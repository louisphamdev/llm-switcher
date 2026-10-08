import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('compact CLI disables summary without fallback, exposes Codex opt-in, and rejects invalid bounds', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-compact-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ activeProfiles: {}, profiles: {},
    idleCompact: { enabled: true, model: 'expensive-official' } }));
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'switch.mjs'), 'compact', ...args], {
    env: { ...process.env, LLM_SWITCHER_CONFIG: config, LLM_SWITCHER_STATE_DIR: dir,
      LLM_SWITCHER_REGISTRY_URL: 'http://127.0.0.1:9/' }, encoding: 'utf8', timeout: 5000,
  });
  const disabled = run('model', 'default'); assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /no model is called/);
  assert.doesNotMatch(disabled.stdout, /own model/);
  assert.equal(JSON.parse(fs.readFileSync(config)).idleCompact.model, '');
  const codex = run('codex', 'on'); assert.equal(codex.status, 0, codex.stderr);
  assert.match(codex.stdout, /wire prefix cache is on/);
  assert.equal(JSON.parse(fs.readFileSync(config)).idleCompact.codex, true);
  const before = fs.readFileSync(config);
  for (const args of [['idle', '1441'], ['idle', '0'], ['min', '7']]) {
    const invalid = run(...args); assert.equal(invalid.status, 1);
    assert.deepEqual(fs.readFileSync(config), before);
  }
  const status = run('status'); assert.equal(status.status, 0);
  assert.match(status.stdout, /gateway prefix cache/); assert.match(status.stdout, /Codex opt-in:\s+yes/);
});
