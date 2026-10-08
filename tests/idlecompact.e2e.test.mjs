// Actual proxy -> HTTP mock upstream; no external provider or official account is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function unusedPort() {
  const server = http.createServer(); await listen(server); const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function until(predicate, detail = 'condition', timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`timeout waiting for ${detail}`);
}
function history() {
  const messages = [{ role: 'user', content: 'task' }];
  for (let i = 0; i < 12; i++) messages.push(
    { role: 'assistant', content: [{ type: 'text', text: `DECISION_${i}` },
      { type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: '/test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `RESULT_${i} ` + 'X'.repeat(4000) }] });
  return messages;
}

async function fixture(t, { model = '', codex = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-idle-e2e-'));
  const received = []; const pendingSummaries = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      received.push({ url: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') return res.end(JSON.stringify({ data: [],
        bifrost_ua: req.url.includes('codex') ? 'codex_exec/' : '' }));
      if (body.model === 'cheap-summary') {
        pendingSummaries.push({ res, body }); return;
      }
      if (req.url.endsWith('/responses')) return res.end(JSON.stringify({ id: 'resp_test', object: 'response',
        status: 'completed', model: body.model, output: [{ type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }] }] }));
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } }));
    });
  });
  await listen(upstream); const port = await unusedPort();
  const cfg = { port, activeProfiles: {}, profiles: {
    p1: { name: 'Offline', mode: 'hybrid', baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'fixture-only' },
  }, idleCompact: { enabled: true, codex, model, minBytes: 8192, keepRecent: 6 } };
  const config = path.join(dir, 'config.json'); fs.writeFileSync(config, JSON.stringify(cfg));
  const nativeDir = path.join(dir, 'native'); fs.mkdirSync(nativeDir);
  const nativeFiles = ['projects/test-project/session-one.jsonl', 'sessions/2026/10/08/rollout-A.jsonl',
    'sessions/2026/10/08/rollout-B.jsonl', 'thread_history_1.sqlite'];
  for (const file of nativeFiles) {
    fs.mkdirSync(path.dirname(path.join(nativeDir, file)), { recursive: true });
    fs.writeFileSync(path.join(nativeDir, file), JSON.stringify({ type: 'user', uuid: 'leaf-one',
      sessionId: 'session-one', message: { role: 'user', content: `UNCHANGED_${file}` } }) + '\n');
  }
  const nativeBefore = nativeFiles.map(file => fs.readFileSync(path.join(nativeDir, file)));
  const nativeMtimes = nativeFiles.map(file => fs.statSync(path.join(nativeDir, file)).mtimeMs);
  let child, logs = '';
  const start = async () => {
    child = spawn(process.execPath, [path.join(root, 'proxy.mjs'), '--port', String(port)], {
      env: { ...process.env, LLM_SWITCHER_CONFIG: config, LLM_SWITCHER_STATE_DIR: dir,
        LLM_SWITCHER_PORT: '', LLM_SWITCHER_REGISTRY_URL: 'http://127.0.0.1:9/',
        CODEX_HOME: nativeDir, CLAUDE_CONFIG_DIR: nativeDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => logs += chunk); child.stderr.on('data', chunk => logs += chunk);
    await until(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.ok, `proxy start: ${logs}`);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
  };
  t.after(async () => { await stop(); upstream.closeAllConnections?.();
    await new Promise(resolve => upstream.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  await start();
  const send = async (body, { session = 'session-one', responses = false } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/${responses ? 'responses' : 'messages'}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-profile': 'p1',
        ...(responses ? { 'thread-id': session, 'user-agent': 'codex_exec/0.160' } : { 'x-claude-code-session-id': session }) },
      body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
    return received.filter(entry => !entry.url.includes('/models') && entry.body.model !== 'cheap-summary').at(-1).body;
  };
  const age = () => {
    const files = fs.readdirSync(path.join(dir, 'idle-compact')).filter(file => file.endsWith('.json'));
    for (const file of files) { const location = path.join(dir, 'idle-compact', file);
      const record = JSON.parse(fs.readFileSync(location)); record.seenAt = Date.now() - 16 * 60000;
      fs.writeFileSync(location, JSON.stringify(record)); }
  };
  const finish = index => pendingSummaries[index].res.end(JSON.stringify({ choices: [{ message: { content: `SUMMARY_${index}` } }] }));
  return { dir, config, cfg, received, pendingSummaries, send, age, finish,
    restart: async () => { await stop(); await start(); },
    assertNativeUntouched: () => nativeFiles.forEach((file, index) =>
      { assert.deepEqual(fs.readFileSync(path.join(nativeDir, file)), nativeBefore[index]); assert.equal(fs.statSync(path.join(nativeDir, file)).mtimeMs, nativeMtimes[index]); }),
    logs: () => logs, port };
}

test('proxy retains a stable compact prefix through appended turns and restart without model calls or client writes', { timeout: 20000 }, async t => {
  const f = await fixture(t); const body = { model: 'claude-probe', stream: false, messages: history() };
  const initial = await f.send(body); assert.match(JSON.stringify(initial), /RESULT_1 /);
  f.age(); const shortened = await f.send(body);
  assert.doesNotMatch(JSON.stringify(shortened), /RESULT_1 /); assert.match(JSON.stringify(shortened), /DECISION_1"/);
  assert.ok(JSON.stringify(shortened.messages).length < JSON.stringify(body.messages).length / 2);
  body.messages.push({ role: 'assistant', content: 'NEW_ANSWER' }, { role: 'user', content: 'NEW_REQUEST' });
  const next = await f.send(body); assert.match(JSON.stringify(next), /NEW_ANSWER.*NEW_REQUEST/);
  assert.deepEqual(next.messages.slice(0, shortened.messages.length), shortened.messages);
  await f.restart(); assert.deepEqual((await f.send(body)).messages, next.messages);
  const cachedFile = fs.readdirSync(path.join(f.dir, 'idle-compact')).find(file => file.endsWith('.json'));
  fs.writeFileSync(path.join(f.dir, 'idle-compact', cachedFile), '{bad');
  assert.match(JSON.stringify(await f.send(body)), /RESULT_1 /, 'corrupt cache forwards original history');
  assert.equal(f.pendingSummaries.length, 0); f.assertNativeUntouched();
});

test('delayed summary preserves new suffix, maps its own protocol, and loses CAS to a newer idle generation', { timeout: 20000 }, async t => {
  const f = await fixture(t, { model: 'cheap-summary' });
  const body = { model: 'claude-probe', stream: false, messages: history() };
  await f.send(body); f.age(); await f.send(body);
  await until(() => f.pendingSummaries.length === 1, 'first summary');
  assert.ok(f.received.some(entry => entry.url === '/v1/chat/completions' && entry.body.model === 'cheap-summary'));
  assert.doesNotMatch(JSON.stringify(f.pendingSummaries[0].body), /RESULT_11/);
  body.messages.push({ role: 'assistant', content: 'AFTER_SNAPSHOT_ANSWER' }, { role: 'user', content: 'AFTER_SNAPSHOT_USER' });
  await f.send(body);
  f.finish(0); await until(() => f.logs().includes('summary cached'), 'summary storage');
  const resumed = await f.send(body); assert.match(JSON.stringify(resumed), /SUMMARY_0.*AFTER_SNAPSHOT_ANSWER.*AFTER_SNAPSHOT_USER/);
  // Force a larger prefix during a subsequent idle window while an older generation is pending.
  for (let i = 0; i < 8; i++) body.messages.push({ role: 'assistant', content: `NEW_WINDOW_${i} ` + 'Y'.repeat(1000) }, { role: 'user', content: `question ${i}` });
  f.age(); await f.send(body); await until(() => f.pendingSummaries.length === 2, 'second summary');
  for (let i = 0; i < 8; i++) body.messages.push({ role: 'assistant', content: `THIRD_WINDOW_${i}` }, { role: 'user', content: `third question ${i}` });
  f.age(); await f.send(body); await until(() => f.pendingSummaries.length === 3, 'third summary');
  f.finish(2); await until(() => f.logs().split('summary cached').length >= 3, 'newest summary cached');
  f.finish(1); await until(() => f.logs().includes('discarded after a newer generation'), 'stale summary rejection');
  const latest = JSON.stringify(await f.send(body)); assert.match(latest, /SUMMARY_2/); assert.doesNotMatch(latest, /SUMMARY_1/);
  f.assertNativeUntouched();
});

test('Responses opt-in compacts actual forwarded input, keeps assistant output_text and both native threads untouched', { timeout: 20000 }, async t => {
  const f = await fixture(t, { codex: true, model: 'cheap-summary' });
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'task' }] }];
  for (let i = 0; i < 12; i++) input.push(
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `DECISION_${i}` }] },
    { type: 'function_call', call_id: `c${i}`, name: 'read_file', arguments: '{}' },
    { type: 'function_call_output', call_id: `c${i}`, output: `OUTPUT_${i} ` + 'X'.repeat(4000) });
  const body = { model: 'codex/probe', input, stream: false, store: false };
  await f.send(body, { responses: true }); f.age();
  const shortened = await f.send(body, { responses: true });
  assert.doesNotMatch(JSON.stringify(shortened.input), /OUTPUT_1 /); assert.match(JSON.stringify(shortened.input), /DECISION_1/);
  assert.equal(shortened.input.find(item => item.role === 'assistant').content[0].type, 'output_text');
  await until(() => f.pendingSummaries.length === 1, 'Codex configured summary');
  f.finish(0); await until(() => f.logs().includes('summary cached'), 'Codex summary storage');
  body.input.push({ role: 'user', content: 'NEW_CODEX_USER' });
  await f.restart(); assert.match(JSON.stringify(await f.send(body, { responses: true })), /NEW_CODEX_USER/);
  f.assertNativeUntouched();
});

