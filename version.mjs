// The running version, and whether npm has a newer one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const CURRENT_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
})();

const REGISTRY_URL = 'https://registry.npmjs.org/llm-switcher/latest';
const CACHE_FILE = 'version-check.json';
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? ''));
  return m ? m.slice(1).map(Number) : null;
};

/** True only for a release that is newer. A prerelease or an unparseable version is never an update. */
export function isNewer(latest, current) {
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// A git checkout updates with git; an npm install with npm.
const updateCommand = () => (fs.existsSync(path.join(ROOT, '.git')) ? `git -C "${ROOT}" pull` : 'npm install -g llm-switcher@latest');

/**
 * Asks the registry at most once per 12 hours; a failed ask also waits, so an offline machine is not
 * slowed on every call. Never throws: without an answer there is simply no notice.
 */
export async function checkForUpdate({ stateDir, url = process.env.LLM_SWITCHER_REGISTRY_URL || REGISTRY_URL } = {}) {
  const cacheFile = stateDir ? path.join(stateDir, CACHE_FILE) : null;
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}

  let latest = cache?.latest ?? null;
  if (!cache || !(Date.now() - (cache.checkedAt || 0) < MAX_AGE_MS)) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { accept: 'application/json' } });
      if (r.ok) {
        const v = (await r.json())?.version;
        if (parse(v)) latest = v;
      }
    } catch {}
    try { if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify({ checkedAt: Date.now(), latest })); } catch {}
  }
  return { current: CURRENT_VERSION, latest, updateAvailable: isNewer(latest, CURRENT_VERSION), updateCommand: updateCommand() };
}
