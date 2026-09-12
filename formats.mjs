// ============================================================
// formats.mjs — LLM Switcher protocol adapters (zero dependency)
//
// Luồng convert 2 chiều qua IR (Intermediate Representation):
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

function mapStopReason(finishReason) {
  const r = String(finishReason || '').toLowerCase();
  switch (r) {
    case 'tool_calls':
    case 'tool_call':
    case 'function_call':
    case 'function_calls':
      return 'tool_use';
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
      return 'max_tokens';
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
    case 'content_filter':
    case 'safety':
    case 'recitation':
    case 'language':
    case 'blocklist':
    case 'prohibited_content':
    case 'spii':
    case 'malformed_function_call':
    case 'finish_reason_unspecified':
    default:
      return 'end_turn';
  }
}

// Canonical finish dùng nội bộ cho event stream.
function canonFinish(raw) {
  const r = String(raw || '').toLowerCase();
  if (!r) return null;
  if (['stop', 'end_turn', 'stop_sequence', 'eos', 'end'].includes(r)) return 'stop';
  if (['length', 'max_tokens', 'max_output_tokens'].includes(r)) return 'length';
  if (['tool_calls', 'tool_call', 'function_call', 'function_calls', 'tool_use'].includes(r)) return 'tool_calls';
  if (['content_filter', 'safety', 'recitation', 'language', 'blocklist', 'prohibited_content', 'spii'].includes(r)) return 'content_filter';
  return 'stop';
}

