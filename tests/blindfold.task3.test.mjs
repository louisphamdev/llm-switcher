// Task 3 — R3, R3a, R3b, R3c and Acceptance A4, A4b, A9, A12.
//
// The invariant this task has to hold: the interceptor stands in the middle of the network and
// touches nothing else. It answers on a fixed host table instead of a host it was told, it
// carries one certificate for those three hosts, it has no prefix to choose, it keeps the bytes
// of a pass-through exchange out of the capture, and the only thing that can change while it
// runs — the active tool set — arrives over one authenticated loopback POST.
//
// state.mjs binds its paths (config, admin token, CA) at import time, so the workspace has to
// exist before the import. The test runner gives each test file its own process, so this
// environment is this file's alone.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-task3-'));
process.env.LLM_SWITCHER_HOME = TMP;
process.env.LLM_SWITCHER_CONFIG = path.join(TMP, 'config.json');
delete process.env.LLM_SWITCHER_BLINDFOLD_CERTS;

const s = await import('../state.mjs');
const bf = await import('../blindfold/blindfold.mjs');

const INTERCEPTOR = path.join(ROOT, 'blindfold', 'blindfold.mjs');
const CERT_SCRIPT = path.join(ROOT, 'blindfold', 'make-certs.sh');
const CA_PEM = path.join(TMP, 'blindfold', 'certs', 'ca.pem');

// Windows has no `bash` on PATH, but Git for Windows ships one and it carries openssl — which is
// all make-certs.sh needs. Without either, the certificate tests say so instead of passing
// with no assertion at all.
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

function makeCerts(outDir) {
  // The host argument is from an older command line and is ignored (R3): only the directory counts.
  const r = spawnSync(BASH, [CERT_SCRIPT, 'chatgpt.com', toBashPath(outDir)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`make-certs.sh failed: ${r.stderr || r.stdout}`);
}

let certProblem = null;
try {
  if (!BASH) throw new Error('no bash (needs Git for Windows on this machine)');
  makeCerts(path.join(TMP, 'blindfold', 'certs'));
} catch (err) {
  certProblem = err.message;
}
const noCerts = certProblem ? `needs certificates: ${certProblem}` : false;

const TOKEN = s.ensureAdminToken();
const freePort = async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
};

// ---------- an interceptor process, and the gateway it relays to ----------

function fakeGateway({ delayMs = 0 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
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

function writeConfigFile(file, value) {
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

async function startInterceptor({ port, gatewayPort, config, activeTools = 'claude,codex', capture = null }) {
  const cfgFile = path.join(TMP, `cfg-${port}.json`);
  writeConfigFile(cfgFile, config ?? { activeProfiles: { anthropic: 'a', codex: 'b' } });
  const args = [
    INTERCEPTOR,
    '--port', String(port),
    '--gateway-port', String(gatewayPort),
    '--config', cfgFile,
    '--token-file', s.adminTokenPath,
    '--certs', path.join(TMP, 'blindfold', 'certs'),
    '--active-tools', activeTools
  ];
  if (capture) args.push('--capture', capture);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', (d) => output.push(String(d)));
  child.stderr.on('data', (d) => output.push(String(d)));

  const stop = async () => {
    if (child.exitCode !== null) return;   // already gone: waiting for 'exit' would never resolve
    child.kill();
    await once(child, 'exit').catch(() => {});
  };

  const deadline = Date.now() + 8000;
  let probe = { state: 'free' };
  while (Date.now() < deadline && probe.state !== 'ours') {
    if (child.exitCode !== null) {
      throw new Error(`interceptor exited with ${child.exitCode}:\n${output.join('')}`);
    }
    probe = await s.probeBlindfold(port);
    if (probe.state !== 'ours') await new Promise((r) => setTimeout(r, 100));
  }
  if (probe.state !== 'ours') {
    await stop();
    throw new Error(`interceptor never answered as ours (state=${probe.state}):\n${output.join('')}`);
  }
  return { child, cfgFile, stop, port };
}

// ---------- a CONNECT tunnel, then HTTP or an upgrade inside it ----------

// A test that waits forever reports nothing, so every wait here is bounded and says which stage
// it was in.
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
    socket.off('error', onError);
    reject(new Error(`no response head within 8s: ${JSON.stringify(buf.slice(0, 400))}`));
  }, 8000);
  const clear = () => clearTimeout(timer);
  socket.once('close', clear);
  const origResolve = resolve;
  resolve = (v) => { clear(); origResolve(v); };
});

