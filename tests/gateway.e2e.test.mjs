// End-to-end tests: spawn proxy.mjs against a mock upstream (offline, no real API key needed).
// Run: node --test tests/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertValidAnthropicEvents } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let upstream, upstreamPort, proxy, proxyPort, tmpDir;
const received = []; // { url, headers, body }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

const sse = (res, objs, { raw = [] } = {}) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const o of objs) res.write(`data: ${JSON.stringify(o)}\n\n`);
  for (const r of raw) res.write(r);
  res.end();
};

function startUpstream() {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      received.push({ url: req.url, headers: req.headers, body: json });
      const lastUser = JSON.stringify(json.messages?.at(-1) ?? json.contents?.at(-1) ?? '');

      if (req.url.startsWith('/chat/v1/chat/completions')) {
        if (lastUser.includes('RATE_LIMIT')) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '7' });
          return res.end(JSON.stringify({ error: { message: 'slow down' } }));
        }
        if (lastUser.includes('APPLY_PATCH')) {
          return sse(res, [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch\\n' } }] } }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '*** End Patch"}' } }] } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
          ]);
        }
        if (lastUser.includes('MID_STREAM_ERROR')) {
          return sse(res, [
            { choices: [{ index: 0, delta: { content: 'partial' } }] },
            { error: { message: 'upstream exploded' } }
          ]);
        }
        if (!json.stream) {
          return res.end(JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content: '<think>quiet plan</think>Final answer' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 50, completion_tokens: 4 }
          }));
        }
        return sse(res, [
          { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Let me think' } }] },
          { choices: [{ index: 0, delta: { content: 'Running tool' } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_A', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 1234, completion_tokens: 56, prompt_tokens_details: { cached_tokens: 1000 } } }
        ], { raw: ['data: [DONE]\n\n'] });
      }

      if (req.url.startsWith('/vtx/models/')) {
        return sse(res, [
          { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking about it', thought: true }] } }] },
          { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Hanoi' } }, thoughtSignature: 'SIG_HANOI' }] } }] },
          { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Saigon' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 9 } }
        ]);
      }

      if (req.url.startsWith('/ant/messages/count_tokens')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: 4242 }));
      }

      if (req.url.startsWith('/ant/messages')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'transfer-encoding': 'chunked', connection: 'keep-alive' });
        return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: json.model, content: [{ type: 'text', text: 'direct ok' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }));
      }

      res.writeHead(404);
      res.end('{}');
    });
  });
  return new Promise(r => upstream.listen(0, '127.0.0.1', () => { upstreamPort = upstream.address().port; r(); }));
}

