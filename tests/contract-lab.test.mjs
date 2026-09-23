// Contract lab, llm-switcher half: tagging, the bounded upload queue and the policy cache.
// The e2e tests prove the hard rule: a slow, broken or absent intact never changes the bytes
// a coding tool receives, and never delays them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFrameReader } from '../blindfold/wsframe.mjs';
import {
  createContractLab, createHalfTap, newTraceId, switcherVersion, toolVersionFromUA, capJson,
  finishHalf, TRACE_ID_RE, SWITCHER_VERSION_RE, MAX_QUEUE,
  PROBE_FORMATS, probeVariants, probeRequest, probeModels, runProbe
} from '../contract.mjs';
import { contractLabSettings, MASKED_KEY } from '../state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

// ---------------------------------------------------------------- unit: ids and versions

test('a trace id matches the regex intact accepts, and two ids differ', () => {
  const a = newTraceId();
  assert.match(a, TRACE_ID_RE);
  assert.notEqual(a, newTraceId());
});

test('the switcher version matches the shape the half route demands', () => {
  assert.match(switcherVersion(), SWITCHER_VERSION_RE);
  const stamp = switcherVersion().split('+')[1];
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const when = new Date(iso);
  assert.ok(!Number.isNaN(when.getTime()), `${stamp} must parse as a UTC time`);
  assert.ok(when.getTime() <= Date.now() + 24 * 3600 * 1000, 'never later than now plus one day');
});

test('the tool version is read from the User-Agent, and a bad one is dropped', () => {
  assert.equal(toolVersionFromUA('claude-cli/1.2.3 (external, cli)'), '1.2.3');
  assert.equal(toolVersionFromUA('codex_cli_rs/0.47.0-alpha.1'), '0.47.0-alpha.1');
  assert.equal(toolVersionFromUA('claude-cli/not-a-version x'), '');
  assert.equal(toolVersionFromUA('curl'), '');
  assert.equal(toolVersionFromUA(undefined), '');
});

// ---------------------------------------------------------------- unit: config block

