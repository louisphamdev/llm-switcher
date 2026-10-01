// Brings this install to the newest release: a git checkout pulls fast-forward only, an npm install
// asks the registry and installs that exact version. Restarting the gateway is the caller's job.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isNewer } from './version.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_URL = 'https://registry.npmjs.org/llm-switcher/latest';
const execFileAsync = promisify(execFile);

// Async on purpose: the gateway runs this in-process, and a blocking install would stall every request.
async function runCommand(cmd, args, opts = {}) {
  const { stdout } = await execFileAsync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    ...opts,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env }
  });
  return stdout;
}

function readVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

const failure = (what, err) => new Error(`${what} failed: ${String(err.stderr || err.message).trim()}`);
const noUpdate = (from, reason) => ({ updated: false, from, to: from, reason });

async function updateCheckout(root, run, log) {
  const git = (...args) => run('git', ['-C', root, ...args]);
  const from = readVersion(root);
  // A pull into edited files would mix someone's work in progress with the release.
  if ((await git('status', '--porcelain', '--untracked-files=no')).trim()) {
    return noUpdate(from, 'The checkout has local changes. Commit or stash them, then update.');
  }
  try {
    await git('rev-parse', '--abbrev-ref', '@{u}');
  } catch {
    return noUpdate(from, 'The current branch has no upstream branch to update from.');
  }
  log('Fetching the upstream branch...');
  try { await git('fetch', '--quiet'); } catch (err) { throw failure('git fetch', err); }
  const behind = Number((await git('rev-list', '--count', 'HEAD..@{u}')).trim());
  if (!behind) return noUpdate(from, `Already on the latest version (v${from}).`);
  log(`Pulling ${behind} new commit(s)...`);
  // --ff-only: a branch with local commits fails here instead of getting a merge commit.
  try { await git('pull', '--ff-only', '--quiet'); } catch (err) { throw failure('git pull --ff-only', err); }
  return { updated: true, from, to: readVersion(root), reason: `Pulled ${behind} commit(s).` };
}

async function updateNpmInstall(root, run, log, registryUrl) {
  const from = readVersion(root);
  let latest = null;
  try {
    const r = await fetch(registryUrl, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (r.ok) latest = (await r.json())?.version ?? null;
  } catch {}
  if (!latest) return noUpdate(from, 'Could not reach the npm registry.');
  if (!isNewer(latest, from)) return noUpdate(from, `Already on the latest version (v${from}).`);
  log(`Installing llm-switcher@${latest} from npm...`);
  // npm.cmd is a batch file, and Node runs one only through a shell. The cwd is the home directory,
  // because Windows cannot replace a package directory that a process holds as its cwd.
  const win = process.platform === 'win32';
  try {
    await run(win ? 'npm.cmd' : 'npm', ['install', '-g', `llm-switcher@${latest}`], { shell: win, cwd: os.homedir(), timeout: 300000 });
  } catch (err) {
    throw failure('npm install', err);
  }
  const to = readVersion(root);
  // npm can install into another prefix than the one this gateway runs from; then nothing changed here.
  if (to === from) return noUpdate(from, `npm installed v${latest}, but not into ${root}.`);
  return { updated: true, from, to, reason: `Installed v${to} from npm.` };
}

/** Returns { updated, from, to, reason }. Throws only when an update started and failed. */
export async function applyUpdate({
  root = ROOT,
  run = runCommand,
  logger = () => {},
  registryUrl = process.env.LLM_SWITCHER_REGISTRY_URL || REGISTRY_URL
} = {}) {
  return fs.existsSync(path.join(root, '.git'))
    ? updateCheckout(root, run, logger)
    : updateNpmInstall(root, run, logger, registryUrl);
}
