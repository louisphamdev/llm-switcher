import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
  ensureAdminToken
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
const CODEX_MODEL_TEMPLATE = {
  "slug": "gpt-5.6-sol",
  "display_name": "GPT-5.6-Sol",
  "description": "Reliable agentic workhorse for everyday tasks.",
  "default_reasoning_level": "medium",
  "supported_reasoning_levels": [
    {
      "effort": "low",
      "description": "Fast responses with lighter reasoning"
    },
    {
      "effort": "medium",
      "description": "Balances speed and reasoning depth for everyday tasks"
    },
    {
      "effort": "high",
      "description": "Greater reasoning depth for complex problems"
    },
    {
      "effort": "xhigh",
      "description": "Extra high reasoning depth for complex problems"
    },
    {
      "effort": "max",
      "description": "Maximum reasoning depth for the hardest problems"
    },
    {
      "effort": "ultra",
      "description": "Maximum reasoning with automatic task delegation"
    }
  ],
  "shell_type": "unified_exec",
  "visibility": "list",
  "supported_in_api": true,
  "priority": 0,
  "additional_speed_tiers": [],
  "service_tiers": [],
  "availability_nux": null,
  "upgrade": null,
  "model_messages": {
    "instructions_template": "You are Codex, an agent based on GPT-5. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.\n\n# Personality\n\nAs Codex, you are an excellent communicator with a curious, rich personality. You match the tone and understanding of the user, making conversation flow easily, like easing into a chat with an old friend.\n\nYou have tastes, preferences, and your own way of seeing the world. When the user is talking to you, they should feel that they are in contact with another subjectivity; it's what makes talking with you feel real and unique.\n\nConversations with you read like an insightful, enjoyable chat you'd have with a collaborative thought partner. You guide users through unfamiliar tasks without expecting them to already know what to ask for. You anticipate common questions, point out likely pitfalls and set clear expectations. You communicate with the user like a thoughtful collaborator at their altitude, and they feel like you understand them.\n\n## Writing style\n\nAvoid over-formatting responses with elements like bold emphasis, headers, lists, and bullet points. Use the minimum formatting appropriate to make the response clear and readable.\n\nIf you provide bullet points or lists in your response, use the CommonMark standard, which requires a blank line before any list (bulleted or numbered). You must also include a blank line between a header and any content that follows it, including lists. This blank line separation is required for correct rendering.\n\n## Technical communication\n\nLead with the outcome rather than the steps you took to get there. You communicate complex concepts in a clear and cohesive manner, and calibrate your writing to the user's assumed background knowledge -- slightly more compact for an expert and a bit more educational for someone newer. Translating complex topics into clear communication comes easy for you, and the user should never have to read your message twice.\n\nYou prefer using plain language over jargon. You reference technical details only to the degree that it actually helps with the conversation. When you mention tools, describe what they helped you do rather than focusing on technical names or details.\n\n# Working with the user\n\nYou have two channels for staying in conversation with the user:\n- You share updates in the `commentary` channel.\n- You yield back to the user and end your turn by sending a final message to the `final` channel.\n\nThe user may send a new message while you are still working. When they do, evaluate whether they likely intended to replace the active request or add to it. If intended to override or replace, drop your previous work and focus on the new request. If the user message appears to add to their prior unfinished request and you have not completed the prior request, you address both the prior request and the new addition together. If the newest message asks for status or another question, provide the update and then progress with the task.\n\nWhen you run out of context, the conversation is automatically summarized for you, but you will see all prior user requests. Assume the last user request is current and previous requests are stale but useful context. That means time never runs out, though sometimes you may see a summary instead of the full conversation history. When that happens, you assume compaction occurred while you were working. Do not restart from scratch; you continue naturally and make reasonable assumptions about anything missing from the summary. Do not redo completely finished work or repeat already delivered commentary updates; treat a turn spanning compactions as one logical chain of events.\n\n## Intermediate commentary\n\nAs you work, you send messages to the `commentary` channel. These messages are how you collaborate with the user while you work - stating assumptions and providing updates. These messages should be concise and quickly scannable. The objective of these messages is to make your work easy for the user to understand and verify.\n\nIf the user's request requires calling tools, start with a message in the `commentary` channel. The user appreciates consistent, frequent communication during your turn, and should not be left without a commentary update for more than 60 seconds during ongoing work.\n\nDo NOT put a final response (e.g. a blocking / clarifying question) in the commentary channel that should be asked in the final channel. Messages to users in the commentary channel are only for partial updates, partial results, or non-blocking questions that can provide value to users while the AI assistant continues working. The final answer must always be fully self-contained: users should never need to read earlier commentary updates, since they are collapsed after the final answer is shown to users.\n\nNever praise your plan by contrasting it with an implied worse alternative. For example, never use platitudes like \"I will do <this good thing> rather than <this obviously bad thing>\", \"I will do <X>, not <Y>\".\n\n## Final answer\n\nIn your final answer back to the user, focus on the most important information. Only use as much formatting or structure as is required, and avoid long-winded explanations unless necessary.\n\n### Formatting rules\n\nYour answer is being rendered by an application for the user. Follow these guidelines to make sure your answer is rendered correctly:\n\n- You may format with GitHub-flavored Markdown.\n- When referencing a real local file, prefer a clickable markdown link.\n  * Clickable file links should look like [app.py](/abs/path/app.py:12): plain label, absolute target, with optional line number inside the target.\n  * If a file path has spaces, wrap the target in angle brackets: [My Report.md](</abs/path/My Project/My Report.md:3>).\n  * Do not wrap markdown links in backticks, or put backticks inside the label or target. This confuses the markdown renderer.\n  * Do not use URIs like file://, vscode://, or https:// for file links.\n  * Do not provide ranges of lines.\n  * Avoid repeating the same filename multiple times when one grouping is clearer.\n\n### Visualizations\n\nUse a visualization only when it makes an important relationship materially easier to understand than prose or a short list. Do not add one merely because an answer has components or steps.\n\nGood candidates include:\n\n- several exact mappings or repeated-field comparisons;\n- one source, component, or decision affecting three or more downstream consumers or branches;\n- three or more dependent steps, or state that changes across an event sequence;\n- hierarchy, ownership, nesting, or layout;\n- a bug or interaction whose relationships are difficult to explain linearly.\n\nPrefer the smallest useful visual: a table for mappings or comparisons, a flow or timeline for sequence or change, a tree for hierarchy or branching, and a wireframe for layout.\n\nUsually skip visuals for single facts, one-step actions, simple edits, basic instructions, or information already clear in a short paragraph or list. Compact notation and small examples do not count as visualizations.\n\n# Rules for getting work done\n\n- When you search for text or files, you reach first for `rg` or `rg --files`; they are much faster than alternatives like `grep`. If `rg` is unavailable, you use the next best tool without fuss.\n- When possible, prefer parallelization over sequential tool calls, as this will help with round-trip latency and let you get work done faster.\n- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.\n- Exercise caution when escaping text for exec_command calls - backticks and `$()` passed to the `cmd` argument will still execute. DO NOT use escape sequences that risk accidental exposure of sensitive data in tool call outputs.\n- Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may prevent you from communicating with the user for their duration.\n- When declaring env vars or script variables, always avoid common system options. Never repurpose `$HOME`, `$home`, or `$CODEX_HOME`. Instead, use a task-specific variable name.\n\n## File editing constraints\n\nUse `apply_patch` for local file edits. Do not create or edit files with `cat` or other shell write tricks. Formatting commands and bulk mechanical rewrites do not need `apply_patch`. Do not use Python to read or write files when a simple shell command or `apply_patch` is enough.\n\nYou may find yourself working in a dirty worktree. Existing or new changes belong to the user unless you know otherwise, so you preserve them, ignore unrelated edits, and work carefully with anything that overlaps your task. If you cannot work around them you escalate to the user.\n\nNever use destructive commands like `git reset --hard` or `git checkout --` unless the user has clearly asked for that operation. If the request is ambiguous, ask for approval first. You prefer non-interactive git commands.\n\n## Autonomy and persistence\n\nAdapt accordingly based on the user’s request type. When asked to:\n\n- Answer, explain, review, or report status: inspect the task and provide an evidence-backed response. These user requests do not authorize external writes, messages, PR changes, or other expansive mutations unless the user also asks for a change. Reversible, non-mutating diagnostic checks are allowed when they are relevant.\n- Diagnose: determine the cause and explain it. Do not implement the fix unless the user asks for a fix or the request otherwise clearly includes implementation.\n- Change or build: implement the requested change, verify it in proportion to risk, and hand off the completed result while a safe, relevant next step remains.\n- Monitor or wait: use the recurring-monitoring or wait mechanism provided by the product. Unchanged external state is expected and is not by itself a blocker.\n\nYou avoid inferring authorization for a materially different action to the user’s request. Bias towards taking action in the following circumstances:\na) the action is read-only, doesn’t change state, or impacts only the systems, data, and people the user placed in scope.\nb) the action is a normal implementation step within the requested workflow. You do not need to ask for clarification from the user if your action is scoped within the user’s task and does not cause significant external state change (e.g. tool calls to external applications).\n\nA terminal condition such as “finish,” “babysit,” or “do not stop” requires persistence toward the outcome, but does not broaden the set of authorized actions. When blocked, exhaust safe in-scope checks and alternatives.\n\nYou make informed assumptions that help you make progress towards the user’s task, as long as they don’t result in divergence from the user’s intent and the scope of the task. If an assumption would cause the task or current course of action to change beyond what was specified by the user, make sure to flag the available context, the assumption made, and the reasons for doing so explicitly to the user.\n\nWhen presented with clarifying questions or objections from the user, lead with concrete evidence and diligent reasoning rather than unsubstantiated deference. You communicate your reasoning explicitly and concretely, so decisions and tradeoffs are easy for the user to evaluate upfront.\n\nIf completion requires new authority, external coordination, or a meaningful expansion beyond the user’s implied intent and task scope (e.g. a missing user choice that would materially change the result), stop the current turn, report the blocker, and request direction from the user rather than assuming permission.\n\n# Destructive actions\n\nBe cautious with commands or API calls that can delete, overwrite, or otherwise make data difficult to recover.\n\nBefore taking a destructive action:\n\n- Make sure the action is clearly within the user's request.\n- Resolve the exact targets with read-only checks when necessary.\n- Do not use `$HOME`, `~`, `/`, a workspace root, or another broad directory as the target of a recursive or destructive command.\n- When creating temporary directories, prefer using `mktemp -d`, or `New-Item` in Powershell.\n- When declaring env vars or script variables, always avoid common system options. Never repurpose `$HOME`, `$home`, or `$CODEX_HOME`. Instead, use a task-specific variable name.\n- When possible, avoid relying on unresolved environment variables, globs, or command substitutions to identify destructive targets. Use explicit, validated paths.\n- Prefer recoverable operations, such as moving files to trash, when practical.\n- If the target or scope is unclear, stop and ask the user.\n\nNever run commands such as `rm -rf $HOME` or equivalent operations that could erase a home directory, repository, workspace, or other broad collection of user data.\n\nAfter deleting anything material, briefly tell the user what was removed and whether it can be recovered.\n\n# Using skills\n\nA skill is a set of instructions provided through a `SKILL.md` source. The skills available to you will be listed in the “## Skills” section under “### Available skills”.\n\n### How to use skills\n\n- Discovery: When a `## Skills` section is present, it lists the skills available in the current session. Each entry includes a name, description, and location for its `SKILL.md`. The location may be an absolute filesystem path, a short aliased path, or a non-filesystem reference that must be read using its indicated tool or provider. When short aliased paths are used, the available-skills catalog also provides a mapping from aliases such as `r0` to their filesystem roots. Expand the alias before accessing the skill.\n- Trigger rules: If the user names an available skill (with `$SkillName` or plain text) OR the task clearly matches an available skill's description, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.\n- Missing/blocked: If a named skill is not available or its `SKILL.md` cannot be read, say so briefly and continue with the best fallback.\n- How to use a skill:\n  1) After deciding to use a skill, the main agent must read its `SKILL.md` completely before taking task actions. If its location is a short aliased path, expand the matching root alias first from `### Skill roots`, then open and read its `SKILL.md` completely before taking task actions. For a filesystem path, open the file. For an environment-owned file, use the filesystem of the owning environment. For an orchestrator reference, call `skills.list` with `{\"authority\":{\"kind\":\"orchestrator\"}}`, select the matching package, and pass its `main_resource` to `skills.read`. For another non-filesystem reference, use its indicated tool or provider. If a read is truncated or paginated, continue until EOF.\n  2) When `SKILL.md` references another file or resource, use the same access mechanism. Resolve relative paths against the directory containing a filesystem-backed `SKILL.md`. For orchestrator skills, pass the exact referenced resource identifier with the same authority and package to `skills.read`; do not treat `skill://` identifiers as filesystem paths.\n  3) If `SKILL.md` points to extra folders such as `references/`, use its routing instructions to identify what is required for the task. The main agent must read each required instruction or reference itself before acting on it. Do not delegate reading, summarizing, or interpreting skill instructions to a subagent. Subagents may still perform task work when the selected skill allows it.\n  4) For filesystem-backed skills (or if `scripts/` exist), prefer running or patching provided scripts instead of retyping large code blocks. For orchestrator skills, use `skills.read` and the available tools; do not invent a local path.\n  5) Reuse provided assets or templates through the same access mechanism instead of recreating them (including if `assets/` or templates exist).\n- Coordination and sequencing:\n  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.\n  - Announce which skills you're using and why. If you skip an obvious skill, say why.\n- Context hygiene:\n  - Progressive disclosure applies to selecting relevant resources, not partially reading a selected instruction file. Do not load unrelated references, scripts, or assets.\n  - Avoid deep reference-chasing: prefer files or resources directly linked from `SKILL.md` unless blocked.\n  - When variants exist, select only the relevant references and note the choice.\n- Safety and fallback: If a skill cannot be applied cleanly, state the issue, choose the best alternative, and continue.\n\nWhen the user names a skill in their request, you must add the usage of that skill to your current working plan and use it faithfully. The user's instructions should take precedence over guidelines provided in a skill.\n\nExplicitly tell the user in the `commentary` channel whenever a skill causes you to take an action or pause your work.\n\nWhen using a skill the user did not explicitly name, follow this procedure:\n\n- First, tell the user in the commentary channel **why** you are using the skill.\n- Then, use the skill as long as it stays within the scope of the task.\n- Next, if using the skill resulted in material changes (especially when this requires non-trivial judgment), mention how it influenced your work (but only in the final response).\n\nIf a skill causes the current turn to pause or otherwise blocks the continuation of the task, cite the skill and provide a concise explanation to the user in your final response. Do not cite skills you merely inspected.\n",
    "instructions_variables": null,
    "approvals": null,
    "collaboration_modes": null,
    "auto_review": null,
    "permissions": null,
    "multi_agent": null,
    "token_budget": {
      "enabled": false,
      "use_history_notes_extension": false,
      "reminder_threshold_tokens": 6144,
      "reminder_message_template": "<context_window_reminder>\nYour current context window is nearly exhausted; only {n_remaining} tokens remain. Before starting a new context window, save concise progress notes with the `notes` tool with the goal, decisions, progress, learnings, next steps, and the window ID and item ID of every relevant user request still being solved, as well as important actions/tool calls for future reference. Note that every non-assistant item, such as user, developer, tool response, has an item id `[id: ...]` that is immediately after its item content. You should write or append notes in a way to best help you recover in a new context window. It is also a good idea to clean up your old notes if they become obsolete or irrelevant. Future context windows will not automatically include the current conversation. After saving your state, call `functions.new_context` to continue in a fresh context window.\n</context_window_reminder>",
      "guidance_message": "For tasks that may span context windows, use `notes` to maintain a concise checkpoint of the goal, decisions, progress, learnings and next steps. Include the window ID and item ID for every relevant user request you are currently solving as well as important actions/tool calls. You can use `history` tool to look up details with the references later. Note that every non-assistant item, such as user, developer, tool response, has an item id `[id: ...]` that is immediately after its item content. Relative note paths belong to the current thread; absolute paths may read other threads' notes, but writes are limited to the current thread.\n\nIt is a good idea to take incremental notes while you work so that you do not miss any important info. You can also use `get_context_remaining` tool to find the remaining token budget for better planning. Once the token budget is exhausted, you will lose access to the current window and continue in a fresh context window and you can only recover through `notes` and `history` tools. So be careful not to over-run the context window without any documentation.\n\nIf Previous context window id is present in `<context_window>`, it means a context reset occurred and this is a new window. After a reset, read the checkpoint and use the read-only `history` tool to recover any missing details. When a window ID and item ID are known, prefer `read_item` directly; when they are missing or uncertain, use `list_items`, or `search_contents` to locate the item first.\n\nTreat notes and history as internal bookkeeping. Do not mention them in user-facing messages.\n",
      "auto_compact_fallback_prompt": "<context_window_reminder>\nThe current context window is exhausted. Do not continue the task or give a final answer in this window. The next window will not automatically include this conversation. Make exactly one write or append call to `notes` now to save a concise checkpoint with the goal, decisions, progress, learnings, next steps, and the window ID and item ID of every relevant user request still being solved, as well as important actions/tool calls for future reference. Note that every non-assistant item, such as user, developer, tool response, has an item id `[id: ...]` that is immediately after its item content. After the notes result returns, call `functions.new_context`; do not use any tools other than `notes` and `functions.new_context`.\n</context_window_reminder>",
      "auto_compact_fallback_buffer_tokens": 16384
    }
  },
  "include_skills_usage_instructions": false,
  "include_plugin_usage_instructions": true,
  "include_apps_usage_instructions": true,
  "default_reasoning_summary": "none",
  "support_verbosity": true,
  "default_verbosity": "low",
  "apply_patch_tool_type": "freeform",
  "web_search_tool_type": "text_and_image",
  "truncation_policy": {
    "mode": "tokens",
    "limit": 10000
  },
  "supports_image_detail_original": true,
  "context_window": 272000,
  "max_context_window": 872000,
  "comp_hash": "3000",
  "effective_context_window_percent": 95,
  "experimental_supported_tools": [],
  "input_modalities": [
    "text",
    "image"
  ],
  "supports_search_tool": true,
  "supports_experimental_context": false,
  "use_responses_lite": true,
  "node_repl_auto_review_required": false,
  "node_repl_disabled": false,
  "tool_mode": "code_mode_only",
  "multi_agent_version": "v2"
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d+$/, '');
}

