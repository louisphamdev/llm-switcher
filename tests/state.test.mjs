// Unit tests for state.mjs (pure functions only, no flag/env file writes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveMap, setTargetProfile, activateProfile, deactivateProfile, deleteProfile,
  computeLaunchState, findProfileKey, isValidProfileKey, resolvePort, redactConfig, MASKED_KEY,
  modelSlotsForProfile, modelForSlot, primaryModel, codexPublicModel, buildCodexCatalog,
  certCoversHost, ROOT_DIR
} from '../state.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const makeCfg = () => ({
  port: 4000,
  activeProfile: 'router',
  profiles: {
    router: { inFormat: 'auto', apiKey: 'sk-1', defaultModels: { opus: 'o', sonnet: 's' }, model1M: { sonnet: true } },
    codexOnly: {
      inFormat: 'responses', apiKey: 'sk-2',
      defaultModels: { main: 'gpt-main', review: 'gpt-review', subagent: 'gpt-sub' },
      model1M: { main: true }
    }
  }
});

test('legacy config without activeProfiles maps every target to activeProfile', () => {
  assert.deepEqual(getActiveMap(makeCfg()), { anthropic: 'router', responses: 'router', 'openai-chat': 'router', vertex: 'router' });
});

test('setTargetProfile validates target, existence (no prototype keys) and inFormat', () => {
  const cfg = makeCfg();
  assert.match(setTargetProfile(cfg, '__proto__', 'router'), /Unknown target/);
  assert.match(setTargetProfile(cfg, 'anthropic', 'constructor'), /does not exist/);
  assert.match(setTargetProfile(cfg, 'anthropic', 'codexOnly'), /cannot serve/);
  assert.equal(setTargetProfile(cfg, 'responses', 'codexOnly'), null);
  assert.equal(cfg.activeProfiles.responses, 'codexOnly');
  assert.equal(cfg.activeProfiles.anthropic, 'router');
});

test('activateProfile only assigns compatible targets; deactivateProfile leaves others alone', () => {
  const cfg = makeCfg();
  setTargetProfile(cfg, 'anthropic', null);
  activateProfile(cfg, 'codexOnly');
  assert.deepEqual(cfg.activeProfiles, { anthropic: null, responses: 'codexOnly', 'openai-chat': 'router', vertex: 'router' });
  deactivateProfile(cfg, 'router');
  assert.deepEqual(cfg.activeProfiles, { anthropic: null, responses: 'codexOnly', 'openai-chat': null, vertex: null });
});

test('deleteProfile unassigns targets that pointed at it', () => {
  const cfg = makeCfg();
  activateProfile(cfg, 'codexOnly');
  assert.equal(deleteProfile(cfg, 'codexOnly'), null);
  assert.equal(cfg.activeProfiles.responses, null);
  assert.equal(cfg.activeProfile, 'router');
});

test('computeLaunchState derives flags per target profile, not from one global profile', () => {
  const cfg = makeCfg();
  setTargetProfile(cfg, 'responses', 'codexOnly');
  const st = computeLaunchState(cfg, 4000);
  assert.equal(st.active, true);
  assert.equal(st.claude1M, 'sonnet[1m]');
  assert.equal(st.codex1M, 'gpt-main');
  const env = Object.fromEntries(st.env);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4000');
  assert.equal(env.LLM_SWITCHER_CODEX_BASE_URL, 'http://127.0.0.1:4000/v1');
  // Upstream IDs stay server-side: these variables carry the names Codex may display.
  assert.equal(env.LLM_SWITCHER_CODEX_MAIN_MODEL, undefined);
  assert.equal(env.LLM_SWITCHER_CODEX_REVIEW_MODEL, undefined);
  assert.equal(env.LLM_SWITCHER_CODEX_SUBAGENT_MODEL, undefined);
  assert.equal(env.LLM_SWITCHER_CODEX_CONTEXT_WINDOW, '1000000');
  assert.equal(env.LLM_SWITCHER_CODEX_AUTO_COMPACT_LIMIT, '900000');
  assert.equal(env.CODEX_MODEL, undefined, 'unsupported Codex env variables must not be emitted');

  const off = makeCfg();
  off.activeProfiles = { anthropic: null, responses: null, 'openai-chat': null, vertex: null };
  assert.equal(computeLaunchState(off, 4000).active, false);
});

