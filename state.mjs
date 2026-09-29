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

// A git checkout keeps its data next to the code. An npm install must not: an upgrade replaces
// the package directory. LLM_SWITCHER_HOME overrides both.
export function resolveDataDir(rootDir, env = process.env, home = os.homedir()) {
  if (env.LLM_SWITCHER_HOME) return path.resolve(env.LLM_SWITCHER_HOME);
  return fs.existsSync(path.join(rootDir, '.git')) ? rootDir : path.join(home, '.llm-switcher');
}
export const DATA_DIR = resolveDataDir(ROOT_DIR);
// Outside a checkout the data dir starts empty; config, token and launch files all write into it.
if (DATA_DIR !== ROOT_DIR) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); } catch {}
}
// R5: a request has exactly two targets now — the two tools. `anthropic` and `responses`
// survive only as spellings of them; `openai-chat` and `vertex` survive only as names
// migration still has to recognise in a config this build has not rewritten yet.
const LEGACY_TARGET_TOOL = { anthropic: 'claude', responses: 'codex' };
// Migration input only: the pointer keys an unmigrated config may still carry.
const LEGACY_TARGETS = ['anthropic', 'responses', 'openai-chat', 'vertex'];
export const TOOLS = ['claude', 'codex'];
export const COMMAND_WORDS = new Set(['claude', 'codex', 'on', 'off', 'status', 'doctor', 'ui']);
export const DEFAULT_PORT = 3456;
export const DEFAULT_BLINDFOLD_PORT = 3457;
// Codex with ChatGPT sign-in calls https://chatgpt.com/backend-api/codex.
// An API-key account calls https://api.openai.com/v1 instead.
// R3 retired these: routing uses the host table of R3 (INTERCEPT_HOSTS) and nothing else. They
// survive only as migration input, so the migration can still tell a default value from a custom
// one before it drops the per-profile field.
const LEGACY_DEFAULT_BLINDFOLD_HOST = 'chatgpt.com';
const LEGACY_DEFAULT_BLINDFOLD_PREFIX = '/backend-api/codex';
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
  : path.join(DATA_DIR, 'config.json');

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

// The shims read the launch files from the checkout. LLM_SWITCHER_STATE_DIR moves them for tests,
// which must not rewrite the launch state of a switcher that is in use.
export const STATE_DIR = process.env.LLM_SWITCHER_STATE_DIR ? path.resolve(process.env.LLM_SWITCHER_STATE_DIR) : DATA_DIR;

export const paths = {
  activeFlag: path.join(STATE_DIR, 'active.flag'),
  // env.sh / env.cmd stay behind as neutral stubs: a shell rc that still sources them gets
  // nothing new (R8). They are never unlinked, so an old rc line never turns into an error.
  envCmd: path.join(STATE_DIR, 'env.cmd'),
  envSh: path.join(STATE_DIR, 'env.sh'),
  // One env file per tool: a proxy meant for one tool can never capture the other's traffic.
  envClaudeCmd: path.join(STATE_DIR, 'env-claude.cmd'),
  envClaudeSh: path.join(STATE_DIR, 'env-claude.sh'),
  envCodexCmd: path.join(STATE_DIR, 'env-codex.cmd'),
  envCodexSh: path.join(STATE_DIR, 'env-codex.sh'),
  // The gateway port of the last switch on. The shim scrubs a stale loopback base URL
  // against it, so a shell opened before a port change still reaches the right gateway.
  gatewayPort: path.join(STATE_DIR, 'gateway.port'),
  proxyLog: path.join(STATE_DIR, 'proxy.log'),
  blindfoldLog: path.join(STATE_DIR, 'blindfold.log'),
  // The template is an input, not an output: /v1/models still builds its entries from it (R9).
  // Only model-catalog.json (paths.codexCatalog) is no longer written.
  codexCatalogTemplate: path.join(ROOT_DIR, 'codex-catalog-template.json'),
  blindfoldCA: path.join(process.env.LLM_SWITCHER_BLINDFOLD_CERTS || path.join(DATA_DIR, 'blindfold', 'certs'), 'ca.pem'),
  // The bundle holds the user's own CA plus the switcher CA, so Claude Code keeps trusting
  // both. Keyed by the hash of the user's PEM path: two different user CAs never share a file.
  claudeCaBundle: (userCaPath) => path.join(STATE_DIR,
    `claude-ca-bundle-${crypto.createHash('sha256').update(path.resolve(userCaPath)).digest('hex').slice(0, 16)}.pem`),
  // Remembers which PEM the bundle was built from, so a shell that inherits the bundle path
  // rebuilds from the original user file instead of copying the bundle into itself.
  claudeCaBundleSidecar: (userCaPath) => `${paths.claudeCaBundle(userCaPath)}.src`
};

// ---------------------------------------------------------------------------
// Claude CA bundle (R2)
//
// Claude Code appends NODE_EXTRA_CA_CERTS to the system roots. Pointing it straight at our
// ca.pem would drop a CA the user already trusts (a corporate root, for example), so the shim
// points it at a bundle holding BOTH: the user's certificates and the switcher CA.
//
// The bundle is keyed by the user's PEM path, and a `.src` sidecar records that path. A nested
// shell that inherits the bundle path therefore rebuilds from the ORIGINAL user file instead of
// copying the bundle into itself on every run.
//
// Staleness is content comparison only: mtimes lie across copies and checkouts.
//
// Every failure prints to stderr and returns ok:false so the shim can keep the inherited value.
// The shim must never export a path to a file that does not exist.
// ---------------------------------------------------------------------------

function isOwnBundlePath(candidate, stateDir) {
  if (!candidate) return false;
  try {
    const resolved = path.resolve(candidate);
    if (path.dirname(resolved) !== path.resolve(stateDir)) return false;
    return /^claude-ca-bundle-[0-9a-f]{16}\.pem$/.test(path.basename(resolved));
  } catch {
    return false;
  }
}

// One stable rendering, so "did the source change" is a byte comparison of equal shapes.
function normalizePem(pem) {
  const text = String(pem).replace(/\r\n/g, '\n').trim();
  return text ? `${text}\n` : '';
}

// tmp + rename with a fixed mode: the bundle is never visible half-written, and a stale
// tmp from a killed run cannot be mistaken for either file.
function writeModeAtomic(file, content, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Build (or refresh) the bundle of the user's CA and the switcher CA.
 *
 * @param {string} inheritedCa the NODE_EXTRA_CA_CERTS the shell already carried
 * @param {string} switcherCaPath the switcher's own ca.pem
 * @param {string} [stateDir]
 * @returns {{ok: boolean, path?: string, rebuilt?: boolean, error?: string}}
 */
export function ensureClaudeCaBundle(inheritedCa, switcherCaPath, stateDir = STATE_DIR) {
  const fail = (message) => {
    console.error(`[llm-switcher] ${message}`);
    return { ok: false, error: message };
  };

  const inherited = String(inheritedCa || '').trim();
  if (!inherited) return fail('NODE_EXTRA_CA_CERTS is empty; there is nothing to bundle.');

  let userCaPath;
  if (isOwnBundlePath(inherited, stateDir)) {
    // The shell inherited a bundle. Its sidecar names the user's original PEM; the bundle
    // itself must never be a source here, or it would append itself into itself.
    const sidecar = `${inherited}.src`;
    let recorded;
    try {
      recorded = fs.readFileSync(sidecar, 'utf8').trim();
    } catch {
      return fail(`missing or unreadable sidecar ${sidecar}; keeping NODE_EXTRA_CA_CERTS at ${inherited}.`);
    }
    if (!recorded) return fail(`empty sidecar ${sidecar}; keeping NODE_EXTRA_CA_CERTS at ${inherited}.`);
    if (!fs.existsSync(recorded)) {
      return fail(`sidecar ${sidecar} names ${recorded}, which does not exist; keeping NODE_EXTRA_CA_CERTS at ${inherited}.`);
    }
    userCaPath = recorded;
  } else {
    // An external user PEM: no sidecar is expected yet, and this first build writes one.
    if (!fs.existsSync(inherited)) {
      return fail(`${inherited} does not exist; keeping NODE_EXTRA_CA_CERTS at ${inherited}.`);
    }
    userCaPath = inherited;
  }

  let userPem;
  try {
    userPem = fs.readFileSync(userCaPath);
  } catch (err) {
    return fail(`cannot read ${userCaPath}: ${err.message}; keeping NODE_EXTRA_CA_CERTS at ${inherited}.`);
  }

  let switcherPem;
  try {
    switcherPem = fs.readFileSync(switcherCaPath);
  } catch (err) {
    return fail(`cannot read the switcher CA ${switcherCaPath}: ${err.message}; keeping NODE_EXTRA_CA_CERTS at ${inherited}.`);
  }

  const bundlePath = paths.claudeCaBundle(userCaPath);
  const sidecarPath = paths.claudeCaBundleSidecar(userCaPath);
  const desired = Buffer.from(normalizePem(userPem) + normalizePem(switcherPem), 'utf8');

  let current = null;
  try {
    current = fs.readFileSync(bundlePath);
  } catch { /* no bundle yet */ }

  let sidecarOk = false;
  try {
    sidecarOk = fs.readFileSync(sidecarPath, 'utf8').trim() === path.resolve(userCaPath);
  } catch { /* no sidecar yet */ }

  // Content only: an untouched bundle is left alone, so a running tool never sees it churn.
  if (current && current.equals(desired) && sidecarOk) return { ok: true, path: bundlePath, rebuilt: false };

  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return fail(`cannot create ${stateDir}: ${err.message}; keeping NODE_EXTRA_CA_CERTS at ${inherited}.`);
  }

  // The sidecar goes first: the bundle may only exist once its origin is already recorded.
  try {
    writeModeAtomic(sidecarPath, `${path.resolve(userCaPath)}\n`, 0o600);
  } catch (err) {
    return fail(`cannot write ${sidecarPath}: ${err.message}; keeping NODE_EXTRA_CA_CERTS at ${inherited}.`);
  }

  try {
    writeModeAtomic(bundlePath, desired, 0o600);
  } catch (err) {
    return fail(`cannot write ${bundlePath}: ${err.message}; keeping NODE_EXTRA_CA_CERTS at ${inherited}.`);
  }

  return { ok: true, path: bundlePath, rebuilt: true };
}

