// A real gateway, run from a copy of this checkout that tracks a local bare repository. A release
// pushed there must reach the running gateway through POST /api/update, and through --autoupdate at
// start. Nothing here reaches the network or the real home directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, skipReason } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise(r => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

function copySource(dest) {
  const files = git(ROOT, 'ls-files', '--cached', '--others', '--exclude-standard').split(/\r?\n/).filter(Boolean);
  for (const f of files) {
    const from = path.join(ROOT, f);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.copyFileSync(from, path.join(dest, f));
  }
}

function bumpVersion(dir, version) {
  const p = path.join(dir, 'package.json');
  fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf8')), version }, null, 2) + '\n');
}

// The npm registry answer only drives the dashboard notice; a git checkout updates from git.
async function registry(t, version) {
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version })); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}/`;
}

async function fixture(t, { registryUrl = 'http://127.0.0.1:9/' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-update-e2e-'));
  const upstream = path.join(base, 'upstream.git');
  const install = path.join(base, 'install');
  const publisher = path.join(base, 'publisher');
  git(base, 'init', '-q', '--bare', '-b', 'main', upstream);
  fs.mkdirSync(install);
  copySource(install);
  git(install, 'init', '-q', '-b', 'main');
  git(install, 'add', '-A');
  git(install, ...ID, 'commit', '-q', '-m', 'installed');
  git(install, 'remote', 'add', 'origin', upstream);
  git(install, 'push', '-q', '-u', 'origin', 'main');
  fs.mkdirSync(publisher);
  git(publisher, 'init', '-q', '-b', 'main');
  git(publisher, 'remote', 'add', 'origin', upstream);
  git(publisher, 'fetch', '-q', 'origin');
  git(publisher, 'checkout', '-q', '-b', 'main', '--track', 'origin/main');

  const data = path.join(base, 'data');
  const home = path.join(data, 'home');
  fs.mkdirSync(home, { recursive: true });
  const port = await freePort();
  const cfgPath = path.join(data, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port, blindfold: { port: await freePort() }, activeProfiles: { anthropic: null, responses: null, 'openai-chat': null, vertex: null },
    profiles: { plain: { name: 'Plain', mode: 'convert', inFormat: 'auto', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { opus: 'o' } } }
  }, null, 2));
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    LLM_SWITCHER_CONFIG: cfgPath, LLM_SWITCHER_STATE_DIR: data, LLM_SWITCHER_BLINDFOLD_CERTS: path.join(data, 'certs'),
    LLM_SWITCHER_PORT: '', PORT: '', LLM_SWITCHER_REGISTRY_URL: registryUrl
  };

  let proc = null;
  let log = '';
  const pid = async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/health?challenge=t`)).json()).pid ?? null; } catch { return null; }
  };
  const fx = {
    port,
    log: () => log,
    pid,
    release(version) {
      bumpVersion(publisher, version);
      git(publisher, 'add', '-A');
      git(publisher, ...ID, 'commit', '-q', '-m', `v${version}`);
      git(publisher, 'push', '-q', 'origin', 'main');
    },
    async start(...extra) {
      proc = spawn(process.execPath, [path.join(install, 'proxy.mjs'), '--port', String(port), ...extra], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout.on('data', d => { log += d; });
      proc.stderr.on('data', d => { log += d; });
      return proc;
    },
    async waitFor(check, what) {
      for (let i = 0; i < 120; i++) {
        const v = await check();
        if (v) return v;
        await sleep(250);
      }
      throw new Error(`timed out waiting for ${what}\n${log}`);
    },
    cli: (...args) => new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(install, 'switch.mjs'), ...args, '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', d => { out += d; });
      c.stderr.on('data', d => { out += d; });
      c.on('close', code => resolve({ code, out }));
    }),
    dashboardUrl: `http://127.0.0.1:${port}/ui`,
    api: (p, opts = {}) => fetch(`http://127.0.0.1:${port}${p}`, {
      ...opts,
      headers: { 'x-llm-switcher-token': fs.readFileSync(path.join(data, 'admin.token'), 'utf8').trim(), 'Content-Type': 'application/json' }
    })
  };
  t.after(async () => {
    const live = await pid();
    if (live) try { process.kill(live); } catch {}
    proc?.kill();
    await sleep(300);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return fx;
}

async function readSse(res) {
  const events = [];
  for (const block of (await res.text()).split('\n\n')) {
    const event = /^event: (.*)$/m.exec(block)?.[1];
    if (event) events.push({ event, data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) });
  }
  return events;
}

test('POST /api/update pulls the release and a new gateway takes over the port', { timeout: 90000 }, async (t) => {
  const fx = await fixture(t);
  const proc = await fx.start();
  const oldPid = await fx.waitFor(fx.pid, 'the gateway');
  assert.equal((await (await fx.api('/api/version')).json()).current, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);

  fx.release('9.9.9');
  const events = await readSse(await fx.api('/api/update', { method: 'POST', body: '{}' }));
  const result = events.find(e => e.event === 'result')?.data;
  assert.equal(result?.updated, true, JSON.stringify(events));
  assert.equal(result.to, '9.9.9');

  await fx.waitFor(async () => { const p = await fx.pid(); return p && p !== oldPid; }, 'the new gateway');
  assert.equal((await (await fx.api('/api/version')).json()).current, '9.9.9');
  // The first process stays as the parent: a service manager still sees the pid it started.
  assert.equal(proc.exitCode, null);

  const again = (await readSse(await fx.api('/api/update', { method: 'POST', body: '{}' }))).find(e => e.event === 'result')?.data;
  assert.equal(again?.updated, false);
  assert.match(again.reason, /latest/i);
});

test('--autoupdate starts the newest release', { timeout: 90000 }, async (t) => {
  const fx = await fixture(t);
  fx.release('9.9.10');
  await fx.start('--autoupdate');
  await fx.waitFor(fx.pid, 'the gateway');
  assert.equal((await (await fx.api('/api/version')).json()).current, '9.9.10');
  assert.match(fx.log(), /Pulled 1 commit/);
});

test('switch update asks the running gateway and waits for the new one', { timeout: 90000 }, async (t) => {
  const fx = await fixture(t);
  await fx.start();
  await fx.waitFor(fx.pid, 'the gateway');
  fx.release('9.9.11');
  const r = await fx.cli('update');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /runs v9\.9\.11/);
  assert.equal((await (await fx.api('/api/version')).json()).current, '9.9.11');
});

test('the dashboard Update now button installs the release and reloads on the new gateway', { timeout: 90000, skip: skipReason() }, async (t) => {
  const fx = await fixture(t, { registryUrl: await registry(t, '9.9.12') });
  await fx.start();
  await fx.waitFor(fx.pid, 'the gateway');
  fx.release('9.9.12');
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(fx.dashboardUrl);
  await page.waitFor(`!document.getElementById('update-notice').hidden`, 'the update notice');
  await page.click('#update-now');
  await page.waitFor(`document.getElementById('app-version')?.textContent === 'v9.9.12'`, 'the reloaded dashboard on the new version', 30000);
  assert.equal(await page.evaluate(`document.getElementById('update-notice').hidden`), true);
});
