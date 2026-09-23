import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createFrameReader } from './blindfold/wsframe.mjs';
import {
  OUT_FORMATS, IN_FORMATS, parseToIR, emitUpstreamBody, createUpstreamNormalizer, createCollector,
  createThinkTagSplitter, splitThinkTags, healAnthropicPayload, estimateTokens, THINKING_MODES,
  toGeminiSchema, isAntigravityModel,
  createAnthropicStream, createChatStream, createResponsesStream, createVertexStream,
  buildAnthropicMessage, buildChatMessage, buildResponsesMessage, buildVertexMessage
} from './formats.mjs';
import {
  TARGETS, configPath, loadConfig, getConfigLoadError, saveConfig, resolvePort, hasProfile, isValidProfileKey,
  getActiveMap, setTargetProfile, activateProfile, deactivateProfile, deactivateAll, deleteProfile,
  isProfileActive, profileAcceptsTarget, applyLaunchState, readLaunchFlags, redactConfig, MASKED_KEY,
  modelForSlot, primaryModel, codexPublicModel, isSafeModelName, parsePort, CODEX_MODEL_SLOTS,
  ensureAdminToken, identityProof, reconcileBlindfold, checkBlindfoldTarget,
  codexModelEntry, smallestWindows, publicModelWindows, model1MForSlot, computeLaunchState
} from './state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiHtmlPath = path.join(__dirname, 'ui.html');

const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_API_BODY_SIZE = 1024 * 1024;  // 1MB for /api/*

// Avoid network conflicts: keep localhost / 127.0.0.1 out of external proxies (RTK, Headroom, VPN)
const currentNoProxy = process.env.NO_PROXY || process.env.no_proxy || '';
const localHosts = ['127.0.0.1', 'localhost'];
const existingNoProxy = currentNoProxy.split(',').map(s => s.trim().toLowerCase());
const missingNoProxy = localHosts.filter(h => !existingNoProxy.includes(h));
if (missingNoProxy.length > 0) {
  process.env.NO_PROXY = currentNoProxy ? `${currentNoProxy},${missingNoProxy.join(',')}` : missingNoProxy.join(',');
  process.env.no_proxy = process.env.NO_PROXY;
}

// Fixed port for the process lifetime: changing "port" in config.json at runtime has no effect
// env.cmd / flags would point at a port the server is not listening on.
const PORT = resolvePort();

// In-memory Request / Response Inspector Ring Buffer (up to 40 most recent requests)
const requestLogs = [];
const MAX_LOGS = 40;
function logInspection(entry) {
  requestLogs.push({
    id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toLocaleTimeString(),
    ...entry
  });
  if (requestLogs.length > MAX_LOGS) {
    requestLogs.shift();
  }
}

function debugLog(...args) {
  if (loadConfig()?.debug) {
    console.log('[DEBUG]', ...args);
  }
}

function sendJson(res, status, obj, headers = {}) {
  if (res.headersSent) {
    try { res.end(); } catch {}
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
}

// ----------------------------------------------------
// Request guards & body reading
// ----------------------------------------------------
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d+$/, '');
}

// Block DNS rebinding (unknown Host pointing at 127.0.0.1) and CSRF from other sites (unknown Origin).
// Without the Host check, a malicious page could burn tokens via /v1/*.
function checkRequestOrigin(req) {
  if (req.headers.host && !LOOPBACK_HOSTS.has(hostnameOf(req.headers.host))) {
    return 'Forbidden: untrusted Host header';
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      const u = new URL(origin);
      const port = u.port || (u.protocol === 'https:' ? '443' : '80');
      if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase()) || port !== String(PORT)) {
        return 'Forbidden: untrusted origin';
      }
    } catch {
      return 'Forbidden: invalid origin';
    }
  }
  return null;
}

// The Host/Origin guard stops browser pages only. A local process that is not the owner must
// also present the token from admin.token (mode 0600) to use /api/*.
const ADMIN_TOKEN = Buffer.from(ensureAdminToken());

function isAdminRequest(req) {
  const given = Buffer.from(String(req.headers['x-llm-switcher-token'] || ''));
  return given.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(given, ADMIN_TOKEN);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        const err = new Error(`Payload Too Large (max ${Math.round(limit / 1024 / 1024)}MB)`);
        err.status = 413;
        reject(err);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      decodeBody(Buffer.concat(chunks), req.headers['content-encoding'], limit).then(resolve, reject);
    });
    req.on('error', err => {
      err.status = 400;
      reject(err);
    });
  });
}

const INFLATERS = {
  gzip: promisify(zlib.gunzip),
  deflate: promisify(zlib.inflate),
  br: promisify(zlib.brotliDecompress),
  ...(typeof zlib.zstdDecompress === 'function' ? { zstd: promisify(zlib.zstdDecompress) } : {})
};

// Decompression runs off the event loop and stops at the raw-body limit: a few KB of gzip can
// expand to gigabytes.
async function decodeBody(raw, contentEncoding, limit) {
  let encoding = String(contentEncoding || '').toLowerCase().trim();
  if (!['gzip', 'deflate', 'br', 'zstd'].includes(encoding)) {
    // Magic bytes: some clients compress without saying so.
    if (raw.length >= 4 && raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd && INFLATERS.zstd) encoding = 'zstd';
    else if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) encoding = 'gzip';
    else return raw;
  }
  const inflate = INFLATERS[encoding];
  if (!inflate) throw Object.assign(new Error('zstd decompression not supported in this Node.js version'), { status: 415 });
  try {
    return await inflate(raw, { maxOutputLength: limit });
  } catch (err) {
    if (err.code === 'ERR_BUFFER_TOO_LARGE') {
      throw Object.assign(new Error(`Payload Too Large after decompression (max ${Math.round(limit / 1024 / 1024)}MB)`), { status: 413 });
    }
    err.status = 400;
    throw err;
  }
}

