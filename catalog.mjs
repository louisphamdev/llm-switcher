// ============================================================
// catalog.mjs — dynamic model catalog discovery and slot mapping (Claude Code & Codex)
//
// Automatically fetches official model lists from Anthropic / OpenAI or custom
// upstream endpoints to ensure mapping tables never go stale when providers release
// new model variants (e.g. gpt-6-sol, claude-opus-5-5).
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OFFICIAL_MODEL_URLS = {
  claude: 'https://api.anthropic.com/v1/models',
  codex: 'https://api.openai.com/v1/models'
};

export const BASELINE_MODELS = {
  claude: {
    opus: ['claude-opus-5-5', 'claude-opus-4-6', 'claude-3-opus-20240229'],
    sonnet: ['claude-sonnet-4', 'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022'],
    haiku: ['claude-haiku-4', 'claude-3-5-haiku-20241022'],
    fable: ['claude-fable-4']
  },
  codex: {
    main: ['gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.2', 'o3', 'gpt-4o'],
    review: ['gpt-6-terra', 'gpt-5.6-terra', 'o3-mini'],
    subagent: ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.3-codex', 'gpt-5.2-codex']
  }
};

/** Classifies a Claude model name into its corresponding tier slot */
export function classifyClaudeTier(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (m.includes('fable')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  return 'sonnet';
}

/** Classifies a Codex model name into its corresponding role slot */
export function classifyCodexRole(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (m.includes('terra') || m.includes('review')) return 'review';
  if (m.includes('luna') || m.includes('subagent')) return 'subagent';
  return 'main';
}

function catalogCachePath(stateDir) {
  return path.join(stateDir, 'catalog-cache.json');
}

/** Loads cached catalog from disk, falling back to built-in baseline models */
export function loadCatalogCache(stateDir) {
  const p = catalogCachePath(stateDir);
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (data && typeof data === 'object') return data;
    }
  } catch {}
  return {
    updatedAt: 0,
    claude: {
      models: Object.entries(BASELINE_MODELS.claude).flatMap(([tier, ids]) => ids.map(id => ({ id, tier })))
    },
    codex: {
      models: Object.entries(BASELINE_MODELS.codex).flatMap(([role, ids]) => ids.map(id => ({ id, role })))
    }
  };
}

function defaultSources() {
  return {
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  };
}

/**
 * Reads the model list that the tool itself keeps on disk for the signed-in account, so no key and
 * no network call is needed. Codex writes models_cache.json; Claude Code writes cache/model-catalog.
 * Returns null when the tool has no list.
 */
export function readLocalToolModels(tool, sources = defaultSources()) {
  try {
    if (tool === 'codex') {
      const d = JSON.parse(fs.readFileSync(path.join(sources.codexHome, 'models_cache.json'), 'utf8'));
      const models = (Array.isArray(d?.models) ? d.models : [])
        .filter(m => m && typeof m.slug === 'string' && m.slug)
        .map(m => ({ id: m.slug, role: classifyCodexRole(m.slug), ...(Number.isInteger(m.context_window) ? { contextWindow: m.context_window } : {}) }));
      return models.length ? { models, version: String(d.client_version || '') } : null;
    }
    if (tool === 'claude') {
      // One file per account or surface; the newest fetch wins.
      const dir = path.join(sources.claudeDir, 'cache', 'model-catalog');
      let newest = null;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          const list = d?.catalog?.config?.models;
          if (Array.isArray(list) && list.length && (!newest || (d.fetchedAt || 0) > newest.fetchedAt)) newest = { fetchedAt: d.fetchedAt || 0, list };
        } catch {}
      }
      const models = (newest?.list || [])
        .filter(m => m && typeof m.id === 'string' && m.id)
        .map(m => ({ id: m.id, display_name: m.name || m.id, tier: classifyClaudeTier(m.id) }));
      return models.length ? { models, version: '' } : null;
    }
  } catch {}
  return null;
}

/**
 * Copies the tools' own lists into the catalog when they changed. A tool can update and rewrite its
 * list without any request through the gateway, so readers of the catalog call this first.
 */