async function tunnel(proxyPort, host) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await raceTimeout(once(socket, 'connect'), 5000, `CONNECT to 127.0.0.1:${proxyPort}`);
  socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
  const head = await readUntilHead(socket);
  assert.match(head, /^HTTP\/1\.1 200 /, `CONNECT refused: ${head}`);
  return socket;
}

async function openTls(proxyPort, host) {
  const socket = await tunnel(proxyPort, host);
  const secure = tls.connect({ socket, servername: host, ca: fs.readFileSync(CA_PEM), rejectUnauthorized: true });
  // `once` rejects on 'error', so a handshake failure surfaces as itself.
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
  // No length to wait for: the answer is complete when the peer stops writing.
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

async function post(secure, { method = 'POST', url, host, body = '', headers = {} }) {
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  secure.write(`${method} ${url} HTTP/1.1\r\nHost: ${host}\r\n`
    + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${extra}\r\n${body}`);
  return readResponse(secure);
}

// ==================================================================
// a live interceptor, driven over a real CONNECT tunnel
// ==================================================================

// ==================================================================
// R3a — one leaf for the host table, and a CA that may only sign for it
// ==================================================================

test('A4: make-certs.sh names all three hosts, and the CA may sign for nothing else', { skip: noCerts }, () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'leaf-'));
  makeCerts(dir);

  const leaf = fs.readFileSync(path.join(dir, 'leaf.pem'), 'utf8');
  for (const host of s.INTERCEPT_HOSTS) {
    assert.equal(s.certCoversHost(leaf, host), true, `leaf must cover ${host}`);
  }
  assert.equal(s.certCoversHost(leaf, 'evil.test'), false, 'the leaf names only the table');
  assert.equal(s.certCoversHost(leaf, 'sub.chatgpt.com'), false, 'no wildcard entry: one leaf, three names');

  // The CA is the credential that matters: if it could sign for another name, its key alone
  // would be enough to impersonate any host on this machine. OpenSSL prints the constraint as a
  // `Permitted:` block of DNS names, so assert on that block and not on the whole certificate.
  const ca = path.join(dir, 'ca.pem');
  const text = spawnSync(BASH, ['-c', `openssl x509 -in "${toBashPath(ca)}" -noout -text`], { encoding: 'utf8' }).stdout;
  const at = text.indexOf('X509v3 Name Constraints');
  assert.ok(at !== -1, `the CA carries name constraints:\n${text}`);
  const constraints = text.slice(at);
  assert.match(constraints, /Permitted:/, 'these constraints permit, they do not only exclude');
  for (const host of s.INTERCEPT_HOSTS) {
    assert.ok(constraints.includes(`DNS:${host}`), `CA must permit ${host}:\n${constraints}`);
  }
  assert.equal(constraints.includes('evil.test'), false, 'the CA may not sign outside the table');
});

// ==================================================================
// R3 — the host table decides; the table is exact; the tool gates it
// ==================================================================

test('R3: the host table routes whole path segments, per host, and passes everything else', () => {
  const both = new Set(['claude', 'codex']);
  const codexOnly = new Set(['codex']);
  const claudeOnly = new Set(['claude']);
  const pathOf = (host, url, tools = both) => bf.hostRoute(host, url, tools)?.gatewayPath ?? null;

  // api.anthropic.com: unchanged path, query included.
  assert.equal(pathOf('api.anthropic.com', '/v1/messages?beta=true'), '/v1/messages?beta=true');
  assert.equal(pathOf('api.anthropic.com', '/v1/messages/stream'), '/v1/messages/stream');
  assert.equal(pathOf('api.anthropic.com', '/v1/models'), null, 'that path is not anthropic');

  // api.openai.com: the responses and models families, whole segments only.
  assert.equal(pathOf('api.openai.com', '/v1/responses'), '/v1/responses');
  assert.equal(pathOf('api.openai.com', '/v1/models/gpt-5'), '/v1/models/gpt-5');
  assert.equal(pathOf('api.openai.com', '/v1/responses_compact'), null, 'not /v1/responses');
  assert.equal(pathOf('api.openai.com', '/v1/responsesfoo'), null, 'a shared prefix is not a segment');

  // chatgpt.com keeps the one rewrite the interceptor has always done.
  assert.equal(pathOf('chatgpt.com', '/backend-api/codex/chat/completions?x=1'), '/v1/chat/completions?x=1');
  assert.equal(pathOf('chatgpt.com', '/api/oauth/token'), null, 'sign-in stays on chatgpt.com');
  assert.equal(pathOf('chatgpt.com', '/backend-api/codex-usage'), null);

  // A host outside the table is never terminated: this process then only copies bytes.
  for (const other of ['example.com', 'auth.openai.com', 'chatgpt.com.evil.test', 'API.CHATGPT.COM']) {
    assert.equal(bf.hostRoute(other, '/v1/messages', both), null, `must not terminate ${other}`);
  }

  // F2: when a tool is off, its host is not in this switcher's path at all.
  assert.equal(pathOf('api.anthropic.com', '/v1/messages', codexOnly), null, 'claude off');
  assert.equal(pathOf('api.openai.com', '/v1/responses', claudeOnly), null, 'codex off');
  assert.equal(pathOf('chatgpt.com', '/backend-api/codex/x', claudeOnly), null, 'codex off');

  // Spelling is not identity: DNS ignores case and :443 is the default port.
  assert.ok(bf.hostRoute('API.Anthropic.com:443', '/v1/messages', both), 'case and port are spelling');
  assert.equal(bf.misdirected({ socket: { _connectHost: 'API.ANTHROPIC.COM:443' }, headers: { host: 'api.anthropic.com' } }), false);
});

test('A4b: a Host header that is not the CONNECT host is misdirected', () => {
  const req = (connectHost, hostHeader) => ({ socket: { _connectHost: connectHost }, headers: { host: hostHeader } });
  assert.equal(bf.misdirected(req('api.anthropic.com', 'evil.com')), true);
  assert.equal(bf.misdirected(req('chatgpt.com', 'api.openai.com')), true, 'another host of the table is still another host');
  assert.equal(bf.misdirected(req('api.anthropic.com', 'API.ANTHROPIC.COM:443')), false, 'case and :443 match');
  assert.equal(bf.misdirected(req('api.anthropic.com', 'api.anthropic.com')), false);
  assert.equal(bf.misdirected(req('api.anthropic.com', '')), true, 'HTTP/1.1 without a Host is a mismatch');
  // A socket that did not arrive through CONNECT has no tunnel host to compare against.
  assert.equal(bf.misdirected({ socket: {}, headers: { host: 'anything' } }), false);
});

test('A4b: the gateway hop carries no client credential', () => {
  const out = bf.gatewayHeaders({
    authorization: 'Bearer secret',
    'x-api-key': 'sk-live',
    cookie: 'oai-device-id=1',
    'openai-organization': 'org_1',
    'user-agent': 'codex-cli',
    'content-type': 'application/json'
  });
  const lower = Object.fromEntries(Object.entries(out).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(lower.authorization, undefined, 'the gateway has its own keys');
  assert.equal(lower['x-api-key'], undefined, 'the gateway must never see the client key');
  assert.equal(lower.cookie, undefined, 'the cookie was already stripped');
  assert.equal(lower['openai-organization'], undefined, 'an account identifier stays here too');
  assert.equal(lower['user-agent'], 'codex-cli', 'a non-credential header still travels');
  assert.equal(lower['content-type'], 'application/json');
});

test('A4b: a dot-segment escape never reaches the gateway on any host', () => {
  const both = new Set(['claude', 'codex']);
  for (const [host, url] of [
    ['chatgpt.com', '/backend-api/codex/%2e%2e/api/logs'],
    ['chatgpt.com', '/backend-api/codex/a/../../api/save-profile'],
    ['api.anthropic.com', '/v1/messages/%2e%2e/../admin/token'],
    ['api.openai.com', '/v1/responses/%2E%2E/api/logs']
  ]) {
    assert.equal(bf.hostRoute(host, url, both), null, `must not route ${host}${url}`);
  }
});

// ==================================================================
// Finding 6 — one sorted list, and the fallback pointer keys of R6
// ==================================================================

test('deriveActiveTools reads the fallback pointer keys', () => {
  assert.deepEqual(s.deriveActiveTools({ activeProfiles: { anthropic: 'a', responses: 'b', codex: null } }), ['claude']);
  assert.deepEqual(s.deriveActiveTools({ activeProfiles: { anthropic: 'a', responses: 'b' } }), ['claude', 'codex']);
  assert.deepEqual(s.deriveActiveTools({ activeProfile: 'p', activeProfiles: { claude: null } }), ['codex'],
    'an explicit off must not fall through to the legacy pointer');
  assert.deepEqual(s.deriveActiveTools({}), []);
  // Sorted, so the spawn argument and the identity proof are the same string on every run.
  assert.deepEqual(s.deriveActiveTools({ activeProfiles: { codex: 'b', claude: 'a' } }), ['claude', 'codex']);
});

// ==================================================================
// A live interceptor: identity, the control channel, and continuity
// ==================================================================

test('an interceptor proves the active tool set instead of a host and a prefix', { skip: noCerts }, async (t) => {
  const gateway = await fakeGateway();
  t.after(gateway.close);
  const port = await freePort();
  const it = await startInterceptor({ port, gatewayPort: gateway.port, activeTools: 'claude,codex' });
  t.after(it.stop);

  const probe = await s.probeBlindfold(port);
  assert.equal(probe.state, 'ours');
  assert.equal(probe.activeTools, 'claude,codex', 'the proof carries the tool set');
  assert.equal(probe.host, undefined, 'R3 removed the host from the answer');
  assert.equal(probe.prefix, undefined, 'R3 removed the prefix from the answer');
});

test('A4b: a Host that is not the CONNECT host gets 421, with no upstream connection', { skip: noCerts }, async (t) => {
  const gateway = await fakeGateway();
  t.after(gateway.close);
  const port = await freePort();
  const it = await startInterceptor({ port, gatewayPort: gateway.port });
  t.after(it.stop);

  // Plain request inside the tunnel.
  const secure = await openTls(port, 'api.anthropic.com');
  const res = await post(secure, { url: '/v1/messages', host: 'evil.com', body: '{"x":1}' });
  assert.equal(res.status, 421, res.head);
  assert.match(res.head, /Misdirected/i);

  // An upgrade answers on the raw socket, so it needs its own branch.
  const up = await openTls(port, 'api.anthropic.com');
  up.write('GET /backend-api/codex/x HTTP/1.1\r\nHost: chatgpt.com\r\nConnection: Upgrade\r\n'
    + 'Upgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  const upgrade = await readResponse(up);
  assert.equal(upgrade.status, 421, upgrade.head);

  assert.equal(gateway.seen.length, 0, 'neither request may reach an upstream');
  secure.destroy();
  up.destroy();
});

test('A9: only the active tool set is intercepted, and the port never moves', { skip: noCerts }, async (t) => {
  const gateway = await fakeGateway();
  t.after(gateway.close);
  const port = await freePort();
  // Spawns with both tools, while config.json already says Claude is off — so the first control
  // POST has something real to change.
  const it = await startInterceptor({
    port,
    gatewayPort: gateway.port,
    config: { activeProfile: 'p', activeProfiles: { claude: null } },
    activeTools: 'claude,codex'
  });
  t.after(it.stop);

  // Codex is live: its API path reaches the gateway with the path unchanged.
  const a = await openTls(port, 'api.openai.com');
  const routed = await post(a, { url: '/v1/responses?stream=true', host: 'api.openai.com', body: '{"model":"gpt-5"}' });
  assert.equal(routed.status, 200, routed.head);
  assert.equal(gateway.seen.at(-1).url, '/v1/responses?stream=true', 'the path is not rewritten for the API hosts');
  a.destroy();

  // Turn Claude off through the one channel that exists.
  const before = process.hrtime.bigint();
  const ack = await fetch(`http://127.0.0.1:${port}/_control/active-tools`, {
    method: 'POST',
    headers: { 'x-llm-switcher-token': TOKEN, 'content-type': 'application/json' },
    body: '{}'
  }).then((r) => r.json());
  const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;
  assert.deepEqual(ack, { ok: true, activeTools: ['codex'] });
  assert.ok(elapsedMs < 2000, `the update is in place, not a restart (took ${elapsedMs.toFixed(0)}ms)`);

  const after = await s.probeBlindfold(port);
  assert.equal(after.state, 'ours', 'the same process still answers');
  assert.equal(after.pid, it.child.pid, 'the port was never released');
  assert.equal(after.activeTools, 'codex');

  // /v1/messages on api.anthropic.com now leaves this switcher's path: the gateway must not see
  // it. The pass-through itself goes to the real host and may fail without network — the point
  // is that the switcher is no longer between the tool and its endpoint.
  const b = await openTls(port, 'api.anthropic.com');
  const countBefore = gateway.seen.filter((r) => r.url.startsWith('/v1/messages')).length;
  const pending = post(b, { url: '/v1/messages', host: 'api.anthropic.com', body: '{"x":1}' });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(gateway.seen.filter((r) => r.url.startsWith('/v1/messages')).length, countBefore,
    'an inactive tool must not be routed through the gateway');
  b.destroy();
  await pending;

  // Codex is still intercepted on the same port.
  const c = await openTls(port, 'api.openai.com');
  const still = await post(c, { url: '/v1/responses', host: 'api.openai.com', body: '{}' });
  assert.equal(still.status, 200, still.head);
  assert.equal(gateway.seen.at(-1).url, '/v1/responses');
  c.destroy();
});

