// Wire tests for blindfold.mjs: a real interceptor process, a real TLS session through CONNECT,
// and a fake gateway. They cover the capture path and the local-destination guard (audit F03,
// F15, F16).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFrameReader } from '../blindfold/wsframe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAS_OPENSSL = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const SKIP = (process.platform === 'win32' || !HAS_OPENSSL) && 'posix + openssl';

let dir, certDir, captureDir, gateway, gatewayPort;

function freePort() {
  return new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

function frame(opcode, text, { mask = false, length } = {}) {
  const data = Buffer.from(text);
  const len = length ?? data.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | len])
    : Buffer.concat([Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  if (!mask) return Buffer.concat([head, data]);
  const key = crypto.randomBytes(4);
  return Buffer.concat([head, key, Buffer.from(data.map((b, i) => b ^ key[i & 3]))]);
}

// Fake gateway: answers the WS upgrade, then greets with one text frame.
function startGateway() {
  gateway = net.createServer(socket => {
    let head = '';
    socket.on('data', chunk => {
      if (head.includes('\r\n\r\n')) return;
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n');
      socket.write(frame(1, 'hello from gateway'));
    });
    socket.on('error', () => {});
  });
  return new Promise(r => gateway.listen(0, '127.0.0.1', () => { gatewayPort = gateway.address().port; r(); }));
}

async function startInterceptor() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'blindfold', 'blindfold.mjs'),
    '--port', String(port), '--gateway-port', String(gatewayPort), '--certs', certDir,
    '--capture', captureDir, '--token-file', path.join(dir, 'admin.token')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise(r => child.on('exit', (code, signal) => r({ code, signal })));
  for (let i = 0; i < 50 && !out.includes('proxy on'); i++) await new Promise(r => setTimeout(r, 100));
  assert.match(out, /proxy on/, out);
  return { port, child, exited, output: () => out };
}

function connectVia(port, target) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let reply = '';
    const onData = d => {
      reply += d.toString('latin1');
      if (!reply.includes('\r\n\r\n')) return;
      s.off('data', onData);
      resolve({ socket: s, status: Number(reply.split(' ')[1]) });
    };
    s.on('data', onData);
    s.on('error', reject);
  });
}

// CONNECT, TLS with the private CA, then a WS upgrade on the Codex path.
async function openCodexWs(port) {
  const { socket } = await connectVia(port, 'chatgpt.com:443');
  const secure = tls.connect({ socket, servername: 'chatgpt.com', ca: fs.readFileSync(path.join(certDir, 'ca.pem')) });
  await new Promise((r, j) => { secure.once('secureConnect', r); secure.once('error', j); });
  secure.write(`GET /backend-api/codex/responses HTTP/1.1\r\nHost: chatgpt.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n\r\n`);
  const read = createFrameReader();
  const messages = [];
  let head = '';
  secure.on('data', d => {
    if (!head.includes('\r\n\r\n')) {
      head += d.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      d = Buffer.from(head.slice(end + 4), 'latin1');
    }
    for (const f of read(d)) messages.push(f.payload?.toString());
  });
  secure.on('error', () => {});
  for (let i = 0; i < 50 && !messages.length; i++) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(messages, ['hello from gateway']);
  return secure;
}

const captures = () => fs.readdirSync(captureDir).filter(f => f.endsWith('.json')).map(f => fs.readFileSync(path.join(captureDir, f), 'utf8'));

before(async () => {
  if (SKIP) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-wire-'));
  certDir = path.join(dir, 'certs');
  captureDir = path.join(dir, 'captures');
  execFileSync('bash', [path.join(ROOT, 'blindfold', 'make-certs.sh'), 'chatgpt.com', certDir], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'admin.token'), 'wire-test-token', { mode: 0o600 });
  await startGateway();
});

after(() => {
  gateway?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('a SIGTERM writes the WS capture that is still waiting for its quiet period', { skip: SKIP }, async () => {
  fs.rmSync(captureDir, { recursive: true, force: true });
  const bf = await startInterceptor();
  try {
    const ws = await openCodexWs(bf.port);
    ws.write(frame(1, 'hi from client', { mask: true }));
    await new Promise(r => setTimeout(r, 100));
    bf.child.kill('SIGTERM');
    await bf.exited;
    const all = captures().join('\n');
    assert.match(all, /hello from gateway/);
    assert.match(all, /hi from client/);
  } finally {
    bf.child.kill('SIGKILL');
  }
});

test('an undecodable WS frame in capture mode is recorded, and the interceptor keeps running', { skip: SKIP }, async () => {
  fs.rmSync(captureDir, { recursive: true, force: true });
  const bf = await startInterceptor();
  try {
    const ws = await openCodexWs(bf.port);
    ws.write(frame(1, '', { mask: true, length: 2 ** 60 }).subarray(0, 14));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(bf.child.exitCode, null, `interceptor exited:\n${bf.output()}`);
    const next = await openCodexWs(bf.port);
    next.destroy();
    ws.destroy();
    bf.child.kill('SIGTERM');
    await bf.exited;
    assert.match(captures().join('\n'), /"type": "error"/);
  } finally {
    bf.child.kill('SIGKILL');
  }
});

test('a CONNECT to a local address is refused whatever its spelling', { skip: SKIP }, async () => {
  const bf = await startInterceptor();
  try {
    for (const target of ['2130706433:22', '0x7f000001:22', '0:22', '[::ffff:127.0.0.1]:22', '[::]:22', '127.1:22']) {
      const { socket, status } = await connectVia(bf.port, target);
      socket.destroy();
      assert.equal(status, 403, target);
    }
    assert.match(bf.output(), /refused CONNECT/);
  } finally {
    bf.child.kill('SIGKILL');
  }
});
