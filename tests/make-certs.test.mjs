import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAS_OPENSSL = process.platform !== 'win32' && fs.existsSync('/usr/bin/openssl');

// LibreSSL names the -CAcreateserial file after the CA path cut at its first dot, so a
// directory such as /Users/first.last sent the serial file to /Users/first.srl.
test('make-certs.sh builds the certificates under a path that contains a dot', { skip: !HAS_OPENSSL && 'posix + openssl' }, (t) => {
  // The first dot of the whole path is in `first.last`, so a stray serial file lands in `dir` as first.srl.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmswcerts'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'first.last', 'certs');
  execFileSync('bash', [path.join(ROOT, 'blindfold', 'make-certs.sh'), out], { stdio: 'pipe' });
  for (const f of ['ca.pem', 'ca.key', 'leaf.pem', 'leaf.key']) assert.ok(fs.existsSync(path.join(out, f)), `${f} is missing`);
  assert.deepEqual(fs.readdirSync(dir), ['first.last'], 'no serial file outside the output directory');
});

// A Windows path has no forward slash. The script took `C:\...\certs` for the host of the old
// two-argument form, ignored it, and rebuilt the default certificates of the checkout instead.
test('make-certs.sh writes to a Windows path given as its only argument', { skip: process.platform !== 'win32' && 'a Windows path' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmswcerts-win-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'certs');
  // Where the script falls back to: a decoy, so a failing run never touches the real certificates.
  const decoy = path.join(dir, 'decoy');
  execFileSync('bash', [path.join(ROOT, 'blindfold', 'make-certs.sh'), out], { stdio: 'pipe', env: { ...process.env, LLM_SWITCHER_BLINDFOLD_CERTS: decoy } });
  assert.match(out, /^[A-Za-z]:\\/, 'the argument is a native Windows path');
  for (const f of ['ca.pem', 'ca.key', 'leaf.pem', 'leaf.key']) assert.ok(fs.existsSync(path.join(out, f)), `${f} is missing in ${out}`);
  assert.equal(fs.existsSync(decoy), false, 'nothing is written to the default directory');
});