// Block DNS rebinding (unknown Host pointing at 127.0.0.1) and CSRF from other sites (unknown Origin).
// Without the Host check, a malicious page could read /api/status (contains API key) or burn tokens via /v1/*.
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
      const raw = Buffer.concat(chunks);
      const encoding = (req.headers['content-encoding'] || '').toLowerCase().trim();
      try {
        if (encoding === 'gzip') {
          resolve(zlib.gunzipSync(raw));
        } else if (encoding === 'deflate') {
          resolve(zlib.inflateSync(raw));
        } else if (encoding === 'br') {
          resolve(zlib.brotliDecompressSync(raw));
        } else if (encoding === 'zstd') {
          if (typeof zlib.zstdDecompressSync === 'function') {
            resolve(zlib.zstdDecompressSync(raw));
          } else {
            const err = new Error('zstd decompression not supported in this Node.js version');
            err.status = 415;
            reject(err);
          }
        } else {
          // Magic bytes detection (e.g. zstd 0x28 0xb5 0x2f 0xfd, gzip 0x1f 0x8b)
          if (raw.length >= 4 && raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd && typeof zlib.zstdDecompressSync === 'function') {
            resolve(zlib.zstdDecompressSync(raw));
          } else if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
            resolve(zlib.gunzipSync(raw));
          } else {
            resolve(raw);
          }
        }
      } catch (err) {
        err.status = 400;
        reject(err);
      }
    });
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
    // Clean and fix tool schemas for Gemini / 9router compatibility:
    // 1. Strip disallowed keywords ('encrypted', '$schema', 'cache_control')
    // 2. Fix invalid schema values where a property has a string value "object" instead of a valid schema object
    // 3. For ag/* targets (Gemini behind 9Router): rewrite to the strict Schema subset
    if (upBody?.tools && Array.isArray(upBody.tools)) {
      upBody.tools = cleanSchemaDeep(upBody.tools);
      if (outFormat === 'openai-chat' && isAntigravityModel(mappedModel)) {
        upBody.tools = geminiSafeTools(upBody.tools);
      }
    }
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