export function syncLocalCatalog(stateDir, sources = defaultSources()) {
  const cache = loadCatalogCache(stateDir);
  let changed = false;
  for (const tool of ['claude', 'codex']) {
    const local = readLocalToolModels(tool, sources);
    if (!local) continue;
    const ids = (cache[tool]?.models || []).map(m => m.id).join('\n');
    if (ids === local.models.map(m => m.id).join('\n') && cache[tool]?.source === 'local') continue;
    cache[tool] = { ...cache[tool], models: local.models, source: 'local' };
    changed = true;
  }
  if (changed) {
    cache.updatedAt = Date.now();
    saveCatalogCache(stateDir, cache);
  }
  return cache;
}

/** Atomically writes the model catalog cache to disk */
export function saveCatalogCache(stateDir, catalog) {
  const p = catalogCachePath(stateDir);
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return false;
  }
}

/**
 * Fetches the latest models for a tool from its official endpoint or a custom URL.
 * Never throws: falls back safely to baseline models if offline or unreachable.
 */
export async function fetchToolModels(tool, { url, apiKey, timeout = 3000 } = {}) {
  const targetUrl = url || OFFICIAL_MODEL_URLS[tool];
  if (!targetUrl) return { ok: false, error: `Unknown tool: ${tool}`, models: [] };

  const headers = {
    'user-agent': 'llm-switcher/catalog',
    'accept': 'application/json'
  };
  if (tool === 'claude') {
    headers['anthropic-version'] = '2023-06-01';
    if (apiKey) headers['x-api-key'] = apiKey;
  } else if (apiKey) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeout)
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, models: [] };
    }
    const json = await res.json();
    const rawList = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];

    if (tool === 'claude') {
      const models = rawList
        .filter(m => m && (m.id || typeof m === 'string'))
        .map(m => {
          const id = typeof m === 'string' ? m : m.id;
          return { id, display_name: m.display_name || id, tier: classifyClaudeTier(id) };
        });
      return { ok: true, models };
    }

    if (tool === 'codex') {
      const models = rawList
        .filter(m => m && (m.id || typeof m === 'string'))
        .map(m => {
          const id = typeof m === 'string' ? m : m.id;
          return { id, role: classifyCodexRole(id) };
        })
        .filter(m => /^(gpt|o\d|codex)/i.test(m.id));
      return { ok: true, models };
    }

    return { ok: true, models: rawList };
  } catch (err) {
    return { ok: false, error: err.message, models: [] };
  }
}

// A profile key is a credential for that profile's baseURL. Send it to the official model list only
// when the profile itself points at the official host, never to a third party.
function officialKey(profile, tool) {
  try {
    if (profile?.apiKey && new URL(profile.baseURL).host === new URL(OFFICIAL_MODEL_URLS[tool]).host) return profile.apiKey;
  } catch {}
  return undefined;
}

/**
 * Refreshes the local catalog cache with models from both official endpoints
 * and saves to the state directory.
 */
export async function refreshCatalog(stateDir, { claudeProfile, codexProfile, sources = defaultSources() } = {}) {
  const cache = loadCatalogCache(stateDir);
  const local = { claude: readLocalToolModels('claude', sources), codex: readLocalToolModels('codex', sources) };

  // A local list is the list of the account itself; the built-in names are guesses and are not added.
  const [claudeRes, codexRes] = await Promise.all([
    local.claude || fetchToolModels('claude', { apiKey: officialKey(claudeProfile, 'claude') }),
    local.codex || fetchToolModels('codex', { apiKey: officialKey(codexProfile, 'codex') })
  ]);
  for (const tool of ['claude', 'codex']) {
    if (local[tool]) cache[tool] = { ...cache[tool], models: local[tool].models, source: 'local' };
  }

  if (!local.claude && claudeRes.ok && claudeRes.models.length > 0) {
    const existing = new Set(claudeRes.models.map(m => m.id));
    // Keep any baseline models that might be absent from the API
    for (const [tier, ids] of Object.entries(BASELINE_MODELS.claude)) {
      for (const id of ids) {
        if (!existing.has(id)) claudeRes.models.push({ id, tier });
      }
    }
    cache.claude = { ...cache.claude, models: claudeRes.models, source: 'official' };
  }

  if (!local.codex && codexRes.ok && codexRes.models.length > 0) {
    const existing = new Set(codexRes.models.map(m => m.id));
    for (const [role, ids] of Object.entries(BASELINE_MODELS.codex)) {
      for (const id of ids) {
        if (!existing.has(id)) codexRes.models.push({ id, role });
      }
    }
    cache.codex = { ...cache.codex, models: codexRes.models, source: 'official' };
  }

  cache.updatedAt = Date.now();
  saveCatalogCache(stateDir, cache);
  return cache;
}