test('Codex profiles use documented role slots (model/review_model/subagent) and read legacy keys', () => {
  const profile = makeCfg().profiles.codexOnly;
  assert.deepEqual(modelSlotsForProfile(profile), ['main', 'review', 'subagent']);
  assert.equal(primaryModel(profile), 'gpt-main');
  assert.equal(modelForSlot(profile, 'subagent'), 'gpt-sub');

  // Legacy profiles from the custom-key era (fast/fallback) or Claude tiers remain readable.
  const legacy = {
    inFormat: 'responses',
    defaultModels: { opus: 'old-main', sonnet: 'old-review', fast: 'old-sub', fallback: 'old-fb' },
    model1M: { fast: true }
  };
  assert.equal(modelForSlot(legacy, 'main'), 'old-main');
  assert.equal(modelForSlot(legacy, 'review'), 'old-review');
  assert.equal(modelForSlot(legacy, 'subagent'), 'old-sub');

  const cleared = {
    inFormat: 'responses',
    defaultModels: { main: '', opus: 'old-main', subagent: '', fast: 'old-sub' }
  };
  assert.equal(modelForSlot(cleared, 'main'), '');
  assert.equal(modelForSlot(cleared, 'subagent'), '');
});

// Codex must never learn a switcher-internal name. Everything it can display —
// the /model picker, review_model, agents.default_subagent_model — is fed from
// publicModels, so the slot names main/review/subagent stay server-side.
test('codexPublicModel maps each role to an official name, never to a slot alias', () => {
  const profile = {
    inFormat: 'responses',
    publicModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    defaultModels: { main: 'ag/flash', review: 'ag/review', subagent: 'ag/low' }
  };
  assert.equal(codexPublicModel(profile, 'main'), 'gpt-5.6-sol');
  assert.equal(codexPublicModel(profile, 'review'), 'gpt-5.6-terra');
  assert.equal(codexPublicModel(profile, 'subagent'), 'gpt-5.6-luna');

  // An explicit map wins over positional derivation.
  const explicit = { ...profile, codexRoles: { review: 'codex-auto-review' } };
  assert.equal(codexPublicModel(explicit, 'review'), 'codex-auto-review');
  assert.equal(codexPublicModel(explicit, 'main'), 'gpt-5.6-sol');

  // No publicModels: emit nothing rather than falling back to a slot alias.
  const bare = { inFormat: 'responses', defaultModels: { main: 'ag/flash', review: 'ag/review' } };
  assert.equal(codexPublicModel(bare, 'main'), '');
  assert.equal(codexPublicModel(bare, 'review'), '');
});

test('computeLaunchState hands Codex official names, not upstream IDs or slot aliases', () => {
  const cfg = makeCfg();
  cfg.profiles.codexOnly.publicModels = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
  setTargetProfile(cfg, 'responses', 'codexOnly');
  const env = Object.fromEntries(computeLaunchState(cfg, 4000).env);
  assert.equal(env.LLM_SWITCHER_CODEX_MAIN_MODEL, 'gpt-5.6-sol');
  assert.equal(env.LLM_SWITCHER_CODEX_REVIEW_MODEL, 'gpt-5.6-terra');
  assert.equal(env.LLM_SWITCHER_CODEX_SUBAGENT_MODEL, 'gpt-5.6-luna');
  const dump = JSON.stringify(env);
  assert.ok(!dump.includes('gpt-review'), 'upstream IDs must not reach the CLI');
  assert.ok(!dump.includes('gpt-sub'), 'upstream IDs must not reach the CLI');

  // Without publicModels the role variables are absent, so the shim adds no
  // --config override and Codex keeps its own official defaults.
  const bare = makeCfg();
  setTargetProfile(bare, 'responses', 'codexOnly');
  const bareEnv = Object.fromEntries(computeLaunchState(bare, 4000).env);
  assert.equal(bareEnv.LLM_SWITCHER_CODEX_REVIEW_MODEL, undefined);
  assert.equal(bareEnv.LLM_SWITCHER_CODEX_SUBAGENT_MODEL, undefined);
});