// ---------------- config IO ----------------

let cachedConfig = null;
let lastSignature = '';
let lastLoadError = null;
let migrationError = null;
let migrationCollision = null;

export function getMigrationCollision() {
  return migrationCollision;
}

export function getMigrationError() {
  return migrationError;
}

export function getLastLoadError() {
  return lastLoadError;
}

export function getConfigLoadError() {
  return migrationError || lastLoadError;
}

// mtime alone misses a rewrite inside the same timestamp tick. Every save renames a new file into
// place, so the inode changes even then.
const fileSignature = (st) => `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;

function getClaudeSlots(p) {
  const slots = {};
  for (const s of CLAUDE_MODEL_SLOTS) {
    if (p.defaultModels && Object.hasOwn(p.defaultModels, s)) slots[s] = p.defaultModels[s];
  }
  return slots;
}

function getClaude1M(p) {
  const flags = {};
  for (const s of CLAUDE_MODEL_SLOTS) {
    if (p.model1M && Object.hasOwn(p.model1M, s)) flags[s] = p.model1M[s];
  }
  return flags;
}

function getCodexSlots(p) {
  const slots = {};
  for (const s of CODEX_MODEL_SLOTS) {
    if (p.defaultModels && Object.hasOwn(p.defaultModels, s)) slots[s] = p.defaultModels[s];
  }
  return slots;
}

function getCodex1M(p) {
  const flags = {};
  for (const s of CODEX_MODEL_SLOTS) {
    if (p.model1M && Object.hasOwn(p.model1M, s)) flags[s] = p.model1M[s];
  }
  return flags;
}

function createClaudeHalf(p) {
  const half = {};
  for (const [k, v] of Object.entries(p)) {
    if (['inFormat', 'blindfold', 'blindfoldPort', 'blindfoldHost', 'blindfoldPrefix', 'defaultModels', 'model1M', 'publicModels', 'codexRoles'].includes(k)) {
      continue;
    }
    half[k] = v;
  }
  half.tool = 'claude';

  const dm = {};
  if (p.defaultModels && typeof p.defaultModels === 'object') {
    for (const slot of CLAUDE_MODEL_SLOTS) {
      if (Object.hasOwn(p.defaultModels, slot)) dm[slot] = p.defaultModels[slot];
    }
    if (Object.hasOwn(p.defaultModels, 'default')) dm.default = p.defaultModels.default;
  }
  if (p.defaultModels && typeof p.defaultModels === 'object') half.defaultModels = dm;

  const m1m = {};
  if (p.model1M && typeof p.model1M === 'object') {
    for (const slot of CLAUDE_MODEL_SLOTS) {
      if (Object.hasOwn(p.model1M, slot)) m1m[slot] = p.model1M[slot];
    }
  }
  if (Object.keys(m1m).length > 0) half.model1M = m1m;

  return half;
}

function createCodexHalf(p) {
  const half = {};
  for (const [k, v] of Object.entries(p)) {
    if (['inFormat', 'blindfold', 'blindfoldPort', 'blindfoldHost', 'blindfoldPrefix', 'defaultModels', 'model1M', 'publicModels', 'codexRoles'].includes(k)) {
      continue;
    }
    half[k] = v;
  }
  half.tool = 'codex';
  if (Array.isArray(p.publicModels)) half.publicModels = [...p.publicModels];
  if (p.codexRoles && typeof p.codexRoles === 'object') half.codexRoles = { ...p.codexRoles };

  const dm = {};
  const srcDm = p.defaultModels && typeof p.defaultModels === 'object' ? p.defaultModels : {};
  for (const slot of CODEX_MODEL_SLOTS) {
    if (Object.hasOwn(srcDm, slot)) dm[slot] = srcDm[slot];
  }
  if (!Object.hasOwn(dm, 'main') && Object.hasOwn(srcDm, 'opus')) {
    dm.main = srcDm.opus;
  }
  if (!Object.hasOwn(dm, 'review') && Object.hasOwn(srcDm, 'sonnet')) {
    dm.review = srcDm.sonnet;
  }
  if (!Object.hasOwn(dm, 'subagent')) {
    for (const k of ['fast', 'fallback', 'haiku', 'fable']) {
      if (Object.hasOwn(srcDm, k)) {
        dm.subagent = srcDm[k];
        break;
      }
    }
  }
  if (Object.hasOwn(srcDm, 'default')) dm.default = srcDm.default;
  if (Object.keys(dm).length > 0) half.defaultModels = dm;

  const m1m = {};
  const srcM1m = p.model1M && typeof p.model1M === 'object' ? p.model1M : {};
  for (const slot of CODEX_MODEL_SLOTS) {
    if (Object.hasOwn(srcM1m, slot)) m1m[slot] = srcM1m[slot];
  }
  if (!Object.hasOwn(m1m, 'main') && Object.hasOwn(srcM1m, 'opus')) {
    m1m.main = srcM1m.opus;
  }
  if (!Object.hasOwn(m1m, 'review') && Object.hasOwn(srcM1m, 'sonnet')) {
    m1m.review = srcM1m.sonnet;
  }
  if (!Object.hasOwn(m1m, 'subagent')) {
    for (const k of ['fast', 'fallback', 'haiku', 'fable']) {
      if (Object.hasOwn(srcM1m, k)) {
        m1m.subagent = srcM1m[k];
        break;
      }
    }
  }
  if (Object.keys(m1m).length > 0) half.model1M = m1m;

  return half;
}

export function validateProfileInput(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'Profile must be an object';
  if (p.inFormat !== undefined) return 'inFormat is not supported; use "tool": "claude" or "tool": "codex"';
  if (p.blindfold !== undefined) return 'blindfold per-profile setting is deprecated';
  if (p.blindfoldPort !== undefined) return 'blindfoldPort per-profile setting is deprecated';
  if (p.blindfoldHost !== undefined) return 'blindfoldHost per-profile setting is deprecated';
  if (p.blindfoldPrefix !== undefined) return 'blindfoldPrefix per-profile setting is deprecated';
  if (p.tool !== undefined && p.tool !== null && !TOOLS.includes(p.tool)) {
    return `Invalid tool "${p.tool}". Valid: ${TOOLS.join(', ')}`;
  }
  return null;
}

export function needsMigration(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  if (Object.hasOwn(cfg, 'activeProfile')) return true;
  if (cfg.activeProfiles && typeof cfg.activeProfiles === 'object') {
    for (const k of LEGACY_TARGETS) {
      if (Object.hasOwn(cfg.activeProfiles, k)) return true;
    }
  }
  if (cfg.profiles && typeof cfg.profiles === 'object') {
    for (const [key, p] of Object.entries(cfg.profiles)) {
      if (COMMAND_WORDS.has(key.toLowerCase())) return true;
      if (!p || typeof p !== 'object') continue;
      if (Object.hasOwn(p, 'inFormat')) return true;
      if (Object.hasOwn(p, 'blindfold')) return true;
      if (Object.hasOwn(p, 'blindfoldPort')) return true;
      if (Object.hasOwn(p, 'blindfoldHost')) return true;
      if (Object.hasOwn(p, 'blindfoldPrefix')) return true;
      if (p.tool === undefined) {
        if (p.tool === null && p.disabled === true) {
          // already migrated retired profile
        } else {
          return true;
        }
      }
    }
  }
  if (Object.hasOwn(cfg, 'blindfold') && (typeof cfg.blindfold !== 'object' || cfg.blindfold === null || Array.isArray(cfg.blindfold))) {
    return true;
  }
  return false;
}

export function migrateConfigInMemory(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object') {
    return { config: rawConfig, collision: null, migrated: false, warnings: [] };
  }

  const warnings = [];
  const cfg = JSON.parse(JSON.stringify(rawConfig));
  const rawProfiles = rawConfig.profiles && typeof rawConfig.profiles === 'object' ? rawConfig.profiles : {};
  cfg.profiles = cfg.profiles && typeof cfg.profiles === 'object' ? cfg.profiles : {};

  // Step 1: Command-word renames (R7f, R6)
  const renameMap = new Map();
  for (const key of Object.keys(rawProfiles)) {
    if (COMMAND_WORDS.has(key.toLowerCase())) {
      const newKey = `${key}-profile`;
      renameMap.set(key, newKey);
      cfg.profiles[newKey] = cfg.profiles[key];
      delete cfg.profiles[key];
      warnings.push(`Profile "${key}" renamed to "${newKey}" because "${key}" is a command word.`);
    }
  }

  const rawActiveMap = getActiveMap(rawConfig);
  const splitMap = new Map();
  const clashingKeys = [];
  const initialKeysLower = new Set(Object.keys(rawProfiles).map(k => k.toLowerCase()));

  // Step 2: Profile classification & splitting (R7)
  const profilesToProcess = Object.entries(cfg.profiles);

  for (const [key, p] of profilesToProcess) {
    if (!p || typeof p !== 'object') continue;

    let originalKey = key;
    for (const [orig, ren] of renameMap.entries()) {
      if (ren === key) { originalKey = orig; break; }
    }

    const inFmt = p.inFormat !== undefined && p.inFormat !== null ? String(p.inFormat).trim().toLowerCase() : null;

    // R7(a): a profile that already declares `tool` is already migrated. It only loses a
    // leftover `inFormat`/`blindfold*` (cleanup pass below) and is never classified or split again.
    if (Object.hasOwn(p, 'tool')) {
      continue;
    }

    if (inFmt === 'anthropic') {
      p.tool = 'claude';
      continue;
    }
    if (inFmt === 'responses') {
      p.tool = 'codex';
      continue;
    }
    if (inFmt && inFmt !== 'auto' && inFmt !== '') {
      p.tool = null;
      p.disabled = true;
      warnings.push(`Unknown or retired format "${p.inFormat}" for profile "${key}"; profile disabled.`);
      continue;
    }

    const claudeSlots = getClaudeSlots(p);
    const claude1M = getClaude1M(p);
    const codexSlots = getCodexSlots(p);
    const codex1M = getCodex1M(p);
    const hasClaude = Object.keys(claudeSlots).length > 0 || Object.keys(claude1M).length > 0;
    const hasCodex = Object.keys(codexSlots).length > 0 || Object.keys(codex1M).length > 0
      || (Array.isArray(p.publicModels) && p.publicModels.length > 0)
      || (p.codexRoles && Object.keys(p.codexRoles).length > 0);

    const activeForResponses = (rawActiveMap.codex === originalKey);
    const activeForAnthropic = (rawActiveMap.claude === originalKey);

    let shouldSplit = false;
    let singleTool = null;

    if (hasClaude && hasCodex) {
      shouldSplit = true;
    } else if (hasClaude && !hasCodex) {
      if (activeForResponses) {
        shouldSplit = true;
      } else {
        singleTool = 'claude';
      }
    } else if (hasCodex && !hasClaude) {
      if (activeForAnthropic) {
        shouldSplit = true;
      } else {
        singleTool = 'codex';
      }
    } else {
      if (activeForResponses) {
        shouldSplit = true;
      } else {
        singleTool = 'claude';
      }
    }

    if (singleTool) {
      p.tool = singleTool;
    } else if (shouldSplit) {
      const claudeKey = `${key}-claude`;
      const codexKey = `${key}-codex`;

      for (const candidate of [claudeKey, codexKey]) {
        const candidateLower = candidate.toLowerCase();
        if (initialKeysLower.has(candidateLower) && candidateLower !== originalKey.toLowerCase()) {
          clashingKeys.push(candidate);
        }
      }

      splitMap.set(key, { claude: claudeKey, codex: codexKey });
      if (originalKey !== key) {
        splitMap.set(originalKey, { claude: claudeKey, codex: codexKey });
      }

      const claudeProfile = createClaudeHalf(p);
      const codexProfile = createCodexHalf(p);

      delete cfg.profiles[key];
      cfg.profiles[claudeKey] = claudeProfile;
      cfg.profiles[codexKey] = codexProfile;
    }
  }

  for (const [orig, ren] of renameMap.entries()) {
    const renLower = ren.toLowerCase();
    if (initialKeysLower.has(renLower) && renLower !== orig.toLowerCase()) {
      clashingKeys.push(ren);
    }
  }

  if (clashingKeys.length > 0) {
    return {
      config: rawConfig,
      collision: { clashingKeys: [...new Set(clashingKeys)], originalConfig: rawConfig },
      migrated: false,
      warnings
    };
  }

  // Step 3: Pointer migration (R7b, Item 2)
  const newActiveProfiles = {};
  if (rawConfig.activeProfiles && Object.hasOwn(rawConfig.activeProfiles, 'claude')) {
    newActiveProfiles.claude = rawConfig.activeProfiles.claude;
  } else {
    let oldClaudeTarget = null;
    if (rawConfig.activeProfiles && Object.hasOwn(rawConfig.activeProfiles, 'anthropic')) {
      oldClaudeTarget = rawConfig.activeProfiles.anthropic;
    } else if (rawConfig.activeProfile) {
      oldClaudeTarget = rawConfig.activeProfile;
    }
    if (oldClaudeTarget) {
      let resolvedKey = renameMap.get(oldClaudeTarget) || oldClaudeTarget;
      if (splitMap.has(resolvedKey)) {
        resolvedKey = splitMap.get(resolvedKey).claude;
      }
      const prof = cfg.profiles[resolvedKey];
      if (prof && prof.tool === 'claude') {
        newActiveProfiles.claude = resolvedKey;
      } else {
        newActiveProfiles.claude = null;
      }
    } else {
      newActiveProfiles.claude = null;
    }
  }

  if (rawConfig.activeProfiles && Object.hasOwn(rawConfig.activeProfiles, 'codex')) {
    newActiveProfiles.codex = rawConfig.activeProfiles.codex;
  } else {
    let oldCodexTarget = null;
    if (rawConfig.activeProfiles && Object.hasOwn(rawConfig.activeProfiles, 'responses')) {
      oldCodexTarget = rawConfig.activeProfiles.responses;
    } else if (rawConfig.activeProfile) {
      oldCodexTarget = rawConfig.activeProfile;
    }
    if (oldCodexTarget) {
      let resolvedKey = renameMap.get(oldCodexTarget) || oldCodexTarget;
      if (splitMap.has(resolvedKey)) {
        resolvedKey = splitMap.get(resolvedKey).codex;
      }
      const prof = cfg.profiles[resolvedKey];
      if (prof && prof.tool === 'codex') {
        newActiveProfiles.codex = resolvedKey;
      } else {
        newActiveProfiles.codex = null;
      }
    } else {
      newActiveProfiles.codex = null;
    }
  }

  cfg.activeProfiles = newActiveProfiles;
  delete cfg.activeProfile;

  // Step 4: R3b top-level blindfold.port resolution (R3b)
  let topBlindfold = null;
  if (cfg.blindfold && typeof cfg.blindfold === 'object' && !Array.isArray(cfg.blindfold)) {
    topBlindfold = cfg.blindfold;
  }

  const gatewayPort = parsePort(cfg.port) || DEFAULT_PORT;
  let defaultBfPort = DEFAULT_BLINDFOLD_PORT;
  if (gatewayPort === defaultBfPort) {
    defaultBfPort = gatewayPort + 1;
  }

  if (topBlindfold && parsePort(topBlindfold.port)) {
    let bfP = parsePort(topBlindfold.port);
    if (bfP === gatewayPort) {
      bfP = gatewayPort === DEFAULT_BLINDFOLD_PORT ? DEFAULT_BLINDFOLD_PORT + 1 : DEFAULT_BLINDFOLD_PORT;
      warnings.push(`blindfold.port ${topBlindfold.port} conflicts with gateway port ${gatewayPort}; changed to ${bfP}`);
    }
    cfg.blindfold = { ...topBlindfold, port: bfP };
  } else {
    let candidatePort = null;
    const activeCodexKey = cfg.activeProfiles?.codex;
    let rawActiveCodexProf = null;
    if (activeCodexKey) {
      for (const [origKey, p] of Object.entries(rawProfiles)) {
        const ren = renameMap.get(origKey) || origKey;
        const split = splitMap.get(ren);
        if (ren === activeCodexKey || (split && split.codex === activeCodexKey)) {
          rawActiveCodexProf = p;
          break;
        }
      }
    }

    if (rawActiveCodexProf && rawActiveCodexProf.blindfold && parsePort(rawActiveCodexProf.blindfoldPort)) {
      candidatePort = parsePort(rawActiveCodexProf.blindfoldPort);
    } else {
      const ports = [];
      for (const [k, p] of Object.entries(rawProfiles)) {
        if (!p || p.disabled) continue;
        const ren = renameMap.get(k) || k;
        const split = splitMap.get(ren);
        const codexResultKey = split ? split.codex : ren;
        const resProf = cfg.profiles[codexResultKey];
        if (resProf && resProf.tool === 'codex') {
          if (p.blindfold && parsePort(p.blindfoldPort)) {
            const bp = parsePort(p.blindfoldPort);
            if (bp !== DEFAULT_BLINDFOLD_PORT) ports.push(bp);
          }
        }
      }
      if (ports.length > 0) {
        candidatePort = Math.min(...ports);
      }
    }

    let finalBfPort = candidatePort || defaultBfPort;
    if (finalBfPort === gatewayPort) {
      finalBfPort = gatewayPort === DEFAULT_BLINDFOLD_PORT ? DEFAULT_BLINDFOLD_PORT + 1 : DEFAULT_BLINDFOLD_PORT;
    }
    cfg.blindfold = { port: finalBfPort };
  }

  // Clean up all result profiles: delete inFormat and blindfold* fields
  for (const [k, p] of Object.entries(cfg.profiles)) {
    if (p && typeof p === 'object') {
      if (p.blindfoldHost && p.blindfoldHost !== LEGACY_DEFAULT_BLINDFOLD_HOST) {
        warnings.push(`Profile "${k}" has custom blindfoldHost "${p.blindfoldHost}" which is no longer supported and was dropped.`);
      }
      if (p.blindfoldPrefix && p.blindfoldPrefix !== LEGACY_DEFAULT_BLINDFOLD_PREFIX) {
        warnings.push(`Profile "${k}" has custom blindfoldPrefix "${p.blindfoldPrefix}" which is no longer supported and was dropped.`);
      }
      delete p.inFormat;
      delete p.blindfold;
      delete p.blindfoldPort;
      delete p.blindfoldHost;
      delete p.blindfoldPrefix;
    }
  }

  return { config: cfg, collision: null, migrated: true, warnings };
}

export function saveConfigAtomicCAS(migratedBytes, originalBytes, targetPath = configPath) {
  let attempts = 0;
  let currentOriginal = originalBytes;
  let currentMigrated = migratedBytes;
  const createdBackups = [];
  const createdTmps = [];

  while (attempts < 3) {
    attempts++;
    const rand = crypto.randomBytes(4).toString('hex');
    const tmp = `${targetPath}.${process.pid}.${rand}.tmp`;
    const bak = path.join(path.dirname(targetPath), `config.json.bak-${Date.now()}-${process.pid}-${rand}`);
    let renameFinished = false;

    try {
      createdTmps.push(tmp);
      fs.writeFileSync(tmp, currentMigrated, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(tmp, 0o600);

      createdBackups.push(bak);
      fs.writeFileSync(bak, currentOriginal, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(bak, 0o600);

      const diskBytes = fs.readFileSync(targetPath);
      if (diskBytes.equals(currentOriginal)) {
        fs.renameSync(tmp, targetPath);
        renameFinished = true;
        try {
          fs.chmodSync(targetPath, 0o600);
        } catch {}
        return { ok: true, config: JSON.parse(currentMigrated.toString('utf8')) };
      }

      // Mismatch
      try { fs.rmSync(tmp, { force: true }); } catch {}
      try { fs.rmSync(bak, { force: true }); } catch {}
      createdTmps.pop();
      createdBackups.pop();

      let diskParsed;
      try {
        diskParsed = JSON.parse(diskBytes.toString('utf8'));
      } catch {
        throw new Error('config.json contains invalid JSON on disk during CAS retry');
      }

      if (!needsMigration(diskParsed)) {
        return { ok: true, config: diskParsed, noMigrationNeeded: true };
      }

      const reResult = migrateConfigInMemory(diskParsed);
      if (reResult.collision) {
        return { collision: reResult.collision };
      }

      currentOriginal = diskBytes;
      currentMigrated = Buffer.from(JSON.stringify(reResult.config, null, 2), 'utf8');
    } catch (err) {
      if (renameFinished) {
        return { ok: true, config: JSON.parse(currentMigrated.toString('utf8')) };
      }
      try { fs.rmSync(tmp, { force: true }); } catch {}
      try { fs.rmSync(bak, { force: true }); } catch {}
      throw err;
    }
  }

  for (const t of createdTmps) {
    try { fs.rmSync(t, { force: true }); } catch {}
  }
  for (const b of createdBackups) {
    try { fs.rmSync(b, { force: true }); } catch {}
  }
  const casErr = new Error('CAS failed after 3 attempts');
  return { error: casErr };
}

// Cached config read. If the file is half-written (invalid JSON), keep the old cached copy.
export function loadConfig() {
  try {
    const stat = fs.statSync(configPath);
    const currentSig = fileSignature(stat);
    if (!cachedConfig || currentSig !== lastSignature) {
      lastLoadError = null;
      migrationError = null;
      migrationCollision = null;

      const rawBytes = fs.readFileSync(configPath);
      const parsed = JSON.parse(rawBytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('config root must be an object');
      if (!parsed.profiles || typeof parsed.profiles !== 'object') parsed.profiles = {};

      if (needsMigration(parsed)) {
        const migResult = migrateConfigInMemory(parsed);
        if (migResult.collision) {
          migrationCollision = migResult.collision;
          cachedConfig = parsed;
          lastSignature = currentSig;
          return cachedConfig;
        }

        const migratedBytes = Buffer.from(JSON.stringify(migResult.config, null, 2), 'utf8');
        try {
          const casRes = saveConfigAtomicCAS(migratedBytes, rawBytes, configPath);
          if (casRes.ok) {
            cachedConfig = casRes.config || migResult.config;
            try {
              const newStat = fs.statSync(configPath);
              lastSignature = fileSignature(newStat);
            } catch {
              lastSignature = '';
            }
          } else if (casRes.collision) {
            migrationCollision = casRes.collision;
            cachedConfig = parsed;
            lastSignature = currentSig;
          } else if (casRes.error) {
            migrationError = casRes.error;
            cachedConfig = parsed;
            lastSignature = currentSig;
          }
        } catch (casErr) {
          migrationError = casErr;
          cachedConfig = parsed;
          lastSignature = currentSig;
        }
      } else {
        cachedConfig = parsed;
        lastSignature = currentSig;
      }
    }
  } catch (err) {
    lastLoadError = err;
  }
  return cachedConfig;
}

// Atomic write (tmp + rename) so a running proxy never reads a half-written file.
// The tmp file is created 0600 and renamed over config.json, so the keys are never readable by
// another account, even when an earlier release left config.json at 0644.
export function saveConfig(cfg) {
  if (migrationCollision) {
    throw new Error(`Refusing to save: configuration migration collision: ${JSON.stringify(migrationCollision.clashingKeys)}`);
  }
  if (migrationError) {
    throw new Error(`Refusing to save: configuration migration failed: ${migrationError.message}`);
  }
  const tmp = `${configPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  const ino = fs.statSync(tmp).ino;
  fs.renameSync(tmp, configPath);
  cachedConfig = cfg;
  try {
    const st = fs.statSync(configPath);
    lastSignature = st.ino === ino ? fileSignature(st) : '';
  } catch {
    lastSignature = '';
  }
}

