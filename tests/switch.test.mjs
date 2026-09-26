// CLI tests: switch.mjs runs as a child with its own config, launch files and Claude dir
// (audit F06, BR-02, F27, F30, F46).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  assert.equal(cfg.activeProfiles.claude, 'plain');
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

// ==================== Task 1 Tests ====================

const failCASInject = {
  NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(`
    const fs = (await import('node:fs')).default;
    let c = 0;
    const origRead = fs.readFileSync;
    fs.readFileSync = (f, ...a) => {
      const res = origRead(f, ...a);
      if (typeof f === 'string' && f.endsWith('config.json') && c++ % 2 === 1) return Buffer.from(res.toString() + ' ');
      return res;
    };
  `)}`
};

test('with migrationError set, running "switch <p>" asserts exit 1, stderr containing "Migration error", and no gateway answering on the port afterwards', { skip: !POSIX && 'posix' }, async (t) => {
  const port = await freePort();
  const ws = workspace(t, port, { plain: { inFormat: 'anthropic' } });
  const r = await run(ws, ['plain'], { env: failCASInject });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Migration error/);
  const probe = await new Promise(res => {
    const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res('listening'); });
    s.on('error', () => res('free'));
  });
  assert.equal(probe, 'free', 'no gateway answers on port');
});

test('A11: save-profile refuses command word profile keys with 400', async () => {
  const { isValidProfileKey } = await import('../state.mjs');
  for (const word of ['on', 'off', 'status', 'doctor', 'ui', 'claude', 'codex', 'ON', 'Claude']) {
    assert.equal(isValidProfileKey(word), false, `Command word "${word}" must not be valid profile key`);
  }
});

test('A5: save-profile refuses inFormat and legacy blindfold fields with 400', async () => {
  const { validateProfileInput } = await import('../state.mjs');
  assert.ok(validateProfileInput({ inFormat: 'auto' }), 'must reject inFormat');
  assert.ok(validateProfileInput({ blindfoldPort: 3457 }), 'must reject blindfoldPort');
  assert.ok(validateProfileInput({ blindfoldHost: 'chatgpt.com' }), 'must reject blindfoldHost');
  assert.ok(validateProfileInput({ blindfoldPrefix: '/v1' }), 'must reject blindfoldPrefix');
  assert.ok(validateProfileInput({ blindfold: true }), 'must reject blindfold');
});

test('R7: gateway process startup and reconcile refuse while getMigrationCollision is non-null', { skip: !POSIX && 'posix' }, async (t) => {
  const port = await freePort();
  const ws = workspace(t, port);
  // Write a colliding config into workspace
  const collidingCfg = {
    port,
    activeProfile: 'p',
    profiles: {
      p: { inFormat: 'auto', defaultModels: { opus: 'x', main: 'y' } },
      'p-codex': { tool: 'codex' }
    }
  };
  fs.writeFileSync(ws.cfgPath, JSON.stringify(collidingCfg, null, 2));
  const r = await run(ws, ['on', 'p']);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /collision/i);
});

// ==================== Task 5 ====================

// A gateway started straight (not through `switch`) is what the service and the tests do, and it
// has to refuse every route that would rewrite a config.json it cannot rewrite. Returns its log.
async function startGateway(t, dir, cfgPath, port, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'proxy.mjs'), '--port', String(port)], {
    env: {
      ...process.env, LLM_SWITCHER_CONFIG: cfgPath, LLM_SWITCHER_STATE_DIR: dir,
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), LLM_SWITCHER_PORT: '', PORT: '',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return log; } catch { /* not listening yet */ }
    await new Promise(res => setTimeout(res, 50));
  }
  throw new Error(`gateway did not start: ${log}`);
}

// The token file is written once the gateway has decided what it serves, so wait for it instead
// of racing it.
async function waitForToken(dir) {
  for (let i = 0; i < 200; i++) {
    try {
      const t = fs.readFileSync(path.join(dir, 'admin.token'), 'utf8').trim();
      if (t) return t;
    } catch { /* not written yet */ }
    await new Promise(res => setTimeout(res, 50));
  }
  throw new Error('admin.token was never written');
}

test('calling /api/switch, /api/toggle, /api/save-profile, /api/delete-profile with collision present returns HTTP 409 with clashing keys and leaves config.json bytes identical before and after', async (t) => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-409-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfgPath = path.join(dir, 'config.json');
  // `p` would split into p-claude and p-codex on migration, and p-codex already exists: the two
  // pointers disagree about who owns that name.
  const colliding = {
    port,
    activeProfile: 'p',
    profiles: {
      p: { name: 'P', mode: 'convert', inFormat: 'auto', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { opus: 'x', main: 'y' } },
      'p-codex': { name: 'P codex', mode: 'convert', tool: 'codex', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { main: 'y' } }
    }
  };
  fs.writeFileSync(cfgPath, JSON.stringify(colliding, null, 2), { mode: 0o600 });
  const before = fs.readFileSync(cfgPath);
  await startGateway(t, dir, cfgPath, port);
  const token = await waitForToken(dir);
  const headers = { 'Content-Type': 'application/json', 'x-llm-switcher-token': token };
  const calls = [
    ['/api/switch', { target: 'claude', profile: 'p' }],
    ['/api/toggle', { target: 'claude', enabled: true }],
    ['/api/save-profile', { key: 'brand-new', profile: { name: 'N', mode: 'convert', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: {} } }],
    ['/api/delete-profile', { key: 'p' }]
  ];
  for (const [p, body] of calls) {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(r.status, 409, `${p} must be refused, got ${r.status}`);
    const j = await r.json();
    assert.equal(j.error, 'Migration collision', `${p} says what is wrong`);
    assert.ok(Array.isArray(j.clashingKeys) && j.clashingKeys.length > 0, `${p} names the clashing keys`);
  }
  assert.ok(fs.readFileSync(cfgPath).equals(before), 'config.json is byte-identical after every refused change');
});

// ==================== Task 5: collision mode, turnOff, doctor ====================

// A config that collides on migration: `p` serves both tools, so migration would split it into
// `p-claude` and `p-codex`, and `p-codex` already exists. It gets a blindfold port of its own, so a
// probe from this workspace can never reach the interceptor of another install on the machine.
async function collisionWs(t, extra = {}) {
  const port = await freePort();
  const ws = workspace(t, port);
  const bfPort = await freePort();
  fs.writeFileSync(ws.cfgPath, JSON.stringify({
    port,
    activeProfile: 'p',
    blindfold: { port: bfPort },
    activeProfiles: { anthropic: null, responses: null, 'openai-chat': null, vertex: null, ...(extra.activeProfiles || {}) },
    ...(extra.top || {}),
    profiles: {
      p: { name: 'P', mode: 'convert', inFormat: 'auto', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { opus: 'x', main: 'y' } },
      'p-codex': { name: 'P codex', mode: 'convert', tool: 'codex', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { main: 'y' } },
      claudeOnly: { name: 'C', mode: 'convert', tool: 'claude', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { opus: 'x' } },
      ...(extra.profiles || {})
    }
  }, null, 2), { mode: 0o600 });
  return { ...ws, port, bfPort };
}

// Every mutating command has to refuse before it stops or starts anything. These five are the
// surface the collision rules name (R7).
const R7_REFUSALS = [
  ['R7: during collision, gateway start exits non-zero', ['on', 'p']],
  ['R7: during collision, switch on exits non-zero', ['on']],
  ['R7: during collision, switch <p> exits non-zero', ['p']],
  ['R7: during collision, switch claude exits non-zero', ['claude', 'p']],
  ['R7: during collision, switch codex exits non-zero', ['codex', 'p']]
];
for (const [name, args] of R7_REFUSALS) {
  test(name, async (t) => {
    const ws = await collisionWs(t);
    const before = fs.readFileSync(ws.cfgPath);
    const r = await run(ws, args);
    assert.notEqual(r.status, 0, `${args.join(' ')} must exit non-zero:\n${r.stdout}`);
    assert.match(r.stderr, /collision/i);
    assert.ok(fs.readFileSync(ws.cfgPath).equals(before), 'config.json untouched');
    const probe = await new Promise(res => {
      const s = net.connect(ws.port, '127.0.0.1', () => { s.destroy(); res('listening'); });
      s.on('error', () => res('free'));
    });
    assert.equal(probe, 'free', 'no gateway was started');
  });
}

// The user asked for it and the build still has to honour it: nothing is refused, only rewritten
// through the CAS writer (R7b). Exit 0 is the whole point — a broken migration must not turn
// "switch off" into an error the user cannot act on.
test('R7: during collision, bare switch off exits 0', async (t) => {
  const ws = await collisionWs(t);
  const r = await run(ws, ['off']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const cfg = readCfg(ws);
  assert.ok(Object.hasOwn(cfg.activeProfiles, 'claude') && cfg.activeProfiles.claude === null);
  assert.ok(Object.hasOwn(cfg.activeProfiles, 'codex') && cfg.activeProfiles.codex === null);
});

test('bare switch off during collision writes both new keys as null, clears launch state, stops gateway, and exits 0', async (t) => {
  const ws = await collisionWs(t);
  await startGateway(t, ws.dir, ws.cfgPath, ws.port);
  fs.writeFileSync(path.join(ws.dir, 'active.flag'), 'active');
  fs.writeFileSync(path.join(ws.dir, 'env-claude.sh'), "export HTTPS_PROXY='http://127.0.0.1:1'\n");

  const r = await run(ws, ['off']);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const cfg = readCfg(ws);
  assert.equal(cfg.activeProfiles.claude, null, 'claude pointer cleared');
  assert.equal(cfg.activeProfiles.codex, null, 'codex pointer cleared');
  assert.equal(cfg.activeProfile, 'p', 'the legacy pointer this build will not rewrite stays');
  assert.equal(fs.existsSync(path.join(ws.dir, 'active.flag')), false, 'launch state cleared');
  assert.equal(fs.readFileSync(path.join(ws.dir, 'env-claude.sh'), 'utf8'), '', 'env files emptied');

  let up = false;
  try { up = (await fetch(`http://127.0.0.1:${ws.port}/health`)).ok; } catch { /* already gone */ }
  assert.equal(up, false, 'the gateway was stopped');
});

