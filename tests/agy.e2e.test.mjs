// End-to-end tests for the Antigravity CLI (agy) route and the Bifrost route of agy and Codex.
// A mock upstream stands in for Google Code Assist, intact and a chat API; nothing leaves the host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGY_UA = 'antigravity/cli/1.2.14 (aidev_client; os_type=windows; arch=amd64; cl=990662481; auth_method=consumer)';
const CODEX_UA = 'codex_cli_rs/0.160.0 (Windows 10.0.26300; x86_64) WindowsTerminal';

let upstream, base, proxy, proxyPort, tmpDir;
const received = [];
const stalled = [];
const extraGateways = [];
let flakyLookups = 0;
let notFoundLookups = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

const sse = (res, objs) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const o of objs) res.write(`data: ${JSON.stringify(o)}\n\n`);
  res.end();
};

function startUpstream() {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch {}
      received.push({ method: req.method, url: req.url, headers: req.headers, raw, body: json });

      if (req.url.startsWith('/fail/v1/')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
      }
      if (req.method === 'GET' && req.url.startsWith('/flaky/v1/models/')) {
        // The first lookup fails; intact names the agy CLI from then on.
        if (flakyLookups++ === 0) { res.writeHead(503); return res.end('{}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ bifrost_ua: 'antigravity/cli/' }));
      }
      if (req.method === 'GET' && req.url.startsWith('/nf/v1/models/')) {
        // An intact that does not know the model yet (404), then knows it.
        if (notFoundLookups++ === 0) { res.writeHead(404); return res.end('{}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ bifrost_ua: 'antigravity/cli/' }));
      }
      if (req.url.startsWith('/flaky/v1/v1internal:') || req.url.startsWith('/nf/v1/v1internal:')) {
        return sse(res, [{ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'flaky bifrost' }] }, finishReason: 'STOP' }] }, traceId: 'f' }]);
      }
      if (req.url.startsWith('/flaky/v1/chat/completions') || req.url.startsWith('/nf/v1/chat/completions')) {
        return sse(res, [
          { choices: [{ index: 0, delta: { content: 'flaky converted' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        ]);
      }
      if (req.method === 'GET' && req.url.startsWith('/broken/v1/models/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ bifrost_ua: 'antigravity/cli/' }));
      }
      if (req.url.startsWith('/broken/v1/v1internal:')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"half"}]}}]}}\n\n');
        return setTimeout(() => res.socket.destroy(), 50);
      }
      if (req.url.startsWith('/google/v1internal:breakMidway')) {
        // Headers and part of a body, then the connection dies.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"partial":');
        return setTimeout(() => res.socket.destroy(), 50);
      }
      if (req.url.startsWith('/google/v1internal:stallMidway')) {
        // Headers and part of a body, then silence with the socket open.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"partial":');
        stalled.push(res);
        return;
      }
      if (req.url.startsWith('/google/v1internal:')) {
        if (req.url.includes('streamGenerateContent')) {
          return sse(res, [{ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'from google' }] }, finishReason: 'STOP' }] }, traceId: 'g' }]);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ answeredBy: 'google', path: req.url }));
      }
      if (req.method === 'GET' && req.url.startsWith('/intact/v1/models/')) {
        const id = decodeURIComponent(req.url.slice('/intact/v1/models/'.length));
        const ua = id.startsWith('antigravity/') ? 'antigravity/cli/' : id.startsWith('codex/') ? 'codex_cli_rs/' : '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id, ...(ua ? { bifrost_ua: ua } : {}) }));
      }
      if (req.url.startsWith('/intact/v1/v1internal:streamGenerateContent')) {
        return sse(res, [
          { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'pool answer' }] } }] }, traceId: 't' },
          { response: { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 3, thoughtsTokenCount: 2, cachedContentTokenCount: 30 } }, traceId: 't' }
        ]);
      }
      if (req.url.startsWith('/intact/v1/v1internal:generateContent')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts: [{ text: 'pool whole' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1 } }, traceId: 't' }));
      }
      if (req.url.startsWith('/intact/v1/chat/completions')) {
        // The convert route of intact: usage 9/2, never the 40/5 of the Bifrost answer.
        if (!json?.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ id: 'c2', object: 'chat.completion', model: json?.model, choices: [{ index: 0, message: { role: 'assistant', content: 'intact converted' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } }));
        }
        return sse(res, [
          { choices: [{ index: 0, delta: { content: 'intact converted' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } }
        ]);
      }
      if (req.url.startsWith('/intact/v1/responses')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`);
        return res.end();
      }
      if (req.url.startsWith('/chat/v1/chat/completions')) {
        const last = json?.messages?.at(-1);
        if (json?.tools?.length && last?.role === 'user') {
          return sse(res, [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_up_1', type: 'function', function: { name: 'view_file', arguments: '{"AbsolutePath":"/n"}' } }] } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 4 } }
          ]);
        }
        if (!json?.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: json.model, choices: [{ index: 0, message: { role: 'assistant', content: 'converted answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } }));
        }
        return sse(res, [
          { choices: [{ index: 0, delta: { content: 'converted answer' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2 } }
        ]);
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  return new Promise(r => upstream.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${upstream.address().port}`; r(); }));
}

