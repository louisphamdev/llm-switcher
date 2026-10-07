import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  parseModelWindows, parseModelList, fetchProfileWindows,
  resolveProfileWindows, readWindowsCache, readLocalCodexWindows
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
    { context: 262144, compact: 0 });
  assert.deepEqual(parseModelWindows({ id: 'bare' }), null, 'a model with no limits says nothing');
  assert.deepEqual(parseModelWindows({ id: 'zero', context_length: 0, compact_window: 0 }), null);
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
