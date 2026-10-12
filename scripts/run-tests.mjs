// Runs only tests/**/*.test.mjs. A bare `node --test` also collects test files from git-ignored
// folders (an old copy in temp/), and Node 18 and 20 do not expand a glob argument.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function holdsFile(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || holdsFile(path.join(dir, e.name))) return true;
  }
  return false;
}

// npm makes node-compile-cache in TMPDIR as it starts and writes files only as it exits, so an empty cache is taken
// as made by this run. Not exact: the empty cache of another npm run still in progress goes too, which costs that
// run a rebuild only. npm makes the directory before this script starts, so no earlier existence check can tell.
export function compileCacheIsNew(dir, env = process.env) {
  if (!env.npm_lifecycle_event) return false;
  try {
    return !holdsFile(dir);
  } catch {
    return false; // missing or unreadable: nothing of ours to remove
  }
}

export function removeQuietly(dir, rm = fs.rmSync) {
  try {
    rm(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`run-tests: could not remove ${dir}: ${err.message}`);
  }
}

function main() {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.test.mjs')) files.push(path.relative(root, p));
    }
  })(path.join(root, 'tests'));

  // A version check must never reach the real npm registry.
  const env = { ...process.env, LLM_SWITCHER_REGISTRY_URL: 'http://127.0.0.1:9/' };
  const compileCache = path.join(os.tmpdir(), 'node-compile-cache');
  const npmMadeCache = compileCacheIsNew(compileCache);

  const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit', env });
  if (npmMadeCache) removeQuietly(compileCache);
  process.exit(r.status ?? 1);
}

// node runs a symlinked script from its real path, so only real paths compare. A path that cannot be
// resolved is not this script: returning false keeps an import by the test from running the suite.
export function isMainModule(argv1, selfUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(fileURLToPath(selfUrl));
  } catch {
    return false;
  }
}

// Imported by its test, run by `npm test`.
if (isMainModule(process.argv[1])) main();
