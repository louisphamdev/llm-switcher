// Brings this install to the newest release. A release is published to npm, so npm is what is asked
// first: `npm install -g llm-switcher@<version>` for the exact version the registry names. A git
// checkout is the one install npm cannot serve, because npm writes into the global prefix while the
// running code is the checkout itself, so the checkout is asked second and only then. Restarting
// the gateway is the caller's job.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isNewer, CURRENT_VERSION } from './version.mjs';

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

// launchd and systemd --user give the gateway a short PATH without a Homebrew or nvm npm. The npm
// next to the running node is the right one, and its launcher finds node on the same PATH.
function envWithNodeFirst(env = process.env) {
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  return { ...env, [key]: [path.dirname(process.execPath), env[key]].filter(Boolean).join(path.delimiter) };
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
  // npm.cmd is a batch file, and Node runs one only through cmd.exe. The cwd is the home directory,
  // because Windows cannot replace a package directory that a process holds as its cwd.
  const npmArgs = ['install', '-g', `llm-switcher@${latest}`];
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...npmArgs]] : ['npm', npmArgs];
  try {
    await run(cmd, args, { cwd: os.homedir(), timeout: 300000, env: envWithNodeFirst() });
  } catch (err) {
    throw failure('npm install', err);
  }
  const to = readVersion(root);
  // npm installs into the global prefix. When this gateway runs from a checkout that is a different
  // directory, so the registry can name a release this code never receives; `elsewhere` says so.
  if (to === from) return { ...noUpdate(from, `npm installed v${latest}, but not into ${root}.`), elsewhere: latest };
  return { updated: true, from, to, reason: `Installed v${to} from npm.` };
}

/** Returns { updated, from, to, reason }. Throws only when an update started and failed. */
export async function applyUpdate({
  root = ROOT,
  run = runCommand,
  logger = () => {},
  registryUrl = process.env.LLM_SWITCHER_REGISTRY_URL || REGISTRY_URL,
  running = CURRENT_VERSION
} = {}) {
  // npm writes into the global prefix, so a checkout is the one install it cannot serve: the running
  // code is this directory, not the prefix. The registry is still asked, because the release on npm
  // is the release every other install receives, but for a checkout a failed install is not the end
  // of the update -- the checkout is the thing that can move, so it is asked next.
  const checkout = fs.existsSync(path.join(root, '.git'));
  let registry;
  try {
    registry = await updateNpmInstall(root, run, logger, registryUrl);
  } catch (err) {
    if (!checkout) throw err;
    logger(`npm could not install it here: ${err.message}`);
    registry = { ...noUpdate(readVersion(root), `npm could not install it here: ${err.message}`), elsewhere: true };
  }
  let r = registry;
  if (!r.updated && checkout) {
    r = await updateCheckout(root, run, logger);
    // Neither could deliver it, and npm held a release this directory cannot take: both facts, because
    // "already the latest version" on its own would hide the one version the reader does not have.
    if (!r.updated && registry.elsewhere) r = { ...r, reason: `${registry.reason} ${r.reason}` };
  }
  // Newer code already on disk (an install outside the gateway) is an update for the
  // running process: without the restart it keeps the old code and the old version forever.
  const onDisk = readVersion(root);
  if (!r.updated && isNewer(onDisk, running)) {
    return { updated: true, from: running, to: onDisk, reason: `v${onDisk} is on disk, but the gateway ran v${running}.` };
  }
  return r;
}
