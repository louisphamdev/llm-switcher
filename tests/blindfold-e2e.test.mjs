// Task 7 — A3, end to end: a Claude Code shaped request through the interceptor, with a fake
// upstream standing in for api.anthropic.com.
//
// What this proves is the whole invariant: the switcher sits in the middle and nowhere else.
// /v1/messages is healed by the local gateway, /api/oauth/* reaches the real host, the OAuth body
// never lands in a capture, and the client is told nothing except a normal HTTPS answer.
//
// The one test-only trick is a `--import` hook on the interceptor child: it points the upstream
// hop of api.anthropic.com at the fake server on this machine. Production code is untouched —
// the interceptor still asks for `api.anthropic.com` by name and still gets that name in SNI.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-e2e-'));
const CERTS = path.join(TMP, 'blindfold', 'certs');
const CA_PEM = path.join(CERTS, 'ca.pem');
const CAPTURES = path.join(TMP, 'captures');

process.env.LLM_SWITCHER_HOME = TMP;
process.env.LLM_SWITCHER_STATE_DIR = TMP;
process.env.LLM_SWITCHER_CONFIG = path.join(TMP, 'config.json');
process.env.LLM_SWITCHER_BLINDFOLD_CERTS = CERTS;
delete process.env.LLM_SWITCHER_BLINDFOLD_PORT;

const s = await import('../state.mjs');
const TOKEN_FILE = s.adminTokenPath;
s.ensureAdminToken();

const INTERCEPTOR = path.join(ROOT, 'blindfold', 'blindfold.mjs');
const CERT_SCRIPT = path.join(ROOT, 'blindfold', 'make-certs.sh');

// ---------- certificates ----------

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

let certProblem = null;
try {
  if (!BASH) throw new Error('no bash (needs Git for Windows on this machine)');
  const r = spawnSync(BASH, [CERT_SCRIPT, 'chatgpt.com', CERTS.replace(/\\/g, '/')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`make-certs.sh failed: ${r.stderr || r.stdout}`);
} catch (err) {
  certProblem = err.message;
}
const noCerts = certProblem ? `needs certificates: ${certProblem}` : false;

// ---------- the two servers the traffic is split between ----------

// The provider. It holds a certificate for api.anthropic.com signed by the test CA, so the
// interceptor's re-originated hop verifies exactly as it would against the real host.
async function fakeUpstream() {
  const server = https.createServer({
    key: fs.readFileSync(path.join(CERTS, 'leaf.key')),
    cert: fs.readFileSync(path.join(CERTS, 'leaf.pem'))
  }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = req.url.startsWith('/api/oauth/token')
        ? '{"ok":"upstream-oauth"}'
        : '{"ok":"upstream-messages"}';
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      server.seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
    });
  });
  server.seen = [];
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen: server.seen, close: () => new Promise((r) => server.close(r)) };
}

// The upstream the gateway forwards to. A marker only this server can return is what tells the
// test that the answer came through the gateway and not from anywhere else.
async function echoUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.stringify({ via: 'gateway-upstream', url: req.url });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      server.seen.push({ method: req.method, url: req.url });
    });
  });
  server.seen = [];
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen: server.seen, close: () => new Promise((r) => server.close(r)) };
}

// ---------- the interceptor child, with the upstream hop pointed at this machine ----------

const REDIRECT = path.join(TMP, 'redirect-upstream.mjs');
fs.writeFileSync(REDIRECT, [
  "import https from 'node:https';",
  'const UP = Number(process.env.TEST_UPSTREAM_PORT);',
  'const orig = https.request;',
  'https.request = function (options, ...rest) {',
  '  let o = options;',
  "  if (o && typeof o === 'object' && o.host === 'api.anthropic.com' && Number(o.port) === 443) {",
  "    o = { ...o, host: '127.0.0.1', port: UP };  // SNI and the identity check keep api.anthropic.com",
  '  }',
  '  return orig.call(this, o, ...rest);',
  '};',
  ''
].join('\n'));