before(async () => {
  await startUpstream();
  proxyPort = await freePort();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-switcher-test-'));
  const base = `http://127.0.0.1:${upstreamPort}`;
  const models = { opus: 'up-opus', sonnet: 'up-sonnet', haiku: 'up-haiku', fable: 'up-fable' };
  const cfg = {
    port: proxyPort,
    activeProfile: 'chat',
    activeProfiles: { anthropic: 'chat', responses: 'chat', 'openai-chat': 'chat', vertex: 'chat' },
    profiles: {
      chat: { name: 'Mock Chat', mode: 'convert', inFormat: 'auto', outFormat: 'openai-chat', baseURL: `${base}/chat/v1`, apiKey: 'sk-secret-chat', defaultModels: models },
      vtx: { name: 'Mock Vertex', mode: 'convert', inFormat: 'auto', outFormat: 'vertex', baseURL: `${base}/vtx`, apiKey: 'sk-secret-vtx', defaultModels: models },
      agmock: { name: 'Mock AG via chat', mode: 'convert', inFormat: 'responses', baseURL: `${base}/chat/v1`, apiKey: 'sk-secret-ag', defaultModels: { main: 'ag/mock-flash', review: 'ag/mock-review', subagent: 'ag/mock-low' } },
      pub: { name: 'Mock Public', mode: 'convert', inFormat: 'responses', baseURL: `${base}/chat/v1`, apiKey: 'sk-secret-pub', publicModels: ['gpt-5.6-sol', 'gpt-5.2'], defaultModels: { main: 'ag/mock-flash' } },
      roles: { name: 'Mock Public Roles', mode: 'convert', inFormat: 'responses', baseURL: `${base}/chat/v1`, apiKey: 'sk-secret-roles', publicModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'], defaultModels: { main: 'ag/mock-flash', review: 'ag/mock-review', subagent: 'ag/mock-low' } },
      native: { name: 'Mock Strict OpenAI', mode: 'convert', inFormat: 'auto', outFormat: 'openai-chat', thinkingMode: 'native', baseURL: `${base}/chat/v1`, apiKey: 'sk-secret-native', defaultModels: models },
      ant: { name: 'Mock Anthropic', mode: 'direct', inFormat: 'auto', outFormat: 'anthropic', baseURL: `${base}/ant`, apiKey: 'sk-secret-ant', defaultModels: models }
    }
  };
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(cfg, null, 2));
  proxy = spawn(process.execPath, [path.join(ROOT, 'proxy.mjs'), '--port', String(proxyPort)], {
    env: { ...process.env, LLM_SWITCHER_CONFIG: path.join(tmpDir, 'config.json'), LLM_SWITCHER_PORT: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  proxy.stdout.on('data', d => { log += d; });
  proxy.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${proxyPort}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`proxy did not start:\n${log}`);
});

after(() => {
  proxy?.kill();
  upstream?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const url = (p) => `http://127.0.0.1:${proxyPort}${p}`;
const post = (p, body, headers = {}) => fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

function parseSSE(text) {
  return text.split(/\n\n/).filter(Boolean).map(block => {
    let event = null;
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    return { event, raw: data, data: data && data !== '[DONE]' ? JSON.parse(data) : null };
  });
}

function rawRequest({ path: p, method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: p, method, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('Claude Code stream via OpenAI upstream: valid Anthropic events, full tool args, real usage', async () => {
  const res = await post('/v1/messages', {
    model: 'claude-opus-4-6', max_tokens: 4096, stream: true,
    messages: [{ role: 'user', content: 'read a.txt' }],
    tools: [{ name: 'read_file', description: 'r', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]
  });
  assert.equal(res.status, 200);
  const events = parseSSE(await res.text()).map(e => ({ event: e.event, data: e.data }));
  assertValidAnthropicEvents(events);
  const starts = events.filter(e => e.event === 'content_block_start').map(e => e.data.content_block.type);
  assert.deepEqual(starts, ['thinking', 'text', 'tool_use']);
  const toolIdx = events.find(e => e.data?.content_block?.type === 'tool_use').data.index;
  const args = events.filter(e => e.event === 'content_block_delta' && e.data.index === toolIdx).map(e => e.data.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(args), { path: 'a.txt' });
  const md = events.find(e => e.event === 'message_delta').data;
  assert.equal(md.delta.stop_reason, 'tool_use');
  assert.equal(md.usage.output_tokens, 56);
  assert.equal(md.usage.input_tokens + md.usage.cache_read_input_tokens, 1234);
  assert.equal(received.at(-1).body.model, 'up-opus');
});

test('Anthropic request without "stream" gets JSON (not SSE); <think> tags become a thinking block', async () => {
  const res = await post('/v1/messages', { model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
  assert.match(res.headers.get('content-type'), /application\/json/);
  const json = await res.json();
  assert.equal(received.at(-1).body.stream, false);
  assert.deepEqual(json.content.map(b => b.type), ['thinking', 'text']);
  assert.equal(json.content[0].thinking, 'quiet plan');
  assert.equal(json.content[1].text, 'Final answer');
});

test('Codex (Responses) stream: output_item.done carries function_call; no [DONE] line', async () => {
  const res = await post('/v1/responses', { model: 'gpt-5-codex', stream: true, input: 'go', tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }] });
  const text = await res.text();
  assert.ok(!text.includes('[DONE]'));
  const events = parseSSE(text);
  assert.ok(events.every(e => e.event === e.data.type), 'event: line matches data.type');
  const done = events.filter(e => e.event === 'response.output_item.done').map(e => e.data.item);
  const fc = done.find(i => i.type === 'function_call');
  assert.equal(fc.call_id, 'call_A');
  assert.deepEqual(JSON.parse(fc.arguments), { path: 'a.txt' });
  assert.equal(events.at(-1).event, 'response.completed');
  assert.equal(events.at(-1).data.response.usage.input_tokens, 1234);
});

test('Codex via ag/* target: Gemini-hostile tool schemas are rewritten before upstream', async () => {
  const res = await post('/v1/responses', {
    model: 'main', stream: false,
    input: 'clean my tools',
    tools: [{ type: 'function', name: 'gmail_x', parameters: {
      type: 'object',
      properties: {
        ids: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        part: { $ref: '#/$defs/P' },
        raw: 'object'
      },
      required: ['ids', 'nope'],
      $defs: { P: { type: 'object', properties: { t: { type: 'string' } } } }
    } }]
  }, { 'x-llm-profile': 'agmock' });
  assert.equal(res.status, 200);
  const up = received.at(-1);
  assert.equal(up.body.model, 'ag/mock-flash');
  const params = up.body.tools[0].function.parameters;
  assert.deepEqual(params.properties.ids, { type: 'array', items: { type: 'string' }, nullable: true });
  assert.deepEqual(params.properties.part, { type: 'object', properties: { t: { type: 'string' } } });
  assert.deepEqual(params.properties.raw, { type: 'object', properties: {} });
  assert.deepEqual(params.required, ['ids']);
  assert.ok(!JSON.stringify(params).includes('$ref'), 'no $ref survives');
  assert.equal(params.$defs, undefined);
});

test('Codex bare OpenAI model IDs fail closed to the main slot (no 404 passthrough)', async () => {
  const res = await post('/v1/responses', { model: 'gpt-5.6-sol', stream: false, input: 'RATE_LIMIT probe' }, { 'x-llm-profile': 'agmock' });
  assert.equal(received.at(-1).body.model, 'ag/mock-flash');
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.message, 'slow down');
});

// Once Codex is told the official names, those names must still reach the right
// slot. Without this the blanket gpt-* fail-closed rule sends review and subagent
// traffic to the main model.
test('Official public names resolve to their own slot, not to the main fail-closed slot', async () => {
  await post('/v1/responses', { model: 'gpt-5.6-terra', stream: false, input: 'go' }, { 'x-llm-profile': 'roles' });
  assert.equal(received.at(-1).body.model, 'ag/mock-review');
  await post('/v1/responses', { model: 'gpt-5.6-luna', stream: false, input: 'go' }, { 'x-llm-profile': 'roles' });
  assert.equal(received.at(-1).body.model, 'ag/mock-low');
  // An official name the profile does not publish still fails closed to main.
  await post('/v1/responses', { model: 'gpt-5.1-codex-max', stream: false, input: 'go' }, { 'x-llm-profile': 'roles' });
  assert.equal(received.at(-1).body.model, 'ag/mock-flash');
});

// The upgrade handler is a second entrance to the gateway. Node emits 'upgrade', not
// 'request', so route() and its checkRequestOrigin never run there. Without this guard
// any web page can open ws://127.0.0.1:<port>/v1/responses and spend the profile key:
// browsers do not apply same-origin to WebSocket.
function rawHandshake(headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      const lines = ['GET /v1/responses HTTP/1.1', ...headers,
        'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13'];
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let data = '';
    socket.setTimeout(5000, () => { socket.destroy(); resolve(data); });
    socket.on('data', c => {
      data += c;
      if (data.includes('\r\n\r\n')) { socket.destroy(); resolve(data); }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(data));
  });
}

test('WS upgrade refuses a foreign Origin and a foreign Host, and still accepts loopback', async () => {
  const evilOrigin = await rawHandshake([`Host: 127.0.0.1:${proxyPort}`, 'Origin: https://evil.example']);
  assert.ok(!evilOrigin.includes('101'), `foreign Origin must not get a 101: ${evilOrigin.slice(0, 80)}`);

  const evilHost = await rawHandshake([`Host: evil.example:${proxyPort}`]);
  assert.ok(!evilHost.includes('101'), `foreign Host must not get a 101: ${evilHost.slice(0, 80)}`);

  // An absent Origin stays allowed: Codex sends none, and blindfold deletes it.
  const ok = await rawHandshake([`Host: 127.0.0.1:${proxyPort}`]);
  assert.match(ok, /HTTP\/1\.1 101/, 'a loopback handshake must still succeed');
});

// The dashboard writes these keys, and a hand-edited config reaches the same sink.
// state.mjs already drops an unsafe name before it can reach env.cmd; rejecting it
// here as well tells the user why, instead of losing the value in silence.
test('save-profile rejects a model name that could act as a command', async () => {
  const bad = await post('/api/save-profile', {
    key: 'probe', profile: { name: 'p', baseURL: 'http://127.0.0.1:1/v1', publicModels: ['a & echo pwned'] }
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /publicModels/);

  const badRole = await post('/api/save-profile', {
    key: 'probe', profile: { name: 'p', baseURL: 'http://127.0.0.1:1/v1', codexRoles: { review: 'x"&y' } }
  });
  assert.equal(badRole.status, 400);
  assert.match((await badRole.json()).error, /codexRoles/);

  const badPort = await post('/api/save-profile', {
    key: 'probe', profile: { name: 'p', baseURL: 'http://127.0.0.1:1/v1', blindfoldPort: 70000 }
  });
  assert.equal(badPort.status, 400);
  assert.match((await badPort.json()).error, /blindfoldPort/);

  const badHost = await post('/api/save-profile', {
    key: 'probe', profile: { name: 'p', baseURL: 'http://127.0.0.1:1/v1', blindfoldHost: 'not a host/' }
  });
  assert.equal(badHost.status, 400);
  assert.match((await badHost.json()).error, /blindfoldHost/);

  // The shapes the dashboard actually sends stay valid, empty strings included.
  const ok = await post('/api/save-profile', {
    key: 'probe', profile: {
      name: 'p', baseURL: 'http://127.0.0.1:1/v1', inFormat: 'responses',
      publicModels: ['gpt-5.6-sol', 'ag/mock-flash'],
      codexRoles: { main: 'gpt-5.6-sol', review: '', subagent: '' },
      blindfold: true, blindfoldHost: 'chatgpt.com', blindfoldPort: 3457, blindfoldPrefix: '/backend-api/codex'
    }
  });
  assert.equal(ok.status, 200);
});

test('Codex WS transport: upstream 429 becomes response.failed with rate_limit_exceeded', async () => {  const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/v1/responses`);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), 5000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('ws open error')); }, { once: true });
  });
  const seen = [];
  const failedP = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no response.failed, got: ' + JSON.stringify(seen.map(s => s.type)))), 15000);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      seen.push(msg);
      if (msg.type === 'response.failed') { clearTimeout(t); resolve(msg); }
    });
  });
  ws.send(JSON.stringify({ type: 'response.create', model: 'main', input: 'RATE_LIMIT over ws' }));
  const failed = await failedP;
  ws.close();
  assert.deepEqual(seen.slice(0, 2).map(s => s.type), ['response.created', 'response.in_progress']);
  assert.equal(failed.response.status, 'failed');
  assert.equal(failed.response.error.code, 'rate_limit_exceeded');
  assert.match(failed.response.error.message, /slow down/);
});

test('Public catalog: /v1/models serves official names with no switcher branding', async () => {
  const res = await fetch(url('/v1/models'), { headers: { 'x-llm-profile': 'pub' } });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('llm-switcher'), 'no switcher branding leaks to the client');
  assert.ok(!text.includes('ag/'), 'no upstream IDs leak to the client');
  const json = JSON.parse(text);
  assert.deepEqual(json.data.map(m => m.id), ['gpt-5.6-sol', 'gpt-5.2']);
  assert.ok(json.models.every(m => m.slug && m.display_name));
});

test('Response events echo the requested model, never the mapped upstream ID', async () => {
  const res = await post('/v1/responses', { model: 'main', stream: true, input: 'go' }, { 'x-llm-profile': 'agmock' });
  assert.equal(received.at(-1).body.model, 'ag/mock-flash');
  const events = parseSSE(await res.text());
  const created = events.find(e => e.event === 'response.created');
  assert.equal(created.data.response.model, 'main');
  assert.equal(events.at(-1).data.response.model, 'main');
});

test('Model list exposes only real mapped IDs, no slot aliases', async () => {
  const res = await fetch(url('/v1/models'));
  assert.equal(res.status, 200);
  const json = await res.json();
  const ids = json.data.map(m => m.id);
  assert.deepEqual([...ids].sort(), ['up-fable', 'up-haiku', 'up-opus', 'up-sonnet']);
  assert.ok(!ids.some(id => ['main', 'review', 'subagent', 'opus', 'sonnet', 'haiku', 'fable'].includes(id)), 'no slot aliases, got: ' + ids.join(','));
  assert.ok(json.models.every(m => m.slug && m.display_name));
});

test('Vertex upstream: multiple functionCall chunks become separate tool_use blocks', async () => {
  const res = await post('/v1/messages', { model: 'claude-sonnet-4-6', max_tokens: 2048, stream: true, messages: [{ role: 'user', content: 'weather x2' }] }, { 'x-llm-profile': 'vtx' });
  const events = parseSSE(await res.text()).map(e => ({ event: e.event, data: e.data }));
  assertValidAnthropicEvents(events);
  const tools = events.filter(e => e.data?.content_block?.type === 'tool_use');
  assert.equal(tools.length, 2);
  const argsOf = (idx) => JSON.parse(events.filter(e => e.event === 'content_block_delta' && e.data.index === idx).map(e => e.data.delta.partial_json).join(''));
  assert.deepEqual(argsOf(tools[0].data.index), { city: 'Hanoi' });
  assert.deepEqual(argsOf(tools[1].data.index), { city: 'Saigon' });
  assert.match(received.at(-1).url, /:streamGenerateContent\?alt=sse$/);
});

test('Gemini SDK route: model comes from the URL path', async () => {
  const res = await post('/v1beta/models/claude-opus-like:generateContent', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(received.at(-1).body.model, 'up-opus');
  assert.ok(json.candidates[0].content.parts.some(p => p.text === 'Final answer'));
});

test('Upstream 429 is returned in Anthropic error shape with retry-after', async () => {
  const res = await post('/v1/messages', { model: 'claude-opus-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'RATE_LIMIT' }] });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '7');
  const json = await res.json();
  assert.deepEqual(json, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
});

test('Mid-stream upstream error surfaces as an error event instead of a fake end_turn', async () => {
  const res = await post('/v1/messages', { model: 'claude-opus-4-6', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'MID_STREAM_ERROR' }] });
  const events = parseSSE(await res.text());
  assert.equal(events.at(-1).event, 'error');
  assert.match(events.at(-1).data.error.message, /exploded/);
  assert.ok(!events.some(e => e.event === 'message_stop'));
});

test('Direct Anthropic passthrough strips hop-by-hop headers and blocks client credentials', async () => {
  const res = await post('/v1/messages', { model: 'claude-opus-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
    { 'x-llm-profile': 'ant', 'x-goog-api-key': 'client-google-key', 'x-request-id': 'trace-1' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).content[0].text, 'direct ok');
  const up = received.at(-1);
  assert.equal(up.headers['x-api-key'], 'sk-secret-ant');
  assert.equal(up.headers['x-goog-api-key'], undefined);
  assert.equal(up.headers['x-request-id'], 'trace-1');
  assert.equal(up.body.model, 'up-opus');
});

test('Healer: orphaned tool_result and missing tool_result produce a valid chat history', async () => {
  await post('/v1/messages', {
    model: 'claude-opus-4-6', max_tokens: 50, messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'pruned', content: 'old' }, { type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'kept', name: 'f', input: {} }] },
      { role: 'user', content: 'result was pruned' }
    ]
  });
  const msgs = received.at(-1).body.messages;
  msgs.forEach((m, i) => {
    if (m.tool_calls) {
      const ids = m.tool_calls.map(t => t.id);
      const following = msgs.slice(i + 1, i + 1 + ids.length);
      assert.deepEqual(following.map(f => f.tool_call_id), ids);
    }
    if (m.role === 'tool') assert.ok(msgs[i - 1].tool_calls || msgs[i - 1].role === 'tool');
  });
});

test('Security: foreign Host / Origin are rejected (DNS rebinding & CSRF)', async () => {
  const rebinding = await rawRequest({ path: '/api/status', headers: { host: `evil.example:${proxyPort}` } });
  assert.equal(rebinding.status, 403);
  const csrf = await rawRequest({ path: '/api/status', headers: { origin: 'https://evil.example' } });
  assert.equal(csrf.status, 403);
  const otherLocalApp = await rawRequest({ path: '/api/status', headers: { origin: 'http://localhost:5173' } });
  assert.equal(otherLocalApp.status, 403);
  const ok = await rawRequest({ path: '/api/status', headers: { origin: `http://127.0.0.1:${proxyPort}` } });
  assert.equal(ok.status, 200);
});

test('Admin API: keys are redacted and invalid switch input is rejected', async () => {
  const status = await (await fetch(url('/api/status'))).json();
  assert.ok(!JSON.stringify(status).includes('sk-secret'));
  assert.equal(status.config.profiles.chat.hasApiKey, true);

  for (const body of [{ target: '__proto__', profile: 'chat' }, { target: 'anthropic', profile: 'constructor' }, { profile: 'toString' }]) {
    const r = await post('/api/switch', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const badKey = await post('/api/save-profile', { key: '__proto__', profile: { name: 'x', baseURL: 'http://a' } });
  assert.equal(badKey.status, 400);
});

test('Direct Anthropic path runs the native healer (orphan result, placeholder thinking)', async () => {
  const res = await post('/v1/messages', {
    model: 'claude-opus-4-6', max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2048 }, messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'converted', signature: 'reasoning-sig' }, { type: 'tool_use', id: 't1', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: 'pruned result' }] }
    ]
  }, { 'x-llm-profile': 'ant' });
  assert.equal(res.status, 200);
  await res.text();
  const body = received.at(-1).body;
  assert.ok(!JSON.stringify(body).includes('reasoning-sig'));
  assert.equal(body.messages[2].content[0].type, 'tool_result');
  assert.equal(body.thinking, undefined);
});

test('count_tokens: forwarded to native Anthropic upstream, estimated otherwise', async () => {
  const payload = { model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'x'.repeat(4000) }] };
  const real = await (await post('/v1/messages/count_tokens', payload, { 'x-llm-profile': 'ant' })).json();
  assert.equal(real.input_tokens, 4242);
  assert.equal(received.at(-1).body.model, 'up-opus');
  const est = await (await post('/v1/messages/count_tokens', payload)).json();
  assert.ok(est.input_tokens >= 1000 && est.input_tokens < 1010, String(est.input_tokens));
});

test('thinkingMode native profile: strict OpenAI body', async () => {
  const res = await post('/v1/messages', { model: 'claude-opus-4-6', max_tokens: 5000, system: 'SYS', thinking: { type: 'enabled', budget_tokens: 3000 }, messages: [{ role: 'user', content: 'hi' }] }, { 'x-llm-profile': 'native' });
  assert.equal(res.status, 200);
  await res.json();
  const body = received.at(-1).body;
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, 'medium');
  assert.equal(body.max_completion_tokens, 5000);
  assert.equal(body.messages[0].content, 'SYS');
});

