// The update itself: npm is asked first and installs the version the registry names; a git
// checkout is the fallback, and pulls fast-forward only. Every remote here is a local bare
// repository or a local HTTP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { applyUpdate } from '../update.mjs';

const execFileAsync = promisify(execFile);

// Records every command in the order it is asked. git runs for real, because the checkout has to
// move before the fallback can be observed. npm's install is recorded and not run: the version a
// fixture registry names is a number from the test, not one the real registry serves, and a real
// install would put a package on the machine running the suite.
const recording = (calls) => async (cmd, args, opts) => {
  calls.push([cmd, ...args]);
  if (cmd === 'npm' || cmd === 'cmd.exe') return '';
  const { stdout } = await execFileAsync(cmd, args, { encoding: 'utf8', ...opts });
  return stdout;
};

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
  const r = await applyUpdate({ root: fx.install, registryUrl: await registry(t, '1.0.0') });
  assert.deepEqual({ updated: r.updated, from: r.from, to: r.to }, { updated: true, from: '1.0.0', to: '1.0.1' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(fx.install, 'package.json'), 'utf8')).version, '1.0.1');
});

test('a checkout level with its upstream does nothing', async (t) => {
  const fx = fixture(t);
  const r = await applyUpdate({ root: fx.install, registryUrl: await registry(t, '1.0.0') });
  assert.equal(r.updated, false);
  assert.match(r.reason, /latest/i);
});

test('a gateway that runs older code than its checkout restarts into it, with nothing to pull', async (t) => {
  const fx = fixture(t);
  fx.release('1.0.1');
  git(fx.install, 'pull', '-q', '--ff-only');
  const r = await applyUpdate({ root: fx.install, running: '1.0.0', registryUrl: await registry(t, '1.0.1') });
  assert.deepEqual({ updated: r.updated, from: r.from, to: r.to }, { updated: true, from: '1.0.0', to: '1.0.1' });
});

test('a checkout with local edits is left alone, even when upstream moved', async (t) => {
  const fx = fixture(t);
  fx.release('1.0.1');
  const before = fx.head();
  fs.appendFileSync(path.join(fx.install, 'package.json'), ' ');
  const r = await applyUpdate({ root: fx.install, registryUrl: await registry(t, '1.0.0') });
  assert.equal(r.updated, false);
  assert.match(r.reason, /local changes/i);
  assert.equal(fx.head(), before);
});

test('a checkout that is only ahead of upstream does nothing', async (t) => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.install, 'local.txt'), 'x');
  commit(fx.install, 'local work');
  const r = await applyUpdate({ root: fx.install, registryUrl: await registry(t, '1.0.0') });
  assert.equal(r.updated, false);
});

test('a diverged checkout fails and is never merged', async (t) => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.install, 'local.txt'), 'x');
  commit(fx.install, 'local work');
  fx.release('1.0.1');
  const before = fx.head();
  await assert.rejects(applyUpdate({ root: fx.install, registryUrl: await registry(t, '1.0.0') }), /fast-forward|diverged/i);
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

