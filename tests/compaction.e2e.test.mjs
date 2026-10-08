import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openResponsesWs } from './ws-client.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function until(check) { const deadline = Date.now() + 6000; while (Date.now() < deadline) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('timeout'); }
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-compaction-'));
  const received = []; let finish = 'stop', truncate = false;
  const up = http.createServer((req, res) => {
    let raw = ''; req.on('data', b => raw += b); req.on('end', () => {
      if (req.method === 'GET') return res.end('{"data":[]}');
      const body = JSON.parse(raw); received.push(body);
      const summary = 'KEEP_DECISION_7391';
      if (body.stream) {
        res.setHeader('content-type', 'text/event-stream');
        res.write(`data: {"choices":\ndata: [{"index":0,"delta":{"content":"${summary}"}}]}\n\n`);
        if (!truncate) res.write(`data: {"choices":[{"index":0,"delta":{},"finish_reason":"${finish}"}]}\n\ndata: [DONE]\n\n`);
        res.end();
      } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: summary }, finish_reason: finish }] })); }
    });
  }); await listen(up);
  const reserve = http.createServer(); await listen(reserve); const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const config = path.join(dir, 'config.json'); fs.writeFileSync(config, JSON.stringify({ port, profiles: {
    p1: { name: 'Offline', mode: 'convert', outFormat: 'openai-chat', baseURL: `http://127.0.0.1:${up.address().port}/v1`, apiKey: 'fixture-only' }
  } }));
  const child = spawn(process.execPath, [path.join(root, 'proxy.mjs')], { env: { ...process.env,
    LLM_SWITCHER_CONFIG: config, LLM_SWITCHER_STATE_DIR: dir, LLM_SWITCHER_PORT: '', LLM_SWITCHER_REGISTRY_URL: 'http://127.0.0.1:9/' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
  t.after(async () => {
    if (child.exitCode === null) { const done = new Promise(r => child.once('exit', r)); child.kill(); await done; }
    up.closeAllConnections?.(); await new Promise(r => up.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await until(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.ok);
  const send = body => fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-profile': 'p1' }, body: JSON.stringify(body) });
  return { port, received, send, failure: (reason, cut = false) => { finish = reason; truncate = cut; }, logs: () => logs };
}
const trigger = stream => ({ model: 'm', stream, input: [{ role: 'user', content: 'ORIGINAL_HISTORY' }, { type: 'compaction_trigger' }] });
const events = text => text.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));

test('HTTP compaction produces one item, replays it, and can compact the replay again', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  for (const stream of [false, true]) {
    const first = await f.send(trigger(stream)); assert.equal(first.status, 200, f.logs());
    const response = stream ? events(await first.text()).find(e => e.type === 'response.completed').response : await first.json();
    assert.equal(response.output.length, 1); assert.equal(response.output[0].type, 'compaction');
    const replay = await f.send({ model: 'm', input: [response.output[0], { role: 'user', content: 'continue' }] });
    assert.equal(replay.status, 200, await replay.text());
    assert.match(JSON.stringify(f.received.at(-1).messages), /KEEP_DECISION_7391.*continue/);
    const again = await f.send({ ...trigger(false), input: [response.output[0], { type: 'compaction_trigger' }] });
    assert.equal(again.status, 200, await again.text());
    assert.match(JSON.stringify(f.received.at(-1).messages), /KEEP_DECISION_7391/);
    assert.doesNotMatch(JSON.stringify(f.received.at(-1)), /encrypted_content|compaction_trigger/);
  }
});
test('HTTP compaction rejects token-limit and prematurely ended summaries', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  f.failure('length'); assert.equal((await f.send(trigger(false))).status, 502);
  f.failure('stop', true); const r = await f.send(trigger(true)); assert.equal(r.status, 502);
  assert.doesNotMatch(await r.text(), /encrypted_content/);
});
test('WS compaction replays the compacted state through previous_response_id', { timeout: 20000 }, async t => {
  const f = await fixture(t); const ws = await openResponsesWs(f.port, { 'x-profile': 'p1' }); t.after(ws.close);
  ws.send({ type: 'response.create', ...trigger(true) });
  await until(() => ws.messages.some(m => ['response.completed', 'response.failed'].includes(m.type)));
  const completed = ws.messages.find(m => m.type === 'response.completed'); assert.ok(completed, JSON.stringify(ws.messages));
  assert.equal(ws.messages.filter(m => m.type === 'response.output_item.done' && m.item.type === 'compaction').length, 1);
  ws.send({ type: 'response.create', model: 'm', previous_response_id: completed.response.id, input: [{ role: 'user', content: 'NEXT_TURN' }] });
  await until(() => f.received.length === 2);
  assert.match(JSON.stringify(f.received.at(-1).messages), /KEEP_DECISION_7391.*NEXT_TURN/);
  assert.doesNotMatch(JSON.stringify(f.received.at(-1).messages), /ORIGINAL_HISTORY/);
});