test('POST /_control/active-tools re-derives the list from config.json', { skip: noCerts }, async (t) => {
  const gateway = await fakeGateway();
  t.after(gateway.close);
  const port = await freePort();
  const it = await startInterceptor({
    port,
    gatewayPort: gateway.port,
    config: { activeProfile: 'p', activeProfiles: { claude: null } },
    activeTools: 'claude,codex'
  });
  t.after(it.stop);

  const res = await fetch(`http://127.0.0.1:${port}/_control/active-tools`, {
    method: 'POST', headers: { 'x-llm-switcher-token': TOKEN }, body: '{}'
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).activeTools, ['codex'], 'the pointer chain, read from the file');
  assert.equal((await s.probeBlindfold(port)).activeTools, 'codex');
});

test('POST /_control/active-tools refuses a missing token and a config it cannot read', { skip: noCerts }, async (t) => {
  const gateway = await fakeGateway();
  t.after(gateway.close);
  const port = await freePort();
  const it = await startInterceptor({ port, gatewayPort: gateway.port, activeTools: 'claude,codex' });
  t.after(it.stop);
  const post_ = (headers) => fetch(`http://127.0.0.1:${port}/_control/active-tools`, { method: 'POST', headers, body: '{}' });

  // Loopback is not an identity: any process on this machine can reach the port.
  assert.equal((await post_({})).status, 403);
  assert.equal((await post_({ 'x-llm-switcher-token': 'not-the-token' })).status, 403);
  assert.equal((await s.probeBlindfold(port)).activeTools, 'claude,codex', 'a refused call changes nothing');

  // A config the interceptor cannot read must not empty the table: non-2xx, set unchanged.
  writeConfigFile(it.cfgFile, '{ this is not json');
  const broken = await post_({ 'x-llm-switcher-token': TOKEN });
  assert.ok(broken.status >= 500, `expected a non-2xx answer, got ${broken.status}`);
  const body = await broken.json();
  assert.equal(body.ok, false);
  assert.ok(!Array.isArray(body.activeTools), 'it must not claim a new list it could not derive');
  assert.equal((await s.probeBlindfold(port)).activeTools, 'claude,codex', 'the running set is kept');
});