async function readJsonBody(req, limit = MAX_API_BODY_SIZE) {
  const buf = await readBody(req, limit);
  try {
    const v = JSON.parse(buf.toString('utf8') || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('JSON body must be an object');
    return v;
  } catch (e) {
    const err = new Error(`Invalid JSON body: ${e.message}`);
    err.status = 400;
    throw err;
  }
}

// ----------------------------------------------------
// Profile & model resolution
// ----------------------------------------------------
function getActiveProfile(clientFormat, req) {
  const cfg = loadConfig();
  if (!cfg) return { cfg: null, profileKey: null, profile: null };

  let reqProfile = null;
  if (req) {
    reqProfile = req.headers['x-llm-profile'] || req.headers['x-profile'] || null;
    if (!reqProfile && req.url) {
      try { reqProfile = new URL(req.url, 'http://localhost').searchParams.get('profile'); } catch {}
    }
  }
  if (reqProfile) {
    if (hasProfile(cfg, reqProfile)) return { cfg, profileKey: reqProfile, profile: cfg.profiles[reqProfile] };
    return { cfg, profileKey: reqProfile, profile: null, error: `Profile "${reqProfile}" requested via x-llm-profile/?profile= does not exist` };
  }

  // Look up the active profile by CLI target (clientFormat: anthropic | responses | openai-chat | vertex).
  // Deleted profile / disabled target counts as OFF, never silently fall through to another profile (different API key!).
  const key = clientFormat ? getActiveMap(cfg)[clientFormat] : (cfg.activeProfile || null);
  if (!key || !hasProfile(cfg, key)) return { cfg, profileKey: key || null, profile: null };
  return { cfg, profileKey: key, profile: cfg.profiles[key] };
}

// For endpoints not tied to a specific client format (/health, /v1/models).
function getFirstActiveProfile(preferred, req) {
  if (req) {
    const r = getActiveProfile(null, req);
    if (r.profile) return r;
  }
  for (const t of preferred) {
    const r = getActiveProfile(t);
    if (r.profile) return r;
  }
  return { cfg: loadConfig(), profileKey: null, profile: null };
}

// clientFormat is the protocol the request arrived in. An `auto` profile serves every protocol,
// so the profile's inFormat cannot tell a Codex request from a Claude one.
function mapModel(requestedModel, profile, clientFormat) {
  if (!requestedModel) return primaryModel(profile);
  const clean = requestedModel.replace(/\[1m\]/gi, '').trim();
  // If the client specified a model with a provider prefix (e.g. ag/..., gh/..., cf/...), keep it as-is
  if (clean.includes('/') && !clean.startsWith('anthropic/')) {
    return clean;
  }
  const m = clean.toLowerCase();
  if (clientFormat === 'responses') {
    // Aliases for the real Codex roles in the docs (model / review_model /
    // agents.default_subagent_model). Unknown names pass through unchanged.
    const aliases = {
      main: ['main', 'default', 'codex-main', 'codex-default'],
      review: ['review', 'codex-review'],
      subagent: ['subagent', 'codex-subagent']
    };
    for (const [slot, names] of Object.entries(aliases)) {
      if (names.includes(m)) return modelForSlot(profile, slot) || clean;
    }
    // The official names the CLI was given (publicModels) carry the role. Resolve
    // them before the fail-closed rule below, otherwise review and subagent traffic
    // collapses onto the main slot.
    for (const slot of CODEX_MODEL_SLOTS) {
      const publicName = codexPublicModel(profile, slot);
      if (publicName && publicName.toLowerCase() === m) return modelForSlot(profile, slot) || clean;
    }
    // Codex model IDs change frequently. Bare OpenAI IDs (config leftovers like gpt-5.6-sol,
    // retired gpt-5.3-codex) have no credentials behind 9Router -> fail closed to the main slot
    // instead of passing through to an upstream 404. Provider-prefixed names (ag/..., cf/...)
    // are preserved by the early return above.
    if (/^(gpt|o\d|codex)([-/]|$)/i.test(clean)) return modelForSlot(profile, 'main') || clean;
    return clean || requestedModel;
  }
  if (clientFormat === 'openai-chat' || clientFormat === 'vertex') {
    if (m === 'default' || m === 'main' || !clean) return modelForSlot(profile, 'default') || clean;
  }
  if (m.includes('fable')) return modelForSlot(profile, 'fable') || clean;
  if (m.includes('opus')) return modelForSlot(profile, 'opus') || clean;
  if (m.includes('haiku')) return modelForSlot(profile, 'haiku') || clean;
  if (m.includes('sonnet')) return modelForSlot(profile, 'sonnet') || clean;
  return clean || requestedModel;
}

// Wait until a slow client has taken the buffered bytes, so the gateway does not read the whole
// upstream stream into memory. A closed client also ends the wait.
function drained(stream) {
  if (!stream.writableNeedDrain || stream.destroyed) return null;
  return new Promise(resolve => {
    const done = () => {
      stream.off('drain', done);
      stream.off('close', done);
      resolve();
    };
    stream.on('drain', done);
    stream.on('close', done);
  });
}

function sendSSE(res, event, data) {
  // event=null -> raw `data:` line (OpenAI Chat / Vertex clients).
  if (event) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  else res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ----------------------------------------------------
// Client-shaped errors
// ----------------------------------------------------
function anthropicErrorType(status) {
  switch (status) {
    case 400: return 'invalid_request_error';
    case 401: return 'authentication_error';
    case 403: return 'permission_error';
    case 404: return 'not_found_error';
    case 413: return 'request_too_large';
    case 429: return 'rate_limit_error';
    case 529: return 'overloaded_error';
    default: return status >= 500 ? 'api_error' : 'invalid_request_error';
  }
}

function vertexStatus(status) {
  switch (status) {
    case 400: return 'INVALID_ARGUMENT';
    case 401: return 'UNAUTHENTICATED';
    case 403: return 'PERMISSION_DENIED';
    case 404: return 'NOT_FOUND';
    case 429: return 'RESOURCE_EXHAUSTED';
    case 503: return 'UNAVAILABLE';
    default: return status >= 500 ? 'INTERNAL' : 'FAILED_PRECONDITION';
  }
}

// Each SDK parses errors in its own shape; Claude Code relies on error.type + retry-after to decide retries.
function sendClientError(res, clientFormat, status, message, headers = {}) {
  let body;
  if (clientFormat === 'anthropic') {
    body = { type: 'error', error: { type: anthropicErrorType(status), message } };
  } else if (clientFormat === 'vertex') {
    body = { error: { code: status, message, status: vertexStatus(status) } };
  } else {
    body = { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', code: String(status) } };
  }
  sendJson(res, status, body, headers);
}

function extractUpstreamMessage(text) {
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    if (typeof e === 'string') return e;
    if (e?.message) return e.message;
    if (j.message) return j.message;
  } catch {}
  return text;
}

const RETRY_HEADERS = ['retry-after', 'retry-after-ms', 'x-should-retry'];
function pickRetryHeaders(upstreamRes) {
  const h = {};
  for (const k of RETRY_HEADERS) {
    const v = upstreamRes.headers.get(k);
    if (v) h[k] = v;
  }
  return h;
}

// ----------------------------------------------------
// Upstream endpoint & headers
// ----------------------------------------------------
function resolveOutFormat(profile, mappedModel) {
  if (profile.outFormat && OUT_FORMATS.includes(profile.outFormat)) return profile.outFormat;
  const mode = profile.mode || 'hybrid';
  if (mode === 'direct') return 'anthropic';
  if (mode === 'convert') return 'openai-chat';
  return String(mappedModel || '').toLowerCase().startsWith('claude-') ? 'anthropic' : 'openai-chat';
}

// Client headers that must NOT be forwarded upstream: client credentials (e.g. the Gemini SDK's x-goog-api-key
// would leak to a third-party upstream), switcher control headers, and hop-by-hop / network identity headers.
const BLOCKED_PASSTHROUGH = new Set([
  'x-api-key', 'x-goog-api-key', 'x-goog-user-project', 'x-profile', 'x-llm-profile',
  'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port'
]);

function upstreamEndpoint(profile, outFormat, model, stream, req) {
  const base = String(profile.baseURL || '').replace(/\/+$/, '');
  const ov = profile.endpoints || {};
  const key = profile.apiKey || '';
  const headers = { 'Content-Type': 'application/json' };

  // Safely pass through client headers from intermediate tools (x-request-id, traceparent, x-...)
  if (req?.headers) {
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if ((lk.startsWith('x-') || lk === 'traceparent' || lk === 'tracestate') && !BLOCKED_PASSTHROUGH.has(lk)) {
        headers[lk] = v;
      }
    }
  }

  if (outFormat === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = req?.headers?.['anthropic-version'] || '2023-06-01';
    if (req?.headers?.['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
  } else {
    headers['authorization'] = `Bearer ${key}`;
  }

  if (outFormat === 'anthropic') {
    return { url: ov.anthropic || `${base}/messages`, headers };
  }
  if (outFormat === 'vertex') {
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    const url = ov.vertex
      ? ov.vertex.replace('{model}', encodeURIComponent(model)).replace('{action}', action)
      : `${base}/models/${encodeURIComponent(model)}:${action}`;
    return { url: stream && !/[?&]alt=sse/.test(url) ? `${url}${url.includes('?') ? '&' : '?'}alt=sse` : url, headers };
  }
  return { url: ov['openai-chat'] || `${base}/chat/completions`, headers };
}

// Read the upstream stream: accept both SSE `data:` and raw JSON lines (Vertex framing).
async function* readUpstreamPayloads(upstreamRes) {
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder('utf8');
  let buffer = '';
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const parsed = parsePayloadLine(line);
        if (parsed) yield parsed;
      }
    }
    buffer += decoder.decode();
    const tail = parsePayloadLine(buffer);
    if (tail) yield tail;
  } finally {
    // A consumer that stops early (an in-band error) must close the upstream connection too.
    if (!finished) await reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch {}
  }
}

function parsePayloadLine(line) {
  let s = line.trim();
  if (!s) return null;
  if (s.startsWith('data:')) s = s.slice(5).trim();
  else if (s.startsWith('event:') || s.startsWith(':') || s.startsWith('id:') || s.startsWith('retry:')) return null;
  if (!s || s === '[DONE]' || !s.startsWith('{')) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function clientRenderer(clientFormat, res, model, opts = {}) {
  if (clientFormat === 'anthropic') return createAnthropicStream((e, d) => sendSSE(res, e, d), model);
  if (clientFormat === 'responses') return createResponsesStream((e, d) => sendSSE(res, e, d), model, opts);
  if (clientFormat === 'vertex') return createVertexStream((e, d) => sendSSE(res, null, d), model);
  return createChatStream((e, d) => sendSSE(res, null, d), model);
}

function clientMessage(clientFormat, args) {
  if (clientFormat === 'anthropic') return buildAnthropicMessage(args);
  if (clientFormat === 'responses') return buildResponsesMessage(args);
  if (clientFormat === 'vertex') return buildVertexMessage(args);
  return buildChatMessage(args);
}

function previewOf(ir) {
  const lastUser = (ir.messages || []).slice().reverse().find(m => m.role === 'user');
  if (!lastUser) return '';
  if (typeof lastUser.content === 'string') return lastUser.content.slice(0, 300);
  if (Array.isArray(lastUser.content)) {
    return lastUser.content.map(p => (p.type === 'text' ? p.text : `[${p.type}]`)).join(' ').slice(0, 300);
  }
  return '';
}

// ----------------------------------------------------
// Mode 1: DIRECT PASS-THROUGH (Native Anthropic to Native Anthropic)
// ----------------------------------------------------
const HOP_BY_HOP = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);

