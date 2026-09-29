// Unit tests for catalog.mjs (dynamic model discovery, caching and auto-role classification)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  classifyClaudeTier,
  classifyCodexRole,
  loadCatalogCache,
  saveCatalogCache,
  fetchToolModels,
  refreshCatalog,
  detectToolVersion,
  checkVersionAndRefresh,
  readLocalToolModels,
  syncLocalCatalog,
  BASELINE_MODELS
} from '../catalog.mjs';

test('classifyClaudeTier categorizes all Claude models into correct tiers', () => {
  assert.equal(classifyClaudeTier('claude-opus-5-5'), 'opus');
  assert.equal(classifyClaudeTier('claude-opus-4-6'), 'opus');
  assert.equal(classifyClaudeTier('claude-3-opus-20240229'), 'opus');

  assert.equal(classifyClaudeTier('claude-sonnet-4'), 'sonnet');
  assert.equal(classifyClaudeTier('claude-3-7-sonnet-20250219'), 'sonnet');
  assert.equal(classifyClaudeTier('claude-3-5-sonnet-20241022'), 'sonnet');

  assert.equal(classifyClaudeTier('claude-haiku-4'), 'haiku');
  assert.equal(classifyClaudeTier('claude-3-5-haiku-20241022'), 'haiku');

  assert.equal(classifyClaudeTier('claude-fable-4'), 'fable');
  assert.equal(classifyClaudeTier('custom-model'), 'sonnet', 'defaults unknown Claude models to sonnet tier');
});

test('classifyCodexRole categorizes all Codex models into correct roles', () => {
  assert.equal(classifyCodexRole('gpt-6-sol'), 'main');
  assert.equal(classifyCodexRole('gpt-5.6-sol'), 'main');
  assert.equal(classifyCodexRole('gpt-5.2'), 'main');
  assert.equal(classifyCodexRole('o3'), 'main');

  assert.equal(classifyCodexRole('gpt-6-terra'), 'review');
  assert.equal(classifyCodexRole('gpt-5.6-terra'), 'review');
  assert.equal(classifyCodexRole('codex-review-model'), 'review');

  assert.equal(classifyCodexRole('gpt-6-luna'), 'subagent');
  assert.equal(classifyCodexRole('gpt-5.6-luna'), 'subagent');
  assert.equal(classifyCodexRole('codex-subagent-worker'), 'subagent');
});

test('loadCatalogCache returns baseline models when cache file does not exist', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-cat-test-'));
  try {
    const catalog = loadCatalogCache(tmp);
    assert.ok(catalog.claude.models.length > 0);
    assert.ok(catalog.codex.models.length > 0);
    assert.ok(catalog.claude.models.some(m => m.id === 'claude-opus-5-5'));
    assert.ok(catalog.codex.models.some(m => m.id === 'gpt-6-sol'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('saveCatalogCache writes cache atomically and loadCatalogCache reads it back', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-cat-test-'));
  try {
    const sample = {
      updatedAt: 123456789,
      claude: { models: [{ id: 'claude-future-opus', tier: 'opus' }] },
      codex: { models: [{ id: 'gpt-7-sol', role: 'main' }] }
    };
    const saved = saveCatalogCache(tmp, sample);
    assert.equal(saved, true);
    const loaded = loadCatalogCache(tmp);
    assert.equal(loaded.updatedAt, 123456789);
    assert.equal(loaded.claude.models[0].id, 'claude-future-opus');
    assert.equal(loaded.codex.models[0].id, 'gpt-7-sol');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fetchToolModels queries endpoint and parses model list', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'gpt-6-sol', object: 'model' },
          { id: 'gpt-6-terra', object: 'model' },
          { id: 'gpt-6-luna', object: 'model' }
        ]
      }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });

  const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  try {
    const res = await fetchToolModels('codex', { url: `http://127.0.0.1:${port}/v1/models` });
    assert.equal(res.ok, true);
    assert.equal(res.models.length, 3);
    assert.equal(res.models.find(m => m.id === 'gpt-6-sol').role, 'main');
    assert.equal(res.models.find(m => m.id === 'gpt-6-terra').role, 'review');
    assert.equal(res.models.find(m => m.id === 'gpt-6-luna').role, 'subagent');
  } finally {
    server.close();
  }
});

test('fetchToolModels handles network errors gracefully without throwing', async () => {
  const res = await fetchToolModels('claude', { url: 'http://127.0.0.1:1/nonexistent', timeout: 50 });
  assert.equal(res.ok, false);
  assert.ok(res.error, 'reports error reason without crashing');
});

test('detectToolVersion extracts semantic version from various User-Agent strings', () => {
  assert.equal(detectToolVersion({ 'user-agent': 'claude-cli/2.1.280 (external, cli)' }), '2.1.280');
  assert.equal(detectToolVersion({ 'user-agent': 'codex-cli/0.157.1 (Windows NT 10.0; Win64; x64)' }), '0.157.1');
  assert.equal(detectToolVersion({ 'user-agent': 'claude-code/2.2.0 darwin' }), '2.2.0');
  assert.equal(detectToolVersion({ 'user-agent': 'curl/7.68.0' }), '');
  assert.equal(detectToolVersion({}), '');
});

