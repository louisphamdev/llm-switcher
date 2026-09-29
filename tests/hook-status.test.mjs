// The launch hook: what a coding tool shows the person about the switcher at the start of a session.
//
// The shim toast fires only when the shim runs, and it needs the shim directory first on PATH. A
// hook runs inside the tool itself, so it reports even when the launcher is the person's own script.
// Both tools read one JSON object from stdout and show `systemMessage` to the person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'hook-status.mjs');
const { identityProof } = await import(pathToFileURL(path.join(ROOT, 'state.mjs')).href);

function tmpState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The proof is an HMAC over the admin token, so the fake gateway needs the same file.
  fs.writeFileSync(path.join(dir, 'admin.token'), 'tok-for-the-hook-test', { mode: 0o600 });
  return dir;
}

function writeConfig(dir, port) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    port,
    activeProfiles: { claude: 'cl', codex: null },
    profiles: {
      cl: {
        name: 'Intact Claude', baseURL: 'https://intact.example.io/v1', apiKey: 'sk-secret',
        defaultModels: { opus: 'gemini-3.8-flash' }, model1M: { opus: true }
      }
    }
  }), { mode: 0o600 });
}

// A gateway of this build: it answers /health with a proof over the challenge.
function fakeGateway(t, port) {
  const srv = http.createServer((req, res) => {
    const nonce = new URL(req.url, 'http://127.0.0.1').searchParams.get('challenge') || '';
    const body = { proxy: 'llm-switcher', port, pid: process.pid };
    body.proof = identityProof(nonce, { role: 'gateway', port, pid: body.pid }, 'tok-for-the-hook-test');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => {
    t.after(() => new Promise(r => srv.close(r)));
    resolve(srv);
  }));
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function runHook(dir, tool) {
  const out = execFileSync(process.execPath, [HOOK, tool], {
    encoding: 'utf8', timeout: 20000,
    env: {
      ...process.env,
      LLM_SWITCHER_STATE_DIR: dir,
      LLM_SWITCHER_CONFIG: path.join(dir, 'config.json'),
      LLM_SWITCHER_PORT: ''
    }
  });
  return { raw: out, json: JSON.parse(out.trim() || '{}') };
}

test('a tool that is not routed gets no message at all', async (t) => {
  const dir = tmpState(t);
  writeConfig(dir, await freePort());
  // codex has no profile, so its route file is empty. This is the state after `switch off codex`.
  fs.writeFileSync(path.join(dir, 'active.flag'), 'active');
  fs.writeFileSync(path.join(dir, 'route-codex.txt'), '');
  const r = runHook(dir, 'codex');
  assert.equal(r.json.systemMessage, undefined, 'a tool on its official endpoint says nothing');
});

test('a routed tool with a live gateway reports where its traffic goes', async (t) => {
  const dir = tmpState(t);
  const port = await freePort();
  writeConfig(dir, port);
  await fakeGateway(t, port);
  fs.writeFileSync(path.join(dir, 'active.flag'), 'active');
  fs.writeFileSync(path.join(dir, 'route-claude.txt'), 'claude -> cl | intact.example.io | gemini-3.8-flash | 1M\n');
  const r = runHook(dir, 'claude');
  assert.match(r.json.systemMessage, /LLM Switcher/, 'the message names the switcher');
  assert.match(r.json.systemMessage, /intact\.example\.io/, 'and the host the traffic goes to');
  assert.match(r.json.systemMessage, /gemini-3\.8-flash/, 'and the model');
  assert.doesNotMatch(r.json.systemMessage, /sk-secret/, 'and never the API key');
});

test('a routed tool with a dead gateway is warned that it cannot reach the provider', async (t) => {
  const dir = tmpState(t);
  const port = await freePort();   // nothing listens on it
  writeConfig(dir, port);
  fs.writeFileSync(path.join(dir, 'active.flag'), 'active');
  fs.writeFileSync(path.join(dir, 'route-claude.txt'), 'claude -> cl | intact.example.io | gemini-3.8-flash | 1M\n');
  const r = runHook(dir, 'claude');
  assert.match(r.json.systemMessage, /does not answer|not running/i, 'the message says the gateway is down');
  assert.match(r.json.systemMessage, new RegExp(String(port)), 'and names the port');
  assert.match(r.json.systemMessage, /switch on/, 'and names the command that fixes it');
});

test('a broken state never fails the session: exit 0 and parseable output', async (t) => {
  const dir = tmpState(t);
  fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'active.flag'), 'active');
  const r = runHook(dir, 'claude');
  assert.equal(typeof r.json, 'object', 'the tool still gets one JSON object');
  const bad = runHook(dir, 'not-a-tool');
  assert.equal(bad.json.systemMessage, undefined, 'an unknown tool name says nothing');
});