test('contractLab is absent by default, and a saved block survives a rewrite', () => {
  assert.deepEqual(contractLabSettings({}), { url: '', apiKey: '', enabled: false });
  assert.deepEqual(contractLabSettings(null), { url: '', apiKey: '', enabled: false });
  // Enabled needs a real http(s) URL and a key: a half-filled block stays off.
  assert.equal(contractLabSettings({ contractLab: { enabled: true } }).enabled, false);
  assert.equal(contractLabSettings({ contractLab: { url: 'file:///etc/passwd', apiKey: 'k', enabled: true } }).enabled, false);
  assert.equal(contractLabSettings({ contractLab: { url: 'http://127.0.0.1:9/', apiKey: 'k', enabled: true } }).enabled, true);
  assert.equal(contractLabSettings({ contractLab: { url: 'http://127.0.0.1:9/', apiKey: 'k', enabled: true } }).url, 'http://127.0.0.1:9');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-switcher-lab-'));
  const cfgPath = path.join(dir, 'config.json');
  const cfg = { port: 3456, profiles: {}, contractLab: { url: 'http://127.0.0.1:20142', apiKey: 'sk-lab', enabled: true } };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const out = JSON.parse(spawnNodeSync(`
    import fs from 'node:fs';
    import { loadConfig, saveConfig, contractLabSettings, redactConfig } from '${ROOT}/state.mjs';
    saveConfig({ ...loadConfig(), debug: true });
    const again = JSON.parse(fs.readFileSync(process.env.LLM_SWITCHER_CONFIG, 'utf8'));
    console.log(JSON.stringify({ settings: contractLabSettings(again), masked: redactConfig(again).contractLab }));
  `, cfgPath, dir));
  assert.deepEqual(out.settings, { url: 'http://127.0.0.1:20142', apiKey: 'sk-lab', enabled: true });
  // The dashboard must never read the intact key back out of /api/config.
  assert.equal(out.masked.apiKey, MASKED_KEY);
  assert.equal(out.masked.hasApiKey, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// state.mjs reads its config path once per process, so a config test runs in its own process.
function spawnNodeSync(code, cfgPath, stateDir) {
  const file = path.join(stateDir, 'probe.mjs');
  fs.writeFileSync(file, code);
  return execFileSync(process.execPath, [file], {
    encoding: 'utf8',
    env: { ...process.env, LLM_SWITCHER_CONFIG: cfgPath, LLM_SWITCHER_STATE_DIR: stateDir }
  });
}

// ---------------------------------------------------------------- unit: queue and policy

const labSettings = (url) => () => ({ url, apiKey: 'sk-lab', enabled: true });

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  arrayBuffer: async () => new ArrayBuffer(0)
});

const half = { toolRequest: '{"a":1}', toolResponse: '{"b":2}', toolVersion: '1.2.3', inFormat: 'anthropic', outFormat: 'openai-chat' };

test('the upload queue holds 32 waiting halves and drops the oldest at the 33rd', () => {
  // The pump starts on a later turn, so all 33 uploads of this turn meet a queue that never drains.
  const lab = createContractLab({ settings: labSettings('http://127.0.0.1:1'), fetchImpl: fakeFetch(() => jsonRes(202, {})), log: () => {} });
  const ids = [];
  for (let i = 0; i < MAX_QUEUE + 1; i++) {
    const id = newTraceId();
    ids.push(id);
    lab.upload(id, half);
  }
  const pending = lab.pending();
  assert.equal(pending.length, MAX_QUEUE);
  assert.equal(lab.stats().dropped, 1);
  assert.ok(!pending.includes(ids[0]), 'the oldest waiting half is the one dropped');
  assert.equal(pending.at(-1), ids.at(-1));
});

test('finishHalf uploads only a sampled turn that ran to the end', () => {
  const calls = [];
  const lab = { upload: (traceId, h) => calls.push([traceId, h]) };
  const id = newTraceId();
  finishHalf(lab, null, false, half);
  finishHalf(lab, id, true, half);
  assert.equal(calls.length, 0, 'an untagged or aborted turn uploads nothing');
  finishHalf(lab, id, false, half);
  assert.deepEqual(calls, [[id, half]]);
});

test('a 409 half counts as done and is never sent again', async () => {
  const fetchImpl = fakeFetch(() => jsonRes(409, {}));
  const lab = createContractLab({ settings: labSettings('http://127.0.0.1:1'), fetchImpl, log: () => {} });
  const id = newTraceId();
  lab.upload(id, half);
  await waitFor(() => lab.stats().done === 1, 'the 409 to count as done');
  await sleep(50);
  assert.equal(fetchImpl.calls.length, 1, 'no retry');
  assert.equal(lab.stats().failed, 0);
  assert.equal(lab.pending().length, 0);
  const sent = fetchImpl.calls[0];
  assert.equal(sent.url, `http://127.0.0.1:1/api/contracts/traces/${id}/half`);
  assert.equal(sent.opts.method, 'POST');
  assert.equal(sent.opts.headers.authorization, 'Bearer sk-lab');
  const body = JSON.parse(sent.opts.body);
  assert.deepEqual(body.converter, { inFormat: 'anthropic', outFormat: 'openai-chat' });
  assert.equal(body.toolRequest, '{"a":1}');
  assert.equal(body.toolResponse, '{"b":2}');
  assert.equal(body.toolVersion, '1.2.3');
  assert.match(body.switcherVersion, SWITCHER_VERSION_RE);
});

test('a failed policy refresh keeps the last policy, and no policy samples nothing', async () => {
  let clock = 0;
  let fail = false;
  const fetchImpl = fakeFetch(() => (fail ? Promise.reject(new Error('intact down')) : jsonRes(200, { models: { 'ag/flash': 1 }, default: 0 })));
  const lab = createContractLab({
    settings: labSettings('http://127.0.0.1:1'), fetchImpl, log: () => {},
    now: () => clock, random: () => 0
  });
  // Before the first policy arrives nothing is sampled.
  assert.equal(lab.traceFor('ag/flash'), null);
  await waitFor(() => lab.policy() !== null, 'the first policy');
  assert.match(lab.traceFor('ag/flash'), TRACE_ID_RE);
  assert.equal(lab.traceFor('other-model'), null, 'a model with rate 0 is not sampled');

  fail = true;
  clock += 10 * 60 * 1000 + 1;
  // The refresh runs beside the request, never in front of it: the cached policy still decides.
  assert.match(lab.traceFor('ag/flash'), TRACE_ID_RE);
  await waitFor(() => fetchImpl.calls.length === 2, 'the second policy call');
  await sleep(20);
  assert.deepEqual(lab.policy(), { models: { 'ag/flash': 1 }, default: 0 }, 'the last policy is kept');
  assert.match(lab.traceFor('ag/flash'), TRACE_ID_RE);
});

test('a lab whose config is disabled tags nothing and calls intact never', async () => {
  const fetchImpl = fakeFetch(() => jsonRes(200, { default: 1 }));
  const lab = createContractLab({ settings: () => ({ url: 'http://127.0.0.1:1', apiKey: 'k', enabled: false }), fetchImpl, log: () => {} });
  assert.equal(lab.traceFor('m'), null);
  lab.upload(newTraceId(), half);
  await sleep(50);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(lab.pending().length, 0);
});

test('a WS message becomes half text, and an unreadable or oversized one becomes empty', () => {
  assert.equal(capJson({ type: 'response.create', model: 'main' }), '{"type":"response.create","model":"main"}');
  assert.equal(capJson({ a: 'x'.repeat(40) }, 8), '', 'a side over the cap would get 413 from intact');
  assert.equal(capJson(undefined), '');
  assert.equal(capJson({ big: 1n }), '', 'a value JSON cannot hold never breaks the turn');
});

test('the half tap copies bytes and gives up the whole side past the cap', () => {
  const tap = createHalfTap(16);
  tap.push('ab');
  tap.push(Buffer.from('cd'));
  tap.push(new Uint8Array([101, 102]));
  assert.equal(tap.text(), 'abcdef');
  const small = createHalfTap(4);
  small.push('abcdef');
  assert.equal(small.text(), '', 'a side over the cap is dropped, intact would answer 413');
});

// ---------------------------------------------------------------- e2e with a spawned gateway

let upstream, upstreamPort, intact, intactPort, closedPort, tmpDir;
const received = [];       // upstream requests
const halves = [];         // half uploads intact saw
const intactState = { hangHalf: false, policy: { models: {}, default: 1 } };
const proxies = {};        // name -> { port, child }

const DIRECT_BODY = JSON.stringify({
  id: 'msg_fixed', type: 'message', role: 'assistant', model: 'up-opus',
  content: [{ type: 'text', text: 'direct ok' }], stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 2 }
});

