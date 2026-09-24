// ============================================================
// formats.mjs — LLM Switcher protocol adapters (zero dependency)
//
// Two-way conversion flow through IR (Intermediate Representation):
//
//   client --parse--> IR --emit--> upstream --events--> client
//
// Client (input)  : anthropic | openai-chat | responses (Codex) | vertex
// Upstream (out)  : openai-chat | anthropic | vertex
//
// IR shape:
// {
//   model, system,
//   messages: [{ role:'system'|'user'|'assistant'|'tool',
//                 content: string | [{type:'text',text}|{type:'image_url',image_url:{url}}],
//                 toolCalls?: [{id,name,args}], toolCallId?, name? }],
//   tools: [{ name, description, parameters }],
//   toolChoice: 'auto'|'required'|'none'|{name}|null,
//   params: { maxTokens, temperature, topP, topK, stop[],
//             presencePenalty?, frequencyPenalty? },
//   thinking: { type:'enabled'|'disabled'|'adaptive', budget?, effort? } | null,
//   stream: bool
// }
// ============================================================

export const IN_FORMATS = ['anthropic', 'openai-chat', 'responses', 'vertex'];
export const OUT_FORMATS = ['openai-chat', 'anthropic', 'vertex'];

// ---------------- stop reasons ----------------

// Canonical finish used internally for the event stream.
function canonFinish(raw) {
  const r = String(raw || '').toLowerCase();
  if (!r) return null;
  if (['stop', 'end_turn', 'stop_sequence', 'eos', 'end'].includes(r)) return 'stop';
  if (['length', 'max_tokens', 'max_output_tokens'].includes(r)) return 'length';
  if (['tool_calls', 'tool_call', 'function_call', 'function_calls', 'tool_use'].includes(r)) return 'tool_calls';
  if (['content_filter', 'safety', 'recitation', 'language', 'blocklist', 'prohibited_content', 'spii'].includes(r)) return 'content_filter';
  return 'stop';
}

// `length` wins over tool calls: a cut-off tool call must reach the client as truncated, not as done.
function chatFinish(canonical, hasTools) {
  if (canonical === 'length') return 'length';
  if (hasTools) return 'tool_calls';
  switch (canonical) {
    case 'length': return 'length';
    case 'content_filter': return 'content_filter';
    default: return 'stop';
  }
}

// ---------------- smart field detection (moved from proxy) ----------------

const REASONING_KEYS = ['reasoning_content', 'reasoning', 'thinking', 'thought', 'thinking_content', 'thinking_text', 'reasoning_text', 'chain_of_thought', 'cot', 'rationale'];
const TEXT_KEYS = ['text', 'answer', 'output', 'response', 'completion', 'generated_text', 'result', 'message_text', 'reply'];

function asText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v
      .map(x => (typeof x === 'string' ? x : (x && typeof x === 'object' ? (typeof x.text === 'string' ? x.text : '') : '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function splitParts(parts) {
  const out = { thinking: [], text: [], tools: [], signature: null };
  if (!Array.isArray(parts)) return out;
  for (const p of parts) {
    if (typeof p === 'string') {
      if (p) out.text.push(p);
      continue;
    }
    if (!p || typeof p !== 'object') continue;
    const t = typeof p.text === 'string' ? p.text : '';
    const partSig = typeof (p.thoughtSignature ?? p.thought_signature) === 'string' ? (p.thoughtSignature ?? p.thought_signature) : null;
    const fc = p.functionCall || p.function_call;
    if (p.thought === true) {
      if (t) out.thinking.push(t);
    } else if (t) {
      out.text.push(t);
    }
    // Gemini 3 may attach the signature to an empty text part in the last chunk -> still must pick it up.
    if (!out.signature && partSig && !fc) out.signature = partSig;
    if (fc && typeof fc === 'object') {
      const args = fc.args !== undefined ? fc.args : fc.arguments;
      out.tools.push({
        index: out.tools.length,
        id: p.id || fc.id || null,
        name: fc.name || '',
        args: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        sig: partSig
      });
    }
  }
  return out;
}

function smartReasoning(node) {
  if (!node || typeof node !== 'object') return null;
  const texts = [];
  let signature = null;
  const take = (s) => { if (typeof s === 'string' && s) texts.push(s); };
  for (const k of REASONING_KEYS) {
    const v = node[k];
    if (typeof v === 'string' && v) { take(v); break; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      take(v.text ?? v.content ?? '');
      if (texts.length) break;
    } else if (Array.isArray(v) && v.length) {
      for (const it of v) {
        if (typeof it === 'string') take(it);
        else if (it && typeof it === 'object') take(it.text ?? it.content ?? it.summary ?? '');
      }
      if (texts.length) break;
    }
  }
  const det = node.reasoning_details || node.reasoningDetails;
  if (!texts.length && Array.isArray(det)) {
    for (const it of det) {
      if (typeof it === 'string') { take(it); continue; }
      if (!it || typeof it !== 'object') continue;
      take(it.text ?? it.content ?? it.summary ?? '');
      if (!signature && typeof it.signature === 'string' && it.signature) signature = it.signature;
    }
  }
  const parts = node.parts || node.content?.parts;
  if (Array.isArray(parts)) {
    const sp = splitParts(parts);
    // The same thought can arrive in both places; take the parts only when nothing else carried it.
    if (sp.thinking.length && !texts.length) texts.push(sp.thinking.join(''));
    if (!signature) signature = sp.signature;
  }
  if (!signature) {
    const sig = node.thoughtSignature ?? node.thought_signature ?? node.signature;
    if (typeof sig === 'string' && sig) signature = sig;
  }
  const text = texts.join('');
  if (!text) return null;
  return { text, signature };
}

function smartText(node) {
  if (!node || typeof node !== 'object') return '';
  const c = node.content;
  if (c !== undefined && c !== null) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return splitParts(c).text.join('\n');
    if (typeof c === 'object') {
      if (Array.isArray(c.parts)) return splitParts(c.parts).text.join('');
      if (typeof c.text === 'string' && c.text) return c.text;
    }
    return asText(c);
  }
  for (const k of TEXT_KEYS) {
    const v = node[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function smartToolCalls(node) {
  if (!node || typeof node !== 'object') return [];
  const norm = (tc, idx) => {
    if (!tc || typeof tc !== 'object') return null;
    const fn = (tc.function && typeof tc.function === 'object') ? tc.function : {};
    const name = fn.name || tc.name || '';
    const rawArgs = fn.arguments ?? fn.args ?? tc.args ?? tc.arguments ?? tc.input;
    // Follow-up OpenAI stream chunks only carry {index, function:{arguments}} (no name/id):
    // they must still be kept, otherwise all args after the first chunk are lost.
    if (!name && (rawArgs === undefined || rawArgs === null || rawArgs === '')) return null;
    return {
      index: (typeof tc.index === 'number' ? tc.index : idx),
      id: tc.id || fn.id || null,
      name: name || null,
      args: typeof rawArgs === 'string' ? rawArgs : (name ? JSON.stringify(rawArgs ?? {}) : JSON.stringify(rawArgs)),
      sig: tc.extra_content?.google?.thought_signature || null
    };
  };
  for (const k of ['tool_calls', 'toolCalls', 'tools_called', 'function_calls']) {
    if (Array.isArray(node[k]) && node[k].length) {
      return node[k].map(norm).filter(Boolean);
    }
  }
  const single = node.function_call || node.functionCall;
  if (single && typeof single === 'object') {
    const one = norm({ function: single, id: node.id }, 0);
    return one ? [one] : [];
  }
  const parts = node.parts || node.content?.parts;
  if (Array.isArray(parts)) {
    return splitParts(parts).tools.filter(t => t.name);
  }
  return [];
}

function smartUsage(u) {
  const o = (u && typeof u === 'object') ? u : {};
  const det = (o.prompt_tokens_details && typeof o.prompt_tokens_details === 'object') ? o.prompt_tokens_details : {};
  const num = (...vals) => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  };
  // Reasoning tokens are billed output the client never sees, and each upstream
  // puts them somewhere else: OpenAI chat in completion_tokens_details, the
  // Responses API in output_tokens_details, Anthropic as thinking_tokens, Vertex
  // as thoughtsTokenCount. Measured 2026-09-20 through 9Router: 95 of 96 output
  // tokens were reasoning, so losing this field misreports almost the whole cost.
  const outDet = (o.completion_tokens_details && typeof o.completion_tokens_details === 'object')
    ? o.completion_tokens_details
    : (o.output_tokens_details && typeof o.output_tokens_details === 'object') ? o.output_tokens_details : {};
  // Gemini counts thoughts apart from candidates. Every other API counts them inside the output.
  const geminiOutput = (Number(o.candidatesTokenCount) || 0) + (Number(o.thoughtsTokenCount) || 0);
  return {
    prompt: num(o.prompt_tokens, o.input_tokens, o.promptTokenCount, o.inputTokens),
    completion: num(o.completion_tokens, o.output_tokens, geminiOutput, o.outputTokens),
    cached: num(det.cached_tokens, o.cached_tokens, o.cachedContentTokenCount, o.cached_content_token_count, o.cache_read_input_tokens),
    reasoning: num(outDet.reasoning_tokens, outDet.thinking_tokens, o.thoughtsTokenCount, o.reasoning_tokens)
  };
}

function smartFinish(root, choice) {
  const raw = choice?.finish_reason ?? choice?.finishReason
    ?? root?.finishReason ?? root?.finish_reason
    ?? root?.stop_reason ?? choice?.stop_reason ?? null;
  if (typeof raw === 'string' && raw) return raw;
  if (root?.done === true || choice?.done === true) return 'stop';
  return null;
}

function firstChoice(root) {
  if (!root || typeof root !== 'object') return null;
  for (const k of ['choices', 'candidates', 'outputs', 'results', 'messages']) {
    if (Array.isArray(root[k]) && root[k][0] && typeof root[k][0] === 'object') return root[k][0];
  }
  return null;
}

function smartDelta(choice) {
  if (!choice || typeof choice !== 'object') return null;
  const d = choice.delta ?? choice.message ?? null;
  if (d && typeof d === 'object') return d;
  return choice;
}

const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

function sanitizeJsonSchema(schema) {
  if (schema === null || schema === undefined) return { type: 'object', properties: {} };
  return sanitizeSchemaNode(schema);
}

// Inside a schema 0, false, "" and null are values (minimum: 0, additionalProperties: false), not a missing schema.
function sanitizeSchemaNode(schema) {
  if (schema === null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaNode);
  const clean = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === 'cache_control' || k === 'encrypted') continue;
    if (k === 'format' && ['uri', 'uri-reference'].includes(v)) continue;
    // A name map: each value is a schema, the map itself is not. A parameter may be named "properties".
    if (SCHEMA_MAPS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      clean[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, sanitizeSchemaNode(sub)]));
      continue;
    }
    clean[k] = sanitizeSchemaNode(v);
  }
  if (!clean.type && clean.properties) {
    clean.type = 'object';
  }
  if (clean.type === 'object' && !clean.properties) {
    clean.properties = {};
  }
  return clean;
}

// ---------------- thinking helpers ----------------

function budgetToEffort(b) {
  const n = Number(b) || 0;
  return n >= 8000 ? 'high' : n >= 2000 ? 'medium' : 'low';
}

function effortToBudget(e) {
  switch (String(e || '').toLowerCase()) {
    case 'max':
    case 'xhigh':
    case 'high': return 8000;
    case 'medium': return 4000;
    case 'low':
    case 'minimal': return 1024;
    default: return 2000;
  }
}

function clampBudget(b, fallback = 2048) {
  const n = Number(b) || fallback;
  return Math.max(1024, n);
}

function parseArgs(v) {
  if (v === undefined || v === null) return {};
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return { raw: v }; }
  }
  return {};
}

function stringifyArgs(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v ?? {}); } catch { return '{}'; }
}

// ---------------- input parsers: client format -> IR ----------------

function baseIR() {
  return {
    model: '', system: '', messages: [], tools: [], toolChoice: null,
    params: { maxTokens: null, temperature: null, topP: null, topK: null, stop: [] },
    thinking: null, stream: false
  };
}

