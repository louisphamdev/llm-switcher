// Real-world user interaction and coding tool simulation battery.
// Simulates end-to-end interactions from Claude Code and Codex clients
// calling LLM providers through the llm-switcher gateway.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertValidAnthropicEvents } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let upstream;
let upstreamPort;
let proxy;
let proxyPort;
let fakeInterceptor;
let blindfoldPort;
let tmpDir;
const received = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
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
        if (lastUser.includes('SIM_429')) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '15' });
          return res.end(JSON.stringify({ error: { message: 'Rate limit reached, please slow down' } }));
        }

        if (lastUser.includes('SIM_CUT_STREAM')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial thinking...' } }] })}\n\n`);
          return setTimeout(() => res.destroy(), 30);
        }

        if (lastUser.includes('SIM_THINKING_BUDGET')) {
          return sse(res, [
            { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Step 1: Inspect requirement.\nStep 2: Formulate plan.' } }] },
            { choices: [{ index: 0, delta: { content: 'Here is the plan.' } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            { choices: [], usage: { prompt_tokens: 150, completion_tokens: 45, prompt_tokens_details: { cached_tokens: 50 } } }
          ], { raw: ['data: [DONE]\n\n'] });
        }

        if (lastUser.includes('SIM_TOOL_TURN_1')) {
          return sse(res, [
            { choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me search files.' } }] },
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_grep_01', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"ensureAdminToken"}' } }] } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            { choices: [], usage: { prompt_tokens: 200, completion_tokens: 30 } }
          ], { raw: ['data: [DONE]\n\n'] });
        }

        if (lastUser.includes('SIM_TOOL_TURN_2')) {
          return sse(res, [
            { choices: [{ index: 0, delta: { content: 'Found ensureAdminToken in state.mjs: line 42.' } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            { choices: [], usage: { prompt_tokens: 350, completion_tokens: 25 } }
          ], { raw: ['data: [DONE]\n\n'] });
        }

        if (lastUser.includes('SIM_CODEX_PATCH')) {
          return sse(res, [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_patch_1', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch\\n+console.log(\\"patched\\");\\n*** End Patch"}' } }] } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
          ]);
        }

        if (lastUser.includes('SIM_CODEX_DONE')) {
          return sse(res, [
            { choices: [{ index: 0, delta: { content: 'Patch verified and test passes.' } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
          ]);
        }

        // Generic stream response
        return sse(res, [
          { choices: [{ index: 0, delta: { content: 'Simulation ok' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }
        ], { raw: ['data: [DONE]\n\n'] });
      }

      if (req.url.startsWith('/vtx/models/')) {
        // Vertex simulation: check tools received
        return sse(res, [
          { candidates: [{ content: { role: 'model', parts: [{ text: 'Vertex received valid schemas' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 15 } }
        ]);
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
  blindfoldPort = await freePort();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-sim-'));

  const base = `http://127.0.0.1:${upstreamPort}`;
  const models = { opus: 'up-opus', sonnet: 'up-sonnet', haiku: 'up-haiku', fable: 'up-fable' };
  const cfg = {
    port: proxyPort,
    blindfold: { port: blindfoldPort },
    activeProfiles: { claude: 'chat', codex: 'codex-chat' },
    profiles: {
      chat: { name: 'Sim Chat', mode: 'convert', tool: 'claude', outFormat: 'openai-chat', baseURL: `${base}/chat/v1`, apiKey: 'sk-sim-chat', defaultModels: models },
      vtx: { name: 'Sim Vertex', mode: 'convert', inFormat: 'auto', outFormat: 'vertex', baseURL: `${base}/vtx`, apiKey: 'sk-sim-vtx', defaultModels: models },
      'codex-chat': { name: 'Sim Codex', mode: 'convert', tool: 'codex', inFormat: 'responses', outFormat: 'openai-chat', baseURL: `${base}/chat/v1`, apiKey: 'sk-sim-codex', defaultModels: { main: 'up-sonnet' } }
    }
  };
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(cfg, null, 2));

  proxy = spawn(process.execPath, [path.join(ROOT, 'proxy.mjs'), '--port', String(proxyPort)], {
    env: {
      ...process.env,
      LLM_SWITCHER_CONFIG: path.join(tmpDir, 'config.json'),
      LLM_SWITCHER_STATE_DIR: tmpDir,
      CLAUDE_CONFIG_DIR: path.join(tmpDir, 'claude'),
      LLM_SWITCHER_PORT: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let started = false;
  for (let i = 0; i < 50 && !started; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${proxyPort}/health`);
      if (r.ok) started = true;
    } catch {}
    if (!started) await new Promise(r => setTimeout(r, 100));
  }
  if (!started) throw new Error('proxy did not start in simulation fixture');

  // Stand-in mock interceptor on blindfoldPort
  fakeInterceptor = spawn(process.execPath, ['--input-type=module', '-e', `
    const s = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'state.mjs')).href)});
    const http = await import('node:http');
    const port = ${blindfoldPort};
    http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const ch = u.searchParams.get('challenge');
      const proof = s.identityProof(ch || '', { role: 'blindfold', port, pid: process.pid, gatewayPort: ${proxyPort}, activeTools: 'claude,codex' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proxy: 'llm-switcher-blindfold', role: 'blindfold', port, pid: process.pid, gatewayPort: ${proxyPort}, activeTools: 'claude,codex', proof }));
    }).listen(port, '127.0.0.1');
  `], {
    env: { ...process.env, LLM_SWITCHER_CONFIG: path.join(tmpDir, 'config.json'), LLM_SWITCHER_STATE_DIR: tmpDir },
    stdio: 'ignore'
  });

  const deadline = Date.now() + 8000;
  for (;;) {
    const probe = await fetch(`http://127.0.0.1:${blindfoldPort}/?challenge=probe`).catch(() => null);
    if (probe?.ok) break;
    if (Date.now() > deadline) throw new Error('fake interceptor never started');
    await new Promise(r => setTimeout(r, 100));
  }
});

after(() => {
  fakeInterceptor?.kill();
  try {
    const bfFile = path.join(tmpDir, 'blindfold.json');
    if (fs.existsSync(bfFile)) {
      const bfState = JSON.parse(fs.readFileSync(bfFile, 'utf8'));
      if (bfState?.pid) {
        if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/PID', String(bfState.pid)], { stdio: 'ignore' });
        else process.kill(bfState.pid, 'SIGTERM');
      }
    }
  } catch {}
  proxy?.kill();
  upstream?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const url = (p) => `http://127.0.0.1:${proxyPort}${p}`;
const adminToken = () => fs.readFileSync(path.join(tmpDir, 'admin.token'), 'utf8').trim();
const post = (p, body, headers = {}) => fetch(url(p), {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(p.startsWith('/api/') ? { 'x-llm-switcher-token': adminToken() } : {}),
    ...headers
  },
  body: JSON.stringify(body)
});

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

test('Real User Sim 1: Claude Code multi-turn tool interaction (Tool Call -> Tool Result -> Final Answer)', async () => {
  // Turn 1: User prompt requests finding a function
  const res1 = await post('/v1/messages', {
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    stream: true,
    messages: [{ role: 'user', content: 'SIM_TOOL_TURN_1 find ensureAdminToken' }],
    tools: [
      { name: 'Grep', description: 'Search files', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } }
    ]
  });
  assert.equal(res1.status, 200);
  const text1 = await res1.text();
  const events1 = parseSSE(text1);
  assertValidAnthropicEvents(events1);

  const blockStart = events1.find(e => e.event === 'content_block_start' && e.data?.content_block?.type === 'tool_use');
  assert.ok(blockStart, 'must emit content_block_start with tool_use');
  assert.equal(blockStart.data.content_block.name, 'Grep');
  const toolId = blockStart.data.content_block.id;
  assert.ok(toolId, 'tool_use must have an id');

  // Turn 2: Claude Code runs the tool and returns tool_result
  const res2 = await post('/v1/messages', {
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    stream: true,
    messages: [
      { role: 'user', content: 'SIM_TOOL_TURN_1 find ensureAdminToken' },
      { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Grep', input: { pattern: 'ensureAdminToken' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'SIM_TOOL_TURN_2 state.mjs:42: export function ensureAdminToken' }] }
    ]
  });
  assert.equal(res2.status, 200);
  const text2 = await res2.text();
  const events2 = parseSSE(text2);
  assertValidAnthropicEvents(events2);

  const deltas = events2.filter(e => e.event === 'content_block_delta').map(e => e.data?.delta?.text).filter(Boolean);
  assert.ok(deltas.join('').includes('Found ensureAdminToken in state.mjs: line 42.'));
  const msgStop = events2.find(e => e.event === 'message_stop');
  assert.ok(msgStop, 'must cleanly complete turn with message_stop');
});

test('Real User Sim 2: Claude Code thinking block flow with budget tokens', async () => {
  const res = await post('/v1/messages', {
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    stream: true,
    messages: [{ role: 'user', content: 'SIM_THINKING_BUDGET Plan the refactoring' }]
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const events = parseSSE(text);
  assertValidAnthropicEvents(events);

  const thinkingBlock = events.find(e => e.event === 'content_block_start' && e.data?.content_block?.type === 'thinking');
  assert.ok(thinkingBlock, 'must emit thinking block for reasoning upstream');
  const thinkingDeltas = events.filter(e => e.event === 'content_block_delta' && e.data?.delta?.type === 'thinking_delta');
  assert.ok(thinkingDeltas.length > 0, 'must emit thinking deltas');
  const textBlock = events.find(e => e.event === 'content_block_start' && e.data?.content_block?.type === 'text');
  assert.ok(textBlock, 'text block follows thinking block');
});

test('Real User Sim 3: Gemini / Vertex healing of empty & complex tool schemas', async () => {
  // Test switching profile to vertex and sending empty schema
  const switchRes = await post('/api/switch', { tool: 'claude', profile: 'vtx' });
  assert.equal(switchRes.status, 200);

  const res = await post('/v1/messages', {
    model: 'claude-sonnet-4',
    max_tokens: 1024,
    stream: true,
    messages: [{ role: 'user', content: 'Call tool with empty schema' }],
    tools: [
      { name: 'empty_tool', description: 'Tool with no parameters', input_schema: {} },
      { name: 'nested_tool', description: 'Tool with complex types', input_schema: { type: 'object', properties: { flag: { type: 'boolean' } } } }
    ]
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('Vertex received valid schemas'), 'vertex must receive healed non-empty schemas');

  // Switch back to chat profile
  await post('/api/switch', { tool: 'claude', profile: 'chat' });
});

test('Real User Sim 4: Codex WebSocket turns (warmup -> prompt -> apply_patch -> continue)', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/v1/responses`);
  const messages = [];

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    try { messages.push(JSON.parse(event.data)); } catch {}
  };

  // Step 1: Warmup with tools declaration
  ws.send(JSON.stringify({
    type: 'response.create',
    generate: false,
    input: [
      { type: 'additional_tools', id: 'at_1', role: 'developer', tools: [
        { type: 'custom', name: 'apply_patch', description: 'Patch files' }
      ] }
    ]
  }));
  await new Promise(r => setTimeout(r, 100));
  const warmup = messages.find(m => m.type === 'response.completed');
  assert.ok(warmup, 'warmup answered locally without upstream call');

  // Step 2: Task with custom patch tool
  messages.length = 0;
  ws.send(JSON.stringify({
    type: 'response.create',
    previous_response_id: warmup.response.id,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SIM_CODEX_PATCH please patch bug' }] }]
  }));

  const deadline = Date.now() + 3000;
  while (!messages.some(m => m.type === 'response.completed') && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
  }
  const patchTurn = messages.find(m => m.type === 'response.completed');
  assert.ok(patchTurn, 'patch turn completed');
  const patchItem = messages.find(m => m.type === 'response.output_item.done' && m.item?.type === 'custom_tool_call');
  assert.ok(patchItem, 'emitted custom_tool_call for apply_patch');
  assert.equal(patchItem.item.name, 'apply_patch');
  const respId = patchTurn.response?.id;

  // Step 3: Continuation with previous_response_id
  messages.length = 0;
  ws.send(JSON.stringify({
    type: 'response.create',
    previous_response_id: respId,
    input: [{ type: 'custom_tool_call_output', output: 'Patch applied successfully' }]
  }));

  const deadline2 = Date.now() + 3000;
  while (!messages.some(m => m.type === 'response.completed') && Date.now() < deadline2) {
    await new Promise(r => setTimeout(r, 50));
  }
  const doneTurn = messages.find(m => m.type === 'response.completed');
  assert.ok(doneTurn, 'continuation turn completed');

  ws.close();
});

test('Real User Sim 5: High-concurrency dual-tool execution (Claude streaming + Codex WS simultaneously)', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/v1/responses`);
  await new Promise(r => { ws.onopen = r; });
  const wsMessages = [];
  ws.onmessage = (e) => { try { wsMessages.push(JSON.parse(e.data)); } catch {} };

  // Trigger both simultaneously
  const claudePromise = post('/v1/messages', {
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    stream: true,
    messages: [{ role: 'user', content: 'SIM_CONCURRENCY Claude request' }]
  });

  ws.send(JSON.stringify({
    type: 'response.create',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SIM_CONCURRENCY Codex request' }] }]
  }));

  const [claudeRes] = await Promise.all([claudePromise]);
  assert.equal(claudeRes.status, 200);
  const claudeText = await claudeRes.text();
  assert.ok(claudeText.includes('Simulation ok'));

  const deadline = Date.now() + 3000;
  while (!wsMessages.some(m => m.type === 'response.completed') && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(wsMessages.some(m => m.type === 'response.completed'), 'Codex completed concurrently without interference');
  ws.close();
});

test('Real User Sim 6: Upstream 429 Rate Limit mapping with Retry-After header', async () => {
  const res = await post('/v1/messages', {
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: 'SIM_429 test rate limit' }]
  });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '15', 'preserves retry-after header');
  const body = await res.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error?.type, 'rate_limit_error');
  assert.ok(body.error?.message.includes('Rate limit reached'));
});

test('Real User Sim 7: Mid-stream network failure emitted as Anthropic error event', async () => {
  const res = await post('/v1/messages', {
    model: 'claude-opus-4-6',
    stream: true,
    messages: [{ role: 'user', content: 'SIM_CUT_STREAM disconnect mid stream' }]
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const events = parseSSE(text);
  const errEvent = events.find(e => e.event === 'error');
  assert.ok(errEvent, 'must emit error event when upstream cuts stream abruptly');
  assert.ok(!events.some(e => e.event === 'message_stop'), 'must not emit fake message_stop when cut');
});

test('Real User Sim 8: Dynamic profile switching during session preserves system integrity', async () => {
  // Check status before
  const st1 = await (await fetch(url('/api/status'), { headers: { 'x-llm-switcher-token': adminToken() } })).json();
  assert.equal(st1.activeProfiles.claude, 'chat');

  // Toggle Claude profile off
  const toggleOff = await post('/api/toggle', { target: 'claude', enabled: false });
  assert.equal(toggleOff.status, 200);

  const st2 = await (await fetch(url('/api/status'), { headers: { 'x-llm-switcher-token': adminToken() } })).json();
  assert.equal(st2.activeProfiles.claude, null);

  // Toggle Claude profile on
  const toggleOn = await post('/api/toggle', { target: 'claude', enabled: true });
  assert.equal(toggleOn.status, 200);

  const st3 = await (await fetch(url('/api/status'), { headers: { 'x-llm-switcher-token': adminToken() } })).json();
  assert.equal(st3.activeProfiles.claude, 'chat');
});