test('R7b: during collision, switch off codex writes only activeProfiles.codex=null, empties env-codex.sh, and keeps old pointer keys byte-equal', async (t) => {
  const ws = await collisionWs(t);
  const before = readCfg(ws);
  fs.writeFileSync(path.join(ws.dir, 'env-codex.sh'), "export HTTPS_PROXY='codex'\n");
  fs.writeFileSync(path.join(ws.dir, 'env-claude.sh'), "export HTTPS_PROXY='claude'\n");

  const r = await run(ws, ['off', 'codex']);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const after = readCfg(ws);
  assert.equal(after.activeProfiles.codex, null, 'only the codex pointer was cleared');
  assert.ok(!Object.hasOwn(after.activeProfiles, 'claude'), 'no claude pointer was written');
  for (const k of ['anthropic', 'responses', 'openai-chat', 'vertex']) {
    assert.equal(after[k], before[k], `top-level ${k} byte-equal`);
    assert.equal(after.activeProfiles[k], before.activeProfiles[k], `activeProfiles.${k} byte-equal`);
  }
  assert.equal(after.activeProfile, before.activeProfile, 'activeProfile byte-equal');
  assert.deepEqual(after.profiles, before.profiles, 'profiles byte-equal');
  assert.equal(fs.readFileSync(path.join(ws.dir, 'env-codex.sh'), 'utf8'), '', 'env-codex.sh emptied');
  assert.equal(fs.readFileSync(path.join(ws.dir, 'env-claude.sh'), 'utf8'), "export HTTPS_PROXY='claude'\n", 'the other tool keeps its env file');
});

