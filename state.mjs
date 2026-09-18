// ============================================================
// state.mjs — shared config / launcher-flag state for LLM Switcher
//
// Dùng chung cho proxy.mjs, switch.mjs, mcp.mjs để tránh 3 bản copy
// logic bật/tắt profile bị lệch nhau.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = __dirname;
export const TARGETS = ['anthropic', 'responses', 'openai-chat', 'vertex'];
export const DEFAULT_PORT = 3456;

export const configPath = process.env.LLM_SWITCHER_CONFIG
  ? path.resolve(process.env.LLM_SWITCHER_CONFIG)
  : path.join(ROOT_DIR, 'config.json');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const claudeSettingsPath = path.join(claudeDir, 'settings.json');

export const paths = {
  activeFlag: path.join(ROOT_DIR, 'active.flag'),
  flag1M: path.join(ROOT_DIR, '1m.flag'),            // Claude Code launcher flag
  flagCodex1M: path.join(ROOT_DIR, 'codex-1m.flag'),  // Codex launcher flag
  flagOpenAI1M: path.join(ROOT_DIR, 'openai-1m.flag'), // OpenAI launcher flag
  envCmd: path.join(ROOT_DIR, 'env.cmd'),
  envSh: path.join(ROOT_DIR, 'env.sh'),
  pidFile: path.join(ROOT_DIR, 'proxy.pid')
};

// ---------------- config IO ----------------

let cachedConfig = null;
let lastMtime = 0;
let lastLoadError = null;

// Đọc config có cache theo mtime. Nếu file đang bị sửa dở (JSON lỗi) thì giữ bản cache cũ.
export function loadConfig() {
  try {
    const stat = fs.statSync(configPath);
    if (!cachedConfig || stat.mtimeMs !== lastMtime) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('config root must be an object');
      if (!parsed.profiles || typeof parsed.profiles !== 'object') parsed.profiles = {};
      cachedConfig = parsed;
      lastMtime = stat.mtimeMs;
    }
    lastLoadError = null;
  } catch (err) {
    lastLoadError = err;
  }
  return cachedConfig;
}

export function getConfigLoadError() {
  return lastLoadError;
}

// Ghi atomic (tmp + rename) để proxy đang chạy không bao giờ đọc phải file ghi dở.
export function saveConfig(cfg) {
  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, configPath);
  cachedConfig = cfg;
  try { lastMtime = fs.statSync(configPath).mtimeMs; } catch {}
}

// ---------------- helpers ----------------

export function hasProfile(cfg, key) {
  return Boolean(key) && Boolean(cfg?.profiles) && Object.hasOwn(cfg.profiles, key);
}

export function isValidProfileKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key);
}

export function isValidTarget(target) {
  return TARGETS.includes(target);
}

// Tìm profile không phân biệt hoa thường (CLI gõ `switch MyProfile` hay `switch myprofile` đều được).
export function findProfileKey(cfg, name) {
  if (!name || !cfg?.profiles) return null;
  if (hasProfile(cfg, name)) return name;
  const lower = String(name).toLowerCase();
  return Object.keys(cfg.profiles).find(k => k.toLowerCase() === lower) || null;
}

export function profileAcceptsTarget(profile, target) {
  const inFmt = profile?.inFormat || 'auto';
  return inFmt === 'auto' || inFmt === target;
}

export function parsePort(value) {
  const p = parseInt(value, 10);
  return Number.isInteger(p) && p > 0 && p <= 65535 ? p : null;
}

// Thứ tự ưu tiên: --port / -p  >  PORT / LLM_SWITCHER_PORT  >  config.port  >  3456
export function resolvePort(argv = process.argv.slice(2), cfg = loadConfig()) {
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--port' || argv[i] === '-p') && argv[i + 1]) {
      const p = parsePort(argv[i + 1]);
      if (p) return p;
    }
  }
  const envP = parsePort(process.env.LLM_SWITCHER_PORT || process.env.PORT);
  if (envP) return envP;
  return parsePort(cfg?.port) || DEFAULT_PORT;
}

// Config cũ chỉ có `activeProfile` -> suy ra map theo từng CLI target.
export function getActiveMap(cfg) {
  const out = {};
  const legacy = cfg?.activeProfile || null;
  for (const t of TARGETS) {
    if (cfg?.activeProfiles && Object.hasOwn(cfg.activeProfiles, t)) out[t] = cfg.activeProfiles[t] || null;
    else out[t] = legacy;
  }
  return out;
}

