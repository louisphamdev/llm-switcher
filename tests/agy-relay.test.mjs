// Tests for agy-relay.mjs: agy's Google token reaches a gateway only on a connection where that
// gateway proved itself with the key of gateway.secret, also when the gateway stops in the middle
// of an agy session.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELAY = path.join(ROOT, 'agy-relay.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agyrelay-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// The directory of a relay run: admin.token, and gateway.secret unless `secret` is false.
const TOKEN = 'b'.repeat(64);
function stateDir(name, { secret = true } = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'admin.token'), TOKEN);
  if (secret) fs.writeFileSync(path.join(dir, 'gateway.secret'), crypto.randomBytes(32).toString('hex'));
  return dir;
}
const MAIN = stateDir('main');
const { identityProof } = await import(pathToFileURL(path.join(ROOT, 'state.mjs')).href);

// Stands in for agy: FAKE_CALLS requests with its Google token, then one more once `signal` exists.
const FAKE_AGY = path.join(TMP, 'fake-agy.mjs');
fs.writeFileSync(FAKE_AGY, `
import fs from 'node:fs';
import http from 'node:http';
const [, , code, signal] = process.argv;
const call = () => new Promise((resolve) => {
  const req = http.request(process.env.CLOUD_CODE_URL + '/v1internal:loadCodeAssist', {
    method: 'POST', agent: false, headers: { authorization: 'Bearer google-secret', 'content-type': 'application/json' }
  }, (res) => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { console.log('STATUS ' + res.statusCode + ' ' + b); resolve(); }); res.on('error', () => resolve()); });
  req.on('error', (e) => { console.log('ERROR ' + e.message); resolve(); });
  req.end('{}');
});
console.log('CCU ' + (process.env.CLOUD_CODE_URL || ''));
if (process.env.CLOUD_CODE_URL) for (let i = 0; i < Number(process.env.FAKE_CALLS || 1); i++) await call();
if (signal) { while (!fs.existsSync(signal)) await new Promise(r => setTimeout(r, 50)); await call(); }
process.exit(Number(code) || 0);
`);

const relayHmac = (key, port, pid, nonce) => crypto.createHmac('sha256', key).update(['relay', port, pid, nonce].join('|')).digest('hex');

// The answer of a gateway fixture to the identity probe. 'real' signs with the raw bytes of the
// gateway.secret file; every other kind is one way to be wrong.
function probeAnswer(kind, challenge, port, dir) {
  const pid = 4242;
  const secretFile = path.join(dir, 'gateway.secret');
  const secret = fs.existsSync(secretFile) ? fs.readFileSync(secretFile) : Buffer.from('no-secret');
  let status = 200;
  let body = { status: 'ok', proxy: 'llm-switcher', port, pid, proof: identityProof(challenge, { role: 'gateway', port, pid }, TOKEN) };
  if (kind === 'real' || kind === 'extra') body.relayProof = relayHmac(secret, port, pid, challenge);
  if (kind === 'squatter') body.relayProof = relayHmac(TOKEN, port, pid, challenge);
  if (kind === 'replay') Object.assign(body, { relayProof: relayHmac(secret, port, pid, 'stale-nonce'), nonce: 'stale-nonce', challenge: 'stale-nonce' });
  if (kind === 'status500') { status = 500; body.relayProof = relayHmac(secret, port, pid, challenge); }
  if (kind === 'oversize') Object.assign(body, { relayProof: relayHmac(secret, port, pid, challenge), pad: 'x'.repeat(70 * 1024) });
  if (kind === 'empty') body.relayProof = '';
  if (kind === 'null') body = null;
  if (kind === 'number') body = 7;
  if (kind === 'array') body = [];
  const text = JSON.stringify(body);
  let out = `HTTP/1.1 ${status} X\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: keep-alive\r\n\r\n${text}`;
  if (kind === 'extra') out += 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 13\r\n\r\nINJECTED-BODY';
  return out;
}