// The Codex WS transport always asks upstream for a stream, so the mock answers one.
const STREAM_BODY = [
  ['message_start', { type: 'message_start', message: { id: 'msg_ws', type: 'message', role: 'assistant', model: 'up-opus', content: [], usage: { input_tokens: 5, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ws ok' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
  ['message_stop', { type: 'message_stop' }]
].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');

function startUpstream() {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      received.push({ url: req.url, headers: req.headers, body: json });
      if (JSON.stringify(json.messages || '').includes('ERR_400')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }));
      }
      if (JSON.stringify(json.messages || '').includes('MID_STREAM_ERR')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_err","type":"message","role":"assistant","model":"up-opus","content":[]}}\n\n');
        setTimeout(() => res.destroy(new Error('cut off')), 50);
        return;
      }
      if (json.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end(STREAM_BODY);
      }
      const answer = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(DIRECT_BODY);
      };
      if (JSON.stringify(json.messages || '').includes('SLOW')) setTimeout(answer, 400);
      else answer();
    });
  });
  return new Promise(r => upstream.listen(0, '127.0.0.1', () => { upstreamPort = upstream.address().port; r(); }));
}

function startIntact() {
  intact = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/contracts/policy') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(intactState.policy));
      }
      const m = req.url.match(/^\/api\/contracts\/traces\/([^/]+)\/half$/);
      if (m && req.method === 'POST') {
        halves.push({ traceId: m[1], headers: req.headers, body: JSON.parse(body) });
        if (intactState.hangHalf) return; // never answers: the tool answer must not wait for it
        res.writeHead(202);
        return res.end('{}');
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  return new Promise(r => intact.listen(0, '127.0.0.1', () => { intactPort = intact.address().port; r(); }));
}

