import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  OUT_FORMATS, parseToIR, emitUpstreamBody, normalizeUpstream, createCollector,
  createAnthropicStream, createChatStream, createResponsesStream, createVertexStream,
  buildAnthropicMessage, buildChatMessage, buildResponsesMessage, buildVertexMessage
} from './formats.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, 'config.json');
const uiHtmlPath = path.join(__dirname, 'ui.html');

const userProfile = os.homedir();
const claudeSettingsPath = path.join(userProfile, '.claude', 'settings.json');
const claudeBackupPath = path.join(userProfile, '.claude', 'settings.json.bak-pre-9router-proxy');
const activeFlagPath = path.join(__dirname, 'active.flag');
const flag1MPath = path.join(__dirname, '1m.flag'); // Claude Code launcher flag
const flagCodex1MPath = path.join(__dirname, 'codex-1m.flag'); // Codex launcher flag
const flagOpenAI1MPath = path.join(__dirname, 'openai-1m.flag'); // OpenAI launcher flag
const envCmdPath = path.join(__dirname, 'env.cmd');
const envShPath = path.join(__dirname, 'env.sh');

// Chống xung đột mạng: Đảm bảo localhost / 127.0.0.1 không bị các proxy bên ngoài (RTK, Headroom, VPN) chặn bắt
const currentNoProxy = process.env.NO_PROXY || process.env.no_proxy || '';
const localHosts = ['127.0.0.1', 'localhost'];
const existingNoProxy = currentNoProxy.split(',').map(s => s.trim().toLowerCase());
const missingNoProxy = localHosts.filter(h => !existingNoProxy.includes(h));
if (missingNoProxy.length > 0) {
  process.env.NO_PROXY = currentNoProxy ? `${currentNoProxy},${missingNoProxy.join(',')}` : missingNoProxy.join(',');
  process.env.no_proxy = process.env.NO_PROXY;
}

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

// Cấu hình cổng lắng nghe: Cho phép ghi đè linh hoạt qua CLI arg (--port / -p), env (PORT / LLM_SWITCHER_PORT), hoặc config.json
function getListeningPort() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      const p = parseInt(args[i + 1], 10);
      if (!isNaN(p) && p > 0 && p <= 65535) return p;
    }
  }
  const envP = parseInt(process.env.PORT || process.env.LLM_SWITCHER_PORT, 10);
  if (!isNaN(envP) && envP > 0 && envP <= 65535) return envP;
  const cfg = loadConfig();
  return cfg?.port || 3456;
}

let cachedConfig = null;
let lastMtime = 0;

function loadConfig() {
  try {
    const stat = fs.statSync(configPath);
    if (!cachedConfig || stat.mtimeMs > lastMtime) {
      const raw = fs.readFileSync(configPath, 'utf8');
      cachedConfig = JSON.parse(raw);
      lastMtime = stat.mtimeMs;
    }
  } catch (err) {}
  return cachedConfig;
}

function saveConfig(newConfig) {
  cachedConfig = newConfig;
  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8');
  lastMtime = fs.statSync(configPath).mtimeMs;
}

function getActiveProfile(clientFormat, req) {
  const cfg = loadConfig();
  let reqProfile = null;
  if (req) {
    reqProfile = req.headers['x-profile'] || req.headers['x-llm-profile'];
    if (!reqProfile && req.url) {
      try {
        const u = new URL(req.url, 'http://localhost');
        reqProfile = u.searchParams.get('profile');
      } catch {}
    }
  }
  if (reqProfile && cfg.profiles[reqProfile]) {
    return { cfg, profileKey: reqProfile, profile: cfg.profiles[reqProfile] };
  }

  // Tra cứu active profile theo target CLI (clientFormat: anthropic | responses | openai-chat | vertex)
  const activeMap = cfg.activeProfiles || {};
  let targetKey = clientFormat ? activeMap[clientFormat] : undefined;
  if (targetKey === undefined) {
    targetKey = cfg.activeProfile;
  }

  // Target này bị tắt riêng (null hoặc rỗng)
  if (targetKey === null || targetKey === '') {
    return { cfg, profileKey: null, profile: null };
  }

  const profileKey = targetKey || cfg.activeProfile || Object.keys(cfg.profiles)[0] || '9router';
  const profile = cfg.profiles[profileKey] || Object.values(cfg.profiles)[0];
  return { cfg, profileKey, profile };
}