// Blindfold mode removes the last visible trace: without openai_base_url the CLI
// stops printing "base URL is overridden" on its own /model screen.
test('blindfold mode swaps the base URL override for a CONNECT proxy and a CA file', () => {
  const cfg = makeCfg();
  cfg.profiles.codexOnly.publicModels = ['gpt-5.6-sol'];
  cfg.profiles.codexOnly.blindfold = true;
  setTargetProfile(cfg, 'responses', 'codexOnly');
  const env = Object.fromEntries(computeLaunchState(cfg, 4000).env);

  const codexEnv = Object.fromEntries(computeLaunchState(cfg, 4000).envCodex);

  assert.equal(env.LLM_SWITCHER_CODEX_BASE_URL, undefined,
    'an openai_base_url override is exactly what makes Codex print the banner');
  // The proxy variables belong to Codex alone. The `claude` shim sources the shared
  // file, and pointing every claude HTTPS call at a Codex-only loopback port breaks
  // claude after any restart that does not re-run `switch`.
  assert.equal(env.HTTPS_PROXY, undefined, 'proxy variables must not reach the shared file');
  assert.equal(env.https_proxy, undefined);
  assert.equal(env.NO_PROXY, undefined);
  assert.equal(codexEnv.HTTPS_PROXY, 'http://127.0.0.1:3457');
  assert.equal(codexEnv.https_proxy, 'http://127.0.0.1:3457');
  assert.match(codexEnv.NO_PROXY, /127\.0\.0\.1/, 'NO_PROXY must travel with HTTPS_PROXY');
  assert.match(codexEnv.CODEX_CA_CERTIFICATE, /blindfold[\\/]certs[\\/]ca\.pem$/);
  // The role names still travel: they are official and carry no URL.
  assert.equal(env.LLM_SWITCHER_CODEX_MAIN_MODEL, 'gpt-5.6-sol');

  // The launcher needs the port and the CA path as data, so that `switch` can start
  // the interceptor and refuse to activate when the certificate is missing.
  const st = computeLaunchState(cfg, 4000);
  assert.equal(st.blindfold.port, 3457);
  assert.match(st.blindfold.ca, /blindfold[\\/]certs[\\/]ca\.pem$/);
  // ChatGPT sign-in is the common case, so it is the default.
  assert.equal(st.blindfold.host, 'chatgpt.com');
  assert.equal(st.blindfold.prefix, '/backend-api/codex');

  // An API-key account talks to a different host under a different prefix. The
  // launcher must pass both through, otherwise that account cannot use blindfold.
  const apiKeyCfg = makeCfg();
  Object.assign(apiKeyCfg.profiles.codexOnly, {
    publicModels: ['gpt-5.6-sol'], blindfold: true,
    blindfoldHost: 'api.openai.com', blindfoldPrefix: '/v1'
  });
  setTargetProfile(apiKeyCfg, 'responses', 'codexOnly');
  const apiKeySt = computeLaunchState(apiKeyCfg, 4000);
  assert.equal(apiKeySt.blindfold.host, 'api.openai.com');
  assert.equal(apiKeySt.blindfold.prefix, '/v1');

  cfg.profiles.codexOnly.blindfoldPort = 4999;
  const movedState = computeLaunchState(cfg, 4000);
  assert.equal(Object.fromEntries(movedState.envCodex).HTTPS_PROXY, 'http://127.0.0.1:4999');
  assert.equal(movedState.blindfold.port, 4999);

  // Off by default: the documented base URL override stays the normal route.
  const plain = makeCfg();
  setTargetProfile(plain, 'responses', 'codexOnly');
  const plainState = computeLaunchState(plain, 4000);
  const plainEnv = Object.fromEntries(plainState.env);
  assert.equal(plainEnv.LLM_SWITCHER_CODEX_BASE_URL, 'http://127.0.0.1:4000/v1');
  assert.equal(plainEnv.HTTPS_PROXY, undefined);
  assert.equal(plainState.blindfold, null);
  assert.deepEqual(plainState.envCodex, []);
});