async function startProxy(name, contractLab) {
  const port = await freePort();
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const models = { opus: 'up-opus', sonnet: 'up-sonnet', haiku: 'up-haiku', fable: 'up-fable' };
  const cfg = {
    port,
    activeProfiles: { anthropic: 'ant', responses: 'ant', 'openai-chat': 'ant', vertex: 'ant' },
    profiles: {
      ant: { name: 'Mock Anthropic', mode: 'direct', inFormat: 'auto', outFormat: 'anthropic', baseURL: `http://127.0.0.1:${upstreamPort}/ant`, apiKey: 'sk-secret-ant', defaultModels: models }
    },
    ...(contractLab ? { contractLab } : {})
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  const child = spawn(process.execPath, [path.join(ROOT, 'proxy.mjs'), '--port', String(port)], {
    env: { ...process.env, LLM_SWITCHER_CONFIG: path.join(dir, 'config.json'), LLM_SWITCHER_STATE_DIR: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), LLM_SWITCHER_PORT: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  proxies[name] = { port, child };
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return proxies[name];
    } catch {}
    await sleep(50);
  }
  throw new Error(`proxy ${name} did not start:\n${log}`);
}

const ask = (name, headers = {}, opts = {}) => fetch(`http://127.0.0.1:${proxies[name].port}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'user-agent': 'claude-cli/1.2.3 (external, cli)', ...headers },
  body: JSON.stringify({
    model: 'claude-opus-4-6',
    max_tokens: 64,
    ...(opts.stream ? { stream: true } : {}),
    messages: [{ role: 'user', content: opts.text || 'hello' }]
  }),
  ...(opts.signal ? { signal: opts.signal } : {})
});

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-switcher-contract-'));
  await startUpstream();
  await startIntact();
  closedPort = await freePort();
  await startProxy('off', null);
  await startProxy('on', { url: `http://127.0.0.1:${intactPort}`, apiKey: 'sk-lab', enabled: true });
  await startProxy('down', { url: `http://127.0.0.1:${closedPort}`, apiKey: 'sk-lab', enabled: true });
});

after(() => {
  for (const p of Object.values(proxies)) p.child?.kill();
  upstream?.close();
  intact?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a client that sends its own X-Intact-Trace never reaches the upstream with it', async () => {
  const chosen = 'client-chosen-trace-id-0001';
  const res = await ask('off', { 'X-Intact-Trace': chosen });
  assert.equal(res.status, 200);
  assert.equal(received.at(-1).headers['x-intact-trace'], undefined, 'the lab is off: no trace header at all');

  // Sampled, the switcher still refuses the client's id and uses its own.
  await waitFor(async () => {
    await ask('on', { 'X-Intact-Trace': chosen });
    return received.at(-1).headers['x-intact-trace'] !== undefined;
  }, 'the policy to arrive and a request to be sampled');
  const tagged = received.at(-1).headers['x-intact-trace'];
  assert.notEqual(tagged, chosen);
  assert.match(tagged, TRACE_ID_RE);
});

test('the half of a sampled request reaches intact with the exchange and the versions', async () => {
  await waitFor(async () => {
    await ask('on');
    return halves.length > 0;
  }, 'a sampled request to reach intact');
  const last = halves.at(-1);
  assert.match(last.traceId, TRACE_ID_RE);
  assert.equal(last.headers.authorization, 'Bearer sk-lab');
  assert.deepEqual(last.body.converter, { inFormat: 'anthropic', outFormat: 'anthropic' });
  assert.equal(last.body.toolVersion, '1.2.3');
  assert.match(last.body.switcherVersion, SWITCHER_VERSION_RE);
  assert.equal(JSON.parse(last.body.toolRequest).messages[0].content, 'hello');
  assert.equal(JSON.parse(last.body.toolResponse).content[0].text, 'direct ok');
});