// A raw gateway fixture on `port`. `kinds` is one kind, or one kind per connection in order (the
// last repeats). It records every challenge and every byte that arrives after its probe answer.
function gateway(kinds, { port = 0, dir = MAIN } = {}) {
  const list = [].concat(kinds);
  const seen = { challenges: [], bytes: '' };
  let conn = 0;
  const server = net.createServer((sock) => {
    const kind = list[Math.min(conn++, list.length - 1)];
    sock.on('error', () => {});
    let buf = '';
    let probed = false;
    sock.on('data', (d) => {
      if (kind === 'silent') { seen.bytes += d; return; }
      if (probed) {
        seen.bytes += d;
        buf += d;
        // 'real' answers each forwarded request once its 2-byte body is in.
        const end = buf.indexOf('\r\n\r\n');
        if (kind === 'real' && end >= 0 && buf.length >= end + 6) {
          buf = '';
          const answer = '{"answeredBy":"real"}';
          sock.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${answer.length}\r\nConnection: keep-alive\r\n\r\n${answer}`);
        }
        return;
      }
      buf += d;
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.slice(0, end);
      const rest = buf.slice(end + 4);
      buf = '';
      probed = true;
      seen.challenges.push((head.match(/challenge=([0-9a-f]+)/) || [])[1] || '');
      sock.write(probeAnswer(kind, seen.challenges.at(-1), server.address().port, dir));
      if (rest) seen.bytes += rest;
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

function runRelay(gatewayUrl, args = [], { env = {}, dir = MAIN } = {}) {
  const child = spawn(process.execPath, [RELAY, gatewayUrl, process.execPath, FAKE_AGY, ...args], {
    env: { ...process.env, LLM_SWITCHER_CONFIG: path.join(dir, 'config.json'), CLOUD_CODE_URL: gatewayUrl, ...env }
  });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
  return { child, done, out: () => out };
}

const statuses = (out) => out.split('\n').filter(l => l.startsWith('STATUS')).map(l => Number(l.split(' ')[1]));
const ccuPort = (out) => Number((out.match(/CCU http:\/\/127\.0\.0\.1:(\d+)/) || [])[1]);

test('agy talks to its own relay port, and the relay forwards to a gateway that proved itself with gateway.secret', async (t) => {
  const g = await gateway('real');
  t.after(() => g.server.close());
  const { code, out } = await runRelay(`http://127.0.0.1:${g.port}`).done;
  assert.equal(code, 0);
  assert.ok(ccuPort(out) > 0 && ccuPort(out) !== g.port, `agy gets the relay port, not the gateway port: ${out}`);
  assert.match(out, /STATUS 200 .*"answeredBy":"real"/);
  assert.match(g.seen.bytes, /Bearer google-secret/);
});

// Every way a listener on the gateway port can be wrong: agy gets a 502, and its token never leaves.
for (const kind of ['squatter', 'replay', 'extra', 'status500', 'oversize', 'old']) {
  test(`a gateway that answers the probe as '${kind}' gets a 502 and never receives the token`, async (t) => {
    const g = await gateway(kind);
    t.after(() => g.server.close());
    const { code, out } = await runRelay(`http://127.0.0.1:${g.port}`).done;
    assert.equal(code, 0);
    assert.deepEqual(statuses(out), [502], out);
    assert.doesNotMatch(g.seen.bytes, /google-secret/);
    assert.doesNotMatch(out, /INJECTED-BODY/, 'bytes after the probe answer never reach agy');
    if (kind === 'old') assert.match(out, /switch off.*switch on/, 'an old gateway gets the restart hint');
  });
}

test('a silent listener only ever sees the probe, never the token', async (t) => {
  const g = await gateway('silent');
  t.after(() => g.server.close());
  const { out } = await runRelay(`http://127.0.0.1:${g.port}`).done;
  assert.deepEqual(statuses(out), [502]);
  assert.match(g.seen.bytes, /^GET \/health\?challenge=/);
  assert.doesNotMatch(g.seen.bytes, /google-secret/);
});

test('one relay sends a fresh challenge on every connection', async (t) => {
  const g = await gateway('replay');
  t.after(() => g.server.close());
  await runRelay(`http://127.0.0.1:${g.port}`, [], { env: { FAKE_CALLS: '2' } }).done;
  assert.equal(g.seen.challenges.length, 2);
  assert.notEqual(g.seen.challenges[0], g.seen.challenges[1]);
  assert.match(g.seen.challenges[0], /^[0-9a-f]{32}$/);
});

test('without gateway.secret the relay trusts no proof, not even one keyed by admin.token', async (t) => {
  const dir = stateDir('nosecret', { secret: false });
  for (const kind of ['empty', 'squatter']) {
    const g = await gateway(kind, { dir });
    t.after(() => g.server.close());
    const { out } = await runRelay(`http://127.0.0.1:${g.port}`, [], { dir }).done;
    assert.deepEqual(statuses(out), [502], `${kind}: ${out}`);
    assert.doesNotMatch(g.seen.bytes, /google-secret/, kind);
  }
});

test('an answer that is not an object gets a 502, and the relay keeps serving agy', async (t) => {
  const g = await gateway(['null', 'number', 'array', 'real']);
  t.after(() => g.server.close());
  const { code, out } = await runRelay(`http://127.0.0.1:${g.port}`, [], { env: { FAKE_CALLS: '4' } }).done;
  assert.equal(code, 0);
  assert.deepEqual(statuses(out), [502, 502, 502, 200], out);
});

test('a gateway replaced in the middle of an agy session never receives the token', async (t) => {
  const real = await gateway('real');
  const port = real.port;
  const signal = path.join(TMP, 'go-swap');
  const run = runRelay(`http://127.0.0.1:${port}`, ['0', signal]);
  for (let i = 0; i < 200 && !/STATUS/.test(run.out()); i++) await new Promise(r => setTimeout(r, 50));
  assert.match(run.out(), /STATUS 200 /, 'the first request went through the real gateway');
  // The gateway stops, and a process that holds admin.token takes its port.
  await new Promise(r => real.server.close(r));
  const squatter = await gateway('squatter', { port });
  t.after(() => squatter.server.close());
  fs.writeFileSync(signal, '');
  const { out } = await run.done;
  assert.deepEqual(statuses(out), [200, 502]);
  assert.doesNotMatch(squatter.seen.bytes, /google-secret/);
});

test('the relay works against the real proxy.mjs and the proof it computes', async (t) => {
  const dir = stateDir('realproxy', { secret: false });
  fs.rmSync(path.join(dir, 'admin.token'));
  const mock = http.createServer((req, res) => { req.resume(); res.end('{"answeredBy":"code-assist-mock"}'); });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  t.after(() => mock.close());
  const port = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, activeProfiles: { claude: null, codex: null, agy: null }, profiles: {} }));
  const proxy = spawn(process.execPath, [path.join(ROOT, 'proxy.mjs'), '--port', String(port)], {
    env: { ...process.env, LLM_SWITCHER_CONFIG: path.join(dir, 'config.json'), LLM_SWITCHER_STATE_DIR: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), LLM_SWITCHER_PORT: '', LLM_SWITCHER_CODE_ASSIST_URL: `http://127.0.0.1:${mock.address().port}` },
    stdio: 'ignore'
  });
  t.after(() => proxy.kill());
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(fs.existsSync(path.join(dir, 'gateway.secret')), 'the gateway made its secret at startup');
  const { out } = await runRelay(`http://127.0.0.1:${port}`, [], { dir }).done;
  assert.match(out, /STATUS 200 .*code-assist-mock/, out);
});

test('the relay exits with the exit code of agy', async (t) => {
  const g = await gateway('real');
  t.after(() => g.server.close());
  const { code } = await runRelay(`http://127.0.0.1:${g.port}`, ['7']).done;
  assert.equal(code, 7);
});

test('a gateway address that is not 127.0.0.1 with a port leaves agy on its official endpoint', async () => {
  for (const bad of ['http://localhost:3456', 'http://127.0.0.1', 'https://127.0.0.1:3456', 'not a url']) {
    const { code, out, err } = await runRelay(bad).done;
    assert.equal(code, 0, bad);
    assert.match(out, /^CCU $/m, `${bad}: agy gets no CLOUD_CODE_URL`);
    assert.match(err, /official endpoint/, bad);
  }
});

// An argv string cannot hold NUL on any platform: Node refuses it before a process exists, so it
// can reach neither the relay nor agy. The relay's own NUL guard only backs this up.
test('an argument with a NUL character cannot start a process at all', () => {
  assert.throws(() => spawn(process.execPath, [RELAY, 'http://127.0.0.1:9', process.execPath, FAKE_AGY, 'a\0b']), { code: 'ERR_INVALID_ARG_VALUE' });
});

// ---- A .cmd agy on Windows: every argument arrives byte-identical through cmd.exe ----------------

const WIN = process.platform === 'win32';
function cmdFixture(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'argv.js'), `require('fs').writeFileSync(require('path').join(process.cwd(), 'argv.json'), JSON.stringify(process.argv.slice(2)));\n`);
  fs.writeFileSync(path.join(dir, 'agy.cmd'), '@node "%~dp0argv.js" %*\r\n');
  return dir;
}
function runCmdRelay(dir, args) {
  const child = spawn(process.execPath, [RELAY, 'http://127.0.0.1', path.join(dir, 'agy.cmd'), ...args], {
    cwd: dir, env: { ...process.env, LLM_SWITCHER_CONFIG: path.join(MAIN, 'config.json') }
  });
  let err = '';
  child.stderr.on('data', d => { err += d; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, err })));
}