test('R6: an in-flight request completes while the control endpoint updates the tool set', { skip: noCerts }, async (t) => {
  const gateway = await fakeGateway({ delayMs: 1500 });
  t.after(gateway.close);
  const port = await freePort();
  // The file says Claude is off, so the control endpoint has a real change to make mid-flight.
  const it = await startInterceptor({
    port,
    gatewayPort: gateway.port,
    config: { activeProfile: 'p', activeProfiles: { claude: null } },
    activeTools: 'claude,codex'
  });
  t.after(it.stop);

  const secure = await openTls(port, 'api.openai.com');
  const inFlight = post(secure, { url: '/v1/responses', host: 'api.openai.com', body: '{"stream":true}' });

  await new Promise((r) => setTimeout(r, 250));
  const ack = await fetch(`http://127.0.0.1:${port}/_control/active-tools`, {
    method: 'POST', headers: { 'x-llm-switcher-token': TOKEN }, body: '{}'
  }).then((r) => r.json());
  assert.deepEqual(ack, { ok: true, activeTools: ['codex'] }, 'the update lands while the request is open');

  const res = await inFlight;
  assert.equal(res.status, 200, `the open stream must not be reset: ${res.head}`);
  assert.equal(gateway.seen.length, 1, 'one request, relayed once');
  secure.destroy();
});

