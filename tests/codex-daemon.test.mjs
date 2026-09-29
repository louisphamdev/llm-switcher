// A Codex profile that is switched on restarts the Codex app-server daemon, so the daemon routes
// with the new launch environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { restartCodexDaemonOnSwitch } from '../state.mjs';

const cfg = (codex) => ({
  port: 4000,
  blindfold: { port: 4457 },
  activeProfiles: { claude: null, codex },
  profiles: {
    a: { name: 'A', mode: 'convert', tool: 'codex', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { main: 'm' } },
    b: { name: 'B', mode: 'convert', tool: 'codex', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', defaultModels: { main: 'm' } }
  }
});

// A fake `codex` that records its arguments and the routing variables it was started with.
function withFakeCodex(fn, { exitCode = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexdaemon-'));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'codex'),
    `#!/bin/sh\necho "$* | $HTTPS_PROXY | $CODEX_CA_CERTIFICATE" >> '${log}'\nexit ${exitCode}\n`, { mode: 0o755 });
  const old = process.env.LLM_SWITCHER_CODEX_BIN;
  process.env.LLM_SWITCHER_CODEX_BIN = path.join(dir, 'codex');
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return Promise.resolve(fn(calls)).finally(() => {
    if (old === undefined) delete process.env.LLM_SWITCHER_CODEX_BIN;
    else process.env.LLM_SWITCHER_CODEX_BIN = old;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('switching a Codex profile on restarts the app-server daemon with the Codex route', { skip: process.platform === 'win32' && 'posix fake binary' }, () =>
  withFakeCodex(async (calls) => {
    const r = await restartCodexDaemonOnSwitch(cfg(null), cfg('a'), 4000);
    assert.deepEqual(r, { ok: true });
    const [line, ...rest] = calls();
    assert.equal(rest.length, 0, 'one restart');
    const [args, proxy, ca] = line.split(' | ');
    assert.equal(args, 'app-server daemon restart');
    assert.equal(proxy, 'http://127.0.0.1:4457', 'the daemon starts behind the interceptor');
    assert.match(ca, /ca\.pem$/);
  }));

test('switching Codex to another profile also restarts the daemon', { skip: process.platform === 'win32' && 'posix fake binary' }, () =>
  withFakeCodex(async (calls) => {
    assert.deepEqual(await restartCodexDaemonOnSwitch(cfg('a'), cfg('b'), 4000), { ok: true });
    assert.equal(calls().length, 1);
  }));

test('no restart when the Codex profile did not change or was switched off', { skip: process.platform === 'win32' && 'posix fake binary' }, () =>
  withFakeCodex(async (calls) => {
    assert.equal(await restartCodexDaemonOnSwitch(cfg('a'), cfg('a'), 4000), null);
    assert.equal(await restartCodexDaemonOnSwitch(cfg('a'), cfg(null), 4000), null);
    assert.equal(await restartCodexDaemonOnSwitch(null, cfg(null), 4000), null);
    assert.deepEqual(calls(), []);
  }));

test('a failed restart is reported, never thrown', { skip: process.platform === 'win32' && 'posix fake binary' }, async () => {
  await withFakeCodex(async () => {
    const r = await restartCodexDaemonOnSwitch(cfg(null), cfg('a'), 4000);
    assert.equal(r.ok, false);
    assert.match(r.error, /codex app-server daemon restart/);
  }, { exitCode: 3 });

  const old = process.env.LLM_SWITCHER_CODEX_BIN;
  process.env.LLM_SWITCHER_CODEX_BIN = path.join(os.tmpdir(), 'llm-switcher-no-codex');
  try {
    const r = await restartCodexDaemonOnSwitch(cfg(null), cfg('a'), 4000);
    assert.equal(r.ok, false, 'Codex is not installed');
  } finally {
    if (old === undefined) delete process.env.LLM_SWITCHER_CODEX_BIN;
    else process.env.LLM_SWITCHER_CODEX_BIN = old;
  }
});
