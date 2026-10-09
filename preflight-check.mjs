#!/usr/bin/env node
// preflight-check.mjs — Proactively verify configured models, API key, and endpoint
// availability when launching a tool session from the notice shim.
//
// Usage: node preflight-check.mjs <tool> [stateDir]

import fs from 'node:fs';
import path from 'node:path';

const tool = process.argv[2] || 'claude';
const stateDir = process.argv[3] || process.env.LLM_SWITCHER_STATE_DIR || path.join(process.env.HOME || '', '.llm-switcher');
const CACHE_TTL_MS = 180000; // 3 minutes cache to keep consecutive shell starts instant

async function run() {
  const routeFile = path.join(stateDir, `route-${tool}.txt`);
  let routeLine = '';
  try {
    if (fs.existsSync(routeFile)) {
      routeLine = fs.readFileSync(routeFile, 'utf8').trim();
    }
  } catch {}

  if (!routeLine) {
    process.exit(0);
  }

  const configPath = path.join(stateDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    console.log(`[llm-switcher] ${routeLine}`);
    process.exit(0);
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    console.log(`[llm-switcher] ${routeLine}`);
    process.exit(0);
  }

  const activeMap = cfg.activeProfiles || {};
  const profileKey = activeMap[tool] || (tool === 'claude' ? cfg.activeProfile : null);
  const profile = profileKey ? cfg.profiles?.[profileKey] : null;

  if (!profile || !profile.baseURL) {
    console.log(`[llm-switcher] ${routeLine}`);
    process.exit(0);
  }

  // Identify configured models for this tool
  const configuredModels = [];
  if (tool === 'claude') {
    const dm = profile.defaultModels || {};
    if (dm.sonnet) configuredModels.push({ slot: 'sonnet', name: dm.sonnet });
    if (dm.opus && dm.opus !== dm.sonnet) configuredModels.push({ slot: 'opus', name: dm.opus });
    if (dm.haiku && dm.haiku !== dm.sonnet) configuredModels.push({ slot: 'haiku', name: dm.haiku });
  } else if (tool === 'codex') {
    const dm = profile.defaultModels || {};
    if (dm.main) configuredModels.push({ slot: 'main', name: dm.main });
    if (dm.review && dm.review !== dm.main) configuredModels.push({ slot: 'review', name: dm.review });
    if (dm.subagent && dm.subagent !== dm.main) configuredModels.push({ slot: 'subagent', name: dm.subagent });
  } else if (tool === 'agy') {
    const m = profile.defaultModels?.main || profile.model || profile.models?.[0];
    if (m) configuredModels.push({ slot: 'main', name: m });
  }

  if (!configuredModels.length && profile.model) {
    configuredModels.push({ slot: 'default', name: profile.model });
  }

  const cachePath = path.join(stateDir, 'preflight-cache.json');
  const cacheKey = `${profileKey}:${configuredModels.map(m => m.name).join(',')}`;

  // Check cache
  try {
    if (fs.existsSync(cachePath)) {
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const entry = cache[tool];
      if (entry && entry.cacheKey === cacheKey && (Date.now() - entry.time < CACHE_TTL_MS)) {
        if (Array.isArray(entry.lines)) {
          console.log(entry.lines.join('\n'));
          process.exit(0);
        }
      }
    }
  } catch {}

  // Run preflight check
  let lines = [];
  const base = String(profile.baseURL || '').replace(/\/+$/, '');
  const modelsUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/models`;

  const headers = {
    'user-agent': 'llm-switcher/preflight',
    'accept': 'application/json'
  };

  if (profile.outFormat === 'anthropic') {
    headers['x-api-key'] = profile.apiKey || '';
    headers['anthropic-version'] = '2023-06-01';
  } else if (profile.apiKey) {
    headers['authorization'] = `Bearer ${profile.apiKey}`;
  }

  try {
    const res = await fetch(modelsUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(2500)
    });

    if (res.status === 401 || res.status === 403) {
      lines = [
        `[llm-switcher] ${routeLine}`,
        `[llm-switcher:preflight] ⚠️ CẢNH BÁO: API key cho profile '${profileKey}' không hợp lệ hoặc bị từ chối (HTTP ${res.status}).`,
        `[llm-switcher:preflight] Gợi ý: Chạy 'switch ui' để kiểm tra lại API key.`
      ];
    } else if (res.status >= 500) {
      lines = [
        `[llm-switcher] ${routeLine}`,
        `[llm-switcher:preflight] ⚠️ CẢNH BÁO: Endpoint ${base} đang báo lỗi máy chủ (HTTP ${res.status}).`
      ];
    } else if (res.ok) {
      let json = {};
      try {
        json = await res.json();
      } catch {}

      const rawList = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
      const catalogIds = new Set(rawList.map(m => typeof m === 'string' ? m : m?.id).filter(Boolean));

      if (catalogIds.size > 0 && configuredModels.length > 0) {
        const missing = [];
        for (const m of configuredModels) {
          const shortName = m.name.split('/').pop();
          const found = catalogIds.has(m.name) || catalogIds.has(shortName) ||
            Array.from(catalogIds).some(id => id.endsWith(m.name) || m.name.endsWith(id));
          if (!found) {
            missing.push(m);
          }
        }

        if (missing.length > 0) {
          lines = [
            `[llm-switcher] ${routeLine}`,
            `[llm-switcher:preflight] ⚠️ CẢNH BÁO: Model đã setup không còn khả dụng trên provider: ${missing.map(m => `'${m.name}' [slot ${m.slot}]`).join(', ')}.`,
            `[llm-switcher:preflight] Gợi ý: Chạy 'switch ui' để cập nhật lại model hợp lệ.`
          ];
        } else {
          lines = [`[llm-switcher] ${routeLine} (verified ✓)`];
        }
      } else {
        lines = [`[llm-switcher] ${routeLine} (verified ✓)`];
      }
    } else {
      // 404 on /models (provider doesn't implement catalog endpoint) -> neutral fallback
      lines = [`[llm-switcher] ${routeLine}`];
    }
  } catch (err) {
    if (err.name === 'TimeoutError') {
      lines = [
        `[llm-switcher] ${routeLine}`,
        `[llm-switcher:preflight] ⚠️ CẢNH BÁO: Endpoint ${base} phản hồi chậm (>2.5s) hoặc không thể kết nối.`
      ];
    } else {
      lines = [
        `[llm-switcher] ${routeLine}`,
        `[llm-switcher:preflight] ⚠️ CẢNH BÁO: Không thể kết nối tới endpoint ${base} (${err.message || 'connection failed'}).`
      ];
    }
  }

  // Save cache
  try {
    let cache = {};
    if (fs.existsSync(cachePath)) {
      try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}
    }
    cache[tool] = { cacheKey, time: Date.now(), lines };
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch {}

  console.log(lines.join('\n'));
}

run().catch(() => {
  process.exit(0);
});