// Anthropic Messages API -> IR (logic ported from the old transformAnthropicToOpenAI).
function anthropicToIR(payload) {
  const ir = baseIR();
  ir.model = payload.model || '';
  // Anthropic API defaults to non-stream when the `stream` field is absent (the SDK leaves it empty for messages.create).
  ir.stream = payload.stream === true;

  if (payload.system) {
    if (typeof payload.system === 'string') ir.system = payload.system;
    else if (Array.isArray(payload.system)) {
      ir.system = payload.system
        .map(s => (typeof s === 'string' ? s : s.text || s.content || ''))
        .filter(Boolean)
        .join('\n\n');
    }
  }

  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      if (!msg) continue;
      if (typeof msg.content === 'string') {
        ir.messages.push({ role: msg.role, content: msg.content });
        continue;
      }
      if (Array.isArray(msg.content)) {
        const parts = [];
        const toolCalls = [];
        for (const part of msg.content) {
          if (!part) continue;
          if (part.type === 'text') {
            if (part.text) parts.push({ type: 'text', text: part.text });
          } else if (part.type === 'image' && part.source?.type === 'base64') {
            const mimeType = part.source.media_type || 'image/jpeg';
            parts.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${part.source.data}` } });
          } else if (part.type === 'image' && part.source?.type === 'url' && part.source.url) {
            parts.push({ type: 'image_url', image_url: { url: part.source.url } });
          } else if (part.type === 'tool_use') {
            toolCalls.push({ id: part.id, name: part.name, args: part.input ?? {} });
          } else if (part.type === 'tool_result') {
            let resultText = '';
            if (typeof part.content === 'string') resultText = part.content;
            else if (Array.isArray(part.content)) {
              // Don't stuff image base64 into text (token blowup); keep only a placeholder.
              resultText = part.content.map(c => {
                if (typeof c === 'string') return c;
                if (c?.type === 'text') return c.text || '';
                if (c?.type === 'image') return '[image omitted]';
                return JSON.stringify(c);
              }).filter(Boolean).join('\n');
            } else if (part.content) resultText = JSON.stringify(part.content);
            if (part.is_error && !resultText.toLowerCase().startsWith('error')) {
              resultText = `[Tool Error] ${resultText}`;
            }
            ir.messages.push({ role: 'tool', toolCallId: part.tool_use_id, content: resultText || '(empty tool output)' });
          }
        }
        const out = { role: msg.role };
        if (parts.length) {
          out.content = parts.every(p => p.type === 'text') ? parts.map(p => p.text).join('\n') : parts;
        }
        if (toolCalls.length) out.toolCalls = toolCalls;
        if (out.content !== undefined || out.toolCalls) ir.messages.push(out);
      } else if (msg.content) {
        // Fallback for payloads that preprocessing/compression tools mangled into an object
        ir.messages.push({ role: msg.role, content: asText(msg.content) });
      }
    }
  }

  if (Array.isArray(payload.tools) && payload.tools.length) {
    ir.tools = payload.tools.map(t => ({
      name: t.name, description: t.description || '',
      parameters: sanitizeJsonSchema(t.input_schema || {})
    }));
  }

  if (payload.tool_choice) {
    const tc = payload.tool_choice;
    if (tc.type === 'auto') ir.toolChoice = 'auto';
    else if (tc.type === 'any') ir.toolChoice = 'required';
    else if (tc.type === 'none') ir.toolChoice = 'none';
    else if (tc.type === 'tool' && tc.name) ir.toolChoice = { name: tc.name };
    if (tc.disable_parallel_tool_use === true) ir.params.parallelToolCalls = false;
  }

  if (typeof payload.max_tokens === 'number') ir.params.maxTokens = payload.max_tokens;
  if (typeof payload.temperature === 'number') ir.params.temperature = payload.temperature;
  if (typeof payload.top_p === 'number') ir.params.topP = payload.top_p;
  if (typeof payload.top_k === 'number') ir.params.topK = payload.top_k;
  if (Array.isArray(payload.stop_sequences)) ir.params.stop = stopList(payload.stop_sequences);

  ir.thinking = thinkingFromAnthropicParam(payload.thinking, payload.output_config?.effort);
  return ir;
}

// Anthropic `thinking` param ({type, budget_tokens}) -> IR thinking ({type, budget, effort}).
function thinkingFromAnthropicParam(th, effort) {
  if (!th || typeof th !== 'object') return null;
  // Client explicitly disabled thinking -> honor that intent, don't "restore" thinking.
  if (th.type === 'disabled') return { type: 'disabled' };
  const out = { type: th.type === 'adaptive' ? 'adaptive' : 'enabled' };
  const budget = Number(th.budget_tokens ?? th.budget);
  if (Number.isFinite(budget) && budget > 0) out.budget = budget;
  const eff = th.effort || effort;
  if (typeof eff === 'string' && eff) out.effort = eff;
  return out;
}

function isNoReasoningEffort(e) {
  return String(e || '').toLowerCase() === 'none';
}

// OpenAI Chat Completions -> IR (light normalization).
// Anthropic rejects an empty stop string, and no upstream can match one.
function stopList(stop) {
  return (Array.isArray(stop) ? stop : [stop]).filter(x => typeof x === 'string' && x);
}

// allowed_tools restricts the call to a subset of the declared tools. Hosted tools are not
// forwarded, so they never count as allowed.
function applyAllowedTools(ir, mode, list, nameOf) {
  const names = new Set((Array.isArray(list) ? list : []).map(nameOf).filter(Boolean));
  ir.tools = (ir.tools || []).filter(t => names.has(t.name));
  ir.toolChoice = ir.tools.length ? (mode === 'required' ? 'required' : 'auto') : null;
}

function chatToIR(payload) {
  const ir = baseIR();
  ir.model = payload.model || '';
  ir.stream = payload.stream === true;

  if (Array.isArray(payload.messages)) {
    for (const m of payload.messages) {
      const role = m.role;
      if (role === 'system' || role === 'developer') {
        const t = typeof m.content === 'string' ? m.content : asText(m.content);
        if (t) ir.system = ir.system ? `${ir.system}\n\n${t}` : t;
        continue;
      }
      if (role === 'tool' || role === 'function') {
        ir.messages.push({
          role: 'tool', toolCallId: m.tool_call_id || m.id,
          name: m.name, content: typeof m.content === 'string' ? m.content : asText(m.content)
        });
        continue;
      }
      const out = { role: role === 'assistant' ? 'assistant' : 'user' };
      if (typeof m.content === 'string' || Array.isArray(m.content)) out.content = m.content;
      else if (m.content != null) out.content = asText(m.content);
      if (Array.isArray(m.tool_calls)) {
        out.toolCalls = m.tool_calls.map((tc, i) => ({
          id: tc.id || null,
          name: tc.function?.name || tc.name || '',
          args: parseArgs(tc.function?.arguments ?? tc.function?.args ?? tc.args)
        })).filter(t => t.name);
      }
      if (out.content !== undefined || out.toolCalls) ir.messages.push(out);
    }
  }

  const toolDefs = payload.tools;
  if (Array.isArray(toolDefs) && toolDefs.length) {
    ir.tools = toolDefs.map(t => {
      const fn = t.function || t;
      return { name: fn.name, description: fn.description || '', parameters: sanitizeJsonSchema(fn.parameters || fn.input_schema || {}) };
    }).filter(t => t.name);
  }

  const tc = payload.tool_choice;
  if (typeof tc === 'string') ir.toolChoice = tc;
  else if (tc?.type === 'function' && tc.function?.name) ir.toolChoice = { name: tc.function.name };
  else if (tc?.type === 'allowed_tools') applyAllowedTools(ir, tc.allowed_tools?.mode, tc.allowed_tools?.tools, t => t?.function?.name);

  ir.params.maxTokens = payload.max_tokens ?? payload.max_completion_tokens ?? null;
  if (typeof payload.temperature === 'number') ir.params.temperature = payload.temperature;
  if (typeof payload.top_p === 'number') ir.params.topP = payload.top_p;
  if (typeof payload.presence_penalty === 'number') ir.params.presencePenalty = payload.presence_penalty;
  if (typeof payload.frequency_penalty === 'number') ir.params.frequencyPenalty = payload.frequency_penalty;
  if (payload.stop !== undefined && payload.stop !== null) ir.params.stop = stopList(payload.stop);
  if (payload.parallel_tool_calls === false) ir.params.parallelToolCalls = false;

  if (payload.thinking && typeof payload.thinking === 'object') {
    ir.thinking = thinkingFromAnthropicParam(payload.thinking, payload.reasoning_effort);
  } else if (typeof payload.reasoning_effort === 'string') {
    ir.thinking = isNoReasoningEffort(payload.reasoning_effort)
      ? { type: 'disabled' }
      : { type: 'enabled', budget: effortToBudget(payload.reasoning_effort), effort: payload.reasoning_effort };
  } else if (payload.reasoning && typeof payload.reasoning === 'object') {
    ir.thinking = thinkingFromReasoningParam(payload.reasoning);
  }
  return ir;
}

// OpenAI/OpenRouter `reasoning` object -> IR thinking.
function thinkingFromReasoningParam(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.exclude === true || r.enabled === false || isNoReasoningEffort(r.effort)) return { type: 'disabled' };
  return {
    type: 'enabled',
    budget: r.max_tokens ? clampBudget(r.max_tokens) : effortToBudget(r.effort),
    effort: r.effort
  };
}

// ---- Codex tool kinds ----
// Codex declares tools as: function | custom (freeform, e.g. apply_patch with Lark grammar) | namespace
// (wrapping function/custom) | local_shell (legacy) | hosted (web_search, tool_search...).
// Non-OpenAI upstreams only understand function tools, so:
//  - custom      -> function with a single string `input` param (grammar goes into the description), returns custom_tool_call;
//  - namespace   -> flat name "<namespace>__<name>", returns function_call with `namespace`;
//  - local_shell -> function {command[], workdir, timeout_ms}, returns local_shell_call;
//  - hosted tools run server-side by OpenAI -> can't be forwarded, skipped.
const CUSTOM_TOOL_PARAMS = {
  type: 'object',
  properties: { input: { type: 'string', description: 'The raw freeform tool input (not JSON-encoded).' } },
  required: ['input'],
  additionalProperties: false
};
const LOCAL_SHELL_PARAMS = {
  type: 'object',
  properties: {
    command: { type: 'array', items: { type: 'string' }, description: 'Command and arguments, e.g. ["bash", "-lc", "ls -la"].' },
    workdir: { type: 'string', description: 'Working directory for the command.' },
    timeout_ms: { type: 'number', description: 'Timeout in milliseconds.' }
  },
  required: ['command']
};

function responsesToolName(namespace, name) {
  const raw = namespace ? `${namespace}__${name}` : String(name || '');
  return raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function customToolDescription(t) {
  let d = t.description || '';
  d += `${d ? '\n\n' : ''}This is a FREEFORM tool: pass the raw input text in the "input" string argument, exactly as the tool expects it (do not wrap it in JSON).`;
  if (t.format?.type === 'grammar' && t.format.definition) {
    d += `\nThe input must match this ${t.format.syntax || ''} grammar:\n${t.format.definition}`;
  }
  return d;
}

// function_call_output / custom_tool_call_output: `output` is a string or an array of content items.
function responsesOutputToText(out) {
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) {
    return out.map(x => {
      if (typeof x === 'string') return x;
      if (typeof x?.text === 'string') return x.text;
      if (x?.type === 'input_image') return '[image]';
      return JSON.stringify(x);
    }).join('\n');
  }
  return out == null ? '' : JSON.stringify(out);
}

// OpenAI Responses API (Codex) -> IR.
function responsesToIR(payload) {
  const ir = baseIR();
  ir.model = payload.model || '';
  ir.stream = payload.stream === true;
  if (typeof payload.instructions === 'string' && payload.instructions) ir.system = payload.instructions;

  const pushText = (role, text) => {
    if (!text) return;
    const last = ir.messages[ir.messages.length - 1];
    if (last && last.role === role && typeof last.content === 'string' && !last.toolCalls) {
      last.content += '\n' + text;
    } else {
      ir.messages.push({ role, content: text });
    }
  };

  const appendSystem = (text) => {
    if (text) ir.system = ir.system ? `${ir.system}\n\n${text}` : text;
  };

  // Parallel tool calls arrive as consecutive items -> merge into 1 assistant turn,
  // otherwise OpenAI Chat/Anthropic will error that tool_calls aren't answered adjacently.
  const pushCall = (call) => {
    const last = ir.messages[ir.messages.length - 1];
    if (last && last.role === 'assistant') last.toolCalls = [...(last.toolCalls || []), call];
    else ir.messages.push({ role: 'assistant', toolCalls: [call] });
  };

  // Responses Lite sends the tools as an input item, not in payload.tools.
  const toolList = Array.isArray(payload.tools) ? [...payload.tools] : [];
  const input = payload.input;
  if (typeof input === 'string' && input) {
    ir.messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') { pushText('user', item); continue; }
      if (!item || typeof item !== 'object') continue;
      // EasyInputMessage ({role, content}) doesn't require `type`.
      if (item.type === 'message' || (!item.type && item.role)) {
        const c = item.content;
        const parts = [];
        if (typeof c === 'string') {
          if (c) parts.push({ type: 'text', text: c });
        } else if (Array.isArray(c)) {
          for (const p of c) {
            if (typeof p === 'string') { if (p) parts.push({ type: 'text', text: p }); continue; }
            if (!p || typeof p !== 'object') continue;
            if (p.type === 'input_image' && (p.image_url || p.url)) {
              parts.push({ type: 'image_url', image_url: { url: typeof p.image_url === 'string' ? p.image_url : (p.image_url?.url || p.url) } });
            } else if (typeof p.text === 'string' && p.text) {
              parts.push({ type: 'text', text: p.text });
            }
          }
        }
        if (item.role === 'system' || item.role === 'developer') {
          appendSystem(parts.filter(p => p.type === 'text').map(p => p.text).join('\n'));
          continue;
        }
        const role = item.role === 'assistant' ? 'assistant' : 'user';
        if (parts.every(p => p.type === 'text')) {
          pushText(role, parts.map(p => p.text).join('\n'));
        } else {
          ir.messages.push({ role, content: parts });
        }
      } else if (item.type === 'function_call') {
        pushCall({ id: item.call_id || item.id || null, name: responsesToolName(item.namespace, item.name), args: parseArgs(item.arguments) });
      } else if (item.type === 'custom_tool_call') {
        pushCall({ id: item.call_id || item.id || null, name: responsesToolName(item.namespace, item.name), args: { input: typeof item.input === 'string' ? item.input : responsesOutputToText(item.input) } });
      } else if (item.type === 'local_shell_call') {
        const a = item.action || {};
        pushCall({ id: item.call_id || item.id || null, name: 'local_shell', args: { command: a.command || [], workdir: a.working_directory ?? undefined, timeout_ms: a.timeout_ms ?? undefined } });
      } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output' || item.type === 'local_shell_call_output') {
        ir.messages.push({ role: 'tool', toolCallId: item.call_id || item.id, content: responsesOutputToText(item.output) });
      } else if (item.type === 'additional_tools' && Array.isArray(item.tools)) {
        toolList.push(...item.tools);
      }
    }
  }

  if (toolList.length) {
    ir.toolMeta = {};
    const addTool = (t, namespace) => {
      if (!t || typeof t !== 'object') return;
      // A tool in both payload.tools and an additional_tools item is sent once: upstreams refuse duplicate names.
      if (t.name && t.type !== 'namespace' && ir.toolMeta[responsesToolName(namespace, t.name)]) return;
      if (t.type === 'local_shell' && ir.toolMeta.local_shell) return;
      if (t.type === 'namespace' && Array.isArray(t.tools)) {
        for (const inner of t.tools) addTool(inner, t.name);
        return;
      }
      if (t.type === 'function' && t.name) {
        const name = responsesToolName(namespace, t.name);
        ir.tools.push({ name, description: t.description || '', parameters: sanitizeJsonSchema(t.parameters || {}) });
        ir.toolMeta[name] = { kind: 'function', name: t.name, namespace: namespace || null };
      } else if (t.type === 'custom' && t.name) {
        const name = responsesToolName(namespace, t.name);
        ir.tools.push({ name, description: customToolDescription(t), parameters: CUSTOM_TOOL_PARAMS });
        ir.toolMeta[name] = { kind: 'custom', name: t.name, namespace: namespace || null };
      } else if (t.type === 'local_shell') {
        ir.tools.push({ name: 'local_shell', description: 'Run a shell command on the user\'s machine and return its output.', parameters: LOCAL_SHELL_PARAMS });
        ir.toolMeta.local_shell = { kind: 'local_shell', name: 'local_shell', namespace: null };
      }
      // web_search / file_search / tool_search / image_generation...: hosted tools, skipped.
    };
    for (const t of toolList) addTool(t, null);
  }

  const tc = payload.tool_choice;
  if (typeof tc === 'string') ir.toolChoice = tc;
  else if ((tc?.type === 'function' || tc?.type === 'custom') && tc.name) ir.toolChoice = { name: responsesToolName(tc.namespace, tc.name) };
  else if (tc?.type === 'allowed_tools') applyAllowedTools(ir, tc.mode, tc.tools, t => (t?.name ? responsesToolName(t.namespace, t.name) : null));
  else if (['none', 'auto', 'required'].includes(tc?.type)) ir.toolChoice = tc.type;
  // A hosted tool (web search, file search) is not forwarded, so it cannot be forced.
  else if (tc && typeof tc === 'object') ir.toolChoice = 'auto';

  if (typeof payload.max_output_tokens === 'number') ir.params.maxTokens = payload.max_output_tokens;
  if (typeof payload.temperature === 'number') ir.params.temperature = payload.temperature;
  if (typeof payload.top_p === 'number') ir.params.topP = payload.top_p;
  if (payload.parallel_tool_calls === false) ir.params.parallelToolCalls = false;

  if (payload.reasoning && typeof payload.reasoning === 'object') {
    ir.thinking = thinkingFromReasoningParam(payload.reasoning);
  }
  return ir;
}

// Vertex generateContent -> IR.
function vertexToIR(payload) {
  const ir = baseIR();
  ir.model = payload.model || '';
  ir.stream = false; // proxy overrides per the :streamGenerateContent endpoint

  const sys = payload.systemInstruction?.parts;
  if (Array.isArray(sys)) {
    ir.system = sys.map(p => p.text || '').filter(Boolean).join('\n\n');
  } else if (typeof payload.system_instruction === 'string') {
    ir.system = payload.system_instruction;
  }

  // Vertex has no tool call ids: auto-generate ids for functionCalls then match functionResponses by name (FIFO),
  // so upstream OpenAI/Anthropic gets the correct tool_call <-> tool result pairs instead of "healing" them into text.
  const pendingByName = new Map();
  let callSeq = 0;

  if (Array.isArray(payload.contents)) {
    for (const c of payload.contents) {
      const parts = Array.isArray(c?.parts) ? c.parts : [];
      const texts = [];
      const toolCalls = [];
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        if (typeof p.text === 'string' && p.text && p.thought !== true) texts.push(p.text);
        if (p.functionCall) {
          const name = p.functionCall.name || '';
          const id = p.functionCall.id || `call_vtx_${callSeq++}_${name}`;
          if (!pendingByName.has(name)) pendingByName.set(name, []);
          pendingByName.get(name).push(id);
          const sig = p.thoughtSignature || p.thought_signature || null;
          rememberToolSignature(id, sig);
          toolCalls.push({ id, name, args: p.functionCall.args ?? {}, sig });
        }
        if (p.functionResponse) {
          const fr = p.functionResponse;
          const name = fr.name || '';
          const queue = pendingByName.get(name);
          const id = fr.id || (queue && queue.length ? queue.shift() : `call_vtx_orphan_${name}`);
          ir.messages.push({
            role: 'tool', toolCallId: id, name: name || null,
            content: typeof fr.response === 'string' ? fr.response : JSON.stringify(fr.response ?? '')
          });
        }
      }
      if (c.role === 'model') {
        const out = { role: 'assistant' };
        if (texts.length) out.content = texts.join('');
        if (toolCalls.length) out.toolCalls = toolCalls;
        if (out.content !== undefined || out.toolCalls) ir.messages.push(out);
      } else if (c.role === 'function') {
        // functionResponse already pushed above
      } else {
        if (texts.length) ir.messages.push({ role: 'user', content: texts.join('') });
      }
    }
  }

  const fns = payload.tools?.flatMap(t => t.functionDeclarations || t.function_declarations || []);
  if (Array.isArray(fns) && fns.length) {
    ir.tools = fns.filter(f => f.name).map(f => ({
      name: f.name, description: f.description || '',
      parameters: sanitizeJsonSchema(f.parameters || {})
    }));
  }

  const gc = payload.generationConfig || payload.generation_config || {};
  if (typeof gc.maxOutputTokens === 'number') ir.params.maxTokens = gc.maxOutputTokens;
  if (typeof gc.temperature === 'number') ir.params.temperature = gc.temperature;
  if (typeof gc.topP === 'number') ir.params.topP = gc.topP;
  if (Array.isArray(gc.stopSequences)) ir.params.stop = stopList(gc.stopSequences);
  const th = gc.thinkingConfig || gc.thinking_config;
  if (th && typeof th === 'object') {
    if (th.thinkingBudget === 0) ir.thinking = { type: 'disabled' };
    else if (th.thinkingBudget > 0) ir.thinking = { type: 'enabled', budget: clampBudget(th.thinkingBudget) };
    else if (th.thinkingLevel) ir.thinking = { type: 'enabled', budget: effortToBudget(th.thinkingLevel), effort: th.thinkingLevel };
    else if (th.includeThoughts) ir.thinking = { type: 'enabled', budget: 2048 };
  }
  return ir;
}

function parseToIR(clientFormat, payload) {
  switch (clientFormat) {
    case 'anthropic': return anthropicToIR(payload);
    case 'openai-chat': return chatToIR(payload);
    case 'responses': return responsesToIR(payload);
    case 'vertex': return vertexToIR(payload);
    default: throw new Error(`Unknown client format: ${clientFormat}`);
  }
}

// ---------------- emitters: IR -> upstream body ----------------

function hasNativeReasoning(model) {
  // Detect capability families instead of pinning exact versions. Claude Opus
  // model IDs change often, but all current Opus variants support reasoning.
  const m = String(model || '').toLowerCase();
  return m.includes('thinking') || m.includes('reasoning') || m.includes('reasoner') || m.includes('opus')
    || /(^|[/_.:-])(o[134]|r1|qwq)([/_.:-]|$)/.test(m);
}

// Healer Engine: normalize tool call <-> tool result pairs before emitting to any upstream.
//
// Token-compressing tools (RTK, Headroom, Ponytail) or history trimming break tool pairs:
//  - orphaned tool result (assistant turn holding the tool call was deleted)
//    -> Anthropic: "tool_use_id does not correspond to any tool_use"
//    -> OpenAI: "messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
//  - tool call with no immediately following result (result deleted or another message inserted in between)
//    -> Anthropic: "tool_use ids were found without tool_result blocks immediately after"
//    -> OpenAI: "assistant message with 'tool_calls' must be followed by tool messages"
//
// Rule: a tool result is only valid when placed right after the assistant turn that declared it. Orphaned results are
// converted to user text (preserving context); tool calls missing a result get a placeholder result.
const MISSING_TOOL_RESULT = '[Tool result unavailable: it was removed from the conversation history]';

function healToolPairs(messages) {
  const out = [];
  let pending = null;   // Map<callId, name> of the most recent assistant turn
  let deferred = [];    // orphaned results seen while awaiting results -> flushed later to preserve adjacency
  let seq = 0;

  const orphanText = (m) => ({
    role: 'user',
    content: `[Tool Result${m.toolCallId ? ` (${m.toolCallId})` : ''}]: ${m.content ?? ''}`
  });
  const flush = () => {
    if (pending) {
      for (const [id, name] of pending) {
        out.push({ role: 'tool', toolCallId: id, name, content: MISSING_TOOL_RESULT });
      }
      pending = null;
    }
    for (const m of deferred) out.push(orphanText(m));
    deferred = [];
  };

  let unnamed = [];     // ids given to calls that arrived with no id, in order

  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'tool') {
      // A result with no id answers the next call that also had none.
      const id = m.toolCallId || (pending && unnamed.find(u => pending.has(u)));
      if (pending && id && pending.has(id)) {
        const name = pending.get(id);
        pending.delete(id);
        out.push({ ...m, toolCallId: id, name: m.name || name });
      } else if (pending) {
        deferred.push(m);
      } else {
        out.push(orphanText(m));
      }
      continue;
    }
    flush();
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      unnamed = [];
      const toolCalls = m.toolCalls
        .filter(tc => tc && tc.name)
        .map(tc => {
          if (tc.id) return tc;
          const id = `call_heal_${seq++}`;
          unnamed.push(id);
          return { ...tc, id };
        });
      const msg = { ...m, toolCalls };
      if (!toolCalls.length) delete msg.toolCalls;
      out.push(msg);
      if (toolCalls.length) pending = new Map(toolCalls.map(tc => [tc.id, tc.name]));
      continue;
    }
    out.push(m);
  }
  flush();
  return out;
}

export const THINKING_MODES = ['auto', 'native', 'off'];

function normThinkingMode(mode) {
  return THINKING_MODES.includes(mode) ? mode : 'auto';
}

// IR -> OpenAI Chat Completions body.
//
// opts.thinkingMode (per profile):
//  - 'auto'   (default, for gateways like 9Router): restore thinking for reasoning models when compression tools
//             drop the param, inject a <think> guide for models without native reasoning, send both
//             `thinking` and `reasoning_effort`.
//  - 'native' (genuine OpenAI / strict OpenAI-compatible servers): only send `reasoning_effort` when
//             the client requests thinking, don't touch the system prompt, use `max_completion_tokens`.
//  - 'off'    : never send reasoning params, never inject prompts.
function irToChatBody(ir, model, opts = {}) {
  const messages = [];
  const mode = normThinkingMode(opts.thinkingMode);
  const clientWantsThinking = Boolean(ir.thinking && ir.thinking.type !== 'disabled');
  const modelIsThinking = hasNativeReasoning(model);
  const wantsThinking = mode === 'off' ? false
    : mode === 'native' ? clientWantsThinking
    : Boolean(clientWantsThinking || (modelIsThinking && (!ir.thinking || ir.thinking.type !== 'disabled')));

  let systemText = ir.system || '';
  if (mode === 'auto' && wantsThinking && !modelIsThinking && !String(model).toLowerCase().includes('gemini')) {
    const thinkGuide = 'You must provide your internal reasoning and step-by-step thinking inside <think> and </think> tags before your final response.';
    systemText = systemText ? `${thinkGuide}\n\n${systemText}` : thinkGuide;
  }
  if (systemText.trim()) messages.push({ role: 'system', content: systemText });

  for (const m of healToolPairs(ir.messages)) {
    if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' });
      continue;
    }
    const out = { role: m.role === 'assistant' ? 'assistant' : 'user' };
    if (m.content !== undefined) out.content = m.content;
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      out.tool_calls = m.toolCalls.map(tc => {
        const call = { id: tc.id, type: 'function', function: { name: tc.name, arguments: stringifyArgs(tc.args) } };
        const sig = tc.sig || lookupToolSignature(tc.id);
        if (sig) call.extra_content = { google: { thought_signature: sig } };
        return call;
      });
      if (out.content === undefined || out.content === '') out.content = null;
    }
    if (out.content === undefined) out.content = '';
    messages.push(out);
  }

  const body = { model, messages, stream: ir.stream === true };
  if (body.stream) body.stream_options = { include_usage: true };
  if (ir.tools.length) {
    body.tools = ir.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: sanitizeJsonSchema(t.parameters || {}) }
    }));
  }
  if (ir.toolChoice) {
    if (typeof ir.toolChoice === 'string') {
      body.tool_choice = ir.toolChoice === 'required' ? 'required' : ir.toolChoice;
    } else if (ir.toolChoice.name) {
      body.tool_choice = { type: 'function', function: { name: ir.toolChoice.name } };
    }
  }
  if (typeof ir.params.maxTokens === 'number') {
    if (mode === 'native') body.max_completion_tokens = ir.params.maxTokens;
    else body.max_tokens = ir.params.maxTokens;
  }
  if (typeof ir.params.temperature === 'number') body.temperature = ir.params.temperature;
  if (typeof ir.params.topP === 'number') body.top_p = ir.params.topP;
  if (typeof ir.params.presencePenalty === 'number') body.presence_penalty = ir.params.presencePenalty;
  if (typeof ir.params.frequencyPenalty === 'number') body.frequency_penalty = ir.params.frequencyPenalty;
  if (ir.params.stop.length) body.stop = ir.params.stop;
  if (ir.params.parallelToolCalls === false && body.tools) body.parallel_tool_calls = false;

  if (wantsThinking && mode === 'native') {
    body.reasoning_effort = ir.thinking?.effort && !['max', 'xhigh'].includes(ir.thinking.effort)
      ? ir.thinking.effort
      : (ir.thinking?.type === 'adaptive' ? 'high' : (ir.thinking?.budget ? budgetToEffort(ir.thinking.budget) : 'medium'));
  } else if (wantsThinking) {
    if (ir.thinking?.type === 'adaptive') {
      body.thinking = { type: 'adaptive' };
      body.reasoning_effort = ir.thinking.effort || 'high';
    } else {
      // Restore thinking: if an external compression tool (RTK/Headroom) dropped the thinking object,
      // but the target model is a reasoning model, the gateway auto re-enables thinking with a safe budget.
      const rawBudget = ir.thinking?.budget ?? (ir.thinking?.effort ? effortToBudget(ir.thinking.effort) : 2048);
      const safeBudget = clampBudget(rawBudget);
      body.thinking = { type: 'enabled', budget_tokens: safeBudget };
      body.reasoning_effort = ir.thinking?.effort || budgetToEffort(safeBudget);
    }
  }
  return body;
}

function urlToAnthropicImage(url) {
  const s = String(url || '');
  const m = s.match(/^data:([^;]+);base64,(.+)$/s);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  if (/^https?:\/\//i.test(s)) return { type: 'image', source: { type: 'url', url: s } };
  return null;
}

function contentToAnthropicBlocks(c) {
  if (typeof c === 'string') return c ? [{ type: 'text', text: c }] : [];
  if (!Array.isArray(c)) return [];
  const blocks = [];
  for (const p of c) {
    if (!p) continue;
    // Anthropic rejects empty text blocks ("text content blocks must be non-empty").
    if (p.type === 'text' && p.text) blocks.push({ type: 'text', text: p.text });
    else if (p.type === 'image_url') {
      const img = urlToAnthropicImage(typeof p.image_url === 'string' ? p.image_url : p.image_url?.url);
      if (img) blocks.push(img);
    }
  }
  return blocks;
}

// IR -> Anthropic Messages body.
function irToAnthropicBody(ir, model) {
  const messages = [];

  for (const m of healToolPairs(ir.messages)) {
    if (m.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content ?? '' }]
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = contentToAnthropicBlocks(m.content).filter(b => b.type === 'text');
      for (const tc of (m.toolCalls || [])) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parseArgs(tc.args) });
      }
      if (blocks.length) messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    const blocks = contentToAnthropicBlocks(m.content);
    if (blocks.length) messages.push({ role: 'user', content: blocks });
  }

  // Normalize messages for the Anthropic API:
  // 1. Merge consecutive same-role messages (consecutive user-user or assistant-assistant).
  // 2. Ensure the first message is always 'user'.
  // 3. Ensure there is at least 1 message.
  const normalizedMessages = [];
  const toBlocks = (c) => typeof c === 'string' ? (c ? [{ type: 'text', text: c }] : []) : Array.isArray(c) ? c : [];

  for (const msg of messages) {
    const blocks = toBlocks(msg.content);
    if (!blocks.length) continue;
    const last = normalizedMessages[normalizedMessages.length - 1];
    if (last && last.role === msg.role) {
      last.content = [...toBlocks(last.content), ...blocks];
    } else {
      normalizedMessages.push({ role: msg.role, content: blocks });
    }
  }

  if (normalizedMessages.length > 0 && normalizedMessages[0].role === 'assistant') {
    normalizedMessages.unshift({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
  }
  if (normalizedMessages.length === 0) {
    normalizedMessages.push({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
  }

  const body = {
    model,
    max_tokens: (typeof ir.params.maxTokens === 'number' ? ir.params.maxTokens : 4096),
    messages: normalizedMessages,
    stream: ir.stream === true
  };
  if (ir.system && ir.system.trim()) body.system = ir.system;
  if (ir.tools.length) {
    body.tools = ir.tools.map(t => ({
      name: t.name, description: t.description || '',
      input_schema: sanitizeJsonSchema(t.parameters || {})
    }));
  }
  if (ir.toolChoice) {
    if (typeof ir.toolChoice === 'string') {
      body.tool_choice = ir.toolChoice === 'required' ? { type: 'any' } : { type: ir.toolChoice };
    } else if (ir.toolChoice.name) {
      body.tool_choice = { type: 'tool', name: ir.toolChoice.name };
    }
  }
  if (ir.params.parallelToolCalls === false && body.tool_choice) body.tool_choice.disable_parallel_tool_use = true;
  if (typeof ir.params.temperature === 'number') body.temperature = ir.params.temperature;
  if (typeof ir.params.topP === 'number') body.top_p = ir.params.topP;
  if (typeof ir.params.topK === 'number') body.top_k = ir.params.topK;
  if (ir.params.stop.length) body.stop_sequences = ir.params.stop;
  if (ir.thinking && ir.thinking.type === 'adaptive') {
    body.thinking = { type: 'adaptive' };
  } else if (ir.thinking && ir.thinking.type !== 'disabled' && body.max_tokens > 1024) {
    // Anthropic requires 1024 <= budget_tokens < max_tokens; drop thinking when max_tokens is too small.
    const budget = clampBudget(ir.thinking.budget ?? (ir.thinking.effort ? effortToBudget(ir.thinking.effort) : 4096));
    body.thinking = { type: 'enabled', budget_tokens: Math.min(budget, body.max_tokens - 1) };
  }
  if (body.thinking) {
    // When thinking is on, Anthropic rejects temperature != 1, top_k, or top_p < 0.95.
    if (body.temperature !== undefined && body.temperature !== 1) delete body.temperature;
    delete body.top_k;
    if (body.top_p !== undefined && body.top_p < 0.95) delete body.top_p;
    // tool_choice any/tool is incompatible with extended thinking.
    if (body.tool_choice && (body.tool_choice.type === 'any' || body.tool_choice.type === 'tool')) {
      body.tool_choice = { type: 'auto', ...(body.tool_choice.disable_parallel_tool_use ? { disable_parallel_tool_use: true } : {}) };
    }
  }
  return body;
}

function dataUrlToInlineData(url) {
  const m = String(url || '').match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return null;
  return { inlineData: { mimeType: m[1], data: m[2] } };
}

// IR -> Vertex generateContent body.
function irToVertexBody(ir, model) {
  const contents = [];
  const textPartsOf = (c) => {
    if (typeof c === 'string') return c ? [{ text: c }] : [];
    if (Array.isArray(c)) {
      const parts = [];
      for (const p of c) {
        if (p.type === 'text' && p.text) parts.push({ text: p.text });
        else if (p.type === 'image_url') {
          const inline = dataUrlToInlineData(p.image_url?.url);
          if (inline) parts.push(inline);
        }
      }
      return parts;
    }
    return [];
  };

  // Merge adjacent contents of the same kind: Gemini requires all functionResponses of one parallel-call round
  // to share a single content (functionResponse count must match the previous functionCall count).
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    const isFnResp = parts.some(p => p.functionResponse);
    const lastIsFnResp = last?.parts.some(p => p.functionResponse);
    if (last && last.role === role && isFnResp === lastIsFnResp) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  const healed = healToolPairs(ir.messages);
  // The "current turn" starts at the last user message with real content (not a functionResponse).
  let turnStart = -1;
  healed.forEach((m, i) => { if (m.role === 'user') turnStart = i; });
  const needSig = geminiRequiresSignatures(model);

  for (const [i, m] of healed.entries()) {
    if (m.role === 'tool') {
      let resp;
      try {
        const parsed = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
        // functionResponse.response must be an object (Struct), not an array/primitive.
        resp = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : { result: parsed ?? '' };
      } catch { resp = { result: m.content ?? '' }; }
      // Gemini API & Vertex only accept roles 'user' | 'model' (functionResponse lives in the 'user' role).
      push('user', [{ functionResponse: { name: m.name || 'tool', response: resp } }]);
      continue;
    }
    if (m.role === 'assistant') {
      const parts = textPartsOf(m.content).filter(p => p.text);
      (m.toolCalls || []).forEach((tc, j) => {
        const part = { functionCall: { name: tc.name, args: parseArgs(tc.args) } };
        const sig = tc.sig || lookupToolSignature(tc.id);
        if (sig) part.thoughtSignature = sig;
        // Only the first functionCall of each step in the current turn is checked.
        else if (needSig && j === 0 && i > turnStart) part.thoughtSignature = GEMINI_DUMMY_SIGNATURE;
        parts.push(part);
      });
      push('model', parts);
      continue;
    }
    push('user', textPartsOf(m.content));
  }

  const body = { contents };
  if (ir.system && ir.system.trim()) {
    body.systemInstruction = { parts: [{ text: ir.system }] };
  }
  if (ir.tools.length) {
    body.tools = [{
      functionDeclarations: ir.tools.map(t => ({
        name: t.name, description: t.description || '',
        parameters: toGeminiSchema(t.parameters || { type: 'object', properties: {} })
      }))
    }];
  }
  if (ir.toolChoice) {
    const mode = ir.toolChoice === 'none' ? 'NONE' : ir.toolChoice === 'auto' ? 'AUTO' : 'ANY';
    const fcc = { mode };
    if (typeof ir.toolChoice === 'object' && ir.toolChoice.name) fcc.allowedFunctionNames = [ir.toolChoice.name];
    if (body.tools) body.toolConfig = { functionCallingConfig: fcc };
  }
  const gc = {};
  if (typeof ir.params.temperature === 'number') gc.temperature = ir.params.temperature;
  if (typeof ir.params.topP === 'number') gc.topP = ir.params.topP;
  if (typeof ir.params.topK === 'number') gc.topK = ir.params.topK;
  if (typeof ir.params.maxTokens === 'number') gc.maxOutputTokens = ir.params.maxTokens;
  if (ir.params.stop.length) gc.stopSequences = ir.params.stop;
  if (ir.thinking && ir.thinking.type !== 'disabled') {
    // includeThoughts: without this flag Gemini won't return thought parts -> the client loses thinking.
    gc.thinkingConfig = { includeThoughts: true };
    if (ir.thinking.type === 'enabled') {
      gc.thinkingConfig.thinkingBudget = clampBudget(ir.thinking.budget ?? (ir.thinking.effort ? effortToBudget(ir.thinking.effort) : 2048));
    }
  }
  if (Object.keys(gc).length) body.generationConfig = gc;
  return body;
}

// JSON Schema -> Gemini/Vertex Schema (OpenAPI subset). Gemini rejects keys like
// additionalProperties, $schema, $ref, const, exclusiveMinimum, array-form type...
const GEMINI_SCHEMA_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'items', 'properties', 'required',
  'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'anyOf', 'propertyOrdering', 'default', 'example'
]);

// Resolve a local JSON-Schema $ref ('#/$defs/X', '#/definitions/X', '#/properties/...')
// against the root parameters object. Returns the target node or null.
function resolveLocalRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = root;
  for (const p of parts) {
    if (!node || typeof node !== 'object') return null;
    node = node[p];
  }
  return node && typeof node === 'object' && !Array.isArray(node) ? node : null;
}

// A union of exactly one real schema plus an optional null branch collapses to that
// schema (+nullable). Anything else (multi-branch anyOf) is left for the caller.
function collapseNullableUnion(branches) {
  if (!Array.isArray(branches)) return null;
  const isNullBranch = (s) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
    if (s.type === 'null') return true;
    if (Array.isArray(s.type)) return s.type.length === 1 && s.type[0] === 'null';
    if (Array.isArray(s.enum) && s.enum.length === 1 && s.enum[0] === null) return true;
    if (Object.hasOwn(s, 'const') && s.const === null) return true;
    return false;
  };
  const rest = branches.filter(s => !isNullBranch(s));
  if (rest.length !== 1) return null;
  return { schema: rest[0], nullable: rest.length !== branches.length };
}

function toGeminiSchema(schema, root, seen) {
  // Shorthand left by some MCP servers: a bare "object"/"string" where a Schema belongs.
  // Vertex rejects the raw string with INVALID_ARGUMENT, so expand it.
  if (typeof schema === 'string') {
    return schema === 'object' ? { type: 'object', properties: {} } : { type: schema };
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  root = root || schema;
  seen = seen || new Set();
  if (seen.has(schema)) return {};
  // Inline local $refs: Vertex/GenAI function declarations do not support $ref/$defs.
  if (typeof schema.$ref === 'string') {
    const target = resolveLocalRef(root, schema.$ref);
    if (!target) return {};
    seen.add(schema);
    const merged = toGeminiSchema(target, root, seen);
    seen.delete(schema);
    const extra = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k !== '$ref' && (k === 'description' || k === 'title' || k === 'default' || k === 'example')) extra[k] = v;
    }
    return { ...merged, ...extra };
  }
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$ref' || k === '$defs' || k === 'definitions') continue;
    if (k === 'const') { out.enum = [v]; continue; }
    if ((k === 'oneOf' || k === 'anyOf') && Array.isArray(v)) {
      const collapsed = collapseNullableUnion(v);
      if (collapsed) {
        const inner = toGeminiSchema(collapsed.schema, root, seen);
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) Object.assign(out, inner);
        if (collapsed.nullable) out.nullable = true;
        continue;
      }
      if (k === 'oneOf') { out.anyOf = v.map(s => toGeminiSchema(s, root, seen)); continue; }
    }
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, toGeminiSchema(s, root, seen)]));
    } else if (k === 'items') {
      out.items = Array.isArray(v) ? toGeminiSchema(v[0] || {}, root, seen) : toGeminiSchema(v, root, seen);
    } else if (k === 'anyOf' && Array.isArray(v)) {
      out.anyOf = v.map(s => toGeminiSchema(s, root, seen));
    } else if (k === 'type' && Array.isArray(v)) {
      const types = v.filter(t => t !== 'null');
      out.type = types[0] || 'string';
      if (types.length !== v.length) out.nullable = true;
    } else if (k === 'format' && !['enum', 'date-time', 'int32', 'int64', 'float', 'double'].includes(v)) {
      continue;
    } else if (k === 'enum' && Array.isArray(v)) {
      out.enum = v.filter(x => x !== null).map(String);
    } else {
      out[k] = v;
    }
  }
  if (!out.type && out.properties) out.type = 'object';
  if (out.type === 'object' && !out.properties) out.properties = {};
  if (out.enum && !out.type) out.type = 'string';
  if (out.enum && out.type !== 'string') {
    // Gemini supports enum for strings only. Keep the constraint as text for the model.
    const values = (schema.enum || (Object.hasOwn(schema, 'const') ? [schema.const] : [])).filter(x => x !== null);
    if (values.length) out.description = `${out.description ? `${out.description} ` : ''}Allowed values: ${values.join(', ')}.`;
    delete out.enum;
  }
  if (Array.isArray(out.required)) {
    out.required = out.type === 'object' && out.properties ? out.required.filter(r => Object.hasOwn(out.properties, r)) : [];
    if (!out.required.length) delete out.required;
  }
  return out;
}

// Claude Code injects an `x-anthropic-billing-header: ...` line at the top of system. Google Antigravity
// answers that line with a bogus 429 RESOURCE_EXHAUSTED even when quota remains, so strip it only when the target model is antigravity
// (`ag/...`). 9Router's Claude provider still needs the header, so keep it for all other models.
const BILLING_HEADER_RE = /^x-anthropic-billing-header:[^\n]*(?:\r?\n)*/i;

function isAntigravityModel(model) {
  return /^(ag|antigravity)\//i.test(String(model || ''));
}

function emitUpstreamBody(outFormat, ir, model, opts = {}) {
  // thinkingMode 'off' applies to all upstreams: drop the client's thinking entirely.
  let src = normThinkingMode(opts.thinkingMode) === 'off' ? { ...ir, thinking: { type: 'disabled' } } : ir;
  if (isAntigravityModel(model) && src.system) src = { ...src, system: src.system.replace(BILLING_HEADER_RE, '') };
  switch (outFormat) {
    case 'anthropic': return irToAnthropicBody(src, model);
    case 'vertex': return irToVertexBody(src, model);
    case 'openai-chat':
    default: return irToChatBody(src, model, opts);
  }
}

// ---------------- native Anthropic healer (direct passthrough) ----------------
// The anthropic -> anthropic branch skips IR (to preserve thinking signatures, cache_control, documents...),
// so it patches the Anthropic payload directly, touching only what the API will definitely reject:
//  1. orphaned tool_result -> text block;
//  2. tool_use missing tool_result in the next user turn -> add a placeholder tool_result;
//  3. tool_result must lead the user turn -> move it to the front;
//  4. thinking block with a fake signature (generated by the gateway during conversion) -> drop, since Anthropic verifies signatures;
//  5. thinking on but the last assistant turn of the tool loop doesn't start with thinking -> disable thinking
//     for this request (Anthropic: "a final assistant message must start with a thinking block").

export const PLACEHOLDER_SIGNATURE = 'reasoning-sig';

// Signatures the gateway issues to Anthropic clients are always "not from Anthropic": a placeholder, or
// another provider's signature wrapped with the `lsw1.` prefix (so it can be sent back to that provider later).
export const FOREIGN_SIG_PREFIX = 'lsw1.';

function isGatewaySignature(sig) {
  return !sig || sig === PLACEHOLDER_SIGNATURE || String(sig).startsWith(FOREIGN_SIG_PREFIX);
}

function toAnthropicBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? content.filter(Boolean) : [];
}

function toolResultText(block) {
  const c = block.content;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) ? c.map(x => (x?.type === 'text' ? x.text : x?.type === 'image' ? '[image omitted]' : JSON.stringify(x))).join('\n')
    : c ? JSON.stringify(c) : '';
  return `[Tool Result${block.tool_use_id ? ` (${block.tool_use_id})` : ''}]: ${text}`;
}

function healAnthropicPayload(payload) {
  const notes = [];
  if (!payload || !Array.isArray(payload.messages)) return { payload, changed: false, notes };
  const src = payload.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant'));
  let changed = src.length !== payload.messages.length;

  // Step 0: drop thinking blocks with fake signatures; merge adjacent user turns (so a tool_result split
  // into a later turn can still be matched with its tool_use).
  const msgs = [];
  for (const m of src) {
    let content = m.content;
    if (m.role === 'assistant' && Array.isArray(content)) {
      const kept = content.filter(b => !(b && b.type === 'thinking' && isGatewaySignature(b.signature)));
      if (kept.length !== content.length) {
        changed = true;
        notes.push('stripped placeholder-signed thinking blocks');
        content = kept;
      }
      if (!content.length) {
        changed = true;
        continue;
      }
    }
    const last = msgs[msgs.length - 1];
    if (m.role === 'user' && last && last.role === 'user') {
      last.content = [...toAnthropicBlocks(last.content), ...toAnthropicBlocks(content)];
      changed = true;
      continue;
    }
    msgs.push({ ...m, content });
  }

  // Steps 1-3: pair up tool_use / tool_result.
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant') {
      out.push(m);
      const toolIds = toAnthropicBlocks(m.content).filter(b => b.type === 'tool_use' && b.id).map(b => b.id);
      if (toolIds.length && msgs[i + 1]?.role !== 'user') {
        out.push({ role: 'user', content: toolIds.map(id => ({ type: 'tool_result', tool_use_id: id, content: MISSING_TOOL_RESULT })) });
        changed = true;
        notes.push('added placeholder tool_result');
      }
      continue;
    }
    const prev = out[out.length - 1];
    const pending = prev?.role === 'assistant'
      ? toAnthropicBlocks(prev.content).filter(b => b.type === 'tool_use' && b.id).map(b => b.id)
      : [];
    const blocks = toAnthropicBlocks(m.content);
    const results = new Map();
    const rest = [];
    for (const b of blocks) {
      if (b.type === 'tool_result' && pending.includes(b.tool_use_id) && !results.has(b.tool_use_id)) {
        results.set(b.tool_use_id, b);
      } else if (b.type === 'tool_result') {
        rest.push({ type: 'text', text: toolResultText(b) });
        changed = true;
        notes.push('converted orphaned tool_result to text');
      } else {
        rest.push(b);
      }
    }
    if (!blocks.some(b => b.type === 'tool_result') && !pending.length) {
      out.push(m);
      continue;
    }
    const head = pending.map(id => {
      if (results.has(id)) return results.get(id);
      changed = true;
      notes.push('added placeholder tool_result');
      return { type: 'tool_result', tool_use_id: id, content: MISSING_TOOL_RESULT };
    });
    const newContent = [...head, ...rest];
    // Blocks are reused by reference, so an unchanged turn has the same objects in the same order.
    if (newContent.length === blocks.length && newContent.every((b, i) => b === blocks[i])) {
      out.push(m);
      continue;
    }
    changed = true;
    notes.push('normalized tool_result placement');
    out.push({ ...m, content: newContent.length ? newContent : [{ type: 'text', text: '(empty)' }] });
  }

  let body = { ...payload, messages: out };

  // Step 5: thinking + an in-progress tool loop whose last assistant turn doesn't open with thinking.
  const thinkingOn = payload.thinking && payload.thinking.type && payload.thinking.type !== 'disabled';
  if (thinkingOn) {
    const lastUser = out[out.length - 1];
    const lastAssistant = out[out.length - 2];
    const inToolLoop = lastUser?.role === 'user' && toAnthropicBlocks(lastUser.content).some(b => b.type === 'tool_result');
    const first = lastAssistant?.role === 'assistant' ? toAnthropicBlocks(lastAssistant.content)[0] : null;
    if (inToolLoop && first && first.type !== 'thinking' && first.type !== 'redacted_thinking') {
      body = { ...body };
      delete body.thinking;
      changed = true;
      notes.push('disabled thinking: last assistant turn has no valid thinking block');
    }
  }

  if (!changed) return { payload, changed: false, notes };
  return { payload: body, changed: true, notes: [...new Set(notes)] };
}

// Estimate tokens for /count_tokens when the upstream has no real counting endpoint.
function estimateTokens(payload) {
  let chars = 0;
  let images = 0;
  const walk = (v) => {
    if (typeof v === 'string') { chars += v.length; return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      if (v.type === 'image' || v.type === 'image_url' || v.type === 'document') { images++; return; }
      for (const [k, x] of Object.entries(v)) {
        if (k === 'data' || k === 'cache_control') continue;
        walk(x);
      }
    }
  };
  walk(payload?.system);
  walk(payload?.messages);
  walk(payload?.tools);
  return Math.ceil(chars / 4) + images * 1600;
}

// ---------------- upstream event normalization ----------------
// Every upstream response (any format, stream or JSON) -> standard events:
// { think:[{text,sig}], text:[str], tools:[{index,id,name,args}],
//   finish: 'stop'|'length'|'tool_calls'|'content_filter'|null,
//   usage:{prompt,completion,cached}, sig, error }
//
// Usage convention: prompt = total input tokens (including cached, per OpenAI semantics), cached = cache read.

function chunkToolFull(tc, idx) {
  return { index: (typeof tc.index === 'number' ? tc.index : idx), id: tc.id || null, name: tc.name || null, args: tc.args || '', sig: tc.sig || null };
}

// ---------------- Gemini thought signature cache ----------------
// Gemini 3 requires resending the functionCall's thoughtSignature within the current turn (missing -> HTTP 400).
// Clients like Claude Code / Codex don't carry this signature, so the gateway remembers it by tool call id (in-RAM LRU)
// and reattaches it when history comes back. Cache lost (restart) -> use the Google-allowed dummy signature.
// https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
export const GEMINI_DUMMY_SIGNATURE = 'skip_thought_signature_validator';
const MAX_SIGNATURES = 5000;
const toolSignatures = new Map();

function rememberToolSignature(id, sig) {
  if (!id || !sig) return;
  toolSignatures.delete(id);
  toolSignatures.set(id, sig);
  if (toolSignatures.size > MAX_SIGNATURES) toolSignatures.delete(toolSignatures.keys().next().value);
}

function lookupToolSignature(id) {
  return id ? toolSignatures.get(id) || null : null;
}

function geminiRequiresSignatures(model) {
  const m = String(model || '').toLowerCase().match(/gemini-(\d+)/);
  return Boolean(m && Number(m[1]) >= 3);
}

function anthropicUsage(u) {
  const o = (u && typeof u === 'object') ? u : {};
  const input = Number(o.input_tokens) || 0;
  const cacheRead = Number(o.cache_read_input_tokens) || 0;
  const cacheCreate = Number(o.cache_creation_input_tokens) || 0;
  // Anthropic reports thinking tokens under output_tokens_details.
  const det = (o.output_tokens_details && typeof o.output_tokens_details === 'object') ? o.output_tokens_details : {};
  return {
    prompt: input + cacheRead + cacheCreate,
    completion: Number(o.output_tokens) || 0,
    cached: cacheRead,
    reasoning: Number(det.thinking_tokens || det.reasoning_tokens) || 0
  };
}

function upstreamError(parsed) {
  if (parsed.type === 'error') return parsed.error?.message || JSON.stringify(parsed.error || parsed);
  if (parsed.error && typeof parsed.error === 'object' && !parsed.choices && !parsed.candidates) {
    return parsed.error.message || JSON.stringify(parsed.error);
  }
  return null;
}

function normalizeUpstream(parsed, outFormat) {
  const ev = { think: [], text: [], tools: [], finish: null, usage: { prompt: 0, completion: 0, cached: 0, reasoning: 0 }, sig: null, error: null };
  if (!parsed || typeof parsed !== 'object') return ev;

  const err = upstreamError(parsed);
  if (err) {
    ev.error = err;
    return ev;
  }

  if (outFormat === 'anthropic') {
    const t = parsed.type;
    if (t === 'content_block_delta') {
      const d = parsed.delta || {};
      if (d.type === 'thinking_delta' && d.thinking) ev.think.push({ text: d.thinking });
      else if (d.type === 'text_delta' && d.text) ev.text.push(d.text);
      else if (d.type === 'signature_delta' && d.signature) ev.sig = d.signature;
      else if (d.type === 'input_json_delta' && d.partial_json) {
        ev.tools.push({ index: parsed.index ?? 0, id: null, name: null, args: d.partial_json });
      }
    } else if (t === 'content_block_start') {
      const b = parsed.content_block || {};
      if (b.type === 'tool_use') ev.tools.push({ index: parsed.index ?? 0, id: b.id || null, name: b.name || null, args: '' });
      else if (b.type === 'thinking' && b.thinking) ev.think.push({ text: b.thinking });
      else if (b.type === 'text' && b.text) ev.text.push(b.text);
    } else if (t === 'message_start') {
      ev.usage = anthropicUsage(parsed.message?.usage);
    } else if (t === 'message_delta') {
      if (parsed.delta?.stop_reason) ev.finish = canonFinish(parsed.delta.stop_reason);
      ev.usage = anthropicUsage(parsed.usage);
    } else if (t === 'message' && Array.isArray(parsed.content)) {
      // non-stream Anthropic message
      for (const b of parsed.content) {
        if (b.type === 'thinking' && b.thinking) ev.think.push({ text: b.thinking, sig: b.signature || null });
        else if (b.type === 'text' && b.text) ev.text.push(b.text);
        else if (b.type === 'tool_use') ev.tools.push(chunkToolFull({ index: ev.tools.length, id: b.id, name: b.name, args: stringifyArgs(b.input) }));
      }
      if (parsed.stop_reason) ev.finish = canonFinish(parsed.stop_reason);
      ev.usage = anthropicUsage(parsed.usage);
    }
    return ev;
  }

  // openai-chat | vertex (both SSE chunks and full JSON share one shape)
  // Read usage FIRST: OpenAI's final usage chunk (stream_options.include_usage) has `choices: []`.
  const u = smartUsage(parsed.usage ?? parsed.usageMetadata);
  // Forward the whole shape. Listing the fields by hand here is how `reasoning`
  // was silently dropped between smartUsage and the emitters on 2026-09-20.
  ev.usage = u;

  const choice = firstChoice(parsed);
  const node = smartDelta(choice) || (outFormat === 'vertex' ? parsed : null);
  if (!node) return ev;
  const r = smartReasoning(node);
  if (r) {
    ev.think.push({ text: r.text, sig: r.signature || null });
    if (r.signature) ev.sig = r.signature;
  }
  const tx = smartText(node);
  if (tx) ev.text.push(tx);
  for (const tc of smartToolCalls(node)) ev.tools.push(chunkToolFull(tc));
  const f = smartFinish(parsed, choice);
  if (f) ev.finish = canonFinish(f);
  return ev;
}

// Stateful normalizer for one response: renumber tool call indexes to continuous 0,1,2...
//  - Vertex returns complete functionCalls with no index -> each call is a new tool
//    (previously every call had index 0 so args from different calls got concatenated).
//  - Anthropic uses block indexes (1, 2...) -> OpenAI clients need tool_calls indexes starting at 0.
//  - OpenAI-compatible providers drop `index` but send distinct ids -> split into separate tools.
function createUpstreamNormalizer(outFormat) {
  const slots = new Map();
  let next = 0;
  return (parsed) => {
    const ev = normalizeUpstream(parsed, outFormat);
    for (const tc of ev.tools) {
      if (outFormat === 'vertex') {
        tc.index = next++;
        // Vertex has no id -> generate a stable id for the client to send back, used as the signature-cache key.
        tc.id = tc.id || `call_${rand(24)}`;
        rememberToolSignature(tc.id, tc.sig);
        continue;
      }
      const key = tc.index ?? 0;
      const slot = slots.get(key);
      if (!slot || (tc.id && slot.id && tc.id !== slot.id)) {
        const created = { index: next++, id: tc.id || null };
        slots.set(key, created);
        tc.index = created.index;
      } else {
        if (!slot.id && tc.id) slot.id = tc.id;
        tc.index = slot.index;
      }
      rememberToolSignature(tc.id || slots.get(key)?.id, tc.sig);
    }
    return ev;
  };
}

// Collect events for non-stream (also the usage accumulator for stream).
function createCollector() {
  const C = {
    think: [], text: [], tools: new Map(), finish: null,
    prompt: 0, completionTokens: 0, cached: 0, reasoning: 0, usageSum: 0,
    sig: null, chars: 0, error: null,
    add(ev) {
      for (const t of (ev.think || [])) {
        C.think.push(t.text);
        C.chars += t.text.length;
        if (t.sig && !C.sig) C.sig = t.sig;
      }
      if (ev.sig && !C.sig) C.sig = ev.sig;
      for (const t of (ev.text || [])) {
        C.text.push(t);
        C.chars += t.length;
      }
      for (const tc of (ev.tools || [])) {
        const idx = tc.index ?? 0;
        if (!C.tools.has(idx)) C.tools.set(idx, { index: idx, id: tc.id, name: tc.name, args: '' });
        const s = C.tools.get(idx);
        if (!s.id && tc.id) s.id = tc.id;
        if (!s.sig && tc.sig) s.sig = tc.sig;
        if ((!s.name || s.name === 'tool') && tc.name) s.name = tc.name;
        if (tc.args) {
          s.args += tc.args;
          C.chars += tc.args.length;
        }
      }
      if (ev.finish) C.finish = ev.finish;
      if (ev.error) C.error = ev.error;
      if (ev.usage) {
        // Three upstream shapes, not two:
        //   cumulative  - Anthropic/Vertex repeat a running total in every chunk
        //   final-once  - OpenAI sends one usage object at the end
        //   per-chunk   - qwen/zai on Cloudflare send a DELTA every chunk
        //                 (completion_tokens: 1 x N, see docs/LLM-RESPONSE-MATRIX.md)
        // Math.max is right for the first two and reports 1 for the third. A value
        // that does not grow is the signature of a delta, so switch to summing the
        // moment a later chunk reports less completion than the running total.
        const completion = ev.usage.completion || 0;
        C.completionTokens = Math.max(C.completionTokens, completion);
        C.usageSum += completion;
        C.prompt = Math.max(C.prompt, ev.usage.prompt || 0);
        C.cached = Math.max(C.cached, ev.usage.cached || 0);
        C.reasoning = Math.max(C.reasoning, ev.usage.reasoning || 0);
      }
    },
    // Upstream returned no usage -> estimate ~4 chars / token.
    //
    // Three upstream shapes exist, not two. Anthropic and Vertex repeat a running
    // total in every chunk and OpenAI sends one object at the end: for both, the
    // maximum is the answer. But qwen and zai on Cloudflare send a per-token DELTA
    // in every chunk (`completion_tokens: 1` x N, docs/LLM-RESPONSE-MATRIX.md:126),
    // and the maximum of those is 1 no matter how long the reply was.
    //
    // Rather than guess the shape from the number pattern, compare the reported
    // total against what was actually streamed. A total far below the text we
    // received cannot be a total, so the sum is the honest figure.
    completion() {
      const estimate = Math.ceil(C.chars / 4);
      if (C.completionTokens <= 0) return estimate;
      if (C.usageSum > C.completionTokens && C.completionTokens * 4 < estimate) return C.usageSum;
      return C.completionTokens;
    }
  };
  return C;
}

// ---------------- <think> tag splitter ----------------
// Many OSS models (DeepSeek, Qwen, GLM) stuff reasoning into content as <think>...</think>.
// The splitter tolerates tags split across 2 chunks (e.g. "<thi" + "nk>").

const THINK_TAGS = ['<think>', '</think>', '<thinking>', '</thinking>'];

function createThinkTagSplitter(onThink, onText) {
  let carry = '';
  let inTag = false;
  const emitTok = (tok) => {
    if (!tok) return;
    if (inTag) onThink(tok);
    else onText(tok);
  };
  return {
    push(raw) {
      if (!raw) return;
      let buf = carry + raw;
      carry = '';
      const lastOpen = buf.lastIndexOf('<');
      if (lastOpen !== -1) {
        const tail = buf.slice(lastOpen).toLowerCase();
        if (!tail.includes('>') && THINK_TAGS.some(t => t.startsWith(tail))) {
          carry = buf.slice(lastOpen);
          buf = buf.slice(0, lastOpen);
        }
      }
      for (const tok of buf.split(/(<\/?think(?:ing)?>)/i)) {
        if (!tok) continue;
        if (/^<think(?:ing)?>$/i.test(tok)) { inTag = true; continue; }
        if (/^<\/think(?:ing)?>$/i.test(tok)) { inTag = false; continue; }
        emitTok(tok);
      }
    },
    flush() {
      const c = carry;
      carry = '';
      emitTok(c);
    }
  };
}

function splitThinkTags(text) {
  const think = [];
  const out = [];
  const sp = createThinkTagSplitter(t => think.push(t), t => out.push(t));
  sp.push(text);
  sp.flush();
  return { think: think.join(''), text: out.join('') };
}

// ---------------- client renderers ----------------
// Each renderer has: start(), think(text, sig), text(t), tool({index,id,name,args}),
// finish(canonical, {prompt, completion, cached, hasTools}), error(message).

function rand(n = 6) {
  let s = '';
  while (s.length < n) s += Math.random().toString(36).slice(2);
  return s.slice(0, n);
}

function anthropicStopReason(canonical, hasTools) {
  if (canonical === 'length') return 'max_tokens';
  if (hasTools) return 'tool_use';
  switch (canonical) {
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    default: return 'end_turn';
  }
}

// --- Anthropic SSE + message ---
// Sequential block state machine: indexes grow in content_block_start order, never
// write deltas into a stopped block or reuse an index (thinking -> tool -> thinking -> text are all valid).
function createAnthropicStream(emit, model) {
  const msgId = `msg_${Date.now()}_${rand()}`;
  let nextIndex = 0;
  let open = null;          // { kind: 'thinking' | 'text', index }
  const tools = new Map();  // tool index -> { index, id, name, closed }
  let sig = null;

  function closeOpen() {
    if (!open) return;
    if (open.kind === 'thinking') {
      emit('content_block_delta', { type: 'content_block_delta', index: open.index, delta: { type: 'signature_delta', signature: sig ? FOREIGN_SIG_PREFIX + sig : PLACEHOLDER_SIGNATURE } });
    }
    emit('content_block_stop', { type: 'content_block_stop', index: open.index });
    open = null;
  }
  function closeTools() {
    for (const t of tools.values()) {
      if (!t.closed) {
        emit('content_block_stop', { type: 'content_block_stop', index: t.index });
        t.closed = true;
      }
    }
  }
  function delta(kind, tok) {
    if (!open || open.kind !== kind) {
      closeOpen();
      closeTools();
      open = { kind, index: nextIndex++ };
      emit('content_block_start', {
        type: 'content_block_start', index: open.index,
        content_block: kind === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' }
      });
    }
    emit('content_block_delta', {
      type: 'content_block_delta', index: open.index,
      delta: kind === 'thinking' ? { type: 'thinking_delta', thinking: tok } : { type: 'text_delta', text: tok }
    });
  }

  return {
    start() {
      emit('message_start', {
        type: 'message_start',
        message: {
          id: msgId, type: 'message', role: 'assistant', model, content: [],
          stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }
      });
      emit('ping', { type: 'ping' });
    },
    think(text, s) {
      if (s) sig = s;
      if (text) delta('thinking', text);
    },
    text(t) {
      if (t) delta('text', t);
    },
    tool(tc) {
      const key = tc.index ?? 0;
      let st = tools.get(key);
      if (!st) {
        closeOpen();
        st = { index: nextIndex++, id: tc.id || `toolu_${rand(24)}`, name: tc.name || 'tool', closed: false };
        tools.set(key, st);
        emit('content_block_start', {
          type: 'content_block_start', index: st.index,
          content_block: { type: 'tool_use', id: st.id, name: st.name, input: {} }
        });
      }
      if (tc.args) {
        emit('content_block_delta', {
          type: 'content_block_delta', index: st.index,
          delta: { type: 'input_json_delta', partial_json: tc.args }
        });
      }
    },
    finish(canonical, stats = {}) {
      closeOpen();
      closeTools();
      const prompt = stats.prompt || 0;
      const cached = Math.min(stats.cached || 0, prompt);
      emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: anthropicStopReason(canonical, stats.hasTools || tools.size > 0), stop_sequence: null },
        usage: {
          input_tokens: prompt - cached,
          output_tokens: stats.completion || 0,
          cache_read_input_tokens: cached,
          cache_creation_input_tokens: 0
        }
      });
      emit('message_stop', { type: 'message_stop' });
    },
    error(message) {
      closeOpen();
      closeTools();
      emit('error', { type: 'error', error: { type: 'api_error', message: String(message || 'Upstream stream error') } });
    }
  };
}

function buildAnthropicMessage({ model, think, text, tools, finish, prompt, completion, cached, id, sig }) {
  const content = [];
  const thinking = (think || []).join('');
  if (thinking) {
    content.push({ type: 'thinking', thinking, signature: sig ? FOREIGN_SIG_PREFIX + sig : PLACEHOLDER_SIGNATURE });
  }
  const body = (text || []).join('');
  if (body) content.push({ type: 'text', text: body });
  for (const tc of (tools || [])) {
    content.push({ type: 'tool_use', id: tc.id || `toolu_${rand(24)}`, name: tc.name || 'tool', input: parseArgs(tc.args) });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const p = prompt || 0;
  const c = Math.min(cached || 0, p);
  return {
    id: id || `msg_${Date.now()}_${rand()}`,
    type: 'message', role: 'assistant', model, content,
    stop_reason: anthropicStopReason(finish, Boolean(tools && tools.length)),
    stop_sequence: null,
    usage: { input_tokens: p - c, output_tokens: completion || 0, cache_creation_input_tokens: 0, cache_read_input_tokens: c }
  };
}

// --- OpenAI Chat SSE + object ---
function createChatStream(emit, model) {
  const id = `chatcmpl-${Date.now()}${rand(4)}`;
  const created = Math.floor(Date.now() / 1000);
  const seenTools = new Set();
  const chunk = (choices, usage) => {
    const o = { id, object: 'chat.completion.chunk', created, model, choices };
    if (usage) o.usage = usage;
    emit(null, o);
  };
  return {
    start() {
      chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
    },
    think(t) {
      if (t) chunk([{ index: 0, delta: { reasoning_content: t }, finish_reason: null }]);
    },
    text(t) {
      if (t) chunk([{ index: 0, delta: { content: t }, finish_reason: null }]);
    },
    tool(tc) {
      const idx = tc.index ?? 0;
      if (!seenTools.has(idx)) {
        seenTools.add(idx);
        chunk([{ index: 0, delta: { tool_calls: [{ index: idx, id: tc.id || `call_${rand(24)}`, type: 'function', function: { name: tc.name || 'tool', arguments: tc.args || '' } }] }, finish_reason: null }]);
      } else if (tc.args) {
        chunk([{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: tc.args } }] }, finish_reason: null }]);
      }
    },
    finish(canonical, stats = {}) {
      const completion = stats.completion || 0;
      const prompt = stats.prompt || 0;
      const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
      if (stats.cached) usage.prompt_tokens_details = { cached_tokens: stats.cached };
      if (stats.reasoning > 0) usage.completion_tokens_details = { reasoning_tokens: stats.reasoning };
      chunk([{ index: 0, delta: {}, finish_reason: chatFinish(canonical, stats.hasTools) }], usage);
    },
    error(message) {
      emit(null, { error: { message: String(message || 'Upstream stream error'), type: 'server_error', code: 'upstream_error' } });
    }
  };
}

function buildChatMessage({ model, think, text, tools, finish, prompt, completion, cached, reasoning, id, stats }) {
  const msg = { role: 'assistant', content: (text || []).join('') || null };
  const thinking = (think || []).join('');
  if (thinking) {
    msg.reasoning_content = thinking;
    msg.reasoning = thinking;
  }
  if (tools && tools.length) {
    msg.tool_calls = tools.map(tc => ({
      id: tc.id || `call_${rand(24)}`,
      type: 'function',
      function: { name: tc.name || 'tool', arguments: typeof tc.args === 'string' ? tc.args : stringifyArgs(tc.args) }
    }));
  }
  if (msg.content === null && !msg.tool_calls) msg.content = '';
  const usage = { prompt_tokens: prompt || 0, completion_tokens: completion || 0, total_tokens: (prompt || 0) + (completion || 0) };
  if (cached) usage.prompt_tokens_details = { cached_tokens: cached };
  const r = reasoning ?? stats?.reasoning;
  if (r > 0) usage.completion_tokens_details = { reasoning_tokens: r };
  return {
    id: id || `chatcmpl-${Date.now()}${rand(4)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: msg, finish_reason: chatFinish(finish, tools && tools.length) }],
    usage
  };
}

// --- OpenAI Responses (Codex) SSE + object ---
// Codex CLI builds history & runs tools from `response.output_item.done`, not `response.completed.output`,
// so each item (reasoning / message / function_call) must complete the full added -> delta -> done cycle.
function responsesUsage(prompt, completion, cached, reasoning) {
  return {
    input_tokens: prompt || 0,
    input_tokens_details: { cached_tokens: cached || 0 },
    output_tokens: completion || 0,
    output_tokens_details: { reasoning_tokens: reasoning || 0 },
    total_tokens: (prompt || 0) + (completion || 0)
  };
}

// Models often return args with literal newlines inside JSON strings (invalid) -> try escaping control chars.
function parseArgsLenient(v) {
  const first = parseArgs(v);
  if (typeof v !== 'string' || !('raw' in first) || Object.keys(first).length !== 1) return first;
  try {
    return JSON.parse(v.replace(/[\u0000-\u001f]/g, c => JSON.stringify(c).slice(1, -1)));
  } catch {
    return first;
  }
}

// Build the Codex output item for one tool call based on the original tool type declared in the request.
function responsesToolItem(toolMeta, t, status = 'completed') {
  const meta = toolMeta?.[t.name];
  const ns = meta?.namespace ? { namespace: meta.namespace } : {};
  if (meta?.kind === 'custom') {
    const a = parseArgsLenient(t.args);
    const input = typeof a.input === 'string' ? a.input : (typeof a.raw === 'string' ? a.raw : (t.args || ''));
    return { id: t.itemId || `ctc_${rand(24)}`, type: 'custom_tool_call', status, call_id: t.callId, name: meta.name, ...ns, input: status === 'completed' ? input : '' };
  }
  if (meta?.kind === 'local_shell') {
    const a = parseArgsLenient(t.args);
    const command = Array.isArray(a.command) ? a.command.map(String) : (a.command ? ['bash', '-lc', String(a.command)] : []);
    return {
      id: t.itemId || `lsh_${rand(24)}`, type: 'local_shell_call', status, call_id: t.callId,
      action: { type: 'exec', command, timeout_ms: a.timeout_ms ?? null, working_directory: a.workdir ?? null, env: null, user: null }
    };
  }
  return {
    id: t.itemId || `fc_${rand(24)}`, type: 'function_call', status, name: meta?.name || t.name || 'tool', ...ns,
    arguments: status === 'completed' ? (t.args || '{}') : '', call_id: t.callId
  };
}

function createResponsesStream(emit, model, opts = {}) {
  const toolMeta = opts.toolMeta || null;
  const respId = `resp_${Date.now()}${rand(8)}`;
  const created = Math.floor(Date.now() / 1000);
  let seq = 0;
  let nextOutput = 0;
  const output = [];
  let reasoning = null;       // { id, index, text }
  let message = null;         // { id, index, text }
  const tools = new Map();    // tool index -> { id, callId, index, name, args, done }

  const send = (obj) => emit(obj.type, { ...obj, sequence_number: seq++ });
  const snapshot = (status, extra = {}) => ({
    id: respId, object: 'response', created_at: created, model, status,
    output: output.filter(Boolean), parallel_tool_calls: true, tool_choice: 'auto', tools: [],
    ...extra
  });

  function closeReasoning() {
    if (!reasoning) return;
    const r = reasoning;
    reasoning = null;
    send({ type: 'response.reasoning_summary_text.done', item_id: r.id, output_index: r.index, summary_index: 0, text: r.text });
    send({ type: 'response.reasoning_summary_part.done', item_id: r.id, output_index: r.index, summary_index: 0, part: { type: 'summary_text', text: r.text } });
    const item = { id: r.id, type: 'reasoning', summary: [{ type: 'summary_text', text: r.text }] };
    output[r.index] = item;
    send({ type: 'response.output_item.done', output_index: r.index, item });
  }
  function closeMessage() {
    if (!message) return;
    const m = message;
    message = null;
    const part = { type: 'output_text', text: m.text, annotations: [] };
    send({ type: 'response.output_text.done', item_id: m.id, output_index: m.index, content_index: 0, text: m.text });
    send({ type: 'response.content_part.done', item_id: m.id, output_index: m.index, content_index: 0, part });
    const item = { id: m.id, type: 'message', status: 'completed', role: 'assistant', content: [part] };
    output[m.index] = item;
    send({ type: 'response.output_item.done', output_index: m.index, item });
  }
  function closeTool(t) {
    if (t.done) return;
    t.done = true;
    const item = responsesToolItem(toolMeta, { itemId: t.id, callId: t.callId, name: t.name, args: t.args });
    if (item.type === 'function_call') {
      send({ type: 'response.function_call_arguments.done', item_id: t.id, output_index: t.index, arguments: t.args });
    }
    output[t.index] = item;
    // Codex only runs the tool upon receiving output_item.done with the complete item.
    send({ type: 'response.output_item.done', output_index: t.index, item });
  }
  const closeTools = () => { for (const t of tools.values()) closeTool(t); };

  return {
    start() {
      send({ type: 'response.created', response: snapshot('in_progress') });
      send({ type: 'response.in_progress', response: snapshot('in_progress') });
    },
    think(t) {
      if (!t) return;
      if (!reasoning) {
        closeMessage();
        closeTools();
        reasoning = { id: `rs_${rand(24)}`, index: nextOutput++, text: '' };
        send({ type: 'response.output_item.added', output_index: reasoning.index, item: { id: reasoning.id, type: 'reasoning', summary: [] } });
        send({ type: 'response.reasoning_summary_part.added', item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, part: { type: 'summary_text', text: '' } });
      }
      reasoning.text += t;
      send({ type: 'response.reasoning_summary_text.delta', item_id: reasoning.id, output_index: reasoning.index, summary_index: 0, delta: t });
    },
    text(t) {
      if (!t) return;
      if (!message) {
        closeReasoning();
        closeTools();
        message = { id: `msg_${rand(24)}`, index: nextOutput++, text: '' };
        send({ type: 'response.output_item.added', output_index: message.index, item: { id: message.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
        send({ type: 'response.content_part.added', item_id: message.id, output_index: message.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      message.text += t;
      send({ type: 'response.output_text.delta', item_id: message.id, output_index: message.index, content_index: 0, delta: t });
    },
    tool(tc) {
      const key = tc.index ?? 0;
      let st = tools.get(key);
      if (!st) {
        closeReasoning();
        closeMessage();
        const kind = toolMeta?.[tc.name]?.kind || 'function';
        const prefix = kind === 'custom' ? 'ctc' : kind === 'local_shell' ? 'lsh' : 'fc';
        st = { id: `${prefix}_${rand(24)}`, callId: tc.id || `call_${rand(24)}`, index: nextOutput++, name: tc.name || '', args: '', done: false, kind };
        tools.set(key, st);
        if (kind !== 'local_shell') {
          const added = responsesToolItem(toolMeta, { itemId: st.id, callId: st.callId, name: st.name, args: '' }, 'in_progress');
          send({ type: 'response.output_item.added', output_index: st.index, item: added });
        }
      }
      if (!st.name && tc.name) st.name = tc.name;
      if (tc.args && !st.done) {
        st.args += tc.args;
        if (st.kind === 'function') {
          send({ type: 'response.function_call_arguments.delta', item_id: st.id, output_index: st.index, delta: tc.args });
        }
      }
    },
    finish(canonical, stats = {}) {
      closeReasoning();
      closeMessage();
      const incomplete = canonical === 'length';
      // Codex runs a tool on output_item.done. After a length stop, drop any tool call whose arguments
      // do not parse (upstream arguments are JSON for every tool kind) instead of running it cut off.
      // Its output_item.added then gets no done. A done would run the call, so this is the safe side.
      if (incomplete) {
        for (const t of tools.values()) {
          if (t.done) continue;
          try { JSON.parse(t.args || '{}'); } catch { t.done = true; }
        }
      }
      closeTools();
      send({
        type: 'response.completed',
        response: snapshot(incomplete ? 'incomplete' : 'completed', {
          incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
          usage: responsesUsage(stats.prompt, stats.completion, stats.cached, stats.reasoning)
        })
      });
    },
    error(message, code = 'server_error') {
      send({ type: 'response.failed', response: snapshot('failed', { error: { code: String(code || 'server_error'), message: String(message || 'Upstream stream error') } }) });
    }
  };
}

function buildResponsesMessage({ model, think, text, tools, finish, prompt, completion, cached, reasoning, id, toolMeta, stats }) {
  const output = [];
  const thinking = (think || []).join('');
  if (thinking) output.push({ id: `rs_${rand(24)}`, type: 'reasoning', summary: [{ type: 'summary_text', text: thinking }] });
  const body = (text || []).join('');
  if (body || !(tools && tools.length)) {
    output.push({
      id: `msg_${rand(24)}`, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: body, annotations: [] }]
    });
  }
  const incomplete = finish === 'length';
  for (const tc of (tools || [])) {
    const item = responsesToolItem(toolMeta, {
      callId: tc.id || `call_${rand(24)}`, name: tc.name,
      args: typeof tc.args === 'string' ? tc.args : stringifyArgs(tc.args)
    });
    // Same rule as the stream: a length stop never hands Codex a call with truncated arguments.
    if (incomplete && typeof tc.args === 'string') {
      try { JSON.parse(tc.args || '{}'); } catch { continue; }
    }
    output.push(item);
  }
  const r = reasoning ?? stats?.reasoning;
  return {
    id: id || `resp_${Date.now()}${rand(8)}`, object: 'response', created_at: Math.floor(Date.now() / 1000), model,
    status: incomplete ? 'incomplete' : 'completed',
    incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
    output,
    output_text: body,
    usage: responsesUsage(prompt, completion, cached, r)
  };
}

// --- Vertex generateContent (native) ---
function vertexFinish(canonical) {
  switch (canonical) {
    case 'length': return 'MAX_TOKENS';
    case 'content_filter': return 'SAFETY';
    default: return 'STOP';
  }
}

function vertexUsage(prompt, completion, cached, reasoning) {
  const thoughts = Math.min(reasoning || 0, completion || 0);
  const u = { promptTokenCount: prompt || 0, candidatesTokenCount: (completion || 0) - thoughts };
  if (thoughts) u.thoughtsTokenCount = thoughts;
  u.totalTokenCount = (prompt || 0) + (completion || 0);
  if (cached) u.cachedContentTokenCount = cached;
  return u;
}

function buildVertexMessage({ model, think, text, tools, finish, prompt, completion, cached, reasoning, sig }) {
  const parts = [];
  const thinking = (think || []).join('');
  if (thinking) {
    const tp = { text: thinking, thought: true };
    if (sig) tp.thoughtSignature = sig;
    parts.push(tp);
  }
  const body = (text || []).join('');
  if (body) parts.push({ text: body });
  for (const tc of (tools || [])) {
    const part = { functionCall: { name: tc.name || 'tool', args: parseArgs(tc.args) } };
    const tsig = tc.sig || lookupToolSignature(tc.id);
    if (tsig) part.thoughtSignature = tsig;
    parts.push(part);
  }
  if (!parts.length) parts.push({ text: '' });
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: vertexFinish(finish), index: 0 }],
    usageMetadata: vertexUsage(prompt, completion, cached, reasoning),
    modelVersion: model
  };
}

function createVertexStream(emit, model) {
  const cand = (parts) => emit(null, { candidates: [{ content: { role: 'model', parts }, index: 0 }], modelVersion: model });
  // Tool args arrive from OpenAI/Anthropic as deltas; Vertex needs complete functionCalls -> buffer them, emit at the end.
  const tools = new Map();
  return {
    start() {},
    think(t, sig) {
      if (t) {
        const p = { text: t, thought: true };
        if (sig) p.thoughtSignature = sig;
        cand([p]);
      }
    },
    text(t) { if (t) cand([{ text: t }]); },
    tool(tc) {
      const key = tc.index ?? 0;
      if (!tools.has(key)) tools.set(key, { id: tc.id || null, name: tc.name || '', args: '', sig: null });
      const st = tools.get(key);
      if (!st.id && tc.id) st.id = tc.id;
      if (!st.sig && tc.sig) st.sig = tc.sig;
      if (!st.name && tc.name) st.name = tc.name;
      if (tc.args) st.args += tc.args;
    },
    finish(canonical, stats = {}) {
      const parts = [...tools.values()]
        .filter(t => t.name)
        .map(t => {
          const part = { functionCall: { name: t.name, args: parseArgs(t.args || '{}') } };
          const tsig = t.sig || lookupToolSignature(t.id);
          if (tsig) part.thoughtSignature = tsig;
          return part;
        });
      emit(null, {
        candidates: [{ content: { role: 'model', parts }, finishReason: vertexFinish(canonical), index: 0 }],
        usageMetadata: vertexUsage(stats.prompt, stats.completion, stats.cached, stats.reasoning),
        modelVersion: model
      });
    },
    error(message) {
      emit(null, { error: { code: 500, message: String(message || 'Upstream stream error'), status: 'INTERNAL' } });
    }
  };
}

export {
  canonFinish, chatFinish, anthropicStopReason,
  smartReasoning, smartText, smartToolCalls, smartUsage, smartFinish,
  firstChoice, smartDelta, sanitizeJsonSchema, toGeminiSchema, splitParts,
  budgetToEffort, effortToBudget, clampBudget, parseArgs, stringifyArgs,
  anthropicToIR, chatToIR, responsesToIR, vertexToIR, parseToIR,
  healToolPairs, healAnthropicPayload, rememberToolSignature, lookupToolSignature, estimateTokens, irToChatBody, irToAnthropicBody, irToVertexBody, emitUpstreamBody,
  normalizeUpstream, createUpstreamNormalizer, createCollector,
  createThinkTagSplitter, splitThinkTags,
  createAnthropicStream, buildAnthropicMessage,
  createChatStream, buildChatMessage,
  createResponsesStream, buildResponsesMessage,
  vertexFinish, createVertexStream, buildVertexMessage,
  isAntigravityModel
};
