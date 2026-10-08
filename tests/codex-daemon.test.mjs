// The interactive Codex TUI talks to a shared app-server daemon that keeps the environment it started
// with. A change of the Codex route must restart it, or the TUI keeps calling the old destination.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Temporary HOME and state dir before the import, so nothing here can reach the real Codex daemon.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-codex-daemon-'));
process.env.HOME = path.join(root, 'home');
process.env.LLM_SWITCHER_STATE_DIR = path.join(root, 'state');
delete process.env.CODEX_HOME;
fs.mkdirSync(process.env.LLM_SWITCHER_STATE_DIR, { recursive: true });
const { restartCodexDaemon, applyLaunchState, clearLaunchState, emptyToolEnvFiles, computeLaunchState, STATE_DIR } = await import('../state.mjs');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// A machine where the codex shim routes through `stateDir` and a daemon is running.
function machine(stateDir) {
  const home = fs.mkdtempSync(path.join(root, 'm-'));
  const codexHome = path.join(home, '.codex');
  const bin = path.join(codexHome, 'packages', 'app-server-daemon', 'current', 'bin', 'codex');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '');
  fs.mkdirSync(path.join(codexHome, 'app-server-control'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'app-server-control', 'app-server-control.sock'), '');
  fs.mkdirSync(path.join(home, '.llm-switcher', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.llm-switcher', 'bin', 'codex'), `#!/usr/bin/env bash\nSWITCHER_DIR="${stateDir}"\n`);
  const calls = [];
  const spawnFn = (cmd, args, opts) => { calls.push({ cmd, args, env: opts.env }); return { unref() {}, on() {} }; };
  return { home, codexHome, bin, calls, spawnFn };
}

const ROUTE = [['HTTPS_PROXY', 'http://127.0.0.1:3457'], ['https_proxy', 'http://127.0.0.1:3457'],
  ['NO_PROXY', '127.0.0.1,localhost'], ['no_proxy', '127.0.0.1,localhost'], ['CODEX_CA_CERTIFICATE', '/ca.pem']];

test('a route change restarts the running daemon with the new Codex variables', () => {
  const m = machine('/switcher/state');
  const r = restartCodexDaemon(ROUTE, { home: m.home, codexHome: m.codexHome, stateDir: '/switcher/state', spawnFn: m.spawnFn, baseEnv: { PATH: '/bin' } });
  assert.equal(r.restarted, true);
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].cmd, m.bin);
  assert.deepEqual(m.calls[0].args, ['app-server', 'daemon', 'restart']);
  assert.equal(m.calls[0].env.HTTPS_PROXY, 'http://127.0.0.1:3457');
  assert.equal(m.calls[0].env.PATH, '/bin');
});

// Codex reads this path when it builds its TLS client and cannot start without it, and its daemon
// keeps the environment it started with. A path that is not on disk therefore does not route Codex,
// it takes Codex down, and the daemon then fails its own update with "Failed to read CA certificate
// file" -- which is what a caller sees as a daemon error while using Codex.
test('a CA that is not on disk is never handed to Codex', () => {
  const m = machine('/switcher/state');
  restartCodexDaemon(ROUTE, { home: m.home, codexHome: m.codexHome, stateDir: '/switcher/state', spawnFn: m.spawnFn, baseEnv: { PATH: '/bin' } });
  assert.equal(m.calls[0].env.CODEX_CA_CERTIFICATE, undefined,
    'a CA the switcher never built must not reach the daemon');
});

test('a CA that is on disk is passed through, so the interceptor still works', () => {
  const m = machine('/switcher/state');
  const ca = path.join(m.home, 'certs', 'ca.pem');
  fs.mkdirSync(path.dirname(ca), { recursive: true });
  fs.writeFileSync(ca, '-----BEGIN CERTIFICATE-----\n');
  restartCodexDaemon([...ROUTE.filter(([k]) => k !== 'CODEX_CA_CERTIFICATE'), ['CODEX_CA_CERTIFICATE', ca]],
    { home: m.home, codexHome: m.codexHome, stateDir: '/switcher/state', spawnFn: m.spawnFn, baseEnv: { PATH: '/bin' }, ca });
  assert.equal(m.calls[0].env.CODEX_CA_CERTIFICATE, ca, 'a CA that exists is the whole point of the route');
});