function ensureActiveMap(cfg) {
  cfg.activeProfiles = getActiveMap(cfg);
  return cfg.activeProfiles;
}

// ---------------- mutations (không tự lưu) ----------------

// Gán profile cho 1 target. Trả về chuỗi lỗi hoặc null.
export function setTargetProfile(cfg, target, profileKey) {
  if (!isValidTarget(target)) return `Unknown target "${target}". Valid: ${TARGETS.join(', ')}`;
  const map = ensureActiveMap(cfg);
  if (!profileKey) {
    map[target] = null;
    return null;
  }
  if (!hasProfile(cfg, profileKey)) return `Profile "${profileKey}" does not exist`;
  const p = cfg.profiles[profileKey];
  if (!profileAcceptsTarget(p, target)) {
    return `Profile "${profileKey}" only accepts "${p.inFormat}" input and cannot serve target "${target}"`;
  }
  map[target] = profileKey;
  cfg.activeProfile = profileKey;
  return null;
}

// Bật profile cho mọi target mà nó hỗ trợ (inFormat auto -> tất cả).
export function activateProfile(cfg, profileKey) {
  if (!hasProfile(cfg, profileKey)) return `Profile "${profileKey}" does not exist`;
  const map = ensureActiveMap(cfg);
  const p = cfg.profiles[profileKey];
  for (const t of TARGETS) {
    if (profileAcceptsTarget(p, t)) map[t] = profileKey;
  }
  cfg.activeProfile = profileKey;
  return null;
}

// Tắt đúng các target đang dùng profile này (không đụng target khác).
export function deactivateProfile(cfg, profileKey) {
  const map = ensureActiveMap(cfg);
  for (const t of TARGETS) {
    if (map[t] === profileKey) map[t] = null;
  }
}

export function deactivateAll(cfg) {
  cfg.activeProfiles = Object.fromEntries(TARGETS.map(t => [t, null]));
}

export function deleteProfile(cfg, profileKey) {
  if (!hasProfile(cfg, profileKey)) return 'Profile not found';
  deactivateProfile(cfg, profileKey);
  delete cfg.profiles[profileKey];
  if (cfg.activeProfile === profileKey) {
    cfg.activeProfile = Object.keys(cfg.profiles)[0] || '';
  }
  return null;
}

export function isProfileActive(cfg, profileKey) {
  return Object.values(getActiveMap(cfg)).includes(profileKey);
}

// ---------------- launcher flags & env files ----------------

function writeOrRemove(file, content) {
  if (content) {
    fs.writeFileSync(file, content, 'utf8');
  } else if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch {}
  }
}

const CLAUDE_TIERS = ['opus', 'sonnet', 'haiku', 'fable'];

function claudeTier1M(profile) {
  const m = profile?.model1M || {};
  return m.opus ? 'opus[1m]' : m.sonnet ? 'sonnet[1m]' : m.fable ? 'fable[1m]' : null;
}

function anyTier1M(profile) {
  const m = profile?.model1M || {};
  return Boolean(m.opus || m.sonnet || m.haiku || m.fable);
}

function primaryModel(profile) {
  const d = profile?.defaultModels || {};
  return d.opus || d.sonnet || d.haiku || '';
}

// Tính trạng thái launcher từ activeProfiles (nguồn sự thật duy nhất).
export function computeLaunchState(cfg, port) {
  const map = getActiveMap(cfg);
  const pick = (t) => (hasProfile(cfg, map[t]) ? cfg.profiles[map[t]] : null);
  const claude = pick('anthropic');
  const codex = pick('responses');
  const openai = pick('openai-chat');
  const vertex = pick('vertex');
  const base = `http://127.0.0.1:${port}`;

  const state = {
    active: Boolean(claude || codex || openai || vertex),
    claude1M: claude ? claudeTier1M(claude) : null,
    codex1M: codex && anyTier1M(codex) ? (primaryModel(codex) || '1000000') : null,
    openai1M: openai && anyTier1M(openai) ? (primaryModel(openai) || '1000000') : null,
    env: []
  };

  if (claude) {
    state.env.push(['ANTHROPIC_BASE_URL', base]);
    state.env.push(['CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT', '1']);
    if (state.claude1M) {
      state.env.push(['ANTHROPIC_MODEL', state.claude1M]);
      state.env.push(['CLAUDE_CODE_AUTO_COMPACT_WINDOW', '900000']);
    }
    // Claude Code đọc `[1m]` theo từng biến: chỉ ANTHROPIC_MODEL mang hậu tố thì `/model sonnet`,
    // đổi tier hay subagent gọi alias đều rơi về model Claude thật 200K. Gắn `<tier>[1m]` cho đúng
    // các tier profile bật model1M; Claude Code khi đó gửi nguyên `opus`/`sonnet`/... nên proxy vẫn
    // map theo profile đang active (đổi profile nóng không cần khởi động lại CLI).
    for (const tier of CLAUDE_TIERS) {
      if (claude.model1M?.[tier]) state.env.push([`ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`, `${tier}[1m]`]);
    }
  }
  if (codex) {
    state.env.push(['CODEX_BASE_URL', `${base}/v1`]);
    state.env.push(['OPENAI_BASE_URL', `${base}/v1`]);
    if (state.codex1M) {
      state.env.push(['CODEX_MAX_CONTEXT_TOKENS', '1000000']);
      state.env.push(['CODEX_AUTO_COMPACT_WINDOW', '900000']);
      const pm = primaryModel(codex);
      if (pm) state.env.push(['CODEX_MODEL', pm]);
    }
  }
  if (openai) {
    if (!codex) state.env.push(['OPENAI_BASE_URL', `${base}/v1`]);
    if (state.openai1M) state.env.push(['OPENAI_MAX_CONTEXT_TOKENS', '1000000']);
  }
  return state;
}