test('A12: a pass-through exchange writes method, path, status and headers — and no body', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'capture-'));
  const { EventEmitter } = await import('node:events');

  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/api/oauth/token';
  req.headers = { host: 'chatgpt.com', authorization: 'Bearer xyz', 'content-type': 'application/json' };

  const record = bf.recordExchange(req, { includeBody: false, captureDir: dir });
  assert.ok(record, 'a pass-through exchange is still worth recording');

  const up = new EventEmitter();
  up.statusCode = 200;
  up.headers = { 'content-type': 'text/plain', 'content-length': '2' };
  record(up);

  // The bodies arrive and are simply never collected.
  req.emit('data', Buffer.from('{"refresh_token":"rt-secret"}'));
  up.emit('data', Buffer.from('ok'));
  up.emit('end');

  const deadline = Date.now() + 3000;
  while (fs.readdirSync(dir).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, 'one capture file');
  const written = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));

  assert.equal(written.method, 'POST');
  assert.equal(written.url, '/api/oauth/token');
  assert.equal(written.status, 200);
  assert.equal(written.responseHeaders['content-type'], 'text/plain');
  assert.ok(!('requestBody' in written), 'no request body may be stored');
  assert.ok(!('responseBody' in written), 'no response body may be stored');
  const dump = JSON.stringify(written);
  assert.ok(!dump.includes('rt-secret'), 'the refresh token must not reach the disk');
  assert.ok(!dump.includes('Bearer xyz'), 'the credential must not reach the disk');
});