function debugLog(...args) {
  const cfg = loadConfig();
  if (cfg?.debug) {
    console.log('[DEBUG]', ...args);
  }
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
  // event=null -> raw `data:` line (OpenAI Chat / Responses / Vertex clients).
  if (event) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  else res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ----------------------------------------------------
// CLI Launcher & Flags Helper (Zero config mutation)
// ----------------------------------------------------
function applyProfileToClaude(profile, port) {
  const cfg = loadConfig();
  const PORT = port || getListeningPort();
  const activeMap = cfg.activeProfiles || {
    anthropic: cfg.activeProfile,
    responses: cfg.activeProfile,
    'openai-chat': cfg.activeProfile,
    vertex: cfg.activeProfile
  };

  const hasAnyActive = Object.values(activeMap).some(Boolean);
  if (hasAnyActive) {
    fs.writeFileSync(activeFlagPath, 'active', 'utf8');
  } else if (fs.existsSync(activeFlagPath)) {
    try { fs.unlinkSync(activeFlagPath); } catch {}
  }

  // 1. Claude Code 1M: CHỈ bật khi profile active của Claude Code hỗ trợ 1M
  const claudeProfileKey = activeMap.anthropic;
  const claudeProfile = claudeProfileKey ? cfg.profiles[claudeProfileKey] : null;
  if (claudeProfile) {
    const inFmt = claudeProfile.inFormat || 'auto';
    const isClaudeTarget = (inFmt === 'anthropic' || inFmt === 'auto');
    const tier1M = claudeProfile.model1M?.opus ? 'opus[1m]' :
                   claudeProfile.model1M?.sonnet ? 'sonnet[1m]' :
                   claudeProfile.model1M?.fable ? 'fable[1m]' : null;
    if (isClaudeTarget && tier1M) {
      fs.writeFileSync(flag1MPath, tier1M, 'utf8');
    } else if (fs.existsSync(flag1MPath)) {
      try { fs.unlinkSync(flag1MPath); } catch {}
    }
  } else if (fs.existsSync(flag1MPath)) {
    try { fs.unlinkSync(flag1MPath); } catch {}
  }

  // 2. Codex CLI 1M: bật khi profile active của Codex hỗ trợ 1M
  const codexProfileKey = activeMap.responses;
  const codexProfile = codexProfileKey ? cfg.profiles[codexProfileKey] : null;
  if (codexProfile) {
    const inFmt = codexProfile.inFormat || 'auto';
    const isCodexTarget = (inFmt === 'responses' || inFmt === 'auto');
    const has1M = Boolean(codexProfile.model1M?.opus || codexProfile.model1M?.sonnet || codexProfile.model1M?.fable || codexProfile.model1M?.haiku);
    const primaryModel = codexProfile.defaultModels?.opus || codexProfile.defaultModels?.sonnet || codexProfile.defaultModels?.haiku || '';
    if (isCodexTarget && has1M) {
      fs.writeFileSync(flagCodex1MPath, primaryModel || '1000000', 'utf8');
    } else if (fs.existsSync(flagCodex1MPath)) {
      try { fs.unlinkSync(flagCodex1MPath); } catch {}
    }
  } else if (fs.existsSync(flagCodex1MPath)) {
    try { fs.unlinkSync(flagCodex1MPath); } catch {}
  }

  // 3. OpenAI CLI 1M: bật khi profile active của OpenAI hỗ trợ 1M
  const openaiProfileKey = activeMap['openai-chat'];
  const openaiProfile = openaiProfileKey ? cfg.profiles[openaiProfileKey] : null;
  if (openaiProfile) {
    const inFmt = openaiProfile.inFormat || 'auto';
    const isOpenAITarget = (inFmt === 'openai-chat' || inFmt === 'auto');
    const has1M = Boolean(openaiProfile.model1M?.opus || openaiProfile.model1M?.sonnet || openaiProfile.model1M?.fable || openaiProfile.model1M?.haiku);
    const primaryModel = openaiProfile.defaultModels?.opus || openaiProfile.defaultModels?.sonnet || openaiProfile.defaultModels?.haiku || '';
    if (isOpenAITarget && has1M) {
      fs.writeFileSync(flagOpenAI1MPath, primaryModel || '1000000', 'utf8');
    } else if (fs.existsSync(flagOpenAI1MPath)) {
      try { fs.unlinkSync(flagOpenAI1MPath); } catch {}
    }
  } else if (fs.existsSync(flagOpenAI1MPath)) {
    try { fs.unlinkSync(flagOpenAI1MPath); } catch {}
  }

  // 4. Sinh file env.cmd và env.sh tổng hợp
  const envCmdLines = ['@echo off', 'REM Auto-generated environment for active profiles'];
  const envShLines = ['#!/usr/bin/env sh', '# Auto-generated environment for active profiles'];

  if (claudeProfile) {
    envCmdLines.push(`SET "ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT}"`);
    envCmdLines.push('SET "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1"');
    envShLines.push(`export ANTHROPIC_BASE_URL="http://127.0.0.1:${PORT}"`);
    envShLines.push('export CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1');
    const tier1M = claudeProfile.model1M?.opus ? 'opus[1m]' :
                   claudeProfile.model1M?.sonnet ? 'sonnet[1m]' :
                   claudeProfile.model1M?.fable ? 'fable[1m]' : null;
    if (tier1M) {
      envCmdLines.push(`SET "ANTHROPIC_MODEL=${tier1M}"`);
      envCmdLines.push('SET "CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000"');
      envCmdLines.push('SET "CLAUDE_CODE_AUTO_COMPACT_WINDOW=900000"');
      envShLines.push(`export ANTHROPIC_MODEL="${tier1M}"`);
      envShLines.push('export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000');
      envShLines.push('export CLAUDE_CODE_AUTO_COMPACT_WINDOW=900000');
    }
  }

  if (codexProfile) {
    envCmdLines.push(`SET "CODEX_BASE_URL=http://127.0.0.1:${PORT}/v1"`);
    envCmdLines.push(`SET "OPENAI_BASE_URL=http://127.0.0.1:${PORT}/v1"`);
    envShLines.push(`export CODEX_BASE_URL="http://127.0.0.1:${PORT}/v1"`);
    envShLines.push(`export OPENAI_BASE_URL="http://127.0.0.1:${PORT}/v1"`);
    const has1M = Boolean(codexProfile.model1M?.opus || codexProfile.model1M?.sonnet || codexProfile.model1M?.fable || codexProfile.model1M?.haiku);
    if (has1M) {
      envCmdLines.push('SET "CODEX_MAX_CONTEXT_TOKENS=1000000"');
      envCmdLines.push('SET "CODEX_AUTO_COMPACT_WINDOW=900000"');
      envShLines.push('export CODEX_MAX_CONTEXT_TOKENS=1000000');
      envShLines.push('export CODEX_AUTO_COMPACT_WINDOW=900000');
      const pm = codexProfile.defaultModels?.opus || codexProfile.defaultModels?.sonnet || '';
      if (pm) {
        envCmdLines.push(`SET "CODEX_MODEL=${pm}"`);
        envShLines.push(`export CODEX_MODEL="${pm}"`);
      }
    }
  }

  if (openaiProfile && !codexProfile) {
    envCmdLines.push(`SET "OPENAI_BASE_URL=http://127.0.0.1:${PORT}/v1"`);
    envShLines.push(`export OPENAI_BASE_URL="http://127.0.0.1:${PORT}/v1"`);
  }

  try {
    fs.writeFileSync(envCmdPath, envCmdLines.join('\r\n'), 'utf8');
    fs.writeFileSync(envShPath, envShLines.join('\n'), 'utf8');
  } catch {}

  // Keep ~/.claude/settings.json 100% clean to prevent warning banners
  if (fs.existsSync(claudeSettingsPath)) {
    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    if (settings.env) {
      delete settings.env.ANTHROPIC_BASE_URL;
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
      delete settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME;
      delete settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME;
      delete settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME;
      delete settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME;
    }
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }
}

function removeProxyFromClaude() {
  const flags = [activeFlagPath, flag1MPath, flagCodex1MPath, flagOpenAI1MPath, envCmdPath, envShPath];
  for (const f of flags) {
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
  if (fs.existsSync(claudeSettingsPath)) {
    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    if (settings.env) {
      delete settings.env.ANTHROPIC_BASE_URL;
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
      delete settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME;
      delete settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME;
      delete settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME;
      delete settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME;
    }
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }
}

function getClaudeProxyStatus(port) {
  const isUsing = fs.existsSync(activeFlagPath);
  const isClaude1M = fs.existsSync(flag1MPath) && isUsing;
  const isCodex1M = fs.existsSync(flagCodex1MPath) && isUsing;
  const isOpenAI1M = fs.existsSync(flagOpenAI1MPath) && isUsing;
  return {
    isUsingProxy: isUsing,
    is1MActive: isClaude1M,
    isCodex1MActive: isCodex1M,
    isOpenAI1MActive: isOpenAI1M,
    claudeBaseURL: isUsing ? `http://127.0.0.1:${port} (injected via launcher)` : '(none / official)'
  };
}

// ----------------------------------------------------
// Mode 1: DIRECT PASS-THROUGH (Native Anthropic to Native Anthropic)
// ----------------------------------------------------
async function forwardAnthropicDirect(req, res, bodyBuffer, targetUrl, apiKey, mappedModel, signal) {
  debugLog('Direct forward to native Anthropic endpoint:', targetUrl);

  let modifiedBody = bodyBuffer;
  try {
    const json = JSON.parse(bodyBuffer.toString('utf8'));
    if (mappedModel && json.model !== mappedModel) {
      json.model = mappedModel;
      modifiedBody = Buffer.from(JSON.stringify(json), 'utf8');
    }
  } catch {}

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01'
  };
  if (req.headers['anthropic-beta']) {
    headers['anthropic-beta'] = req.headers['anthropic-beta'];
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: modifiedBody,
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Direct forward error: ${err.message}` } }));
    return;
  }

  const resHeaders = {};
  for (const [k, v] of upstreamRes.headers.entries()) {
    if (!['content-length', 'content-encoding'].includes(k.toLowerCase())) {
      resHeaders[k] = v;
    }
  }
  res.writeHead(upstreamRes.status, resHeaders);

  const reader = upstreamRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (streamErr) {
    console.error('[DirectForward] Stream error:', streamErr);
  } finally {
    res.end();
  }
}

// ----------------------------------------------------
// LLM Switcher generic pipeline: client --parse--> IR --emit--> upstream
// Client (input) formats : anthropic | openai-chat | responses (Codex) | vertex
// Upstream (output)      : profile.outFormat or legacy mode mapping
//   direct  -> anthropic | convert -> openai-chat
//   hybrid  -> claude-* via native anthropic, others via openai-chat
// ----------------------------------------------------
function resolveOutFormat(profile, mappedModel) {
  if (profile.outFormat && OUT_FORMATS.includes(profile.outFormat)) return profile.outFormat;
  const mode = profile.mode || 'hybrid';
  if (mode === 'direct') return 'anthropic';
  if (mode === 'convert') return 'openai-chat';
  return String(mappedModel || '').toLowerCase().startsWith('claude-') ? 'anthropic' : 'openai-chat';
}

function upstreamEndpoint(profile, outFormat, model, stream, req) {
  const base = String(profile.baseURL || '').replace(/\/+$/, '');
  const ov = profile.endpoints || {};
  const key = profile.apiKey || '';
  const headers = { 'Content-Type': 'application/json' };

  if (outFormat === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = (req?.headers && req.headers['anthropic-version']) || '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${key}`;
  }

  // Passthrough an toàn các client headers từ tool trung gian (anthropic-beta, x-request-id, traceparent, x-...)
  if (req?.headers) {
    if (req.headers['anthropic-beta'] && outFormat === 'anthropic') {
      headers['anthropic-beta'] = req.headers['anthropic-beta'];
    }
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if ((lk.startsWith('x-') || lk === 'traceparent' || lk === 'tracestate')
          && !['x-api-key', 'x-profile', 'x-llm-profile', 'host', 'connection', 'content-length'].includes(lk)) {
        headers[k] = v;
      }
    }
  }

  if (outFormat === 'anthropic') {
    return { url: ov.anthropic || `${base}/messages`, headers };
  }
  if (outFormat === 'vertex') {
    const path = stream ? 'streamGenerateContent' : 'generateContent';
    const url = ov.vertex
      ? ov.vertex.replace('{model}', encodeURIComponent(model))
      : `${base}/models/${encodeURIComponent(model)}:${path}${stream ? '?alt=sse' : ''}`;
    return { url, headers };
  }
  return { url: ov['openai-chat'] || `${base}/chat/completions`, headers };
}