async function startInterceptor({ port, gatewayPort, config, upstreamPort }) {
  fs.mkdirSync(CAPTURES, { recursive: true });
  const importArg = `--import=${pathToFileURL(REDIRECT).href}`;
  const nodeOptions = [process.env.NODE_OPTIONS, importArg].filter(Boolean).join(' ');
  const child = spawn(process.execPath, [
    INTERCEPTOR,
    '--port', String(port),
    '--gateway-port', String(gatewayPort),
    '--config', config,
    '--token-file', TOKEN_FILE,
    '--certs', CERTS,
    '--active-tools', 'claude',
    '--capture', CAPTURES
  ], {
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      NODE_EXTRA_CA_CERTS: CA_PEM,
      TEST_UPSTREAM_PORT: String(upstreamPort)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
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
    if (child.exitCode !== null) throw new Error(`interceptor exited ${child.exitCode}:\n${output.join('')}`);
    probe = await s.probeBlindfold(port);
    if (probe.state !== 'ours') await new Promise((r) => setTimeout(r, 100));
  }
  if (probe.state !== 'ours') {
    await stop();
    throw new Error(`interceptor never answered as ours (state=${probe.state}):\n${output.join('')}`);
  }
  return { child, stop, port };
}

async function startGateway(t, port, cfgPath) {
  const child = spawn(process.execPath, [path.join(ROOT, 'proxy.mjs'), '--port', String(port)], {
    env: {
      ...process.env, LLM_SWITCHER_CONFIG: cfgPath, LLM_SWITCHER_STATE_DIR: TMP,
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude'), LLM_SWITCHER_PORT: '', PORT: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill();
    await once(child, 'exit').catch(() => {});
  };
  t.after(stop);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return stop; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  await stop();
  throw new Error(`gateway did not start: ${log}`);
}

// ---------- an HTTPS client behind the interceptor ----------

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

function tryParse(buf, ended) {
  const text = buf.toString('latin1');
  const i = text.indexOf('\r\n\r\n');
  if (i === -1) return null;
  const head = text.slice(0, i);
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
  if (!m) return null;
  const status = Number(m[1]);
  const start = i + 4;
  const len = /content-length:\s*(\d+)/i.exec(head);
  if (len) {
    const need = Number(len[1]);
    if (buf.length < start + need) return null;
    return { status, head, body: buf.slice(start, start + need).toString('utf8') };
  }
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    // A gateway answer is streamed, so it arrives in chunks. Reading the raw bytes as JSON
    // would parse the hex length as the value and stop on the first letter of the real one.
    let pos = start;
    const parts = [];
    for (;;) {
      const eol = buf.indexOf('\r\n', pos);
      if (eol === -1) return ended ? { status, head, body: Buffer.concat(parts).toString('utf8') } : null;
      const size = parseInt(buf.slice(pos, eol).toString('latin1').split(';')[0], 16);
      if (Number.isNaN(size)) return null;
      if (size === 0) return { status, head, body: Buffer.concat(parts).toString('utf8') };
      const dataStart = eol + 2;
      if (buf.length < dataStart + size + 2) return ended ? { status, head, body: Buffer.concat(parts).toString('utf8') } : null;
      parts.push(buf.slice(dataStart, dataStart + size));
      pos = dataStart + size + 2;
    }
  }
  if (ended || status === 421 || status === 502 || status === 400 || status === 404) {
    return { status, head, body: buf.slice(start).toString('utf8') };
  }
  return null;
}

function readResponse(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const all = Buffer.concat(chunks);
      resolve(tryParse(all, true) ?? { status: 0, head: all.toString('latin1'), body: '' });
    };
    const timer = setTimeout(done, 8000);
    stream.on('data', (c) => {
      chunks.push(c);
      const parsed = tryParse(Buffer.concat(chunks), false);
      if (parsed) { settled = true; clearTimeout(timer); resolve(parsed); }
    });
    stream.on('end', done);
    stream.on('close', done);
    stream.on('error', done);
  });
}