// ==================================================================
// R3b — reconcile: keep, replace a legacy build, confirm the ACK
// ==================================================================

const baseCfg = (port) => ({
  blindfold: { port },
  activeProfiles: { anthropic: 'a', codex: 'b' },
  profiles: {
    a: { tool: 'claude', baseURL: 'http://example.test', apiKey: 'k' },
    b: { tool: 'codex', baseURL: 'http://example.test', apiKey: 'k' }
  }
});

test('R3b: a second reconcile over an unchanged config keeps the running interceptor', { skip: noCerts }, async (t) => {
  const gateway = await fakeGateway();
  t.after(gateway.close);
  const port = await freePort();
  const gatewayPort = await freePort();
  const first = await s.reconcileBlindfold(baseCfg(port), gatewayPort);
  t.after(async () => { await s.stopRecordedBlindfold(); });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.action, 'started');

  const running = await s.probeBlindfold(port);
  assert.equal(running.state, 'ours');
  assert.equal(running.activeTools, 'claude,codex');

  const second = await s.reconcileBlindfold(baseCfg(port), gatewayPort);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.action, 'kept', 'nothing changed, so nothing is restarted');
  assert.equal((await s.probeBlindfold(port)).pid, running.pid, 'the same process is still serving');
});

test('R3b: an interceptor from 1.1.11 proves the old way and is replaced, not treated as foreign', { skip: noCerts }, async (t) => {
  const gateway = await fakeGateway();
  t.after(gateway.close);
  const gatewayPort = await freePort();
  const port = await freePort();

  // Exactly the 1.1.11 answer: HMAC over role, port, pid, gateway port, HOST and PREFIX. It runs
  // in its own process, because reconcile is about to kill whatever answers that proof.
  const legacySrc = `
    const s = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'state.mjs')).href)});
    const http = await import('node:http');
    const fs = await import('node:fs');
    const port = ${port};
    const gatewayPort = ${gatewayPort};
    http.createServer((req, res) => {
      const nonce = new URL(req.url, 'http://x').searchParams.get('challenge');
      const f = { role: 'blindfold', port, pid: process.pid, gatewayPort, host: 'chatgpt.com', prefix: '/backend-api/codex' };
      const token = fs.readFileSync(${JSON.stringify(s.adminTokenPath)}, 'utf8').trim();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        proxy: 'llm-switcher-blindfold', port, pid: process.pid, gatewayPort,
        host: f.host, prefix: f.prefix, proof: s.legacyIdentityProof(nonce, f, token)
      }));
    }).listen(port, '127.0.0.1');
  `;
  const legacy = spawn(process.execPath, ['--input-type=module', '-e', legacySrc], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (legacy.exitCode !== null) return;
    legacy.kill();
    await once(legacy, 'exit').catch(() => {});
  });

  const deadline = Date.now() + 8000;
  let before = { state: 'free' };
  while (Date.now() < deadline && before.state !== 'legacy-ours') {
    before = await s.probeBlindfold(port);
    if (before.state !== 'legacy-ours') await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(before.state, 'legacy-ours', 'the old proof still verifies: it is ours to stop');
  assert.equal(before.host, 'chatgpt.com');

  fs.writeFileSync(s.blindfoldStatePath, JSON.stringify({ pid: legacy.pid, port, gatewayPort }));
  t.after(async () => { await s.stopRecordedBlindfold(); });

  const r = await s.reconcileBlindfold(baseCfg(port), gatewayPort);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.action, 'started', 'the legacy build is replaced by the multi-host one');
  const now = await s.probeBlindfold(port);
  assert.equal(now.state, 'ours', 'the new answer is the new proof');
  assert.equal(now.activeTools, 'claude,codex');
  assert.ok(now.pid !== legacy.pid, 'the fake that held the port is gone');
});

