import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { webSearchQuery, buildWebSearchContent, sendWebSearchResponse, runOmpSearch } from '../omp-websearch.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 8 };
const searchPayload = (q, extra = {}) => ({
  model: 'claude-sonnet-5-5', stream: true, tools: [WEB_TOOL],
  messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${q}` }] }], ...extra
});

function fakeRes() {
  const r = { status: 0, headers: {}, chunks: [], ended: false, writableEnded: false };
  r.writeHead = (s, h) => { r.status = s; r.headers = h; };
  r.write = (c) => { r.chunks.push(c); return true; };
  r.end = (c) => { if (c) r.chunks.push(c); r.ended = true; r.writableEnded = true; };
  return r;
}
const sseEvents = (r) => r.chunks.join('').split('\n\n').filter(Boolean).map(b => JSON.parse(b.split('\ndata: ')[1]));
const OK = { ok: true, text: 'Answer [1]\n[1] Bun\n    https://bun.sh', sources: [{ title: 'Bun', url: 'https://bun.sh' }] };

describe('webSearchQuery', () => {
  it('extracts the query from the WebSearch sub-request', () => {
    assert.equal(webSearchQuery(searchPayload('bun latest release')), 'bun latest release');
  });
  it('accepts a plain-string user message', () => {
    const p = searchPayload('x', { messages: [{ role: 'user', content: 'Perform a web search for the query: hello world' }] });
    assert.equal(webSearchQuery(p), 'hello world');
  });
  it('ignores a request without the provider-run web_search tool', () => {
    assert.equal(webSearchQuery(searchPayload('x', { tools: [] })), null);
    assert.equal(webSearchQuery(searchPayload('x', { tools: undefined })), null);
  });
  it('ignores a client tool that happens to be named web_search', () => {
    const tool = { name: 'web_search', description: 'd', input_schema: { type: 'object' } };
    assert.equal(webSearchQuery(searchPayload('x', { tools: [tool] })), null);
  });
  it('ignores a conversation that is not the WebSearch sub-request', () => {
    const p = searchPayload('x', { messages: [{ role: 'user', content: 'search the web for cats' }] });
    assert.equal(webSearchQuery(p), null);
  });
});

describe('buildWebSearchContent', () => {
  it('returns call, result and answer text, linked by one tool id', () => {
    const [call, result, text] = buildWebSearchContent('q', OK);
    assert.equal(call.type, 'server_tool_use');
    assert.deepEqual(call.input, { query: 'q' });
    assert.equal(result.type, 'web_search_tool_result');
    assert.equal(result.tool_use_id, call.id);
    assert.deepEqual(result.content.map(c => [c.type, c.url, c.title]), [['web_search_result', 'https://bun.sh', 'Bun']]);
    assert.equal(text.text, OK.text);
  });
  it('reports a failed search as a tool error, not as empty results', () => {
    const [, result, text] = buildWebSearchContent('q', { ok: false, text: 'Error: boom', sources: [] });
    assert.deepEqual(result.content, { type: 'web_search_tool_result_error', error_code: 'unavailable' });
    assert.equal(text.text, 'Error: boom');
  });
});

describe('sendWebSearchResponse', () => {
  it('streams a complete Anthropic message', () => {
    const res = fakeRes();
    sendWebSearchResponse(res, { stream: true, model: 'm', query: 'q', result: OK });
    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /text\/event-stream/);
    const ev = sseEvents(res);
    assert.deepEqual(ev.map(e => e.type), [
      'message_start',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop'
    ]);
    assert.equal(ev[1].content_block.type, 'server_tool_use');
    assert.deepEqual(ev[1].content_block.input, {});
    assert.equal(JSON.parse(ev[2].delta.partial_json).query, 'q');
    assert.equal(ev[4].content_block.type, 'web_search_tool_result');
    assert.equal(ev[7].delta.text, OK.text);
    assert.equal(ev[9].delta.stop_reason, 'end_turn');
    assert.equal(ev[9].usage.server_tool_use.web_search_requests, 1);
    assert.ok(res.ended);
  });
  it('answers a non-stream request with one JSON message', () => {
    const res = fakeRes();
    sendWebSearchResponse(res, { stream: false, model: 'm', query: 'q', result: OK });
    const msg = JSON.parse(res.chunks.join(''));
    assert.equal(msg.type, 'message');
    assert.equal(msg.model, 'm');
    assert.deepEqual(msg.content.map(b => b.type), ['server_tool_use', 'web_search_tool_result', 'text']);
    assert.equal(msg.stop_reason, 'end_turn');
  });
});

describe('runOmpSearch', () => {
  it('fails cleanly when bun cannot be started', async () => {
    const prev = process.env.LLM_SWITCHER_BUN;
    process.env.LLM_SWITCHER_BUN = '/nonexistent/bun';
    try {
      const r = await runOmpSearch('q');
      assert.equal(r.ok, false);
      assert.match(r.text, /^Error:/);
    } finally {
      if (prev === undefined) delete process.env.LLM_SWITCHER_BUN; else process.env.LLM_SWITCHER_BUN = prev;
    }
  });
});

describe('search.ts helper', () => {
  it('imports nothing by package name: the installed copy has none of omp\'s dependencies', () => {
    const src = fs.readFileSync(path.join(ROOT, 'omp-websearch', 'search.ts'), 'utf8');
    const bare = [...src.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map(m => m[1])
      .filter(spec => !spec.startsWith('node:') && !spec.startsWith('.') && !spec.startsWith('/'));
    assert.deepEqual(bare, []);
  });
});

// ---------- the gateway answers instead of forwarding ----------

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

it('the gateway answers a WebSearch sub-request with omp and never calls the upstream', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-ompws-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // A stand-in for bun: prints the helper's result line, so no network or omp install is needed.
  const fakeBun = path.join(tmp, 'fake-bun.sh');
  fs.writeFileSync(fakeBun, '#!/bin/sh\nprintf \'noise\\n@@OMP@@{"ok":true,"text":"Answer [1]","sources":[{"title":"Bun","url":"https://bun.sh"}]}\\n\'\n', { mode: 0o755 });
  const fakeSrc = path.join(tmp, 'omp-src');
  fs.mkdirSync(path.join(fakeSrc, 'web/search'), { recursive: true });
  fs.writeFileSync(path.join(fakeSrc, 'web/search/index.ts'), '');

  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => { upstreamHits++; res.writeHead(500).end('{}'); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());

  const port = await freePort();
  const cfgPath = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port, blindfold: { port: await freePort() }, activeProfiles: { claude: 'c', codex: null },
    profiles: { c: {
      name: 'c', mode: 'direct', tool: 'claude', outFormat: 'anthropic',
      baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'sk-test',
      defaultModels: { opus: 'm-opus', sonnet: 'm-sonnet', haiku: 'm-haiku', fable: 'm-fable' }
    } }
  }), { mode: 0o600 });

  const child = spawn(process.execPath, [path.join(ROOT, 'proxy.mjs'), '--port', String(port)], {
    env: {
      ...process.env, LLM_SWITCHER_HOME: tmp, LLM_SWITCHER_CONFIG: cfgPath, LLM_SWITCHER_STATE_DIR: tmp,
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), LLM_SWITCHER_PORT: '', PORT: '',
      LLM_SWITCHER_BUN: fakeBun, LLM_SWITCHER_OMP_SRC: fakeSrc
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit').catch(() => {}); } });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    assert.ok(i < 80, `gateway did not start: ${log}`);
    await new Promise(r => setTimeout(r, 100));
  }

  const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
    body: JSON.stringify(searchPayload('bun latest release'))
  });
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /"type":"server_tool_use"/);
  assert.match(body, /"url":"https:\/\/bun\.sh"/);
  assert.match(body, /Answer \[1\]/);
  assert.match(body, /event: message_stop/);
  assert.equal(upstreamHits, 0, 'the upstream must not see the web search request');
});