before(async () => {
  await startUpstream();
  proxyPort = await freePort();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-switcher-agy-'));
  const cfg = {
    port: proxyPort,
    activeProfiles: { claude: null, codex: null, agy: 'agyb' },
    profiles: {
      agyb: { name: 'agy on intact', mode: 'convert', tool: 'agy', outFormat: 'openai-chat', baseURL: `${base}/intact/v1`, apiKey: 'sk-intact', defaultModels: { main: 'antigravity/*' } },
      agyc: { name: 'agy converted', mode: 'convert', tool: 'agy', outFormat: 'openai-chat', baseURL: `${base}/chat/v1`, apiKey: 'sk-chat', defaultModels: { main: 'gem/flash' } },
      agye: { name: 'agy empty slot', mode: 'convert', tool: 'agy', outFormat: 'openai-chat', baseURL: `${base}/chat/v1`, apiKey: 'sk-chat', defaultModels: {} },
      agy500: { name: 'agy failing upstream', mode: 'convert', tool: 'agy', outFormat: 'openai-chat', baseURL: `${base}/fail/v1`, apiKey: 'sk-fail', defaultModels: { main: 'gem/flash' } },
      agyf: { name: 'agy flaky lookup', mode: 'convert', tool: 'agy', outFormat: 'openai-chat', baseURL: `${base}/flaky/v1`, apiKey: 'sk-flaky', defaultModels: { main: 'antigravity/*' } },
      agynf: { name: 'agy lookup 404', mode: 'convert', tool: 'agy', outFormat: 'openai-chat', baseURL: `${base}/nf/v1`, apiKey: 'sk-nf', defaultModels: { main: 'antigravity/*' } },
      agyg: { name: 'agy broken stream', mode: 'convert', tool: 'agy', outFormat: 'openai-chat', baseURL: `${base}/broken/v1`, apiKey: 'sk-broken', defaultModels: { main: 'antigravity/*' } },
      cdx: { name: 'codex on intact', mode: 'convert', tool: 'codex', outFormat: 'openai-chat', baseURL: `${base}/intact/v1`, apiKey: 'sk-intact', defaultModels: { main: 'codex/gpt-5.5' } }
    }
  };
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(cfg, null, 2));
  proxy = spawn(process.execPath, [path.join(ROOT, 'proxy.mjs'), '--port', String(proxyPort)], {
    env: {
      ...process.env,
      LLM_SWITCHER_CONFIG: path.join(tmpDir, 'config.json'),
      LLM_SWITCHER_STATE_DIR: tmpDir,
      CLAUDE_CONFIG_DIR: path.join(tmpDir, 'claude'),
      LLM_SWITCHER_CODE_ASSIST_URL: `${base}/google`,
      LLM_SWITCHER_PORT: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  proxy.stdout.on('data', d => { log += d; });
  proxy.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${proxyPort}/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`proxy did not start:\n${log}`);
});

// Another gateway on the same config, with its own environment.
async function startGateway(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'proxy.mjs'), '--port', String(port)], {
    env: {
      ...process.env,
      LLM_SWITCHER_CONFIG: path.join(tmpDir, 'config.json'),
      LLM_SWITCHER_STATE_DIR: tmpDir,
      CLAUDE_CONFIG_DIR: path.join(tmpDir, 'claude'),
      LLM_SWITCHER_PORT: '',
      ...env
    },
    stdio: 'ignore'
  });
  extraGateways.push(child);
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return port; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('the extra gateway did not start');
}