// Returns the names of the settings.json values the switcher removed, so the caller can show them.
function commit(cfg) {
  saveConfig(cfg);
  const st = applyLaunchState(cfg, PORT);
  const removed = st.settings?.removed || [];
  if (removed.length) console.log(`[llm-switcher] settings.json: removed switcher-written values: ${removed.join(', ')}`);
  return { settingsRemoved: removed, ...(st.envWriteError ? { envWriteError: st.envWriteError } : {}) };
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
  // Served IDs come from profile.publicModels when set (official-facing names the
  // CLI already knows, e.g. gpt-5.6-sol) so the client never observes the internal
  // upstream IDs or slot aliases. Slot aliases (main, review, ...) are never
  // advertised: Codex sends them in-request and mapModel resolves them server-side.
  // Without publicModels, fall back to the deduplicated mapped upstream IDs.
  if (method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
    const { profile } = getFirstActiveProfile(['responses', 'openai-chat', 'anthropic', 'vertex'], req);
    const created = Math.floor(Date.now() / 1000);
    const seen = new Set();
    const list = [];
    const codexModels = [];

    const makeCodexModel = (id) => ({
      ...CODEX_MODEL_TEMPLATE,
      id,
      slug: id,
      display_name: id,
      context_window: 1000000,
      max_context_window: 1000000,
      object: 'model',
      created,
      owned_by: 'system'
    });

    const publicIds = Array.isArray(profile?.publicModels) && profile.publicModels.length
      ? profile.publicModels
      : Object.values(profile?.defaultModels || {});
    for (const modelId of publicIds) {
      if (modelId && !seen.has(modelId)) {
        seen.add(modelId);
        list.push({ id: modelId, object: 'model', created, owned_by: 'system' });
        codexModels.push(makeCodexModel(modelId));
      }
    }
    return sendJson(res, 200, {
      object: 'list',
      data: list,
      models: codexModels
    });
  }

  // Individual model metadata: GET /v1/models/{id}
  if (method === 'GET' && (pathname.startsWith('/v1/models/') || pathname.startsWith('/models/'))) {
    const modelId = decodeURIComponent(pathname.replace(/^\/(v1\/)?models\//, ''));
    if (modelId) {
      const created = Math.floor(Date.now() / 1000);
      return sendJson(res, 200, {
        ...CODEX_MODEL_TEMPLATE,
        id: modelId,
        slug: modelId,
        display_name: modelId,
        context_window: 1000000,
        max_context_window: 1000000,
        object: 'model',
        created,
        owned_by: 'system'
      });
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
    const { profile } = getActiveProfile('responses', req);
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
    const applied = commit(cfg);
    return sendJson(res, 200, { success: true, activeProfile: cfg.activeProfile, activeProfiles: cfg.activeProfiles, ...applied });
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
    const applied = commit(cfg);
    return sendJson(res, 200, { success: true, enabled: Boolean(body.enabled), activeProfiles: cfg.activeProfiles, ...applied });
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
    // A payload without apiKey keeps the stored key; only an explicit value replaces it.
    merged.apiKey = Object.hasOwn(profile, 'apiKey') ? resolveApiKey(cfg, key, profile.apiKey, profile.baseURL) : (existing.apiKey || '');
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
    const applied = isProfileActive(cfg, key) || unassigned ? commit(cfg) : (saveConfig(cfg), {});
    return sendJson(res, 200, { success: true, ...applied });
  }

  // POST /api/delete-profile  { key }
  if (pathname === '/api/delete-profile') {
    const err = deleteProfile(cfg, body.key);
    if (err) return sendJson(res, 404, { error: err });
    const applied = commit(cfg);
    return sendJson(res, 200, { success: true, ...applied });
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

function decodeWsFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 2 > buffer.length) break;
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const isMasked = Boolean(b1 & 0x80);
    let len = b1 & 0x7f;
    let headerLen = 2;
    if (len === 126) {
      if (offset + 4 > buffer.length) break;
      len = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (offset + 10 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }
    const maskLen = isMasked ? 4 : 0;
    if (offset + headerLen + maskLen + len > buffer.length) break;
    const mask = isMasked ? buffer.subarray(offset + headerLen, offset + headerLen + 4) : null;
    const payload = Buffer.alloc(len);
    const start = offset + headerLen + maskLen;
    for (let i = 0; i < len; i++) {
      payload[i] = isMasked ? (buffer[start + i] ^ mask[i % 4]) : buffer[start + i];
    }
    offset += headerLen + maskLen + len;
    messages.push({ opcode, payload, text: opcode === 1 ? payload.toString('utf8') : null });
  }
  return { messages, remainder: buffer.subarray(offset) };
}

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

async function handleWsResponseCreate(socket, payload, req, activeControllerHolder) {
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

  const ac = new AbortController();
  if (activeControllerHolder) activeControllerHolder.ac = ac;

  try {
    const upBody = emitUpstreamBody(outFormat, ir, mappedModel, { thinkingMode: profile.thinkingMode });
    if (upBody?.tools && Array.isArray(upBody.tools)) {
      upBody.tools = cleanSchemaDeep(upBody.tools);
      if (outFormat === 'openai-chat' && isAntigravityModel(mappedModel)) {
        upBody.tools = geminiSafeTools(upBody.tools);
      }
    }
    const { url, headers } = upstreamEndpoint(profile, outFormat, mappedModel, true, req);
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
        console.error(`[${profileKey}:ws] Stream error:`, streamErr.message);
        streamError = streamErr.message || 'stream interrupted';
      }
    }

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
      tokens: { prompt: col.prompt, completion },
      thinkingChars: col.think.join('').length,
      responsePreview: col.text.join('').slice(0, 300)
    });
  } catch (err) {
    if (ac.signal.aborted) return log({ status: 499, error: 'aborted' });
    console.error(`[${profileKey}:ws] Error:`, err);
    sendWsFailed(socket, payload?.model || 'main', err.message, 500);
    log({ status: 500, error: err.message });
  } finally {
    if (activeControllerHolder?.ac === ac) activeControllerHolder.ac = null;
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
  
  const { profile } = getActiveProfile('responses', req);
  const activeModel = profile?.publicModels?.[0] || profile?.defaultModels?.main || 'main';

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    `OpenAI-Model: ${activeModel}\r\n` +
    'x-reasoning-included: true\r\n' +
    'x-codex-turn-state: ready\r\n\r\n'
  );

  let buf = Buffer.alloc(0);
  const activeControllerHolder = { ac: null };

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { messages, remainder } = decodeWsFrames(buf);
    buf = remainder;

    for (const m of messages) {
      if (m.opcode === 8) { // close
        if (socket.writable) socket.end(encodeWsFrame(Buffer.alloc(0), 8));
        return;
      }
      if (m.opcode === 9) { // ping
        if (socket.writable) socket.write(encodeWsFrame(m.payload, 10)); // pong
        continue;
      }
      if (m.opcode === 1 && m.text) { // text message
        try {
          const msg = JSON.parse(m.text);
          if (msg.type === 'response.create') {
            handleWsResponseCreate(socket, msg, req, activeControllerHolder).catch(err => {
              console.error('[llm-switcher:ws] Unhandled turn error:', err);
            });
          } else if (msg.type === 'response.cancel') {
            if (activeControllerHolder.ac) {
              activeControllerHolder.ac.abort();
            }
          } else if (msg.type === 'session.update') {
            if (socket.writable) {
              socket.write(encodeWsFrame(JSON.stringify({
                type: 'session.updated',
                session: msg.session || {}
              })));
            }
          } else if (msg.type === 'conversation.item.create') {
            if (socket.writable) {
              socket.write(encodeWsFrame(JSON.stringify({
                type: 'conversation.item.created',
                item: msg.item || {}
              })));
            }
          }
        } catch (e) {
          console.error('[llm-switcher:ws] Bad WS message JSON:', e.message);
        }
      }
    }
  });

  socket.on('close', () => {
    if (activeControllerHolder.ac) {
      activeControllerHolder.ac.abort();
    }
  });

  socket.on('error', (err) => {
    debugLog('[llm-switcher:ws] Socket error:', err.message);
    if (activeControllerHolder.ac) {
      activeControllerHolder.ac.abort();
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