// A model name travels into env.cmd, which cmd.exe executes on every launch, and is
// then re-expanded unquoted onto the shim's command line. `SET "K=V"` does not contain
// a bare `&`, and a newline splits the batch file outright.
test('a model name that could act as a command is dropped, not written', () => {
  const payloads = [
    'a" & echo pwned & rem',
    'good\nSET X=1 & echo pwned',
    'good\r& echo pwned',
    'a & echo pwned',
    'a %PATH% ^b',
    'a|b', 'a>c', 'a<c'
  ];
  for (const payload of payloads) {
    const cfg = makeCfg();
    cfg.profiles.codexOnly.publicModels = [payload, 'gpt-5.6-terra', 'gpt-5.6-luna'];
    setTargetProfile(cfg, 'responses', 'codexOnly');
    const env = Object.fromEntries(computeLaunchState(cfg, 4000).env);
    assert.equal(env.LLM_SWITCHER_CODEX_MAIN_MODEL, undefined,
      `must drop an unsafe model name: ${JSON.stringify(payload)}`);
    // A safe sibling is unaffected.
    assert.equal(env.LLM_SWITCHER_CODEX_REVIEW_MODEL, 'gpt-5.6-terra');
  }

  // Names that real providers use stay legal.
  for (const ok of ['gpt-5.6-sol', 'ag/gemini-3.8-flash', 'claude-haiku-4-5-20251001', 'gpt-4.1_mini', 'a.b:c']) {
    const cfg = makeCfg();
    cfg.profiles.codexOnly.publicModels = [ok];
    setTargetProfile(cfg, 'responses', 'codexOnly');
    assert.equal(Object.fromEntries(computeLaunchState(cfg, 4000).env).LLM_SWITCHER_CODEX_MAIN_MODEL, ok);
  }
});

test('a blank entry in publicModels does not shift the later roles', () => {
  const profile = {
    inFormat: 'responses',
    publicModels: ['gpt-5.6-sol', '', 'gpt-5.6-luna'],
    defaultModels: { main: 'ag/flash', review: 'ag/review', subagent: 'ag/low' }
  };
  assert.equal(codexPublicModel(profile, 'main'), 'gpt-5.6-sol');
  assert.equal(codexPublicModel(profile, 'review'), '', 'a blank slot means no override for that slot');
  assert.equal(codexPublicModel(profile, 'subagent'), 'gpt-5.6-luna', 'position must not shift');
});

test('the generated catalog states the 1M window only for a slot the profile marks 1M', () => {
  const base = {
    inFormat: 'responses',
    defaultModels: { main: 'ag/flash', review: 'ag/review', subagent: 'ag/low' }
  };
  const windowOf = (catalog, slug) => {
    const m = catalog.models.find(x => x.slug === slug);
    return [m.context_window, m.max_context_window];
  };

  const off = buildCodexCatalog({ ...base, publicModels: ['a-model'], model1M: { main: false } });
  assert.deepEqual(windowOf(off, 'a-model'), [272000, 872000],
    'a non-1M slot keeps the official window');

  const on = buildCodexCatalog({ ...base, publicModels: ['a-model'], model1M: { main: true } });
  assert.deepEqual(windowOf(on, 'a-model'), [1000000, 1000000]);

  // Two slots publishing the same name deduplicate into one entry. The smaller window
  // wins: overstating it is what makes Codex size a session it cannot fit.
  const mixed = buildCodexCatalog({
    ...base,
    publicModels: ['same', 'same', 'other'],
    model1M: { main: true, review: false, subagent: false }
  });
  assert.deepEqual(mixed.models.map(m => m.slug), ['same', 'other']);
  assert.deepEqual(windowOf(mixed, 'same'), [272000, 872000],
    'a name shared by a 1M and a non-1M slot must not claim 1M');
});

// Changing blindfoldHost without rebuilding the leaf gives a TLS failure that reads
// like a network fault. The launcher compares the two and says what to run instead.
test('certCoversHost reads the leaf subject alternative names', () => {
  const leaf = path.join(ROOT_DIR, 'blindfold', 'certs', 'leaf.pem');
  if (!fs.existsSync(leaf)) return;
  const pem = fs.readFileSync(leaf, 'utf8');
  assert.equal(certCoversHost(pem, 'chatgpt.com'), true);
  assert.equal(certCoversHost(pem, 'sub.chatgpt.com'), true, 'the wildcard entry must count');
  assert.equal(certCoversHost(pem, 'api.openai.com'), false);
  assert.equal(certCoversHost(pem, ''), false);
  assert.equal(certCoversHost('not a certificate', 'chatgpt.com'), false);
});

