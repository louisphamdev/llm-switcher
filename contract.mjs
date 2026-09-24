// Contract lab, llm-switcher half. It tags a sampled request with a trace id and uploads this
// side of the exchange to intact, which joins both halves and finds what a converter loses.
// Nothing here may delay, fail or change the answer a coding tool receives: every entry point
// returns at once, and every failure is logged and dropped.
// Wire shape of the policy: `{models: {"<model>": rate}, default: rate}`, rate 0 to 1. The half
// body is built in `send`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getActiveMap, modelSlotsForProfile, modelForSlot } from './state.mjs';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const TRACE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const SWITCHER_VERSION_RE = /^\d{1,5}\.\d{1,5}\.\d{1,5}\+\d{8}T\d{6}Z$/;
export const TOOL_VERSION_RE = /^\d{1,5}\.\d{1,5}\.\d{1,5}([-+][0-9A-Za-z.]{1,32})?$/;
export const POLICY_REFRESH_MS = 10 * 60 * 1000;
export const MAX_QUEUE = 32;
export const MAX_HALF_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

/** A trace id the client cannot choose: 32 url-safe characters from the system random source. */
export function newTraceId() {
  return crypto.randomBytes(24).toString('base64url');
}

// The coding tool version is the text after the first slash of the User-Agent, up to the first
// space. intact answers 400 to any other value, so an unreadable one is left out of the half.
export function toolVersionFromUA(ua) {
  const first = String(ua || '').split(' ')[0];
  const slash = first.indexOf('/');
  if (slash < 0) return '';
  const version = first.slice(slash + 1);
  return TOOL_VERSION_RE.test(version) ? version : '';
}

const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

let cachedVersion = '';

// package version + the commit time, the shape the half route demands. Without git (an unpacked
// copy) the mtime of package.json stands in, so the value always parses as a past UTC time.
export function switcherVersion() {
  if (cachedVersion) return cachedVersion;
  let version = '0.0.0';
  let stampMs = Date.now();
  try {
    const pkgPath = path.join(ROOT_DIR, 'package.json');
    const parsed = /^(\d{1,5}\.\d{1,5}\.\d{1,5})/.exec(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '');
    if (parsed) version = parsed[1];
    stampMs = fs.statSync(pkgPath).mtimeMs;
  } catch {}
  try {
    const out = execFileSync('git', ['-C', ROOT_DIR, 'log', '-1', '--format=%ct'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/^\d{1,12}$/.test(out)) stampMs = Number(out) * 1000;
  } catch {}
  cachedVersion = `${version}+${utcStamp(stampMs)}`;
  return cachedVersion;
}

/** Copies what the gateway writes to the client. Past the cap the side is dropped, not cut. */
// ---------------- masking of client content ----------------
// A half leaves this machine. The client's own content (prompts, answers, tool arguments and results,
// files, user ids) is replaced by "x" of the same byte length; everything intact needs to analyse the
// shape (keys, types, roles, models, tool names, numbers, flags, event names) stays as sent.
const TEXT_KEYS = new Set(['text', 'content', 'thinking', 'system', 'instructions', 'delta', 'reasoning_content',
  'refusal', 'output', 'input', 'data', 'url', 'file_data', 'encrypted_content', 'user', 'user_id', 'prompt',
  'summary', 'output_text', 'partial_json', 'arguments', 'args']);
const SSE_EVENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

const maskString = (s) => 'x'.repeat(Buffer.byteLength(s));

// Inside a payload (tool arguments, tool input, a function response) every value belongs to the client.
function maskPayload(v) {
  if (typeof v === 'string') return maskString(v);
  if (Array.isArray(v)) return v.map(maskPayload);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, c]) => [k, maskPayload(c)]));
  return v;
}

// A string that holds JSON (tool arguments) keeps its keys, so intact still sees the nested shape.
function maskJsonString(s) {
  const t = s.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { return JSON.stringify(maskPayload(JSON.parse(t))); } catch {}
  }
  return maskString(s);
}