// Ghi flag + env.cmd/env.sh đúng theo activeProfiles, và dọn settings.json của Claude Code.
export function applyLaunchState(cfg, port) {
  const st = computeLaunchState(cfg, port);
  writeOrRemove(paths.activeFlag, st.active ? 'active' : null);
  writeOrRemove(paths.flag1M, st.claude1M);
  writeOrRemove(paths.flagCodex1M, st.codex1M);
  writeOrRemove(paths.flagOpenAI1M, st.openai1M);

  if (st.active) {
    const cmd = ['@echo off', 'REM Auto-generated by LLM Switcher for active profiles'];
    const sh = ['#!/usr/bin/env sh', '# Auto-generated by LLM Switcher for active profiles'];
    for (const [k, v] of st.env) {
      cmd.push(`SET "${k}=${v}"`);
      sh.push(`export ${k}='${String(v).replace(/'/g, `'\\''`)}'`);
    }
    try {
      fs.writeFileSync(paths.envCmd, cmd.join('\r\n') + '\r\n', 'utf8');
      fs.writeFileSync(paths.envSh, sh.join('\n') + '\n', 'utf8');
    } catch {}
  } else {
    writeOrRemove(paths.envCmd, null);
    writeOrRemove(paths.envSh, null);
  }

  cleanClaudeSettings();
  return st;
}

export function clearLaunchState() {
  for (const f of [paths.activeFlag, paths.flag1M, paths.flagCodex1M, paths.flagOpenAI1M, paths.envCmd, paths.envSh]) {
    writeOrRemove(f, null);
  }
  cleanClaudeSettings();
}

export function readLaunchFlags() {
  const active = fs.existsSync(paths.activeFlag);
  return {
    isUsingProxy: active,
    is1MActive: active && fs.existsSync(paths.flag1M),
    isCodex1MActive: active && fs.existsSync(paths.flagCodex1M),
    isOpenAI1MActive: active && fs.existsSync(paths.flagOpenAI1M)
  };
}

const MANAGED_CLAUDE_ENV = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME'
];

// Gỡ các biến proxy cũ khỏi ~/.claude/settings.json. Chỉ ghi file khi thực sự có thay đổi,
// và không bao giờ ném lỗi (settings.json lỗi cú pháp thì để nguyên cho user tự sửa).
export function cleanClaudeSettings() {
  try {
    if (!fs.existsSync(claudeSettingsPath)) return { changed: false };
    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    if (!settings?.env || typeof settings.env !== 'object') return { changed: false };
    const removed = MANAGED_CLAUDE_ENV.filter(k => Object.hasOwn(settings.env, k));
    if (!removed.length) return { changed: false };
    for (const k of removed) delete settings.env[k];
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return { changed: true, removed };
  } catch (err) {
    return { changed: false, error: err.message };
  }
}

// Ẩn API key khi trả config ra UI / API.
export const MASKED_KEY = '__LLM_SWITCHER_KEEP_KEY__';

export function redactConfig(cfg) {
  const clone = JSON.parse(JSON.stringify(cfg || {}));
  for (const p of Object.values(clone.profiles || {})) {
    if (p && typeof p === 'object') {
      p.hasApiKey = Boolean(p.apiKey);
      p.apiKey = p.apiKey ? MASKED_KEY : '';
    }
  }
  return clone;
}
