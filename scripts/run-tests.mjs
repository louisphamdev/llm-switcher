// Runs only tests/**/*.test.mjs. A bare `node --test` also collects test files from git-ignored
// folders (an old copy in temp/), and Node 18 and 20 do not expand a glob argument.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
// `npm test` itself, not a test, makes node-compile-cache in TMPDIR as it starts. Only a cache born
// in the seconds before this run is removed afterwards; one that was there before stays.
const compileCache = path.join(os.tmpdir(), 'node-compile-cache');
const launchedAt = Date.now() - process.uptime() * 1000;
let npmMadeCache = false;
try {
  const born = fs.statSync(compileCache).birthtimeMs;
  npmMadeCache = Boolean(process.env.npm_lifecycle_event) && born > 0 && born >= launchedAt - 10_000;
} catch { /* no cache: nothing to remove */ }

const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit', env });
if (npmMadeCache) fs.rmSync(compileCache, { recursive: true, force: true });
process.exit(r.status ?? 1);