// R7b: `switch off` has to work while saveConfig refuses — a collision means this build will not
// rewrite config.json, but turning one tool off is still a write the user asked for. Re-read the file,
// change only the pointer(s) that name a tool, and hand both byte buffers to the CAS writer, so the
// top-level legacy pointers and the retired keys inside activeProfiles come back exactly as they were.
// Throws when config.json cannot be read or parsed; otherwise returns what saveConfigAtomicCAS returns.
export function casClearToolPointers(tools) {
  const original = fs.readFileSync(configPath);
  const next = JSON.parse(original.toString('utf8'));
  const active = (next.activeProfiles && typeof next.activeProfiles === 'object')
    ? next.activeProfiles
    : (next.activeProfiles = {});
  for (const tool of tools) active[tool] = null;
  return saveConfigAtomicCAS(Buffer.from(JSON.stringify(next, null, 2), 'utf8'), original, configPath);
}

// ---------------- contract lab ----------------

export const CONTRACT_LAB_OFF = { url: '', apiKey: '', enabled: false };

// The top-level `contractLab` block, normalized. It stays off unless the block names an http(s)
// intact URL and a key, so a half-filled block never starts sampling.
export function contractLabSettings(cfg) {
  const raw = cfg?.contractLab;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...CONTRACT_LAB_OFF };
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  let url = '';
  try {
    const parsed = new URL(typeof raw.url === 'string' ? raw.url.trim() : '');
    if (['http:', 'https:'].includes(parsed.protocol)) url = String(raw.url).trim().replace(/\/+$/, '');
  } catch {}
  return { url, apiKey, enabled: raw.enabled === true && Boolean(url) && Boolean(apiKey) };
}

