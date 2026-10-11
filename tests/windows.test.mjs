import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  parseModelWindows, parseModelList, fetchProfileWindows,
  resolveProfileWindows, readWindowsCache, readLocalCodexWindows,
  windowsCacheKey, cachedProfileWindows
} from '../windows.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lsw-windows-'));

// A Codex model publishes both windows; intact names the threshold itself. Neither is guessed.
test('a list entry gives the whole window and the window to compress at', () => {
  assert.deepEqual(parseModelWindows({ id: 'codex/gpt-6-astra', context_length: 872000, compact_window: 272000 }),
    { context: 872000, compact: 272000 });
  assert.deepEqual(parseModelWindows({ id: 'local/g', context_window: 272000, max_context_window: 872000 }),
    { context: 872000, compact: 272000 }, 'the smaller of two Codex windows is the threshold');
  assert.deepEqual(parseModelWindows({ id: 'groq/q', context_window: 131072 }), { context: 131072, compact: 0 },
    'one window is the whole window, not a threshold');
  assert.deepEqual(parseModelWindows({ id: 'or/r', context_length: 262144, top_provider: { context_length: 262144, max_completion_tokens: 32768 } }),
    { context: 262144, compact: 0, output: 32768 });
  assert.deepEqual(parseModelWindows({ id: 'bare' }), null, 'a model with no limits says nothing');
  assert.deepEqual(parseModelWindows({ id: 'zero', context_length: 0, compact_window: 0 }), null);
});

// The output limit lets the gateway clamp a max_tokens the model would refuse.
test('a list entry keeps the output limit it names, and leaves it out when it names none', () => {
  assert.deepEqual(parseModelWindows({ id: 'i/m', context_length: 200000, max_output_tokens: 8192 }),
    { context: 200000, compact: 0, output: 8192 });
  assert.deepEqual(parseModelWindows({ id: 'only-out', max_output_tokens: 4096 }), { context: 0, compact: 0, output: 4096 },
    'an output limit alone is still worth keeping');
  assert.equal('output' in parseModelWindows({ id: 'g', context_length: 131072 }), false);
  assert.deepEqual(parseModelList({ data: [{ id: 'i/m', context_length: 200000, max_output_tokens: 8192 }] }),
    { 'i/m': { context: 200000, compact: 0, output: 8192 } });
});

test('parseModelList keys the windows by the id a profile maps, and drops the nameless', () => {
  const out = parseModelList({ data: [{ id: 'models/big', context_length: 1048576 }, { id: 'bare' }, 'plain'] });
  assert.deepEqual(Object.keys(out), ['big'], 'a bare string carries no window, and a models/ prefix is dropped');
  assert.equal(out.big.context, 1048576);
  assert.deepEqual(parseModelList({}), {});
  assert.deepEqual(parseModelList({ models: [{ id: 'gemini', inputTokenLimit: 1000000 }] }), {});
});