function maskValue(v, parentKey = '') {
  if (Array.isArray(v)) return v.map((c) => maskValue(c, parentKey));
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, c] of Object.entries(v)) {
    const payload = k === 'args' || k === 'arguments' || (k === 'input' && c && typeof c === 'object' && !Array.isArray(c))
      || (k === 'response' && parentKey === 'functionResponse');
    if (payload) out[k] = typeof c === 'string' ? maskJsonString(c) : maskPayload(c);
    else if (typeof c === 'string' && TEXT_KEYS.has(k)) out[k] = (k === 'partial_json') ? maskJsonString(c) : maskString(c);
    else out[k] = maskValue(c, k);
  }
  return out;
}

/** Masks the client's content in a request or response body: JSON, SSE, or anything else (masked whole). */
export function maskHalf(text) {
  if (!text) return '';
  try { return JSON.stringify(maskValue(JSON.parse(text))); } catch {}
  const lines = text.split('\n');
  if (!lines.some((l) => l.startsWith('data:'))) return maskString(text);
  return lines.map((line) => {
    if (line === '' || line === '\r' || line.startsWith(':')) return line;
    if (line.startsWith('event:')) {
      const name = line.slice(6).trim();
      return SSE_EVENT_RE.test(name) ? line : `event: ${maskString(name)}`;
    }
    if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      if (data === '[DONE]') return line;
      try { return `data: ${JSON.stringify(maskValue(JSON.parse(data)))}`; } catch { return `data: ${maskString(data)}`; }
    }
    return maskString(line);
  }).join('\n');
}

export function createHalfTap(limit = MAX_HALF_BYTES) {
  const chunks = [];
  let size = 0;
  let over = false;
  return {
    push(chunk) {
      try {
        if (over || chunk === undefined || chunk === null) return;
        const buf = Buffer.isBuffer(chunk) ? chunk
          : ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : Buffer.from(String(chunk), 'utf8');
        size += buf.length;
        if (size > limit) {
          over = true;
          chunks.length = 0;
          return;
        }
        chunks.push(buf);
      } catch {}
    },
    // A side over the cap would get 413 from intact, so it is sent empty and only that
    // direction is skipped.
    text() {
      return over ? '' : Buffer.concat(chunks).toString('utf8');
    }
  };
}

/** The client request half, or '' when it is over the cap intact accepts. */
export function capText(buf, limit = MAX_HALF_BYTES) {
  if (!buf) return '';
  return buf.length > limit ? '' : buf.toString('utf8');
}

// The WS transport hands the handler a parsed message, not the bytes of the frame. The shape
// survives the round trip, which is all intact reduces. A value JSON cannot hold gives ''.
export function capJson(value, limit = MAX_HALF_BYTES) {
  try {
    return capText(Buffer.from(JSON.stringify(value) ?? '', 'utf8'), limit);
  } catch {
    return '';
  }
}

// Copies every byte the handler writes to the client. It never changes them, and a tap failure
// is swallowed inside the tap.
export function tapClientWrites(res, tap) {
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = function tappedWrite(chunk, ...rest) {
    if (typeof chunk !== 'function') tap.push(chunk);
    return write(chunk, ...rest);
  };
  res.end = function tappedEnd(chunk, ...rest) {
    if (typeof chunk !== 'function') tap.push(chunk);
    return end(chunk, ...rest);
  };
}

// The only place the upload guard lives. An untagged request was never sampled, and an aborted
// or failed turn has no complete answer: uploading it would diff as a loss the converter never made.
export function finishHalf(lab, traceId, failed, half) {
  if (!traceId || failed) return;
  lab.upload(traceId, half);
}

const clamp = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

