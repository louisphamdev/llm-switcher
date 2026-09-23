#!/usr/bin/env node
// ============================================================
// mcp.mjs — Model Context Protocol (MCP) Server for LLM Switcher
// Zero-dependency, pure Node.js stdio JSON-RPC 2.0 server.
//
// Tools exposed to AI Coding Agents (Claude Code, Cursor, Codex, Opencode):
//  1. switcher_status          : Read active profiles & multi-CLI status
//  2. switcher_audit           : Audit environment to ensure tools route through Switcher
//  3. switcher_switch_profile  : Programmatically switch active profile per CLI
//  4. switcher_recent_logs     : Inspect recent request logs & thinking traces
// ============================================================

import fs from 'node:fs';
import { claudeSettingsPath, loadConfig as loadSharedConfig, resolvePort, readAdminToken, TARGETS } from './state.mjs';

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; }
})();

// A substring test would accept http://localhost.evil.test; the host itself must be loopback.
function isLoopbackURL(value) {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

// /api/* requires the per-install token that the gateway writes next to config.json.
const adminHeaders = (extra = {}) => ({ 'x-llm-switcher-token': readAdminToken() || '', ...extra });

function loadConfig() {
  return loadSharedConfig() || { port: 3456, activeProfile: '', profiles: {} };
}

function getMcpPort() {
  return resolvePort(process.argv.slice(2), loadSharedConfig());
}

async function fetchStatus(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: adminHeaders(), signal: AbortSignal.timeout(1500) });
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

/** The logs, or null when the gateway does not answer. */
async function fetchLogs(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/logs`, { headers: adminHeaders(), signal: AbortSignal.timeout(1500) });
    if (r.ok) return (await r.json()).logs || [];
  } catch {}
  return null;
}

async function postSwitch(port, target, profile) {
  const r = await fetch(`http://127.0.0.1:${port}/api/switch`, {
    method: 'POST',
    headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ target, profile: profile || null }),
    signal: AbortSignal.timeout(5000)
  });
  return await r.json();
}

const TOOLS = [
  {
    name: 'switcher_status',
    description: 'Get live status of LLM Switcher gateway: port, active multi-CLI targets (Claude Code, Codex, OpenAI, Vertex), and 1M context flags.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'switcher_audit',
    description: 'Audit workstation environment to ensure token compression tools (Headroom, RTK, Ponytail) and CLI endpoints route through LLM Switcher (:3456) instead of making rogue direct outbound calls.',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Include detailed environment variable checks' }
      }
    }
  },
  {
    name: 'switcher_switch_profile',
    description: 'Programmatically change the active profile for a specific CLI target (e.g. Claude Code, Codex, OpenAI, Vertex) or globally.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'CLI target to switch: "anthropic" (Claude Code), "responses" (Codex), "openai-chat", or "vertex"',
          enum: TARGETS
        },
        profile: {
          type: 'string',
          description: 'Profile key to activate (from config.json), or empty/null to deactivate this target'
        }
      },
      required: ['profile']
    }
  },
  {
    name: 'switcher_recent_logs',
    description: 'Inspect the last N requests handled by LLM Switcher: check latency, prompt preview, token counts, and whether thinking blocks were successfully extracted.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of recent logs to return (default: 5)' }
      }
    }
  }
];

