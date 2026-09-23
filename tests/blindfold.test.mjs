// Tests for blindfold/blindfold.mjs — the routing decision of a TLS-intercepting proxy.
//
// Real-world failure (2026-09-20, adversarial review): the first version decided with a
// bare `startsWith(API_PREFIX)` on the raw request target. Node does not normalize a
// request target, but the gateway does (`new URL(...).pathname`). So
// `/backend-api/codex/%2e%2e/api/logs` passed the prefix test, was forwarded as
// `/v1/%2e%2e/api/logs`, and the gateway resolved it to `/api/logs`. The forwarded
// headers also forge a loopback Host, which satisfies the admin API's only guard.
// One request through the proxy could read the provider API key.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  isGatewayPath, toGatewayPath, isInterceptedHost, isPrivateDestination,
  API_PREFIX, GATEWAY_PREFIX, redactHeaders, captureName, decodeBody, writeCaptureFile
} from '../blindfold/blindfold.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a dot-segment escape never reaches the gateway', () => {
  for (const attack of [
    '/backend-api/codex/%2e%2e/api/logs',
    '/backend-api/codex/../api/logs',
    '/backend-api/codex/%2E%2E/%2e%2e/api/fetch-models',
    '/backend-api/codex/a/../../api/save-profile'
  ]) {
    assert.equal(isGatewayPath(attack), false, `must not route: ${attack}`);
  }
});

test('a path that only shares the prefix string is passed through', () => {
  assert.equal(isGatewayPath('/backend-api/codex-usage'), false);
  assert.equal(isGatewayPath('/backend-api/codexfoo'), false);
  assert.equal(isGatewayPath('/backend-api/codex_settings'), false);
});

test('a real Codex API path is routed, and its query string survives', () => {
  assert.equal(isGatewayPath('/backend-api/codex/responses'), true);
  assert.equal(isGatewayPath(API_PREFIX), true);
  assert.equal(toGatewayPath('/backend-api/codex/x?y=1&z=2'), `${GATEWAY_PREFIX}/x?y=1&z=2`);
  assert.equal(toGatewayPath('/backend-api/codex/responses'), `${GATEWAY_PREFIX}/responses`);
});

// A CONNECT to any other host must be tunneled, not intercepted: the process then
// only copies bytes and never holds that host's plaintext.
test('only the target host is intercepted; every other public host is tunneled', () => {
  assert.equal(isInterceptedHost('chatgpt.com'), true);
  for (const other of ['api.openai.com', 'auth.openai.com', 'example.com', 'chatgpt.com.evil.test']) {
    assert.equal(isInterceptedHost(other), false, `must not intercept ${other}`);
    assert.equal(isPrivateDestination(other), false, `must tunnel ${other}`);
  }
});

// The listener is a proxy on loopback, so every local process can ask it for a
// destination. A local destination would turn it into a way to reach a service that
// listens only on this machine.
test('a local or private destination is refused', () => {
  for (const local of [
    'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]',
    '10.0.0.5', '192.168.1.10', '172.16.0.1', '172.31.255.254', '169.254.169.254', ''
  ]) {
    assert.equal(isPrivateDestination(local), true, `must refuse ${local || '(empty)'}`);
  }
  // A public address that only looks similar stays allowed.
  for (const publicHost of ['172.32.0.1', '11.0.0.1', '193.168.1.10']) {
    assert.equal(isPrivateDestination(publicHost), false, `must not refuse ${publicHost}`);
  }
});

test('a malformed target is refused rather than guessed', () => {
  for (const bad of ['', null, undefined, 'http://evil.example/backend-api/codex/responses']) {
    assert.equal(isGatewayPath(bad), false, `must not route: ${String(bad)}`);
  }
});

// A capture records what a real client sends, so it must never record how that
// client authenticates. The header name stays so the request shape is still
// readable; only the value goes.
test('capture redaction removes credential values and keeps everything else', () => {
  const out = redactHeaders({
    'Authorization': 'Bearer secret-token',
    'COOKIE': 'session=abc',
    'X-Api-Key': 'sk-123',
    'proxy-authorization': 'Basic zzz',
    'Content-Type': 'application/json',
    'user-agent': 'codex_cli_rs/0.154.0'
  });
  assert.equal(out['Authorization'], '<redacted>');
  assert.equal(out['COOKIE'], '<redacted>', 'matching must be case-insensitive');
  assert.equal(out['X-Api-Key'], '<redacted>');
  assert.equal(out['proxy-authorization'], '<redacted>');
  assert.equal(out['Content-Type'], 'application/json');
  assert.equal(out['user-agent'], 'codex_cli_rs/0.154.0');
  assert.ok(Object.keys(out).includes('Authorization'), 'the header name must survive');
});

