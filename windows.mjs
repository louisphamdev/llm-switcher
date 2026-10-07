// The real window of every model a profile serves.
//
// A coding tool sizes a session, and its auto-compact point, from the window its own catalog
// gives it. So the gateway reports what the model really has instead of a number someone picked
// in a checkbox. Two numbers come out of a provider's list:
//
//   context  the whole window the model accepts
//   compact  the window to compress at, which a Codex model publishes as `context_window`
//            next to `max_context_window` (272K against 872K)
//
// A model whose list gives only one window has no compact window, and a provider that lists no
// limits at all leaves both unknown: the caller then falls back to its own template rather than
// inventing a number.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ONE_HOUR_MS = 60 * 60 * 1000;
const DEFAULT_TTL_MS = ONE_HOUR_MS;
const FETCH_TIMEOUT_MS = 15000;

const n = v => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

// One entry of a provider's list -> the two windows, or null when it names none.
export function parseModelWindows(m) {
  if (!m || typeof m !== 'object') return null;
  const top = m.top_provider && typeof m.top_provider === 'object' ? m.top_provider : {};
  const context = n(m.max_context_window) || n(m.context_length) || n(top.context_length) || n(m.context_window);
  // intact serves the threshold under its own name; a Codex-shaped list carries it as the
  // smaller of the two windows it publishes.
  const compact = n(m.compact_window) || n(m.compaction_threshold)
    || (context && n(m.context_window) && n(m.context_window) < context ? n(m.context_window) : 0);
  if (!context && !compact) return null;
  return { context, compact };
}

// The list as it names the models, so a caller can look one up by the id a profile maps.
export function parseModelList(data) {
  const entries = Array.isArray(data?.data) ? data.data
    : Array.isArray(data) ? data
    : Array.isArray(data?.models) ? data.models
    : [];
  const out = {};
  for (const m of entries) {
    const id = String(typeof m === 'string' ? m : (m?.id || m?.name || '')).replace(/^models\//, '');
    if (!id) continue;
    const w = parseModelWindows(m);
    if (w) out[id] = w;
  }
  return out;
}

/**
 * Reads a provider's model list for its windows. Returns {} on any failure: a profile whose
 * upstream cannot be reached keeps the last answer, never a wrong window.
 */
export async function fetchProfileWindows(baseURL, apiKey, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const base = String(baseURL || '').replace(/\/+$/, '');
  if (!base) return {};
  try {
    const headers = { accept: 'application/json' };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
      headers['x-api-key'] = apiKey;
    }
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return {};
    return parseModelList(await res.json());
  } catch {
    return {};
  }
}

/**
 * The windows of a profile's models, from the cache when it is fresh and from the profile's own
 * list when it is not. A failed read keeps the stale answer, because an old window only sizes a
 * session slightly wrong, while an empty one would hand the tool a template window it may not
 * have. Never throws.
 */
export async function resolveProfileWindows(stateDir, cacheKey, baseURL, apiKey, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const cache = readWindowsCache(stateDir);
  const entry = cache[cacheKey] || {};
  const fresh = entry.at && now - entry.at < ttlMs;
  if (fresh) return entry.models || {};
  const models = await fetchProfileWindows(baseURL, apiKey);
  if (Object.keys(models).length) {
    cache[cacheKey] = { at: now, baseURL, models };
    writeWindowsCache(stateDir, cache);
    return models;
  }
  return entry.models || {};
}

export function windowsCachePath(stateDir) {
  return path.join(stateDir, 'model-windows.json');
}

export function readWindowsCache(stateDir) {
  try {
    const d = JSON.parse(fs.readFileSync(windowsCachePath(stateDir), 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}

export function writeWindowsCache(stateDir, cache) {
  const p = windowsCachePath(stateDir);
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return false;
  }
}

/**
 * The windows the Codex CLI itself cached for its signed-in account. It is the fallback for a
 * profile that lists no limits: those numbers came from the provider the CLI uses, so they are
 * better than the template and never a guess. Returns {} when the tool keeps no list.
 */
export function readLocalCodexWindows(sources = {}) {
  const codexHome = sources.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    const d = JSON.parse(fs.readFileSync(path.join(codexHome, 'models_cache.json'), 'utf8'));
    const models = Array.isArray(d?.models) ? d.models : [];
    const out = {};
    for (const m of models) {
      const id = m && typeof m.slug === 'string' ? m.slug : '';
      const context = n(m?.max_context_window) || n(m?.context_window);
      const compact = context && n(m.context_window) < context ? n(m.context_window) : 0;
      if (id && context) out[id] = { context, compact };
    }
    return out;
  } catch {
    return {};
  }
}
