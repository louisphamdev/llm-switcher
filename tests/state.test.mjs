// Unit tests for state.mjs (pure functions only, no flag/env file writes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveMap, setTargetProfile, activateProfile, deactivateProfile, deleteProfile,
  computeLaunchState, findProfileKey, isValidProfileKey, resolvePort, redactConfig, MASKED_KEY,
  modelSlotsForProfile, modelForSlot, primaryModel, codexPublicModel, buildCodexCatalog,
  certCoversHost, blindfoldPreflight, ROOT_DIR, openLog, probeGateway, isSafeModelName
} from '../state.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execFile as execFileCb } from 'node:child_process';

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
// The test builds its own leaf: blindfold/certs is gitignored, and a test that returns early
// on a clean checkout passes with no assertion at all.
test('certCoversHost reads the leaf subject alternative names', (t) => {
  if (process.platform === 'win32' || !fs.existsSync('/usr/bin/openssl')) return t.skip('needs bash and openssl to build a leaf');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-leaf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('bash', [path.join(ROOT_DIR, 'blindfold', 'make-certs.sh'), 'chatgpt.com', path.join(dir, 'certs')], { stdio: 'ignore' });
  const pem = fs.readFileSync(path.join(dir, 'certs', 'leaf.pem'), 'utf8');
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
    // A generic PORT belongs to other tools (dev servers) and must not move the gateway (audit F32).
    delete process.env.LLM_SWITCHER_PORT;
    process.env.PORT = '3000';
    assert.equal(resolvePort(['on'], cfg), 4000);
    delete process.env.PORT;
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

// settings.json belongs to Claude Code and to the user. The switcher may remove only the
// values it would itself write: its own base URL and the `<tier>[1m]` aliases.
test('cleanClaudeSettings removes only switcher-written values and keeps the file identity', { skip: process.platform === 'win32' && 'posix symlink' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-claude-'));
  try {
    const real = path.join(dir, 'real-settings.json');
    const userEnv = {
      ANTHROPIC_AUTH_TOKEN: 'tok-user',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'my-opus',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'x',
      ANTHROPIC_BASE_URL: 'https://other.example'
    };
    fs.writeFileSync(real, JSON.stringify({ env: userEnv, theme: 'dark' }, null, 2), { mode: 0o640 });
    fs.chmodSync(real, 0o640);
    fs.symlinkSync(real, path.join(dir, 'settings.json'));
    const run = (port) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      `const s = await import(${JSON.stringify(path.join(ROOT_DIR, 'state.mjs'))}); console.log(JSON.stringify(s.cleanClaudeSettings(${port})));`
    ], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, encoding: 'utf8' }).trim());

    const before = fs.readFileSync(real, 'utf8');
    assert.deepEqual(run(3456).removed || [], []);
    assert.equal(fs.readFileSync(real, 'utf8'), before, 'user-owned values leave the file byte-identical');

    // Switcher-written values are removed; the user's values stay.
    const mixed = { ...userEnv, ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456', ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet[1m]' };
    fs.writeFileSync(real, JSON.stringify({ env: mixed }, null, 2));
    const out = run(3456);
    assert.deepEqual(out.removed.sort(), ['ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_SONNET_MODEL']);
    const env = JSON.parse(fs.readFileSync(real, 'utf8')).env;
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-user');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'my-opus');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, 'x');
    assert.ok(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink(), 'the symlink survives');
    assert.equal((fs.statSync(real).mode & 0o777).toString(8), '640', 'the target keeps its mode');

    // A local gateway on another port (for example 9router) is not the switcher's.
    fs.writeFileSync(real, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:20128' } }));
    assert.deepEqual(run(3456).removed || [], []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The dashboard saves every role key, a blank one as '', and a compacted publicModels list.
// A blank role means "no override"; it must never pick up another role's name by position.
test('an explicit blank Codex role stays blank and never shifts the other roles', () => {
  const uiShaped = { inFormat: 'responses', codexRoles: { main: '', review: 'gpt-review', subagent: 'gpt-sub' }, publicModels: ['gpt-review', 'gpt-sub'] };
  assert.equal(codexPublicModel(uiShaped, 'main'), '');
  assert.equal(codexPublicModel(uiShaped, 'review'), 'gpt-review');
  assert.equal(codexPublicModel(uiShaped, 'subagent'), 'gpt-sub');
  const e2eFixture = { inFormat: 'responses', publicModels: ['gpt-5.6-sol', 'ag/mock-flash'], codexRoles: { main: 'gpt-5.6-sol', review: '', subagent: '' } };
  assert.equal(codexPublicModel(e2eFixture, 'review'), '', 'no upstream id reaches the CLI');
});

// /proc/<pid>/cmdline is readable by every account, so `switch ui` must never put the admin
// token on a command line. It opens a private file that redirects to the dashboard instead.
test('the dashboard launcher keeps the admin token off the command line', { skip: process.platform === 'win32' && 'posix modes' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-ui-'));
  try {
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      `const s = await import(${JSON.stringify(path.join(ROOT_DIR, 'state.mjs'))});
       const token = s.ensureAdminToken();
       const file = s.writeDashboardLauncher('http://127.0.0.1:4000/ui');
       const fs = await import('node:fs');
       console.log(JSON.stringify({ token, file, mode: (fs.statSync(file).mode & 0o777).toString(8), html: fs.readFileSync(file, 'utf8') }));`
    ], { env: { ...process.env, LLM_SWITCHER_CONFIG: path.join(dir, 'config.json') }, encoding: 'utf8' }).trim());
    assert.ok(!out.file.includes(out.token), 'the path that reaches argv holds no token');
    assert.equal(out.mode, '600');
    assert.ok(out.html.includes(`http://127.0.0.1:4000/ui#token=${out.token}`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A leaf from another build does not chain to ca.pem, and a key from another build does not
// match the leaf: Codex then fails with a TLS error that reads like a network fault (audit F17).
test('blindfoldPreflight refuses a leaf that does not chain to ca.pem or does not match leaf.key', (t) => {
  if (process.platform === 'win32' || !fs.existsSync('/usr/bin/openssl')) return t.skip('needs bash and openssl');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-chain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const [a, b] = ['a', 'b'].map(n => path.join(dir, n));
  for (const d of [a, b]) execFileSync('bash', [path.join(ROOT_DIR, 'blindfold', 'make-certs.sh'), 'chatgpt.com', d], { stdio: 'ignore' });
  const desired = { ca: path.join(a, 'ca.pem'), host: 'chatgpt.com' };
  assert.equal(blindfoldPreflight(desired), null);

  const keep = (f) => fs.readFileSync(path.join(a, f));
  const leafPem = keep('leaf.pem');
  fs.copyFileSync(path.join(b, 'leaf.pem'), path.join(a, 'leaf.pem'));
  assert.match(blindfoldPreflight(desired) || '', /not signed by/);
  fs.writeFileSync(path.join(a, 'leaf.pem'), leafPem);

  fs.copyFileSync(path.join(b, 'leaf.key'), path.join(a, 'leaf.key'));
  assert.match(blindfoldPreflight(desired) || '', /does not match/);
});

// ca.key signs for every host that Codex trusts it for. The name constraint limits a leaked key
// to the intercepted host (audit attacker missed-4).
test('make-certs.sh builds a CA that can sign only for its host', (t) => {
  if (process.platform === 'win32' || !fs.existsSync('/usr/bin/openssl')) return t.skip('needs bash and openssl');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-nc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const certs = path.join(dir, 'certs');
  execFileSync('bash', [path.join(ROOT_DIR, 'blindfold', 'make-certs.sh'), 'chatgpt.com', certs], { stdio: 'ignore' });
  const ossl = (...args) => execFileSync('openssl', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(ossl('verify', '-CAfile', path.join(certs, 'ca.pem'), path.join(certs, 'leaf.pem')), /OK/);

  // A leaf for another host, signed with the same CA key, must fail verification.
  ossl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'evil.key');
  ossl('req', '-new', '-key', 'evil.key', '-subj', '/CN=evil.test', '-out', 'evil.csr');
  fs.writeFileSync(path.join(dir, 'evil.ext'), 'subjectAltName = DNS:evil.test\n');
  ossl('x509', '-req', '-in', 'evil.csr', '-CA', path.join(certs, 'ca.pem'), '-CAkey', path.join(certs, 'ca.key'),
    '-CAcreateserial', '-days', '1', '-extfile', 'evil.ext', '-out', 'evil.pem');
  // LibreSSL prints the verify error on stdout, OpenSSL 3 on stderr.
  assert.throws(() => ossl('verify', '-CAfile', path.join(certs, 'ca.pem'), 'evil.pem'),
    (e) => /permitted subtree violation/.test(`${e.stdout}${e.stderr}`));
});

// ---- Launch state, config cache, logs, probes (audit F28, F31, F42, M5, racer "blocked gateway") ----

// Paths are computed at import, so each scenario runs state.mjs in a child with its own dirs.
function runState(env, code) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const s = await import(${JSON.stringify(path.join(ROOT_DIR, 'state.mjs'))}); const fs = await import('node:fs'); const path = await import('node:path');
     const result = await (async () => { ${code} })(); console.log(JSON.stringify(result));`],
  { env: { ...process.env, LLM_SWITCHER_PORT: '', ...env }, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

function tmpDirs(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify(makeCfg()), { mode: 0o600 });
  return { dir, env: { LLM_SWITCHER_CONFIG: cfg, LLM_SWITCHER_STATE_DIR: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude') } };
}

test('launch files follow LLM_SWITCHER_STATE_DIR, so tests never touch the real ones', (t) => {
  const { dir, env } = tmpDirs(t);
  const r = runState(env, `const st = s.applyLaunchState(s.loadConfig(), 4000); return { active: fs.existsSync(path.join(${JSON.stringify(dir)}, 'active.flag')), flag: s.paths.activeFlag };`);
  assert.equal(r.active, true);
  assert.equal(r.flag, path.join(dir, 'active.flag'));
});

test('a failed env write leaves the flags alone, so no launcher sources a missing env file', (t) => {
  const { dir, env } = tmpDirs(t);
  fs.mkdirSync(path.join(dir, 'env-codex.sh'));
  const r = runState(env, `const st = s.applyLaunchState(s.loadConfig(), 4000); return { err: st.envWriteError || null, active: fs.existsSync(s.paths.activeFlag), envSh: fs.existsSync(s.paths.envSh) };`);
  assert.ok(r.err, 'the failure is reported');
  assert.equal(r.active, false, 'active.flag is not written when the env files are not');
});

test('a haiku-only 1M profile reports its 1M tier and keeps the main session model', () => {
  const cfg = makeCfg();
  cfg.profiles.router.model1M = { haiku: true };
  const st = computeLaunchState(cfg, 4000);
  assert.equal(st.claude1M, null, 'the main session does not move to Haiku');
  assert.deepEqual(st.claude1MTiers, ['haiku']);
  assert.equal(Object.fromEntries(st.env).ANTHROPIC_DEFAULT_HAIKU_MODEL, 'haiku[1m]');
});

test('loadConfig sees a rewrite that keeps the same mtime', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  const r = runState(env, `
    const first = s.loadConfig().activeProfile;
    const st = fs.statSync(${JSON.stringify(cfgPath)});
    const next = JSON.parse(fs.readFileSync(${JSON.stringify(cfgPath)}, 'utf8'));
    next.activeProfile = 'codexOnly';
    fs.writeFileSync(${JSON.stringify(cfgPath)} + '.new', JSON.stringify(next));
    fs.renameSync(${JSON.stringify(cfgPath)} + '.new', ${JSON.stringify(cfgPath)});
    fs.utimesSync(${JSON.stringify(cfgPath)}, st.atime, st.mtime);
    return { first, second: s.loadConfig().activeProfile };`);
  assert.equal(r.first, 'router');
  assert.equal(r.second, 'codexOnly');
});

test('openLog rotates a log above the size limit', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'proxy.log');
  fs.writeFileSync(file, Buffer.alloc(11 * 1024 * 1024, 'a'));
  fs.closeSync(openLog(file));
  assert.equal(fs.statSync(file).size, 0);
  assert.equal(fs.statSync(`${file}.1`).size, 11 * 1024 * 1024);
  if (process.platform !== 'win32') assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
});

test('a port that accepts but never answers probes as silent, not as foreign', async (t) => {
  const net = await import('node:net');
  const server = net.createServer(() => {});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  assert.equal(await probeGateway(server.address().port), 'silent');
});

// A gateway from before 1.1.1 answers /health without an identity proof. It is ours in spirit but
// cannot be proven, so it is never stopped; the CLI names it instead of calling it a foreign process.
test('a pre-1.1.1 gateway answers without a proof and probes as legacy, not as foreign', async (t) => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', proxy: 'llm-switcher', port: server.address().port, configLoaded: true }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  assert.equal(await probeGateway(server.address().port), 'legacy');
});

test('an llm-switcher answer with a wrong proof is still foreign', async (t) => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', proxy: 'llm-switcher', port: server.address().port, pid: 1, proof: 'forged' }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  assert.equal(await probeGateway(server.address().port), 'foreign');
});

// Codex parses an unquoted --config value as TOML first. The Windows shim passes names unquoted, so a
// name that TOML reads as a number, a boolean or a date would change type (audit N-3 residual).
test('isSafeModelName refuses names that TOML reads as something other than a string', () => {
  for (const bad of ['1.5', '42', 'true', 'false', 'inf', '-nan', '0x1F', '0o17', '0b101', '1e5', '1_000', '2024-01-01', '07:32:00']) {
    assert.equal(isSafeModelName(bad), false, bad);
  }
  for (const good of ['gpt-5.2', 'o3', 'ag/gemini-3.8-flash', 'claude-opus-4-6', 'qwen3:32b', 'e5-large']) {
    assert.equal(isSafeModelName(good), true, good);
  }
});

// The CLI and the gateway both write the launch files, one file at a time. Two writers that overlap
// would leave env.sh from one state and env-codex.sh from another (audit racer-M6).
test('launch-file writers take turns through a lock, and a dead holder does not block them', async (t) => {
  const { dir, env } = tmpDirs(t);
  const lock = path.join(dir, '.launch.lock');
  // A live holder: this test process. The child must wait until the lock is gone.
  fs.writeFileSync(lock, String(process.pid));
  setTimeout(() => fs.rmSync(lock, { force: true }), 400);
  const started = Date.now();
  const r = await new Promise((resolve, reject) => {
    execFileCb(process.execPath, ['--input-type=module', '-e',
      `const s = await import(${JSON.stringify(path.join(ROOT_DIR, 'state.mjs'))}); const t0 = Date.now(); s.applyLaunchState(s.loadConfig(), 4000); console.log(Date.now() - t0);`],
    { env: { ...process.env, LLM_SWITCHER_PORT: '', ...env }, encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(Number(out.trim()))));
  });
  // Without the lock the write takes a few ms; with it the child waits for the release at 400 ms.
  assert.ok(r >= 100, `the writer waited ${r} ms for the live holder`);
  assert.ok(Date.now() - started >= 380);
  assert.equal(fs.existsSync(lock), false, 'the writer releases the lock');
  // A holder that no longer runs is taken over at once.
  fs.writeFileSync(lock, '999999999');
  const quick = runState(env, `const t0 = Date.now(); s.applyLaunchState(s.loadConfig(), 4000); return Date.now() - t0;`);
  assert.ok(quick < 1000, `a stale lock blocked for ${quick} ms`);
  assert.equal(fs.existsSync(lock), false);
});

// A probe that never settles held the gateway's admin chain for good (follow-up RACER-1): a listener
// that answers with more than 64 KB, or one that trickles bytes without end.
test('probes settle within their deadline for an oversized or a never-ending answer', async (t) => {
  const http = await import('node:http');
  const big = http.createServer((req, res) => res.end(Buffer.alloc(100 * 1024, 'x')));
  const trickle = http.createServer((req, res) => {
    res.writeHead(200);
    const timer = setInterval(() => res.write('x'), 500);
    res.on('close', () => clearInterval(timer));
  });
  for (const s of [big, trickle]) await new Promise(r => s.listen(0, '127.0.0.1', r));
  t.after(() => { big.close(); trickle.close(); big.closeAllConnections?.(); trickle.closeAllConnections?.(); });
  for (const [s, want] of [[big, 'foreign'], [trickle, 'silent']]) {
    const started = Date.now();
    const state = await Promise.race([probeGateway(s.address().port), new Promise(r => setTimeout(() => r('pending'), 5000))]);
    assert.equal(state, want);
    assert.ok(Date.now() - started < 3600, `settled after ${Date.now() - started} ms`);
  }
});

test('isSafeModelName refuses TOML date-times with T and Z', () => {
  for (const bad of ['2024-01-01T00:00:00Z', '1979-05-27T07:32:00', '1979-05-27 07:32:00+07:00', '1979-05-27t07:32:00.5z']) {
    assert.equal(isSafeModelName(bad), false, bad);
  }
});

// An empty lock file is a writer between create and write. Taking it over let two writers in
// (follow-up RACER-2).
test('an empty launch lock is held, not taken over', async (t) => {
  const { dir, env } = tmpDirs(t);
  const lock = path.join(dir, '.launch.lock');
  fs.writeFileSync(lock, '');
  setTimeout(() => fs.rmSync(lock, { force: true }), 400);
  const waited = await new Promise((resolve, reject) => {
    execFileCb(process.execPath, ['--input-type=module', '-e',
      `const s = await import(${JSON.stringify(path.join(ROOT_DIR, 'state.mjs'))}); const t0 = Date.now(); s.applyLaunchState(s.loadConfig(), 4000); console.log(Date.now() - t0);`],
    { env: { ...process.env, LLM_SWITCHER_PORT: '', ...env }, encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(Number(out.trim()))));
  });
  // Taken over at once, the write would take a few ms.
  assert.ok(waited >= 100 && waited < 4000, `the writer waited ${waited} ms`);
  assert.equal(fs.existsSync(lock), false);
});