// ---------------- helpers ----------------

export function hasProfile(cfg, key) {
  return Boolean(key) && Boolean(cfg?.profiles) && Object.hasOwn(cfg.profiles, key);
}

export function isValidProfileKey(key) {
  if (typeof key !== 'string') return false;
  if (COMMAND_WORDS.has(key.toLowerCase())) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key);
}

export function isValidTarget(target) {
  return TOOLS.includes(target) || Object.hasOwn(LEGACY_TARGET_TOOL, target);
}

// Case-insensitive profile lookup (CLI accepts `switch MyProfile` or `switch myprofile`).
export function findProfileKey(cfg, name) {
  if (!name || !cfg?.profiles) return null;
  if (hasProfile(cfg, name)) return name;
  const lower = String(name).toLowerCase();
  return Object.keys(cfg.profiles).find(k => k.toLowerCase() === lower) || null;
}

export function profileAcceptsTarget(profile, target) {
  if (profile?.tool) {
    if (target === 'claude' || target === 'anthropic') return profile.tool === 'claude';
    if (target === 'codex' || target === 'responses') return profile.tool === 'codex';
    return false;
  }
  const inFmt = profile?.inFormat || 'auto';
  if (inFmt === 'auto') return true;
  if (inFmt === 'anthropic') return target === 'anthropic' || target === 'claude';
  if (inFmt === 'responses') return target === 'responses' || target === 'codex';
  return inFmt === target;
}

