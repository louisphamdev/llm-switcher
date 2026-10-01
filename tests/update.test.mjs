// The update itself: a git checkout pulls fast-forward only, an npm install asks the registry.
// Every remote here is a local bare repository or a local HTTP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyUpdate } from '../update.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

function writeVersion(dir, version) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'llm-switcher', version }) + '\n');
}

function commit(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, ...ID, 'commit', '-q', '-m', msg);
}

// upstream.git <- publisher (pushes releases), and install (the checkout being updated).
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-update-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const upstream = path.join(base, 'upstream.git');
  const publisher = path.join(base, 'publisher');
  const install = path.join(base, 'install');
  git(base, 'init', '-q', '--bare', '-b', 'main', upstream);
  for (const dir of [publisher, install]) {
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', upstream);
  }
  writeVersion(publisher, '1.0.0');
  commit(publisher, 'v1.0.0');
  git(publisher, 'push', '-q', '-u', 'origin', 'main');
  git(install, 'fetch', '-q', 'origin');
  git(install, 'checkout', '-q', '-b', 'main', '--track', 'origin/main');
  const release = (version) => {
    writeVersion(publisher, version);
    commit(publisher, `v${version}`);
    git(publisher, 'push', '-q', 'origin', 'main');
  };
  return { install, release, head: () => git(install, 'rev-parse', 'HEAD') };
}

test('a checkout behind its upstream pulls and reports the new version', async (t) => {
  const fx = fixture(t);
  fx.release('1.0.1');
  const r = await applyUpdate({ root: fx.install });
  assert.deepEqual({ updated: r.updated, from: r.from, to: r.to }, { updated: true, from: '1.0.0', to: '1.0.1' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(fx.install, 'package.json'), 'utf8')).version, '1.0.1');
});

test('a checkout level with its upstream does nothing', async (t) => {
  const fx = fixture(t);
  const r = await applyUpdate({ root: fx.install });
  assert.equal(r.updated, false);
  assert.match(r.reason, /latest/i);
});

test('a checkout with local edits is left alone, even when upstream moved', async (t) => {
  const fx = fixture(t);
  fx.release('1.0.1');
  const before = fx.head();
  fs.appendFileSync(path.join(fx.install, 'package.json'), ' ');
  const r = await applyUpdate({ root: fx.install });
  assert.equal(r.updated, false);
  assert.match(r.reason, /local changes/i);
  assert.equal(fx.head(), before);
});

test('a checkout that is only ahead of upstream does nothing', async (t) => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.install, 'local.txt'), 'x');
  commit(fx.install, 'local work');
  const r = await applyUpdate({ root: fx.install });
  assert.equal(r.updated, false);
});

test('a diverged checkout fails and is never merged', async (t) => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.install, 'local.txt'), 'x');
  commit(fx.install, 'local work');
  fx.release('1.0.1');
  const before = fx.head();
  await assert.rejects(applyUpdate({ root: fx.install }), /fast-forward|diverged/i);
  assert.equal(fx.head(), before);
});

async function registry(t, version) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}/`;
}

function npmInstall(t, version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-npm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeVersion(root, version);
  return root;
}

test('an npm install on the latest version runs no install', async (t) => {
  const root = npmInstall(t, '1.0.0');
  const calls = [];
  const r = await applyUpdate({ root, registryUrl: await registry(t, '1.0.0'), run: async (...a) => { calls.push(a); return ''; } });
  assert.equal(r.updated, false);
  assert.deepEqual(calls, []);
});

test('an npm install behind the registry installs that exact version globally', async (t) => {
  const root = npmInstall(t, '1.0.0');
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd, ...args]); writeVersion(root, '1.0.1'); return ''; };
  const r = await applyUpdate({ root, registryUrl: await registry(t, '1.0.1'), run });
  assert.deepEqual({ updated: r.updated, from: r.from, to: r.to }, { updated: true, from: '1.0.0', to: '1.0.1' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(-3), ['install', '-g', 'llm-switcher@1.0.1']);
});

test('an unreachable registry is not an update', async (t) => {
  const root = npmInstall(t, '1.0.0');
  const r = await applyUpdate({ root, registryUrl: 'http://127.0.0.1:9/' });
  assert.equal(r.updated, false);
  assert.match(r.reason, /registry/i);
});
