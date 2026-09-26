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

test('checkVersionAndRefresh records new version and triggers update only on version bumps', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-bump-test-'));
  try {
    // Initial request from version 1.1.0
    checkVersionAndRefresh('claude', { 'user-agent': 'claude-cli/1.1.0' }, tmp);
    const cat1 = loadCatalogCache(tmp);
    assert.equal(cat1.claude.lastSeenVersion, '1.1.0');

    // Repeated request from the same version 1.1.0 -> no change, no duplicate trigger
    checkVersionAndRefresh('claude', { 'user-agent': 'claude-cli/1.1.0' }, tmp);
    const cat2 = loadCatalogCache(tmp);
    assert.equal(cat2.claude.lastSeenVersion, '1.1.0');

    // Tool updates to version 1.2.0 -> version bump detected and saved
    checkVersionAndRefresh('claude', { 'user-agent': 'claude-cli/1.2.0' }, tmp);
    const cat3 = loadCatalogCache(tmp);
    assert.equal(cat3.claude.lastSeenVersion, '1.2.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