function readPolicy(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const models = {};
  if (body.models && typeof body.models === 'object' && !Array.isArray(body.models)) {
    for (const [model, rate] of Object.entries(body.models)) {
      if (typeof rate === 'number' && Number.isFinite(rate)) models[model] = clamp(rate);
    }
  }
  const fallback = typeof body.default === 'number' && Number.isFinite(body.default) ? clamp(body.default) : 0;
  return { models, default: fallback };
}

/** The url and key of a lab that is on and fully configured, or null. */
function activeSettings(s) {
  if (!s || s.enabled !== true || !s.url || !s.apiKey) return null;
  return { url: String(s.url).replace(/\/+$/, ''), apiKey: String(s.apiKey) };
}

export function createContractLab(options = {}) {
  const {
    settings = () => null,
    fetchImpl = (...args) => fetch(...args),
    now = () => Date.now(),
    random = Math.random,
    version = switcherVersion,
    log = (message) => console.error(`[llm-switcher:contract] ${message}`)
  } = options;

  let policy = null;
  // Never refreshed yet. A failed refresh sets a real time, so a down intact is asked again
  // only after the interval, not on every request.
  let policyAt = Number.NEGATIVE_INFINITY;
  let refreshing = false;
  let pumping = false;
  const queue = [];
  const stats = { sampled: 0, dropped: 0, done: 0, failed: 0 };

  const active = () => activeSettings(settings());

  const call = (url, opts) => fetchImpl(url, { ...opts, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  async function refreshPolicy(s) {
    refreshing = true;
    try {
      const res = await call(`${s.url}/api/contracts/policy`, { headers: { authorization: `Bearer ${s.apiKey}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = readPolicy(await res.json());
      if (!next) throw new Error('unreadable policy');
      policy = next;
    } catch (err) {
      // Keep the policy that worked. With none, nothing is sampled until a refresh succeeds.
      log(`policy refresh failed: ${err.message}`);
    } finally {
      policyAt = now();
      refreshing = false;
    }
  }

  /** The trace id for this request, or null. Never throws, never waits. */
  function traceFor(model) {
    try {
      const s = active();
      if (!s) return null;
      if (!refreshing && now() - policyAt >= POLICY_REFRESH_MS) void refreshPolicy(s);
      if (!policy) return null;
      const byModel = policy.models[model];
      const rate = typeof byModel === 'number' ? byModel : policy.default;
      if (!(rate > 0) || random() >= rate) return null;
      stats.sampled++;
      return newTraceId();
    } catch {
      return null;
    }
  }

  async function send(s, { traceId, half }) {
    const body = JSON.stringify({
      toolRequest: maskHalf(half.toolRequest || ''),
      toolResponse: maskHalf(half.toolResponse || ''),
      ...(half.toolVersion ? { toolVersion: half.toolVersion } : {}),
      switcherVersion: version(),
      converter: { inFormat: half.inFormat, outFormat: half.outFormat }
    });
    try {
      const res = await call(`${s.url}/api/contracts/traces/${encodeURIComponent(traceId)}/half`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${s.apiKey}` },
        body
      });
      // 409 means intact already holds this half: the work is done, a retry would only repeat it.
      if (res.ok || res.status === 409) stats.done++;
      else {
        stats.failed++;
        log(`half upload refused: HTTP ${res.status}`);
      }
      try { await res.arrayBuffer(); } catch {}
    } catch (err) {
      stats.failed++;
      log(`half upload failed: ${err.message}`);
    }
  }

  async function pump() {
    try {
      while (queue.length) {
        const entry = queue.shift();
        const s = active();
        if (!s) {
          stats.dropped++;
          continue;
        }
        await send(s, entry);
      }
    } catch (err) {
      log(`upload queue stopped: ${err.message}`);
    } finally {
      pumping = false;
    }
  }

  /** Queues this side of a sampled exchange. Returns before any byte goes to intact. */
  function upload(traceId, half) {
    try {
      if (!active() || !TRACE_ID_RE.test(String(traceId || ''))) return;
      if (queue.length >= MAX_QUEUE) {
        queue.shift();
        stats.dropped++;
      }
      queue.push({ traceId, half });
      if (!pumping) {
        pumping = true;
        setImmediate(() => { void pump(); });
      }
    } catch {}
  }

  return {
    traceFor,
    upload,
    policy: () => policy,
    pending: () => queue.map(e => e.traceId),
    stats: () => ({ ...stats, queued: queue.length })
  };
}

// ---------------------------------------------------------------- probe
//
// `switch contract-probe` drives one exchange per variant, format and model through the local
// gateway so intact sees a full matrix without a human typing in a coding tool. The gateway
// captures a probe exchange only when the request carries admin.token, which a coding tool
// never has: a client can still not choose a trace id.

export const PROBE_HEADER = 'x-intact-probe';
export const PROBE_FORMATS = ['anthropic', 'responses'];
export const PROBE_PATHS = { anthropic: '/v1/messages', responses: '/v1/responses' };
const PROBE_TIMEOUT_MS = 120_000;
// A thinking budget under 1024 is refused by the backends the matrix sampled (docs/LLM-RESPONSE-MATRIX.md).
const THINK_BUDGET = 2048;
const TRUNC_MAX_TOKENS = 40;
const PROBE_MAX_TOKENS = 512;
const PROBE_PROMPT = 'Think step by step, then answer in one sentence: why does ice float on water?';
const PROBE_TOOL_PROMPT = 'Call the get_weather tool for Hanoi. Answer only with the tool call.';
const PROBE_TOOL_SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string', description: 'City name' } },
  required: ['city']
};

const VARIANT_KNOBS = {
  'base-stream': { stream: true },
  'think-stream': { stream: true, think: true },
  'think-nostream': { stream: false, think: true },
  'tool-stream': { stream: true, tool: true },
  'trunc-stream': { stream: true, maxTokens: TRUNC_MAX_TOKENS },
  'effort-stream': { stream: true, effort: 'high' }
};

/** The variant names of docs/response-matrix.json that this probe can build a request for. */
export function probeVariants() {
  try {
    const file = path.join(ROOT_DIR, 'docs', 'response-matrix.json');
    const listed = JSON.parse(fs.readFileSync(file, 'utf8')).variants;
    const usable = Array.isArray(listed) ? listed.filter(v => Object.hasOwn(VARIANT_KNOBS, v)) : [];
    if (usable.length) return usable;
  } catch {}
  return Object.keys(VARIANT_KNOBS);
}

/** The path and body of one probe request. An unknown variant is built as the base one. */
export function probeRequest({ format, variant, model }) {
  const knobs = VARIANT_KNOBS[variant] || VARIANT_KNOBS['base-stream'];
  const maxTokens = knobs.maxTokens || PROBE_MAX_TOKENS;
  const prompt = knobs.tool ? PROBE_TOOL_PROMPT : PROBE_PROMPT;
  if (format === 'responses') {
    return {
      path: PROBE_PATHS.responses,
      body: {
        model,
        input: prompt,
        stream: knobs.stream === true,
        max_output_tokens: maxTokens,
        ...(knobs.think ? { reasoning: { effort: 'medium' } } : {}),
        ...(knobs.effort ? { reasoning: { effort: knobs.effort } } : {}),
        ...(knobs.tool ? { tools: [{ type: 'function', name: 'get_weather', description: 'Current weather of a city', parameters: PROBE_TOOL_SCHEMA }] } : {})
      }
    };
  }
  // Anthropic has no reasoning_effort: the effort variant asks for the deepest thinking instead.
  // Anthropic requires max_tokens to strictly exceed budget_tokens.
  const think = knobs.think || knobs.effort;
  const budget = knobs.effort ? THINK_BUDGET * 2 : THINK_BUDGET;
  const anthropicMaxTokens = think ? Math.max(maxTokens, budget + PROBE_MAX_TOKENS) : maxTokens;
  return {
    path: PROBE_PATHS.anthropic,
    body: {
      model,
      max_tokens: anthropicMaxTokens,
      messages: [{ role: 'user', content: prompt }],
      stream: knobs.stream === true,
      ...(think ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
      ...(knobs.tool ? { tools: [{ name: 'get_weather', description: 'Current weather of a city', input_schema: PROBE_TOOL_SCHEMA }] } : {})
    }
  };
}

/** Every model an active profile maps to, in slot order, once each. */
export function probeModels(cfg) {
  const out = [];
  const seenProfiles = new Set();
  for (const key of Object.values(getActiveMap(cfg))) {
    if (!key || seenProfiles.has(key)) continue;
    seenProfiles.add(key);
    const profile = cfg?.profiles?.[key];
    if (!profile) continue;
    for (const slot of modelSlotsForProfile(profile)) {
      const model = modelForSlot(profile, slot);
      if (model && !out.includes(model)) out.push(model);
    }
  }
  return out;
}

/**
 * Sends every variant of every format for every probed model through the local gateway.
 * Returns one row per request; `unreachable` is true when the gateway refused a connection.
 */
export async function runProbe(options = {}) {
  const {
    port, token, config, model = '', fetchImpl = (...args) => fetch(...args),
    log = (line) => console.log(line), newId = newTraceId
  } = options;
  const wanted = String(model || '').toLowerCase();
  const models = probeModels(config).filter(m => !wanted || m.toLowerCase() === wanted);
  const variants = probeVariants();
  const rows = [];
  let unreachable = false;

  for (const target of models) {
    for (const format of PROBE_FORMATS) {
      for (const variant of variants) {
        const traceId = newId();
        const { path: route, body } = probeRequest({ format, variant, model: target });
        let status = 'unreachable';
        try {
          const res = await fetchImpl(`http://127.0.0.1:${port}${route}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'user-agent': `llm-switcher-probe/${switcherVersion()}`,
              'x-llm-switcher-token': token,
              [PROBE_HEADER]: traceId
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
          });
          status = res.status;
          try { await res.arrayBuffer(); } catch {}
        } catch (err) {
          unreachable = true;
          status = `unreachable (${err.message})`;
        }
        rows.push({ model: target, format, variant, traceId, status });
        log(`${target}  ${format}  ${variant}  ${traceId}  ${status}`);
      }
    }
  }
  return { rows, unreachable };
}

// ---------------------------------------------------------------- check
//
// `switch contract-check` turns the open findings of intact into test DATA. Nothing that a
// finding or a fixture holds is ever written into a `.mjs` file: a path, an enum value or a name
// comes from a provider or from another key, and only the finding id (validated against
// FINDING_ID_RE) ever builds a file name.

export const FINDING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const CONTRACT_TEST_DIR = path.join(ROOT_DIR, 'tests', 'contract');
const EXCLUSIONS_FILE = path.join(ROOT_DIR, 'contract-exclusions.json');
const CHECK_TIMEOUT_MS = 30_000;

/** Untrusted text on its way to the terminal: printable, one line, short. */
const safe = (v) => String(v ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, 64);

/** The intentional normalizations of the converter. A broken file excludes nothing. */
export function loadExclusions(file = EXCLUSIONS_FILE) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8')).exclusions;
    return Array.isArray(list) ? list.filter(e => e && typeof e.id === 'string' && Array.isArray(e.paths)) : [];
  } catch {
    return [];
  }
}

/** The exclusion that covers this finding, or null. A path matches exactly, in its direction. */
export function matchExclusion(finding, list = loadExclusions()) {
  const path_ = String(finding?.path ?? '');
  const direction = String(finding?.direction ?? '');
  for (const item of list) {
    if (item.direction && item.direction !== direction) continue;
    if (item.paths.includes(path_)) return item;
  }
  return null;
}

async function getJson(url, apiKey, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
  });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  return { status: res.status, body: await res.json() };
}

/**
 * Pulls the open findings and the fixture of each exempt trace, and writes one JSON file per
 * `lost` finding that no exclusion covers. Returns the printed rows; `ok` is false when intact
 * could not be read, which the CLI turns into exit code 2.
 */
export async function runCheck(options = {}) {
  const {
    settings = () => null,
    fetchImpl = (...args) => fetch(...args),
    dir = CONTRACT_TEST_DIR,
    exclusions = loadExclusions(),
    log = (line) => console.log(line)
  } = options;

  const s = activeSettings(settings());
  if (!s) return { ok: false, rows: [], error: 'The contract lab is off. Set contractLab.url, contractLab.apiKey and contractLab.enabled in config.json.' };

  let findings;
  try {
    const pulled = await getJson(`${s.url}/api/contracts/findings?status=open`, s.apiKey, fetchImpl);
    const body = pulled.body;
    findings = Array.isArray(body) ? body : Array.isArray(body?.findings) ? body.findings : null;
    if (!findings) throw new Error('the findings route answered an unreadable body');
  } catch (err) {
    return { ok: false, rows: [], error: `intact did not answer: ${err.message}` };
  }

  const rows = [];
  const writtenFiles = new Set();
  for (const raw of findings) {
    const finding = raw && typeof raw === 'object' ? raw : {};
    const id = String(finding.id ?? '');
    const row = {
      id: FINDING_ID_RE.test(id) ? id : '<invalid id>',
      model: safe(finding.model),
      direction: safe(finding.direction),
      class: safe(finding.class),
      file: '-'
    };
    rows.push(row);

    if (!FINDING_ID_RE.test(id)) {
      row.skipped = true;
      row.file = 'skipped: the id is not one url-safe word';
      continue;
    }
    if (finding.class !== 'lost') continue;
    if (matchExclusion(finding, exclusions)) {
      row.file = 'excluded';
      continue;
    }
    const trace = String(finding.exemptTrace ?? '');
    if (!trace) {
      row.file = 'no fixture';
      continue;
    }
    let fixture;
    try {
      const pulled = await getJson(`${s.url}/api/contracts/fixtures/${encodeURIComponent(trace)}`, s.apiKey, fetchImpl);
      if (pulled.status === 404 || !pulled.body) {
        row.file = 'no fixture';
        continue;
      }
      fixture = pulled.body;
    } catch (err) {
      return { ok: false, rows, error: `intact did not answer: ${err.message}` };
    }
    fs.mkdirSync(dir, { recursive: true });
    const targetFile = path.join(dir, `${id}.json`);
    const tmpFile = path.join(dir, `.${id}.json.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(tmpFile, `${JSON.stringify({ finding, fixture }, null, 2)}\n`);
    fs.renameSync(tmpFile, targetFile);
    writtenFiles.add(`${id}.json`);
    row.file = `tests/contract/${id}.json`;
  }

  // Prune stale fixtures: only files written by this successful run remain in the directory.
  if (fs.existsSync(dir)) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.json') && !writtenFiles.has(name)) {
          try { fs.unlinkSync(path.join(dir, name)); } catch {}
        }
      }
    } catch {}
  }

  const width = (key, head) => Math.max(head.length, ...rows.map(r => String(r[key]).length), 0);
  const cols = [['id', 'FINDING'], ['model', 'MODEL'], ['direction', 'DIRECTION'], ['class', 'CLASS'], ['file', 'FILE']];
  const line = (get) => cols.map(([key, head]) => String(get(key, head)).padEnd(width(key, head))).join('  ').trimEnd();
  log(line((key, head) => head));
  for (const row of rows) log(line(key => row[key]));
  log(`${rows.length} open findings, ${rows.filter(r => r.file.startsWith('tests/')).length} tests written.`);
  return { ok: true, rows };
}