async function forwardAnthropicDirect(res, payload, bodyBuffer, url, headers, mappedModel, signal, profile) {
  debugLog('Direct forward to native Anthropic endpoint:', url);

  // Only re-serialize when a fix is actually needed; otherwise forward the client's original bytes.
  let json = payload;
  let modified = false;
  if (mappedModel && json.model !== mappedModel) {
    json = { ...json, model: mappedModel };
    modified = true;
  }
  const healed = healAnthropicPayload(json);
  if (healed.changed) {
    json = healed.payload;
    modified = true;
    debugLog('Healer (direct):', healed.notes.join('; '));
  }
  if (profile?.thinkingMode === 'off' && json.thinking) {
    json = { ...json };
    delete json.thinking;
    modified = true;
  }
  const body = modified ? Buffer.from(JSON.stringify(json), 'utf8') : bodyBuffer;

  const upstreamRes = await fetch(url, { method: 'POST', headers, body, signal });
  const resHeaders = {};
  for (const [k, v] of upstreamRes.headers.entries()) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) resHeaders[k] = v;
  }
  res.writeHead(upstreamRes.status, resHeaders);

  let errorPreview = '';
  const usage = createUsageTap();
  const reader = upstreamRes.body.getReader();
  let status = upstreamRes.status;
  let streamError = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!upstreamRes.ok && errorPreview.length < 300) errorPreview += Buffer.from(value).toString('utf8');
      usage.push(value);
      res.write(value);
      await drained(res);
    }
  } catch (streamErr) {
    // The status line is already sent, so only the log can say that the stream broke.
    if (signal.aborted) {
      status = 499;
      streamError = 'client disconnected mid-stream';
    } else {
      console.error('[DirectForward] Stream error:', streamErr.message);
      status = 502;
      streamError = `stream interrupted: ${streamErr.cause?.message || streamErr.message}`;
    }
  } finally {
    res.end();
  }
  const error = streamError || (upstreamRes.ok ? null : errorPreview.slice(0, 300));
  return { status, error, healed: healed.notes, tokens: usage.tokens() };
}

// Reads the token counts out of the passthrough bytes without changing them: message_start and
// message_delta in a stream, `usage` in a JSON body.
function createUsageTap(limit = 4 * 1024 * 1024) {
  const decoder = new TextDecoder('utf8');
  let text = '';
  let seen = 0;
  const tokens = { prompt: 0, completion: 0 };
  const take = (u) => {
    if (!u || typeof u !== 'object') return;
    if (typeof u.input_tokens === 'number') tokens.prompt = u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (typeof u.output_tokens === 'number') tokens.completion = u.output_tokens;
  };
  const line = (l) => {
    const t = l.startsWith('data:') ? l.slice(5).trim() : '';
    if (!t.includes('"usage"')) return;
    try {
      const d = JSON.parse(t);
      take(d.message?.usage || d.usage);
    } catch {}
  };
  return {
    push(chunk) {
      if (seen > limit) return;
      seen += chunk.length;
      text += decoder.decode(chunk, { stream: true });
      const lines = text.split('\n');
      text = lines.pop();
      for (const l of lines) line(l);
    },
    tokens() {
      text += decoder.decode();
      if (text.trim().startsWith('{')) {
        try { take(JSON.parse(text).usage); } catch {}
      } else if (text) line(text);
      return tokens;
    }
  };
}

function cleanSchemaDeep(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(cleanSchemaDeep);
  const res = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'encrypted' || k === '$schema' || k === 'cache_control') continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const cleanProps = {};
      for (const [pk, pv] of Object.entries(v)) {
        if (typeof pv === 'string') {
          cleanProps[pk] = { type: pv === 'object' ? 'object' : pv, ...(pv === 'object' ? { properties: {} } : {}) };
        } else {
          cleanProps[pk] = cleanSchemaDeep(pv);
        }
      }
      res[k] = cleanProps;
    } else {
      res[k] = cleanSchemaDeep(v);
    }
  }
  if (!res.type && res.properties) res.type = 'object';
  if (res.type === 'object' && !res.properties) res.properties = {};
  return res;
}

// The upstream request of the HTTP and the WS transport: the IR as an upstream body, with tool schemas
// made acceptable to the target:
// 1. Strip disallowed keywords ('encrypted', '$schema', 'cache_control')
// 2. Fix invalid schema values where a property has a string value "object" instead of a valid schema object
// 3. For ag/* targets (Gemini behind 9Router): rewrite to the strict Schema subset
function buildUpstreamRequest(profile, outFormat, ir, mappedModel, req) {
  const upBody = emitUpstreamBody(outFormat, ir, mappedModel, { thinkingMode: profile.thinkingMode });
  if (upBody?.tools && Array.isArray(upBody.tools)) {
    upBody.tools = cleanSchemaDeep(upBody.tools);
    if (outFormat === 'openai-chat' && isAntigravityModel(mappedModel)) {
      upBody.tools = geminiSafeTools(upBody.tools);
    }
  }
  const { url, headers } = upstreamEndpoint(profile, outFormat, mappedModel, ir.stream, req);
  return { url, headers, upBody };
}

// Feeds upstream stream events to a client renderer until the stream ends, fails or is aborted.
// Returns the stream error, or null. `sink` is the client stream whose backpressure it waits for.
async function pumpStream(upstreamRes, { normalize, col, renderer, splitter, signal, sink, tag }) {
  let streamError = null;
  let events = 0;
  try {
    for await (const parsed of readUpstreamPayloads(upstreamRes)) {
      events++;
      const ev = normalize(parsed);
      col.add(ev);
      if (ev.error) {
        streamError = ev.error;
        break;
      }
      for (const t of ev.think) renderer.think(t.text, t.sig);
      if (ev.sig) renderer.think('', ev.sig);
      for (const t of ev.text) splitter.push(t);
      if (ev.tools.length) {
        splitter.flush();
        for (const tc of ev.tools) renderer.tool(tc);
      }
      await drained(sink);
    }
    if (!streamError && events === 0) streamError = 'Upstream returned an empty stream';
  } catch (streamErr) {
    if (!signal.aborted) {
      console.error(`[${tag}] Stream error:`, streamErr.message);
      streamError = streamErr.message || 'stream interrupted';
    }
  }
  return streamError;
}

