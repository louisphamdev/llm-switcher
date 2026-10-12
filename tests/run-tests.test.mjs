import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileCacheIsNew, removeQuietly, isMainModule } from '../scripts/run-tests.mjs';

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lsw-runtests-'));
  tmpDirs.push(d);
  return d;
};
const npm = { npm_lifecycle_event: 'test' };

// npm writes its compile cache only when it exits, so the cache it made for this run has no file yet.
test('npm test removes only a compile cache that npm made for this run', () => {
  const made = path.join(tmpDir(), 'node-compile-cache');
  fs.mkdirSync(path.join(made, 'v26-x64-1000'), { recursive: true });
  assert.equal(compileCacheIsNew(made, npm), true, 'empty: made at the start of this run');

  const kept = path.join(tmpDir(), 'node-compile-cache');
  fs.mkdirSync(path.join(kept, 'v26-x64-1000'), { recursive: true });
  fs.writeFileSync(path.join(kept, 'v26-x64-1000', '0c92995d'), 'x');
  assert.equal(compileCacheIsNew(kept, npm), false, 'a file in it: it was there before this run, however new');

  assert.equal(compileCacheIsNew(made, {}), false, 'run without npm: the cache is not ours');
  assert.equal(compileCacheIsNew(path.join(tmpDir(), 'none'), npm), false, 'no cache, nothing to remove');
});

test('a failed cleanup never throws, so the exit status of the tests stays', () => {
  const dir = tmpDir();
  assert.doesNotThrow(() => removeQuietly(dir, () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }));
  removeQuietly(dir);
  assert.equal(fs.existsSync(dir), false);
});

// node resolves a symlinked script to its real path, so the guard must compare real paths or the tests never run.
test('the main-module guard sees the script through a symlink, and a false guard only returns false', () => {
  const script = fileURLToPath(new URL('../scripts/run-tests.mjs', import.meta.url));
  const link = path.join(tmpDir(), 'run-tests-link.mjs');
  fs.symlinkSync(script, link);
  assert.equal(isMainModule(script), true);
  assert.equal(isMainModule(link), true, 'an absolute symlinked path is the script');
  assert.equal(isMainModule(fileURLToPath(import.meta.url)), false, 'another file is not');
  assert.equal(isMainModule(path.join(tmpDir(), 'missing.mjs')), false, 'a path that does not exist is not');
  assert.equal(isMainModule(undefined), false);
});
