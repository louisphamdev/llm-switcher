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
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configPath = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { port: 3456, activeProfile: '9router', profiles: {} };
  }
}

function getMcpPort() {
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
  return cfg.port || 3456;
}

async function fetchStatus(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

async function fetchLogs(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/logs`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return (await r.json()).logs || [];
  } catch {}
  return [];
}

async function postSwitch(port, target, profile) {
  const r = await fetch(`http://127.0.0.1:${port}/api/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, profile: profile || null })
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
          enum: ['anthropic', 'responses', 'openai-chat', 'vertex']
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
      `  - Claude Code (/v1/messages)       : [${activeMap.anthropic || 'OFF'}] ${live?.is1MActive ? '• 1M Context ACTIVE' : ''}`,
      `  - Codex CLI   (/v1/responses)      : [${activeMap.responses || 'OFF'}] ${live?.isCodex1MActive ? '• 1M Context ACTIVE' : ''}`,
      `  - OpenAI Chat (/v1/chat/completions: [${activeMap['openai-chat'] || 'OFF'}]`,
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

    // 1. Kiểm tra cổng proxy
    if (!live) {
      findings.push(`[CRITICAL] LLM Switcher service is NOT running on port ${port}. Run 'node switch.mjs on' to start it.`);
      isClean = false;
    } else {
      findings.push(`[PASS] LLM Switcher edge gateway is running on http://127.0.0.1:${port}.`);
    }

    // 2. Kiểm tra settings.json của Claude Code có bị tool nào ghi bẩn không
    const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(claudeSettingsPath)) {
      try {
        const s = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
        if (s.env?.ANTHROPIC_BASE_URL) {
          findings.push(`[WARNING] ~/.claude/settings.json has hardcoded ANTHROPIC_BASE_URL="${s.env.ANTHROPIC_BASE_URL}". This can trigger warning banners in Claude Code. Run 'switch off' or remove it to rely on zero-mutation launcher flags.`);
          isClean = false;
        } else {
          findings.push(`[PASS] ~/.claude/settings.json is clean (zero-mutation compliant).`);
        }
      } catch {}
    }

    // 3. Kiểm tra các biến môi trường
    const anthBase = process.env.ANTHROPIC_BASE_URL;
    const oaiBase = process.env.OPENAI_BASE_URL;
    const cdxBase = process.env.CODEX_BASE_URL;

    if (anthBase) {
      if (!anthBase.includes('127.0.0.1') && !anthBase.includes('localhost')) {
        findings.push(`[ALERT] ANTHROPIC_BASE_URL="${anthBase}" points to an external endpoint! It should point to LLM Switcher (http://127.0.0.1:${port}) or your local optimizer proxy.`);
        isClean = false;
      } else {
        findings.push(`[PASS] ANTHROPIC_BASE_URL points to a local endpoint: ${anthBase}`);
      }
    }

    // 4. Hướng dẫn phân tầng cho tool nén
    findings.push('');
    findings.push('--- Guideline for Token Optimizers (Headroom, RTK, Ponytail) ---');
    findings.push(`If a token compressor is used, ensure its upstream target is configured to http://127.0.0.1:${port}.`);
    findings.push('LLM Switcher will act as the final outbound gatekeeper to heal schemas, unlock 1M context, and preserve thinking traces.');

    const summary = isClean ? 'VERDICT: HEALTHY & PROPERLY ROUTED' : 'VERDICT: ACTION NEEDED';
    return { content: [{ type: 'text', text: `=== LLM Switcher Audit (${summary}) ===\n\n` + findings.join('\n') }] };
  }

  if (name === 'switcher_switch_profile') {
    const { target, profile } = args || {};
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
    // Bỏ qua Content-Length header nếu host gửi kiểu LSP
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
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'llm-switcher', version: '1.0.0' }
        }
      });
      continue;
    }

    if (method === 'notifications/initialized') {
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