// Đọc upstream stream: chịu cả SSE `data:` lẫn raw JSON lines (Vertex framing).
async function* readUpstreamPayloads(upstreamRes) {
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder('utf8');
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let s = t;
      if (s.startsWith('data:')) s = s.slice(5).trim();
      else if (s.startsWith('event:')) continue;
      if (!s || s === '[DONE]') continue;
      if (!s.startsWith('{')) continue;
      try { yield JSON.parse(s); } catch {}
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('{')) {
    try { yield JSON.parse(tail); } catch {}
  }
}

function clientRenderer(clientFormat, res, model) {
  if (clientFormat === 'anthropic') return createAnthropicStream((e, d) => sendSSE(res, e, d), model);
  if (clientFormat === 'responses') return createResponsesStream((e, d) => sendSSE(res, null, d), model);
  if (clientFormat === 'vertex') return createVertexStream((e, d) => sendSSE(res, null, d), model);
  return createChatStream((e, d) => sendSSE(res, null, d), model);
}

function clientMessage(clientFormat, args) {
  if (clientFormat === 'anthropic') return buildAnthropicMessage(args);
  if (clientFormat === 'responses') return buildResponsesMessage(args);
  if (clientFormat === 'vertex') return buildVertexMessage(args);
  return buildChatMessage(args);
}