after(() => {
  for (const g of extraGateways) g.kill();
  for (const r of stalled) r.socket?.destroy();
  proxy?.kill();
  upstream?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const url = (p) => `http://127.0.0.1:${proxyPort}${p}`;
const agyHeaders = (extra = {}) => ({ 'content-type': 'application/json', 'user-agent': AGY_UA, authorization: 'Bearer google-user-token', ...extra });
const envelope = (over = {}) => ({
  project: 'aicode-consumers', requestId: 'agent/s/1/t/1', model: 'gemini-3.8-flash-high', userAgent: 'antigravity', requestType: 'agent',
  request: {
    contents: [{ role: 'user', parts: [{ text: 'Read note' }] }],
    tools: [{ functionDeclarations: [{ name: 'view_file', description: 'View a file.', parameters: { type: 'OBJECT', properties: { AbsolutePath: { type: 'STRING' } }, required: ['AbsolutePath'] } }] }],
    generationConfig: { maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
    sessionId: '-1'
  },
  ...over
});
const lastTo = (prefix) => [...received].reverse().find(r => r.url.startsWith(prefix));
const dataLines = (text) => text.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5)));

test('agy side calls go to Google with the person\'s own token, bytes unchanged', async () => {
  const r = await fetch(url('/v1internal:loadCodeAssist'), { method: 'POST', headers: agyHeaders(), body: '{"metadata":{"ideType":"ANTIGRAVITY"}}' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).answeredBy, 'google');
  const got = lastTo('/google/v1internal:loadCodeAssist');
  assert.equal(got.headers.authorization, 'Bearer google-user-token');
  assert.equal(got.raw, '{"metadata":{"ideType":"ANTIGRAVITY"}}');
});

test('an agy checkpoint stays on Google even while a profile routes agy', async () => {
  const r = await fetch(url('/v1internal:streamGenerateContent?alt=sse'), { method: 'POST', headers: agyHeaders(), body: JSON.stringify(envelope({ requestType: 'checkpoint', model: 'gemini-3.5-flash-lite' })) });
  assert.match(await r.text(), /from google/);
  assert.equal(lastTo('/google/v1internal:streamGenerateContent').url, '/google/v1internal:streamGenerateContent?alt=sse');
});

test('agy agent turn crosses Bifrost: intact key, no Google token, the CLI model under antigravity/', async () => {
  const before = received.length;
  const r = await fetch(url('/v1internal:streamGenerateContent?alt=sse'), { method: 'POST', headers: agyHeaders(), body: JSON.stringify(envelope()) });
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.match(text, /pool answer/);
  const got = received.slice(before).find(x => x.url.startsWith('/intact/v1/v1internal:'));
  assert.ok(got, 'the agent turn must reach intact');
  assert.equal(got.url, '/intact/v1/v1internal:streamGenerateContent?alt=sse');
  assert.equal(got.headers['x-api-key'], 'sk-intact');
  assert.equal(got.headers.authorization, undefined, 'the Google token must never reach intact');
  assert.equal(got.headers['user-agent'], AGY_UA);
  assert.equal(got.body.model, 'antigravity/gemini-3.8-flash-high');
  assert.deepEqual(got.body.request, envelope().request);
  assert.equal(received.slice(before).some(x => x.url.startsWith('/google/')), false);
});