export function modelSlotsForProfile(profile) {
  if (profile?.tool === 'claude') return CLAUDE_MODEL_SLOTS;
  if (profile?.tool === 'codex') return CODEX_MODEL_SLOTS;
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
// Codex parses a --config value as TOML before it falls back to a string, and the Windows shim passes
// the name unquoted. A name that TOML reads as a number, a boolean or a date would change type.
const TOML_NON_STRING = /^([+-]?(0x[0-9a-f_]+|0o[0-7_]+|0b[01_]+|inf|nan|[\d_]+(\.[\d_]+)?(e[+-]?[\d_]+)?)|true|false|\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:\d{2})?)?|[^a-z]*)$/i;

export function isSafeModelName(name) {
  return typeof name === 'string' && SAFE_MODEL_NAME.test(name) && !TOML_NON_STRING.test(name);
}

// Codex compares the handshake model with the one it asked for, and reads its /model catalog from publicModels.
export function codexPublicModelsWarning(key, profile) {
  if (!profile || isSafeModelName(codexPublicModel(profile, 'main'))) return '';
  return `Profile "${key}" serves Codex but has no publicModels. Codex gets no model catalog and shows false `
    + `"model metadata not found" and "high-risk cyber activity" warnings. Add for example `
    + `"publicModels": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], then run \`switch codex ${key}\` again.`;
}

/**
 * The host table of R3: every host the interceptor answers on, and the only hosts this CA may
 * sign for (blindfold/make-certs.sh builds exactly these). One leaf serves all three, because the
 * interceptor presents the same certificate whichever host the tool dialled — a leaf from an
 * older version covers one host and fails the other two with a TLS error that reads like a
 * network fault.
 */
export const INTERCEPT_HOSTS = Object.freeze(['api.anthropic.com', 'api.openai.com', 'chatgpt.com']);

/**
 * Does this leaf certificate cover the host the interceptor will present it for?
 * Changing the host table without rebuilding the leaf produces a TLS error that reads
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

// One catalog entry. /v1/models and the OpenAI-Model handshake both use it, so they cannot drift.
// model-catalog.json itself is no longer written (R9: publicModels stays the gateway's mapping table).
export function codexModelEntry(name, is1M) {
  // The template copies a real OpenAI model. Its Responses Lite and code modes send the tools in a
  // form made for OpenAI's own tools, and an upstream then gets none (LS-5).
  const { tool_mode, ...template } = structuredClone(codexCatalogTemplate() || {});
  return {
    ...template,
    use_responses_lite: false,
    slug: name,
    display_name: name,
    ...(is1M ? { context_window: 1000000, max_context_window: 1000000 } : {})
  };
}

// name -> is1M. The picker sizes a session from this window, so when two slots share a name the
// smaller window wins: overstating it makes Codex plan against space it does not have.
export function smallestWindows(pairs) {
  const windows = new Map();
  for (const [name, is1M] of pairs) {
    if (!name) continue;
    if (!windows.has(name) || !is1M) windows.set(name, Boolean(is1M));
  }
  return windows;
}

export function publicModelWindows(profile) {
  return smallestWindows(CODEX_MODEL_SLOTS.map(slot => [codexPublicModel(profile, slot), model1MForSlot(profile, slot)]));
}

export function parsePort(value) {
  const p = parseInt(value, 10);
  return Number.isInteger(p) && p > 0 && p <= 65535 ? p : null;
}

// Precedence: --port / -p > LLM_SWITCHER_PORT > config.port > 3456. A generic PORT is ignored: other
// tools (dev servers) set it, and it would move the gateway in silence.
export function resolvePort(argv = process.argv.slice(2), cfg = loadConfig()) {
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--port' || argv[i] === '-p') && argv[i + 1]) {
      const p = parsePort(argv[i + 1]);
      if (p) return p;
    }
  }
  const envP = parsePort(process.env.LLM_SWITCHER_PORT);
  if (envP) return envP;
  return parsePort(cfg?.port) || DEFAULT_PORT;
}

// The whole map, and nothing else: `{ claude, codex }`. A pointer that is present wins even
// when its value is null — an explicit "off" must never fall back to the legacy single
// pointer and re-enable a tool under a different API key. This is the same chain
// deriveActiveTools walks, so the launcher state and the interceptor's tool set can never
// disagree about which tools are on.
export function getActiveMap(cfg) {
  const ap = cfg?.activeProfiles || {};
  const pointer = (tool, legacy) => (
    Object.hasOwn(ap, tool) ? ap[tool]
      : Object.hasOwn(ap, legacy) ? ap[legacy]
        : cfg?.activeProfile ?? null
  );
  return { claude: pointer('claude', 'anthropic'), codex: pointer('codex', 'responses') };
}

/**
 * Which tools this config points at a profile, rendered as the interceptor's `--active-tools`
 * list (F2, Finding 6). The chain accepts both key spellings in the wild — the newer `claude` /
 * `codex` and the older `anthropic` / `responses` — and a key that is present wins even when its
 * value is null: an explicit "off" must never fall through to the legacy single pointer.
 * Codex counts only when the profile it lands on can serve Codex; and a pointer that names no
 * profile we can inspect is not evidence that Codex is off, so Codex stays on.
 */
