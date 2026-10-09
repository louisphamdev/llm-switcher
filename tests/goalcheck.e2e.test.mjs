import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

async function until(check, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('timeout waiting for condition');
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-goalcheck-'));
  const adminToken = 'admin-secret-token-123';
  fs.writeFileSync(path.join(dir, 'admin.token'), adminToken, { mode: 0o600 });

  let nativeVerdict = { ok: true, reason: 'looks complete' };
  let jevScores = { complete: 0.14, evidence: 0.84, unfinished: 0.63 };
  let jevStatus = 200;

  // Mock native upstream (Anthropic format)
  const nativeUp = http.createServer((req, res) => {
    let raw = '';
    req.on('data', b => raw += b);
    req.on('end', () => {
      if (req.method !== 'POST' || !raw.trim()) {
        res.setHeader('content-type', 'application/json');
        return res.end('{"data":[]}');
      }
      const body = JSON.parse(raw);
      const isStream = Boolean(body.stream);
      const respText = JSON.stringify(nativeVerdict);

      if (isStream) {
        res.setHeader('content-type', 'text/event-stream');
        res.write(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-3-haiku","content":[],"usage":{"input_tokens":10,"output_tokens":5}}}\n\n`);
        res.write(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`);
        res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(respText)}}}\n\n`);
        res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
        res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n`);
        res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        res.end();
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-3-haiku',
          content: [{ type: 'text', text: respText }],
          stop_reason: 'end_turn'
        }));
      }
    });
  });
  await listen(nativeUp);

  // Mock Jev decision upstream
  let jevRequests = [];
  const jevUp = http.createServer((req, res) => {
    let raw = '';
    req.on('data', b => raw += b);
    req.on('end', () => {
      if (req.method === 'POST') {
        jevRequests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
      }
      if (jevStatus !== 200) {
        res.statusCode = jevStatus;
        return res.end('error');
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'typesafe/jev-latest',
        answers: {
          complete: { type: 'noul', noul: jevScores.complete },
          evidence: { type: 'noul', noul: jevScores.evidence },
          unfinished: { type: 'noul', noul: jevScores.unfinished }
        }
      }));
    });
  });
  await listen(jevUp);

  const reserve = http.createServer();
  await listen(reserve);
  const port = reserve.address().port;
  await new Promise(r => reserve.close(r));

  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port,
    activeProfile: 'p1',
    activeProfiles: { claude: 'p1' },
    profiles: {
      p1: {
        name: 'NativeMock',
        mode: 'direct',
        tool: 'claude',
        inFormat: 'auto',
        outFormat: 'anthropic',
        baseURL: `http://127.0.0.1:${nativeUp.address().port}`,
        apiKey: 'sk-native-key'
      }
    },
    goalCheck: {
      enabled: false,
      backend: 'jev',
      baseURL: `http://127.0.0.1:${jevUp.address().port}`,
      apiKey: 'jev-test-key',
      model: 'typesafe/jev-latest',
      completeMin: 0.90,
      evidenceMin: 0.85,
      unfinishedMax: 0.10
    }
  }));

  const child = spawn(process.execPath, [path.join(root, 'proxy.mjs')], {
    env: {
      ...process.env,
      LLM_SWITCHER_CONFIG: configPath,
      LLM_SWITCHER_STATE_DIR: dir,
      LLM_SWITCHER_PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let logs = '';
  child.stdout.on('data', b => logs += b);
  child.stderr.on('data', b => logs += b);

  t.after(async () => {
    if (child.exitCode === null) {
      const done = new Promise(r => child.once('exit', r));
      child.kill();
      await done;
    }
    nativeUp.closeAllConnections?.();
    jevUp.closeAllConnections?.();
    await Promise.all([
      new Promise(r => nativeUp.close(r)),
      new Promise(r => jevUp.close(r))
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await until(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.ok);

  const adminHeaders = {
    'x-llm-switcher-token': adminToken,
    'content-type': 'application/json'
  };

  const sendAdmin = (path, method = 'GET', body = null) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: adminHeaders,
    body: body ? JSON.stringify(body) : undefined
  });

  const sendClaude = (body, stream = false) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'claude-cli/2.1.295'
    },
    body: JSON.stringify({ ...body, stream })
  });

  return {
    port,
    sendAdmin,
    sendClaude,
    setNativeVerdict: v => { nativeVerdict = v; },
    setJevScores: s => { jevScores = s; },
    setJevStatus: st => { jevStatus = st; },
    jevRequests,
    logs: () => logs
  };
}

const evaluatorRequest = {
  model: 'claude-3-haiku-20240307',
  system: 'You are evaluating a stop-condition hook in Claude Code. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.',
  messages: [
    { role: 'user', content: 'Please fix the failing tests in repo.' },
    { role: 'assistant', content: 'I have edited the code and reports.' },
    {
      role: 'user',
      content: 'Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.\n\nCondition: Fix all failing tests.'
    }
  ],
  tools: []
};

test('goalcheck e2e: admin API endpoints and probe', async t => {
  const f = await fixture(t);

  // 1. GET /api/goal-check
  const r1 = await f.sendAdmin('/api/goal-check');
  assert.equal(r1.status, 200);
  const data1 = await r1.json();
  assert.equal(data1.goalCheck.enabled, false);
  assert.equal(data1.goalCheck.apiKey, '__LLM_SWITCHER_KEEP_KEY__');
  assert.equal(data1.goalCheck.hasApiKey, true);
  assert.equal(data1.status.configured, true);

  // 2. POST /api/goal-check/test (Probe)
  const probeRes = await f.sendAdmin('/api/goal-check/test', 'POST', {
    model: 'typesafe/jev-latest'
  });
  assert.equal(probeRes.status, 200);
  const probeData = await probeRes.json();
  assert.equal(probeData.ok, true);
  assert.ok(probeData.message.includes('Connected successfully'));

  // 3. POST /api/goal-check (enable feature)
  const updateRes = await f.sendAdmin('/api/goal-check', 'POST', {
    enabled: true,
    completeMin: 0.90
  });
  assert.equal(updateRes.status, 200);
  const updateData = await updateRes.json();
  assert.equal(updateData.goalCheck.enabled, true);
  assert.equal(updateData.status.enabled, true);

  // 4. GET /api/goal-check/logs
  const logsRes = await f.sendAdmin('/api/goal-check/logs');
  assert.equal(logsRes.status, 200);
  const logsData = await logsRes.json();
  assert.ok(Array.isArray(logsData.logs));
});

test('goalcheck e2e: live interception, veto, and allow behaviors', async t => {
  const f = await fixture(t);

  // Case A: Feature is OFF -> passes through untouched
  f.setNativeVerdict({ ok: true, reason: 'native pass' });
  const offRes = await f.sendClaude(evaluatorRequest, false);
  assert.equal(offRes.status, 200);
  const offJson = await offRes.json();
  const offVerdict = JSON.parse(offJson.content[0].text);
  assert.equal(offVerdict.ok, true);
  assert.equal(offVerdict.reason, 'native pass');
  assert.equal(f.jevRequests.length, 0); // Jev was not called!

  // Enable Goal Check
  await f.sendAdmin('/api/goal-check', 'POST', { enabled: true });

  // Case B: Feature is ON -> Native passes, but Jev has low complete score (0.14) -> VETOED!
  f.setJevScores({ complete: 0.14, evidence: 0.84, unfinished: 0.63 });
  f.setNativeVerdict({ ok: true, reason: 'audit report PASS' });

  // Test Non-streaming JSON
  const vetoRes = await f.sendClaude(evaluatorRequest, false);
  assert.equal(vetoRes.status, 200);
  const vetoJson = await vetoRes.json();
  const vetoVerdict = JSON.parse(vetoJson.content[0].text);
  assert.equal(vetoVerdict.ok, false);
  assert.match(vetoVerdict.reason, /Jev has not confirmed full completion/);
  assert.match(vetoVerdict.reason, /complete=0.14/);
  assert.equal(f.jevRequests.length, 1); // Jev was called!

  // Test SSE streaming: verify valid event stream and vetoed result
  const sseRes = await f.sendClaude(evaluatorRequest, true);
  assert.equal(sseRes.status, 200);
  assert.ok(sseRes.headers.get('content-type').includes('text/event-stream'));
  const sseText = await sseRes.text();
  assert.ok(sseText.includes('event: message_start'));
  assert.ok(sseText.includes('event: content_block_delta'));
  assert.ok(sseText.includes('event: message_stop'));
  assert.ok(!sseText.includes('\\"ok\\":true')); // NEVER sends ok:true!
  assert.ok(sseText.includes('\\"ok\\":false'));

  // Case C: Feature is ON -> Native passes AND Jev scores pass all thresholds -> ALLOWED!
  f.setJevScores({ complete: 0.95, evidence: 0.90, unfinished: 0.05 });
  const allowRes = await f.sendClaude(evaluatorRequest, false);
  assert.equal(allowRes.status, 200);
  const allowJson = await allowRes.json();
  const allowVerdict = JSON.parse(allowJson.content[0].text);
  assert.equal(allowVerdict.ok, true);
  assert.equal(allowVerdict.reason, 'audit report PASS');

  // Case D: Native rejects (ok: false) -> preserves native rejection
  f.setNativeVerdict({ ok: false, reason: 'test command exited 1' });
  const rejectRes = await f.sendClaude(evaluatorRequest, false);
  assert.equal(rejectRes.status, 200);
  const rejectJson = await rejectRes.json();
  const rejectVerdict = JSON.parse(rejectJson.content[0].text);
  assert.equal(rejectVerdict.ok, false);
  assert.equal(rejectVerdict.reason, 'test command exited 1');

  // Case E: Jev unavailable (HTTP 502) -> fails closed
  f.setNativeVerdict({ ok: true, reason: 'claimed done' });
  f.setJevStatus(502);
  const failRes = await f.sendClaude(evaluatorRequest, false);
  assert.equal(failRes.status, 200);
  const failJson = await failRes.json();
  const failVerdict = JSON.parse(failJson.content[0].text);
  assert.equal(failVerdict.ok, false);
  assert.match(failVerdict.reason, /Goal Check verification unavailable/);

  // Check logs endpoint recorded the checks
  const logsRes = await f.sendAdmin('/api/goal-check/logs');
  const logsData = await logsRes.json();
  assert.ok(logsData.logs.length >= 4);
  assert.equal(logsData.logs[0].verdictType, 'Unavailable');
});
