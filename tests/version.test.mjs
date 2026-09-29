// The running version and the update notice. The registry is a local server, never npm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { CURRENT_VERSION, isNewer, checkForUpdate } from '../version.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

async function registry(handler) {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; handler(req, res); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/llm-switcher/latest`, hits: () => hits, close: () => server.close() };
}
const tmpState = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lsw-version-'));

test('the current version is the one in package.json', () => {
  assert.equal(CURRENT_VERSION, pkg.version);
});

test('isNewer compares numerically, and a prerelease is not an update', () => {
  assert.equal(isNewer('1.2.10', '1.2.9'), true);
  assert.equal(isNewer('2.0.0', '1.9.9'), true);
  assert.equal(isNewer('1.2.2', '1.2.2'), false);
  assert.equal(isNewer('1.2.1', '1.2.2'), false);
  assert.equal(isNewer('1.3.0-beta.1', '1.2.2'), false);
  assert.equal(isNewer('garbage', '1.2.2'), false);
  assert.equal(isNewer(null, '1.2.2'), false);
});

test('a newer registry version is reported with the update command, and cached', async () => {
  const reg = await registry((req, res) => res.end(JSON.stringify({ version: '99.0.0' })));
  const stateDir = tmpState();
  try {
    const r = await checkForUpdate({ stateDir, url: reg.url });
    assert.equal(r.current, CURRENT_VERSION);
    assert.equal(r.latest, '99.0.0');
    assert.equal(r.updateAvailable, true);
    assert.match(r.updateCommand, /^(npm install -g llm-switcher@latest|git -C ".+" pull)$/);
    await checkForUpdate({ stateDir, url: reg.url });
    assert.equal(reg.hits(), 1, 'the second check reads the cache');
  } finally {
    reg.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the same version is no update; a stale cache asks the registry again', async () => {
  const reg = await registry((req, res) => res.end(JSON.stringify({ version: CURRENT_VERSION })));
  const stateDir = tmpState();
  try {
    fs.writeFileSync(path.join(stateDir, 'version-check.json'), JSON.stringify({ checkedAt: 0, latest: '99.0.0' }));
    const r = await checkForUpdate({ stateDir, url: reg.url });
    assert.equal(reg.hits(), 1);
    assert.equal(r.updateAvailable, false);
    assert.equal(r.latest, CURRENT_VERSION);
  } finally {
    reg.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an unreachable or broken registry gives no notice and never throws', async () => {
  const reg = await registry((req, res) => { res.statusCode = 500; res.end('down'); });
  const stateDir = tmpState();
  try {
    const r = await checkForUpdate({ stateDir, url: reg.url });
    assert.deepEqual([r.current, r.latest, r.updateAvailable], [CURRENT_VERSION, null, false]);
    const closed = await checkForUpdate({ stateDir: tmpState(), url: 'http://127.0.0.1:9/x' });
    assert.equal(closed.updateAvailable, false);
  } finally {
    reg.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