test('agy agent turn on a non-intact profile is converted and answered in Code Assist shape', async () => {
  const r = await fetch(url('/v1internal:streamGenerateContent?alt=sse'), { method: 'POST', headers: agyHeaders({ 'x-llm-profile': 'agyc' }), body: JSON.stringify(envelope()) });
  assert.equal(r.status, 200);
  const events = dataLines(await r.text());
  const up = lastTo('/chat/v1/chat/completions');
  assert.equal(up.body.model, 'gem/flash');
  assert.equal(up.headers.authorization, 'Bearer sk-chat');
  assert.equal(up.body.tools[0].function.parameters.properties.AbsolutePath.type, 'string');
  const call = events.flatMap(e => e.response?.candidates?.[0]?.content?.parts || []).find(p => p.functionCall);
  assert.deepEqual(call.functionCall, { id: 'call_up_1', name: 'view_file', args: { AbsolutePath: '/n' } });
  assert.ok(events.every(e => typeof e.traceId === 'string' && e.response), 'every chunk is wrapped as Code Assist does');
});

test('agy tool result in a model turn reaches the upstream as a tool message', async () => {
  const body = envelope({
    request: {
      ...envelope().request,
      contents: [
        { role: 'user', parts: [{ text: 'Read note' }] },
        { role: 'model', parts: [{ functionCall: { id: 'call_up_1', name: 'view_file', args: { AbsolutePath: '/n' } } }] },
        { role: 'model', parts: [{ functionResponse: { id: 'call_up_1', name: 'view_file', response: { output: 'line-one-marker' } } }] }
      ]
    }
  });
  const r = await fetch(url('/v1internal:generateContent'), { method: 'POST', headers: agyHeaders({ 'x-llm-profile': 'agyc' }), body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  const whole = await r.json();
  assert.match(JSON.stringify(whole.response), /converted answer/);
  const msgs = lastTo('/chat/v1/chat/completions').body.messages;
  const tool = msgs.find(m => m.role === 'tool');
  assert.equal(tool.tool_call_id, 'call_up_1');
  assert.equal(tool.content, 'line-one-marker');
});

test('Codex HTTP turn crosses Bifrost to intact when intact names the Codex CLI', async () => {
  const before = received.length;
  const body = { model: 'gpt-5.5', instructions: 'x', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], stream: true, store: false };
  const r = await fetch(url('/v1/responses'), { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': CODEX_UA, 'x-llm-profile': 'cdx', authorization: 'Bearer chatgpt-user-token' }, body: JSON.stringify(body) });
  assert.match(await r.text(), /response\.completed/);
  const got = received.slice(before).find(x => x.url.startsWith('/intact/v1/responses'));
  assert.ok(got, 'the turn must reach intact /responses unchanged');
  assert.equal(got.headers['x-api-key'], 'sk-intact');
  assert.equal(got.headers.authorization, undefined);
  assert.equal(got.body.model, 'codex/gpt-5.5');
  assert.deepEqual(got.body.input, body.input);
});

test('an agy turn whose client is not the CLI keeps the convert route on intact', async () => {
  const before = received.length;
  const r = await fetch(url('/v1internal:streamGenerateContent?alt=sse'), { method: 'POST', headers: agyHeaders({ 'user-agent': 'curl/8' }), body: JSON.stringify(envelope()) });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /intact converted/);
  const mine = received.slice(before);
  assert.ok(mine.some(x => x.url.startsWith('/intact/v1/chat/completions')), 'the convert route of intact took the turn');
  assert.equal(mine.some(x => x.url.startsWith('/intact/v1/v1internal:')), false, 'no Bifrost request for another client');
});

test('a Codex turn whose client is not the Codex CLI keeps the convert route', async () => {
  const before = received.length;
  const body = { model: 'gpt-5.5', instructions: 'x', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], stream: true, store: false };
  const r = await fetch(url('/v1/responses'), { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'curl/8', 'x-llm-profile': 'cdx' }, body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  await r.text();
  const mine = received.slice(before);
  assert.ok(mine.some(x => x.url.startsWith('/intact/v1/chat/completions')), 'the convert route took the turn');
  assert.equal(mine.some(x => x.url.startsWith('/intact/v1/responses')), false);
});

test('the inspector reads the Gemini usage of a Bifrost agy turn', async () => {
  const r = await fetch(url('/v1internal:streamGenerateContent?alt=sse'), { method: 'POST', headers: agyHeaders(), body: JSON.stringify(envelope({ requestId: 'agent/s/1/t/usage' })) });
  await r.text();
  const token = fs.readFileSync(path.join(tmpDir, 'admin.token'), 'utf8').trim();
  const { logs } = await (await fetch(url('/api/logs'), { headers: { 'x-llm-switcher-token': token } })).json();
  const entry = logs.find(l => l.clientFormat === 'codeassist' && l.outFormat === 'bifrost' && l.profile === 'agyb');
  assert.ok(entry, 'the Bifrost agy turn is in the inspector');
  assert.deepEqual(entry.tokens, { prompt: 40, completion: 5 });
});

test('a non-streaming agy turn crosses Bifrost at the generateContent path', async () => {
  const before = received.length;
  const r = await fetch(url('/v1internal:generateContent'), { method: 'POST', headers: agyHeaders(), body: JSON.stringify(envelope()) });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /pool whole/);
  assert.ok(received.slice(before).some(x => x.url === '/intact/v1/v1internal:generateContent'));
});

test('a Code Assist host that cannot be reached gives a 502 in the Code Assist error shape', async () => {
  const closed = await freePort();
  const port = await startGateway({ LLM_SWITCHER_CODE_ASSIST_URL: `http://127.0.0.1:${closed}` });
  const r = await fetch(`http://127.0.0.1:${port}/v1internal:loadCodeAssist`, { method: 'POST', headers: agyHeaders(), body: '{}' });
  assert.equal(r.status, 502);
  assert.equal(typeof (await r.json()).error.status, 'string');
});

test('a Code Assist host that never answers gives a 504 after the idle timeout', async () => {
  const silent = net.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise(r => silent.once('listening', r));
  try {
    const port = await startGateway({ LLM_SWITCHER_CODE_ASSIST_URL: `http://127.0.0.1:${silent.address().port}`, LLM_SWITCHER_CODE_ASSIST_TIMEOUT_MS: '1000' });
    const started = Date.now();
    const r = await fetch(`http://127.0.0.1:${port}/v1internal:loadCodeAssist`, { method: 'POST', headers: agyHeaders(), body: '{}' });
    assert.equal(r.status, 504);
    assert.equal(typeof (await r.json()).error.status, 'string');
    assert.ok(Date.now() - started < 8000);
  } finally {
    silent.close();
  }
});

test('an upstream that stops in the middle of a body ends the answer to agy with an error', async () => {
  const started = Date.now();
  const r = await fetch(url('/v1internal:breakMidway'), { method: 'POST', headers: agyHeaders(), body: '{}' });
  await assert.rejects(r.text());
  assert.ok(Date.now() - started < 10000);
});

test('an upstream that stalls after its headers is cut by the idle timeout', async () => {
  const port = await startGateway({ LLM_SWITCHER_CODE_ASSIST_URL: `${base}/google`, LLM_SWITCHER_CODE_ASSIST_TIMEOUT_MS: '1000' });
  const started = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/v1internal:stallMidway`, { method: 'POST', headers: agyHeaders(), body: '{}' });
  await assert.rejects(r.text());
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test('a timeout value that Node cannot hold falls back to the default, so calls still pass', async () => {
  for (const value of ['3000000000', 'abc']) {
    const port = await startGateway({ LLM_SWITCHER_CODE_ASSIST_URL: `${base}/google`, LLM_SWITCHER_CODE_ASSIST_TIMEOUT_MS: value });
    const r = await fetch(`http://127.0.0.1:${port}/v1internal:loadCodeAssist`, { method: 'POST', headers: agyHeaders(), body: '{}' });
    assert.equal(r.status, 200, `timeout ${value}`);
    assert.equal((await r.json()).answeredBy, 'google');
  }
});