/** Extracts tool version string from client User-Agent or headers */
export function detectToolVersion(headers = {}, expectedTool) {
  const ua = headers['user-agent'] || headers['User-Agent'] || '';
  const first = String(ua || '').split(' ')[0];
  const slash = first.indexOf('/');
  if (slash >= 0) {
    const prefix = first.slice(0, slash).toLowerCase();
    if (prefix.includes('claude') || prefix.includes('codex') || (expectedTool && prefix.includes(expectedTool))) {
      const version = first.slice(slash + 1);
      if (/^\d{1,5}\.\d{1,5}/.test(version)) return version;
    }
  }
  const m = /(?:claude(?:-cli|-code)?|codex(?:-cli)?)[/v\s]+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i.exec(ua);
  return m ? m[1] : '';
}

const refreshingTools = new Set();

/**
 * Version-triggered auto-poll:
 * When a request arrives with a tool version that has no refreshed catalog yet, the catalog is
 * refreshed from the tool's own list on disk, or else from the official list in the background.
 * The version is recorded only after a refresh succeeds, so a failed refresh is tried again.
 */
const RETRY_AFTER_MS = 10 * 60 * 1000;
const failedAttempts = new Map();

export function checkVersionAndRefresh(tool, headers, stateDir, apiKey, sources = defaultSources()) {
  const version = detectToolVersion(headers, tool);
  if (!version) return;

  const cache = loadCatalogCache(stateDir);
  if (version === (cache[tool]?.lastSeenVersion || '')) return;

  const local = readLocalToolModels(tool, sources);
  if (local) {
    cache[tool] = { ...cache[tool], lastSeenVersion: version, models: local.models, source: 'local' };
    cache.updatedAt = Date.now();
    saveCatalogCache(stateDir, cache);
    console.log(`[llm-switcher:catalog] Detected ${tool} ${version} -> model catalog read from the tool (${local.models.length} models)`);
    return;
  }

  // Without a local list every request would call the network again; wait between failed attempts.
  const failed = failedAttempts.get(tool);
  if (failed && failed.version === version && Date.now() - failed.at < RETRY_AFTER_MS) return;
  if (refreshingTools.has(tool)) return;

  refreshingTools.add(tool);
  fetchToolModels(tool, { apiKey })
    .then(res => {
      if (!res.ok || res.models.length === 0) {
        failedAttempts.set(tool, { version, at: Date.now() });
        console.log(`[llm-switcher:catalog] ${tool} ${version}: no local model list, official list failed (${res.error || 'empty'})`);
        return;
      }
      const fresh = loadCatalogCache(stateDir);
      const existing = new Set(res.models.map(m => m.id));
      const baseline = BASELINE_MODELS[tool] || {};
      for (const [, ids] of Object.entries(baseline)) {
        for (const id of ids) {
          if (!existing.has(id)) {
            res.models.push({ id, ...(tool === 'claude' ? { tier: classifyClaudeTier(id) } : { role: classifyCodexRole(id) }) });
          }
        }
      }
      fresh[tool] = { ...fresh[tool], lastSeenVersion: version, models: res.models, source: 'official' };
      fresh.updatedAt = Date.now();
      saveCatalogCache(stateDir, fresh);
      console.log(`[llm-switcher:catalog] Detected ${tool} version update to ${version} -> refreshed model catalog (${res.models.length} models)`);
    })
    .catch(() => {})
    .finally(() => {
      refreshingTools.delete(tool);
    });
}
