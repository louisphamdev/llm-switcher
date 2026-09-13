import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUT_FORMATS, IN_FORMATS, parseToIR, emitUpstreamBody, createUpstreamNormalizer, createCollector,
  createThinkTagSplitter, splitThinkTags, healAnthropicPayload, estimateTokens, THINKING_MODES,
  createAnthropicStream, createChatStream, createResponsesStream, createVertexStream,
  buildAnthropicMessage, buildChatMessage, buildResponsesMessage, buildVertexMessage
} from './formats.mjs';
import {
  TARGETS, configPath, loadConfig, getConfigLoadError, saveConfig, resolvePort, hasProfile, isValidProfileKey,
  getActiveMap, setTargetProfile, activateProfile, deactivateProfile, deactivateAll, deleteProfile,
  isProfileActive, profileAcceptsTarget, applyLaunchState, readLaunchFlags, redactConfig, MASKED_KEY
} from './state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiHtmlPath = path.join(__dirname, 'ui.html');

const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_API_BODY_SIZE = 1024 * 1024;  // 1MB cho /api/*

// Chống xung đột mạng: Đảm bảo localhost / 127.0.0.1 không bị các proxy bên ngoài (RTK, Headroom, VPN) chặn bắt
const currentNoProxy = process.env.NO_PROXY || process.env.no_proxy || '';
const localHosts = ['127.0.0.1', 'localhost'];
const existingNoProxy = currentNoProxy.split(',').map(s => s.trim().toLowerCase());
const missingNoProxy = localHosts.filter(h => !existingNoProxy.includes(h));
if (missingNoProxy.length > 0) {
  process.env.NO_PROXY = currentNoProxy ? `${currentNoProxy},${missingNoProxy.join(',')}` : missingNoProxy.join(',');
  process.env.no_proxy = process.env.NO_PROXY;
}

// Port cố định cho vòng đời process: đổi "port" trong config.json khi đang chạy không được làm
// env.cmd / flag trỏ sang port mà server không lắng nghe.
const PORT = resolvePort();

// In-memory Request / Response Inspector Ring Buffer (tối đa 40 request gần nhất)
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

// Chặn DNS rebinding (Host lạ trỏ về 127.0.0.1) và CSRF từ trang web khác (Origin lạ).
// Nếu không có check Host, một trang độc hại có thể đọc /api/status (chứa API key) hoặc tiêu token qua /v1/*.
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
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks)); });
    req.on('error', err => {
      err.status = 400;
      reject(err);
    });
  });
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

  // Tra cứu active profile theo target CLI (clientFormat: anthropic | responses | openai-chat | vertex).
  // Profile đã bị xoá / target bị tắt -> coi như OFF, không âm thầm rơi sang profile khác (khác API key!).
  const key = clientFormat ? getActiveMap(cfg)[clientFormat] : (cfg.activeProfile || null);
  if (!key || !hasProfile(cfg, key)) return { cfg, profileKey: key || null, profile: null };
  return { cfg, profileKey: key, profile: cfg.profiles[key] };
}

// Dùng cho endpoint không gắn với 1 client format cụ thể (/health, /v1/models).
function getFirstActiveProfile(preferred) {
  for (const t of preferred) {
    const r = getActiveProfile(t);
    if (r.profile) return r;
  }
  return { cfg: loadConfig(), profileKey: null, profile: null };
}

