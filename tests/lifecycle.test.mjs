// Tests for process identity and the blindfold interceptor lifecycle (switch.mjs, proxy.mjs, state.mjs).
//
// Audit 2026-09-23: the CLI trusted any TCP accept on the interceptor port and any /health body on the
// gateway port, `switch on` saved config.json before it refused, and only the CLI ever started the
// interceptor, so the dashboard, `switch port` and a service start left HTTPS_PROXY pointing at nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSIX = process.platform !== 'win32';
const HAS_OPENSSL = POSIX && fs.existsSync('/usr/bin/openssl');

// switch.mjs writes the launcher files into the repository root; keep whatever was there.
const LAUNCH_FILES = ['active.flag', '1m.flag', 'codex-1m.flag', 'openai-1m.flag', 'env.sh', 'env.cmd', 'env-codex.sh', 'env-codex.cmd', 'model-catalog.json'];
function snapshotLaunchFiles() {
  return Object.fromEntries(LAUNCH_FILES.map(f => {
    const p = path.join(ROOT, f);
    return [f, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null];
  }));
}
function restoreLaunchFiles(snap) {
  for (const [f, content] of Object.entries(snap)) {
    const p = path.join(ROOT, f);
    if (content === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, content);
  }
}

const freePort = () => new Promise(r => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

function makeWorkspace({ certs = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-life-'));
  const certDir = path.join(dir, 'certs');
  if (certs) execFileSync('bash', [path.join(ROOT, 'blindfold', 'make-certs.sh'), 'chatgpt.com', certDir], { stdio: 'ignore' });
  return { dir, certDir, cfgPath: path.join(dir, 'config.json'), claudeDir: path.join(dir, 'claude') };
}

function envFor(ws) {
  return { ...process.env, LLM_SWITCHER_CONFIG: ws.cfgPath, LLM_SWITCHER_BLINDFOLD_CERTS: ws.certDir, CLAUDE_CONFIG_DIR: ws.claudeDir, LLM_SWITCHER_PORT: '', PORT: '' };
}

function writeConfig(ws, gwPort, bfPort, activeResponses = null) {
  fs.writeFileSync(ws.cfgPath, JSON.stringify({
    port: gwPort,
    activeProfiles: { anthropic: null, responses: activeResponses, 'openai-chat': null, vertex: null },
    profiles: {
      plain: { name: 'Plain', mode: 'convert', inFormat: 'auto', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { opus: 'o' } },
      bf: {
        name: 'Blindfold', mode: 'convert', inFormat: 'responses', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k',
        defaultModels: { main: 'm' }, blindfold: true, blindfoldPort: bfPort
      }
    }
  }, null, 2), { mode: 0o600 });
}

// Children run asynchronously: the replay and squatter servers live in this process, and a
// synchronous exec would block them, so a probe would time out and read 'foreign' for the wrong reason.
function probe(ws, expr) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e',
      `const s = await import(${JSON.stringify(path.join(ROOT, 'state.mjs'))}); console.log(JSON.stringify(await (${expr})));`
    ], { env: envFor(ws), encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout.trim()))));
  });
}

function runSwitch(ws, args) {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(ROOT, 'switch.mjs'), ...args], { env: envFor(ws), encoding: 'utf8', timeout: 30000 },
      (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
  });
}

async function startGateway(ws, gwPort) {
  const child = spawn(process.execPath, [path.join(ROOT, 'proxy.mjs'), '--port', String(gwPort)], { env: envFor(ws), stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${gwPort}/health`)).ok) return child; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('gateway did not start');
}

const token = (ws) => fs.readFileSync(path.join(ws.dir, 'admin.token'), 'utf8').trim();
const api = (ws, gwPort, p, body) => fetch(`http://127.0.0.1:${gwPort}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-llm-switcher-token': token(ws) }, body: JSON.stringify(body)
}).then(r => r.json());

async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise(r => setTimeout(r, 200));
  }
  return last;
}

