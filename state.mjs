// ============================================================
// state.mjs — shared config / launcher-flag state for LLM Switcher
//
// Shared by proxy.mjs, switch.mjs, mcp.mjs to avoid 3 copies of the
// profile on/off logic drifting out of sync.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = __dirname;
export const TARGETS = ['anthropic', 'responses', 'openai-chat', 'vertex'];
export const DEFAULT_PORT = 3456;
export const DEFAULT_BLINDFOLD_PORT = 3457;
// Codex with ChatGPT sign-in calls https://chatgpt.com/backend-api/codex.
// An API-key account calls https://api.openai.com/v1 instead.
export const DEFAULT_BLINDFOLD_HOST = 'chatgpt.com';
export const DEFAULT_BLINDFOLD_PREFIX = '/backend-api/codex';
export const CLAUDE_MODEL_SLOTS = ['opus', 'sonnet', 'haiku', 'fable'];
// Codex CLI model roles per OpenAI docs (config-reference):
// - main     <-> `model` (session model)
// - review   <-> `review_model` (override for /review)
// - subagent <-> `agents.default_subagent_model` (spawned agents)
// No fast/fallback in the docs — those are custom keys, read only for backward compatibility.
export const CODEX_MODEL_SLOTS = ['main', 'review', 'subagent'];
export const CHAT_MODEL_SLOTS = ['default'];
export const VERTEX_MODEL_SLOTS = ['default'];

export const MODEL_SLOTS_BY_FORMAT = {
  anthropic: CLAUDE_MODEL_SLOTS,
  responses: CODEX_MODEL_SLOTS,
  'openai-chat': CHAT_MODEL_SLOTS,
  vertex: VERTEX_MODEL_SLOTS,
  auto: CLAUDE_MODEL_SLOTS
};

// Fallback key chain when reading old profiles (preserves values, no config loss).
const SLOT_LEGACY_KEYS = {
  main: ['opus'],
  review: ['sonnet'],
  subagent: ['fast', 'fallback', 'haiku', 'fable'],
  default: ['sonnet', 'opus', 'haiku', 'fable']
};

export const configPath = process.env.LLM_SWITCHER_CONFIG
  ? path.resolve(process.env.LLM_SWITCHER_CONFIG)
  : path.join(ROOT_DIR, 'config.json');

// Any local process can reach loopback, so /api/* needs a secret that only the owner can read.
// It lives next to config.json so a test config in a temp dir gets its own token.
export const adminTokenPath = path.join(path.dirname(configPath), 'admin.token');