// ----------------------------------------------------
// LLM Switcher generic pipeline: client --parse--> IR --emit--> upstream
// Client (input) formats : anthropic | openai-chat | responses (Codex) | vertex
// Upstream (output)      : profile.outFormat or legacy mode mapping
//   direct  -> anthropic | convert -> openai-chat
//   hybrid  -> claude-* via native anthropic, others via openai-chat
// ----------------------------------------------------
async function handleConvert(clientFormat, req, res, bodyBuffer, opts = {}) {
  const { profileKey, profile, error: profileError } = getActiveProfile(clientFormat, req);
  if (!loadConfig()) {
    sendClientError(res, clientFormat, 500, `LLM Switcher config not loaded (${configPath}): ${getConfigLoadError()?.message || 'missing file'}`);
    return;
  }
  if (!profile) {
    sendClientError(res, clientFormat, profileError ? 400 : 503, profileError ||
      `Proxy is currently OFF for ${clientFormat}. Set an active profile for this target in Web UI or via switch command.`);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(bodyBuffer.toString('utf8'));
  } catch {
    sendClientError(res, clientFormat, 400, 'Invalid JSON body');
    return;
  }

  const wantIn = profile.inFormat || 'auto';
  if (wantIn !== 'auto' && wantIn !== clientFormat) {
    sendClientError(res, clientFormat, 400, `Profile "${profileKey}" expects "${wantIn}" input, got "${clientFormat}"`);
    return;
  }

  let ir;
  try {
    ir = parseToIR(clientFormat, payload);
  } catch (e) {
    sendClientError(res, clientFormat, 400, `Cannot parse ${clientFormat} request: ${e.message}`);
    return;
  }
  if (clientFormat === 'vertex') {
    ir.stream = Boolean(opts.vertexStream);
    if (!ir.model && opts.vertexModel) ir.model = opts.vertexModel;
  }

  const reqStartTime = Date.now();
  const requestPreview = previewOf(ir);
  const requestedModel = ir.model || payload.model || '';
  const mappedModel = mapModel(requestedModel, profile, clientFormat);
  const outFormat = resolveOutFormat(profile, mappedModel);
  console.log(`[llm-switcher] ${clientFormat} -> ${outFormat} "${requestedModel}" -> "${mappedModel}" [${profile.name || profileKey}]`);

  const logBase = { clientFormat, outFormat, profile: profileKey, model: mappedModel, stream: ir.stream, requestPreview };
  const log = (extra) => logInspection({ ...logBase, duration: Date.now() - reqStartTime, tokens: { prompt: 0, completion: 0 }, ...extra });

  // AbortController to cancel the upstream fetch as soon as the client disconnects (saves tokens)
  const ac = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) {
      debugLog(`[${profileKey}] Client connection closed before response ended, aborting upstream request`);
      ac.abort();
    }
  };
  res.on('close', onClientClose);

  try {
    // Fast path: anthropic in/out goes straight through, preserving original bytes (including thinking signatures).
    // Note: this branch skips the Healer Engine because it bypasses the IR.
    if (clientFormat === 'anthropic' && outFormat === 'anthropic') {
      const { url, headers } = upstreamEndpoint(profile, 'anthropic', mappedModel, ir.stream, req);
      try {
        const r = await forwardAnthropicDirect(res, payload, bodyBuffer, url, headers, mappedModel, ac.signal, profile);
        log({ status: r.status, tokens: r.tokens, responsePreview: r.healed.length ? `(direct forward, healed: ${r.healed.join('; ')})` : '(direct forward)', error: r.error || undefined });
      } catch (err) {
        if (ac.signal.aborted) return log({ status: 499, error: 'client disconnected' });
        console.error(`[${profileKey}] Direct forward error:`, err.message);
        sendClientError(res, clientFormat, 502, `Direct forward error: ${err.message}`);
        log({ status: 502, error: err.message });
      }
      return;
    }

    const { url, headers, upBody } = buildUpstreamRequest(profile, outFormat, ir, mappedModel, req);
    debugLog(`[${profileKey}] ${clientFormat} -> ${outFormat} ${url} ::`, JSON.stringify(upBody).slice(0, 500));

    let upstreamRes;
    try {
      upstreamRes = await fetch(url, { method: 'POST', headers, body: JSON.stringify(upBody), signal: ac.signal });
    } catch (fetchErr) {
      if (ac.signal.aborted) return log({ status: 499, error: 'client disconnected' });
      console.error(`[${profileKey}] Network error:`, fetchErr.message);
      sendClientError(res, clientFormat, 502, `Failed to connect to upstream: ${fetchErr.cause?.message || fetchErr.message}`);
      return log({ status: 502, error: fetchErr.message });
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text().catch(() => '');
      console.error(`[${profileKey}] Error HTTP ${upstreamRes.status}:`, errText.slice(0, 500));
      sendClientError(res, clientFormat, upstreamRes.status, extractUpstreamMessage(errText) || `Upstream HTTP ${upstreamRes.status}`, pickRetryHeaders(upstreamRes));
      return log({ status: upstreamRes.status, error: errText.slice(0, 300) });
    }

    const normalize = createUpstreamNormalizer(outFormat);
    const col = createCollector();

    // ---- non-stream ----
    if (!ir.stream) {
      let json;
      try {
        json = await upstreamRes.json();
      } catch (e) {
        if (ac.signal.aborted) return log({ status: 499, error: 'client disconnected' });
        sendClientError(res, clientFormat, 502, `Upstream returned non-JSON: ${e.message}`);
        return log({ status: 502, error: e.message });
      }
      col.add(normalize(json));
      if (col.error) {
        sendClientError(res, clientFormat, 502, `Upstream error: ${col.error}`);
        return log({ status: 502, error: String(col.error).slice(0, 300) });
      }
      const split = splitThinkTags(col.text.join(''));
      const think = [...col.think, split.think].filter(Boolean);
      const tools = [...col.tools.values()].sort((a, b) => a.index - b.index);
      const completion = col.completion();
      const out = clientMessage(clientFormat, {
        model: requestedModel || mappedModel, think, text: [split.text], tools, toolMeta: ir.toolMeta,
        finish: col.finish, prompt: col.prompt, completion, cached: col.cached,
        reasoning: col.reasoning, sig: col.sig
      });
      sendJson(res, 200, out);
      return log({
        status: 200, tokens: { prompt: col.prompt, completion },
        thinkingChars: think.join('').length, responsePreview: split.text.slice(0, 300)
      });
    }

    // ---- stream ----
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const renderer = clientRenderer(clientFormat, res, requestedModel || mappedModel, { toolMeta: ir.toolMeta });
    renderer.start();
    const splitter = createThinkTagSplitter(t => renderer.think(t), t => renderer.text(t));
    const streamError = await pumpStream(upstreamRes, { normalize, col, renderer, splitter, signal: ac.signal, sink: res, tag: profileKey });

    if (ac.signal.aborted) {
      return log({ status: 499, error: 'client disconnected mid-stream', responsePreview: col.text.join('').slice(0, 300) });
    }
    splitter.flush();
    const completion = col.completion();
    if (streamError) {
      // Report the error clearly instead of a fake "end_turn" ending -> the client knows the response was cut off and can retry.
      renderer.error(streamError);
    } else {
      renderer.finish(col.finish, { completion, prompt: col.prompt, cached: col.cached, reasoning: col.reasoning, hasTools: col.tools.size > 0 });
    }
    // OpenAI Chat clients expect a terminal [DONE] line (Responses API does not use [DONE]).
    if (clientFormat === 'openai-chat') res.write('data: [DONE]\n\n');
    res.end();
    log({
      status: streamError ? 502 : 200, stream: true,
      tokens: { prompt: col.prompt, completion },
      thinkingChars: col.think.join('').length,
      responsePreview: col.text.join('').slice(0, 300),
      error: streamError ? String(streamError).slice(0, 300) : undefined
    });
  } finally {
    res.off('close', onClientClose);
  }
}