test('a .cmd agy receives every argument byte-identical, and cmd.exe runs nothing else', { skip: !WIN && 'cmd.exe only' }, async () => {
  const dir = cmdFixture('cmdargs');
  const args = ['%PATH%', '%PATH:a=%', '%CMDCMDLINE:~-1%&echo PWNED>marker', 'C:\\temp\\', 'a"b', 'a\\"b', 'say "hi there"',
    '50% off', 'x&y', 'a|b', 'a^b', '<x>', '(x)', '!PATH!', 'héllo wörld', ''];
  const { code, err } = await runCmdRelay(dir, args);
  assert.equal(code, 0, err);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8')), args);
  assert.equal(fs.existsSync(path.join(dir, 'marker')), false, 'no second command ran');
});

test('a .cmd agy in a directory with % in its name still starts', { skip: !WIN && 'cmd.exe only' }, async () => {
  const dir = cmdFixture('50%off');
  const { code, err } = await runCmdRelay(dir, ['ok']);
  assert.equal(code, 0, err);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8')), ['ok']);
});

test('a .cmd agy gets no line break and no command line over the cmd.exe limit', { skip: !WIN && 'cmd.exe only' }, async () => {
  for (const [name, args, hint] of [['crlf-n', ['a\nb'], /line break/], ['crlf-r', ['a\rb'], /line break/], ['toolong', ['x'.repeat(8200)], /8191/]]) {
    const dir = cmdFixture(name);
    const { code, err } = await runCmdRelay(dir, args);
    assert.notEqual(code, 0, name);
    assert.match(err, hint, name);
    assert.match(err, /stdin/, name);
    assert.equal(fs.existsSync(path.join(dir, 'argv.json')), false, `${name}: the fixture never ran`);
  }
  const dir = cmdFixture('long-ok');
  const long = 'y'.repeat(4000);
  const { code, err } = await runCmdRelay(dir, [long]);
  assert.equal(code, 0, err);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8')), [long]);
});

test('an .exe agy gets a line break in an argument unchanged', async (t) => {
  const dir = path.join(TMP, 'exe-newline');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'argv.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));\n`);
  const child = spawn(process.execPath, [RELAY, 'http://127.0.0.1', process.execPath, script, 'a\nb'], { env: { ...process.env, LLM_SWITCHER_CONFIG: path.join(MAIN, 'config.json') } });
  const code = await new Promise(r => child.on('close', r));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8')), ['a\nb']);
});