// The writer must take its bytes from the file, not from the CLI's cache: the cached copy of a
// colliding config is the one migration would have produced, and writing that would rewrite a file
// this build has refused to rewrite.
test('R2: collision-mode switch off <tool> re-reads config from disk and writes via CAS keeping seeded old pointer keys byte-equal at top level and inside activeProfiles (anthropic, responses, openai-chat, vertex)', async (t) => {
  const ws = await collisionWs(t, {
    top: { anthropic: 'z-ant-top', responses: 'z-res-top', 'openai-chat': 'z-oai-top', vertex: 'z-vert-top' },
    activeProfiles: { anthropic: 'z-ant', responses: 'z-res', 'openai-chat': 'z-oai', vertex: 'z-vert' }
  });
  const before = readCfg(ws);

  const r = await run(ws, ['off', 'claude']);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const after = readCfg(ws);
  assert.ok(Object.hasOwn(after.activeProfiles, 'claude') && after.activeProfiles.claude === null, 'claude cleared');
  assert.ok(!Object.hasOwn(after.activeProfiles, 'codex'), 'codex untouched');
  for (const k of ['anthropic', 'responses', 'openai-chat', 'vertex']) {
    assert.equal(after[k], before[k], `top-level ${k} byte-equal`);
    assert.equal(after.activeProfiles[k], before.activeProfiles[k], `activeProfiles.${k} byte-equal`);
  }
  assert.deepEqual(after.profiles, before.profiles, 'profiles byte-equal');
  // The file on disk is still the unmigrated one: no p-claude was created, activeProfile survived.
  assert.equal(after.activeProfile, 'p', 'still unmigrated');
  assert.ok(!Object.hasOwn(after.profiles, 'p-claude'), 'no split profile was written');
});