test('the gateway proves its identity to a fresh challenge; a replayed /health is foreign', { skip: !POSIX && 'posix' }, async () => {
  const ws = makeWorkspace();
  const gwPort = await freePort();
  writeConfig(ws, gwPort, await freePort());
  const gw = await startGateway(ws, gwPort);
  const replay = http.createServer((req, res) => res.end(JSON.stringify({ status: 'ok', proxy: 'llm-switcher', proof: 'recorded' })));
  const replayPort = await new Promise(r => replay.listen(0, '127.0.0.1', () => r(replay.address().port)));
  try {
    const body = await (await fetch(`http://127.0.0.1:${gwPort}/health?challenge=abc`)).json();
    assert.equal(body.proof, crypto.createHmac('sha256', token(ws)).update('abc').digest('hex'));
    assert.equal(await probe(ws, `s.probeGateway(${gwPort})`), 'ours');
    assert.equal(await probe(ws, `s.probeGateway(${replayPort})`), 'foreign');
    assert.equal(await probe(ws, `s.probeGateway(${await freePort()})`), 'free');
  } finally {
    gw.kill(); replay.close(); fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('switch on refuses a foreign gateway port and changes nothing', { skip: !POSIX && 'posix' }, async () => {
  const ws = makeWorkspace();
  const gwPort = await freePort();
  writeConfig(ws, gwPort, await freePort());
  const replay = http.createServer((req, res) => res.end(JSON.stringify({ status: 'ok', proxy: 'llm-switcher' })));
  await new Promise(r => replay.listen(gwPort, '127.0.0.1', r));
  const before = fs.readFileSync(ws.cfgPath);
  const launch = snapshotLaunchFiles();
  try {
    const r = await runSwitch(ws, ['on', 'plain']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /held by another process/);
    assert.deepEqual(fs.readFileSync(ws.cfgPath), before);
    assert.deepEqual(snapshotLaunchFiles(), launch, 'no launcher file changed');
  } finally {
    replay.close(); restoreLaunchFiles(launch); fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('switch codex <blindfold profile> refuses missing certificates, a missing leaf.key and a foreign interceptor port, changing nothing', { skip: !HAS_OPENSSL && 'posix + openssl' }, async () => {
  const launch = snapshotLaunchFiles();
  const cases = [];
  try {
    // 1. no certificates at all
    const a = makeWorkspace(); cases.push(a);
    writeConfig(a, await freePort(), await freePort());
    // 2. leaf.key missing
    const b = makeWorkspace({ certs: true }); cases.push(b);
    fs.rmSync(path.join(b.certDir, 'leaf.key'));
    writeConfig(b, await freePort(), await freePort());
    // 3. valid certificates, but another process holds the interceptor port
    const c = makeWorkspace({ certs: true }); cases.push(c);
    const squatter = net.createServer(s => s.end('HTTP/1.1 200 OK\r\n\r\nnot the switcher'));
    const bfPort = await new Promise(r => squatter.listen(0, '127.0.0.1', () => r(squatter.address().port)));
    writeConfig(c, await freePort(), bfPort);
    try {
      for (const [ws, why] of [[a, /missing/], [b, /leaf\.key is missing/], [c, /held by another process/]]) {
        const before = fs.readFileSync(ws.cfgPath);
        const r = await runSwitch(ws, ['codex', 'bf']);
        assert.notEqual(r.status, 0, r.stdout);
        assert.match(r.stderr, why);
        assert.deepEqual(fs.readFileSync(ws.cfgPath), before, 'config.json is byte-identical');
        assert.ok(!fs.existsSync(path.join(ws.dir, 'blindfold.json')));
      }
      assert.deepEqual(snapshotLaunchFiles(), launch, 'no launcher file changed');
    } finally {
      squatter.close();
    }
  } finally {
    restoreLaunchFiles(launch);
    for (const ws of cases) fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('the gateway owns the interceptor: dashboard changes, a lost interceptor and a gateway restart are reconciled', { skip: !HAS_OPENSSL && 'posix + openssl' }, async () => {
  const ws = makeWorkspace({ certs: true });
  const gwPort = await freePort();
  const bfPort = await freePort();
  writeConfig(ws, gwPort, bfPort);
  const launch = snapshotLaunchFiles();
  let gw = await startGateway(ws, gwPort);
  const bfState = () => probe(ws, `s.probeBlindfold(${bfPort})`);
  try {
    // 1. the dashboard turns blindfold on for the Codex target
    const on = await api(ws, gwPort, '/api/switch', { target: 'responses', profile: 'bf' });
    assert.equal(on.success, true, JSON.stringify(on));
    let st = await waitFor(async () => { const s = await bfState(); return s.state === 'ours' && s; });
    assert.equal(st.gatewayPort, gwPort);
    assert.equal(st.prefix, '/backend-api/codex');

    // 2. the dashboard changes the prefix: the interceptor is respawned with it
    const saved = await api(ws, gwPort, '/api/save-profile', { key: 'bf', profile: { blindfoldPrefix: '/backend-api/codex2' } });
    assert.notEqual(saved.success, false, JSON.stringify(saved));
    st = await waitFor(async () => { const s = await bfState(); return s.prefix === '/backend-api/codex2' && s; });
    assert.equal(st.prefix, '/backend-api/codex2');

    // 3. the interceptor dies; a sync brings it back
    process.kill(st.pid, 'SIGTERM');
    await waitFor(async () => (await bfState()).state === 'free');
    const sync = await api(ws, gwPort, '/api/blindfold/sync', {});
    assert.equal(sync.ok, true, JSON.stringify(sync));
    assert.equal((await bfState()).state, 'ours');

    // 4. reboot case: interceptor and gateway gone, the gateway starts again on its own
    process.kill((await bfState()).pid, 'SIGTERM');
    gw.kill();
    await waitFor(async () => (await bfState()).state === 'free');
    gw = await startGateway(ws, gwPort);
    st = await waitFor(async () => { const s = await bfState(); return s.state === 'ours' && s; });
    assert.equal(st.gatewayPort, gwPort, 'the gateway starts the interceptor at boot');

    // 5. a foreign process on the new interceptor port: the caller sees the failure
    const squatter = net.createServer(s => s.end());
    const squatPort = await new Promise(r => squatter.listen(0, '127.0.0.1', () => r(squatter.address().port)));
    try {
      const bad = await api(ws, gwPort, '/api/save-profile', { key: 'bf', profile: { blindfoldPort: squatPort } });
      assert.equal(bad.success, false);
      assert.match(bad.error, /held by another process/);
      assert.equal((await bfState()).state, 'free', 'the interceptor on the old port was stopped');
    } finally {
      squatter.close();
    }

    // 6. turning the Codex target off stops the interceptor
    await api(ws, gwPort, '/api/save-profile', { key: 'bf', profile: { blindfoldPort: bfPort } });
    await waitFor(async () => (await bfState()).state === 'ours');
    await api(ws, gwPort, '/api/switch', { target: 'responses', profile: null });
    assert.equal(await waitFor(async () => (await bfState()).state === 'free'), true);
  } finally {
    try { const s = await bfState(); if (s.state === 'ours') process.kill(s.pid, 'SIGTERM'); } catch {}
    gw.kill();
    restoreLaunchFiles(launch);
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});