test('buildCodexCatalog lists only official slugs, deduplicated, with no slot alias', () => {
  const profile = {
    inFormat: 'responses',
    publicModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-sol'],
    defaultModels: { main: 'ag/flash', review: 'ag/review', subagent: 'ag/low' }
  };
  const catalog = buildCodexCatalog(profile);
  assert.deepEqual(catalog.models.map(m => m.slug), ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.ok(catalog.models.every(m => m.display_name === m.slug));
  assert.ok(catalog.models.every(m => m.model_messages?.instructions_template),
    'each entry keeps the official instructions so Codex does not fall back to full context');
  const dump = JSON.stringify(catalog);
  for (const leak of ['"main"', '"review"', '"subagent"', 'ag/', 'llm-switcher']) {
    assert.ok(!dump.includes(leak), `catalog must not leak ${leak}`);
  }

  assert.equal(buildCodexCatalog({ inFormat: 'responses' }), null,
    'no publicModels means no catalog file, so Codex uses its built-in one');
});

test('openai-chat and vertex profiles use a single default slot with legacy fallback', () => {
  assert.deepEqual(modelSlotsForProfile({ inFormat: 'openai-chat' }), ['default']);
  assert.deepEqual(modelSlotsForProfile({ inFormat: 'vertex' }), ['default']);
  assert.deepEqual(modelSlotsForProfile({ inFormat: 'auto' }),
    ['opus', 'sonnet', 'haiku', 'fable']);
  const legacy = { inFormat: 'openai-chat', defaultModels: { sonnet: 's-old' } };
  assert.equal(modelForSlot(legacy, 'default'), 's-old');
  assert.equal(primaryModel(legacy), 's-old');
});

test('computeLaunchState tags [1m] per Claude tier from the profile model1M map, nothing hard-coded', () => {
  const cfg = makeCfg();
  cfg.profiles.router.model1M = { opus: true, sonnet: false, fable: true };
  const env = Object.fromEntries(computeLaunchState(cfg, 4000).env);
  assert.equal(env.ANTHROPIC_MODEL, 'opus[1m]');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'opus[1m]');
  assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'fable[1m]');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);

  cfg.profiles.router.model1M = {};
  const none = Object.fromEntries(computeLaunchState(cfg, 4000).env);
  assert.ok(!Object.keys(none).some(k => k.startsWith('ANTHROPIC_DEFAULT_') || k === 'ANTHROPIC_MODEL' || k === 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'));
});

test('helpers: case-insensitive lookup, key validation, port resolution, redaction', () => {
  const cfg = makeCfg();
  assert.equal(findProfileKey(cfg, 'CODEXONLY'), 'codexOnly');
  assert.equal(findProfileKey(cfg, 'nope'), null);
  assert.ok(isValidProfileKey('my-llm.v2'));
  assert.ok(!isValidProfileKey('__proto__'));
  assert.ok(!isValidProfileKey('bad key'));

  const saved = { a: process.env.LLM_SWITCHER_PORT, b: process.env.PORT };
  delete process.env.LLM_SWITCHER_PORT;
  delete process.env.PORT;
  try {
    assert.equal(resolvePort(['on', '--port', '5000'], cfg), 5000);
    assert.equal(resolvePort(['on'], cfg), 4000);
    process.env.LLM_SWITCHER_PORT = '4500';
    assert.equal(resolvePort(['on'], cfg), 4500);
  } finally {
    if (saved.a === undefined) delete process.env.LLM_SWITCHER_PORT; else process.env.LLM_SWITCHER_PORT = saved.a;
    if (saved.b !== undefined) process.env.PORT = saved.b;
  }
  const red = redactConfig(cfg);
  assert.equal(red.profiles.router.apiKey, MASKED_KEY);
  assert.equal(cfg.profiles.router.apiKey, 'sk-1', 'original config untouched');
});

// config.json holds every API key. It must be private to the owner even when an earlier
// version left it world-readable, and the tmp file must never be readable before the rename.
test('saveConfig writes config.json 0600, also over an existing 0644 file', { skip: process.platform === 'win32' && 'posix modes' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-mode-'));
  try {
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, '{"profiles":{}}', { mode: 0o644 });
    fs.chmodSync(cfgPath, 0o644);
    const script = `
      import fs from 'node:fs';
      const seen = [];
      const rename = fs.renameSync;
      fs.renameSync = (a, b) => { seen.push((fs.statSync(a).mode & 0o777).toString(8)); return rename(a, b); };
      const s = await import(${JSON.stringify(path.join(ROOT_DIR, 'state.mjs'))});
      s.saveConfig({ profiles: {} });
      console.log(JSON.stringify({ tmp: seen[0], final: (fs.statSync(s.configPath).mode & 0o777).toString(8) }));`;
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, LLM_SWITCHER_CONFIG: cfgPath }, encoding: 'utf8'
    }).trim());
    assert.equal(out.tmp, '600', 'the tmp file is private before it replaces config.json');
    assert.equal(out.final, '600', 'config.json ends private');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