test('native compaction and configuration changes each invalidate an in-flight summary', { timeout: 20000 }, async t => {
  const f = await fixture(t, { model: 'cheap-summary' });
  const body = { model: 'claude-probe', messages: history(), stream: false };
  await f.send(body); f.age(); await f.send(body);
  await until(() => f.pendingSummaries.length === 1, 'summary before native compact');
  const native = { ...body, messages: [{ role: 'user', content: 'NATIVE_CONTEXT' },
    { role: 'assistant', content: 'NATIVE_ANSWER' }, { role: 'user', content: 'NEW_TURN' }] };
  assert.match(JSON.stringify(await f.send(native)), /NATIVE_CONTEXT.*NEW_TURN/);
  f.finish(0); await until(() => f.logs().includes('discarded after a newer generation'), 'native compact discards late summary');
  assert.doesNotMatch(JSON.stringify(await f.send(native)), /SUMMARY_0/);
  // The larger raw history replaces the native prefix and starts its own idle window.
  await f.send(body); f.age(); await f.send(body);
  await until(() => f.pendingSummaries.length === 2, 'summary before config change');
  const cfg = JSON.parse(fs.readFileSync(f.config)); cfg.idleCompact.model = null;
  fs.writeFileSync(f.config, JSON.stringify(cfg));
  f.finish(1); await until(() => f.logs().includes('discarded after configuration change'), 'configuration guard');
  assert.doesNotMatch(JSON.stringify(await f.send(body)), /SUMMARY_1/);
  f.assertNativeUntouched();
});