test('an agy turn with no model and a * slot gets a 400, not a request for model ""', async () => {
  const before = received.length;
  const r = await fetch(url('/v1internal:streamGenerateContent?alt=sse'), { method: 'POST', headers: agyHeaders(), body: JSON.stringify(envelope({ model: '' })) });
  assert.equal(r.status, 400);
  assert.equal(typeof (await r.json()).error.status, 'string');
  assert.equal(received.slice(before).some(x => x.url.startsWith('/intact/') && x.method === 'POST'), false);
});

test('an agy profile with no main slot sends the model that agy picked', async () => {
  const r = await fetch(url('/v1internal:streamGenerateContent?alt=sse'), { method: 'POST', headers: agyHeaders({ 'x-llm-profile': 'agye' }), body: JSON.stringify(envelope({ request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } })) });
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(lastTo('/chat/v1/chat/completions').body.model, 'gemini-3.8-flash-high');
});

test('a converted agy turn whose upstream fails gets the Code Assist error shape', async () => {
  const r = await fetch(url('/v1internal:generateContent'), { method: 'POST', headers: agyHeaders({ 'x-llm-profile': 'agy500' }), body: JSON.stringify(envelope()) });
  assert.ok(r.status >= 500, `status ${r.status}`);
  const body = await r.json();
  assert.equal(typeof body.error.status, 'string');
  assert.equal(typeof body.error.message, 'string');
});