async function handleConvert(clientFormat, req, res, bodyBuffer) {
  const { profileKey, profile } = getActiveProfile(clientFormat, req);
  if (!profile) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `Proxy is currently OFF for ${clientFormat}. Set an active profile for this target in Web UI or via switch command.`
      }
    }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(bodyBuffer.toString('utf8'));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
    return;
  }

  const wantIn = profile.inFormat || 'auto';
  if (wantIn !== 'auto' && wantIn !== clientFormat) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Profile "${profileKey}" expects "${wantIn}" input, got "${clientFormat}"` } }));
    return;
  }

  let ir;
  try {
    ir = parseToIR(clientFormat, payload);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Cannot parse ${clientFormat} request: ${e.message}` } }));
    return;
  }
  if (clientFormat === 'vertex' && req._vertexStream) ir.stream = true;

  const reqStartTime = Date.now();
  let promptPreview = '';
  if (ir.messages && ir.messages.length) {
    const lastUser = ir.messages.slice().reverse().find(m => m.role === 'user');
    if (lastUser) {
      promptPreview = typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content);
    }
  }

  const requestedModel = ir.model || payload.model || '';
  const mappedModel = mapModel(requestedModel, profile);
  const outFormat = resolveOutFormat(profile, mappedModel);
  console.log(`[llm-switcher] ${clientFormat} -> ${outFormat} "${requestedModel}" -> "${mappedModel}" [${profile.name}]`);

  // AbortController để huỷ fetch upstream ngay khi client ngắt kết nối (tiết kiệm token)
  const ac = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) {
      debugLog(`[${profileKey}] Client connection closed before response ended, aborting upstream request`);
      ac.abort();
    }
  };
  res.on('close', onClientClose);

  // Cửa ngõ cuối cùng hứng toàn bộ request trước khi ra Internet:
  // Dù request đến trực tiếp từ CLI hay qua các tool nén token (Headroom, Ponytail, RTK),
  // Switcher đóng vai trò chốt chặn cuối cùng: tự chữa lành tin nhắn mồ côi (orphaned tool_result),
  // khôi phục thinking params nếu bị cắt, bảo vệ 1M context và convert 2 chiều sang 9Router / Upstream.

  // Legacy fast path: anthropic in/out đi thẳng, giữ nguyên bytes (kể cả signatures).
  if (clientFormat === 'anthropic' && outFormat === 'anthropic') {
    debugLog(`[${profileKey}] Model "${mappedModel}" -> Direct native Anthropic forward`);
    const { url } = upstreamEndpoint(profile, 'anthropic', mappedModel, false, req);
    try {
      await forwardAnthropicDirect(req, res, bodyBuffer, url, profile.apiKey, mappedModel, ac.signal);
      logInspection({
        clientFormat, outFormat, profile: profileKey, model: mappedModel,
        status: 200, duration: Date.now() - reqStartTime, stream: ir.stream,
        tokens: { prompt: 0, completion: 0 },
        requestPreview: promptPreview.slice(0, 300),
        responsePreview: '(direct forward stream)'
      });
    } finally {
      res.off('close', onClientClose);
    }
    return;
  }

  const upBody = emitUpstreamBody(outFormat, ir, mappedModel);
  const { url, headers } = upstreamEndpoint(profile, outFormat, mappedModel, ir.stream, req);
  debugLog(`[${profileKey}] ${clientFormat} -> ${outFormat} ${url} ::`, JSON.stringify(upBody).slice(0, 500));

  let upstreamRes;
  try {
    upstreamRes = await fetch(url, { method: 'POST', headers, body: JSON.stringify(upBody), signal: ac.signal });
  } catch (fetchErr) {
    res.off('close', onClientClose);
    if (fetchErr.name === 'AbortError') return;
    console.error(`[${profileKey}] Network error:`, fetchErr);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Failed to connect to upstream: ${fetchErr.message}` } }));
    logInspection({
      clientFormat, outFormat, profile: profileKey, model: mappedModel,
      status: 502, duration: Date.now() - reqStartTime, stream: ir.stream,
      tokens: { prompt: 0, completion: 0 },
      requestPreview: promptPreview.slice(0, 300),
      error: fetchErr.message
    });
    return;
  }

  if (!upstreamRes.ok) {
    res.off('close', onClientClose);
    const errText = await upstreamRes.text();
    console.error(`[${profileKey}] Error HTTP ${upstreamRes.status}:`, errText.slice(0, 500));
    res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: errText } }));
    logInspection({
      clientFormat, outFormat, profile: profileKey, model: mappedModel,
      status: upstreamRes.status, duration: Date.now() - reqStartTime, stream: ir.stream,
      tokens: { prompt: 0, completion: 0 },
      requestPreview: promptPreview.slice(0, 300),
      error: errText.slice(0, 300)
    });
    return;
  }

  // ---- non-stream ----
  if (!ir.stream) {
    res.off('close', onClientClose);
    let json;
    try {
      json = await upstreamRes.json();
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Upstream returned non-JSON: ${e.message}` } }));
      return;
    }
    const ev = normalizeUpstream(json, outFormat);
    const col = createCollector();
    col.add(ev);
    const out = clientMessage(clientFormat, {
      model: mappedModel,
      think: col.think, text: [col.text.join('')],
      tools: [...col.tools.values()],
      finish: col.finish, prompt: col.prompt,
      completion: Math.max(col.sum, col.last) || 0,
      sig: col.sig
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
    logInspection({
      clientFormat, outFormat, profile: profileKey, model: mappedModel,
      status: 200, duration: Date.now() - reqStartTime, stream: false,
      tokens: { prompt: col.prompt, completion: Math.max(col.sum, col.last) || 0 },
      thinkingChars: col.think.join('').length,
      requestPreview: promptPreview.slice(0, 300),
      responsePreview: col.text.join('').slice(0, 300)
    });
    return;
  }

  // ---- stream ----
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  const renderer = clientRenderer(clientFormat, res, mappedModel);
  renderer.start();
  const col = createCollector();
  try {
    for await (const parsed of readUpstreamPayloads(upstreamRes)) {
      if (ac.signal.aborted) break;
      const ev = normalizeUpstream(parsed, outFormat);
      col.add(ev);
      for (const t of (ev.think || [])) renderer.think(t.text, t.sig);
      for (const t of (ev.text || [])) renderer.text(t);
      for (const tc of (ev.tools || [])) renderer.tool(tc);
    }
  } catch (streamErr) {
    if (streamErr.name !== 'AbortError') {
      console.error(`[${profileKey}] Stream error:`, streamErr);
    }
  } finally {
    res.off('close', onClientClose);
    const completion = Math.max(col.sum, col.last) || col.counted;
    renderer.finish(col.finish, { completion, prompt: col.prompt, hasTools: col.tools.size > 0 });
    // OpenAI/Codex clients expect a terminal [DONE] line.
    if (clientFormat === 'openai-chat' || clientFormat === 'responses') {
      res.write('data: [DONE]\n\n');
    }
    res.end();
    logInspection({
      clientFormat, outFormat, profile: profileKey, model: mappedModel,
      status: 200, duration: Date.now() - reqStartTime, stream: true,
      tokens: { prompt: col.prompt, completion },
      thinkingChars: col.think.join('').length,
      requestPreview: promptPreview.slice(0, 300),
      responsePreview: col.text.join('').slice(0, 300)
    });
  }
}