test('API rejects invalid patch without writing config, accepts all settings, and anonymous calls remain unmodified', { timeout: 20000 }, async t => {
  const f = await fixture(t); const token = fs.readFileSync(path.join(f.dir, 'admin.token'), 'utf8').trim();
  const update = patch => fetch(`http://127.0.0.1:${f.port}/api/idle-compact`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-llm-switcher-token': token }, body: JSON.stringify(patch) });
  const before = fs.readFileSync(f.config);
  for (const patch of [{ unknown: 1 }, { userChars: 0 }, { codex: 'yes' }, { keepRecent: 0.5 }]) {
    const response = await update(patch); assert.equal(response.status, 400); await response.text();
    assert.deepEqual(fs.readFileSync(f.config), before);
  }
  const valid = await update({ codex: true, model: null, userChars: 128, summaryMaxChars: 256, sessionLookbackHours: 24 });
  assert.equal(valid.status, 200); const settings = await valid.json(); assert.equal(settings.idleCompact.codex, true);
  const body = { model: 'claude-probe', messages: history(), stream: false };
  const response = await fetch(`http://127.0.0.1:${f.port}/v1/messages`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-profile': 'p1' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200); await response.text();
  assert.match(JSON.stringify(f.received.at(-1).body), /RESULT_1 /);
  assert.equal(fs.existsSync(path.join(f.dir, 'idle-compact')), false);
});