test('a profile list is read over HTTP, and a failure gives no window rather than a wrong one', async () => {
  const seen = [];
  const sink = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'm', context_length: 872000, compact_window: 272000 }] }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => sink.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${sink.address().port}/v1`;
  try {
    assert.deepEqual(await fetchProfileWindows(base, 'sk-x'), { m: { context: 872000, compact: 272000 } });
    assert.ok(seen[0]?.startsWith('Bearer '), 'the profile key travels to the profile own list');
    assert.deepEqual(await fetchProfileWindows(`${base}/gone`, 'sk-x'), {}, 'a 404 is not a window');
    assert.deepEqual(await fetchProfileWindows('http://127.0.0.1:9/v1', 'sk-x'), {}, 'an unreachable host is not a window');
    assert.deepEqual(await fetchProfileWindows('', 'sk-x'), {});
  } finally {
    sink.close();
  }
});

// The cache exists so /v1/models costs nothing on the hot path, and so a profile whose list cannot
// be read keeps the last windows it did see.
test('windows are cached for an hour, and a failed refresh keeps the stale answer', async () => {
  const dir = tmpDir();
  let hits = 0;
  const sink = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'm', context_length: hits === 1 ? 872000 : 400000 }] }));
  });
  await new Promise(r => sink.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${sink.address().port}/v1`;
  const key = 'p@' + base;
  try {
    const fresh = await resolveProfileWindows(dir, key, base, 'k', { now: 1_000 });
    assert.equal(fresh.m.context, 872000);
    assert.equal(hits, 1);
    // Inside the hour: the cache answers and the list is not read again.
    assert.equal((await resolveProfileWindows(dir, key, base, 'k', { now: 1_000 + 60_000 })).m.context, 872000);
    assert.equal(hits, 1);
    // Past the hour the list is read again, and the answer moves with it.
    assert.equal((await resolveProfileWindows(dir, key, base, 'k', { now: 1_000 + 3_600_000 })).m.context, 400000);
    assert.equal(hits, 2);
    // A list that cannot be read keeps what the last good read found.
    sink.closeAllConnections?.();
    await new Promise(r => sink.close(r));
    assert.equal((await resolveProfileWindows(dir, key, base, 'k', { now: 1_000 + 7_200_000 })).m.context, 400000);
    assert.equal(readWindowsCache(dir)[key].models.m.context, 400000, 'and the cache still holds it');
  } finally {
    sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the cache persists the output limit, and an old cache file without it still reads', async () => {
  const dir = tmpDir();
  const sink = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'm', context_length: 200000, max_output_tokens: 8192 }] }));
  });
  await new Promise(r => sink.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${sink.address().port}/v1`;
  try {
    await resolveProfileWindows(dir, 'p@' + base, base, 'k', { now: 1_000 });
    assert.equal(readWindowsCache(dir)['p@' + base].models.m.output, 8192);
    fs.writeFileSync(path.join(dir, 'model-windows.json'), JSON.stringify({ old: { at: 1_000, baseURL: base, models: { m: { context: 200000, compact: 0 } } } }));
    assert.deepEqual(await resolveProfileWindows(dir, 'old', base, 'k', { now: 2_000 }), { m: { context: 200000, compact: 0 } });
  } finally {
    sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty cache file reads as no windows instead of throwing', () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(readWindowsCache(dir), {});
    fs.writeFileSync(path.join(dir, 'model-windows.json'), 'not json');
    assert.deepEqual(readWindowsCache(dir), {}, 'a broken cache is a cache miss, never a crash');
    fs.writeFileSync(path.join(dir, 'model-windows.json'), '[1,2]');
    assert.deepEqual(readWindowsCache(dir), {}, 'a shape that is not a map is a cache miss too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The Codex CLI keeps the numbers for its own account, so a profile that lists no limits at least
// gets the provider's real windows instead of the template's.
test('the Codex CLI own cache is a fallback, not a source of truth', () => {
  const home = tmpDir();
  try {
    assert.deepEqual(readLocalCodexWindows({ codexHome: home }), {}, 'no cache file, no windows');
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-6-astra', context_window: 272000, max_context_window: 872000 },
      { slug: 'flat', context_window: 400000 },
      { slug: 'bare' }
    ] }));
    assert.deepEqual(readLocalCodexWindows({ codexHome: home }), {
      'gpt-6-astra': { context: 872000, compact: 272000 },
      flat: { context: 400000, compact: 0 }
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A profile whose baseURL is spelled with another case or a trailing slash is the same address.
test('the cache key of a profile ignores the case of scheme and host and a trailing slash', () => {
  assert.equal(windowsCacheKey('p', 'HTTP://Api.Example.COM:8080/v1/'), 'p@http://api.example.com:8080/v1');
  assert.equal(windowsCacheKey('p', 'http://api.example.com:8080/v1'), 'p@http://api.example.com:8080/v1');
  assert.equal(windowsCacheKey('p', 'https://api.example.com/V1//'), 'p@https://api.example.com/V1', 'the path keeps its case');
  assert.equal(windowsCacheKey(null, 'https://h/v1'), 'profile@https://h/v1');
});

// The output clamp reads the cache without a refresh, so it trusts only what this profile read within the hour.
test('cachedProfileWindows answers only for its own key and only while the entry is fresh', () => {
  const dir = tmpDir();
  try {
    const models = { m: { context: 200000, compact: 0, output: 8192 } };
    fs.writeFileSync(path.join(dir, 'model-windows.json'), JSON.stringify({ 'a@http://h/v1': { at: 1_000, baseURL: 'http://h/v1', models } }));
    assert.deepEqual(cachedProfileWindows(dir, 'a@http://h/v1', { now: 1_000 + 60_000 }), models);
    assert.deepEqual(cachedProfileWindows(dir, 'b@http://h/v1', { now: 1_000 + 60_000 }), {}, 'another profile on the same baseURL');
    assert.deepEqual(cachedProfileWindows(dir, 'a@http://h/v1', { now: 1_000 + 3_600_000 }), {}, 'an entry an hour old');
    assert.deepEqual(cachedProfileWindows(dir, 'a@http://h/v1', { now: 2_000, ttlMs: 500 }), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A list that names only an output limit must not erase the windows an earlier read found, and an
// output limit lives only as long as the newest list still states it.
test('a refresh merges each model into the cached windows, but never carries an output limit forward', async () => {
  const dir = tmpDir();
  const lists = [
    [{ id: 'm', context_length: 200000, compact_window: 150000, max_output_tokens: 4096 }, { id: 'n', context_length: 100000, max_output_tokens: 2048 }],
    [{ id: 'm', context_length: 300000 }, { id: 'o', context_length: 50000 }],
    [{ id: 'm', max_output_tokens: 8192 }]
  ];
  let hits = 0;
  const sink = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: lists[hits++] }));
  });
  await new Promise(r => sink.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${sink.address().port}/v1`;
  try {
    await resolveProfileWindows(dir, 'p', base, 'k', { now: 1_000 });
    const second = await resolveProfileWindows(dir, 'p', base, 'k', { now: 1_000 + 3_600_000 });
    const expected = {
      m: { context: 300000, compact: 150000 },
      n: { context: 100000, compact: 0 },
      o: { context: 50000, compact: 0 }
    };
    assert.deepEqual(second, expected, 'a changed window replaces the cached one; no output limit the list did not state');
    assert.deepEqual(readWindowsCache(dir).p.models, expected);
    const fresh = cachedProfileWindows(dir, 'p', { now: 1_000 + 3_600_000 + 60_000 });
    assert.equal(fresh.m.output, undefined);
    assert.equal(fresh.m.context, 300000);
    const third = await resolveProfileWindows(dir, 'p', base, 'k', { now: 1_000 + 7_200_000 });
    assert.equal(hits, 3);
    assert.deepEqual(third.m, { context: 300000, compact: 150000, output: 8192 }, 'an output-only list keeps the windows');
  } finally {
    sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
