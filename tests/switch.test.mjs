// CLI tests: switch.mjs runs as a child with its own config, launch files and Claude dir
// (audit F06, BR-02, F27, F30, F46).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSIX = process.platform !== 'win32';

const freePort = () => new Promise(r => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

function workspace(t, port, profiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-cli-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port, activeProfiles: { anthropic: null, responses: null, 'openai-chat': null, vertex: null },
    profiles: profiles || { plain: { name: 'Plain', mode: 'convert', inFormat: 'auto', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { opus: 'o' } } }
  }, null, 2), { mode: 0o600 });
  // HOME too: `switch on` installs shims under the home directory, and a test must never rewrite the real ones.
  const home = path.join(dir, 'home');
  const ws = { dir, cfgPath, home, env: { ...process.env, HOME: home, USERPROFILE: home, LLM_SWITCHER_CONFIG: cfgPath, LLM_SWITCHER_STATE_DIR: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), LLM_SWITCHER_PORT: '', PORT: '' } };
  t.after(async () => {
    await run(ws, ['off']).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return ws;
}

// onLine lets a test act at a precise moment of the run, for example while the CLI waits.
function run(ws, args, { onLine, env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'switch.mjs'), ...args], { env: { ...ws.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => {
      stdout += d;
      if (onLine) for (const line of String(d).split('\n')) onLine(line);
    });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', code => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
}

const readCfg = (ws) => JSON.parse(fs.readFileSync(ws.cfgPath, 'utf8'));

test('profile names are printed without terminal control sequences', { skip: !POSIX && 'posix' }, async (t) => {
  const ws = workspace(t, await freePort(), {
    evil: { name: 'Evil\u001b[2J\u001b]0;pwned\u0007', mode: 'convert', inFormat: 'auto', baseURL: 'http://127.0.0.1:9/v1\u001b[31m', apiKey: 'k', defaultModels: { opus: 'o' } }
  });
  const r = await run(ws, ['status']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(r.stdout), JSON.stringify(r.stdout));
  assert.match(r.stdout, /Evil/);
});

test('-p is the global port option at any position, never the port command', { skip: !POSIX && 'posix' }, async (t) => {
  const port = await freePort();
  const other = await freePort();
  const ws = workspace(t, port);
  const r = await run(ws, ['-p', String(other), 'status']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /=== LLM Switcher Status ===/);
  assert.match(r.stdout, new RegExp(`/ui`));
  assert.ok(r.stdout.includes(`:${other}/ui`), r.stdout);
  assert.equal(readCfg(ws).port, port, 'config.json keeps its port');
});

test('switch on keeps a change that another writer saved while it waited for the gateway', { skip: !POSIX && 'posix' }, async (t) => {
  const ws = workspace(t, await freePort());
  let edited = false;
  const r = await run(ws, ['on', 'plain'], {
    onLine: (line) => {
      if (edited || !line.startsWith('Starting proxy service')) return;
      edited = true;
      const cfg = readCfg(ws);
      cfg.profiles.plain.name = 'Renamed while waiting';
      fs.writeFileSync(`${ws.cfgPath}.x`, JSON.stringify(cfg));
      fs.renameSync(`${ws.cfgPath}.x`, ws.cfgPath);
    }
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(edited, 'the CLI started a gateway');
  const cfg = readCfg(ws);
  assert.equal(cfg.profiles.plain.name, 'Renamed while waiting');
  assert.equal(cfg.activeProfiles.anthropic, 'plain');
});

test('switch port refuses a port that another process holds and leaves the gateway where it was', { skip: !POSIX && 'posix' }, async (t) => {
  const port = await freePort();
  const ws = workspace(t, port);
  assert.equal((await run(ws, ['on', 'plain'])).status, 0);
  const squatter = net.createServer(s => s.end('HTTP/1.1 200 OK\r\n\r\nnot the switcher'));
  const held = await new Promise(r => squatter.listen(0, '127.0.0.1', () => r(squatter.address().port)));
  t.after(() => squatter.close());
  const r = await run(ws, ['port', String(held)]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /held by another process/);
  assert.equal(readCfg(ws).port, port);
  const status = await run(ws, ['status']);
  assert.match(status.stdout, new RegExp(`RUNNING \\(port ${port}\\)`));
});

test('switch port puts config.json and the gateway back when the new gateway does not come up', { skip: !POSIX && 'posix' }, async (t) => {
  const port = await freePort();
  const next = await freePort();
  const ws = workspace(t, port);
  assert.equal((await run(ws, ['on', 'plain'])).status, 0);
  // The new port is free at the check and taken right after the old gateway stops.
  const squatter = net.createServer(s => s.destroy());
  t.after(() => squatter.close());
  const r = await run(ws, ['port', String(next)], {
    onLine: (line) => { if (line.startsWith('Stopping gateway')) squatter.listen(next, '127.0.0.1'); }
  });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, new RegExp(`back on port ${port}`));
  assert.equal(readCfg(ws).port, port);
  assert.match((await run(ws, ['status'])).stdout, new RegExp(`RUNNING \\(port ${port}\\)`));
});

// A shim bakes in the state dir. A temp state dir, deleted later, would make every shim source a path that
// another account can re-create (audit follow-up attacker-1).
test('switch on installs no shims when the launch files live outside the checkout', { skip: !POSIX && 'posix' }, async (t) => {
  const ws = workspace(t, await freePort());
  const r = await run(ws, ['on', 'plain']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[Shim\] Not installed automatically/);
  assert.equal(fs.existsSync(path.join(ws.home, '.llm-switcher', 'bin', 'claude')), false);
});

// Only the named script starts late: the CLI itself runs at normal speed.
const slowStart = (script, ms) => ({ NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(`if ((process.argv[1] || '').endsWith('${script}')) { const end = Date.now() + ${ms}; while (Date.now() < end) {} }`)}` });

// A gateway that comes up after the 5 s wait must not stay on the new port after the rollback
// (follow-up RACER-5).
test('switch port stops the new gateway it started when it rolls back', { skip: !POSIX && 'posix' }, async (t) => {
  const port = await freePort();
  const next = await freePort();
  const ws = workspace(t, port);
  assert.equal((await run(ws, ['on', 'plain'])).status, 0);
  const r = await run(ws, ['port', String(next)], { env: slowStart('proxy.mjs', 7000) });
  assert.notEqual(r.status, 0, r.stdout);
  await new Promise(res => setTimeout(res, 8000));
  const probe = await new Promise(res => {
    const s = net.connect(next, '127.0.0.1', () => { s.destroy(); res('listening'); });
    s.on('error', () => res('free'));
  });
  assert.equal(probe, 'free', 'nothing listens on the abandoned port');
});

// Without publicModels the gateway has no official name to give Codex: no model catalog, no OpenAI-Model
// header, and Codex prints false "metadata not found" and "high-risk cyber activity" warnings.
test('switch codex and switch doctor warn when the Codex profile has no publicModels', { skip: !POSIX && 'posix' }, async (t) => {
  const base = { mode: 'convert', inFormat: 'auto', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { opus: 'o' } };
  const ws = workspace(t, await freePort(), { bare: { name: 'Bare', ...base }, named: { name: 'Named', ...base, publicModels: ['gpt-5.6-sol'] } });
  const on = await run(ws, ['codex', 'bare']);
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout + on.stderr, /\[WARN\].*"bare".*publicModels/);
  const doctor = await run(ws, ['doctor']);
  assert.match(doctor.stdout, /\[WARN\].*"bare".*publicModels/);

  const named = await run(ws, ['codex', 'named']);
  assert.equal(named.status, 0, named.stderr);
  assert.doesNotMatch(named.stdout + named.stderr, /publicModels/);
  assert.doesNotMatch((await run(ws, ['doctor'])).stdout, /publicModels/);
});