function chatFinish(canonical, hasTools) {
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
    if (p.thought === true) {
      if (t) out.thinking.push(t);
      if (!out.signature && typeof p.thoughtSignature === 'string' && p.thoughtSignature) {
        out.signature = p.thoughtSignature;
      }
    } else if (t) {
      out.text.push(t);
    }
    const fc = p.functionCall || p.function_call;
    if (fc && typeof fc === 'object') {
      const args = fc.args !== undefined ? fc.args : fc.arguments;
      out.tools.push({
        index: out.tools.length,
        id: p.id || fc.id || null,
        name: fc.name || '',
        args: typeof args === 'string' ? args : JSON.stringify(args ?? {})
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
    if (sp.thinking.length) texts.push(sp.thinking.join(''));
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
    if (Array.isArray(c)) {
      const sp = splitParts(c);
      const direct = c.filter(x => typeof x === 'string');
      return [...sp.text, ...direct].join('\n');
    }
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
    if (!name) return null;
    const rawArgs = fn.arguments ?? fn.args ?? tc.args ?? tc.arguments ?? tc.input ?? {};
    return {
      index: (typeof tc.index === 'number' ? tc.index : idx),
      id: tc.id || fn.id || null,
      name,
      args: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {})
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
  return {
    prompt: num(o.prompt_tokens, o.input_tokens, o.promptTokenCount, o.inputTokens),
    completion: num(o.completion_tokens, o.output_tokens, o.candidatesTokenCount, o.outputTokens),
    cached: num(det.cached_tokens, o.cached_tokens, o.cachedContentTokenCount, o.cached_content_token_count, o.cache_read_input_tokens)
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

function smartChoice(root) {
  if (!root || typeof root !== 'object') return null;
  for (const k of ['choices', 'candidates', 'outputs', 'results', 'messages']) {
    if (Array.isArray(root[k]) && root[k][0] && typeof root[k][0] === 'object') return root[k][0];
  }
  return root;
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

function sanitizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeJsonSchema);
  const clean = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === 'cache_control') continue;
    if (k === 'format' && ['uri', 'uri-reference'].includes(v)) continue;
    clean[k] = sanitizeJsonSchema(v);
  }
  if (!clean.type && clean.properties) {
    clean.type = 'object';
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

// Anthropic Messages API -> IR (logic port từ transformAnthropicToOpenAI cũ).
function anthropicToIR(payload) {
  const ir = baseIR();
  ir.model = payload.model || '';
  ir.stream = payload.stream !== false;

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
            parts.push({ type: 'text', text: part.text || '' });
          } else if (part.type === 'image' && part.source?.type === 'base64') {
            const mimeType = part.source.media_type || 'image/jpeg';
            parts.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${part.source.data}` } });
          } else if (part.type === 'tool_use') {
            toolCalls.push({ id: part.id, name: part.name, args: part.input ?? {} });
          } else if (part.type === 'tool_result') {
            let resultText = '';
            if (typeof part.content === 'string') resultText = part.content;
            else if (Array.isArray(part.content)) {
              resultText = part.content.map(c => (typeof c === 'string' ? c : c.text || JSON.stringify(c))).join('\n');
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
        // Fallback cho payload bị các tool tiền xử lý nén/biến dạng thành object
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
  }

  if (typeof payload.max_tokens === 'number') ir.params.maxTokens = payload.max_tokens;
  if (typeof payload.temperature === 'number') ir.params.temperature = payload.temperature;
  if (typeof payload.top_p === 'number') ir.params.topP = payload.top_p;
  if (typeof payload.top_k === 'number') ir.params.topK = payload.top_k;
  if (Array.isArray(payload.stop_sequences) && payload.stop_sequences.length) ir.params.stop = payload.stop_sequences;

  if (payload.thinking && payload.thinking.type !== 'disabled') ir.thinking = { ...payload.thinking };
  return ir;
}

// OpenAI Chat Completions -> IR (chuẩn hoá nhẹ).
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
  else if (tc?.type === 'allowed_tools') ir.toolChoice = 'required';

  ir.params.maxTokens = payload.max_tokens ?? payload.max_completion_tokens ?? null;
  if (typeof payload.temperature === 'number') ir.params.temperature = payload.temperature;
  if (typeof payload.top_p === 'number') ir.params.topP = payload.top_p;
  if (typeof payload.presence_penalty === 'number') ir.params.presencePenalty = payload.presence_penalty;
  if (typeof payload.frequency_penalty === 'number') ir.params.frequencyPenalty = payload.frequency_penalty;
  if (payload.stop !== undefined) ir.params.stop = Array.isArray(payload.stop) ? payload.stop : [payload.stop];

  if (payload.thinking && typeof payload.thinking === 'object' && payload.thinking.type !== 'disabled') {
    ir.thinking = { ...payload.thinking };
  } else if (typeof payload.reasoning_effort === 'string') {
    ir.thinking = { type: 'enabled', budget: effortToBudget(payload.reasoning_effort), effort: payload.reasoning_effort };
  } else if (payload.reasoning && typeof payload.reasoning === 'object') {
    if (payload.reasoning.exclude === true) ir.thinking = null;
    else if (payload.reasoning.enabled !== false || payload.reasoning.effort || payload.reasoning.max_tokens) {
      ir.thinking = {
        type: 'enabled',
        budget: payload.reasoning.max_tokens ? clampBudget(payload.reasoning.max_tokens) : effortToBudget(payload.reasoning.effort),
        effort: payload.reasoning.effort
      };
    }
  }
  return ir;
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

  const input = payload.input;
  if (typeof input === 'string' && input) {
    ir.messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') { pushText('user', item); continue; }
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'message') {
        const role = item.role === 'assistant' ? 'assistant' : 'user';
        const c = item.content;
        if (typeof c === 'string') pushText(role, c);
        else if (Array.isArray(c)) {
          pushText(role, c.map(p => (typeof p === 'string' ? p : p.text || '')).filter(Boolean).join('\n'));
        }
      } else if (item.type === 'function_call') {
        ir.messages.push({
          role: 'assistant',
          toolCalls: [{ id: item.call_id || item.id || null, name: item.name || '', args: parseArgs(item.arguments) }]
        });
      } else if (item.type === 'function_call_output') {
        const out = item.output;
        ir.messages.push({
          role: 'tool', toolCallId: item.call_id || item.id,
          content: typeof out === 'string' ? out : JSON.stringify(out ?? '')
        });
      }
    }
  }

  if (Array.isArray(payload.tools) && payload.tools.length) {
    ir.tools = payload.tools
      .filter(t => t.type === 'function' && t.name)
      .map(t => ({ name: t.name, description: t.description || '', parameters: sanitizeJsonSchema(t.parameters || {}) }));
  }

  const tc = payload.tool_choice;
  if (typeof tc === 'string') ir.toolChoice = tc;
  else if (tc?.type === 'function' && tc.name) ir.toolChoice = { name: tc.name };
  else if (tc && typeof tc === 'object') ir.toolChoice = 'required';

  if (typeof payload.max_output_tokens === 'number') ir.params.maxTokens = payload.max_output_tokens;
  if (typeof payload.temperature === 'number') ir.params.temperature = payload.temperature;
  if (typeof payload.top_p === 'number') ir.params.topP = payload.top_p;

  if (payload.reasoning && typeof payload.reasoning === 'object') {
    ir.thinking = {
      type: 'enabled',
      budget: payload.reasoning.max_tokens ? clampBudget(payload.reasoning.max_tokens) : effortToBudget(payload.reasoning.effort),
      effort: payload.reasoning.effort
    };
  }
  return ir;
}

// Vertex generateContent -> IR.
function vertexToIR(payload) {
  const ir = baseIR();
  ir.model = payload.model || '';
  ir.stream = false; // proxy override theo endpoint :streamGenerateContent

  const sys = payload.systemInstruction?.parts;
  if (Array.isArray(sys)) {
    ir.system = sys.map(p => p.text || '').filter(Boolean).join('\n\n');
  } else if (typeof payload.system_instruction === 'string') {
    ir.system = payload.system_instruction;
  }

  if (Array.isArray(payload.contents)) {
    for (const c of payload.contents) {
      const parts = Array.isArray(c.parts) ? c.parts : [];
      const texts = [];
      const toolCalls = [];
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text) texts.push(p.text);
        if (p.functionCall) {
          toolCalls.push({ id: null, name: p.functionCall.name || '', args: p.functionCall.args ?? {} });
        }
        if (p.functionResponse) {
          const fr = p.functionResponse;
          ir.messages.push({
            role: 'tool', toolCallId: fr.name || null, name: fr.name || null,
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
        // đã push functionResponse ở trên
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
  if (Array.isArray(gc.stopSequences)) ir.params.stop = gc.stopSequences;
  const th = gc.thinkingConfig || gc.thinking_config;
  if (th && typeof th === 'object') {
    if (th.thinkingBudget) ir.thinking = { type: 'enabled', budget: clampBudget(th.thinkingBudget) };
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
  const m = String(model || '').toLowerCase();
  return m.includes('thinking') || m.includes('reasoning')
    || m.includes('opus-4-6') || m.includes('opus-4-7') || m.includes('opus-5');
}

// IR -> OpenAI Chat Completions body.
function irToChatBody(ir, model) {
  const messages = [];
  const modelIsThinking = hasNativeReasoning(model);
  const wantsThinking = Boolean(
    (ir.thinking && ir.thinking.type !== 'disabled') ||
    (modelIsThinking && (!ir.thinking || ir.thinking.type !== 'disabled'))
  );

  let systemText = ir.system || '';
  if (wantsThinking && !hasNativeReasoning(model) && !String(model).toLowerCase().includes('gemini')) {
    const thinkGuide = 'You must provide your internal reasoning and step-by-step thinking inside <think> and </think> tags before your final response.';
    systemText = systemText ? `${thinkGuide}\n\n${systemText}` : thinkGuide;
  }
  if (systemText.trim()) messages.push({ role: 'system', content: systemText });

  // Thu thập tất cả ID tool_calls được assistant khai báo trước đó
  const declaredToolCallIds = new Set();
  for (const m of ir.messages) {
    if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        if (tc.id) declaredToolCallIds.add(tc.id);
      }
    }
  }

  for (const m of ir.messages) {
    if (m.role === 'tool') {
      const toolId = m.toolCallId;
      // Chống đụng độ với các tool cắt token (RTK, Headroom, Ponytail):
      // Nếu assistant turn chứa tool_call bị cắt mất, OpenAI Chat sẽ báo lỗi 400
      // "messages with role 'tool' must be a response to a preceding message with 'tool_calls'".
      // Cơ chế tự chữa lành: chuyển thành user text message để upstream không bị lỗi.
      if (toolId && declaredToolCallIds.has(toolId)) {
        messages.push({ role: 'tool', tool_call_id: toolId, content: m.content ?? '' });
      } else {
        messages.push({ role: 'user', content: `[Tool Output${toolId ? ' (' + toolId + ')' : ''}]: ${m.content ?? ''}` });
      }
      continue;
    }
    const out = { role: m.role === 'assistant' ? 'assistant' : 'user' };
    if (m.content !== undefined) out.content = m.content;
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      out.tool_calls = m.toolCalls.map(tc => ({
        id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'function',
        function: { name: tc.name, arguments: stringifyArgs(tc.args) }
      }));
      if (out.content === undefined) out.content = null;
    }
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
  if (typeof ir.params.maxTokens === 'number') body.max_tokens = ir.params.maxTokens;
  if (typeof ir.params.temperature === 'number') body.temperature = ir.params.temperature;
  if (typeof ir.params.topP === 'number') body.top_p = ir.params.topP;
  if (typeof ir.params.presencePenalty === 'number') body.presence_penalty = ir.params.presencePenalty;
  if (typeof ir.params.frequencyPenalty === 'number') body.frequency_penalty = ir.params.frequencyPenalty;
  if (ir.params.stop.length) body.stop = ir.params.stop;

  if (wantsThinking) {
    if (ir.thinking?.type === 'adaptive') {
      body.thinking = { type: 'adaptive' };
      body.reasoning_effort = 'high';
    } else {
      // Phục hồi thinking: Nếu một tool nén bên ngoài (RTK/Headroom) xóa mất object thinking,
      // nhưng model đích là reasoning model, gateway tự động kích hoạt lại thinking với budget an toàn.
      const rawBudget = ir.thinking?.budget ?? (ir.thinking?.effort ? effortToBudget(ir.thinking.effort) : 2048);
      const safeBudget = clampBudget(rawBudget);
      body.thinking = { type: 'enabled', budget_tokens: safeBudget };
      body.reasoning_effort = ir.thinking?.effort || budgetToEffort(safeBudget);
    }
  }
  return body;
}

function dataUrlToAnthropicImage(url) {
  const m = String(url || '').match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return null;
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

// IR -> Anthropic Messages body.
function irToAnthropicBody(ir, model) {
  const messages = [];

  // Thu thập tất cả ID tool_use được assistant khai báo trước đó
  const declaredToolUseIds = new Set();
  for (const m of ir.messages) {
    if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        if (tc.id) declaredToolUseIds.add(tc.id);
      }
    }
  }

  for (const m of ir.messages) {
    if (m.role === 'tool') {
      const toolId = m.toolCallId;
      // Chống đụng độ với các tool cắt/nén token (RTK, Headroom, Ponytail):
      // Nếu một tool ngoài vô tình xóa mất turn assistant chứa tool_use,
      // Anthropic native sẽ lập tức báo lỗi 400 "tool_use_id does not correspond to any tool_use".
      // Cơ chế tự chữa lành: chuyển thành text block giữ nguyên ngữ cảnh mà không làm gãy API.
      if (toolId && declaredToolUseIds.has(toolId)) {
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolId, content: m.content ?? '' }]
        });
      } else {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: `[Tool Result${toolId ? ' (' + toolId + ')' : ''}]: ${m.content ?? ''}` }]
        });
      }
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      const pushTextBlocks = (c) => {
        if (typeof c === 'string' && c) blocks.push({ type: 'text', text: c });
        else if (Array.isArray(c)) {
          for (const p of c) {
            if (p.type === 'text' && p.text) blocks.push({ type: 'text', text: p.text });
            else if (p.type === 'image_url') {
              const img = dataUrlToAnthropicImage(p.image_url?.url);
              if (img) blocks.push(img);
            }
          }
        }
      };
      pushTextBlocks(m.content);
      for (const tc of (m.toolCalls || [])) {
        blocks.push({ type: 'tool_use', id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: tc.name, input: parseArgs(tc.args) });
      }
      if (blocks.length) messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    // user
    if (typeof m.content === 'string') {
      messages.push({ role: 'user', content: m.content });
    } else if (Array.isArray(m.content)) {
      const blocks = [];
      for (const p of m.content) {
        if (p.type === 'text') blocks.push({ type: 'text', text: p.text || '' });
        else if (p.type === 'image_url') {
          const img = dataUrlToAnthropicImage(p.image_url?.url);
          if (img) blocks.push(img);
        }
      }
      if (blocks.length) messages.push({ role: 'user', content: blocks });
    }
  }

  // Chuẩn hoá tin nhắn cho Anthropic API:
  // 1. Gộp các tin nhắn cùng role liên tiếp (consecutive user-user hoặc assistant-assistant).
  // 2. Đảm bảo tin nhắn đầu tiên luôn là 'user'.
  // 3. Đảm bảo có ít nhất 1 tin nhắn.
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
  if (typeof ir.params.temperature === 'number') body.temperature = ir.params.temperature;
  if (typeof ir.params.topP === 'number') body.top_p = ir.params.topP;
  if (typeof ir.params.topK === 'number') body.top_k = ir.params.topK;
  if (ir.params.stop.length) body.stop_sequences = ir.params.stop;
  if (ir.thinking && ir.thinking.type !== 'disabled') {
    if (ir.thinking.type === 'adaptive') body.thinking = { type: 'adaptive' };
    else body.thinking = { type: 'enabled', budget_tokens: clampBudget(ir.thinking.budget ?? (ir.thinking.effort ? effortToBudget(ir.thinking.effort) : 4096)) };
  }
  return body;
}

function dataUrlToInlineData(url) {
  const m = String(url || '').match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return null;
  return { inlineData: { mimeType: m[1], data: m[2] } };
}

// IR -> Vertex generateContent body.
function irToVertexBody(ir) {
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

  for (const m of ir.messages) {
    if (m.role === 'tool') {
      let resp = {};
      try {
        const parsed = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
        resp = (parsed && typeof parsed === 'object') ? parsed : { result: m.content ?? '' };
      } catch { resp = { result: m.content ?? '' }; }
      contents.push({ role: 'function', parts: [{ functionResponse: { name: m.name || m.toolCallId || 'tool', response: resp } }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = textPartsOf(m.content);
      for (const tc of (m.toolCalls || [])) {
        parts.push({ functionCall: { name: tc.name, args: parseArgs(tc.args) } });
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }
    const parts = textPartsOf(m.content);
    if (parts.length) contents.push({ role: 'user', parts });
  }

  const body = { contents };
  if (ir.system && ir.system.trim()) {
    body.systemInstruction = { parts: [{ text: ir.system }] };
  }
  if (ir.tools.length) {
    body.tools = [{
      functionDeclarations: ir.tools.map(t => ({
        name: t.name, description: t.description || '',
        parameters: sanitizeJsonSchema(t.parameters || {})
      }))
    }];
  }
  const gc = {};
  if (typeof ir.params.temperature === 'number') gc.temperature = ir.params.temperature;
  if (typeof ir.params.topP === 'number') gc.topP = ir.params.topP;
  if (typeof ir.params.maxTokens === 'number') gc.maxOutputTokens = ir.params.maxTokens;
  if (ir.params.stop.length) gc.stopSequences = ir.params.stop;
  if (ir.thinking && ir.thinking.type === 'enabled') {
    gc.thinkingConfig = { thinkingBudget: clampBudget(ir.thinking.budget ?? (ir.thinking.effort ? effortToBudget(ir.thinking.effort) : 2048)) };
  }
  if (Object.keys(gc).length) body.generationConfig = gc;
  return body;
}

function emitUpstreamBody(outFormat, ir, model) {
  switch (outFormat) {
    case 'anthropic': return irToAnthropicBody(ir, model);
    case 'vertex': return irToVertexBody(ir);
    case 'openai-chat':
    default: return irToChatBody(ir, model);
  }
}

// ---------------- upstream event normalization ----------------
// Mọi response upstream (mọi format, stream hay JSON) -> events chuẩn:
// { think:[{text,sig}], text:[str], tools:[{index,id,name,args}],
//   finish: 'stop'|'length'|'tool_calls'|'content_filter'|null,
//   usage:{prompt,completion}, sig }

function chunkToolFull(tc, idx) {
  return { index: (typeof tc.index === 'number' ? tc.index : idx), id: tc.id || null, name: tc.name || null, args: tc.args || '' };
}

function normalizeUpstream(parsed, outFormat) {
  const ev = { think: [], text: [], tools: [], finish: null, usage: { prompt: 0, completion: 0 }, sig: null };
  if (!parsed || typeof parsed !== 'object') return ev;

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
      ev.usage.prompt = smartUsage(parsed.message?.usage).prompt;
    } else if (t === 'message_delta') {
      if (parsed.delta?.stop_reason) ev.finish = canonFinish(parsed.delta.stop_reason);
      ev.usage.completion = smartUsage(parsed.usage).completion;
    } else if (t === 'message' && Array.isArray(parsed.content)) {
      // non-stream Anthropic message
      for (const b of parsed.content) {
        if (b.type === 'thinking' && b.thinking) ev.think.push({ text: b.thinking, sig: b.signature || null });
        else if (b.type === 'text' && b.text) ev.text.push(b.text);
        else if (b.type === 'tool_use') ev.tools.push(chunkToolFull({ index: ev.tools.length, id: b.id, name: b.name, args: stringifyArgs(b.input) }));
      }
      if (parsed.stop_reason) ev.finish = canonFinish(parsed.stop_reason);
      const u = smartUsage(parsed.usage);
      ev.usage = { prompt: u.prompt, completion: u.completion };
    }
    return ev;
  }

  // openai-chat | vertex (cả SSE chunk lẫn JSON full: cùng 1 shape)
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
  const u = smartUsage(parsed.usage ?? parsed.usageMetadata);
  ev.usage = { prompt: u.prompt, completion: u.completion };
  return ev;
}

// Gom events cho non-stream (cũng là accumulator usage cho stream).
function createCollector() {
  const C = {
    think: [], text: [], tools: new Map(), finish: null,
    prompt: 0, sum: 0, last: 0, sig: null, counted: 0,
    add(ev) {
      for (const t of (ev.think || [])) {
        C.think.push(t.text);
        if (t.sig && !C.sig) C.sig = t.sig;
      }
      if (ev.sig && !C.sig) C.sig = ev.sig;
      for (const t of (ev.text || [])) C.text.push(t);
      for (const tc of (ev.tools || [])) {
        const idx = tc.index ?? 0;
        if (!C.tools.has(idx)) C.tools.set(idx, { index: idx, id: tc.id, name: tc.name, args: '' });
        const s = C.tools.get(idx);
        if (!s.id && tc.id) s.id = tc.id;
        if ((!s.name || s.name === 'tool') && tc.name) s.name = tc.name;
        if (tc.args) s.args += tc.args;
      }
      if (ev.finish) C.finish = ev.finish;
      if (ev.usage) {
        if (ev.usage.prompt > C.prompt) C.prompt = ev.usage.prompt;
        C.sum += ev.usage.completion;
        C.last = ev.usage.completion;
      }
      C.counted++;
    },
    completion() {
      const up = Math.max(C.sum, C.last);
      return up > 0 ? up : C.counted;
    }
  };
  return C;
}

// ---------------- client renderers ----------------

function rand(n = 6) {
  return Math.random().toString(36).slice(2, 2 + n);
}

// --- Anthropic SSE + message (port logic cũ, giữ nguyên semantics) ---
function createAnthropicStream(emit, model) {
  const msgId = `msg_${Date.now()}_${rand()}`;
  const S = {
    block: 0, thinkStarted: false, thinkStopped: false,
    textStarted: false, textStopped: false,
    tools: new Map(), carry: '', inTag: false, sig: null
  };
  function stopThink() {
    if (S.thinkStarted && !S.thinkStopped) {
      emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: S.sig || 'reasoning-sig' } });
      emit('content_block_stop', { type: 'content_block_stop', index: 0 });
      S.thinkStopped = true;
    }
  }
  function stopText() {
    if (S.textStarted && !S.textStopped) {
      emit('content_block_stop', { type: 'content_block_stop', index: S.block });
      S.textStopped = true;
      S.block++;
    }
  }
  function ensureThink() {
    if (S.thinkStarted) return true;
    if (S.textStarted) return false;
    S.thinkStarted = true;
    emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    S.block = 1;
    return true;
  }
  function ensureText() {
    stopThink();
    if (!S.textStarted) {
      S.textStarted = true;
      if (S.block < (S.thinkStarted ? 1 : 0)) S.block = S.thinkStarted ? 1 : 0;
      emit('content_block_start', { type: 'content_block_start', index: S.block, content_block: { type: 'text', text: '' } });
    }
  }
  function pushThinkToken(tok) {
    if (ensureThink()) {
      emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: tok } });
    } else {
      ensureText();
      emit('content_block_delta', { type: 'content_block_delta', index: S.block, delta: { type: 'text_delta', text: tok } });
    }
  }
  function pushTextToken(tok) {
    ensureText();
    emit('content_block_delta', { type: 'content_block_delta', index: S.block, delta: { type: 'text_delta', text: tok } });
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
    think(text, sig) {
      if (sig && !S.sig) S.sig = sig;
      if (text) pushThinkToken(text);
    },
    text(raw) {
      if (!raw) return;
      let buf = S.carry + raw;
      S.carry = '';
      const lastOpen = buf.lastIndexOf('<');
      if (lastOpen !== -1 && !buf.slice(lastOpen).includes('>')) {
        const tail = buf.slice(lastOpen);
        if (/^<\/?think(?:ing)?$/i.test(tail) || tail === '<' || tail === '</') {
          S.carry = tail;
          buf = buf.slice(0, lastOpen);
        }
      }
      if (!buf) return;
      for (const tok of buf.split(/(<\/?think(?:ing)?>)/i)) {
        if (!tok) continue;
        if (/^<think(?:ing)?>$/i.test(tok)) { S.inTag = true; ensureThink(); continue; }
        if (/^<\/(?:think(?:ing)?)>$/i.test(tok)) { S.inTag = false; stopThink(); continue; }
        if (S.inTag) pushThinkToken(tok);
        else pushTextToken(tok);
      }
    },
    tool(tc) {
      const idx = tc.index ?? 0;
      stopThink();
      stopText();
      if (!S.tools.has(idx)) {
        const bIdx = S.block++;
        S.tools.set(idx, { bIdx, id: tc.id || `call_${Date.now()}_${idx}`, name: tc.name || 'tool', args: '' });
        emit('content_block_start', {
          type: 'content_block_start', index: bIdx,
          content_block: { type: 'tool_use', id: S.tools.get(idx).id, name: S.tools.get(idx).name, input: {} }
        });
      }
      const st = S.tools.get(idx);
      if (!st.id && tc.id) st.id = tc.id;
      if ((!st.name || st.name === 'tool') && tc.name) st.name = tc.name;
      if (tc.args) {
        st.args += tc.args;
        emit('content_block_delta', {
          type: 'content_block_delta', index: st.bIdx,
          delta: { type: 'input_json_delta', partial_json: tc.args }
        });
      }
    },
    finish(canonical, stats = {}) {
      if (S.carry) {
        const tail = S.carry;
        S.carry = '';
        if (/^<\/?think(?:ing)?>$/i.test(tail)) {
          if (/^<think(?:ing)?>$/i.test(tail)) S.inTag = true;
          else { S.inTag = false; stopThink(); }
        } else if (S.inTag) pushThinkToken(tail);
        else pushTextToken(tail);
      }
      stopThink();
      stopText();
      for (const [, st] of S.tools) {
        emit('content_block_stop', { type: 'content_block_stop', index: st.bIdx });
      }
      const hasTools = stats.hasTools || S.tools.size > 0;
      const stopReason = hasTools ? 'tool_use' : mapStopReason(canonicalToOpenAI(canonical));
      emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: stats.completion || 0 }
      });
      emit('message_stop', { type: 'message_stop' });
    }
  };
}

function canonicalToOpenAI(canonical) {
  switch (canonical) {
    case 'length': return 'length';
    case 'tool_calls': return 'tool_calls';
    case 'content_filter': return 'content_filter';
    default: return 'stop';
  }
}

function buildAnthropicMessage({ model, think, text, tools, finish, prompt, completion, id, sig }) {
  const content = [];
  const thinking = (think || []).join('');
  if (thinking) {
    content.push({ type: 'thinking', thinking, signature: sig || 'reasoning-sig' });
  }
  const body = (text || []).join('');
  // Tách <think> dự phòng cho non-stream khi upstream giấu reasoning trong content.
  let cleanBody = body;
  if (!thinking && body) {
    const m = body.match(/<think(?:ing)?>([\s\S]*?)<\/(?:think(?:ing)?)>/i);
    if (m) {
      content.unshift({ type: 'thinking', thinking: m[1].trim(), signature: sig || 'reasoning-sig' });
      cleanBody = (body.slice(0, m.index) + body.slice(m.index + m[0].length)).trim();
    }
  }
  if (cleanBody) content.push({ type: 'text', text: cleanBody });
  for (const tc of (tools || [])) {
    content.push({ type: 'tool_use', id: tc.id || `call_${Date.now()}_${tc.index ?? 0}`, name: tc.name || 'tool', input: parseArgs(tc.args) });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: id || `msg_${Date.now()}`,
    type: 'message', role: 'assistant', model, content,
    stop_reason: (tools && tools.length) ? 'tool_use' : mapStopReason(canonicalToOpenAI(finish)),
    stop_sequence: null,
    usage: { input_tokens: prompt || 0, output_tokens: completion || 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
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
      chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
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
        chunk([{ index: 0, delta: { tool_calls: [{ index: idx, id: tc.id || `call_${Date.now()}_${idx}`, type: 'function', function: { name: tc.name || 'tool', arguments: tc.args || '' } }] }, finish_reason: null }]);
      } else if (tc.args) {
        chunk([{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: tc.args } }] }, finish_reason: null }]);
      }
    },
    finish(canonical, stats = {}) {
      const completion = stats.completion || 0;
      const prompt = stats.prompt || 0;
      chunk(
        [{ index: 0, delta: {}, finish_reason: chatFinish(canonical, stats.hasTools) }],
        { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
      );
    }
  };
}

function buildChatMessage({ model, think, text, tools, finish, prompt, completion, id }) {
  const msg = { role: 'assistant', content: (text || []).join('') || null };
  const thinking = (think || []).join('');
  if (thinking) {
    msg.reasoning_content = thinking;
    msg.reasoning = thinking;
  }
  if (tools && tools.length) {
    msg.tool_calls = tools.map((tc, i) => ({
      id: tc.id || `call_${Date.now()}_${tc.index ?? i}`,
      type: 'function',
      function: { name: tc.name || 'tool', arguments: typeof tc.args === 'string' ? tc.args : stringifyArgs(tc.args) }
    }));
    if (msg.content === null) delete msg.content;
  }
  if (msg.content === null && !msg.tool_calls) msg.content = '';
  return {
    id: id || `chatcmpl-${Date.now()}${rand(4)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: msg, finish_reason: chatFinish(finish, tools && tools.length) }],
    usage: { prompt_tokens: prompt || 0, completion_tokens: completion || 0, total_tokens: (prompt || 0) + (completion || 0) }
  };
}

// --- OpenAI Responses (Codex) SSE + object ---
function createResponsesStream(emit, model) {
  const respId = `resp_${Date.now()}${rand(4)}`;
  const msgItem = `msg_${rand(8)}`;
  const created = Math.floor(Date.now() / 1000);
  const tools = new Map();
  let thinkBuf = '';
  let textLen = 0;
  return {
    start() {
      emit(null, { type: 'response.created', sequence_number: 0, response: { id: respId, object: 'response', created_at: created, model, status: 'in_progress', output: [] } });
      emit(null, { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { id: msgItem, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    },
    think(t) { if (t) thinkBuf += t; },
    text(t) {
      if (!t) return;
      textLen += t.length;
      emit(null, { type: 'response.output_text.delta', sequence_number: 2, item_id: msgItem, output_index: 0, content_index: 0, delta: t });
    },
    tool(tc) {
      const idx = tc.index ?? 0;
      if (!tools.has(idx)) {
        const callId = tc.id || `fc_${rand(12)}`;
        tools.set(idx, { callId, name: tc.name || 'tool', args: '' });
        emit(null, {
          type: 'response.output_item.added', sequence_number: 3,
          output_index: tools.size,
          item: { id: callId, type: 'function_call', status: 'in_progress', name: tools.get(idx).name, arguments: '', call_id: callId }
        });
      }
      const st = tools.get(idx);
      if ((!st.name || st.name === 'tool') && tc.name) st.name = tc.name;
      if (tc.args) {
        st.args += tc.args;
        emit(null, { type: 'response.function_call_arguments.delta', sequence_number: 4, item_id: st.callId, output_index: [...tools.keys()].indexOf(idx) + 1, delta: tc.args });
      }
    },
    finish(canonical, stats = {}) {
      const completion = stats.completion || 0;
      const prompt = stats.prompt || 0;
      const output = [];
      if (thinkBuf) output.push({ id: `rs_${rand(8)}`, type: 'reasoning', summary: [{ type: 'summary_text', text: thinkBuf }] });
      output.push({
        id: msgItem, type: 'message', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: '', annotations: [] }]
      });
      for (const [, st] of tools) {
        output.push({ id: st.callId, type: 'function_call', status: 'completed', name: st.name, arguments: st.args, call_id: st.callId });
      }
      const total = prompt + completion;
      emit(null, {
        type: 'response.completed', sequence_number: 5,
        response: {
          id: respId, object: 'response', created_at: created, model,
          status: canonical === 'length' ? 'incomplete' : 'completed',
          output,
          usage: { input_tokens: prompt, output_tokens: completion, total_tokens: total }
        }
      });
    }
  };
}

function buildResponsesMessage({ model, think, text, tools, finish, prompt, completion, id }) {
  const respId = id || `resp_${Date.now()}${rand(4)}`;
  const created = Math.floor(Date.now() / 1000);
  const output = [];
  const thinking = (think || []).join('');
  if (thinking) output.push({ id: `rs_${rand(8)}`, type: 'reasoning', summary: [{ type: 'summary_text', text: thinking }] });
  output.push({
    id: `msg_${rand(8)}`, type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text: (text || []).join(''), annotations: [] }]
  });
  for (const tc of (tools || [])) {
    output.push({
      id: tc.id || `fc_${rand(12)}`, type: 'function_call', status: 'completed',
      name: tc.name || 'tool', arguments: typeof tc.args === 'string' ? tc.args : stringifyArgs(tc.args),
      call_id: tc.id || `fc_${rand(12)}`
    });
  }
  const total = (prompt || 0) + (completion || 0);
  return {
    id: respId, object: 'response', created_at: created, model,
    status: finish === 'length' ? 'incomplete' : 'completed',
    output,
    usage: { input_tokens: prompt || 0, output_tokens: completion || 0, total_tokens: total }
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

function buildVertexMessage({ model, think, text, tools, finish, prompt, completion, sig }) {
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
    parts.push({ functionCall: { name: tc.name || 'tool', args: parseArgs(tc.args) } });
  }
  if (!parts.length) parts.push({ text: '' });
  const total = (prompt || 0) + (completion || 0);
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: vertexFinish(finish), index: 0 }],
    usageMetadata: { promptTokenCount: prompt || 0, candidatesTokenCount: completion || 0, totalTokenCount: total },
    modelVersion: model
  };
}