test('with intact at a closed port the tool answer is byte-identical to the answer with the lab off', async () => {
  const [a, b] = [await ask('off'), await ask('down')];
  assert.equal(a.status, b.status);
  const [ab, bb] = [Buffer.from(await a.arrayBuffer()), Buffer.from(await b.arrayBuffer())];
  assert.equal(Buffer.compare(ab, bb), 0, 'byte-identical answer');
  assert.equal(ab.toString('utf8'), DIRECT_BODY);
  // Nothing was tagged, because no policy could be read.
  assert.equal(received.at(-1).headers['x-intact-trace'], undefined);
});

test('a client that leaves in the middle uploads no half: that answer never completed', async () => {
  const before = halves.length;
  const seen = received.length;
  const ac = new AbortController();
  const pending = ask('on', {}, { text: 'SLOW please', signal: ac.signal }).catch(() => 'aborted');
  await waitFor(() => received.length > seen, 'the upstream to receive the sampled request');
  assert.match(received.at(-1).headers['x-intact-trace'], TRACE_ID_RE, 'the request was sampled');
  ac.abort();
  assert.equal(await pending, 'aborted');
  await sleep(700);
  assert.equal(halves.length, before, 'a cut-off answer would diff as a loss that the converter never made');
});

test('failed exchanges upload no half: 400 upstream and mid-stream error are ignored', async () => {
  await waitFor(async () => {
    await ask('on');
    return received.at(-1)?.headers['x-intact-trace'] !== undefined;
  }, 'the policy to arrive and requests to be sampled');

  const initialHalves = halves.length;

  // 1. 400 upstream
  const res400 = await ask('on', {}, { text: 'ERR_400' });
  assert.equal(res400.status, 400);
  const trace400 = received.at(-1)?.headers['x-intact-trace'];
  assert.ok(trace400, 'the 400 request had a trace id');

  // 2. mid-stream error
  const resStream = await ask('on', {}, { text: 'MID_STREAM_ERR', stream: true });
  await resStream.text().catch(() => {});
  const traceStream = received.at(-1)?.headers['x-intact-trace'];
  assert.ok(traceStream, 'the stream request had a trace id');

  await sleep(300);

  const newHalves = halves.slice(initialHalves);
  assert.equal(newHalves.some(h => h.traceId === trace400), false, 'fake intact received no half for 400 trace');
  assert.equal(newHalves.some(h => h.traceId === traceStream), false, 'fake intact received no half for mid-stream error trace');
});