// Real-world failure (2026-09-20): a capture of Claude Code recorded 647 bytes of
// gzip for a response that carried a full SSE stream. The client sends
// "accept-encoding: gzip", so reading the wire bytes as UTF-8 stores noise. The
// capture looked like an empty response and the defect was invisible until the
// file was parsed.
test('a compressed response body is decoded for the capture', () => {
  const sse = 'event: message_start\ndata: {"type":"message_start"}\n\n';
  assert.equal(decodeBody(zlib.gzipSync(Buffer.from(sse)), 'gzip'), sse);
  assert.equal(decodeBody(zlib.gzipSync(Buffer.from(sse)), 'GZIP'), sse, 'must be case-insensitive');
  assert.equal(decodeBody(zlib.brotliCompressSync(Buffer.from(sse)), 'br'), sse);
  assert.equal(decodeBody(zlib.deflateSync(Buffer.from(sse)), 'deflate'), sse);
  assert.equal(decodeBody(zlib.zstdCompressSync(Buffer.from(sse)), 'zstd'), sse);
});

test('an unencoded body is passed through untouched', () => {
  const plain = '{"ok":true}';
  assert.equal(decodeBody(Buffer.from(plain), undefined), plain);
  assert.equal(decodeBody(Buffer.from(plain), 'identity'), plain);
  assert.equal(decodeBody(Buffer.from(plain), ''), plain);
});

// A truncated stream is normal: the client can abort mid-answer. The capture must
// still be written, and it must not store bytes that read like a provider reply.
test('a body that cannot be decoded reports the reason instead of storing noise', () => {
  const broken = zlib.gzipSync(Buffer.from('hello')).subarray(0, 8);
  const out = decodeBody(broken, 'gzip');
  assert.match(out, /^\[capture: cannot decode gzip body of 8 bytes: /);
});

test('capture filenames carry no path separator', () => {
  const n = captureName('post', '/backend-api/codex/responses?stream=true', 1700000000000);
  assert.ok(!/[\\/]/.test(n), `unsafe filename: ${n}`);
  assert.match(n, /^1700000000000-POST-/);
  assert.ok(!n.includes('?'), 'the query string must not reach the filename');
  assert.match(captureName('GET', '/'), /-root\.json$/);
});

// A capture holds full prompts and answers. It must stay private to the owner, and it must
// never be written into a directory that another account created first.
test('captures are written 0600 inside a 0700 directory, never into a foreign directory', { skip: process.platform === 'win32' && 'posix modes' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-cap-'));
  try {
    const dir = path.join(base, 'captures');
    assert.equal(writeCaptureFile(dir, 'a.json', { ok: true }), true);
    assert.equal((fs.statSync(dir).mode & 0o777).toString(8), '700');
    assert.equal((fs.statSync(path.join(dir, 'a.json')).mode & 0o777).toString(8), '600');

    const foreign = path.join(base, 'foreign');
    fs.mkdirSync(foreign, { mode: 0o777 });
    const otherUid = (process.getuid?.() ?? 0) + 4242;
    assert.equal(writeCaptureFile(foreign, 'b.json', { ok: true }, { uid: otherUid }), false);
    assert.deepEqual(fs.readdirSync(foreign), [], 'nothing is written into a directory owned by another uid');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// make-certs.sh writes the CA key. With a directory in /tmp (the documented recipe) another
// account can create it first or plant symlinks, so the script must refuse a directory it
// does not own and must write every file private.
test('make-certs.sh writes private files and refuses a directory it does not own', { skip: (process.platform === 'win32' || !fs.existsSync('/usr/bin/openssl')) && 'posix + openssl' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-certs-'));
  const script = path.join(ROOT, 'blindfold', 'make-certs.sh');
  try {
    const out = path.join(base, 'certs');
    execFileSync('bash', [script, 'example.test', out], { stdio: 'ignore' });
    assert.equal((fs.statSync(out).mode & 0o777).toString(8), '700');
    for (const f of ['ca.key', 'leaf.key', 'ca.pem', 'leaf.pem']) {
      assert.equal((fs.statSync(path.join(out, f)).mode & 0o777).toString(8), '600', f);
    }
    // /usr/share/doc exists and belongs to root: the script must stop before writing.
    const rootOwned = '/usr/share/doc';
    let failed = false;
    try { execFileSync('bash', [script, 'example.test', rootOwned], { stdio: 'ignore' }); } catch { failed = true; }
    assert.ok(failed, 'a directory owned by another account is refused with a non-zero exit');
    assert.ok(!fs.existsSync(path.join(rootOwned, 'ca.key')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