function createVertexStream(emit, model) {
  const cand = (parts, extra) => emit(null, { candidates: [{ content: { role: 'model', parts }, ...(extra || {}) }] });
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
      if (tc.name) cand([{ functionCall: { name: tc.name, args: parseArgs(tc.args || '{}') } }]);
    },
    finish(canonical, stats = {}) {
      const prompt = stats.prompt || 0;
      const completion = stats.completion || 0;
      emit(null, {
        candidates: [{ content: { role: 'model', parts: [] }, finishReason: vertexFinish(canonical), index: 0 }],
        usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: completion, totalTokenCount: prompt + completion }
      });
    }
  };
}

export {
  mapStopReason, canonFinish, chatFinish, canonicalToOpenAI,
  smartReasoning, smartText, smartToolCalls, smartUsage, smartFinish,
  smartChoice, firstChoice, smartDelta, sanitizeJsonSchema, splitParts,
  budgetToEffort, effortToBudget, clampBudget, parseArgs, stringifyArgs,
  anthropicToIR, chatToIR, responsesToIR, vertexToIR, parseToIR,
  irToChatBody, irToAnthropicBody, irToVertexBody, emitUpstreamBody,
  normalizeUpstream, createCollector,
  createAnthropicStream, buildAnthropicMessage,
  createChatStream, buildChatMessage,
  createResponsesStream, buildResponsesMessage,
  vertexFinish, createVertexStream, buildVertexMessage
};
