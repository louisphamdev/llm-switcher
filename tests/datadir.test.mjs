import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveDataDir } from '../state.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-sw-datadir-'));

test('a git checkout keeps its data next to the code', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.git'));
  assert.equal(resolveDataDir(root, {}, '/home/u'), root);
});

test('an npm install keeps its data in the home directory, so an upgrade cannot erase it', () => {
  const root = tmp();
  assert.equal(resolveDataDir(root, {}, '/home/u'), path.join('/home/u', '.llm-switcher'));
});

test('LLM_SWITCHER_HOME overrides both', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.git'));
  assert.equal(resolveDataDir(root, { LLM_SWITCHER_HOME: '/data/sw' }, '/home/u'), path.resolve('/data/sw'));
});

test('the switch command file starts with a node shebang, as npm bin requires', () => {
  const first = fs.readFileSync(new URL('../switch.mjs', import.meta.url), 'utf8').split('\n')[0];
  assert.equal(first, '#!/usr/bin/env node');
});

test('package.json is publishable and exposes the switch command', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.bin?.switch, 'switch.mjs');
  assert.ok(fs.existsSync(new URL('../LICENSE', import.meta.url)), 'LICENSE file exists');
});

// macOS ships LibreSSL as /usr/bin/openssl. It has no `x509 -ext`; the script must not depend on it.
test('make-certs.sh runs with an openssl that lacks LibreSSL-missing options', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  const real = execFileSync('sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).trim();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'openssl'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = "-ext" ] && { echo "unknown option -ext" >&2; exit 1; }; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const out = path.join(dir, 'certs');
  const script = new URL('../blindfold/make-certs.sh', import.meta.url).pathname;
  execFileSync('bash', [script, 'chatgpt.com', out], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'pipe' });
  for (const f of ['ca.pem', 'leaf.pem', 'leaf.key']) assert.ok(fs.existsSync(path.join(out, f)), f);
});

// LS-4: files copied over an old checkout (a ZIP) must not borrow the time of the old commit.
test('the version stamp uses the commit time only when the working tree is clean', async () => {
  const { versionStamp } = await import('../contract.mjs');
  const dir = tmp();
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"1.2.3"}');
  fs.writeFileSync(path.join(dir, 'a.mjs'), 'export {};\n');
  git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'old');
  const commitMs = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(versionStamp(dir), commitMs, 'clean tree: commit time');
  fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const changed = 1;\n');
  assert.ok(versionStamp(dir) > commitMs + 60_000, 'dirty tree: the time of the newest file, not of the old commit');
});