// Local model lists that the tools write themselves, in the formats of Codex and Claude Code.
function writeToolCaches(root, { codex = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'], claude = ['claude-opus-5-5', 'claude-sonnet-5-5'] } = {}) {
  const codexHome = path.join(root, 'codex');
  const claudeDir = path.join(root, 'claude');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'cache', 'model-catalog'), { recursive: true });
  if (codex) {
    fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
      fetched_at: '2026-09-29T01:00:00Z', client_version: '0.158.0',
      models: codex.map(slug => ({ slug, display_name: slug, context_window: 1000000, visibility: 'list' }))
    }));
  }
  if (claude) {
    // An older file with another list: the newest fetchedAt wins.
    fs.writeFileSync(path.join(claudeDir, 'cache', 'model-catalog', 'old.json'), JSON.stringify({
      version: 2, fetchedAt: 1000, catalog: { surface: 'cc', config: { models: [{ id: 'claude-opus-4-6', name: 'Opus 4.6' }] } }
    }));
    fs.writeFileSync(path.join(claudeDir, 'cache', 'model-catalog', 'new.json'), JSON.stringify({
      version: 2, fetchedAt: 2000, catalog: { surface: 'cc', config: { models: claude.map(id => ({ id, name: id })) } }
    }));
  }
  return { codexHome, claudeDir };
}

function failingFetch(t) {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 401 }); };
  t.after(() => { globalThis.fetch = realFetch; });
  return () => calls;
}

test('readLocalToolModels reads the model lists that Codex and Claude Code keep on disk', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-local-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = writeToolCaches(root);

  const codex = readLocalToolModels('codex', sources);
  assert.deepEqual(codex.models.map(m => [m.id, m.role]), [['gpt-5.6-sol', 'main'], ['gpt-5.6-terra', 'review'], ['gpt-5.6-luna', 'subagent']]);
  assert.equal(codex.version, '0.158.0');

  const claude = readLocalToolModels('claude', sources);
  assert.deepEqual(claude.models.map(m => [m.id, m.tier]), [['claude-opus-5-5', 'opus'], ['claude-sonnet-5-5', 'sonnet']]);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-no-models-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(readLocalToolModels('codex', { codexHome: empty, claudeDir: empty }), null);
  assert.equal(readLocalToolModels('claude', { codexHome: empty, claudeDir: empty }), null);
});

test('refreshCatalog takes the local lists and drops the built-in names', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-refresh-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = writeToolCaches(root);
  const calls = failingFetch(t);

  const cache = await refreshCatalog(root, { sources });
  assert.deepEqual(cache.codex.models.map(m => m.id), ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  assert.deepEqual(cache.claude.models.map(m => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(calls(), 0, 'a local list needs no network call');
});

test('checkVersionAndRefresh records a version only after the catalog for it is refreshed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-bump-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  failingFetch(t);

  // No local list and a failing official list: nothing is refreshed, so the version stays unseen.
  const none = { codexHome: path.join(root, 'none'), claudeDir: path.join(root, 'none') };
  checkVersionAndRefresh('codex', { 'user-agent': 'codex_cli_rs/0.158.0 (Mac OS)' }, root, undefined, none);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(loadCatalogCache(root).codex.lastSeenVersion, undefined, 'a failed refresh is tried again');

  // Codex wrote its list: the next request refreshes and records the version.
  const sources = writeToolCaches(root, { codex: ['gpt-5.7-sol'] });
  checkVersionAndRefresh('codex', { 'user-agent': 'codex_cli_rs/0.158.0 (Mac OS)' }, root, undefined, sources);
  await new Promise(r => setTimeout(r, 50));
  const after = loadCatalogCache(root);
  assert.equal(after.codex.lastSeenVersion, '0.158.0');
  assert.deepEqual(after.codex.models.map(m => m.id), ['gpt-5.7-sol']);
});

// A profile key belongs to that profile's baseURL. The official model lists may see it only when
// the profile itself points at the official host.
test('refreshCatalog sends a profile key only to the host of that profile', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-catalog-keys-'));
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const h = init.headers || {};
    sent.push({ host: new URL(url).host, auth: h.authorization || h['x-api-key'] || '' });
    return new Response('{}', { status: 401 });
  };
  t.after(() => { globalThis.fetch = realFetch; fs.rmSync(stateDir, { recursive: true, force: true }); });

  await refreshCatalog(stateDir, {
    claudeProfile: { baseURL: 'https://gateway.example/v1', apiKey: 'sk-third-party' },
    codexProfile: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-openai' },
    sources: { codexHome: stateDir, claudeDir: stateDir }
  });
  assert.deepEqual(sent.find(s => s.host === 'api.anthropic.com').auth, '', 'a third-party key never reaches Anthropic');
  assert.deepEqual(sent.find(s => s.host === 'api.openai.com').auth, 'Bearer sk-openai', 'an OpenAI profile key reaches OpenAI');
});

// Codex can update and rewrite its list without one request through the gateway.
test('syncLocalCatalog picks up a list that a tool rewrote, with no network call', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-sync-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = failingFetch(t);
  assert.deepEqual(loadCatalogCache(root).codex.models.map(m => m.id).includes('gpt-6-sol'), true, 'starts from the built-in list');

  const sources = writeToolCaches(root, { codex: ['gpt-5.7-sol', 'gpt-5.7-luna'] });
  const synced = syncLocalCatalog(root, sources);
  assert.deepEqual(synced.codex.models.map(m => m.id), ['gpt-5.7-sol', 'gpt-5.7-luna']);
  assert.deepEqual(loadCatalogCache(root).codex.models.map(m => m.id), ['gpt-5.7-sol', 'gpt-5.7-luna'], 'saved to disk');
  assert.equal(calls(), 0);
});
