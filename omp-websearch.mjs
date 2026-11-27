// Answers Claude Code's WebSearch sub-request with omp's web search instead of forwarding it.
// The upstream behind a gateway often has no server-side web search; omp's provider chain
// (Parallel, Exa, SearXNG, DuckDuckGo...) works with whatever credentials the user already has.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, 'omp-websearch', 'search.ts');
const MARK = '@@OMP@@';
const QUERY_PREFIX = /^Perform a web search for the query:\s*([\s\S]+)$/;
const TIMEOUT_MS = 90_000;

const ompSrc = () => process.env.LLM_SWITCHER_OMP_SRC
  || path.join(os.homedir(), '.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src');
const bunBin = () => process.env.LLM_SWITCHER_BUN
  || (fs.existsSync(path.join(os.homedir(), '.bun/bin/bun')) ? path.join(os.homedir(), '.bun/bin/bun') : 'bun');

// Set LLM_SWITCHER_OMP_WEBSEARCH=0 to forward web search requests upstream again.
export function ompWebSearchAvailable() {
  return process.env.LLM_SWITCHER_OMP_WEBSEARCH !== '0' && fs.existsSync(path.join(ompSrc(), 'web/search/index.ts'));
}

function lastUserText(payload) {
  const last = (payload?.messages || []).slice().reverse().find(m => m?.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return (last.content || []).filter(p => p?.type === 'text').map(p => p.text).join('\n');
}

// Claude Code's WebSearch tool makes its own request: one provider-run web_search tool and the user
// message "Perform a web search for the query: <q>". Anything else is left to the upstream.
export function webSearchQuery(payload) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const hosted = tools.some(t => typeof t?.type === 'string' && t.type.startsWith('web_search') && !t.input_schema);
  if (!hosted) return null;
  const m = QUERY_PREFIX.exec(lastUserText(payload).trim());
  return m ? m[1].trim() : null;
}

export function runOmpSearch(query, signal) {
  return new Promise(resolve => {
    let timer;
    const done = (result) => { clearTimeout(timer); resolve(result); };
    const fail = message => done({ ok: false, text: `Error: ${message}`, sources: [] });
    let child;
    try {
      child = spawn(bunBin(), [HELPER, ompSrc(), query], { stdio: ['ignore', 'pipe', 'pipe'], signal, cwd: os.tmpdir() });
    } catch (e) {
      return fail(e.message);
    }
    timer = setTimeout(() => { child.kill(); fail(`omp search timed out after ${TIMEOUT_MS / 1000}s`); }, TIMEOUT_MS);
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', e => fail(e.name === 'AbortError' ? 'search aborted' : e.message));
    child.on('close', () => {
      const line = out.split('\n').reverse().find(l => l.startsWith(MARK));
      if (!line) return fail('omp search returned no result');
      try {
        done(JSON.parse(line.slice(MARK.length)));
      } catch {
        fail('omp search returned unreadable output');
      }
    });
  });
}

const rand = n => crypto.randomBytes(n).toString('hex').slice(0, n);

// The blocks Anthropic returns for a server-side search: the call, its result, then the answer text.
export function buildWebSearchContent(query, result) {
  const toolId = `srvtoolu_${rand(20)}`;
  const searchResult = result.ok
    ? result.sources.map(s => ({ type: 'web_search_result', url: s.url, title: s.title, encrypted_content: '', page_age: null }))
    : { type: 'web_search_tool_result_error', error_code: 'unavailable' };
  return [
    { type: 'server_tool_use', id: toolId, name: 'web_search', input: { query } },
    { type: 'web_search_tool_result', tool_use_id: toolId, content: searchResult },
    { type: 'text', text: result.text || 'No results.' },
  ];
}

export function sendWebSearchResponse(res, { stream, model, query, result }) {
  const content = buildWebSearchContent(query, result);
  const msgId = `msg_${Date.now()}_${rand(12)}`;
  const usage = { input_tokens: 0, output_tokens: Math.max(1, Math.ceil((content[2].text || '').length / 4)), server_tool_use: { web_search_requests: 1 } };
  if (!stream) {
    const body = JSON.stringify({ id: msgId, type: 'message', role: 'assistant', model, content, stop_reason: 'end_turn', stop_sequence: null, usage });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(body);
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  emit('message_start', { message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  content.forEach((block, index) => {
    if (block.type === 'server_tool_use') {
      emit('content_block_start', { index, content_block: { ...block, input: {} } });
      emit('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else if (block.type === 'text') {
      emit('content_block_start', { index, content_block: { type: 'text', text: '' } });
      emit('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      emit('content_block_start', { index, content_block: block });
    }
    emit('content_block_stop', { index });
  });
  emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage });
  emit('message_stop', {});
  res.end();
}