function mapModel(requestedModel, profile) {
  if (!requestedModel) return profile.defaultModels?.sonnet || 'claude-sonnet-4-6';
  const clean = requestedModel.replace(/\[1m\]/gi, '').trim();
  // Nếu client đã chỉ định rõ model có prefix nhà cung cấp (VD ag/..., gh/..., cf/...) thì giữ nguyên
  if (clean.includes('/') && !clean.startsWith('anthropic/')) {
    return clean;
  }
  const m = clean.toLowerCase();
  if (m.includes('fable')) return profile.defaultModels?.fable || clean;
  if (m.includes('opus')) return profile.defaultModels?.opus || clean;
  if (m.includes('haiku')) return profile.defaultModels?.haiku || clean;
  if (m.includes('sonnet')) return profile.defaultModels?.sonnet || clean;
  return clean || requestedModel;
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

// Mỗi SDK parse lỗi theo shape riêng; Claude Code dựa vào error.type + retry-after để quyết định retry.
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

// Header client KHÔNG được chuyển tiếp lên upstream: credential của client (VD x-goog-api-key của Gemini SDK
// sẽ lộ sang upstream bên thứ 3), header điều khiển của switcher, và header hop-by-hop / định danh mạng.
const BLOCKED_PASSTHROUGH = new Set([
  'x-api-key', 'x-goog-api-key', 'x-goog-user-project', 'x-profile', 'x-llm-profile',
  'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port'
]);

function upstreamEndpoint(profile, outFormat, model, stream, req) {
  const base = String(profile.baseURL || '').replace(/\/+$/, '');
  const ov = profile.endpoints || {};
  const key = profile.apiKey || '';
  const headers = { 'Content-Type': 'application/json' };

  // Passthrough an toàn các client headers từ tool trung gian (x-request-id, traceparent, x-...)
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

// Đọc upstream stream: chịu cả SSE `data:` lẫn raw JSON lines (Vertex framing).
async function* readUpstreamPayloads(upstreamRes) {
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder('utf8');
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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

  // Chỉ serialize lại khi thực sự phải sửa; còn lại gửi nguyên bytes của client.
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
  const reader = upstreamRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!upstreamRes.ok && errorPreview.length < 300) errorPreview += Buffer.from(value).toString('utf8');
      res.write(value);
    }
  } catch (streamErr) {
    if (streamErr.name !== 'AbortError') console.error('[DirectForward] Stream error:', streamErr.message);
  } finally {
    res.end();
  }
  return { status: upstreamRes.status, error: upstreamRes.ok ? null : errorPreview.slice(0, 300), healed: healed.notes };
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
  const mappedModel = mapModel(requestedModel, profile);
  const outFormat = resolveOutFormat(profile, mappedModel);
  console.log(`[llm-switcher] ${clientFormat} -> ${outFormat} "${requestedModel}" -> "${mappedModel}" [${profile.name || profileKey}]`);

  const logBase = { clientFormat, outFormat, profile: profileKey, model: mappedModel, stream: ir.stream, requestPreview };
  const log = (extra) => logInspection({ ...logBase, duration: Date.now() - reqStartTime, tokens: { prompt: 0, completion: 0 }, ...extra });

  // AbortController để huỷ fetch upstream ngay khi client ngắt kết nối (tiết kiệm token)
  const ac = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) {
      debugLog(`[${profileKey}] Client connection closed before response ended, aborting upstream request`);
      ac.abort();
    }
  };
  res.on('close', onClientClose);

  try {
    // Fast path: anthropic in/out đi thẳng, giữ nguyên bytes (kể cả thinking signatures).
    // Lưu ý: nhánh này không chạy Healer Engine vì không đi qua IR.
    if (clientFormat === 'anthropic' && outFormat === 'anthropic') {
      const { url, headers } = upstreamEndpoint(profile, 'anthropic', mappedModel, ir.stream, req);
      try {
        const r = await forwardAnthropicDirect(res, payload, bodyBuffer, url, headers, mappedModel, ac.signal, profile);
        log({ status: r.status, responsePreview: r.healed.length ? `(direct forward, healed: ${r.healed.join('; ')})` : '(direct forward)', error: r.error || undefined });
      } catch (err) {
        if (ac.signal.aborted) return log({ status: 499, error: 'client disconnected' });
        console.error(`[${profileKey}] Direct forward error:`, err.message);
        sendClientError(res, clientFormat, 502, `Direct forward error: ${err.message}`);
        log({ status: 502, error: err.message });
      }
      return;
    }

    const upBody = emitUpstreamBody(outFormat, ir, mappedModel, { thinkingMode: profile.thinkingMode });
    const { url, headers } = upstreamEndpoint(profile, outFormat, mappedModel, ir.stream, req);
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
        model: mappedModel, think, text: [split.text], tools, toolMeta: ir.toolMeta,
        finish: col.finish, prompt: col.prompt, completion, cached: col.cached, sig: col.sig
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
    const renderer = clientRenderer(clientFormat, res, mappedModel, { toolMeta: ir.toolMeta });
    renderer.start();
    const splitter = createThinkTagSplitter(t => renderer.think(t), t => renderer.text(t));
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
      }
      if (!streamError && events === 0) streamError = 'Upstream returned an empty stream';
    } catch (streamErr) {
      if (!ac.signal.aborted) {
        console.error(`[${profileKey}] Stream error:`, streamErr.message);
        streamError = streamErr.message || 'stream interrupted';
      }
    }

    if (ac.signal.aborted) {
      return log({ status: 499, error: 'client disconnected mid-stream', responsePreview: col.text.join('').slice(0, 300) });
    }
    splitter.flush();
    const completion = col.completion();
    if (streamError) {
      // Báo lỗi rõ ràng thay vì kết thúc "end_turn" giả -> client biết response bị cụt và có thể retry.
      renderer.error(streamError);
    } else {
      renderer.finish(col.finish, { completion, prompt: col.prompt, cached: col.cached, hasTools: col.tools.size > 0 });
    }
    // OpenAI Chat clients expect a terminal [DONE] line (Responses API không dùng [DONE]).
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

