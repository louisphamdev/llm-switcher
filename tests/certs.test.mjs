import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { buildCerts, signLeaf } from '../blindfold/certs.mjs';
import { blindfoldPreflight, ensureBlindfoldCerts, INTERCEPT_HOSTS } from '../state.mjs';

const HAS_OPENSSL = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-certs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'certs');
}

const desiredFor = (dir) => ({ ca: path.join(dir, 'ca.pem') });

test('buildCerts writes a CA and a leaf that the preflight accepts, private to the owner', (t) => {
  const dir = tmp(t);
  buildCerts(dir, INTERCEPT_HOSTS);
  for (const f of ['ca.pem', 'ca.key', 'leaf.pem', 'leaf.key']) {
    assert.ok(fs.existsSync(path.join(dir, f)), f);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
  }
  if (process.platform !== 'win32') assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(blindfoldPreflight(desiredFor(dir)), null);
  const ca = new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'ca.pem')));
  assert.equal(ca.ca, true);
  const leaf = new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'leaf.pem')));
  assert.equal(leaf.ca, false);
  for (const h of INTERCEPT_HOSTS) assert.equal(leaf.checkHost(h), h);
});

test('a TLS client that trusts only the CA completes a handshake for every host', async (t) => {
  const dir = tmp(t);
  buildCerts(dir, INTERCEPT_HOSTS);
  const server = tls.createServer({ key: fs.readFileSync(path.join(dir, 'leaf.key')), cert: fs.readFileSync(path.join(dir, 'leaf.pem')) }, s => s.end('ok'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  for (const host of INTERCEPT_HOSTS) {
    const got = await new Promise((resolve, reject) => {
      const s = tls.connect({ port: server.address().port, host: '127.0.0.1', servername: host, ca: fs.readFileSync(path.join(dir, 'ca.pem')) }, () => {
        s.once('data', d => { resolve(String(d)); s.end(); });
      });
      s.on('error', reject);
    });
    assert.equal(got, 'ok', host);
  }
});

test('openssl verifies the leaf, and the name constraints refuse a leaf for another host', { skip: !HAS_OPENSSL && 'openssl' }, (t) => {
  const dir = tmp(t);
  buildCerts(dir, INTERCEPT_HOSTS);
  const out = execFileSync('openssl', ['verify', '-CAfile', path.join(dir, 'ca.pem'), path.join(dir, 'leaf.pem')], { encoding: 'utf8' });
  assert.match(out, /OK/);
  // A leaked ca.key signs for any name; a client that obeys the constraints must refuse it.
  const evil = path.join(dir, 'evil.pem');
  fs.writeFileSync(evil, signLeaf(dir, ['evil.example']).cert);
  assert.throws(() => execFileSync('openssl', ['verify', '-CAfile', path.join(dir, 'ca.pem'), evil], { stdio: 'pipe' }), /permitted subtree violation/);
});

test('ensureBlindfoldCerts builds a missing set, rebuilds a missing leaf on the same CA, and leaves a good set alone', (t) => {
  const dir = tmp(t);
  assert.match(blindfoldPreflight(desiredFor(dir)), /ca\.pem is missing/);
  assert.equal(ensureBlindfoldCerts(desiredFor(dir)), null);
  const ca = fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8');
  const leaf = fs.readFileSync(path.join(dir, 'leaf.pem'), 'utf8');

  assert.equal(ensureBlindfoldCerts(desiredFor(dir)), null);
  assert.equal(fs.readFileSync(path.join(dir, 'leaf.pem'), 'utf8'), leaf, 'a good set is not rebuilt');

  fs.rmSync(path.join(dir, 'leaf.pem'));
  assert.equal(ensureBlindfoldCerts(desiredFor(dir)), null);
  assert.equal(fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8'), ca, 'the CA Codex already trusts is kept');
  assert.notEqual(fs.readFileSync(path.join(dir, 'leaf.pem'), 'utf8'), leaf);

  // A leaf from an older version covers one host only.
  fs.writeFileSync(path.join(dir, 'leaf.pem'), signLeaf(dir, ['api.openai.com']).cert);
  assert.match(blindfoldPreflight(desiredFor(dir)), /does not cover/);
  assert.equal(ensureBlindfoldCerts(desiredFor(dir)), null);
  assert.equal(fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8'), ca);
});
