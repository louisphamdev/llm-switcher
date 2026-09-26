// Task 5 (interceptor half) — R5, R6, R7b and the clause the gate names: an in-place tool-set
// update must keep the port open and leave a request that is already on the wire to finish.
//
// The invariant again: the CLI never becomes a proxy. It writes config.json, then asks the
// interceptor to re-derive its own tool set over one authenticated loopback POST — the body is
// ignored, because the interceptor owns the config (Finding 4, option (a)).
//
// state.mjs binds its paths at import time, so this file has one state dir for everything it does
// and every CLI child is pointed at the same one.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-task5i-'));
process.env.LLM_SWITCHER_HOME = TMP;
process.env.LLM_SWITCHER_STATE_DIR = TMP;
process.env.LLM_SWITCHER_CONFIG = path.join(TMP, 'config.json');
delete process.env.LLM_SWITCHER_BLINDFOLD_CERTS;

const s = await import('../state.mjs');

const INTERCEPTOR = path.join(ROOT, 'blindfold', 'blindfold.mjs');
const CERT_SCRIPT = path.join(ROOT, 'blindfold', 'make-certs.sh');
const CA_PEM = path.join(TMP, 'blindfold', 'certs', 'ca.pem');

// Windows has no `bash` on PATH, but Git for Windows ships one and it carries openssl — which is
// all make-certs.sh needs. Without either, these tests say so instead of passing unasserted.
function findBash() {
  for (const candidate of ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe', '/usr/bin/bash', '/bin/bash']) {
    try {
      const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
      if (!probe.error && probe.status === 0) return candidate;
    } catch { /* try the next one */ }
  }
  return null;
}
const BASH = findBash();
const toBashPath = (p) => p.replace(/\\/g, '/');

let certProblem = null;
try {
  if (!BASH) throw new Error('no bash (needs Git for Windows on this machine)');
  const r = spawnSync(BASH, [CERT_SCRIPT, 'chatgpt.com', toBashPath(path.join(TMP, 'blindfold', 'certs'))], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`make-certs.sh failed: ${r.stderr || r.stdout}`);
} catch (err) {
  certProblem = err.message;
}
const noCerts = certProblem ? `needs certificates: ${certProblem}` : false;

const TOKEN = s.ensureAdminToken();
const STATE = s.blindfoldStatePath;

const freePort = async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
};

// ---------- an interceptor process, and the gateway it relays to ----------

// The gateway stands in for proxy.mjs: the interceptor only has to reach something that answers,
// and `delayMs` is what puts a request on the wire across a `switch off`.
function fakeGateway({ delayMs = 0 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url });
      const body = JSON.stringify({ ok: true });
      const send = () => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      };
      if (delayMs) setTimeout(send, delayMs).unref?.();
      else send();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      seen,
      close: () => new Promise((r) => server.close(r))
    }));
  });
}