// Claude Code gọi /v1/messages/count_tokens để tính context. Upstream Anthropic native -> hỏi số thật;
// upstream khác không có endpoint tương đương -> ước lượng (bỏ qua base64 ảnh, cộng cố định mỗi ảnh).
async function handleCountTokens(req, res, buf) {
  let payload;
  try {
    payload = JSON.parse(buf.toString('utf8'));
  } catch {
    return sendClientError(res, 'anthropic', 400, 'Invalid JSON body');
  }
  const { profile } = getActiveProfile('anthropic', req);
  if (profile) {
    const mappedModel = mapModel(payload.model || '', profile);
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
function requireConfig(res) {
  const cfg = loadConfig();
  if (!cfg) {
    sendJson(res, 500, { error: `Config not loaded (${configPath}): ${getConfigLoadError()?.message || 'missing file'}. Copy config.example.json to config.json.` });
  }
  return cfg;
}

function commit(cfg) {
  saveConfig(cfg);
  applyLaunchState(cfg, PORT);
}

const VALID_MODES = ['hybrid', 'convert', 'direct'];

function validateProfileInput(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'Profile must be an object';
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
  return null;
}

// API key trong UI bị che bằng MASKED_KEY; nếu client gửi lại đúng giá trị che thì dùng key thật đã lưu.
function resolveApiKey(cfg, profileKey, apiKey) {
  if (apiKey === MASKED_KEY) return hasProfile(cfg, profileKey) ? (cfg.profiles[profileKey].apiKey || '') : '';
  return apiKey || '';
}

function upstreamTimeout(ms) {
  return AbortSignal.timeout(ms);
}

async function testUpstream(body, cfg) {
  const baseURL = String(body.baseURL || '').replace(/\/+$/, '');
  if (!baseURL) return { status: 400, json: { ok: false, error: 'Missing baseURL' } };
  const apiKey = resolveApiKey(cfg, body.key, body.apiKey);
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
  const apiKey = resolveApiKey(cfg, body.key, body.apiKey);
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

// Vertex/Gemini: /v1beta/models/{m}:{action} (Gemini API) và
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
    // Chỉ trả lời preflight cho chính origin của UI (đã qua checkRequestOrigin).
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin || `http://127.0.0.1:${PORT}`,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  // Serve Web UI (no-cache: luôn serve bản mới nhất sau khi sửa file)
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
    const { profileKey, profile } = getFirstActiveProfile(TARGETS);
    return sendJson(res, 200, {
      status: 'ok',
      proxy: 'llm-switcher',
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
  if (method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
    const { profile } = getFirstActiveProfile(['responses', 'openai-chat', 'anthropic', 'vertex']);
    const ids = profile ? [...new Set(Object.values(profile.defaultModels || {}).filter(Boolean))] : [];
    const created = Math.floor(Date.now() / 1000);
    return sendJson(res, 200, {
      object: 'list',
      data: ids.map(id => ({ id, object: 'model', created, owned_by: 'llm-switcher' }))
    });
  }

  if (pathname.startsWith('/api/')) {
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

  const cfg = requireConfig(res);
  if (!cfg) return;

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
    commit(cfg);
    return sendJson(res, 200, { success: true, activeProfile: cfg.activeProfile, activeProfiles: cfg.activeProfiles });
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
    commit(cfg);
    return sendJson(res, 200, { success: true, enabled: Boolean(body.enabled), activeProfiles: cfg.activeProfiles });
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
    // Merge để không làm mất field UI không quản lý (VD `endpoints`).
    const merged = { ...existing, ...profile };
    merged.apiKey = resolveApiKey(cfg, key, profile.apiKey);
    for (const k of ['outFormat', 'optimizerURL', 'thinkingMode']) {
      if (Object.hasOwn(profile, k) && !profile[k]) delete merged[k];
    }
    cfg.profiles[key] = merged;

    // Target đang gán profile này mà inFormat mới không còn hỗ trợ -> tắt target đó.
    const map = getActiveMap(cfg);
    cfg.activeProfiles = map;
    let unassigned = false;
    for (const t of TARGETS) {
      if (map[t] === key && !profileAcceptsTarget(merged, t)) {
        map[t] = null;
        unassigned = true;
      }
    }

    // Profile đang active (hoặc vừa bị gỡ khỏi target) -> cập nhật lại flag 1M / env files.
    if (isProfileActive(cfg, key) || unassigned) commit(cfg);
    else saveConfig(cfg);
    return sendJson(res, 200, { success: true });
  }

  // POST /api/delete-profile  { key }
  if (pathname === '/api/delete-profile') {
    const err = deleteProfile(cfg, body.key);
    if (err) return sendJson(res, 404, { error: err });
    commit(cfg);
    return sendJson(res, 200, { success: true });
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
  console.log(`[llm-switcher] Server running on http://127.0.0.1:${PORT}`);
  console.log(`[llm-switcher] Web UI available at: http://127.0.0.1:${PORT}/ui`);
  console.log(`[llm-switcher] Endpoints: /v1/messages (anthropic) | /v1/chat/completions (openai) | /v1/responses (codex) | /v1beta/models/* (vertex)`);
});