test('a converted stream cut mid-way uploads no half, a complete one does', async () => {
  const chat = (text) => fetch(`http://127.0.0.1:${proxies.on.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'user-agent': 'codex/1.0.0' },
    body: JSON.stringify({ model: 'claude-opus-4-6', stream: true, messages: [{ role: 'user', content: text }] })
  });
  let traceOk;
  await waitFor(async () => {
    await (await chat('hello')).text();
    traceOk = received.at(-1)?.headers['x-intact-trace'];
    return traceOk !== undefined;
  }, 'a sampled converted request');
  await waitFor(() => halves.some(h => h.traceId === traceOk), 'the complete converted stream to upload its half');

  const before = halves.length;
  await (await chat('MID_STREAM_ERR')).text().catch(() => {});
  const traceCut = received.at(-1)?.headers['x-intact-trace'];
  assert.ok(traceCut, 'the cut request was sampled');
  await sleep(300);
  assert.equal(halves.slice(before).some(h => h.traceId === traceCut), false, 'a cut converted stream would diff as a loss');
});

// ---------------------------------------------------------------- e2e over the Codex WS transport

// A masked text frame. The gateway rejects an unmasked client frame, as the WS standard demands.
function clientFrame(text) {
  const data = Buffer.from(text, 'utf8');
  const len = data.length;
  const head = len < 126
    ? Buffer.from([0x81, 0x80 | len])
    : Buffer.concat([Buffer.from([0x81, 0x80 | 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(len); return b; })()]);
  const mask = crypto.randomBytes(4);
  return Buffer.concat([head, mask, Buffer.from(data.map((b, i) => b ^ mask[i & 3]))]);
}

// One Codex WS turn against a spawned gateway: upgrade, one response.create, every frame back.
function wsTurn(name, input, headers = {}) {
  const port = proxies[name].port;
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`ws turn timed out: ${input}`)); }, 10000);
    const extra = Object.entries({ 'user-agent': 'codex_cli_rs/0.47.0', ...headers }).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    const read = createFrameReader();
    const events = [];
    const parts = [];
    let head = Buffer.alloc(0);
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ events, text: Buffer.concat(parts).toString('utf8') });
    };
    const collect = (chunk) => {
      for (const f of read(chunk)) {
        if (f.type !== 'text') continue;
        parts.push(f.payload);
        const msg = JSON.parse(f.payload.toString('utf8'));
        events.push(msg);
        if (msg.type === 'response.completed' || msg.type === 'response.failed') finish();
      }
    };
    const onHead = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onHead);
      socket.on('data', collect);
      socket.write(clientFrame(JSON.stringify({ type: 'response.create', model: 'main', input })));
      const rest = head.subarray(end + 4);
      if (rest.length) collect(rest);
    };
    socket.on('error', reject);
    socket.on('data', onHead);
    socket.write(`GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n${extra}\r\n`);
  });
}

// Every turn builds its own response, item and reasoning ids and its own created_at.
const stableWs = (text) => text
  .replace(/"(resp|msg|rs|fc|ctc|lsh)_[A-Za-z0-9]+"/g, '"<id>"')
  .replace(/"created_at":\d+/g, '"created_at":0');

test('a sampled Codex WS turn is tagged and its half reaches intact', async () => {
  const chosen = 'client-chosen-trace-id-0003';
  let turn;
  await waitFor(async () => {
    turn = await wsTurn('on', 'hello over ws', { 'X-Intact-Trace': chosen });
    return received.at(-1).headers['x-intact-trace'] !== undefined;
  }, 'a sampled WS turn');
  const traceId = received.at(-1).headers['x-intact-trace'];
  assert.notEqual(traceId, chosen, 'the id of the client is refused, the switcher uses its own');
  assert.match(traceId, TRACE_ID_RE);
  assert.equal(turn.events.at(-1).type, 'response.completed');

  await waitFor(() => halves.some(h => h.traceId === traceId), 'the half of the WS turn');
  const body = halves.find(h => h.traceId === traceId).body;
  assert.deepEqual(body.converter, { inFormat: 'responses', outFormat: 'anthropic' });
  assert.equal(body.toolVersion, '0.47.0');
  assert.match(body.switcherVersion, SWITCHER_VERSION_RE);
  const asked = JSON.parse(body.toolRequest);
  assert.equal(asked.type, 'response.create');
  assert.equal(asked.input, 'hello over ws');
  assert.ok(body.toolResponse.includes('event: response.completed'), 'the half holds the events the turn wrote');
  assert.ok(body.toolResponse.includes('ws ok'), 'the answer text is in the half');
});

test('a Codex WS client can never choose the trace id, and a down intact leaves the turn unchanged', async () => {
  const chosen = 'client-chosen-trace-id-0002';
  const a = await wsTurn('off', 'ws same bytes', { 'X-Intact-Trace': chosen });
  const offTag = received.at(-1).headers['x-intact-trace'];
  const b = await wsTurn('down', 'ws same bytes', { 'X-Intact-Trace': chosen });
  const downTag = received.at(-1).headers['x-intact-trace'];
  assert.equal(offTag, undefined, 'the lab is off: no trace header at all');
  assert.equal(downTag, undefined, 'no policy could be read: nothing is sampled');
  assert.equal(stableWs(a.text), stableWs(b.text), 'the frames of the turn are the same');
  assert.equal(a.events.at(-1).type, 'response.completed');
});

test('an intact that never answers the half changes neither the bytes nor the timing of the answer', async () => {
  intactState.hangHalf = true;
  const before = halves.length;
  const started = Date.now();
  const res = await ask('on');
  const body = Buffer.from(await res.arrayBuffer());
  const took = Date.now() - started;
  intactState.hangHalf = false;
  assert.equal(res.status, 200);
  assert.equal(body.toString('utf8'), DIRECT_BODY, 'the tap copies bytes, it never changes them');
  assert.ok(took < 2000, `the answer must not wait for intact (took ${took} ms)`);
  await waitFor(() => halves.length > before, 'the half to be posted after the answer');
});

// ---------------------------------------------------------------- probe: the six variants

test('the probe matrix is the six variants of the response matrix, in both tool formats', () => {
  const matrix = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/response-matrix.json'), 'utf8'));
  assert.deepEqual(probeVariants(), matrix.variants);
  assert.deepEqual(PROBE_FORMATS, ['anthropic', 'responses']);
});

test('each variant sets its own knob in both formats', () => {
  const ant = (v) => probeRequest({ format: 'anthropic', variant: v, model: 'm' }).body;
  const res = (v) => probeRequest({ format: 'responses', variant: v, model: 'm' }).body;
  assert.equal(probeRequest({ format: 'anthropic', variant: 'base-stream', model: 'm' }).path, '/v1/messages');
  assert.equal(probeRequest({ format: 'responses', variant: 'base-stream', model: 'm' }).path, '/v1/responses');

  assert.equal(ant('base-stream').stream, true);
  assert.equal(ant('base-stream').thinking, undefined);
  assert.equal(ant('think-stream').thinking.type, 'enabled');
  assert.ok(ant('think-stream').thinking.budget_tokens >= 1024, 'a budget under 1024 is refused');
  assert.equal(ant('think-nostream').stream, false);
  assert.equal(ant('think-nostream').thinking.type, 'enabled');
  assert.equal(ant('tool-stream').tools.length, 1);
  assert.equal(ant('trunc-stream').max_tokens, 40);
  assert.equal(ant('effort-stream').stream, true);
  assert.equal(ant('base-stream').model, 'm');

  assert.equal(res('base-stream').stream, true);
  assert.equal(res('think-nostream').stream, false);
  assert.equal(res('tool-stream').tools[0].type, 'function');
  assert.equal(res('trunc-stream').max_output_tokens, 40);
  assert.equal(res('effort-stream').reasoning.effort, 'high');
  assert.equal(typeof res('base-stream').input, 'string');
});

test('Anthropic probe with thinking sets max_tokens greater than budget_tokens', () => {
  for (const v of ['think-stream', 'think-nostream', 'effort-stream']) {
    const req = probeRequest({ format: 'anthropic', variant: v, model: 'm' });
    assert.ok(
      req.body.max_tokens > req.body.thinking.budget_tokens,
      `${v}: max_tokens (${req.body.max_tokens}) must exceed budget_tokens (${req.body.thinking.budget_tokens})`
    );
  }
});

test('the probe models are every mapped model of the active profiles, once each', () => {
  const cfg = {
    activeProfiles: { anthropic: 'a', responses: 'a', 'openai-chat': 'b', vertex: null },
    profiles: {
      a: { inFormat: 'auto', defaultModels: { opus: 'up-opus', sonnet: 'up-sonnet', haiku: '', fable: 'up-opus' } },
      b: { inFormat: 'openai-chat', defaultModels: { default: 'up-chat' } },
      unused: { inFormat: 'auto', defaultModels: { opus: 'never-probed' } }
    }
  };
  assert.deepEqual(probeModels(cfg), ['up-opus', 'up-sonnet', 'up-chat']);
  assert.deepEqual(probeModels({}), []);
});

// ---------------------------------------------------------------- probe: e2e through the gateway

const adminTokenOf = (name) => fs.readFileSync(path.join(tmpDir, name, 'admin.token'), 'utf8').trim();
const configOf = (name) => JSON.parse(fs.readFileSync(path.join(tmpDir, name, 'config.json'), 'utf8'));

test('the probe sends six variants in two formats per model, each with a fresh trace id', async () => {
  const seen = received.length;
  const lines = [];
  const out = await runProbe({
    port: proxies.off.port, token: adminTokenOf('off'), config: configOf('off'),
    log: (line) => lines.push(line)
  });

  const models = probeModels(configOf('off'));
  assert.equal(models.length, 4);
  assert.equal(out.unreachable, false);
  assert.equal(out.rows.length, models.length * 12, 'six variants x two formats per model');
  assert.equal(lines.length, out.rows.length, 'one printed line per request');

  const sent = received.slice(seen);
  assert.equal(sent.length, out.rows.length, 'every probe request reached the upstream');
  const ids = new Set();
  for (const row of out.rows) {
    assert.match(row.traceId, TRACE_ID_RE);
    assert.equal(row.status, 200, `${row.model} ${row.format} ${row.variant}`);
    ids.add(row.traceId);
    assert.ok(lines.some(l => l.includes(row.traceId) && l.includes(row.variant) && l.includes(row.format)), 'the line names the request');
  }
  assert.equal(ids.size, out.rows.length, 'every request carries its own id');
  for (const id of sent.map(r => r.headers['x-intact-trace'])) assert.ok(ids.has(id), `upstream saw an unknown trace id ${id}`);
  for (const r of sent) {
    assert.equal(r.headers['x-intact-probe'], undefined, 'the probe marker never leaves the gateway');
    assert.equal(r.headers['x-llm-switcher-token'], undefined, 'the admin token never leaves the gateway');
  }

  for (const model of models) {
    const rows = out.rows.filter(r => r.model === model);
    assert.deepEqual([...new Set(rows.map(r => r.variant))], probeVariants());
    assert.deepEqual([...new Set(rows.map(r => r.format))], [...PROBE_FORMATS]);
  }
});

test('--model limits the probe to that one model', async () => {
  const out = await runProbe({
    port: proxies.off.port, token: adminTokenOf('off'), config: configOf('off'),
    model: 'up-haiku', log: () => {}
  });
  assert.equal(out.rows.length, 12);
  assert.deepEqual([...new Set(out.rows.map(r => r.model))], ['up-haiku']);
});

test('a probe run on a lab-enabled gateway uploads a half per row to intact', async () => {
  const initialHalves = halves.length;
  const out = await runProbe({
    port: proxies.on.port, token: adminTokenOf('on'), config: configOf('on'),
    model: 'up-haiku', log: () => {}
  });
  assert.equal(out.unreachable, false);
  assert.equal(out.rows.length, 12);
  const probeIds = new Set(out.rows.map(r => r.traceId));
  await waitFor(() => {
    const uploadedIds = new Set(halves.slice(initialHalves).map(h => h.traceId));
    return [...probeIds].every(id => uploadedIds.has(id));
  }, 'fake intact to receive one half per row traceId');
  const uploaded = halves.slice(initialHalves);
  for (const id of probeIds) {
    assert.ok(uploaded.some(h => h.traceId === id), `trace id ${id} reached intact`);
  }
});

test('without the admin token a client can neither probe nor choose a trace id', async () => {
  const chosen = 'probe-marker-chosen-by-a-client';
  const res = await fetch(`http://127.0.0.1:${proxies.off.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-intact-probe': chosen, 'x-llm-switcher-token': 'wrong-token' },
    body: JSON.stringify({ model: 'up-opus', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  assert.equal(received.at(-1).headers['x-intact-trace'], undefined, 'no capture without the token');
  assert.equal(received.at(-1).headers['x-intact-probe'], undefined, 'the marker never reaches the upstream');
});

test('a probe id that is not a valid trace id is refused by the gateway', async () => {
  const res = await fetch(`http://127.0.0.1:${proxies.off.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-intact-probe': 'short', 'x-llm-switcher-token': adminTokenOf('off') },
    body: JSON.stringify({ model: 'up-opus', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  assert.equal(received.at(-1).headers['x-intact-trace'], undefined);
});

test('switch contract-probe prints the run and fails only when the gateway is unreachable', async () => {
  const dir = path.join(tmpDir, 'off');
  const env = { ...process.env, LLM_SWITCHER_CONFIG: path.join(dir, 'config.json'), LLM_SWITCHER_STATE_DIR: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), LLM_SWITCHER_PORT: '', PORT: '' };
  const run = (args) => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'switch.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });

  const ok = await run(['contract-probe', '--model', 'up-sonnet', '--port', String(proxies.off.port)]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.split('\n').filter(l => l.includes('up-sonnet')).length, 12, ok.stdout);
  assert.ok(ok.stdout.includes('anthropic') && ok.stdout.includes('responses'), ok.stdout);

  const bad = await run(['contract-probe', '--model', 'up-sonnet', '--port', String(closedPort)]);
  assert.notEqual(bad.status, 0, 'a gateway that does not answer is the only failure');
});