test('an npm install that a running gateway has not loaded yet restarts into it, with no install', async (t) => {
  const root = npmInstall(t, '1.0.1');
  const calls = [];
  const r = await applyUpdate({ root, running: '1.0.0', registryUrl: await registry(t, '1.0.1'), run: async (...a) => { calls.push(a); return ''; } });
  assert.deepEqual({ updated: r.updated, from: r.from, to: r.to }, { updated: true, from: '1.0.0', to: '1.0.1' });
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

// launchd and systemd --user start the gateway with a short PATH that has no Homebrew or nvm npm.
test('npm runs with the directory of the running node first on PATH', async (t) => {
  const root = npmInstall(t, '1.0.0');
  let env = null;
  const run = async (cmd, args, opts) => { env = opts.env; writeVersion(root, '1.0.1'); return ''; };
  await applyUpdate({ root, registryUrl: await registry(t, '1.0.1'), run });
  const keys = Object.keys(env).filter(k => k.toUpperCase() === 'PATH');
  assert.equal(keys.length, 1, `one PATH key, got ${keys.join(', ')}`);
  assert.equal(env[keys[0]].split(path.delimiter)[0], path.dirname(process.execPath));
});

test('an unreachable registry is not an update', async (t) => {
  const root = npmInstall(t, '1.0.0');
  const r = await applyUpdate({ root, registryUrl: 'http://127.0.0.1:9/' });
  assert.equal(r.updated, false);
  assert.match(r.reason, /registry/i);
});

// ---- npm first, and the checkout only when npm cannot serve it ----

test('a release on npm is installed before the checkout is asked at all', async (t) => {
  const fx = fixture(t);
  fx.release('1.0.1');
  const calls = [];
  const r = await applyUpdate({ root: fx.install, registryUrl: await registry(t, '1.0.1'), run: recording(calls) });

  const order = calls.map(c => c[0]);
  assert.deepEqual(order.slice(0, 2), [process.platform === 'win32' ? 'cmd.exe' : 'npm', 'git'], `npm first, then the checkout: ${order.join(' ')}`);
  assert.deepEqual(calls[0].slice(-3), ['install', '-g', 'llm-switcher@1.0.1']);
  // npm put the release in the global prefix, which is not this directory, so the checkout is what
  // moved -- and that is the version this gateway runs, which is the only reason the pull happened.
  assert.match(r.reason, /Pulled 1 commit/);
  assert.deepEqual({ updated: r.updated, from: r.from, to: r.to }, { updated: true, from: '1.0.0', to: '1.0.1' });
});

test('a checkout level with its upstream runs no git pull when npm had nothing newer', async (t) => {
  const fx = fixture(t);
  const calls = [];
  const r = await applyUpdate({ root: fx.install, registryUrl: await registry(t, '1.0.0'), run: recording(calls) });

  assert.equal(calls.some(c => c[0] === 'npm' && c.includes('install')), false, 'no install when npm is not newer');
  assert.equal(calls.some(c => c.includes('pull')), false, 'nothing to pull');
  assert.match(r.reason, /latest/i);
});

test('npm holding a release the checkout cannot take is said plainly, not hidden by "latest"', async (t) => {
  const fx = fixture(t);
  // The checkout is level, and the registry is a version ahead of it: the two answers disagree.
  const r = await applyUpdate({ root: fx.install, registryUrl: await registry(t, '1.4.0'), run: recording([]) });

  assert.equal(r.updated, false);
  assert.match(r.reason, /npm installed v1\.4\.0, but not into/);
  assert.match(r.reason, /latest/i, 'the checkout answer is kept as well');
});

test('a checkout is still updated by git when the registry cannot be reached', async (t) => {
  const fx = fixture(t);
  fx.release('1.0.1');
  const r = await applyUpdate({ root: fx.install, registryUrl: 'http://127.0.0.1:9/' });

  assert.deepEqual({ updated: r.updated, from: r.from, to: r.to }, { updated: true, from: '1.0.0', to: '1.0.1' });
});

test('an npm install that fails does not stop a checkout from updating', async (t) => {
  const fx = fixture(t);
  fx.release('1.0.1');
  const logs = [];
  // npm refuses the version a fixture registry names, the way a real registry would.
  const run = async (cmd, args, opts) => {
    if (cmd === 'npm' || cmd === 'cmd.exe') throw new Error('npm install failed: notarget No matching version found');
    return recording([])(cmd, args, opts);
  };
  const r = await applyUpdate({ root: fx.install, registryUrl: await registry(t, '1.0.1'), run, logger: m => logs.push(m) });

  assert.deepEqual({ updated: r.updated, from: r.from, to: r.to }, { updated: true, from: '1.0.0', to: '1.0.1' });
  assert.match(r.reason, /Pulled 1 commit/);
  // The npm failure is said out loud, not swallowed into a success nobody can explain.
  assert.match(logs.join('\n'), /npm could not install it here/);
});

test('an npm install behind the registry still fails loudly when there is no checkout', async (t) => {
  const root = npmInstall(t, '1.0.0');
  const run = async () => { throw new Error('npm install failed: EACCES'); };
  await assert.rejects(applyUpdate({ root, registryUrl: await registry(t, '1.0.1'), run }), /npm install failed/);
});