// The route a restart hands over is the last word: the pairs win, so a CA in them reaches the daemon
// whatever the environment already held. This is the path that ends in a dead daemon.
test('the route written into env-codex carries the CA only when it exists', () => {
  const st = computeLaunchState({ activeProfiles: { codex: 'p' }, profiles: { p: { tool: 'codex', baseURL: 'http://x/v1', apiKey: 'k' } } }, 3456);
  const withCa = st.envCodex.find(([k]) => k === 'CODEX_CA_CERTIFICATE');
  assert.ok(!withCa || fs.existsSync(withCa[1]),
    `env-codex points Codex at ${withCa ? withCa[1] : 'nothing'}; a missing CA stops Codex entirely`);
});

test('switching Codex off restarts the daemon without the switcher variables, and keeps the user\'s own proxy', () => {
  const m = machine('/switcher/state');
  const baseEnv = { HTTPS_PROXY: 'http://127.0.0.1:3457', https_proxy: 'http://proxy.corp:8080', CODEX_CA_CERTIFICATE: '/ca.pem', NO_PROXY: '127.0.0.1,localhost' };
  restartCodexDaemon([], { home: m.home, codexHome: m.codexHome, stateDir: '/switcher/state', spawnFn: m.spawnFn, baseEnv, ca: '/ca.pem' });
  const env = m.calls[0].env;
  assert.equal(env.HTTPS_PROXY, undefined, 'the loopback interceptor is removed');
  assert.equal(env.CODEX_CA_CERTIFICATE, undefined, 'the switcher CA is removed');
  assert.equal(env.https_proxy, 'http://proxy.corp:8080', 'a proxy the user set is kept');
});

test('no restart when the codex shim routes through another state dir, or no daemon runs', () => {
  const other = machine('/another/install');
  assert.equal(restartCodexDaemon(ROUTE, { home: other.home, codexHome: other.codexHome, stateDir: '/switcher/state', spawnFn: other.spawnFn }).restarted, false);
  assert.equal(other.calls.length, 0);

  const idle = machine('/switcher/state');
  fs.rmSync(path.join(idle.codexHome, 'app-server-control', 'app-server-control.sock'));
  assert.equal(restartCodexDaemon(ROUTE, { home: idle.home, codexHome: idle.codexHome, stateDir: '/switcher/state', spawnFn: idle.spawnFn }).restarted, false);
  assert.equal(idle.calls.length, 0, 'a daemon that does not run is not started');
});

test('applyLaunchState reports a Codex route change only when env-codex changes', () => {
  assert.ok(STATE_DIR.startsWith(root), 'the test writes only its own launch files');
  const cfg = {
    port: 3456, blindfold: { port: 3457 }, activeProfiles: { claude: null, codex: 'cx' },
    profiles: { cx: { name: 'Cx', mode: 'convert', tool: 'codex', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { main: 'm' } } }
  };
  assert.equal(applyLaunchState(cfg, 3456).codexRouteChanged, true, 'first activation');
  assert.equal(applyLaunchState(cfg, 3456).codexRouteChanged, false, 'same route again');
  assert.equal(applyLaunchState({ ...cfg, activeProfiles: { claude: null, codex: null } }, 3456).codexRouteChanged, true, 'switched off');
});

test('switch off, for all tools or for Codex alone, also reports the Codex route change', () => {
  const cfg = {
    port: 3456, blindfold: { port: 3457 }, activeProfiles: { claude: null, codex: 'cx' },
    profiles: { cx: { name: 'Cx', mode: 'convert', tool: 'codex', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { main: 'm' } } }
  };
  applyLaunchState(cfg, 3456);
  assert.equal(clearLaunchState(3456).codexRouteChanged, true);
  assert.equal(clearLaunchState(3456).codexRouteChanged, false, 'already off');
  applyLaunchState(cfg, 3456);
  assert.equal(emptyToolEnvFiles('codex').codexRouteChanged, true);
  assert.equal(emptyToolEnvFiles('claude').codexRouteChanged, false);
});