async function startInterceptor({ port, gatewayPort, config, activeTools = 'claude,codex' }) {
  const child = spawn(process.execPath, [
    INTERCEPTOR,
    '--port', String(port),
    '--gateway-port', String(gatewayPort),
    '--config', config,
    '--token-file', s.adminTokenPath,
    '--certs', path.join(TMP, 'blindfold', 'certs'),
    '--active-tools', activeTools
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', (d) => output.push(String(d)));
  child.stderr.on('data', (d) => output.push(String(d)));

  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill();
    await once(child, 'exit').catch(() => {});
  };

  const deadline = Date.now() + 8000;
  let probe = { state: 'free' };
  while (Date.now() < deadline && probe.state !== 'ours') {
    if (child.exitCode !== null) throw new Error(`interceptor exited with ${child.exitCode}:\n${output.join('')}`);
    probe = await s.probeBlindfold(port);
    if (probe.state !== 'ours') await new Promise((r) => setTimeout(r, 100));
  }
  if (probe.state !== 'ours') {
    await stop();
    throw new Error(`interceptor never answered as ours (state=${probe.state}):\n${output.join('')}`);
  }
  return { child, stop, port, pid: probe.pid };
}

// ---------- a CONNECT tunnel, then TLS and an HTTP request inside it ----------

async function raceTimeout(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const readUntilHead = (socket) => new Promise((resolve, reject) => {
  let buf = '';
  const onData = (c) => {
    buf += String(c);
    if (buf.includes('\r\n\r\n')) { socket.off('data', onData); socket.off('error', onError); resolve(buf); }
  };
  const onError = (e) => reject(e);
  socket.on('data', onData);
  socket.on('error', onError);
  const timer = setTimeout(() => {
    socket.off('data', onData);
    reject(new Error(`no response head within 8s: ${JSON.stringify(buf.slice(0, 400))}`));
  }, 8000);
  socket.once('close', () => clearTimeout(timer));
});

async function openTls(proxyPort, host) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await raceTimeout(once(socket, 'connect'), 5000, `CONNECT to 127.0.0.1:${proxyPort}`);
  socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
  const head = await readUntilHead(socket);
  assert.match(head, /^HTTP\/1\.1 200 /, `CONNECT refused: ${head}`);
  const secure = tls.connect({ socket, servername: host, ca: fs.readFileSync(CA_PEM), rejectUnauthorized: true });
  await raceTimeout(once(secure, 'secureConnect'), 8000, 'TLS handshake');
  return secure;
}

function tryParse(buf, ended) {
  const text = buf.toString('latin1');
  const i = text.indexOf('\r\n\r\n');
  if (i === -1) return null;
  const head = text.slice(0, i);
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
  if (!m) return null;
  const status = Number(m[1]);
  const len = /content-length:\s*(\d+)/i.exec(head);
  if (len) {
    const need = Number(len[1]);
    if (buf.length < i + 4 + need) return null;
    return { status, head, body: buf.slice(i + 4, i + 4 + need).toString('utf8') };
  }
  if (ended || status === 421 || status === 502 || status === 400 || status === 404) {
    return { status, head, body: buf.slice(i + 4).toString('utf8') };
  }
  return null;
}

function readResponse(stream, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(tryParse(Buffer.concat(chunks), true) ?? { status: 0, head: Buffer.concat(chunks).toString('latin1'), body: '' });
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.on('data', (c) => {
      chunks.push(c);
      const done = tryParse(Buffer.concat(chunks), false);
      if (done) { settled = true; clearTimeout(timer); resolve(done); }
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
  });
}

function post(secure, { url, host, body = '', headers = {} }) {
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  secure.write(`POST ${url} HTTP/1.1\r\nHost: ${host}\r\n`
    + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${extra}\r\n${body}`);
  return readResponse(secure);
}

// ---------- the CLI, pointed at this file's state dir ----------

function runCli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'switch.mjs'), ...args], {
      env: {
        ...process.env, HOME: TMP, USERPROFILE: TMP, CLAUDE_CONFIG_DIR: path.join(TMP, 'claude'),
        LLM_SWITCHER_STATE_DIR: TMP, LLM_SWITCHER_PORT: '', PORT: '', ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
}

// A config already in the new shape: no legacy pointer, so loading it writes nothing. Anything the
// CLI changes below is this command's own doing.
function writeConfig(file, port, bfPort, { claude = 'a', codex = 'b' } = {}) {
  fs.writeFileSync(file, JSON.stringify({
    port,
    blindfold: { port: bfPort },
    activeProfiles: { claude, codex },
    profiles: {
      a: { name: 'A', mode: 'convert', tool: 'claude', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { opus: 'x' } },
      b: { name: 'B', mode: 'convert', tool: 'codex', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { main: 'y' } }
    }
  }, null, 2), { mode: 0o600 });
  return file;
}

const envFile = (name) => path.join(TMP, `env-${name}.sh`);
const seedEnv = () => {
  fs.writeFileSync(envFile('claude'), "export HTTPS_PROXY='claude'\n");
  fs.writeFileSync(envFile('codex'), "export HTTPS_PROXY='codex'\n");
};

// ==================================================================
// R6 — an in-place tool-set update keeps the port open
// ==================================================================

test('R6: switch off claude empties env-claude.sh, keeps codex active, and an in-flight request through the interceptor completes without the port restarting', { skip: noCerts }, async (t) => {
  const gateway = await fakeGateway({ delayMs: 900 });
  t.after(() => gateway.close());
  const bfPort = await freePort();
  const cfg = path.join(TMP, 'cfg-inflight.json');
  writeConfig(cfg, gateway.port, bfPort);
  seedEnv();

  const it = await startInterceptor({ port: bfPort, gatewayPort: gateway.port, config: cfg, activeTools: 'claude,codex' });
  t.after(() => it.stop());

  // A request on the wire: it is written, not awaited, so the switch below runs across it.
  const secure = await openTls(bfPort, 'api.anthropic.com');
  t.after(() => secure.destroy());
  const inflight = post(secure, {
    url: '/v1/messages',
    host: 'api.anthropic.com',
    body: JSON.stringify({ model: 'x' }),
    headers: { 'content-type': 'application/json' }
  });
  // Give the interceptor time to have the request in hand before anything is changed.
  await new Promise((r) => setTimeout(r, 150));

  const sw = await runCli(['off', 'claude'], { LLM_SWITCHER_CONFIG: cfg });
  assert.equal(sw.status, 0, sw.stdout + sw.stderr);

  const resp = await inflight;
  assert.equal(resp.status, 200, `the in-flight request must finish, got ${resp.status}: ${resp.head}`);
  assert.deepEqual(JSON.parse(resp.body), { ok: true }, 'and carry the gateway answer through');

  // Same process, same port: an update is not a restart.
  const after = await s.probeBlindfold(bfPort);
  assert.equal(after.state, 'ours', 'the interceptor still answers');
  assert.equal(after.pid, it.pid, 'the same interceptor process: the port was never rebound');
  assert.equal(after.activeTools, 'codex', 'it re-derived the set from config.json on its own');

  assert.equal(fs.readFileSync(envFile('claude'), 'utf8'), '', 'env-claude.sh emptied');
  assert.match(fs.readFileSync(envFile('codex'), 'utf8'), new RegExp(`export HTTPS_PROXY='http://127.0.0.1:${bfPort}'`), 'codex still has the interceptor behind it');
  assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).activeProfiles.claude, null, 'claude pointer cleared');
  assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).activeProfiles.codex, 'b', 'codex still active');
});

// ==================================================================
// R7b — collision mode: turn one tool off, leave the other running
// ==================================================================

test('R7b: during collision, switch off claude exits 0, leaves env-codex.sh untouched, and the Codex interceptor still answers', { skip: noCerts }, async (t) => {
  const gateway = await fakeGateway({ delayMs: 0 });
  t.after(() => gateway.close());
  const bfPort = await freePort();
  const cfg = path.join(TMP, 'cfg-collision.json');
  // `p` serves both tools, so migration would split it into p-claude and p-codex — and p-codex
  // already exists. The file this build refuses to rewrite. anthropic/responses stay absent: seeded
  // to null they would say both tools are off, and there would be no "other tool" left to keep.
  fs.writeFileSync(cfg, JSON.stringify({
    port: gateway.port,
    activeProfile: 'p',
    blindfold: { port: bfPort },
    activeProfiles: { 'openai-chat': null, vertex: null },
    profiles: {
      p: { name: 'P', mode: 'convert', inFormat: 'auto', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { opus: 'x', main: 'y' } },
      'p-codex': { name: 'P codex', mode: 'convert', tool: 'codex', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { main: 'y' } }
    }
  }, null, 2), { mode: 0o600 });
  const before = fs.readFileSync(cfg, 'utf8');
  seedEnv();

  const it = await startInterceptor({ port: bfPort, gatewayPort: gateway.port, config: cfg, activeTools: 'claude,codex' });
  t.after(() => it.stop());

  const sw = await runCli(['off', 'claude'], { LLM_SWITCHER_CONFIG: cfg });
  assert.equal(sw.status, 0, `a refused save must not make "switch off" unusable:\n${sw.stdout}${sw.stderr}`);

  const after = await s.probeBlindfold(bfPort);
  assert.equal(after.state, 'ours', 'the Codex interceptor still answers');
  assert.equal(after.activeTools, 'codex', 'claude is off, codex is not');

  assert.equal(fs.readFileSync(envFile('claude'), 'utf8'), '', 'env-claude.sh emptied');
  assert.equal(fs.readFileSync(envFile('codex'), 'utf8'), "export HTTPS_PROXY='codex'\n", 'env-codex.sh untouched');

  const now = fs.readFileSync(cfg, 'utf8');
  const parsed = JSON.parse(now);
  assert.equal(parsed.activeProfiles.claude, null, 'claude pointer cleared');
  assert.equal(parsed.activeProfile, 'p', 'the legacy pointer this build will not rewrite stays');
  assert.ok(now.includes('"inFormat"'), 'the colliding file was not migrated behind the user\'s back');
  assert.ok(now !== before, 'only the one pointer changed');
});

// ==================================================================
// R5 — the interceptor re-derives its own set; the body carries nothing
// ==================================================================

test('R5: with no gateway answering, switch off codex posts to the interceptor and it re-derives the tool set from config.json', { skip: noCerts }, async (t) => {
  const gateway = await fakeGateway({ delayMs: 0 });
  t.after(() => gateway.close());
  const bfPort = await freePort();
  const cfg = path.join(TMP, 'cfg-rederive.json');
  writeConfig(cfg, gateway.port, bfPort);
  seedEnv();

  const it = await startInterceptor({ port: bfPort, gatewayPort: gateway.port, config: cfg, activeTools: 'claude,codex' });
  t.after(() => it.stop());

  // No gateway of ours is running, so the CLI has to talk to the interceptor itself.
  const sw = await runCli(['off', 'codex'], { LLM_SWITCHER_CONFIG: cfg });
  assert.equal(sw.status, 0, sw.stdout + sw.stderr);

  const after = await s.probeBlindfold(bfPort);
  assert.equal(after.state, 'ours', 'the port stayed open through the update');
  assert.equal(after.activeTools, 'claude', 'codex is off, claude is not');
  assert.equal(fs.readFileSync(envFile('codex'), 'utf8'), '', 'env-codex.sh emptied');
  assert.match(fs.readFileSync(envFile('claude'), 'utf8'), new RegExp(`export HTTPS_PROXY='http://127.0.0.1:${bfPort}'`), 'claude still has the interceptor behind it');
});

// ==================================================================
// the recorded state may not outlive the process it names
// ==================================================================

test('stopRecordedBlindfold deletes blindfold.json only after the interceptor port no longer answers ours', { skip: noCerts }, async (t) => {
  const gwPort = await freePort();
  const bfPort = await freePort();
  const cfg = path.join(TMP, 'cfg-recorded.json');
  writeConfig(cfg, gwPort, bfPort);

  const gateway = await fakeGateway({ delayMs: 0 });
  t.after(() => gateway.close());
  const it = await startInterceptor({ port: bfPort, gatewayPort: gwPort, config: cfg, activeTools: 'claude,codex' });
  t.after(() => it.stop());

  fs.writeFileSync(STATE, JSON.stringify({ port: bfPort, pid: it.pid }), { mode: 0o600 });
  const live = await s.probeBlindfold(bfPort);
  assert.equal(live.state, 'ours', 'sanity: it answers as ours before anything is stopped');

  const r = await s.stopRecordedBlindfold();
  assert.equal(r.ok, true, r.error);

  const now = await s.probeBlindfold(bfPort);
  assert.notEqual(now.state, 'ours', 'the port no longer answers as ours');
  assert.notEqual(now.state, 'legacy-ours', 'nor as an older build of ours');
  assert.equal(fs.existsSync(STATE), false, 'the record is gone once the process it names is gone');
});

test('stopRecordedBlindfold never signals a foreign process holding the recorded port', { skip: noCerts }, async (t) => {
  const port = await freePort();
  // A listener that answers with a body this switcher does not recognise: not ours, not killable.
  const stranger = http.createServer((req, res) => res.end('{"hello":true}'));
  await new Promise((r) => stranger.listen(port, '127.0.0.1', r));
  t.after(() => new Promise((r) => stranger.close(r)));

  fs.writeFileSync(STATE, JSON.stringify({ port, pid: process.pid }), { mode: 0o600 });
  const r = await s.stopRecordedBlindfold();

  assert.equal(r.ok, true, 'a port that is not ours is nothing to stop');
  let alive = false;
  try { alive = (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { /* gone */ }
  assert.equal(alive, true, 'a foreign listener must survive: this switcher never signals a pid it did not prove');
  assert.equal(fs.existsSync(STATE), false, 'and the stale record is cleared');
});

process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