test('R7: during collision, switch doctor exits 0', async (t) => {
  const ws = await collisionWs(t);
  const before = fs.readFileSync(ws.cfgPath);
  const r = await run(ws, ['doctor']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /collision/i, 'the doctor names the collision instead of hiding it');
  assert.ok(fs.readFileSync(ws.cfgPath).equals(before), 'doctor is read-only');
});

// A profile belongs to one tool. Being told so costs nothing and saves the user a gateway that
// accepts the request and then has nowhere to send it.
test('A6: switch codex <claude-profile> exits non-zero and changes nothing', async (t) => {
  const port = await freePort();
  const ws = workspace(t, port, {
    claudeOnly: { name: 'C', mode: 'convert', tool: 'claude', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { opus: 'x' } },
    codexOnly: { name: 'K', mode: 'convert', tool: 'codex', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { main: 'y' } }
  });
  // The first load rewrites a legacy config on its own. Migrate once here so the assertion below
  // measures this command and nothing else.
  await run(ws, ['status']);
  const before = fs.readFileSync(ws.cfgPath);
  const r = await run(ws, ['codex', 'claudeOnly']);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /\[Error\]/);
  assert.ok(fs.readFileSync(ws.cfgPath).equals(before), 'config.json untouched');
  const probe = await new Promise(res => {
    const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res('listening'); });
    s.on('error', () => res('free'));
  });
  assert.equal(probe, 'free', 'no gateway was started');
});

// --- migrationError mode: the same CAS writer, because saveConfig refuses here too (R1) ---