test('a body that does not parse, while agy is routed, gets a 400 and never reaches Google', async () => {
  const before = received.length;
  const r = await fetch(url('/v1internal:streamGenerateContent?alt=sse'), { method: 'POST', headers: agyHeaders(), body: '{"requestType":"agent",' });
  assert.equal(r.status, 400);
  assert.equal(typeof (await r.json()).error.status, 'string');
  assert.equal(received.slice(before).some(x => x.url.startsWith('/google/')), false);
});

test('a gateway that never loaded its config answers agy model calls with 503', async () => {
  const bad = path.join(tmpDir, 'broken-config.json');
  fs.writeFileSync(bad, '{ "profiles": ');
  const port = await startGateway({ LLM_SWITCHER_CONFIG: bad, LLM_SWITCHER_CODE_ASSIST_URL: `${base}/google` });
  const before = received.length;
  const r = await fetch(`http://127.0.0.1:${port}/v1internal:streamGenerateContent?alt=sse`, { method: 'POST', headers: agyHeaders(), body: JSON.stringify(envelope()) });
  assert.equal(r.status, 503);
  assert.equal(typeof (await r.json()).error.status, 'string');
  assert.equal(received.slice(before).some(x => x.url.startsWith('/google/')), false);
});

test('an agy model call with no requestType stays on Google', async () => {
  const body = envelope();
  delete body.requestType;
  const r = await fetch(url('/v1internal:streamGenerateContent?alt=sse'), { method: 'POST', headers: agyHeaders(), body: JSON.stringify(body) });
  assert.match(await r.text(), /from google/);
});

test('a GET to a Code Assist method passes through to Google', async () => {
  const r = await fetch(url('/v1internal:fetchUserInfo?x=1'), { headers: agyHeaders() });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).answeredBy, 'google');
  const got = lastTo('/google/v1internal:fetchUserInfo');
  assert.equal(got.method, 'GET');
  assert.equal(got.url, '/google/v1internal:fetchUserInfo?x=1');
});

test('the passthrough keeps the Google headers of agy and drops only the gateway control headers', async () => {
  await fetch(url('/v1internal:loadCodeAssist'), {
    method: 'POST',
    headers: agyHeaders({ 'x-goog-api-client': 'gl-go/1.24', 'x-goog-user-project': 'proj-7', 'x-llm-profile': 'agyc', 'x-forwarded-for': '10.0.0.9', 'x-forwarded-server': 'edge', 'x-real-ip': '10.0.0.9' }),
    body: '{}'
  });
  const got = lastTo('/google/v1internal:loadCodeAssist');
  assert.equal(got.headers['x-goog-api-client'], 'gl-go/1.24');
  assert.equal(got.headers['x-goog-user-project'], 'proj-7');
  assert.equal(got.headers['x-llm-profile'], undefined);
  assert.equal(got.headers['x-forwarded-for'], undefined);
  assert.equal(got.headers['x-forwarded-server'], undefined, 'every x-forwarded-* header goes');
  assert.equal(got.headers['x-real-ip'], undefined);
});

