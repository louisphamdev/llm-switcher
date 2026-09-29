// A real gateway on its own data directory, a stand-in upstream, and a stand-in interceptor.
// The dashboard tests open this gateway in a browser, so nothing here may touch the real home
// directory, the real Codex daemon, the real npm registry or a real interceptor.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

const MODELS = { opus: 'up-opus', sonnet: 'up-sonnet', haiku: 'up-haiku' };

// The starting point of every test. Two profiles that each serve one tool and one that serves
// both, with Claude and Codex each on their own profile: the state in the Deactivate bug report.
export function baselineConfig(port, blindfoldPort, upstreamBase) {
  return {
    port,
    blindfold: { port: blindfoldPort },
    activeProfiles: { claude: 'intact-claude', codex: 'intact-codex' },
    profiles: {
      'intact-claude': { name: 'Intact Claude', mode: 'convert', tool: 'claude', outFormat: 'openai-chat', baseURL: `${upstreamBase}/chat/v1`, apiKey: 'sk-secret-claude', defaultModels: { ...MODELS } },
      'intact-codex': { name: 'Intact Codex', mode: 'convert', tool: 'codex', inFormat: 'responses', outFormat: 'openai-chat', baseURL: `${upstreamBase}/chat/v1`, apiKey: 'sk-secret-codex', defaultModels: { main: 'up-main', review: 'up-review' } },
      shared: { name: 'Shared Router', mode: 'convert', tool: null, outFormat: 'openai-chat', baseURL: `${upstreamBase}/chat/v1`, apiKey: 'sk-secret-shared', defaultModels: { ...MODELS } }
    }
  };
}

export async function startDashboardFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsw-dashboard-'));
  const cfgPath = path.join(dir, 'config.json');
  const received = [];
  // 'ok' answers like a healthy provider; 'deny' answers 401; 'down' answers 503.
  const upstream = { mode: 'ok', received, models: ['up-alpha', 'up-beta', 'up-gamma'], latest: '99.0.0' };

  const upstreamServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url.startsWith('/registry')) return json(200, { version: upstream.latest });
      if (upstream.mode === 'deny') return json(401, { error: { message: 'bad key' } });
      if (upstream.mode === 'down') return json(503, { error: { message: 'upstream is down' } });
      if (req.url.endsWith('/models')) {
        return json(200, { data: upstream.models.map(id => ({ id, context_length: id === 'up-alpha' ? 200000 : 1000000 })) });
      }
      if (req.url.includes('/chat/completions')) {
        return json(200, { id: 'c1', object: 'chat.completion', model: 'up', choices: [{ index: 0, message: { role: 'assistant', content: 'Final answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
      }
      return json(404, { error: 'not found' });
    });
  });
  await new Promise(r => upstreamServer.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstreamServer.address().port}`;

  const port = await freePort();
  const blindfoldPort = await freePort();
  fs.writeFileSync(cfgPath, JSON.stringify(baselineConfig(port, blindfoldPort, upstreamBase), null, 2));

  // The model lists that Claude Code and Codex keep for the signed-in account. With both present the
  // catalog reads them from disk and never asks the official endpoints.
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'cache', 'model-catalog'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'cache', 'model-catalog', 'account.json'), JSON.stringify({
    fetchedAt: 1,
    catalog: { config: { models: [{ id: 'claude-opus-4-6', name: 'Opus' }, { id: 'claude-sonnet-4-6', name: 'Sonnet' }, { id: 'claude-haiku-4-5', name: 'Haiku' }] } }
  }));
  fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({
    client_version: '1.0.0',
    models: [{ slug: 'gpt-5.6-sol', context_window: 400000 }, { slug: 'gpt-5.6-terra', context_window: 400000 }]
  }));
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    LLM_SWITCHER_CONFIG: cfgPath,
    LLM_SWITCHER_STATE_DIR: dir,
    LLM_SWITCHER_PORT: '',
    // Without this the gateway reads and writes the certificates of the checkout.
    LLM_SWITCHER_BLINDFOLD_CERTS: path.join(dir, 'certs'),
    LLM_SWITCHER_REGISTRY_URL: `${upstreamBase}/registry/latest`
  };
  // The gateway starts an interceptor of its own when it finds none on the port. This one is up
  // first and answers the identity proof with this gateway's port and tool set, so nothing real
  // is spawned.
  const interceptor = spawn(process.execPath, ['--input-type=module', '-e', `
    const s = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'state.mjs')).href)});
    const http = await import('node:http');
    s.ensureAdminToken();
    http.createServer((req, res) => {
      const nonce = new URL(req.url, 'http://x').searchParams.get('challenge');
      const activeTools = s.deriveActiveTools(s.loadConfig() || {}).join(',');
      const f = { role: 'blindfold', port: ${blindfoldPort}, pid: process.pid, gatewayPort: ${port}, activeTools };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ proxy: 'llm-switcher-blindfold', port: ${blindfoldPort}, pid: process.pid, gatewayPort: ${port}, activeTools, proof: s.identityProof(nonce, f) }));
    }).listen(${blindfoldPort}, '127.0.0.1');
  `], { env, stdio: 'ignore' });
  const deadline = Date.now() + 8000;
  for (;;) {
    const probe = await fetch(`http://127.0.0.1:${blindfoldPort}/?challenge=probe`).catch(() => null);
    if (probe?.ok) break;
    if (Date.now() > deadline) { interceptor.kill(); throw new Error('the stand-in interceptor never came up'); }
    await new Promise(r => setTimeout(r, 100));
  }

  const proxy = spawn(process.execPath, [path.join(ROOT, 'proxy.mjs'), '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proxy.stdout.on('data', d => { log += d; });
  proxy.stderr.on('data', d => { log += d; });
  let started = false;
  for (let i = 0; i < 80 && !started; i++) {
    try { started = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { /* not listening yet */ }
    if (!started) await new Promise(r => setTimeout(r, 100));
  }
  if (!started) { proxy.kill(); interceptor.kill(); throw new Error(`gateway did not start:\n${log}`); }

  const adminToken = () => fs.readFileSync(path.join(dir, 'admin.token'), 'utf8').trim();
  return {
    port,
    dir,
    upstream,
    upstreamBase,
    dashboardUrl: `http://127.0.0.1:${port}/ui`,
    // What is on disk, which the dashboard has to agree with after every action.
    config: () => JSON.parse(fs.readFileSync(cfgPath, 'utf8')),
    // A change made outside the dashboard, as `switch` in a terminal or an editor would make it.
    writeConfig: (cfg) => fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)),
    baseline: () => baselineConfig(port, blindfoldPort, upstreamBase),
    // The same call the dashboard makes, for a test that needs the server's own answer.
    api: (p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-llm-switcher-token': adminToken(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) })),
    // One request from Claude Code through the route that is on, so the request inspector has a row.
    messages: () => fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 64, messages: [{ role: 'user', content: 'hello from the test' }] })
    }).then(async r => ({ status: r.status, text: await r.text() })),
    async stop() {
      interceptor.kill();
      proxy.kill();
      upstreamServer.close();
      upstreamServer.closeAllConnections?.();
      // A tool set change can start a detached interceptor of its own; stop the one the gateway recorded.
      try {
        const { pid } = JSON.parse(fs.readFileSync(path.join(dir, 'blindfold.json'), 'utf8'));
        if (Number.isInteger(pid) && pid !== interceptor.pid) process.kill(pid);
      } catch { /* none was started */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