test('Codex freeform apply_patch round-trips as custom_tool_call', async () => {
  const res = await post('/v1/responses', {
    model: 'gpt-5-codex', stream: true, input: 'APPLY_PATCH please',
    tools: [{ type: 'custom', name: 'apply_patch', description: 'Edit files', format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' } }]
  });
  const events = parseSSE(await res.text());
  const upTool = received.at(-1).body.tools[0].function;
  assert.equal(upTool.name, 'apply_patch');
  assert.deepEqual(upTool.parameters.required, ['input']);
  const item = events.find(e => e.event === 'response.output_item.done').data.item;
  assert.equal(item.type, 'custom_tool_call');
  assert.equal(item.call_id, 'call_patch');
  assert.equal(item.input, '*** Begin Patch\n*** End Patch');
});

test('Gemini thought signature survives a Claude Code round-trip through the gateway', async () => {
  const first = await post('/v1/messages', { model: 'claude-sonnet-4-6', max_tokens: 2048, stream: true, messages: [{ role: 'user', content: 'weather x2' }] }, { 'x-llm-profile': 'vtx' });
  const events = parseSSE(await first.text());
  const toolUses = events.filter(e => e.data?.content_block?.type === 'tool_use').map(e => e.data.content_block);
  assert.equal(toolUses.length, 2);

  await (await post('/v1/messages', {
    model: 'claude-sonnet-4-6', max_tokens: 2048, stream: true, messages: [
      { role: 'user', content: 'weather x2' },
      { role: 'assistant', content: toolUses.map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: {} })) },
      { role: 'user', content: toolUses.map(t => ({ type: 'tool_result', tool_use_id: t.id, content: '{"temp":30}' })) }
    ]
  }, { 'x-llm-profile': 'vtx' })).text();
  const body = received.at(-1).body;
  assert.equal(body.contents[1].parts[0].thoughtSignature, 'SIG_HANOI');
  assert.equal(body.contents[2].role, 'user');
  assert.deepEqual(body.contents[2].parts.map(p => p.functionResponse.name), ['get_weather', 'get_weather']);
});