async function handleToolCall(name, args) {
  const cfg = loadConfig();
  const port = getMcpPort();

  if (name === 'switcher_status') {
    const live = await fetchStatus(port);
    const activeMap = live?.activeProfiles || cfg.activeProfiles || {};
    const text = [
      '=== LLM Switcher Gateway Status ===',
      `Service Running: ${live ? `YES (http://127.0.0.1:${port})` : 'NO / UNREACHABLE'}`,
      `Active Profiles by CLI:`,
      `  - Claude Code (/v1/messages)       : [${activeMap.anthropic || 'OFF'}] ${live?.claude1MTiers?.length ? `• 1M Context ACTIVE (${live.claude1MTiers.join(', ')})` : ''}`,
      `  - Codex CLI   (/v1/responses)      : [${activeMap.responses || 'OFF'}] ${live?.isCodex1MActive ? '• 1M Context ACTIVE' : ''}`,
      `  - OpenAI Chat (/v1/chat/completions): [${activeMap['openai-chat'] || 'OFF'}]`,
      `  - Vertex      (/v1beta/models/*)   : [${activeMap.vertex || 'OFF'}]`,
      '',
      `Available Profiles in config: ${Object.keys(cfg.profiles || {}).join(', ')}`,
      `Dashboard Web UI: http://127.0.0.1:${port}/ui`
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'switcher_audit') {
    const live = await fetchStatus(port);
    const findings = [];
    let isClean = true;

    // 1. Check the proxy port
    if (!live) {
      findings.push(`[CRITICAL] LLM Switcher service is NOT running on port ${port}. Run 'node switch.mjs on' to start it.`);
      isClean = false;
    } else {
      findings.push(`[PASS] LLM Switcher edge gateway is running on http://127.0.0.1:${port}.`);
    }

    // 2. Check whether Claude Code's settings.json was dirtied by another tool
    if (fs.existsSync(claudeSettingsPath)) {
      try {
        const s = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
        if (s.env?.ANTHROPIC_BASE_URL) {
          findings.push(`[WARNING] ~/.claude/settings.json has hardcoded ANTHROPIC_BASE_URL="${s.env.ANTHROPIC_BASE_URL}". This can trigger warning banners in Claude Code. The switcher removes this value only when it points at its own port; otherwise edit settings.json yourself if you want the launcher flags to apply.`);
          isClean = false;
        } else {
          findings.push(`[PASS] ~/.claude/settings.json is clean (zero-mutation compliant).`);
        }
      } catch (err) {
        findings.push(`[WARNING] ${claudeSettingsPath} does not parse: ${err.message}. Claude Code may ignore it.`);
        isClean = false;
      }
    }

    // 3. The base URL variables this agent process runs with. Codex takes its URL as a --config
    // override from the shim, so it has no variable to check here.
    for (const name of ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL']) {
      const value = process.env[name];
      if (!value) continue;
      if (isLoopbackURL(value)) {
        findings.push(`[PASS] ${name} points to a local endpoint: ${value}`);
      } else {
        findings.push(`[ALERT] ${name}="${value}" points to an external endpoint! It should point to LLM Switcher (http://127.0.0.1:${port}) or your local optimizer proxy.`);
        isClean = false;
      }
    }
    if (args?.verbose) {
      findings.push('');
      findings.push('--- Routing variables of this process ---');
      const names = Object.keys(process.env).filter(k => /^(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|CODEX_CA_CERTIFICATE|LLM_SWITCHER_[A-Z0-9_]+)$/.test(k)).sort();
      for (const k of names) findings.push(`${k}=${process.env[k]}`);
      if (!names.length) findings.push('(none set)');
    }

    // 4. Layering guidance for compression tools
    findings.push('');
    findings.push('--- Guideline for Token Optimizers (Headroom, RTK, Ponytail) ---');
    findings.push(`If a token compressor is used, ensure its upstream target is configured to http://127.0.0.1:${port}.`);
    findings.push('LLM Switcher will act as the final outbound gatekeeper to heal schemas, unlock 1M context, and preserve thinking traces.');

    const summary = isClean ? 'VERDICT: HEALTHY & PROPERLY ROUTED' : 'VERDICT: ACTION NEEDED';
    return { content: [{ type: 'text', text: `=== LLM Switcher Audit (${summary}) ===\n\n` + findings.join('\n') }] };
  }

  if (name === 'switcher_switch_profile') {
    const { target, profile } = args || {};
    // No target and no profile means deactivating the WHOLE gateway; require the agent to state its intent explicitly.
    if (!target && !profile) {
      return { content: [{ type: 'text', text: 'Refusing to deactivate all targets implicitly: pass a "target" to turn off one CLI, or a "profile" to activate.' }], isError: true };
    }
    try {
      const res = await postSwitch(port, target || null, profile || null);
      if (res.success) {
        return { content: [{ type: 'text', text: `Successfully set ${target || 'global'} active profile to "${profile || 'OFF'}".` }] };
      }
      return { content: [{ type: 'text', text: `Switch failed: ${res.error || 'Unknown error'}` }], isError: true };
    } catch (err) {
      return { content: [{ type: 'text', text: `Gateway connection failed: ${err.message}` }], isError: true };
    }
  }

  if (name === 'switcher_recent_logs') {
    const limit = Math.min(20, Math.max(1, Number(args?.limit) || 5));
    const logs = await fetchLogs(port);
    if (!logs) {
      return { content: [{ type: 'text', text: `The LLM Switcher gateway is unreachable on port ${port}, so no logs can be read. Run 'switch on' to start it.` }], isError: true };
    }
    const slice = logs.slice(0, limit);

    if (!slice.length) {
      return { content: [{ type: 'text', text: 'No requests recorded yet in LLM Switcher ring buffer.' }] };
    }

    const rendered = slice.map((l, i) => {
      return [
        `#${i + 1} [${l.timestamp}] ${l.status} (${l.duration}ms) — ${l.clientFormat} ➔ ${l.outFormat}`,
        `   Model: ${l.model}`,
        `   Tokens: prompt=${l.tokens?.prompt || 0} | output=${l.tokens?.completion || 0} | thinking=${l.thinkingChars || 0} chars`,
        `   Prompt: ${l.requestPreview ? l.requestPreview.slice(0, 150) : '(empty)'}`,
        `   Output: ${l.responsePreview ? l.responsePreview.slice(0, 150) : (l.error ? 'ERROR: ' + l.error : '(streaming/direct)')}`
      ].join('\n');
    }).join('\n\n');

    return { content: [{ type: 'text', text: `=== Last ${slice.length} Requests Handled by Gateway ===\n\n` + rendered }] };
  }

  throw new Error(`Unknown tool: ${name}`);
}

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// JSON-RPC 2.0 stdio framing
function send(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(json + '\n');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip the Content-Length header if the host sends LSP-style framing
    if (trimmed.startsWith('Content-Length:')) continue;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const { id, method, params } = req;

    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'llm-switcher', version: VERSION }
        }
      });
      continue;
    }

    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      continue;
    }

    if (typeof method === 'string' && method.startsWith('notifications/')) {
      continue;
    }

    if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS }
      });
      continue;
    }

    if (method === 'tools/call') {
      try {
        const result = await handleToolCall(params?.name, params?.arguments);
        send({ jsonrpc: '2.0', id, result });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: err.message }], isError: true }
        });
      }
      continue;
    }

    // Unhandled method
    if (id !== undefined) {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
    }
  }
});