test('A9: reconcile confirms the list the interceptor reports, not the snapshot it was called with', { skip: noCerts }, async (t) => {
  const gateway = await fakeGateway();
  t.after(gateway.close);
  const port = await freePort();
  // The gateway port has to be the one the interceptor was spawned with: reconcile compares the
  // probe against it, and a mismatch means "a different gateway owns this port".
  const it = await startInterceptor({ port, gatewayPort: gateway.port, activeTools: 'claude,codex' });
  t.after(it.stop);

  // The snapshot this call was built from says "codex only"...
  const snapshot = { ...baseCfg(port), activeProfiles: { anthropic: null, codex: 'b' } };
  // ...while the file on disk — which the interceptor re-reads — still has both. The running
  // process is right and the stale snapshot is wrong; reconcile must agree with the ACK.
  writeConfigFile(it.cfgFile, baseCfg(port));
  fs.writeFileSync(path.join(TMP, 'blindfold.json'), JSON.stringify({ pid: it.child.pid, port, gatewayPort: gateway.port }));

  const r = await s.reconcileBlindfold(snapshot, gateway.port);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.action, 'updated', 'the port stayed open and only the tool set moved');
  assert.equal((await s.probeBlindfold(port)).pid, it.child.pid, 'the same process answered the POST');
  assert.equal((await s.probeBlindfold(port)).activeTools, 'claude,codex', 'confirmed against the acknowledgement');
});