// Claude Code calls /v1/messages/count_tokens to measure context. Native Anthropic upstream -> ask for the real count;
// other upstreams have no equivalent endpoint -> estimate (skip image base64, add a fixed cost per image).
async function handleCountTokens(req, res, buf) {
  let payload;
  try {
    payload = JSON.parse(buf.toString('utf8'));
  } catch {
    return sendClientError(res, 'anthropic', 400, 'Invalid JSON body');
  }
  const { profile } = getActiveProfile('anthropic', req);
  if (profile) {
    const mappedModel = mapModel(payload.model || '', profile, 'anthropic');
    if (resolveOutFormat(profile, mappedModel) === 'anthropic') {
      const { url, headers } = upstreamEndpoint(profile, 'anthropic', mappedModel, false, req);
      const countUrl = profile.endpoints?.countTokens || url.replace(/\/messages$/, '/messages/count_tokens');
      try {
        const body = healAnthropicPayload({ ...payload, model: mappedModel }).payload;
        const r = await fetch(countUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        if (r.ok) {
          const j = await r.json();
          if (typeof j.input_tokens === 'number') return sendJson(res, 200, { input_tokens: j.input_tokens });
        } else {
          debugLog(`count_tokens upstream HTTP ${r.status}, falling back to estimate`);
        }
      } catch (err) {
        debugLog('count_tokens upstream failed, falling back to estimate:', err.message);
      }
    }
  }
  return sendJson(res, 200, { input_tokens: estimateTokens(payload) });
}

// ----------------------------------------------------
// Admin API helpers
// ----------------------------------------------------
// loadConfig keeps serving the last good copy when config.json stops parsing. The admin API must
// not act on that copy: a save would replace the user's hand edit with stale data.
function requireConfig(res) {
  const cfg = loadConfig();
  const loadError = getConfigLoadError();
  if (cfg && loadError && fs.existsSync(configPath)) {
    sendJson(res, 409, { error: `config.json (${configPath}) does not parse: ${loadError.message}. Fix the file; the gateway does not overwrite it until it parses.` });
    return null;
  }
  if (!cfg) {
    sendJson(res, 500, { error: `Config not loaded (${configPath}): ${loadError?.message || 'missing file'}. Copy config.example.json to config.json.` });
  }
  return cfg;
}

// Config changes and interceptor reconciles run one at a time, from read to save. A change that
// waits for its interceptor check must not be saved by a concurrent one, and two must not both
// start an interceptor.
let adminChain = Promise.resolve();
function serialized(fn) {
  const run = adminChain.then(fn);
  adminChain = run.catch(() => {});
  return run;
}
const CONFIG_CHANGES = new Set(['/api/switch', '/api/toggle', '/api/save-profile', '/api/delete-profile', '/api/blindfold/sync']);

// Callers run it inside serialized().
function reconcile(cfg) {
  return reconcileBlindfold(cfg, PORT).then(r => {
    if (!r.ok) console.error(`[llm-switcher:blindfold] ${r.error}`);
    else if (r.action === 'started') console.log('[llm-switcher:blindfold] interceptor started');
    return r;
  });
}

// Returns what the caller must show: removed settings.json values, and a blindfold failure.
async function commit(cfg) {
  // Refuse before saving: a saved interceptor port that a squatter holds would route Codex through it.
  const problem = await checkBlindfoldTarget(cfg, PORT);
  if (problem) return { success: false, error: `Not saved: ${problem}` };
  saveConfig(cfg);
  const revision = configRevision(cfg);
  const st = applyLaunchState(cfg, PORT);
  const removed = st.settings?.removed || [];
  if (removed.length) console.log(`[llm-switcher] settings.json: removed switcher-written values: ${removed.join(', ')}`);
  const bf = await reconcile(cfg);
  return {
    revision,
    settingsRemoved: removed,
    ...(st.envWriteError ? { envWriteError: st.envWriteError } : {}),
    ...(bf.ok ? {} : { success: false, error: `Saved, but the blindfold interceptor is not in line: ${bf.error}` })
  };
}

const VALID_MODES = ['hybrid', 'convert', 'direct'];

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function validateProfileInput(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'Profile must be an object';
  // These strings reach the terminal through `switch status`; a control character could rewrite it.
  for (const k of ['name', 'baseURL', 'optimizerURL']) {
    if (typeof p[k] === 'string' && CONTROL_CHARS.test(p[k])) return `${k} must not contain control characters`;
  }
  if (p.inFormat && p.inFormat !== 'auto' && !IN_FORMATS.includes(p.inFormat)) return `Invalid inFormat "${p.inFormat}"`;
  if (p.outFormat && !OUT_FORMATS.includes(p.outFormat)) return `Invalid outFormat "${p.outFormat}"`;
  if (p.mode && !VALID_MODES.includes(p.mode)) return `Invalid mode "${p.mode}"`;
  if (p.thinkingMode && !THINKING_MODES.includes(p.thinkingMode)) return `Invalid thinkingMode "${p.thinkingMode}"`;
  if (p.baseURL !== undefined) {
    try {
      const u = new URL(p.baseURL);
      if (!['http:', 'https:'].includes(u.protocol)) return 'baseURL must be http(s)';
    } catch {
      return `Invalid baseURL "${p.baseURL}"`;
    }
  }
  // Names the CLI receives end up on a command line. state.mjs drops an unsafe one
  // before the write; refusing it here says why instead of losing it in silence.
  if (p.publicModels !== undefined) {
    if (!Array.isArray(p.publicModels)) return 'publicModels must be an array';
    for (const name of p.publicModels) {
      if (name !== '' && !isSafeModelName(name)) return `Invalid publicModels entry "${name}"`;
    }
  }
  if (p.codexRoles !== undefined) {
    if (!p.codexRoles || typeof p.codexRoles !== 'object' || Array.isArray(p.codexRoles)) {
      return 'codexRoles must be an object';
    }
    for (const [slot, name] of Object.entries(p.codexRoles)) {
      if (name !== '' && !isSafeModelName(name)) return `Invalid codexRoles.${slot} value "${name}"`;
    }
  }
  if (p.blindfoldPort !== undefined && p.blindfoldPort !== '' && !parsePort(p.blindfoldPort)) {
    return `Invalid blindfoldPort "${p.blindfoldPort}"`;
  }
  if (p.blindfoldHost !== undefined && p.blindfoldHost !== '' && !/^[A-Za-z0-9.-]{1,253}$/.test(p.blindfoldHost)) {
    return `Invalid blindfoldHost "${p.blindfoldHost}"`;
  }
  if (p.blindfoldPrefix !== undefined && p.blindfoldPrefix !== '' && !/^\/[A-Za-z0-9._~/-]{0,200}$/.test(p.blindfoldPrefix)) {
    return `Invalid blindfoldPrefix "${p.blindfoldPrefix}"`;
  }
  return null;
}

// API keys are masked with MASKED_KEY in the UI; if the client sends back the masked value, reuse the stored real key.
// Only for the stored baseURL: otherwise the masked value would send the real key to any host the caller names.
const sameBaseURL = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
// endpoints override baseURL per format, so they are part of where the key goes.
const sameDestination = (a, b) => sameBaseURL(a.baseURL, b.baseURL) && JSON.stringify(a.endpoints || {}) === JSON.stringify(b.endpoints || {});

// Changes when config.json changes. The dashboard sends it back, so a change made from a stale
// page is refused instead of overwriting what another tab or the CLI saved.
function configRevision(cfg) {
  return crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 16);
}

function resolveApiKey(cfg, profileKey, apiKey, baseURL) {
  if (apiKey !== MASKED_KEY) return apiKey || '';
  if (!hasProfile(cfg, profileKey)) return '';
  const stored = cfg.profiles[profileKey];
  if (baseURL !== undefined && !sameBaseURL(baseURL, stored.baseURL)) return '';
  return stored.apiKey || '';
}

function upstreamTimeout(ms) {
  return AbortSignal.timeout(ms);
}

async function testUpstream(body, cfg) {
  const baseURL = String(body.baseURL || '').replace(/\/+$/, '');
  if (!baseURL) return { status: 400, json: { ok: false, error: 'Missing baseURL' } };
  const apiKey = resolveApiKey(cfg, body.key, body.apiKey, baseURL);
  const model = body.model || 'default';
  const profile = { baseURL, apiKey, mode: body.mode, outFormat: body.outFormat || undefined };
  const outFormat = resolveOutFormat(profile, model);
  const { url, headers } = upstreamEndpoint(profile, outFormat, model, false, null);
  const ir = { model, system: '', messages: [{ role: 'user', content: 'ping' }], tools: [], toolChoice: null, params: { maxTokens: 16, temperature: null, topP: null, topK: null, stop: [] }, thinking: { type: 'disabled' }, stream: false };
  const start = Date.now();
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(emitUpstreamBody(outFormat, ir, model)), signal: upstreamTimeout(30000) });
  const latency = Date.now() - start;
  if (!r.ok) return { status: 200, json: { ok: false, status: r.status, latency, outFormat, error: (await r.text()).slice(0, 2000) } };
  const data = await r.json().catch(() => ({}));
  const col = createCollector();
  col.add(createUpstreamNormalizer(outFormat)(data));
  const sample = col.text.join('') || col.think.join('') || '(ok, empty response)';
  return { status: 200, json: { ok: true, latency, outFormat, sample: sample.slice(0, 500) } };
}