// Exactly what Claude Code does: CONNECT to the proxy, TLS to the target name inside it, then
// a plain POST as if the switcher were not there.
async function callThrough(proxyPort, url, body, { host = 'api.anthropic.com', headers = {} } = {}) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
  const head = await readUntilHead(socket);
  assert.match(head, /^HTTP\/1\.1 200 /, `CONNECT refused: ${head}`);

  const secure = tls.connect({
    socket, servername: host, ca: fs.readFileSync(CA_PEM), rejectUnauthorized: true
  });
  await once(secure, 'secureConnect');

  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  secure.write(`POST ${url} HTTP/1.1\r\nHost: ${host}\r\n`
    + 'Content-Type: application/json\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${extra}\r\n${body}`);
  return readResponse(secure);
}

// ==================================================================

test('A3: a Claude Code request through the interceptor reaches the gateway for /v1/messages and the real host for /api/oauth/*', { skip: noCerts }, async (t) => {
  const provider = await fakeUpstream();
  t.after(() => provider.close());
  const echoed = await echoUpstream();
  t.after(() => echoed.close());

  const gwPort = await freePort();
  const bfPort = await freePort();
  const cfgPath = path.join(TMP, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: gwPort,
    blindfold: { port: bfPort },
    activeProfiles: { claude: 'c', codex: null },
    profiles: {
      c: {
        name: 'Claude direct',
        mode: 'direct',
        tool: 'claude',
        outFormat: 'anthropic',
        baseURL: `http://127.0.0.1:${echoed.port}/v1`,
        apiKey: 'sk-test',
        defaultModels: { opus: 'claude-opus-4-7', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-20251001', fable: 'claude-haiku-4-5-20251001' },
        model1M: { opus: false, sonnet: false, haiku: false, fable: false }
      }
    }
  }, null, 2), { mode: 0o600 });

  // The interceptor first: the gateway reconciles the interceptor it finds, and one that is
  // already ours must not be replaced by a second process on the same port.
  const it = await startInterceptor({ port: bfPort, gatewayPort: gwPort, config: cfgPath, upstreamPort: provider.port });
  t.after(() => it.stop());
  await startGateway(t, gwPort, cfgPath);

  const payload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hello' }]
  });

  // 1. The API call is healed by the gateway: the marker can only come from the upstream the
  //    gateway forwards to, so nothing on api.anthropic.com was asked.
  const api = await callThrough(bfPort, '/v1/messages', payload);
  assert.equal(api.status, 200, `through the gateway: ${api.head}`);
  assert.deepEqual(JSON.parse(api.body), { via: 'gateway-upstream', url: '/v1/messages' },
    'the answer came from this switcher, not from the provider');
  assert.ok(echoed.seen.some((r) => r.url === '/v1/messages'), 'the gateway forwarded it');

  // 2. Sign-in traffic keeps going to the real host, with nothing captured.
  const oauth = await callThrough(bfPort, '/api/oauth/token',
    JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'super-secret-refresh' }));
  assert.equal(oauth.status, 200, `through to the provider: ${oauth.head}`);
  assert.deepEqual(JSON.parse(oauth.body), { ok: 'upstream-oauth' },
    'the OAuth exchange reached the fake provider directly');
  assert.ok(provider.seen.some((r) => r.url === '/api/oauth/token'), 'the provider saw the sign-in call');
  assert.ok(!provider.seen.some((r) => r.url === '/v1/messages'),
    'the API call never left this machine for the provider');

  // 3. The capture holds the shape of the OAuth exchange and not a byte of it.
  const oauthCaptures = fs.readdirSync(CAPTURES).filter((f) => f.includes('api_oauth_token'));
  assert.equal(oauthCaptures.length, 1, `one capture for the OAuth call, got: ${oauthCaptures.join(', ') || 'none'}`);
  const record = JSON.parse(fs.readFileSync(path.join(CAPTURES, oauthCaptures[0]), 'utf8'));
  assert.equal('requestBody' in record, false, 'R3c: a pass-through body is never stored');
  assert.equal('responseBody' in record, false, 'R3c: nor the answer to it');
  assert.ok(!JSON.stringify(record).includes('super-secret-refresh'),
    'the refresh token is not anywhere in the capture');

  // 4. Through all of it, the interceptor is still the same process on the same port.
  const after = await s.probeBlindfold(bfPort);
  assert.equal(after.state, 'ours', 'the interceptor is still ours');
  assert.equal(after.activeTools, 'claude', 'and it serves exactly the tool that was asked for');
});

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
