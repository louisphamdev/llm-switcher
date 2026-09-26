// ============================================================
// catalog.mjs — dynamic model catalog discovery and slot mapping (Claude Code & Codex)
//
// Automatically fetches official model lists from Anthropic / OpenAI or custom
// upstream endpoints to ensure mapping tables never go stale when providers release
// new model variants (e.g. gpt-6-sol, claude-opus-5-5).
// ============================================================

import fs from 'node:fs';
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

/**
 * Refreshes the local catalog cache with models from both official endpoints
 * and saves to the state directory.
 */
export async function refreshCatalog(stateDir, { claudeKey, codexKey } = {}) {
  const cache = loadCatalogCache(stateDir);

  const [claudeRes, codexRes] = await Promise.all([
    fetchToolModels('claude', { apiKey: claudeKey }),
    fetchToolModels('codex', { apiKey: codexKey })
  ]);

  if (claudeRes.ok && claudeRes.models.length > 0) {
    const existing = new Set(claudeRes.models.map(m => m.id));
    // Keep any baseline models that might be absent from the API
    for (const [tier, ids] of Object.entries(BASELINE_MODELS.claude)) {
      for (const id of ids) {
        if (!existing.has(id)) claudeRes.models.push({ id, tier });
      }
    }
    cache.claude = { models: claudeRes.models };
  }

  if (codexRes.ok && codexRes.models.length > 0) {
    const existing = new Set(codexRes.models.map(m => m.id));
    for (const [role, ids] of Object.entries(BASELINE_MODELS.codex)) {
      for (const id of ids) {
        if (!existing.has(id)) codexRes.models.push({ id, role });
      }
    }
    cache.codex = { models: codexRes.models };
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
 * When a request arrives with a new tool version not yet seen in cache,
 * immediately records the new version and kicks off an asynchronous background refresh.
 * Subsequent requests with the same version do zero network calls.
 */
export function checkVersionAndRefresh(tool, headers, stateDir, apiKey) {
  const version = detectToolVersion(headers, tool);
  if (!version) return;

  const cache = loadCatalogCache(stateDir);
  const toolEntry = cache[tool] || {};
  const lastVersion = toolEntry.lastSeenVersion || '';

  if (version !== lastVersion) {
    toolEntry.lastSeenVersion = version;
    cache[tool] = toolEntry;
    saveCatalogCache(stateDir, cache);

    if (!refreshingTools.has(tool)) {
      refreshingTools.add(tool);
      fetchToolModels(tool, { apiKey })
        .then(res => {
          if (res.ok && res.models.length > 0) {
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
            fresh[tool] = { lastSeenVersion: version, models: res.models };
            fresh.updatedAt = Date.now();
            saveCatalogCache(stateDir, fresh);
            console.log(`[llm-switcher:catalog] Detected ${tool} version update to ${version} -> refreshed model catalog (${res.models.length} models)`);
          }
        })
        .catch(() => {})
        .finally(() => {
          refreshingTools.delete(tool);
        });
    }
  }
}