export function deriveActiveTools(raw) {
  const ap = raw?.activeProfiles || {};
  const pointer = (key, legacy) => (
    Object.hasOwn(ap, key) ? ap[key]
      : Object.hasOwn(ap, legacy) ? ap[legacy]
        : raw?.activeProfile ?? null
  );
  const tools = [];
  if (pointer('claude', 'anthropic')) tools.push('claude');
  const codexProfile = pointer('codex', 'responses');
  if (codexProfile && (!hasProfile(raw, codexProfile) || profileAcceptsTarget(raw.profiles[codexProfile], 'codex'))) {
    tools.push('codex');
  }
  return tools.sort();
}

function ensureActiveMap(cfg) {
  cfg.activeProfiles = getActiveMap(cfg);
  return cfg.activeProfiles;
}

// ---------------- mutations (do not persist by themselves) ----------------

// Assign a profile to one tool. Returns an error string or null.
export function setTargetProfile(cfg, target, profileKey) {
  // `anthropic` and `responses` are spellings of `claude` and `codex`, not targets of their
  // own; `openai-chat` and `vertex` are no longer a target a caller may name at all.
  const tool = TOOLS.includes(target) ? target
    : (Object.hasOwn(LEGACY_TARGET_TOOL, target) ? LEGACY_TARGET_TOOL[target] : null);
  if (!tool) return `Unknown target "${target}". Valid: ${TOOLS.join(', ')}`;
  const map = ensureActiveMap(cfg);
  if (!profileKey) {
    map[tool] = null;
    return null;
  }
  if (!hasProfile(cfg, profileKey)) return `Profile "${profileKey}" does not exist`;
  const p = cfg.profiles[profileKey];
  if (!profileAcceptsTarget(p, tool)) {
    return `Profile "${profileKey}" only accepts "${p.tool || p.inFormat}" input and cannot serve target "${tool}"`;
  }
  map[tool] = profileKey;
  cfg.activeProfile = profileKey;
  return null;
}

// Enable a profile for every target it supports (inFormat auto -> all).
export function activateProfile(cfg, profileKey) {
  if (!hasProfile(cfg, profileKey)) return `Profile "${profileKey}" does not exist`;
  const map = ensureActiveMap(cfg);
  const p = cfg.profiles[profileKey];
  for (const t of TOOLS) {
    if (profileAcceptsTarget(p, t)) map[t] = profileKey;
  }
  cfg.activeProfile = profileKey;
  return null;
}

// Disable exactly the targets using this profile (leaves other targets untouched).
export function deactivateProfile(cfg, profileKey) {
  const map = ensureActiveMap(cfg);
  for (const t of TOOLS) {
    if (map[t] === profileKey) map[t] = null;
  }
}

export function deactivateAll(cfg) {
  cfg.activeProfiles = Object.fromEntries(TOOLS.map(t => [t, null]));
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

// The main session model. Haiku is left out on purpose: a haiku-only 1M profile would otherwise
// move the main session to Haiku. claude1MTiers reports every tier, haiku included.
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
  const claude = pick('claude');
  const codex = pick('codex');
  const active = Boolean(claude || codex);

  // One interceptor serves both tools (R3) and its port lives at the top level of config.json
  // (R3b). The per-profile port went with the per-profile host and prefix.
  const bfPort = parsePort(cfg?.blindfold?.port) || DEFAULT_BLINDFOLD_PORT;
  const interceptor = `http://127.0.0.1:${bfPort}`;
  const loopbackOnly = '127.0.0.1,localhost';
  const proxyPairs = () => [
    ['HTTPS_PROXY', interceptor],
    ['https_proxy', interceptor],
    ['NO_PROXY', loopbackOnly],
    ['no_proxy', loopbackOnly]
  ];

  const state = {
    active,
    // R3b: host and prefix are gone. The interceptor answers on the fixed host table of R3, so
    // there is nothing left to choose; what the launcher still needs as data is the port, the CA
    // and the tool set. The tool set travels sorted as one string (Finding 6), which is also what
    // lets a running interceptor be updated in place instead of restarted.
    // null when no tool is active, which is how reconcileBlindfold knows to stop it.
    blindfold: active
      ? {
        port: bfPort,
        activeTools: deriveActiveTools(cfg).join(','),
        ca: paths.blindfoldCA
      }
      : null,
    // Exactly the variables of R2, each in its own file (A1). Nothing here is a value a coding
    // tool reads as configuration: no base URL, no model name, no CLAUDE_CODE_* / OPENAI_*,
    // no --config (F1, F3, F4). The shim of the tool may therefore never capture the traffic
    // of the other tool, and a restart cannot leave a stale override behind.
    envClaude: [],
    envCodex: []
  };

  // NODE_EXTRA_CA_CERTS is deliberately absent from env-claude: the shim decides it at launch,
  // because only then does it know whether the user brought a CA of their own (R2).
  if (claude) state.envClaude = proxyPairs();
  if (codex) state.envCodex = [...proxyPairs(), ['CODEX_CA_CERTIFICATE', paths.blindfoldCA]];
  return state;
}

// tmp + rename: a launcher never sources a half-written env file.
function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

const LAUNCH_LOCK = path.join(STATE_DIR, '.launch.lock');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const readLock = () => { try { return fs.readFileSync(LAUNCH_LOCK, 'utf8'); } catch { return null; } };

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// The CLI and the gateway both write the launch files, one file at a time. Without turns, two writers
// that overlap leave env.sh from one state and env-codex.sh from another. The writes take milliseconds,
// so a holder that no longer runs, or that keeps the lock for 5 s, is taken over.
function withLaunchLock(fn) {
  const mine = String(process.pid);
  const tmp = `${LAUNCH_LOCK}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, mine, { mode: 0o600 });
  try {
    for (let waited = 0; ; waited += 25) {
      try {
        // link, not create-then-write: the lock never exists without the holder's pid in it.
        fs.linkSync(tmp, LAUNCH_LOCK);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const holder = readLock();
        const pid = parseInt(holder, 10);
        const stale = (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) || waited >= 5000;
        // Remove only the lock that was judged stale; another taker may have replaced it already.
        if (stale && readLock() === holder) fs.rmSync(LAUNCH_LOCK, { force: true });
        else pause(25);
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  try {
    return fn();
  } finally {
    if (readLock() === mine) fs.rmSync(LAUNCH_LOCK, { force: true });
  }
}

// Neutral stubs. A shell rc that still sources env.sh / env.cmd gets nothing new, so an old rc
// line can never re-introduce a base URL the shim just scrubbed (R8). They are overwritten and
// never unlinked: a missing file would turn that rc line into an error instead of silence.
const STUB_SH = '# Neutral stub - LLM Switcher\n';
const STUB_CMD = 'REM Neutral stub - LLM Switcher\r\n';

function renderSh(pairs) {
  return ['#!/usr/bin/env sh', '# Auto-generated by LLM Switcher for the active tool',
    ...pairs.map(([k, v]) => `export ${k}='${String(v).replace(/'/g, `'\\''`)}'`)].join('\n') + '\n';
}
function renderCmd(pairs) {
  return ['@echo off', 'REM Auto-generated by LLM Switcher for the active tool',
    ...pairs.map(([k, v]) => `SET "${k}=${v}"`)].join('\r\n') + '\r\n';
}

// An empty file means "this tool is off": the shim then leaves the tool's environment alone and
// the tool reaches its official endpoint. Empty, never deleted — a deleted file would make a
// stale shell variable survive with nothing left to scrub it.
function writeToolFiles(pairs, shPath, cmdPath) {
  if (pairs.length) {
    writeAtomic(cmdPath, renderCmd(pairs));
    writeAtomic(shPath, renderSh(pairs));
  } else {
    writeAtomic(cmdPath, '');
    writeAtomic(shPath, '');
  }
}

// `switch off <tool>` while saveConfig refuses (R7b) cannot use applyLaunchState: that derives both
// tools from activeProfiles, and a colliding config is one this build will not migrate. This empties
// only the file pair of the tool that was switched off, under the same lock, so the other tool's
// launcher files are never opened (A13: emptied, never deleted).
export function emptyToolEnvFiles(tool) {
  const codex = tool === 'codex';
  withLaunchLock(() => {
    writeAtomic(codex ? paths.envCodexCmd : paths.envClaudeCmd, '');
    writeAtomic(codex ? paths.envCodexSh : paths.envClaudeSh, '');
  });
}

// Write the per-tool env files from activeProfiles. settings.json is never touched here: it
// belongs to the coding tool (R1), and model-catalog.json is no longer written (R9).
export function applyLaunchState(cfg, port, opts = {}) {
  return withLaunchLock(() => writeLaunchState(cfg, port, opts));
}