test('the inspector reads the usage of a non-streaming Bifrost agy turn', async () => {
  const r = await fetch(url('/v1internal:generateContent'), { method: 'POST', headers: agyHeaders(), body: JSON.stringify(envelope({ requestId: 'agent/s/1/t/whole-usage' })) });
  await r.text();
  const token = fs.readFileSync(path.join(tmpDir, 'admin.token'), 'utf8').trim();
  const { logs } = await (await fetch(url('/api/logs'), { headers: { 'x-llm-switcher-token': token } })).json();
  const entry = logs.find(l => l.clientFormat === 'codeassist' && l.outFormat === 'bifrost' && l.profile === 'agyb' && l.stream === false);
  assert.ok(entry, 'the non-streaming Bifrost turn is in the inspector');
  assert.deepEqual(entry.tokens, { prompt: 7, completion: 1 });
});

test('a failed Bifrost lookup is retried soon, not pinned for ten minutes', async () => {
  flakyLookups = 0; // the first lookup of this test fails, whatever ran before
  const port = await startGateway({ LLM_SWITCHER_CODE_ASSIST_URL: `${base}/google`, LLM_SWITCHER_BIFROST_RETRY_MS: '200' });
  const send = async () => (await fetch(`http://127.0.0.1:${port}/v1internal:streamGenerateContent?alt=sse`, { method: 'POST', headers: agyHeaders({ 'x-llm-profile': 'agyf' }), body: JSON.stringify(envelope()) })).text();
  assert.match(await send(), /flaky converted/);
  await new Promise(r => setTimeout(r, 400));
  assert.match(await send(), /flaky bifrost/);
});

test('a Bifrost lookup that answers 404 is retried soon too', async () => {
  notFoundLookups = 0;
  const port = await startGateway({ LLM_SWITCHER_CODE_ASSIST_URL: `${base}/google`, LLM_SWITCHER_BIFROST_RETRY_MS: '200' });
  const send = async () => (await fetch(`http://127.0.0.1:${port}/v1internal:streamGenerateContent?alt=sse`, { method: 'POST', headers: agyHeaders({ 'x-llm-profile': 'agynf' }), body: JSON.stringify(envelope()) })).text();
  assert.match(await send(), /flaky converted/);
  await new Promise(r => setTimeout(r, 400));
  assert.match(await send(), /flaky bifrost/);
});

test('an agent turn that names a profile that does not exist gets a 400, never Google', async () => {
  const before = received.length;
  const r = await fetch(url('/v1internal:streamGenerateContent?alt=sse'), { method: 'POST', headers: agyHeaders({ 'x-llm-profile': 'no-such-profile' }), body: JSON.stringify(envelope()) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /no-such-profile/);
  assert.equal(received.slice(before).some(x => x.url.startsWith('/google/')), false);
});

test('a Bifrost stream that breaks ends the answer to agy with an error, not a clean end', async () => {
  const r = await fetch(url('/v1internal:streamGenerateContent?alt=sse'), { method: 'POST', headers: agyHeaders({ 'x-llm-profile': 'agyg' }), body: JSON.stringify(envelope()) });
  assert.equal(r.status, 200);
  await assert.rejects(r.text());
});

test('with agy switched off, its agent turns go back to Google', async (t) => {
  const token = fs.readFileSync(path.join(tmpDir, 'admin.token'), 'utf8').trim();
  const switchAgy = (profile) => fetch(url('/api/switch'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-llm-switcher-token': token }, body: JSON.stringify({ target: 'agy', profile }) });
  // Put agy back, so a test added after this one still finds it routed.
  t.after(async () => { await switchAgy('agyb'); });
  const off = await switchAgy(null);
  assert.equal(off.status, 200, await off.text());
  const before = received.length;
  const r = await fetch(url('/v1internal:streamGenerateContent?alt=sse'), { method: 'POST', headers: agyHeaders(), body: JSON.stringify(envelope()) });
  assert.match(await r.text(), /from google/);
  assert.equal(received.slice(before).some(x => x.url.startsWith('/intact/')), false);
});