export function readAdminToken() {
  try {
    return fs.readFileSync(adminTokenPath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function ensureAdminToken() {
  const current = readAdminToken();
  if (current) {
    try { fs.chmodSync(adminTokenPath, 0o600); } catch {}
    return current;
  }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(adminTokenPath, `${token}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') return readAdminToken();
    throw err;
  }
  return token;
}

// `switch ui` must not put the token on a command line: /proc/<pid>/cmdline is readable by every
// account. It opens this private file instead, which redirects to the dashboard with the token.
export function writeDashboardLauncher(url) {
  const file = path.join(path.dirname(configPath), 'ui-open.html');
  const target = `${url}#token=${ensureAdminToken()}`;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, `<!doctype html><meta charset="utf-8"><title>LLM Switcher</title><script>location.replace(${JSON.stringify(target)})</script>\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  return file;
}

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const claudeSettingsPath = path.join(claudeDir, 'settings.json');

export const paths = {
  activeFlag: path.join(ROOT_DIR, 'active.flag'),
  flag1M: path.join(ROOT_DIR, '1m.flag'),            // Claude Code launcher flag
  flagCodex1M: path.join(ROOT_DIR, 'codex-1m.flag'),  // Codex launcher flag
  flagOpenAI1M: path.join(ROOT_DIR, 'openai-1m.flag'), // OpenAI launcher flag
  envCmd: path.join(ROOT_DIR, 'env.cmd'),
  envSh: path.join(ROOT_DIR, 'env.sh'),
  envCodexCmd: path.join(ROOT_DIR, 'env-codex.cmd'),
  envCodexSh: path.join(ROOT_DIR, 'env-codex.sh'),
  codexCatalog: path.join(ROOT_DIR, 'model-catalog.json'),
  codexCatalogTemplate: path.join(ROOT_DIR, 'codex-catalog-template.json'),
  blindfoldCA: path.join(process.env.LLM_SWITCHER_BLINDFOLD_CERTS || path.join(ROOT_DIR, 'blindfold', 'certs'), 'ca.pem'),
  pidFile: path.join(ROOT_DIR, 'proxy.pid')
};

// ---------------- config IO ----------------

let cachedConfig = null;
let lastMtime = 0;
let lastLoadError = null;

// Cached config read keyed by mtime. If the file is half-written (invalid JSON), keep the old cached copy.
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

// A caller that changed the cached object and then decided not to save drops it here, so the
// next loadConfig reads config.json again instead of serving the unsaved change.
export function getConfigLoadError() {
  return lastLoadError;
}

// Atomic write (tmp + rename) so a running proxy never reads a half-written file.
// The tmp file is created 0600 and renamed over config.json, so the keys are never readable by
// another account, even when an earlier release left config.json at 0644.
export function saveConfig(cfg) {
  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
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

// Case-insensitive profile lookup (CLI accepts `switch MyProfile` or `switch myprofile`).
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

export function modelSlotsForProfile(profile) {
  return MODEL_SLOTS_BY_FORMAT[profile?.inFormat] || MODEL_SLOTS_BY_FORMAT.auto;
}

function legacyKeysForSlot(slot) {
  return SLOT_LEGACY_KEYS[slot] || [];
}

// UI saves using the new slot keys; on read, try the new key first, legacy keys after.
export function modelForSlot(profile, slot) {
  const models = profile?.defaultModels || {};
  // An explicit empty canonical value clears any legacy value. This matters
  // during migration because the UI keeps old keys until the profile is saved.
  if (Object.hasOwn(models, slot)) return models[slot] || '';
  for (const k of legacyKeysForSlot(slot)) {
    if (models[k]) return models[k];
  }
  return '';
}

export function model1MForSlot(profile, slot) {
  const flags = profile?.model1M || {};
  if (Object.hasOwn(flags, slot)) return Boolean(flags[slot]);
  for (const k of legacyKeysForSlot(slot)) {
    if (Object.hasOwn(flags, k)) return Boolean(flags[k]);
  }
  return false;
}

// ---------------- Codex-facing model names ----------------
//
// Codex must never be handed a switcher-internal name. It can display whatever it
// is given: the /model picker renders the local catalog file, and `review_model` /
// `agents.default_subagent_model` show up in its config. So every name that leaves
// this process for the CLI comes from `publicModels` (official OpenAI slugs), while
// the slots main/review/subagent stay server-side for mapModel to resolve.
//
// `codexRoles` overrides a single role when position is not the wanted pairing.
export function codexPublicModel(profile, slot) {
  // A present key wins even when it is '': the dashboard saves a blank role as "no override".
  if (Object.hasOwn(profile?.codexRoles || {}, slot)) return String(profile.codexRoles[slot] || '');
  // Read by POSITION, without compacting the array. Dropping a blank entry first would
  // move every later role onto the wrong model, and /review would run on the subagent.
  const published = Array.isArray(profile?.publicModels) ? profile.publicModels : [];
  const index = CODEX_MODEL_SLOTS.indexOf(slot);
  return index >= 0 ? String(published[index] || '') : '';
}

// A model name reaches cmd.exe twice: env.cmd runs as a batch file, and the shim then
// expands the variable unquoted onto the Codex command line. So the name is restricted
// to the characters real model IDs use. An unsafe name is dropped, never escaped:
// dropping it loses one override, escaping it correctly in two shells is a bet.
const SAFE_MODEL_NAME = /^[A-Za-z0-9._:/-]{1,128}$/;

export function isSafeModelName(name) {
  return typeof name === 'string' && SAFE_MODEL_NAME.test(name);
}

/**
 * Does this leaf certificate cover the host the interceptor will present it for?
 * Changing blindfoldHost without rebuilding the leaf produces a TLS error that reads
 * like a network fault, so the launcher compares the two before it starts anything.
 */
export function certCoversHost(pem, host) {
  if (!pem || !host) return false;
  let names;
  try {
    names = new crypto.X509Certificate(pem).subjectAltName;
  } catch {
    return false;
  }
  if (!names) return false;
  const target = String(host).toLowerCase();
  return names.split(',').some(entry => {
    const value = entry.trim().replace(/^DNS:/i, '').toLowerCase();
    if (value === target) return true;
    // One wildcard label only, exactly as TLS clients match it.
    if (value.startsWith('*.')) {
      const suffix = value.slice(1);
      return target.endsWith(suffix) && !target.slice(0, -suffix.length).includes('.');
    }
    return false;
  });
}

let cachedCatalogTemplate = null;

function codexCatalogTemplate() {
  if (cachedCatalogTemplate) return cachedCatalogTemplate;
  try {
    cachedCatalogTemplate = JSON.parse(fs.readFileSync(paths.codexCatalogTemplate, 'utf8'));
  } catch {
    cachedCatalogTemplate = null;
  }
  return cachedCatalogTemplate;
}

/**
 * Build the catalog Codex loads through `--config model_catalog_json`.
 * Returns null when the profile publishes no official names: Codex then keeps its
 * own built-in catalog, which is leak-free too.
 */
export function buildCodexCatalog(profile) {
  const template = codexCatalogTemplate();
  if (!template) return null;

  // The catalog is what the picker reads, so its window must match the profile. When
  // two slots publish the same name the smaller window wins: overstating it makes
  // Codex size a session and its auto-compact point against space it does not have.
  const windows = new Map();
  for (const slot of CODEX_MODEL_SLOTS) {
    const name = codexPublicModel(profile, slot);
    if (!name) continue;
    const is1M = model1MForSlot(profile, slot);
    if (!windows.has(name) || !is1M) windows.set(name, is1M);
  }
  if (!windows.size) return null;

  return {
    models: [...windows].map(([name, is1M]) => ({
      ...structuredClone(template),
      slug: name,
      display_name: name,
      ...(is1M ? { context_window: 1000000, max_context_window: 1000000 } : {})
    }))
  };
}

export function parsePort(value) {
  const p = parseInt(value, 10);
  return Number.isInteger(p) && p > 0 && p <= 65535 ? p : null;
}

// Precedence: --port / -p > PORT / LLM_SWITCHER_PORT > config.port > 3456
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

// Legacy config only has `activeProfile` -> derive the per-CLI-target map from it.
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

// ---------------- mutations (do not persist by themselves) ----------------

// Assign a profile to one target. Returns an error string or null.
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

// Enable a profile for every target it supports (inFormat auto -> all).
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

// Disable exactly the targets using this profile (leaves other targets untouched).
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

function claudeTier1M(profile) {
  const m = profile?.model1M || {};
  return m.opus ? 'opus[1m]' : m.sonnet ? 'sonnet[1m]' : m.fable ? 'fable[1m]' : null;
}

function anyTier1M(profile) {
  return modelSlotsForProfile(profile).some(slot => model1MForSlot(profile, slot));
}

export function primaryModel(profile) {
  const slots = modelSlotsForProfile(profile);
  for (const slot of slots) {
    const model = modelForSlot(profile, slot);
    if (model) return model;
  }
  return '';
}

// Derive launcher state from activeProfiles (single source of truth).
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
    codex1M: codex && model1MForSlot(codex, 'main') ? (primaryModel(codex) || '1000000') : null,
    openai1M: openai && anyTier1M(openai) ? (primaryModel(openai) || '1000000') : null,
    // host and prefix travel with the port: an account that signs in with an API key
    // reaches a different host under a different prefix, and the launcher cannot guess
    // either one. The defaults cover ChatGPT sign-in.
    blindfold: codex?.blindfold
      ? {
        port: parsePort(codex.blindfoldPort) || DEFAULT_BLINDFOLD_PORT,
        host: String(codex.blindfoldHost || DEFAULT_BLINDFOLD_HOST),
        prefix: String(codex.blindfoldPrefix || DEFAULT_BLINDFOLD_PREFIX),
        ca: paths.blindfoldCA
      }
      : null,
    env: [],
    // Variables only the Codex shim may apply. They go to a separate file because the
    // `claude` shim sources the shared one, and a Codex-only proxy would capture every
    // claude HTTPS call — including after a restart, when the interceptor is not running.
    envCodex: []
  };

  if (claude) {
    state.env.push(['ANTHROPIC_BASE_URL', base]);
    state.env.push(['CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT', '1']);
    if (state.claude1M) {
      state.env.push(['ANTHROPIC_MODEL', state.claude1M]);
      state.env.push(['CLAUDE_CODE_AUTO_COMPACT_WINDOW', '900000']);
    }
    // Claude Code reads `[1m]` per variable: if only ANTHROPIC_MODEL carries the suffix, `/model sonnet`,
    // tier switches or subagent alias calls fall back to the real 200K Claude model. Set `<tier>[1m]` for
    // each tier the profile enables model1M on; Claude Code then sends plain `opus`/`sonnet`/... so the proxy
    // still maps by the active profile (hot profile switches need no CLI restart).
    for (const tier of CLAUDE_MODEL_SLOTS) {
      if (claude.model1M?.[tier]) state.env.push([`ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`, `${tier}[1m]`]);
    }
  }
  if (codex) {
    // These are internal shim inputs, not Codex configuration variables.
    // The installed Codex shim converts them to documented `--config` keys.
    if (codex.blindfold) {
      // Blindfold mode: Codex keeps its official endpoint and reaches the gateway
      // through blindfold/blindfold.mjs, so no base URL override exists to report.
      // NO_PROXY keeps local MCP servers off the intercept path.
      const blindfoldURL = `http://127.0.0.1:${state.blindfold.port}`;
      state.envCodex.push(['HTTPS_PROXY', blindfoldURL]);
      state.envCodex.push(['https_proxy', blindfoldURL]);
      state.envCodex.push(['NO_PROXY', '127.0.0.1,localhost']);
      state.envCodex.push(['no_proxy', '127.0.0.1,localhost']);
      state.envCodex.push(['CODEX_CA_CERTIFICATE', paths.blindfoldCA]);
    } else {
      state.env.push(['LLM_SWITCHER_CODEX_BASE_URL', `${base}/v1`]);
    }
    // Official names only. An upstream ID here would reach the CLI as a --config
    // value and show up in its UI, which is the leak this indirection exists for.
    for (const slot of CODEX_MODEL_SLOTS) {
      const publicName = codexPublicModel(codex, slot);
      if (isSafeModelName(publicName)) {
        state.env.push([`LLM_SWITCHER_CODEX_${slot.toUpperCase()}_MODEL`, publicName]);
      }
    }
    if (state.codex1M) {
      state.env.push(['LLM_SWITCHER_CODEX_CONTEXT_WINDOW', '1000000']);
      state.env.push(['LLM_SWITCHER_CODEX_AUTO_COMPACT_LIMIT', '900000']);
    }
  }
  if (openai) {
    state.env.push(['OPENAI_BASE_URL', `${base}/v1`]);
    if (state.openai1M) state.env.push(['OPENAI_MAX_CONTEXT_TOKENS', '1000000']);
  }
  return state;
}

// Write flags + env.cmd/env.sh from activeProfiles, and clean up Claude Code settings.json.
export function applyLaunchState(cfg, port, { cleanSettings = true } = {}) {
  const st = computeLaunchState(cfg, port);
  writeOrRemove(paths.activeFlag, st.active ? 'active' : null);
  writeOrRemove(paths.flag1M, st.claude1M);
  writeOrRemove(paths.flagCodex1M, st.codex1M);
  writeOrRemove(paths.flagOpenAI1M, st.openai1M);

  const renderCmd = (pairs) => ['@echo off', 'REM Auto-generated by LLM Switcher for active profiles',
    ...pairs.map(([k, v]) => `SET "${k}=${v}"`)].join('\r\n') + '\r\n';
  const renderSh = (pairs) => ['#!/usr/bin/env sh', '# Auto-generated by LLM Switcher for active profiles',
    ...pairs.map(([k, v]) => `export ${k}='${String(v).replace(/'/g, `'\\''`)}'`)].join('\n') + '\n';

  if (st.active) {
    try {
      fs.writeFileSync(paths.envCmd, renderCmd(st.env), 'utf8');
      fs.writeFileSync(paths.envSh, renderSh(st.env), 'utf8');
      // Written even when empty, so a stale Codex-only file from a previous profile
      // can never survive a switch.
      fs.writeFileSync(paths.envCodexCmd, renderCmd(st.envCodex), 'utf8');
      fs.writeFileSync(paths.envCodexSh, renderSh(st.envCodex), 'utf8');
    } catch (err) {
      st.envWriteError = err.message;
    }
  } else {
    writeOrRemove(paths.envCmd, null);
    writeOrRemove(paths.envSh, null);
    writeOrRemove(paths.envCodexCmd, null);
    writeOrRemove(paths.envCodexSh, null);
  }

  // The catalog follows the active Codex profile, so a profile switch can never
  // leave the previous profile's model names on the /model screen.
  const codexKey = getActiveMap(cfg).responses;
  const codexProfile = hasProfile(cfg, codexKey) ? cfg.profiles[codexKey] : null;
  const catalog = st.active && codexProfile ? buildCodexCatalog(codexProfile) : null;
  writeOrRemove(paths.codexCatalog, catalog ? JSON.stringify(catalog) : null);

  // Clean only after the env files are in place: a failed write must not also touch settings.json.
  if (cleanSettings && !st.envWriteError) st.settings = cleanClaudeSettings(port);
  return st;
}

export function clearLaunchState(port) {
  for (const f of [paths.activeFlag, paths.flag1M, paths.flagCodex1M, paths.flagOpenAI1M,
    paths.envCmd, paths.envSh, paths.envCodexCmd, paths.envCodexSh, paths.codexCatalog]) {
    writeOrRemove(f, null);
  }
  return cleanClaudeSettings(port);
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

// settings.json belongs to Claude Code and to the user. Remove a value only when it is exactly what
// the switcher itself would write: its own base URL, or a `<tier>[1m]` alias. Everything else,
// including ANTHROPIC_AUTH_TOKEN and *_MODEL_NAME, is someone else's and stays.
function isSwitcherValue(key, value, port) {
  if (key === 'ANTHROPIC_BASE_URL') {
    return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?$/.exec(String(value))?.[2] === String(port);
  }
  const tier = /^ANTHROPIC_DEFAULT_(OPUS|SONNET|HAIKU|FABLE)_MODEL$/.exec(key)?.[1];
  return Boolean(tier) && value === `${tier.toLowerCase()}[1m]`;
}

// Only writes when a value is removed; the write goes through the path, so a symlinked
// settings.json stays a symlink and keeps its mode. Never throws.
export function cleanClaudeSettings(port) {
  try {
    if (!fs.existsSync(claudeSettingsPath)) return { changed: false, removed: [] };
    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    if (!settings?.env || typeof settings.env !== 'object') return { changed: false, removed: [] };
    const removed = Object.keys(settings.env).filter(k => isSwitcherValue(k, settings.env[k], port));
    if (!removed.length) return { changed: false, removed: [] };
    for (const k of removed) delete settings.env[k];
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return { changed: true, removed };
  } catch (err) {
    return { changed: false, removed: [], error: err.message };
  }
}

// Hide API keys when returning config to the UI / API.
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

// ---------------- process identity ----------------
// An answer on a port proves nothing: any local process can bind a free port and replay a /health
// body. Only a process that can read admin.token can answer HMAC(token, nonce) for a fresh nonce.
// The MAC covers role, listening port, pid and arguments: a proof relayed from the process on
// another port, or a body with an edited pid, no longer verifies. blindfold.mjs signs the same fields.
export function identityProof(nonce, { role, port, pid, gatewayPort = '', host = '', prefix = '' }, token = readAdminToken()) {
  if (!token) return '';
  return crypto.createHmac('sha256', token).update([role, port, pid, gatewayPort, host, prefix, nonce].join('|')).digest('hex');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A busy but genuine process can take a moment; a squatter gains nothing from a longer wait.
function getJson(port, pathname, timeoutMs = 3000) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; if (data.length > 65536) req.destroy(); });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch {}
        resolve({ state: 'answered', body });
      });
    });
    req.on('error', err => resolve({ state: err.code === 'ECONNREFUSED' ? 'free' : 'foreign' }));
    req.on('timeout', () => { req.destroy(); resolve({ state: 'foreign' }); });
  });
}

const newNonce = () => crypto.randomBytes(16).toString('hex');

/** 'ours' | 'foreign' | 'free' */
export async function probeGateway(port) {
  const nonce = newNonce();
  const r = await getJson(port, `/health?challenge=${nonce}`);
  if (r.state !== 'answered') return r.state;
  const b = r.body;
  if (b?.proxy !== 'llm-switcher' || b.port !== port) return 'foreign';
  const proof = identityProof(nonce, { role: 'gateway', port, pid: b.pid });
  return proof && b.proof === proof ? 'ours' : 'foreign';
}

/** { state: 'ours', pid, gatewayPort, host, prefix } | { state: 'foreign' } | { state: 'free' } */
export async function probeBlindfold(port) {
  const nonce = newNonce();
  const r = await getJson(port, `/?challenge=${nonce}`);
  if (r.state !== 'answered') return { state: r.state };
  const b = r.body;
  if (b?.proxy !== 'llm-switcher-blindfold' || b.port !== port) return { state: 'foreign' };
  const proof = identityProof(nonce, { role: 'blindfold', port, pid: b.pid, gatewayPort: b.gatewayPort, host: b.host, prefix: b.prefix });
  if (!proof || b.proof !== proof) return { state: 'foreign' };
  return { state: 'ours', pid: b.pid, gatewayPort: b.gatewayPort, host: b.host, prefix: b.prefix };
}

// Signal a pid only right after a fresh identity probe named it.
function killVerified(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
  } catch {}
}

// ---------------- blindfold interceptor ----------------
// HTTPS_PROXY in env-codex.* is a hard dependency: with no interceptor behind it, Codex reaches no
// host at all. The gateway process owns the interceptor and reconcileBlindfold is the only code
// that starts one; the CLI asks the gateway through POST /api/blindfold/sync.

const blindfoldScript = path.join(ROOT_DIR, 'blindfold', 'blindfold.mjs');
export const blindfoldStatePath = path.join(path.dirname(configPath), 'blindfold.json');

function readBlindfoldState() {
  try { return JSON.parse(fs.readFileSync(blindfoldStatePath, 'utf8')); } catch { return null; }
}

function writeBlindfoldState(st) {
  fs.writeFileSync(blindfoldStatePath, JSON.stringify(st), { encoding: 'utf8', mode: 0o600 });
}

async function stopBlindfoldAt(port) {
  const cur = await probeBlindfold(port);
  if (cur.state !== 'ours') return;
  killVerified(cur.pid);
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    if ((await probeBlindfold(port)).state !== 'ours') return;
  }
}

/** Stop the interceptor recorded in blindfold.json, if a probe confirms it is ours. Never starts one. */
export async function stopRecordedBlindfold() {
  const prev = readBlindfoldState();
  if (prev?.port) await stopBlindfoldAt(prev.port);
  try { fs.unlinkSync(blindfoldStatePath); } catch {}
}

/** null when the interceptor can start, otherwise the reason and the command that fixes it. */
export function blindfoldPreflight(desired) {
  const certDir = path.dirname(desired.ca);
  const build = `bash blindfold/make-certs.sh ${desired.host}${process.env.LLM_SWITCHER_BLINDFOLD_CERTS ? ` "${certDir}"` : ''}`;
  for (const f of [desired.ca, path.join(certDir, 'leaf.pem'), path.join(certDir, 'leaf.key')]) {
    if (!fs.existsSync(f)) return `Blindfold mode is on, but ${path.basename(f)} is missing in ${certDir}. Build the certificates first: ${build}`;
  }
  // A leaf for another host fails the TLS handshake with an error that reads like a network fault.
  if (!certCoversHost(fs.readFileSync(path.join(certDir, 'leaf.pem'), 'utf8'), desired.host)) {
    return `The leaf certificate does not cover "${desired.host}". Rebuild it for that host: ${build}`;
  }
  return null;
}

// The single place that starts an interceptor.
function spawnBlindfold(desired, gatewayPort) {
  const log = fs.openSync(path.join(ROOT_DIR, 'blindfold.log'), 'a', 0o600);
  const child = spawn(process.execPath, [
    blindfoldScript,
    '--port', String(desired.port),
    '--gateway-port', String(gatewayPort),
    '--host', desired.host,
    '--prefix', desired.prefix,
    '--certs', path.dirname(desired.ca),
    '--token-file', adminTokenPath
  ], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  child.unref();
  fs.closeSync(log);
}

/** null when the interceptor that cfg asks for can run, otherwise the reason. No side effects. */
export async function checkBlindfoldTarget(cfg, gatewayPort) {
  const desired = computeLaunchState(cfg, gatewayPort).blindfold;
  if (!desired) return null;
  const problem = blindfoldPreflight(desired);
  if (problem) return problem;
  if ((await probeBlindfold(desired.port)).state === 'foreign') {
    return `Port ${desired.port} is held by another process, not by this switcher's interceptor.`;
  }
  return null;
}

const matches = (cur, desired, gatewayPort) =>
  cur.state === 'ours' && cur.gatewayPort === gatewayPort && cur.host === desired.host && cur.prefix === desired.prefix;

/**
 * Bring the interceptor in line with the saved config: start, respawn with new arguments, or stop.
 * Returns { ok: true, action } or { ok: false, error }.
 */
export async function reconcileBlindfold(cfg, gatewayPort) {
  const desired = computeLaunchState(cfg, gatewayPort).blindfold;
  const prev = readBlindfoldState();
  if (!desired) {
    if (prev?.port) await stopRecordedBlindfold();
    return { ok: true, action: 'none' };
  }
  // Validate the new interceptor before the old one is stopped: a failed change keeps Codex working.
  const problem = await checkBlindfoldTarget(cfg, gatewayPort);
  if (problem) return { ok: false, error: problem };
  if (prev?.port && prev.port !== desired.port) await stopRecordedBlindfold();
  const cur = await probeBlindfold(desired.port);
  if (matches(cur, desired, gatewayPort)) {
    writeBlindfoldState({ pid: cur.pid, port: desired.port, gatewayPort, host: desired.host, prefix: desired.prefix });
    return { ok: true, action: 'kept' };
  }
  if (cur.state === 'ours') await stopBlindfoldAt(desired.port);

  spawnBlindfold(desired, gatewayPort);
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const now = await probeBlindfold(desired.port);
    if (matches(now, desired, gatewayPort)) {
      writeBlindfoldState({ pid: now.pid, port: desired.port, gatewayPort, host: desired.host, prefix: desired.prefix });
      return { ok: true, action: 'started' };
    }
  }
  return { ok: false, error: `The interceptor did not come up on port ${desired.port}. See blindfold.log.` };
}