function writeLaunchState(cfg, port) {
  const st = computeLaunchState(cfg, port);

  // Env files first, the flag last: a flag that says "active" while a file is missing or stale
  // makes the launcher route with the wrong variables. A failed write leaves the flag as it was.
  try {
    writeToolFiles(st.envClaude, paths.envClaudeSh, paths.envClaudeCmd);
    writeToolFiles(st.envCodex, paths.envCodexSh, paths.envCodexCmd);
    // Recorded on switch on so a shell opened while the gateway ran can still recognize its own
    // stale loopback URL later, after the port changed (R8).
    if (st.active) writeAtomic(paths.gatewayPort, `${port}\n`);
    // The stub always wins: an env.sh left by an older release must not survive a switch.
    writeAtomic(paths.envCmd, STUB_CMD);
    writeAtomic(paths.envSh, STUB_SH);
  } catch (err) {
    st.envWriteError = err.message;
    return st;
  }
  writeOrRemove(paths.activeFlag, st.active ? 'active' : null);
  return st;
}

export function clearLaunchState(port) {
  withLaunchLock(() => {
    writeOrRemove(paths.activeFlag, null);
    // Stubs rather than deletions, and the tool files emptied rather than removed (R8, A13):
    // `switch off claude` must leave an empty claude file behind, and bare `switch off` must
    // leave env.sh present and containing no export and no unset.
    writeAtomic(paths.envCmd, STUB_CMD);
    writeAtomic(paths.envSh, STUB_SH);
    for (const f of [paths.envClaudeCmd, paths.envClaudeSh, paths.envCodexCmd, paths.envCodexSh]) {
      writeAtomic(f, '');
    }
  });
  // settings.json belongs to the coding tool: the switcher neither reads nor writes it (R1).
  return { changed: false, removed: [] };
}

export function readLaunchFlags() {
  // Only "is the gateway wired in". The 1M flags went with the forced window (R9): the tool
  // sizes a session from the window of the official model the user picked.
  return { isUsingProxy: fs.existsSync(paths.activeFlag) };
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
  const lab = clone.contractLab;
  if (lab && typeof lab === 'object' && !Array.isArray(lab)) {
    lab.hasApiKey = Boolean(lab.apiKey);
    lab.apiKey = lab.apiKey ? MASKED_KEY : '';
  }
  return clone;
}

// ---------------- process identity ----------------
// An answer on a port proves nothing: any local process can bind a free port and replay a /health
// body. Only a process that can read admin.token can answer HMAC(token, nonce) for a fresh nonce.
// The MAC covers role, listening port, pid and arguments: a proof relayed from the process on
// another port, or a body with an edited pid, no longer verifies. blindfold.mjs signs the same fields.
// R3 replaced `host` and `prefix` with the active tool set, so the two builds sign different
// fields. Both must verify: a running interceptor from the older build is still ours, and an
// answer that stops verifying would make stopping it look like tampering with a foreign
// process that merely holds the port we need back.
export function identityProof(nonce, { role, port, pid, gatewayPort = '', activeTools = '' }, token = readAdminToken()) {
  if (!token) return '';
  return crypto.createHmac('sha256', token).update([role, port, pid, gatewayPort, activeTools, nonce].join('|')).digest('hex');
}

export function legacyIdentityProof(nonce, { role, port, pid, gatewayPort = '', host = '', prefix = '' }, token = readAdminToken()) {
  if (!token) return '';
  return crypto.createHmac('sha256', token).update([role, port, pid, gatewayPort, host, prefix, nonce].join('|')).digest('hex');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A busy but genuine process can take a moment; a squatter gains nothing from a longer wait.
// Settles exactly once, on every path. A pending probe holds the gateway's admin chain, so an answer
// that is too large, or one that trickles without end, must still end the probe.
function getJson(port, pathname, timeoutMs = 3000) {
  return new Promise(resolve => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      resolve(result);
    };
    // A listener that never answers can be a hung gateway of ours; the caller must not call it foreign.
    // The socket timeout restarts on every byte, so the whole probe also has a deadline.
    const deadline = setTimeout(() => done({ state: 'silent' }), timeoutMs);
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; if (data.length > 65536) done({ state: 'foreign' }); });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch {}
        done({ state: 'answered', body });
      });
      res.on('error', () => done({ state: 'foreign' }));
    });
    req.on('error', err => done({ state: err.code === 'ECONNREFUSED' ? 'free' : 'foreign' }));
    req.on('timeout', () => done({ state: 'silent' }));
  });
}

const newNonce = () => crypto.randomBytes(16).toString('hex');

/** 'ours' | 'legacy' | 'foreign' | 'silent' | 'free'. Treat 'legacy' and 'silent' like 'foreign' in every decision. */
export async function probeGateway(port) {
  const nonce = newNonce();
  const r = await getJson(port, `/health?challenge=${nonce}`);
  if (r.state !== 'answered') return r.state;
  const b = r.body;
  if (b?.proxy !== 'llm-switcher' || b.port !== port) return 'foreign';
  // Gateways before 1.1.1 answer without a proof: name them, but never trust them enough to stop them.
  if (!('proof' in b)) return 'legacy';
  const proof = identityProof(nonce, { role: 'gateway', port, pid: b.pid });
  return proof && b.proof === proof ? 'ours' : 'foreign';
}

/**
 * `ours`          — an interceptor of this build; answers a proof over the active tool set.
 * `legacy-ours`   — an interceptor built before R3; answers a proof over host and prefix. Same
 *                   token, same port, so it is ours, but it cannot be told a new tool set in
 *                   place and reconcile replaces it.
 * `foreign` | `silent` | `free` — not ours; never signalled.
 */
export async function probeBlindfold(port) {
  const nonce = newNonce();
  const r = await getJson(port, `/?challenge=${nonce}`);
  if (r.state !== 'answered') return { state: r.state };
  const b = r.body;
  if (b?.proxy !== 'llm-switcher-blindfold' || b.port !== port) return { state: 'foreign' };
  const activeTools = typeof b.activeTools === 'string' ? b.activeTools : '';
  const proof = identityProof(nonce, { role: 'blindfold', port, pid: b.pid, gatewayPort: b.gatewayPort, activeTools });
  if (proof && b.proof === proof) {
    return { state: 'ours', pid: b.pid, gatewayPort: b.gatewayPort, activeTools };
  }
  const legacy = legacyIdentityProof(nonce, {
    role: 'blindfold', port, pid: b.pid, gatewayPort: b.gatewayPort,
    host: typeof b.host === 'string' ? b.host : '', prefix: typeof b.prefix === 'string' ? b.prefix : ''
  });
  if (legacy && b.proof === legacy) {
    return { state: 'legacy-ours', pid: b.pid, gatewayPort: b.gatewayPort, host: b.host, prefix: b.prefix };
  }
  return { state: 'foreign' };
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

// An interceptor built before R3 is ours too: it holds the port a new one needs to bind, and it
// stops on the same verified pid. A foreign process on that port is never signalled.
const isOurBlindfold = (p) => p.state === 'ours' || p.state === 'legacy-ours';

/** true when no interceptor of ours answers on the port any more. */
async function stopBlindfoldAt(port) {
  const cur = await probeBlindfold(port);
  if (!isOurBlindfold(cur)) return true;
  killVerified(cur.pid);
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    if (!isOurBlindfold(await probeBlindfold(port))) return true;
  }
  return false;
}

/** Stop the interceptor recorded in blindfold.json, if a probe confirms it is ours. Never starts one. */
export async function stopRecordedBlindfold() {
  const prev = readBlindfoldState();
  const stopped = prev?.port ? await stopBlindfoldAt(prev.port) : true;
  if (stopped) try { fs.unlinkSync(blindfoldStatePath); } catch {}
  return { ok: stopped, ...(stopped ? {} : { error: `the interceptor on port ${prev.port} did not stop` }) };
}

