// MCP server and process audit tests (audit F39, F40, N-7, F46). mcp.mjs runs as a stdio child.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { routeEvidence } from '../shim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () => new Promise(r => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); });
});

async function mcpCall(t, env, calls) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ port: await freePort(), activeProfiles: {}, profiles: {} }), { mode: 0o600 });
  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeDir);
  if (env.SETTINGS !== undefined) fs.writeFileSync(path.join(claudeDir, 'settings.json'), env.SETTINGS);
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp.mjs')], {
    env: { ...process.env, LLM_SWITCHER_CONFIG: cfgPath, LLM_SWITCHER_STATE_DIR: dir, CLAUDE_CONFIG_DIR: claudeDir, LLM_SWITCHER_PORT: '', ANTHROPIC_BASE_URL: '', ...env.vars }
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const requests = calls.map((c, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...c })).join('\n') + '\n';
  child.stdin.write(requests);
  for (let i = 0; i < 100 && out.split('\n').filter(Boolean).length < calls.length; i++) await new Promise(r => setTimeout(r, 50));
  child.kill();
  return out.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

const tool = (name, args = {}) => ({ method: 'tools/call', params: { name, arguments: args } });
const text = (reply) => reply.result.content[0].text;

test('MCP initialize reports the package version', async (t) => {
  const [init] = await mcpCall(t, {}, [{ method: 'initialize', params: { protocolVersion: '2025-06-18' } }]);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(init.result.serverInfo.version, pkg.version);
});

test('MCP recent logs says the gateway is unreachable instead of "no requests"', async (t) => {
  const [r] = await mcpCall(t, {}, [tool('switcher_recent_logs')]);
  assert.match(text(r), /unreachable/i);
  assert.equal(r.result.isError, true);
});

test('MCP audit checks the host, not a substring, and reports an unreadable settings.json', async (t) => {
  const [evil] = await mcpCall(t, { vars: { ANTHROPIC_BASE_URL: 'https://localhost.evil.test/v1' } }, [tool('switcher_audit')]);
  assert.match(text(evil), /\[ALERT\] ANTHROPIC_BASE_URL/);
  const [openai] = await mcpCall(t, { vars: { OPENAI_BASE_URL: 'https://api.example.test/v1' } }, [tool('switcher_audit')]);
  assert.match(text(openai), /\[ALERT\] OPENAI_BASE_URL/);
  const [broken] = await mcpCall(t, { SETTINGS: '{ not json' }, [tool('switcher_audit')]);
  assert.match(text(broken), /ACTION NEEDED/);
  assert.match(text(broken), /settings\.json .*does not parse/);
  const [verbose] = await mcpCall(t, { vars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456' } }, [tool('switcher_audit', { verbose: true })]);
  assert.match(text(verbose), /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:3456/);
});

test('routeEvidence reads the right evidence for each CLI and says when it cannot read the environment', () => {
  assert.equal(routeEvidence('claude', 'claude --resume HOME=/h ANTHROPIC_BASE_URL=http://127.0.0.1:3456'), true);
  assert.equal(routeEvidence('claude', 'claude HOME=/h PATH=/bin'), false);
  // Codex through the gateway, through the blindfold interceptor, or through the shim's override.
  assert.equal(routeEvidence('codex', 'codex HOME=/h LLM_SWITCHER_CODEX_BASE_URL=http://127.0.0.1:3456/v1'), true);
  assert.equal(routeEvidence('codex', 'codex HOME=/h HTTPS_PROXY=http://127.0.0.1:3457'), true);
  assert.equal(routeEvidence('codex', 'codex --config openai_base_url=http://127.0.0.1:3456/v1 HOME=/h'), true);
  assert.equal(routeEvidence('codex', 'codex HOME=/h ANTHROPIC_BASE_URL=http://127.0.0.1:3456'), false);
  // macOS ps prints no environment for most processes: that is unknown, not a bypass.
  assert.equal(routeEvidence('claude', 'claude --resume'), null);
});

// A proxy URL often carries a user and a password. The audit output goes into the agent's context.
test('MCP audit never prints the credentials inside a URL', async (t) => {
  const [r] = await mcpCall(t, { vars: { HTTPS_PROXY: 'http://u:s3cret@127.0.0.1:1', ANTHROPIC_BASE_URL: 'https://user:pw-secret@evil.example/v1' } }, [tool('switcher_audit', { verbose: true })]);
  const out = text(r);
  assert.ok(!out.includes('s3cret') && !out.includes('pw-secret'), out);
  assert.match(out, /HTTPS_PROXY=http:\/\/127\.0\.0\.1:1/);
  assert.match(out, /\[ALERT\] ANTHROPIC_BASE_URL="https:\/\/evil\.example\/v1"/);
});

test('routeEvidence does not take the shim --config arguments for an environment', () => {
  assert.equal(routeEvidence('codex', '/usr/local/bin/codex --config model_catalog_json=/s/model-catalog.json --config model="gpt-5.5"'), null);
  assert.equal(routeEvidence('codex', '/usr/local/bin/codex -c model="gpt-5.5" exec'), null);
  // The override on the command line is proof enough, with or without a readable environment.
  assert.equal(routeEvidence('codex', '/usr/local/bin/codex --config openai_base_url=http://127.0.0.1:3456/v1 exec'), true);
});