// The burst variant stops patching the moment the load sets migrationError, so the load fails its CAS
// while `switch off` gets clean bytes and can write. `failCASInject` below never stops, which is the
// other half of the rule: three failures and the command gives up without touching anything.
const failCASThenClean = {
  NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(`
    const fs = (await import('node:fs')).default;
    const s = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'state.mjs')).href)});
    const origRead = fs.readFileSync;
    fs.readFileSync = (f, ...a) => {
      const res = origRead(f, ...a);
      const bad = typeof f === 'string' && f.endsWith('config.json') && !s.getMigrationError();
      let c = fs.__c = (fs.__c || 0) + 1;
      if (bad && c % 2 === 0) return Buffer.from(res.toString() + ' ');
      return res;
    };
  `)}`
};

test('with migrationError set, running "switch off <tool>" uses CAS setting activeProfiles.<tool>=null, empties env-<tool>.sh, syncs interceptor, and exits 0', async (t) => {
  const port = await freePort();
  const ws = workspace(t, port);
  fs.writeFileSync(ws.cfgPath, JSON.stringify({
    port,
    activeProfile: 'plain',
    blindfold: { port: await freePort() },
    activeProfiles: { anthropic: null, responses: null, 'openai-chat': null, vertex: null },
    profiles: { plain: { name: 'Plain', mode: 'convert', inFormat: 'auto', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { opus: 'o' } } }
  }, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(ws.dir, 'env-claude.sh'), "export HTTPS_PROXY='x'\n");
  const before = fs.readFileSync(ws.cfgPath);

  const r = await run(ws, ['off', 'claude'], { env: failCASThenClean });
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const cfg = readCfg(ws);
  assert.ok(!cfg.activeProfiles.claude, 'activeProfiles.claude cleared');
  assert.equal(cfg.activeProfile, 'plain', 'the legacy pointer this build will not rewrite stays');
  assert.equal(fs.readFileSync(path.join(ws.dir, 'env-claude.sh'), 'utf8'), '', 'env-claude.sh emptied');
  assert.ok(!before.equals(fs.readFileSync(ws.cfgPath)), 'the file did change');
});

test('R1: bare switch off under migrationError writes both pointers null through the CAS writer; after 3 forced CAS failures it exits 1 and the gateway still answers', async (t) => {
  const port = await freePort();
  const ws = workspace(t, port);
  fs.writeFileSync(ws.cfgPath, JSON.stringify({
    port,
    activeProfile: 'plain',
    blindfold: { port: await freePort() },
    activeProfiles: { anthropic: null, responses: null, 'openai-chat': null, vertex: null },
    profiles: { plain: { name: 'Plain', mode: 'convert', inFormat: 'auto', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { opus: 'o' } } }
  }, null, 2), { mode: 0o600 });
  await startGateway(t, ws.dir, ws.cfgPath, port, failCASInject);
  fs.writeFileSync(path.join(ws.dir, 'active.flag'), 'active');
  const before = fs.readFileSync(ws.cfgPath);

  const r = await run(ws, ['off'], { env: failCASInject });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /config\.json/i, 'the failure is named on stderr');
  assert.ok(fs.readFileSync(ws.cfgPath).equals(before), 'config.json untouched after three failures');
  assert.equal(fs.existsSync(path.join(ws.dir, 'active.flag')), true, 'launch state was not cleared');

  let up = false;
  try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { /* down */ }
  assert.equal(up, true, 'the gateway still answers: nothing was torn down on a failed write');
});

test('R7e: CLI mutating command exits non-zero with error on stderr when saveConfig refuses under getMigrationError', async (t) => {
  const port = await freePort();
  const ws = workspace(t, port, { plain: { inFormat: 'anthropic' } });
  const r = await run(ws, ['on', 'plain'], { env: failCASInject });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Migration error/);
  const probe = await new Promise(res => {
    const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res('listening'); });
    s.on('error', () => res('free'));
  });
  assert.equal(probe, 'free', 'the refusal happens before any gateway starts');
});

test('R1: port-change path exits 1 before stopProxy is called under migrationError', async (t) => {
  const port = await freePort();
  const other = await freePort();
  const ws = workspace(t, port, { plain: { inFormat: 'anthropic' } });
  await startGateway(t, ws.dir, ws.cfgPath, port, failCASInject);

  const r = await run(ws, ['port', String(other)], { env: failCASInject });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Migration error/);
  assert.equal(readCfg(ws).port, port, 'the port is unchanged');

  let up = false;
  try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { /* down */ }
  assert.equal(up, true, 'the old gateway was never stopped');
});

// The guard that matters is the second read: config.json parsed when the CLI started and stopped
// parsing while it waited for the gateway.
test('R7e: parse guard blocks writes and exits non-zero when lastLoadError is set', async (t) => {
  const port = await freePort();
  const ws = workspace(t, port);
  fs.writeFileSync(ws.cfgPath, JSON.stringify({
    port,
    blindfold: { port: await freePort() },
    activeProfiles: { anthropic: null, responses: null, 'openai-chat': null, vertex: null },
    profiles: { plain: { name: 'Plain', mode: 'convert', inFormat: 'auto', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { opus: 'o' } } }
  }, null, 2), { mode: 0o600 });
  const before = fs.readFileSync(ws.cfgPath);
  const corrupt = Buffer.from('{"port": ');
  let broken = false;
  const r = await run(ws, ['on', 'plain'], {
    onLine: (line) => {
      if (broken || !line.startsWith('Activating profile')) return;
      broken = true;
      fs.writeFileSync(ws.cfgPath, corrupt);
    }
  });
  assert.ok(broken, 'the CLI reached the point where it re-reads config.json');
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /does not parse/);
  assert.ok(fs.readFileSync(ws.cfgPath).equals(corrupt), 'the guard did not rewrite the broken file');
  // Put it back so the workspace teardown can stop the gateway this run started.
  fs.writeFileSync(ws.cfgPath, before);
  await run(ws, ['off']);
});

test('R7e: saves work again after the file is fixed', async (t) => {
  const port = await freePort();
  const ws = workspace(t, port, { plain: { inFormat: 'anthropic' } });
  fs.writeFileSync(ws.cfgPath, '{"port": ');
  const broken = await run(ws, ['plain']);
  assert.notEqual(broken.status, 0, broken.stdout);
  assert.match(broken.stderr, /Cannot load|does not parse/);

  fs.writeFileSync(ws.cfgPath, JSON.stringify({
    port,
    activeProfiles: { anthropic: null, responses: null, 'openai-chat': null, vertex: null },
    profiles: { plain: { name: 'Plain', mode: 'convert', inFormat: 'auto', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { opus: 'o' } } }
  }, null, 2), { mode: 0o600 });

  const fixed = await run(ws, ['off', 'claude']);
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  assert.ok(readCfg(ws).profiles.plain, 'the file writes again');
});