/** null when the interceptor can start, otherwise the reason and the command that fixes it. */
export function blindfoldPreflight(desired) {
  const certDir = path.dirname(desired.ca);
  const build = `bash blindfold/make-certs.sh${process.env.LLM_SWITCHER_BLINDFOLD_CERTS ? ` "${certDir}"` : ''}`;
  for (const f of [desired.ca, path.join(certDir, 'leaf.pem'), path.join(certDir, 'leaf.key')]) {
    if (!fs.existsSync(f)) return `Blindfold mode is on, but ${path.basename(f)} is missing in ${certDir}. Build the certificates first: ${build}`;
  }
  // A leaf from an older version covers one host and fails the other two at the handshake with an
  // error that reads like a network fault. Name every host it is missing and change nothing:
  // the rebuild command is the only answer this returns (R3, spec A5).
  const leafPem = fs.readFileSync(path.join(certDir, 'leaf.pem'), 'utf8');
  const missing = INTERCEPT_HOSTS.filter(h => !certCoversHost(leafPem, h));
  if (missing.length) {
    return `The leaf certificate does not cover ${missing.join(', ')}. Rebuild it for all hosts: ${build}`;
  }
  // Files from two different builds fail the same way.
  try {
    const leaf = new crypto.X509Certificate(leafPem);
    const ca = new crypto.X509Certificate(fs.readFileSync(desired.ca));
    if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) {
      return `The leaf certificate was not signed by ${desired.ca}. Rebuild both: ${build}`;
    }
    if (!leaf.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(path.join(certDir, 'leaf.key'))))) {
      return `leaf.key does not match leaf.pem in ${certDir}. Rebuild both: ${build}`;
    }
  } catch (err) {
    return `Cannot read the certificates in ${certDir}: ${err.message}. Rebuild them: ${build}`;
  }
  return null;
}

const LOG_LIMIT = 10 * 1024 * 1024;

// Opens a private log for appending. A log above LOG_LIMIT moves to <file>.1 first, so the two
// files together stay near twice the limit.
export function openLog(file) {
  try {
    if (fs.statSync(file).size > LOG_LIMIT) fs.renameSync(file, `${file}.1`);
  } catch {}
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.fchmodSync(fd, 0o600); } catch {}
  return fd;
}

// The single place that starts an interceptor.
function spawnBlindfold(desired, gatewayPort) {
  const log = openLog(paths.blindfoldLog);
  const args = [
    blindfoldScript,
    '--port', String(desired.port),
    '--gateway-port', String(gatewayPort),
    // R3: the interceptor re-reads the config itself for the host table and the active tool set,
    // instead of being handed a host and a prefix that go stale (F6).
    '--config', configPath,
    '--certs', path.dirname(desired.ca),
    '--token-file', adminTokenPath
  ];
  // Finding 6: a fixed, sorted list. It is also the field `matches` compares, so a changed tool
  // set reaches a running interceptor through POST /_control/active-tools (Finding 2) instead of
  // through a kill and a restart.
  if (desired.activeTools) args.push('--active-tools', String(desired.activeTools));
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  child.unref();
  fs.closeSync(log);
  return child.pid;
}

/** null when the interceptor that cfg asks for can run, otherwise the reason. No side effects. */
export async function checkBlindfoldTarget(cfg, gatewayPort) {
  const desired = computeLaunchState(cfg, gatewayPort).blindfold;
  if (!desired) return null;
  const problem = blindfoldPreflight(desired);
  if (problem) return problem;
  const held = (await probeBlindfold(desired.port)).state;
  if (held === 'foreign') return `Port ${desired.port} is held by another process, not by this switcher's interceptor.`;
  if (held === 'silent') return `Port ${desired.port} accepts connections but does not answer. A hung interceptor or another program holds it.`;
  return null;
}

// The running interceptor is the one this config asks for: same gateway, same tool set. An older
// build never matches, because it has no channel to be told a new tool set — it gets replaced.
const matches = (cur, desired, gatewayPort) =>
  cur.state === 'ours'
  && cur.gatewayPort === gatewayPort
  && String(cur.activeTools || '') === String(desired.activeTools || '');

/**
 * Ask a running interceptor to re-derive its tool set from config.json (Finding 2, Item 7). The
 * body is empty and is read as nothing: a delta is one more thing to get wrong, and the
 * interceptor already owns the config. Authenticated with the admin token, over loopback only.
 * Returns the status code, or null when it could not be reached.
 */
async function pushActiveTools(port, token) {
  if (!token) return null;
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/_control/active-tools',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': 2, 'x-llm-switcher-token': token },
      timeout: 5000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    // The body is ignored by the interceptor, by design (Finding 4, option (a)).
    req.end('{}');
  });
}

/**
 * Push a tool set to a running interceptor with no gateway in the way (Finding 4). The CLI reaches
 * for this only when `probeGateway` did not answer `ours`: the interceptor re-reads config.json on
 * every call and derives the list itself, so a message that arrives late cannot undo a change the
 * gateway queue already applied. A port with no listener is not a failure — there is nothing to
 * update, and starting one is not this command's job — but a listener this build cannot recognize
 * is, and the reason names the state it saw.
 * Returns { ok: true, activeTools } or { ok: false, error }.
 */
export async function syncInterceptorTools(cfg, gatewayPort) {
  const port = computeLaunchState(cfg, gatewayPort).blindfold?.port || readBlindfoldState()?.port;
  if (!port) return { ok: true, activeTools: [] };
  const cur = await probeBlindfold(port);
  if (cur.state === 'free') return { ok: true, activeTools: [] };
  if (cur.state !== 'ours') {
    const named = {
      'legacy-ours': 'runs an older build of this switcher',
      foreign: 'is held by another process',
      silent: 'accepts connections but never answers'
    }[cur.state] || `reports state "${cur.state}"`;
    return { ok: false, error: `the interceptor on port ${port} ${named}` };
  }
  const ack = await pushActiveTools(port, readAdminToken());
  if (!ack || !Array.isArray(ack.activeTools)) {
    return { ok: false, error: `the interceptor on port ${port} did not accept the active tool set` };
  }
  return { ok: true, activeTools: ack.activeTools };
}

/**
 * Bring the interceptor in line with the saved config: start, respawn with new arguments, or stop.
 * Returns { ok: true, action } or { ok: false, error }.
 */
export async function reconcileBlindfold(cfg, gatewayPort) {
  const desired = computeLaunchState(cfg, gatewayPort).blindfold;
  const prev = readBlindfoldState();
  if (!desired) {
    if (prev?.port) {
      const stopped = await stopRecordedBlindfold();
      if (!stopped.ok) return stopped;
    }
    return { ok: true, action: 'none' };
  }
  // Validate the new interceptor before the old one is stopped: a failed change keeps Codex working.
  const problem = await checkBlindfoldTarget(cfg, gatewayPort);
  if (problem) return { ok: false, error: problem };
  if (prev?.port && prev.port !== desired.port) {
    const stopped = await stopRecordedBlindfold();
    if (!stopped.ok) return stopped;
  }
  const cur = await probeBlindfold(desired.port);
  if (matches(cur, desired, gatewayPort)) {
    writeBlindfoldState({ pid: cur.pid, port: desired.port, gatewayPort, activeTools: desired.activeTools });
    return { ok: true, action: 'kept' };
  }
  // Finding 2 / Item 7: the tool set is the one thing that changes while the interceptor runs.
  // One authenticated loopback POST, no signal, no restart, port untouched and in-flight
  // streams undisturbed. What gets confirmed is the list the interceptor says it now holds, not
  // the snapshot this call began with: config.json can change in between, and the process that
  // already read it is the one that is running.
  if (cur.state === 'ours' && cur.gatewayPort === gatewayPort) {
    const ack = await pushActiveTools(desired.port, readAdminToken());
    if (ack && Array.isArray(ack.activeTools)) {
      const want = ack.activeTools.join(',');
      for (let i = 0; i < 20; i++) {
        const now = await probeBlindfold(desired.port);
        if (now.state === 'ours' && String(now.activeTools || '') === want) {
          writeBlindfoldState({ pid: now.pid, port: desired.port, gatewayPort, activeTools: want });
          return { ok: true, action: 'updated' };
        }
        await sleep(100);
      }
      return { ok: false, error: 'failed to update active tools on interceptor' };
    }
    // Anything else — an interceptor too old to know the endpoint — falls through to a restart.
  }
  if (isOurBlindfold(cur) && !(await stopBlindfoldAt(desired.port))) {
    return { ok: false, error: `the interceptor on port ${desired.port} did not stop` };
  }

  const pid = spawnBlindfold(desired, gatewayPort);
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const now = await probeBlindfold(desired.port);
    if (matches(now, desired, gatewayPort)) {
      writeBlindfoldState({ pid: now.pid, port: desired.port, gatewayPort, activeTools: desired.activeTools });
      return { ok: true, action: 'started' };
    }
  }
  // Stop the child it started: coming up later, it would run with no record that could find it.
  killVerified(pid);
  return { ok: false, error: `The interceptor did not come up on port ${desired.port}. See blindfold.log.` };
}