async function handleMessages(req, res, bodyBuffer) {
  await handleConvert('anthropic', req, res, bodyBuffer);
}


// ----------------------------------------------------
// Server setup & Web UI / API Routes
// ----------------------------------------------------
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const cfg = loadConfig();
  const PORT = getListeningPort();

  // Bảo vệ CSRF / DNS Rebinding cho các endpoint quản trị /api/*
  if (pathname.startsWith('/api/')) {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const u = new URL(origin);
        if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: untrusted origin' }));
          return;
        }
      } catch {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end();
      return;
    }
  }

  // Serve Web UI (no-cache: luôn serve bản mới nhất sau khi sửa file)
  if (req.method === 'GET' && (pathname === '/' || pathname === '/ui')) {
    if (fs.existsSync(uiHtmlPath)) {
      const html = fs.readFileSync(uiHtmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(html);
      return;
    }
  }

  // Health check
  if (req.method === 'GET' && pathname === '/health') {
    const { profileKey, profile } = getActiveProfile();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      proxy: 'llm-switcher',
      activeProfile: profileKey || '(none)',
      mode: profile?.mode || 'hybrid',
      inFormat: profile?.inFormat || 'auto',
      outFormat: profile ? resolveOutFormat(profile, '') : 'none',
      upstream: profile?.baseURL || '(none)'
    }));
    return;
  }

  // OpenAI-style model list (Codex / OpenAI SDK discovery).
  if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
    const { profile } = getActiveProfile();
    const ids = profile ? [...new Set(Object.values(profile.defaultModels || {}).filter(Boolean))] : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: ids.map(id => ({ id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'llm-switcher' }))
    }));
    return;
  }

  // GET /api/status
  if (req.method === 'GET' && pathname === '/api/status') {
    const { profileKey } = getActiveProfile();
    const statusObj = getClaudeProxyStatus(PORT);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      port: PORT,
      activeProfile: profileKey,
      activeProfiles: cfg.activeProfiles || {
        anthropic: cfg.activeProfile,
        responses: cfg.activeProfile,
        'openai-chat': cfg.activeProfile,
        vertex: cfg.activeProfile
      },
      isUsingProxy: statusObj.isUsingProxy,
      is1MActive: statusObj.is1MActive,
      isCodex1MActive: statusObj.isCodex1MActive,
      isOpenAI1MActive: statusObj.isOpenAI1MActive,
      claudeBaseURL: statusObj.claudeBaseURL,
      config: cfg
    }));
    return;
  }

  // GET /api/logs (Live Request/Response Inspector)
  if (req.method === 'GET' && pathname === '/api/logs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ logs: requestLogs.slice().reverse() }));
    return;
  }

  // POST /api/logs/clear
  if (req.method === 'POST' && pathname === '/api/logs/clear') {
    requestLogs.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // POST /api/switch (switch active profile - toàn cục hoặc theo từng CLI target)
  if (req.method === 'POST' && pathname === '/api/switch') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const cliTarget = body.target; // 'anthropic' | 'responses' | 'openai-chat' | 'vertex' (tùy chọn)
        const targetProfile = body.profile; // profile key hoặc null (để tắt)

        if (targetProfile && !cfg.profiles[targetProfile]) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Profile "${targetProfile}" does not exist` }));
          return;
        }

        if (!cfg.activeProfiles) {
          cfg.activeProfiles = {
            anthropic: cfg.activeProfile,
            responses: cfg.activeProfile,
            'openai-chat': cfg.activeProfile,
            vertex: cfg.activeProfile
          };
        }

        if (cliTarget) {
          // Bật/tắt riêng cho đúng 1 CLI target
          cfg.activeProfiles[cliTarget] = targetProfile || null;
          if (targetProfile) cfg.activeProfile = targetProfile;
        } else if (targetProfile) {
          // Legacy switch toàn cục: nếu profile inFormat là cụ thể thì gán vào target đó, nếu auto thì gán tất cả
          const p = cfg.profiles[targetProfile];
          const inFmt = p.inFormat || 'auto';
          cfg.activeProfile = targetProfile;
          if (inFmt === 'auto') {
            cfg.activeProfiles.anthropic = targetProfile;
            cfg.activeProfiles.responses = targetProfile;
            cfg.activeProfiles['openai-chat'] = targetProfile;
            cfg.activeProfiles.vertex = targetProfile;
          } else {
            cfg.activeProfiles[inFmt] = targetProfile;
          }
        } else {
          // targetProfile null -> tắt toàn bộ
          cfg.activeProfiles = { anthropic: null, responses: null, 'openai-chat': null, vertex: null };
        }

        saveConfig(cfg);
        applyProfileToClaude(cfg, PORT);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          activeProfile: cfg.activeProfile,
          activeProfiles: cfg.activeProfiles
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/toggle (toggle proxy ON hoặc OFF cho toàn bộ hoặc 1 CLI target)
  if (req.method === 'POST' && pathname === '/api/toggle') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const cliTarget = body.target;

        if (!cfg.activeProfiles) {
          cfg.activeProfiles = {
            anthropic: cfg.activeProfile,
            responses: cfg.activeProfile,
            'openai-chat': cfg.activeProfile,
            vertex: cfg.activeProfile
          };
        }

        if (cliTarget) {
          cfg.activeProfiles[cliTarget] = body.enabled ? (cfg.activeProfiles[cliTarget] || cfg.activeProfile || Object.keys(cfg.profiles)[0]) : null;
        } else {
          if (body.enabled) {
            const def = cfg.activeProfile || Object.keys(cfg.profiles)[0];
            cfg.activeProfiles = { anthropic: def, responses: def, 'openai-chat': def, vertex: def };
          } else {
            cfg.activeProfiles = { anthropic: null, responses: null, 'openai-chat': null, vertex: null };
          }
        }

        saveConfig(cfg);
        applyProfileToClaude(cfg, PORT);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, enabled: body.enabled, activeProfiles: cfg.activeProfiles }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/save-profile
  if (req.method === 'POST' && pathname === '/api/save-profile') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const { key, profile } = body;
        if (!key || !profile) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing key or profile object' }));
          return;
        }

        cfg.profiles[key] = profile;
        saveConfig(cfg);

        // If updated active profile, sync to Claude Code
        if (key === cfg.activeProfile) {
          const { isUsingProxy } = getClaudeProxyStatus(PORT);
          if (isUsingProxy) {
            applyProfileToClaude(profile, PORT);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/delete-profile
  if (req.method === 'POST' && pathname === '/api/delete-profile') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const { key } = body;
        if (!cfg.profiles[key]) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Profile not found' }));
          return;
        }
        delete cfg.profiles[key];
        if (cfg.activeProfile === key) {
          cfg.activeProfile = Object.keys(cfg.profiles)[0] || '';
        }
        saveConfig(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/test-upstream
  if (req.method === 'POST' && pathname === '/api/test-upstream') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const { baseURL, apiKey, mode, model } = body;
        const start = Date.now();

        if (mode === 'direct') {
          // test via /messages
          const r = await fetch(`${baseURL.replace(/\/+$/, '')}/messages`, {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: model || 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] })
          });
          const latency = Date.now() - start;
          if (r.ok) {
            const data = await r.json();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, latency, sample: data.content?.[0]?.text || '(ok)' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, status: r.status, error: await r.text() }));
          }
        } else {
          // test via /chat/completions
          const r = await fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: model || 'default', messages: [{ role: 'user', content: 'ping' }], max_tokens: 10 })
          });
          const latency = Date.now() - start;
          if (r.ok) {
            const data = await r.json();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, latency, sample: data.choices?.[0]?.message?.content || '(ok)' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, status: r.status, error: await r.text() }));
          }
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/fetch-models
  if (req.method === 'POST' && pathname === '/api/fetch-models') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const { baseURL, apiKey } = body;
        if (!baseURL) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing baseURL' }));
          return;
        }

        const modelsUrl = `${baseURL.replace(/\/+$/, '')}/models`;
        const headers = {};
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
          headers['x-api-key'] = apiKey;
        }

        const r = await fetch(modelsUrl, { headers });
        if (!r.ok) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, status: r.status, error: await r.text() }));
          return;
        }

        const data = await r.json();
        let list = [];
        if (Array.isArray(data.data)) {
          list = data.data.map(m => m.id);
        } else if (Array.isArray(data)) {
          list = data.map(m => (typeof m === 'string' ? m : m.id));
        } else if (Array.isArray(data.models)) {
          list = data.models.map(m => m.id || m.name);
        }
        list = list.filter(Boolean).sort();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, models: list }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Token count estimation endpoint
  if (req.method === 'POST' && pathname === '/v1/messages/count_tokens') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const roughEstimate = Math.ceil(body.length / 4);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: roughEstimate }));
    });
    return;
  }

  // Client endpoints, one per input protocol (auto-detected by path).
  // Profile picks upstream via outFormat (or legacy mode); inFormat mismatch -> 400.
  const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB
  const postBody = (fn) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Payload Too Large (max 50MB)' } }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => fn(Buffer.concat(chunks)));
    req.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Request stream error: ${err.message}` } }));
      }
    });
  };

  // Anthropic Messages (Claude Code)
  if (req.method === 'POST' && (pathname === '/v1/messages' || pathname === '/messages')) {
    postBody((buf) => handleConvert('anthropic', req, res, buf));
    return;
  }

  // OpenAI Chat Completions
  if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
    postBody((buf) => handleConvert('openai-chat', req, res, buf));
    return;
  }

  // OpenAI Responses (Codex)
  if (req.method === 'POST' && (pathname === '/v1/responses' || pathname === '/responses')) {
    postBody((buf) => handleConvert('responses', req, res, buf));
    return;
  }

  // Vertex generateContent / streamGenerateContent (Gemini SDKs)
  const vmatch = req.method === 'POST' && pathname.match(/^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/);
  if (vmatch) {
    req._vertexStream = vmatch[2] === 'streamGenerateContent';
    postBody((buf) => handleConvert('vertex', req, res, buf));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `Not found: ${req.method} ${pathname}` } }));
});

const PORT = getListeningPort();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[llm-switcher:ERROR] Port ${PORT} is already in use by another process!`);
    console.error(`- Run 'switch status' or kill the conflicting service with 'switch stop'.`);
    console.error(`- If another tool (e.g. headroom/rtk/proxy) is using port ${PORT}, change "port" in config.json.`);
    process.exit(1);
  } else {
    console.error('[llm-switcher:ERROR]', err);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[llm-switcher] Server running on http://127.0.0.1:${PORT}`);
  console.log(`[llm-switcher] Web UI available at: http://127.0.0.1:${PORT}/ui`);
  console.log(`[llm-switcher] Endpoints: /v1/messages (anthropic) | /v1/chat/completions (openai) | /v1/responses (codex) | /v1beta/models/* (vertex)`);
});