async function fetchModels(body, cfg) {
  const baseURL = String(body.baseURL || '').replace(/\/+$/, '');
  if (!baseURL) return { status: 400, json: { ok: false, error: 'Missing baseURL' } };
  const apiKey = resolveApiKey(cfg, body.key, body.apiKey, baseURL);
  const headers = {};
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
  }
  const r = await fetch(`${baseURL}/models`, { headers, signal: upstreamTimeout(15000) });
  if (!r.ok) return { status: 200, json: { ok: false, status: r.status, error: (await r.text()).slice(0, 2000) } };
  const data = await r.json();
  let list = [];
  if (Array.isArray(data.data)) list = data.data.map(m => (typeof m === 'string' ? m : m.id));
  else if (Array.isArray(data)) list = data.map(m => (typeof m === 'string' ? m : m.id));
  else if (Array.isArray(data.models)) list = data.models.map(m => (typeof m === 'string' ? m : (m.id || m.name)));
  list = [...new Set(list.filter(Boolean).map(id => String(id).replace(/^models\//, '')))].sort();
  return { status: 200, json: { ok: true, models: list } };
}

// Vertex/Gemini: /v1beta/models/{m}:{action} (Gemini API) and
// /v1/projects/{p}/locations/{l}/publishers/{pub}/models/{m}:{action} (Vertex AI SDK).
const VERTEX_ROUTE = /^\/(?:v1|v1beta|v1beta1)\/(?:projects\/[^/]+\/locations\/[^/]+\/publishers\/[^/]+\/)?models\/([^/:]+):(generateContent|streamGenerateContent)$/;

// ----------------------------------------------------
// Router
// ----------------------------------------------------
async function route(req, res) {
  const parsedUrl = new URL(req.url, 'http://127.0.0.1');
  const pathname = parsedUrl.pathname;
  const method = req.method;

  const guardError = checkRequestOrigin(req);
  if (guardError) {
    req.resume();
    return sendJson(res, 403, { error: guardError });
  }
  if (method === 'OPTIONS') {
    // Only answer preflight for the UI's own origin (already past checkRequestOrigin).
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin || `http://127.0.0.1:${PORT}`,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  // Serve Web UI (no-cache: always serve the latest version after file edits)
  if (method === 'GET' && (pathname === '/' || pathname === '/ui')) {
    if (fs.existsSync(uiHtmlPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(fs.readFileSync(uiHtmlPath, 'utf8'));
    }
  }

  // Health check
  if (method === 'GET' && pathname === '/health') {
    const { profileKey, profile } = getFirstActiveProfile(TARGETS, req);
    // ?challenge=<nonce> lets the CLI tell this gateway from a process that replays a /health body.
    const challenge = parsedUrl.searchParams.get('challenge');
    return sendJson(res, 200, {
      status: 'ok',
      proxy: 'llm-switcher',
      ...(challenge ? {
        pid: process.pid,
        proof: identityProof(challenge, { role: 'gateway', port: PORT, pid: process.pid }, ADMIN_TOKEN.toString())
      } : {}),
      port: PORT,
      configLoaded: Boolean(loadConfig()),
      activeProfile: profileKey || '(none)',
      activeProfiles: loadConfig() ? getActiveMap(loadConfig()) : {},
      mode: profile?.mode || 'hybrid',
      inFormat: profile?.inFormat || 'auto',
      outFormat: profile ? resolveOutFormat(profile, '') : 'none',
      upstream: profile?.baseURL || '(none)'
    });
  }

  // OpenAI-style model list (Codex / OpenAI SDK discovery).
  // Served IDs come from profile.publicModels when set (official-facing names the
  // CLI already knows, e.g. gpt-5.6-sol) so the client never observes the internal
  // upstream IDs or slot aliases. Slot aliases (main, review, ...) are never
  // advertised: Codex sends them in-request and mapModel resolves them server-side.
  // Without publicModels, fall back to the deduplicated mapped upstream IDs.
  if (method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
    const { ids, windows } = servedModels(req);
    const created = Math.floor(Date.now() / 1000);
    return sendJson(res, 200, {
      object: 'list',
      data: ids.map(id => ({ id, object: 'model', created, owned_by: 'system' })),
      models: ids.map(id => ({ ...codexModelEntry(id, windows.get(id)), id, object: 'model', created, owned_by: 'system' }))
    });
  }

  // Individual model metadata: GET /v1/models/{id}
  if (method === 'GET' && (pathname.startsWith('/v1/models/') || pathname.startsWith('/models/'))) {
    const modelId = decodeURIComponent(pathname.replace(/^\/(v1\/)?models\//, ''));
    if (modelId) {
      const { windows } = servedModels(req);
      return sendJson(res, 200, { ...codexModelEntry(modelId, windows.get(modelId)), id: modelId, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'system' });
    }
  }

  if (pathname.startsWith('/api/')) {
    if (!isAdminRequest(req)) {
      req.resume();
      return sendJson(res, 401, { error: 'Unauthorized: send the x-llm-switcher-token header. Open the dashboard with `switch ui`.' });
    }
    return routeApi(req, res, method, pathname);
  }

  // Token count estimation endpoint
  if (method === 'POST' && (pathname === '/v1/messages/count_tokens' || pathname === '/messages/count_tokens')) {
    const buf = await readBody(req, MAX_BODY_SIZE);
    return handleCountTokens(req, res, buf);
  }

  // Client endpoints, one per input protocol (auto-detected by path).
  let clientFormat = null;
  const vmatch = method === 'POST' ? pathname.match(VERTEX_ROUTE) : null;

  // Codex CLI sends GET /v1/responses (and /v1/responses/{id}) to fetch model
  // metadata and retrieve previous responses.  The gateway is stateless, so
  // return a synthetic stub that satisfies the SDK's metadata lookup without
  // erroring out.
  if (method === 'GET' && (pathname === '/v1/responses' || pathname === '/responses' || pathname.startsWith('/v1/responses/') || pathname.startsWith('/responses/'))) {
    req.resume();
    if (pathname === '/v1/responses' || pathname === '/responses') {
      // Model metadata / list — return an empty list
      return sendJson(res, 200, { object: 'list', data: [] });
    }
    // GET /v1/responses/{id} — response retrieval; stateless gateway has no
    // persisted responses so return 404 in OpenAI's error shape.
    return sendJson(res, 404, {
      error: { message: 'Response not found. This gateway is stateless and does not persist responses.', type: 'not_found_error', code: '404' }
    });
  }

  if (method === 'POST') {
    if (pathname === '/v1/messages' || pathname === '/messages') clientFormat = 'anthropic';
    else if (pathname === '/v1/chat/completions' || pathname === '/chat/completions') clientFormat = 'openai-chat';
    else if (pathname === '/v1/responses' || pathname === '/responses') clientFormat = 'responses';
    else if (vmatch) clientFormat = 'vertex';
  }
  if (clientFormat) {
    let buf;
    try {
      buf = await readBody(req, MAX_BODY_SIZE);
    } catch (err) {
      return sendClientError(res, clientFormat, err.status || 400, err.message);
    }
    const opts = vmatch ? { vertexModel: decodeURIComponent(vmatch[1]), vertexStream: vmatch[2] === 'streamGenerateContent' } : {};
    return handleConvert(clientFormat, req, res, buf, opts);
  }

  req.resume();
  return sendJson(res, 404, { error: { message: `Not found: ${method} ${pathname}` } });
}

// The names /v1/models serves, and the window of each. Official names when the profile publishes
// them, otherwise the mapped upstream IDs; each window follows model1M of its slot.
function servedModels(req) {
  const { profile } = getFirstActiveProfile(['responses', 'openai-chat', 'anthropic', 'vertex'], req);
  if (Array.isArray(profile?.publicModels) && profile.publicModels.length) {
    return { ids: [...new Set(profile.publicModels.filter(Boolean))], windows: publicModelWindows(profile) };
  }
  const windows = smallestWindows(Object.entries(profile?.defaultModels || {}).map(([slot, id]) => [id, model1MForSlot(profile, slot)]));
  return { ids: [...windows.keys()], windows };
}

async function routeApi(req, res, method, pathname) {
  // GET /api/status
  if (method === 'GET' && pathname === '/api/status') {
    const cfg = requireConfig(res);
    if (!cfg) return;
    const activeProfiles = getActiveMap(cfg);
    return sendJson(res, 200, {
      port: PORT,
      activeProfile: cfg.activeProfile || null,
      activeProfiles,
      revision: configRevision(cfg),
      claude1MTiers: computeLaunchState(cfg, PORT).claude1MTiers,
      ...readLaunchFlags(),
      claudeBaseURL: activeProfiles.anthropic ? `http://127.0.0.1:${PORT} (injected via launcher)` : '(none / official)',
      config: redactConfig(cfg)
    });
  }

  // GET /api/logs (Live Request/Response Inspector)
  if (method === 'GET' && pathname === '/api/logs') {
    return sendJson(res, 200, { logs: requestLogs.slice().reverse() });
  }

  if (method !== 'POST') {
    req.resume();
    return sendJson(res, 404, { error: `Not found: ${method} ${pathname}` });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.message });
  }

  // POST /api/logs/clear
  if (pathname === '/api/logs/clear') {
    requestLogs.length = 0;
    return sendJson(res, 200, { success: true });
  }

  if (CONFIG_CHANGES.has(pathname)) return serialized(() => routeConfigApi(res, method, pathname, body));
  return routeConfigApi(res, method, pathname, body);
}

async function routeConfigApi(res, method, pathname, body) {
  const loaded = requireConfig(res);
  if (!loaded) return;
  // A copy: a refused change must never reach the cached config that other requests read.
  const cfg = structuredClone(loaded);
  if (typeof body.revision === 'string' && body.revision !== configRevision(loaded)) {
    return sendJson(res, 409, { error: 'config.json changed since this page loaded it. The page reloads it now; check the change and try again.', revision: configRevision(loaded) });
  }

  // POST /api/switch  { target?, profile? | null, deactivate? }
  if (pathname === '/api/switch') {
    let err = null;
    if (body.deactivate) {
      deactivateProfile(cfg, body.deactivate);
    } else if (body.target) {
      err = setTargetProfile(cfg, body.target, body.profile || null);
    } else if (body.profile) {
      err = activateProfile(cfg, body.profile);
    } else {
      deactivateAll(cfg);
    }
    if (err) return sendJson(res, 400, { error: err });
    const applied = await commit(cfg);
    return sendJson(res, applied.success === false ? 502 : 200, { success: true, activeProfile: cfg.activeProfile, activeProfiles: cfg.activeProfiles, ...applied });
  }

  // POST /api/toggle  { target?, enabled }
  if (pathname === '/api/toggle') {
    const map = getActiveMap(cfg);
    let err = null;
    if (body.target) {
      if (!TARGETS.includes(body.target)) return sendJson(res, 400, { error: `Unknown target "${body.target}"` });
      let key = null;
      if (body.enabled) {
        const candidates = [map[body.target], cfg.activeProfile, ...Object.keys(cfg.profiles)];
        key = candidates.find(k => hasProfile(cfg, k) && profileAcceptsTarget(cfg.profiles[k], body.target)) || null;
        if (!key) return sendJson(res, 400, { error: `No profile accepts target "${body.target}"` });
      }
      err = setTargetProfile(cfg, body.target, key);
    } else if (body.enabled) {
      const key = hasProfile(cfg, cfg.activeProfile) ? cfg.activeProfile : Object.keys(cfg.profiles)[0];
      if (!key) return sendJson(res, 400, { error: 'No profiles configured' });
      err = activateProfile(cfg, key);
    } else {
      deactivateAll(cfg);
    }
    if (err) return sendJson(res, 400, { error: err });
    const applied = await commit(cfg);
    return sendJson(res, applied.success === false ? 502 : 200, { success: true, enabled: Boolean(body.enabled), activeProfiles: cfg.activeProfiles, ...applied });
  }

  // POST /api/save-profile  { key, profile }
  if (pathname === '/api/save-profile') {
    const { key, profile } = body;
    if (!isValidProfileKey(key)) {
      return sendJson(res, 400, { error: 'Invalid profile key: use 1-64 chars of letters, digits, ".", "_" or "-"' });
    }
    const invalid = validateProfileInput(profile);
    if (invalid) return sendJson(res, 400, { error: invalid });

    const existing = hasProfile(cfg, key) ? cfg.profiles[key] : {};
    // Merge so unmanaged UI fields are not lost (e.g. `endpoints`).
    const merged = { ...existing, ...profile };
    // A payload without apiKey, or with the mask, keeps the stored key, but only for the destination
    // it was stored with: otherwise one request could send the real key to any host.
    const keepsKey = !Object.hasOwn(profile, 'apiKey') || profile.apiKey === MASKED_KEY;
    if (keepsKey && existing.apiKey && !sameDestination(merged, existing)) {
      return sendJson(res, 400, { error: 'The stored API key is sent only to the baseURL and endpoints it was saved with. Enter the key again to use a new URL.' });
    }
    merged.apiKey = keepsKey ? (existing.apiKey || '') : String(profile.apiKey || '');
    for (const k of ['outFormat', 'optimizerURL', 'thinkingMode']) {
      if (Object.hasOwn(profile, k) && !profile[k]) delete merged[k];
    }
    cfg.profiles[key] = merged;

    // A target assigned to this profile whose new inFormat no longer supports it -> unassign that target.
    const map = getActiveMap(cfg);
    cfg.activeProfiles = map;
    let unassigned = false;
    for (const t of TARGETS) {
      if (map[t] === key && !profileAcceptsTarget(merged, t)) {
        map[t] = null;
        unassigned = true;
      }
    }

    // Profile is active (or was just unassigned from a target) -> refresh 1M flags / env files.
    const applied = isProfileActive(cfg, key) || unassigned ? await commit(cfg) : (saveConfig(cfg), { revision: configRevision(cfg) });
    return sendJson(res, applied.success === false ? 502 : 200, { success: true, ...applied });
  }

  // POST /api/delete-profile  { key }
  if (pathname === '/api/delete-profile') {
    const err = deleteProfile(cfg, body.key);
    if (err) return sendJson(res, 404, { error: err });
    const applied = await commit(cfg);
    return sendJson(res, applied.success === false ? 502 : 200, { success: true, ...applied });
  }

  // POST /api/blindfold/sync — the CLI asks the owner to bring the interceptor in line with config.json.
  if (pathname === '/api/blindfold/sync') {
    const r = await reconcile(cfg);
    return sendJson(res, r.ok ? 200 : 500, r);
  }

  // POST /api/test-upstream
  if (pathname === '/api/test-upstream') {
    try {
      const r = await testUpstream(body, cfg);
      return sendJson(res, r.status, r.json);
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.name === 'TimeoutError' ? 'Timed out waiting for upstream' : (err.cause?.message || err.message) });
    }
  }

  // POST /api/fetch-models
  if (pathname === '/api/fetch-models') {
    try {
      const r = await fetchModels(body, cfg);
      return sendJson(res, r.status, r.json);
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.name === 'TimeoutError' ? 'Timed out waiting for upstream' : (err.cause?.message || err.message) });
    }
  }

  return sendJson(res, 404, { error: `Not found: ${method} ${pathname}` });
}

const server = http.createServer((req, res) => {
  route(req, res).catch(err => {
    console.error('[llm-switcher] Unhandled request error:', err);
    if (!res.headersSent) {
      sendJson(res, err.status || 500, { error: { message: `Gateway error: ${err.message}` } });
    } else {
      try { res.end(); } catch {}
    }
  });
});

function encodeWsFrame(data, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const len = payload.length;
  let header;
  if (len <= 125) {
    header = Buffer.from([0x80 | (opcode & 0x0f), len]);
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Map an upstream HTTP status to a Responses-API error code so Codex can tell a
// retryable rate-limit from a fatal request error.
function responsesErrorCode(status) {
  if (status === 429) return 'rate_limit_exceeded';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'not_found_error';
  if (status === 400) return 'invalid_request_error';
  return 'server_error';
}

// Terminal failure for the WS (responses-ws) transport: Codex ends a turn only on
// response.completed / response.failed, so a bare {type:'error'} frame leaves the turn
// hanging. Emit the full created -> in_progress -> failed sequence instead.
function sendWsFailed(socket, model, message, status = 500) {
  if (!socket.writable) return;
  const renderer = createResponsesStream((e, d) => {
    if (socket.writable) socket.write(encodeWsFrame(JSON.stringify(d)));
  }, model || 'main');
  renderer.start();
  renderer.error(message, responsesErrorCode(status));
}

// 9Router forwards OpenAI-format tools to Gemini/Vertex for ag/* models, which accept only
// a strict Schema subset: bare "object" strings, $ref/$defs, anyOf-null unions and
// additionalProperties all come back as HTTP 400 INVALID_ARGUMENT. Rewrite tool parameters
// into that subset before sending upstream. Non-ag targets keep the OpenAI superset.
function geminiSafeTools(tools) {
  return tools.map(t => {
    if (!t || t.type !== 'function' || !t.function) return t;
    return { ...t, function: { ...t.function, parameters: toGeminiSchema(t.function.parameters || { type: 'object', properties: {} }) } };
  });
}

// One turn of the Codex WS transport. The socket loop runs turns one at a time and owns `ac`.
async function handleWsResponseCreate(socket, payload, req, ac) {
  const clientFormat = 'responses';
  const { profileKey, profile, error: profileError } = getActiveProfile(clientFormat, req);
  if (!loadConfig()) {
    sendWsFailed(socket, payload?.model || 'main', `LLM Switcher config not loaded (${configPath}): ${getConfigLoadError()?.message || 'missing file'}`, 500);
    return;
  }
  if (!profile) {
    sendWsFailed(socket, payload?.model || 'main', profileError || 'Proxy is currently OFF for responses.', 503);
    return;
  }

  let ir;
  try {
    ir = parseToIR('responses', payload);
  } catch (e) {
    sendWsFailed(socket, payload?.model || 'main', `Cannot parse responses request: ${e.message}`, 400);
    return;
  }
  ir.stream = true;

  const reqStartTime = Date.now();
  const requestPreview = previewOf(ir);
  const requestedModel = ir.model || payload.model || '';
  const mappedModel = mapModel(requestedModel, profile, clientFormat);
  const outFormat = resolveOutFormat(profile, mappedModel);

  console.log(`[llm-switcher:ws] ${clientFormat} -> ${outFormat} "${requestedModel}" -> "${mappedModel}" [${profile.name || profileKey}]`);
  const logBase = { clientFormat: 'responses-ws', outFormat, profile: profileKey, model: mappedModel, stream: true, requestPreview };
  const log = (extra) => logInspection({ ...logBase, duration: Date.now() - reqStartTime, tokens: { prompt: 0, completion: 0 }, ...extra });

  try {
    const { url, headers, upBody } = buildUpstreamRequest(profile, outFormat, ir, mappedModel, req);
    debugLog(`[${profileKey}:ws] ${clientFormat} -> ${outFormat} ${url} ::`, JSON.stringify(upBody).slice(0, 300));

    let upstreamRes;
    try {
      upstreamRes = await fetch(url, { method: 'POST', headers, body: JSON.stringify(upBody), signal: ac.signal });
    } catch (fetchErr) {
      if (ac.signal.aborted) return log({ status: 499, error: 'client disconnected' });
      console.error(`[${profileKey}:ws] Network error:`, fetchErr.message);
      sendWsFailed(socket, mappedModel, `Failed to connect to upstream: ${fetchErr.cause?.message || fetchErr.message}`, 502);
      return log({ status: 502, error: fetchErr.message });
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text().catch(() => '');
      console.error(`[${profileKey}:ws] Error HTTP ${upstreamRes.status}:`, errText.slice(0, 500));
      sendWsFailed(socket, mappedModel, extractUpstreamMessage(errText) || `Upstream HTTP ${upstreamRes.status}`, upstreamRes.status);
      return log({ status: upstreamRes.status, error: errText.slice(0, 300) });
    }

    const normalize = createUpstreamNormalizer(outFormat);
    const col = createCollector();

    const renderer = createResponsesStream((e, d) => {
      if (socket.writable) {
        socket.write(encodeWsFrame(JSON.stringify(d)));
      }
    }, requestedModel || mappedModel, { toolMeta: ir.toolMeta });

    renderer.start();
    const splitter = createThinkTagSplitter(t => renderer.think(t), t => renderer.text(t));
    const streamError = await pumpStream(upstreamRes, { normalize, col, renderer, splitter, signal: ac.signal, sink: socket, tag: `${profileKey}:ws` });

    if (ac.signal.aborted) {
      return log({ status: 499, error: 'client disconnected mid-stream', responsePreview: col.text.join('').slice(0, 300) });
    }
    splitter.flush();
    const completion = col.completion();
    if (streamError) {
      renderer.error(streamError);
    } else {
      renderer.finish(col.finish, { completion, prompt: col.prompt, cached: col.cached, reasoning: col.reasoning, hasTools: col.tools.size > 0 });
    }
    log({
      status: streamError ? 502 : 200, stream: true,
      ...(streamError ? { error: String(streamError).slice(0, 300) } : {}),
      tokens: { prompt: col.prompt, completion },
      thinkingChars: col.think.join('').length,
      responsePreview: col.text.join('').slice(0, 300)
    });
  } catch (err) {
    if (ac.signal.aborted) return log({ status: 499, error: 'aborted' });
    console.error(`[${profileKey}:ws] Error:`, err);
    sendWsFailed(socket, payload?.model || 'main', err.message, 500);
    log({ status: 500, error: err.message });
  }
}

server.on('upgrade', (req, socket) => {
  // Node emits 'upgrade' instead of 'request', so route() never runs here and the
  // Host/Origin guard has to be applied again. Browsers do not apply same-origin to
  // WebSocket, so without this any visited page could open ws://127.0.0.1/v1/responses
  // and spend the profile's API key. An absent Origin stays allowed on purpose: Codex
  // sends none, and the blindfold interceptor deletes it.
  const guardError = checkRequestOrigin(req);
  if (guardError) {
    socket.write(
      'HTTP/1.1 403 Forbidden\r\n' +
      'Connection: close\r\n' +
      'Content-Type: application/json\r\n\r\n' +
      `{"error":{"message":${JSON.stringify(guardError)}}}\r\n`
    );
    socket.destroy();
    return;
  }

  const p = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  if (p !== '/v1/responses' && p !== '/responses') {
    socket.write(
      'HTTP/1.1 404 Not Found\r\n' +
      'Connection: close\r\n' +
      'Content-Type: application/json\r\n\r\n' +
      `{"error":{"message":"Not found: ${req.method} ${p}"}}\r\n`
    );
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  
  // The official name or the slot, never the upstream ID. The value goes into a raw header line.
  const { profile } = getActiveProfile('responses', req);
  const publicMain = profile ? codexPublicModel(profile, 'main') : '';
  const activeModel = isSafeModelName(publicMain) ? publicMain : 'main';

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    `OpenAI-Model: ${activeModel}\r\n` +
    'x-reasoning-included: true\r\n' +
    'x-codex-turn-state: ready\r\n\r\n'
  );

  const read = createFrameReader({ maxMessage: MAX_BODY_SIZE });
  // Turns run one at a time: two at once interleave their events on one socket. Every turn,
  // queued or running, holds a controller here, so a cancel or a close stops all of them.
  const turns = new Set();
  let turnChain = Promise.resolve();
  const abortTurns = () => { for (const ac of turns) ac.abort(); };

  const handleMessage = (msg) => {
    if (msg.type === 'response.create') {
      const ac = new AbortController();
      turns.add(ac);
      turnChain = turnChain
        .then(() => (ac.signal.aborted ? null : handleWsResponseCreate(socket, msg, req, ac)))
        .catch(err => {
          // A throw before the handler's own try: Codex ends a turn only on response.failed.
          console.error('[llm-switcher:ws] Unhandled turn error:', err);
          if (!ac.signal.aborted) sendWsFailed(socket, msg.model || 'main', err.message, 500);
        })
        .finally(() => turns.delete(ac));
    } else if (msg.type === 'response.cancel') {
      abortTurns();
    } else if (msg.type === 'session.update') {
      if (socket.writable) socket.write(encodeWsFrame(JSON.stringify({ type: 'session.updated', session: msg.session || {} })));
    } else if (msg.type === 'conversation.item.create') {
      if (socket.writable) socket.write(encodeWsFrame(JSON.stringify({ type: 'conversation.item.created', item: msg.item || {} })));
    }
  };

  socket.on('data', (chunk) => {
    for (const f of read(chunk)) {
      if (f.type === 'error') {
        // 1009 = message too big. The reader has stopped, so the connection cannot continue.
        const code = Buffer.alloc(2);
        code.writeUInt16BE(/exceeds/.test(f.reason) ? 1009 : 1002);
        if (socket.writable) socket.end(encodeWsFrame(code, 8));
        abortTurns();
        return;
      }
      if (f.type === 'close') {
        if (socket.writable) socket.end(encodeWsFrame(Buffer.alloc(0), 8));
        return;
      }
      if (f.type === 'ping') {
        if (socket.writable) socket.write(encodeWsFrame(f.payload, 10));
        continue;
      }
      if (f.type !== 'text') continue;
      let msg;
      try {
        msg = JSON.parse(f.payload.toString('utf8'));
      } catch (e) {
        console.error('[llm-switcher:ws] Bad WS message JSON:', e.message);
        continue;
      }
      handleMessage(msg);
    }
  });

  socket.on('close', abortTurns);
  // The upgraded socket allows half-open: a client FIN alone would not close it, and the turn
  // would keep spending upstream tokens until the next write failed.
  socket.on('end', () => {
    abortTurns();
    socket.end();
  });

  socket.on('error', (err) => {
    debugLog('[llm-switcher:ws] Socket error:', err.message);
    abortTurns();
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[llm-switcher:ERROR] Port ${PORT} is already in use by another process!`);
    console.error(`- Run 'switch status' to check, or 'switch off' to stop a running LLM Switcher.`);
    console.error(`- If another tool (e.g. headroom/rtk/proxy) is using port ${PORT}, change "port" in config.json or pass --port.`);
    process.exit(1);
  } else {
    console.error('[llm-switcher:ERROR]', err);
  }
});

if (!loadConfig()) {
  console.warn(`[llm-switcher:WARN] Could not load ${configPath}: ${getConfigLoadError()?.message}. Copy config.example.json to config.json.`);
}

server.listen(PORT, '127.0.0.1', () => {
  // A service start or a restart on a new port finds env-codex.* already pointing at the interceptor.
  const cfg = loadConfig();
  if (cfg && !getConfigLoadError()) serialized(() => reconcile(cfg));
  console.log(`[llm-switcher] Server running on http://127.0.0.1:${PORT}`);
  console.log(`[llm-switcher] Web UI available at: http://127.0.0.1:${PORT}/ui`);
  console.log(`[llm-switcher] Endpoints: /v1/messages (anthropic) | /v1/chat/completions (openai) | /v1/responses (codex) | /v1beta/models/* (vertex)`);
});
