// The browser tests start a gateway, a stand-in interceptor and a Chromium, and the gateway can
// start a real interceptor of its own, detached. Whatever ends the run, none of them and none of
// their temp dirs may outlive it. Each case runs in a child process with a private TMPDIR, so
// "nothing left" is a check on that one directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { skipReason } from './cdp.mjs';
import { pidsNaming } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const url = (f) => JSON.stringify(pathToFileURL(path.join(HERE, f)).href);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const skip = process.platform === 'win32' ? 'lists processes with ps' : skipReason();

// Starts the fixture and a browser, then moves the interceptor to a new port so the gateway starts
// a real one. `awaitStart` false: the script does not wait for the gateway to record it.
const PRELUDE = (awaitStart) => `
  import { startDashboardFixture } from ${url('dashboard-fixture.mjs')};
  import { launchBrowser } from ${url('cdp.mjs')};
  import { pidsNaming } from ${url('helpers.mjs')};
  import net from 'node:net';
  const free = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
  const fx = await startDashboardFixture();
  const browser = await launchBrowser();
  await browser.newPage();
  const cfg = fx.config();
  cfg.blindfold.port = await free();
  fx.writeConfig(cfg);
  const sync = fx.api('/api/blindfold/sync', {});
  ${awaitStart ? `const r = await sync; if (r.status !== 200) throw new Error('no interceptor: ' + JSON.stringify(r.json));` : 'sync.catch(() => {});'}
  for (let i = 0; i < 200 && !pidsNaming(fx.dir).length; i++) await new Promise(r => setTimeout(r, 25));
  if (!pidsNaming(fx.dir).length) throw new Error('the gateway started no interceptor');
`;

async function inPrivateTmp(t, script, act) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsw-teardown-'));
  t.after(() => {
    // A red run must not leave what it found behind.
    for (const pid of pidsNaming(tmp)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise(r => child.once('exit', r));
  await act(child, () => out);
  await Promise.race([exited, sleep(30000)]);
  // A detached process may take a moment to die after the signal.
  let left = pidsNaming(tmp);
  for (let i = 0; i < 50 && left.length; i++) { await sleep(100); left = pidsNaming(tmp); }
  return { left, files: fs.readdirSync(tmp), out: () => out };
}

test('stop() and close() remove an interceptor the gateway had not recorded yet, and every temp dir', { skip, timeout: 90000 }, async (t) => {
  const r = await inPrivateTmp(t, `${PRELUDE(false)}
    await fx.stop();
    await browser.close();
    console.log('DONE');
  `, async () => {});
  assert.match(r.out(), /DONE/, r.out());
  assert.deepEqual(r.left, [], 'no process names the temp dir');
  assert.deepEqual(r.files, [], 'no temp dir is left');
});

test('a test process stopped by SIGTERM still stops its gateway, interceptor and browser', { skip, timeout: 90000 }, async (t) => {
  const r = await inPrivateTmp(t, `${PRELUDE(true)}
    console.log('READY');
    setInterval(() => {}, 1000);
  `, async (child, out) => {
    for (let i = 0; i < 600 && !/READY/.test(out()) && child.exitCode === null; i++) await sleep(100);
    assert.match(out(), /READY/, out());
    child.kill('SIGTERM');
  });
  assert.deepEqual(r.left, [], 'no process names the temp dir');
  assert.deepEqual(r.files, [], 'no temp dir is left');
});
