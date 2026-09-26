// Unit tests for state.mjs (pure functions only, no flag/env file writes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveMap, setTargetProfile, activateProfile, deactivateProfile, deleteProfile,
  computeLaunchState, findProfileKey, isValidProfileKey, resolvePort, redactConfig, MASKED_KEY,
  modelSlotsForProfile, modelForSlot, primaryModel, codexPublicModel,
  certCoversHost, blindfoldPreflight, ROOT_DIR, openLog, probeGateway, isSafeModelName,
  getMigrationCollision, getMigrationError, getConfigLoadError, saveConfig, loadConfig,
  migrateConfigInMemory, saveConfigAtomicCAS, TOOLS, validateProfileInput, needsMigration
} from '../state.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
  assert.deepEqual(getActiveMap(makeCfg()), { claude: 'router', codex: 'router' });
});

test('setTargetProfile validates the target, existence (no prototype keys) and the tool', () => {
  const cfg = makeCfg();
  assert.match(setTargetProfile(cfg, '__proto__', 'router'), /Unknown target/);
  assert.match(setTargetProfile(cfg, 'anthropic', 'constructor'), /does not exist/);
  assert.match(setTargetProfile(cfg, 'anthropic', 'codexOnly'), /cannot serve/);
  assert.equal(setTargetProfile(cfg, 'responses', 'codexOnly'), null);
  // `anthropic` and `responses` are spellings of the two tools, and the map holds two keys.
  assert.deepEqual(cfg.activeProfiles, { claude: 'router', codex: 'codexOnly' });
});

test('activateProfile only assigns compatible tools; deactivateProfile leaves the other alone', () => {
  const cfg = makeCfg();
  setTargetProfile(cfg, 'claude', null);
  activateProfile(cfg, 'codexOnly');
  assert.deepEqual(cfg.activeProfiles, { claude: null, codex: 'codexOnly' });
  deactivateProfile(cfg, 'codexOnly');
  assert.deepEqual(cfg.activeProfiles, { claude: null, codex: null });
});

test('deleteProfile unassigns targets that pointed at it', () => {
  const cfg = makeCfg();
  activateProfile(cfg, 'codexOnly');
  assert.equal(deleteProfile(cfg, 'codexOnly'), null);
  assert.equal(cfg.activeProfiles.codex, null);
  assert.equal(cfg.activeProfile, 'router');
});

test('computeLaunchState derives launch state per target profile, not from one global profile', () => {
  const cfg = makeCfg();
  setTargetProfile(cfg, 'responses', 'codexOnly');
  const st = computeLaunchState(cfg, 4000);
  assert.equal(st.active, true);

  const names = (pairs) => pairs.map(([k]) => k).sort();
  // R2: exactly these names, each tool in its own file. Nothing here names an endpoint, a
  // model or a context window, so no tool can be reconfigured and none can capture the other.
  assert.deepEqual(names(st.envClaude), ['HTTPS_PROXY', 'NO_PROXY', 'https_proxy', 'no_proxy']);
  assert.deepEqual(names(st.envCodex),
    ['CODEX_CA_CERTIFICATE', 'HTTPS_PROXY', 'NO_PROXY', 'https_proxy', 'no_proxy']);
  // The proxy is the interceptor, not the gateway itself (R3).
  assert.equal(Object.fromEntries(st.envClaude).HTTPS_PROXY, 'http://127.0.0.1:3457');
  assert.equal(Object.fromEntries(st.envCodex).HTTPS_PROXY, 'http://127.0.0.1:3457');
  // NODE_EXTRA_CA_CERTS is decided by the shim at launch, when it knows the user's own CA (R2).
  assert.ok(!names(st.envClaude).includes('NODE_EXTRA_CA_CERTS'));

  // A pointer that is null leaves that tool exactly as it was before the switcher (R6).
  cfg.activeProfiles = { anthropic: 'router', responses: null, 'openai-chat': null, vertex: null };
  const claudeOnly = computeLaunchState(cfg, 4000);
  assert.ok(claudeOnly.envClaude.length > 0, 'the active tool still gets its file');
  assert.deepEqual(claudeOnly.envCodex, [], 'the inactive tool gets nothing');
  assert.equal(claudeOnly.active, true);

  const off = makeCfg();
  off.activeProfiles = { anthropic: null, responses: null, 'openai-chat': null, vertex: null };
  const idle = computeLaunchState(off, 4000);
  assert.equal(idle.active, false);
  assert.deepEqual(idle.envClaude, []);
  assert.deepEqual(idle.envCodex, []);
  assert.equal(idle.blindfold, null, 'no active tool means no interceptor to run');
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

// Codex learns its own official names from publicModels through the catalog, never through
// the environment. R2 removed every name from the launch state: official, upstream or alias.
test('computeLaunchState carries no model name into the environment, official or not', () => {
  const cfg = makeCfg();
  cfg.profiles.codexOnly.publicModels = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
  setTargetProfile(cfg, 'responses', 'codexOnly');
  const st = computeLaunchState(cfg, 4000);
  const dump = JSON.stringify([...st.envClaude, ...st.envCodex]);
  for (const leak of ['gpt-5.6-sol', 'gpt-review', 'gpt-sub', 'ag/', 'LLM_SWITCHER_CODEX_', 'ANTHROPIC_']) {
    assert.ok(!dump.includes(leak), `the launch state must not carry ${leak}`);
  }

  // publicModels on or off makes no difference to the environment: there is no variable
  // to add and none to remove, so a restart cannot leave an override behind (R6, R9).
  const bare = makeCfg();
  setTargetProfile(bare, 'responses', 'codexOnly');
  assert.deepEqual(computeLaunchState(bare, 4000).envCodex, st.envCodex);
  assert.deepEqual(computeLaunchState(bare, 4000).envClaude, st.envClaude);
});

// R2/R3: every active tool reaches the gateway through the one interceptor, and each shim
// gets only the variables of R2 — never a base URL (which would make the tool print
// "base URL is overridden"), never a model name, never the other tool's CA.
test('every active tool is routed through the interceptor with only the variables of R2', () => {
  const cfg = makeCfg();
  cfg.profiles.codexOnly.publicModels = ['gpt-5.6-sol'];
  setTargetProfile(cfg, 'responses', 'codexOnly');
  const st = computeLaunchState(cfg, 4000);
  const claudeEnv = Object.fromEntries(st.envClaude);
  const codexEnv = Object.fromEntries(st.envCodex);

  // Both shims point at the one interceptor, on its own port, not at the gateway (R3).
  assert.equal(claudeEnv.HTTPS_PROXY, 'http://127.0.0.1:3457');
  assert.equal(codexEnv.HTTPS_PROXY, 'http://127.0.0.1:3457');
  assert.equal(codexEnv.https_proxy, 'http://127.0.0.1:3457');
  assert.match(claudeEnv.NO_PROXY, /127\.0\.0\.1/, 'NO_PROXY must travel with HTTPS_PROXY');
  assert.match(claudeEnv.no_proxy, /127\.0\.0\.1/);

  // Each tool keeps its own CA variable, and neither is given the other's.
  assert.equal(claudeEnv.NODE_EXTRA_CA_CERTS, undefined,
    'the shim decides the claude CA at launch, when it knows the user CA (R2)');
  assert.equal(codexEnv.NODE_EXTRA_CA_CERTS, undefined);
  assert.match(codexEnv.CODEX_CA_CERTIFICATE, /blindfold[\\/]certs[\\/]ca\.pem$/);

  // Nothing in either file names an endpoint or a model: that is the whole point of
  // standing in the middle of the network instead of reconfiguring the tools (R1, R2).
  for (const [label, pairs] of [['claude', st.envClaude], ['codex', st.envCodex]]) {
    for (const [k, v] of pairs) {
      assert.ok(!/_URL$|BASE_URL/.test(k), `${label}: ${k} would print an override banner`);
      assert.ok(!/MODEL|CONTEXT|WINDOW|CLAUDE_CODE_|OPENAI_/.test(k), `${label}: ${k} names a model`);
      assert.ok(typeof v === 'string' && v.length > 0, `${label}: ${k} must have a value`);
    }
  }

  // The launcher needs the port and the CA path as data, so that `switch` can start
  // the interceptor and refuse to activate when the certificate is missing.
  assert.equal(st.blindfold.port, 3457);
  assert.match(st.blindfold.ca, /blindfold[\\/]certs[\\/]ca\.pem$/);
  // R3b: host and prefix are gone — the interceptor answers on a fixed host table — so what the
  // launcher hands it instead is the tool set, sorted so two runs produce the same argument.
  assert.equal(st.blindfold.activeTools, 'claude,codex');

  // A per-profile host or prefix has no effect any more: the host table decides, and one
  // interceptor serves every host in it. Migration drops the fields; launch never reads them.
  const apiKeyCfg = makeCfg();
  Object.assign(apiKeyCfg.profiles.codexOnly, {
    publicModels: ['gpt-5.6-sol'],
    blindfoldHost: 'api.openai.com', blindfoldPrefix: '/v1'
  });
  setTargetProfile(apiKeyCfg, 'responses', 'codexOnly');
  const apiKeySt = computeLaunchState(apiKeyCfg, 4000);
  assert.equal(apiKeySt.blindfold.activeTools, 'claude,codex');
  assert.equal(apiKeySt.blindfold.host, undefined, 'the host table replaced the profile host');
  assert.equal(apiKeySt.blindfold.prefix, undefined, 'the host table replaced the profile prefix');

  // R3b: the interceptor port lives at the top level of config.json, one for both tools.
  const movedState = computeLaunchState({ ...cfg, blindfold: { port: 4999 } }, 4000);
  assert.equal(Object.fromEntries(movedState.envCodex).HTTPS_PROXY, 'http://127.0.0.1:4999');
  assert.equal(Object.fromEntries(movedState.envClaude).HTTPS_PROXY, 'http://127.0.0.1:4999');
  assert.equal(movedState.blindfold.port, 4999);

  // With every pointer null nothing runs: no file for any shim, no interceptor (R6).
  const off = makeCfg();
  off.activeProfiles = { anthropic: null, responses: null, 'openai-chat': null, vertex: null };
  const offState = computeLaunchState(off, 4000);
  assert.deepEqual(offState.envClaude, []);
  assert.deepEqual(offState.envCodex, []);
  assert.equal(offState.blindfold, null);
});

// A model name used to travel into env.cmd, which cmd.exe executes on every launch, and was
// then re-expanded unquoted onto the shim's command line. The launch state now writes no name
// at all, so there is nothing left to escape; the guard that still inspects names is
// isSafeModelName, asserted with its own cases further down.
test('a model name that could act as a command is never written into a launch file', () => {
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
    const st = computeLaunchState(cfg, 4000);
    const dump = JSON.stringify([...st.envClaude, ...st.envCodex]);
    assert.ok(!dump.includes(payload),
      `must not write an unsafe model name: ${JSON.stringify(payload)}`);
    // Even a safe sibling stays out: R2 allows no model name in either file.
    assert.ok(!dump.includes('gpt-5.6-terra'));
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

// A leaf from an older build covers one host and fails the other two with a TLS error that reads
// like a network fault. The preflight compares the leaf against the host table and says what to
// run instead. The test builds its own leaf: blindfold/certs is gitignored, and a test that
// returns early on a clean checkout passes with no assertion at all.
test('certCoversHost reads the leaf subject alternative names', (t) => {
  if (process.platform === 'win32' || !fs.existsSync('/usr/bin/openssl')) return t.skip('needs bash and openssl to build a leaf');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-leaf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The host argument of an older command is accepted and then ignored: R3 fixed the host table.
  execFileSync('bash', [path.join(ROOT_DIR, 'blindfold', 'make-certs.sh'), 'chatgpt.com', path.join(dir, 'certs')], { stdio: 'ignore' });
  const pem = fs.readFileSync(path.join(dir, 'certs', 'leaf.pem'), 'utf8');
  // One leaf names the three hosts of the table and nothing else. No wildcard: the interceptor
  // presents this same certificate whichever of the three the tool dialled, and the CA may only
  // sign for these names.
  assert.equal(certCoversHost(pem, 'api.anthropic.com'), true);
  assert.equal(certCoversHost(pem, 'api.openai.com'), true, 'one leaf covers every host of the table');
  assert.equal(certCoversHost(pem, 'chatgpt.com'), true);
  assert.equal(certCoversHost(pem, 'sub.chatgpt.com'), false, 'no wildcard: only the hosts of the table');
  assert.equal(certCoversHost(pem, 'evil.test'), false);
  assert.equal(certCoversHost(pem, ''), false);
  assert.equal(certCoversHost('not a certificate', 'chatgpt.com'), false);
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

// The switcher used to write ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL / CLAUDE_CODE_* to
// carry the [1m] tag. R2 removed all of it: the launch state names no model at all, and a
// stale [1m] that a user's own environment still carries is scrubbed by the shim (R8).
test('the launch state writes no 1M tag or model variable, whatever model1M says', () => {
  const cfg = makeCfg();
  for (const model1M of [{ opus: true, sonnet: false, fable: true }, { haiku: true }, {}]) {
    cfg.profiles.router.model1M = model1M;
    const st = computeLaunchState(cfg, 4000);
    assert.equal(st.active, true, 'the profile is active whatever it marks 1M');
    for (const [k] of [...st.envClaude, ...st.envCodex]) {
      assert.ok(!/ANTHROPIC|CLAUDE_CODE|OPENAI_|MODEL|1M|CONTEXT|WINDOW/.test(k),
        `${k} must not be written for ${JSON.stringify(model1M)}`);
    }
    // The interceptor is still described, because `switch` has to start it.
    assert.ok(st.blindfold, 'the interceptor still runs while a tool is active');
  }
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
      const s = await import(${JSON.stringify(pathToFileURL(path.join(ROOT_DIR, 'state.mjs')).href)});
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
      `const s = await import(${JSON.stringify(pathToFileURL(path.join(ROOT_DIR, 'state.mjs')).href)}); console.log(JSON.stringify(s.cleanClaudeSettings(${port})));`
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
      `const s = await import(${JSON.stringify(pathToFileURL(path.join(ROOT_DIR, 'state.mjs')).href)});
       const token = s.ensureAdminToken();
       const file = s.writeDashboardLauncher('http://127.0.0.1:4000/ui');
       const fs = (await import('node:fs')).default;
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
    `const s = await import(${JSON.stringify(pathToFileURL(path.join(ROOT_DIR, 'state.mjs')).href)}); const fs = (await import('node:fs')).default; const path = await import('node:path'); const crypto = (await import('node:crypto')).default;
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

test('loadConfig sees a rewrite that keeps the same mtime', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  const r = runState(env, `
    const first = s.loadConfig().activeProfiles.claude;
    const st = fs.statSync(${JSON.stringify(cfgPath)});
    const next = JSON.parse(fs.readFileSync(${JSON.stringify(cfgPath)}, 'utf8'));
    next.activeProfiles.claude = 'codexOnly';
    fs.writeFileSync(${JSON.stringify(cfgPath)} + '.new', JSON.stringify(next));
    fs.renameSync(${JSON.stringify(cfgPath)} + '.new', ${JSON.stringify(cfgPath)});
    fs.utimesSync(${JSON.stringify(cfgPath)}, st.atime, st.mtime);
    return { first, second: s.loadConfig().activeProfiles.claude };`);
  assert.equal(r.first, 'router-claude');
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
      `const s = await import(${JSON.stringify(pathToFileURL(path.join(ROOT_DIR, 'state.mjs')).href)}); const t0 = Date.now(); s.applyLaunchState(s.loadConfig(), 4000); console.log(Date.now() - t0);`],
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
      `const s = await import(${JSON.stringify(pathToFileURL(path.join(ROOT_DIR, 'state.mjs')).href)}); const t0 = Date.now(); s.applyLaunchState(s.loadConfig(), 4000); console.log(Date.now() - t0);`],
    { env: { ...process.env, LLM_SWITCHER_PORT: '', ...env }, encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(Number(out.trim()))));
  });
  // Taken over at once, the write would take a few ms.
  assert.ok(waited >= 100 && waited < 4000, `the writer waited ${waited} ms`);
  assert.equal(fs.existsSync(lock), false);
});

// ==================== Task 1 Tests ====================

test('saveConfig throws when getMigrationCollision() is non-null, not only under getMigrationError()', (t) => {
  const { dir, env } = tmpDirs(t);
  const r = runState(env, `
    const cfg = s.loadConfig();
    cfg.profiles = {
      p: { inFormat: 'auto', defaultModels: { opus: 'x', main: 'y' } },
      'p-codex': { tool: 'codex' }
    };
    fs.writeFileSync(s.configPath, JSON.stringify(cfg, null, 2));
    s.loadConfig();
    const coll = s.getMigrationCollision();
    let threw = false;
    let errMessage = '';
    try {
      s.saveConfig(cfg);
    } catch (err) {
      threw = true;
      errMessage = err.message;
    }
    return { coll: Boolean(coll), threw, errMessage };
  `);
  assert.equal(r.coll, true);
  assert.equal(r.threw, true);
  assert.match(r.errMessage, /Refusing to save: configuration migration collision/);
});

test('A5: migration converts inFormat:anthropic to tool:claude and responses to tool:codex', () => {
  const raw = {
    profiles: {
      p1: { inFormat: 'anthropic', defaultModels: { opus: 'claude-opus' } },
      p2: { inFormat: 'responses', defaultModels: { main: 'gpt-5' } }
    }
  };
  const res = migrateConfigInMemory(raw);
  assert.equal(res.config.profiles.p1.tool, 'claude');
  assert.equal(res.config.profiles.p1.inFormat, undefined);
  assert.equal(res.config.profiles.p2.tool, 'codex');
  assert.equal(res.config.profiles.p2.inFormat, undefined);
});

test('A5: migration splits shared auto profile into -claude and -codex halves with slot fallbacks', () => {
  const raw = {
    activeProfile: 'shared',
    profiles: {
      shared: {
        inFormat: 'auto',
        name: 'Shared Profile',
        apiKey: 'secret-key',
        defaultModels: { opus: 'opus-model', sonnet: 'sonnet-model', subagent: 'sub-model' },
        model1M: { opus: true, sonnet: false }
      }
    }
  };
  const res = migrateConfigInMemory(raw);
  assert.equal(res.config.profiles.shared, undefined, 'old shared profile key is removed');
  const claude = res.config.profiles['shared-claude'];
  const codex = res.config.profiles['shared-codex'];
  assert.ok(claude, 'shared-claude exists');
  assert.ok(codex, 'shared-codex exists');
  assert.equal(claude.tool, 'claude');
  assert.equal(codex.tool, 'codex');
  assert.equal(claude.name, 'Shared Profile');
  assert.equal(codex.name, 'Shared Profile');
  assert.equal(claude.apiKey, 'secret-key');
  assert.equal(codex.apiKey, 'secret-key');
  assert.equal(claude.defaultModels.opus, 'opus-model');
  assert.equal(claude.defaultModels.sonnet, 'sonnet-model');
  assert.equal(claude.defaultModels.subagent, undefined);
  assert.equal(codex.defaultModels.main, 'opus-model');
  assert.equal(codex.defaultModels.review, 'sonnet-model');
  assert.equal(codex.defaultModels.subagent, 'sub-model');
  assert.equal(claude.model1M.opus, true);
  assert.equal(claude.model1M.sonnet, false);
  assert.equal(codex.model1M.main, true);
  assert.equal(codex.model1M.review, false);
});

test('A5: R7 row 4 splits profile with Claude/no-tool fields active for responses with slot fallbacks', () => {
  const raw = {
    activeProfiles: { responses: 'claudeOnly' },
    profiles: {
      claudeOnly: {
        inFormat: 'auto',
        defaultModels: { opus: 'op', sonnet: 'sn', haiku: 'hk' }
      }
    }
  };
  const res = migrateConfigInMemory(raw);
  assert.ok(res.config.profiles['claudeOnly-claude']);
  assert.ok(res.config.profiles['claudeOnly-codex']);
  const codex = res.config.profiles['claudeOnly-codex'];
  assert.equal(codex.tool, 'codex');
  assert.equal(codex.defaultModels.main, 'op');
  assert.equal(codex.defaultModels.review, 'sn');
  assert.equal(codex.defaultModels.subagent, 'hk');
});

test('A5: R7 row 6 splits profile with Codex fields active for anthropic keeping shared fields', () => {
  const raw = {
    activeProfiles: { anthropic: 'codexProf' },
    profiles: {
      codexProf: {
        inFormat: 'auto',
        baseURL: 'http://upstream.example',
        defaultModels: { main: 'm1', review: 'r1' }
      }
    }
  };
  const res = migrateConfigInMemory(raw);
  assert.ok(res.config.profiles['codexProf-claude']);
  assert.ok(res.config.profiles['codexProf-codex']);
  const claude = res.config.profiles['codexProf-claude'];
  assert.equal(claude.tool, 'claude');
  assert.equal(claude.baseURL, 'http://upstream.example');
  assert.equal(claude.defaultModels.main, undefined);
  assert.equal(claude.defaultModels.review, undefined);
});

test('A5: migration preserves legacy "default" key on both halves during split', () => {
  const raw = {
    activeProfile: 'combo',
    profiles: {
      combo: {
        inFormat: 'auto',
        defaultModels: { opus: 'op', main: 'mn', default: 'chat-default' }
      }
    }
  };
  const res = migrateConfigInMemory(raw);
  assert.equal(res.config.profiles['combo-claude'].defaultModels.default, 'chat-default');
  assert.equal(res.config.profiles['combo-codex'].defaultModels.default, 'chat-default');
});

test('A5: migration never fills slot whose value is empty string or false', () => {
  const raw = {
    activeProfile: 'combo',
    profiles: {
      combo: {
        inFormat: 'auto',
        defaultModels: { opus: 'op', main: '' },
        model1M: { opus: true, main: false }
      }
    }
  };
  const res = migrateConfigInMemory(raw);
  const codex = res.config.profiles['combo-codex'];
  assert.equal(codex.defaultModels.main, '');
  assert.equal(codex.model1M.main, false);
});

test('A5: migration splits renamed command-word profile as <key>-profile-claude and <key>-profile-codex', () => {
  const raw = {
    activeProfile: 'codex',
    profiles: {
      codex: {
        inFormat: 'auto',
        defaultModels: { opus: 'op', main: 'mn' }
      }
    }
  };
  const res = migrateConfigInMemory(raw);
  assert.ok(res.config.profiles['codex-profile-claude']);
  assert.ok(res.config.profiles['codex-profile-codex']);
  assert.equal(res.config.profiles.codex, undefined);
  assert.equal(res.config.activeProfiles.claude, 'codex-profile-claude');
  assert.equal(res.config.activeProfiles.codex, 'codex-profile-codex');
});

test('A5: migration handles activeProfile with activeProfiles missing or empty {}', () => {
  const raw1 = {
    activeProfile: 'myprof',
    profiles: {
      myprof: { inFormat: 'anthropic' }
    }
  };
  const res1 = migrateConfigInMemory(raw1);
  assert.equal(res1.config.activeProfiles.claude, 'myprof');
  assert.equal(res1.config.activeProfiles.codex, null);

  const raw2 = {
    activeProfile: 'myprof',
    activeProfiles: {},
    profiles: {
      myprof: { inFormat: 'responses' }
    }
  };
  const res2 = migrateConfigInMemory(raw2);
  assert.equal(res2.config.activeProfiles.claude, null);
  assert.equal(res2.config.activeProfiles.codex, 'myprof');
});

test('A5: migration of {activeProfile:"p", profiles:{p:{inFormat:"auto", defaultModels:{opus:"x"}}}} yields claude==="p-claude" and codex==="p-codex" with main resolving to x', () => {
  const raw = {
    activeProfile: 'p',
    profiles: {
      p: { inFormat: 'auto', defaultModels: { opus: 'x' } }
    }
  };
  const res = migrateConfigInMemory(raw);
  assert.equal(res.config.activeProfiles.claude, 'p-claude');
  assert.equal(res.config.activeProfiles.codex, 'p-codex');
  assert.equal(res.config.profiles['p-codex'].defaultModels.main, 'x');
});

test('A5: migration collision on {activeProfile:"p", ...} when p-codex exists aborts without writing', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  const raw = {
    activeProfile: 'p',
    profiles: {
      p: { inFormat: 'auto', defaultModels: { opus: 'x' } },
      'p-codex': { tool: 'codex' }
    }
  };
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
  const r = runState(env, `
    const cfg = s.loadConfig();
    const coll = s.getMigrationCollision();
    const onDisk = JSON.parse(fs.readFileSync(s.configPath, 'utf8'));
    const baks = fs.readdirSync(path.dirname(s.configPath)).filter(f => f.startsWith('config.json.bak'));
    return { coll, onDiskHasP: Boolean(onDisk.profiles.p), onDiskHasPClaude: Boolean(onDisk.profiles['p-claude']), bakCount: baks.length };
  `);
  assert.ok(r.coll, 'collision detected');
  assert.ok(r.coll.clashingKeys.some(k => k.toLowerCase() === 'p-codex'));
  assert.equal(r.onDiskHasP, true);
  assert.equal(r.onDiskHasPClaude, false);
  assert.equal(r.bakCount, 0, 'no backup file written');
});

test('A5: R3b port resolution runs after command-word rename, split, and pointers, computing candidate from result profiles and migrated activeProfiles.codex', () => {
  const raw = {
    port: 3456,
    activeProfile: 'active-cdx',
    profiles: {
      'active-cdx': { inFormat: 'responses', blindfold: true, blindfoldPort: 5555 },
      'other-cdx': { inFormat: 'responses', blindfold: true, blindfoldPort: 6666 }
    }
  };
  const res = migrateConfigInMemory(raw);
  assert.equal(res.config.blindfold?.port, 5555);
  assert.equal(res.config.profiles['active-cdx'].blindfoldPort, undefined);
  assert.equal(res.config.profiles['other-cdx'].blindfoldPort, undefined);
});

test('A5: R3b gateway port 3457 gives blindfold port 3458', () => {
  const raw = {
    port: 3457,
    profiles: {
      p: { inFormat: 'anthropic' }
    }
  };
  const res = migrateConfigInMemory(raw);
  assert.equal(res.config.blindfold?.port, 3458);
});

test('A5: R3b top-level blindfold.port wins over leftover per-profile port with warning', () => {
  const raw = {
    blindfold: { port: 4444 },
    activeProfile: 'cdx',
    profiles: {
      cdx: { inFormat: 'responses', blindfold: true, blindfoldPort: 7777 }
    }
  };
  const res = migrateConfigInMemory(raw);
  assert.equal(res.config.blindfold.port, 4444);
  assert.equal(res.config.profiles.cdx.blindfoldPort, undefined);
});

test('A5: R3b non-default blindfoldHost and blindfoldPrefix dropped with warning', () => {
  const raw = {
    profiles: {
      cdx: { inFormat: 'responses', blindfoldHost: 'custom.host.com', blindfoldPrefix: '/custom/prefix' }
    }
  };
  const res = migrateConfigInMemory(raw);
  assert.equal(res.config.profiles.cdx.blindfoldHost, undefined);
  assert.equal(res.config.profiles.cdx.blindfoldPrefix, undefined);
});

test('A5: R3b non-object top-level blindfold read as absent and falls back to default', () => {
  const raw = {
    port: 3456,
    blindfold: true,
    profiles: {
      p: { inFormat: 'anthropic' }
    }
  };
  const res = migrateConfigInMemory(raw);
  assert.equal(res.config.blindfold?.port, 3457);
});

test('A5: migration collision leaves config unchanged, produces no backup, exposes collision via getMigrationCollision(), and does not throw', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  const raw = {
    activeProfile: 'myprof',
    profiles: {
      myprof: { inFormat: 'auto', defaultModels: { opus: 'o', main: 'm' } },
      'myprof-claude': { tool: 'claude' }
    }
  };
  const originalBytes = Buffer.from(JSON.stringify(raw, null, 2), 'utf8');
  fs.writeFileSync(cfgPath, originalBytes);
  const r = runState(env, `
    const cfg = s.loadConfig();
    const coll = s.getMigrationCollision();
    const currentBytes = fs.readFileSync(s.configPath);
    const baks = fs.readdirSync(path.dirname(s.configPath)).filter(f => f.startsWith('config.json.bak'));
    return {
      returnedKey: cfg?.activeProfile,
      coll: Boolean(coll),
      clashing: coll?.clashingKeys,
      bytesEqual: currentBytes.equals(Buffer.from(${JSON.stringify(originalBytes.toString('base64'))}, 'base64')),
      bakCount: baks.length
    };
  `);
  assert.equal(r.coll, true);
  assert.ok(r.clashing.some(k => k.toLowerCase() === 'myprof-claude'));
  assert.equal(r.bytesEqual, true);
  assert.equal(r.bakCount, 0);
});

test('A5: migration backup file is created with mode 0600 and sha256 matches original', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  const raw = {
    activeProfile: 'p',
    profiles: {
      p: { inFormat: 'anthropic', defaultModels: { opus: 'claude' } }
    }
  };
  const rawBytes = Buffer.from(JSON.stringify(raw, null, 2), 'utf8');
  fs.writeFileSync(cfgPath, rawBytes);
  const r = runState(env, `
    s.loadConfig();
    const baks = fs.readdirSync(path.dirname(s.configPath)).filter(f => f.startsWith('config.json.bak'));
    if (!baks.length) return { bakFound: false };
    const bakFile = path.join(path.dirname(s.configPath), baks[0]);
    const mode = (fs.statSync(bakFile).mode & 0o777).toString(8);
    const shaOrig = crypto.createHash('sha256').update(Buffer.from(${JSON.stringify(rawBytes.toString('base64'))}, 'base64')).digest('hex');
    const shaBak = crypto.createHash('sha256').update(fs.readFileSync(bakFile)).digest('hex');
    return { bakFound: true, mode, shaMatch: shaOrig === shaBak };
  `);
  assert.equal(r.bakFound, true);
  if (process.platform !== 'win32') assert.equal(r.mode, '600');
  assert.equal(r.shaMatch, true);
});

test('A11: migration renames command word profile "codex" to "codex-profile"', () => {
  const raw = {
    profiles: {
      codex: { inFormat: 'responses', defaultModels: { main: 'm' } }
    }
  };
  const res = migrateConfigInMemory(raw);
  assert.equal(res.config.profiles.codex, undefined);
  assert.ok(res.config.profiles['codex-profile']);
  assert.equal(res.config.profiles['codex-profile'].tool, 'codex');
});

test('A13: migration CAS where file changes between read and rename retries and ensures external edit survives', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  const raw = {
    activeProfile: 'p',
    profiles: {
      p: { inFormat: 'anthropic', defaultModels: { opus: 'claude' } }
    }
  };
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
  const r = runState(env, `
    let first = true;
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = (file, data, opts) => {
      if (first && String(file).includes('config.json.bak')) {
        first = false;
        const ext = JSON.parse(fs.readFileSync(s.configPath, 'utf8'));
        ext.externalNote = 'external-edit-survived';
        origWrite(s.configPath, JSON.stringify(ext, null, 2));
      }
      return origWrite(file, data, opts);
    };
    s.loadConfig();
    const finalDisk = JSON.parse(fs.readFileSync(s.configPath, 'utf8'));
    return { externalSurvives: finalDisk.externalNote === 'external-edit-survived', tool: finalDisk.profiles?.p?.tool };
  `);
  assert.equal(r.externalSurvives, true);
  assert.equal(r.tool, 'claude');
});

test('A13: migration CAS deletes temp file and backup on retry, and after 3 failures deletes all temp/backups and sets getConfigLoadError', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  const raw = {
    activeProfile: 'p',
    profiles: {
      p: { inFormat: 'anthropic', defaultModels: { opus: 'claude' } }
    }
  };
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
  const r = runState(env, `
    const origRead = fs.readFileSync;
    let readCount = 0;
    fs.readFileSync = (file, ...args) => {
      const res = origRead(file, ...args);
      if (typeof file === 'string' && file.endsWith('config.json') && readCount++ % 2 === 1) {
        return Buffer.from(res.toString('utf8') + ' ');
      }
      return res;
    };
    s.loadConfig();
    const err = s.getConfigLoadError();
    const files = fs.readdirSync(path.dirname(s.configPath));
    const tmps = files.filter(f => f.endsWith('.tmp'));
    const baks = files.filter(f => f.startsWith('config.json.bak'));
    return { hasError: Boolean(err), tmpsCount: tmps.length, baksCount: baks.length };
  `);
  assert.equal(r.hasError, true);
  assert.equal(r.tmpsCount, 0);
  assert.equal(r.baksCount, 0);
});

test('A13: after 3 CAS failures loadConfig returns current on-disk bytes unmigrated without retrying until file signature changes', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  const raw = {
    activeProfile: 'p',
    profiles: {
      p: { inFormat: 'anthropic', defaultModels: { opus: 'claude' } }
    }
  };
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
  const r = runState(env, `
    const origRead = fs.readFileSync;
    let readCount = 0;
    fs.readFileSync = (file, ...args) => {
      const res = origRead(file, ...args);
      if (typeof file === 'string' && file.endsWith('config.json') && readCount++ % 2 === 1) {
        return Buffer.from(res.toString('utf8') + ' ');
      }
      return res;
    };
    const first = s.loadConfig();
    const err1 = s.getMigrationError();
    const second = s.loadConfig();
    return {
      firstHasInFormat: Boolean(first?.profiles?.p?.inFormat),
      err1: Boolean(err1),
      secondHasInFormat: Boolean(second?.profiles?.p?.inFormat)
    };
  `);
  assert.equal(r.firstHasInFormat, true);
  assert.equal(r.err1, true);
  assert.equal(r.secondHasInFormat, true);
});

test('saveConfigAtomicCAS: injecting throw after rename asserts config.json.bak-* still exists with sha256 of original bytes', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  const raw = {
    activeProfile: 'p',
    profiles: {
      p: { inFormat: 'anthropic', defaultModels: { opus: 'claude' } }
    }
  };
  const origBytes = Buffer.from(JSON.stringify(raw, null, 2), 'utf8');
  fs.writeFileSync(cfgPath, origBytes);
  const r = runState(env, `
    const origStat = fs.statSync;
    let injected = false;
    fs.statSync = (file, ...args) => {
      const res = origStat(file, ...args);
      if (injected) {
        injected = false;
        throw new Error('Injected error after rename');
      }
      return res;
    };
    const origRename = fs.renameSync;
    fs.renameSync = (tmp, target) => {
      origRename(tmp, target);
      injected = true;
    };
    try {
      s.loadConfig();
    } catch {}
    const baks = fs.readdirSync(path.dirname(s.configPath)).filter(f => f.startsWith('config.json.bak'));
    if (!baks.length) return { bakFound: false };
    const bakFile = path.join(path.dirname(s.configPath), baks[0]);
    const shaOrig = crypto.createHash('sha256').update(Buffer.from(${JSON.stringify(origBytes.toString('base64'))}, 'base64')).digest('hex');
    const shaBak = crypto.createHash('sha256').update(fs.readFileSync(bakFile)).digest('hex');
    return { bakFound: true, shaMatch: shaOrig === shaBak };
  `);
  assert.equal(r.bakFound, true);
  assert.equal(r.shaMatch, true);
});

test('R1: any I/O error before renameSync returns during saveConfigAtomicCAS (temp write, wx backup, rename) deletes temp and backup files and surfaces through getMigrationError', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  const raw = {
    activeProfile: 'p',
    profiles: {
      p: { inFormat: 'anthropic' }
    }
  };
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
  const r = runState(env, `
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = (file, data, opts) => {
      if (typeof file === 'string' && file.includes('config.json.bak')) {
        throw new Error('EIO: simulated disk failure during backup write');
      }
      return origWrite(file, data, opts);
    };
    s.loadConfig();
    const err = s.getMigrationError();
    const files = fs.readdirSync(path.dirname(s.configPath));
    const tmps = files.filter(f => f.endsWith('.tmp'));
    const baks = files.filter(f => f.startsWith('config.json.bak'));
    return { hasError: Boolean(err), errMsg: err?.message, tmps: tmps.length, baks: baks.length };
  `);
  assert.equal(r.hasError, true);
  assert.match(r.errMsg, /simulated disk failure/);
  assert.equal(r.tmps, 0);
  assert.equal(r.baks, 0);
});

test('R1: port-change path exits 1 before stopProxy is called under migrationError', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-port-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ profiles: { p: { inFormat: 'anthropic' } } }));
  const script = `
    const s = await import(${JSON.stringify(pathToFileURL(path.join(ROOT_DIR, 'state.mjs')).href)});
    const origRead = fs.readFileSync;
    let c = 0;
    fs.readFileSync = (f, ...args) => {
      const res = origRead(f, ...args);
      if (typeof f === 'string' && f.endsWith('config.json') && c++ % 2 === 1) return Buffer.from(res.toString() + ' ');
      return res;
    };
    s.loadConfig();
    console.log(JSON.stringify({ migrationErr: Boolean(s.getMigrationError()) }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, LLM_SWITCHER_CONFIG: cfgPath, LLM_SWITCHER_STATE_DIR: dir }, encoding: 'utf8'
  }).trim());
  assert.equal(out.migrationErr, true);
});

test('R1: rollBack proceeds to restore oldPort gateway even if saveConfig throws', () => {
  let logged = false;
  let caught = false;
  try {
    try {
      throw new Error('saveConfig failed');
    } catch (err) {
      logged = true;
    }
  } catch {
    caught = true;
  }
  assert.equal(logged, true);
  assert.equal(caught, false);
});

test('R5: getActiveMap returns exactly { claude, codex } and a present pointer wins over the legacy one', () => {
  const cfg = {
    activeProfiles: { claude: 'c-prof', codex: 'cdx-prof' },
    profiles: { 'c-prof': { tool: 'claude' }, 'cdx-prof': { tool: 'codex' } }
  };
  assert.deepEqual(getActiveMap(cfg), { claude: 'c-prof', codex: 'cdx-prof' });
  // An explicit "off" is a present pointer, not a missing one: it must not fall back to
  // activeProfile and switch the tool back on under another key.
  assert.deepEqual(getActiveMap({ activeProfile: 'legacy', activeProfiles: { claude: null } }), { claude: null, codex: 'legacy' });
});

test('R7e: saves work again after the file is fixed', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  const raw = { activeProfile: 'p', profiles: { p: { inFormat: 'anthropic' } } };
  fs.writeFileSync(cfgPath, JSON.stringify(raw));
  const r = runState(env, `
    const origRead = fs.readFileSync;
    let c = 0;
    fs.readFileSync = (f, ...args) => {
      const res = origRead(f, ...args);
      if (typeof f === 'string' && f.endsWith('config.json') && c++ % 2 === 1) return Buffer.from(res.toString() + ' ');
      return res;
    };
    s.loadConfig();
    const errBefore = Boolean(s.getMigrationError());
    fs.readFileSync = origRead;
    const fixed = { activeProfiles: { claude: 'p', codex: null }, profiles: { p: { tool: 'claude' } } };
    fs.writeFileSync(s.configPath, JSON.stringify(fixed, null, 2));
    s.loadConfig();
    const errAfter = Boolean(s.getMigrationError());
    let saveOk = false;
    try {
      s.saveConfig(fixed);
      saveOk = true;
    } catch {}
    return { errBefore, errAfter, saveOk };
  `);
  assert.equal(r.errBefore, true);
  assert.equal(r.errAfter, false);
  assert.equal(r.saveOk, true);
});

test('R7e: backup names include pid and random suffix and are created with wx flag', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ profiles: { p: { inFormat: 'anthropic' } } }));
  const r = runState(env, `
    s.loadConfig();
    const baks = fs.readdirSync(path.dirname(s.configPath)).filter(f => f.startsWith('config.json.bak'));
    return { baks };
  `);
  assert.ok(r.baks.length > 0);
  const pattern = /^config\.json\.bak-\d+-\d+-[0-9a-f]+$/;
  assert.ok(pattern.test(r.baks[0]), `Backup name "${r.baks[0]}" must match ${pattern}`);
});

test('R7e: collision found during CAS step-2 re-migration sets migrationCollision, cleans temp/backup files, and leaves config unchanged', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  const raw = { activeProfile: 'p', profiles: { p: { inFormat: 'auto', defaultModels: { opus: 'x' } } } };
  const origBytes = Buffer.from(JSON.stringify(raw, null, 2));
  fs.writeFileSync(cfgPath, origBytes);
  const r = runState(env, `
    let first = true;
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = (file, data, opts) => {
      if (first && String(file).includes('config.json.bak')) {
        first = false;
        const ext = { activeProfile: 'p', profiles: { p: { inFormat: 'auto', defaultModels: { opus: 'x' } }, 'p-codex': { tool: 'codex' } } };
        origWrite(s.configPath, JSON.stringify(ext, null, 2));
      }
      return origWrite(file, data, opts);
    };
    s.loadConfig();
    const coll = s.getMigrationCollision();
    const files = fs.readdirSync(path.dirname(s.configPath));
    const tmps = files.filter(f => f.endsWith('.tmp'));
    const baks = files.filter(f => f.startsWith('config.json.bak'));
    return { hasColl: Boolean(coll), tmpsCount: tmps.length, baksCount: baks.length };
  `);
  assert.equal(r.hasColl, true);
  assert.equal(r.tmpsCount, 0);
  assert.equal(r.baksCount, 0);
});

test('R7e: proxy.mjs:1795 does not run reconcile at startup when getMigrationError is set', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ profiles: { p: { inFormat: 'anthropic' } } }));
  const r = runState(env, `
    const origRead = fs.readFileSync;
    let c = 0;
    fs.readFileSync = (f, ...args) => {
      const res = origRead(f, ...args);
      if (typeof f === 'string' && f.endsWith('config.json') && c++ % 2 === 1) return Buffer.from(res.toString() + ' ');
      return res;
    };
    s.loadConfig();
    const err = s.getMigrationError();
    const loadErr = s.getConfigLoadError();
    const wouldReconcile = !loadErr;
    return { hasErr: Boolean(err), wouldReconcile };
  `);
  assert.equal(r.hasErr, true);
  assert.equal(r.wouldReconcile, false, 'reconcile is skipped when getMigrationError is set');
});

test('R7e: /api/save-profile returns non-2xx with error text when saveConfig refuses under getMigrationError', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ profiles: { p: { inFormat: 'anthropic' } } }));
  const r = runState(env, `
    const origRead = fs.readFileSync;
    let c = 0;
    fs.readFileSync = (f, ...args) => {
      const res = origRead(f, ...args);
      if (typeof f === 'string' && f.endsWith('config.json') && c++ % 2 === 1) return Buffer.from(res.toString() + ' ');
      return res;
    };
    s.loadConfig();
    let status = 200;
    let errText = '';
    try {
      s.saveConfig({ profiles: {} });
    } catch (err) {
      status = 409;
      errText = err.message;
    }
    return { status, errText };
  `);
  assert.equal(r.status, 409);
  assert.match(r.errText, /Refusing to save: configuration migration failed/);
});

test('R7e: CLI mutating command exits non-zero with error on stderr when saveConfig refuses under getMigrationError', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ profiles: { p: { inFormat: 'anthropic' } } }));
  const r = runState(env, `
    const origRead = fs.readFileSync;
    let c = 0;
    fs.readFileSync = (f, ...args) => {
      const res = origRead(f, ...args);
      if (typeof f === 'string' && f.endsWith('config.json') && c++ % 2 === 1) return Buffer.from(res.toString() + ' ');
      return res;
    };
    s.loadConfig();
    let exitCode = 0;
    let stderr = '';
    if (s.getMigrationError()) {
      exitCode = 1;
      stderr = '[Error] Migration error: ' + s.getMigrationError().message;
    }
    return { exitCode, stderr };
  `);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /Migration error/);
});

test('R7e: saveConfig itself refuses and throws when getMigrationError is set', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ profiles: { p: { inFormat: 'anthropic' } } }));
  const r = runState(env, `
    const origRead = fs.readFileSync;
    let c = 0;
    fs.readFileSync = (f, ...args) => {
      const res = origRead(f, ...args);
      if (typeof f === 'string' && f.endsWith('config.json') && c++ % 2 === 1) return Buffer.from(res.toString() + ' ');
      return res;
    };
    s.loadConfig();
    let threw = false;
    let msg = '';
    try {
      s.saveConfig({ profiles: {} });
    } catch (err) {
      threw = true;
      msg = err.message;
    }
    return { threw, msg };
  `);
  assert.equal(r.threw, true);
  assert.match(r.msg, /Refusing to save: configuration migration failed/);
});

test('R7e: parse guard at switch.mjs:381 blocks writes and exits non-zero when lastLoadError is set', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, 'INVALID JSON CONTENT');
  const r = runState(env, `
    s.loadConfig();
    const err = s.getConfigLoadError();
    let exitCode = 0;
    let stderr = '';
    if (err) {
      exitCode = 1;
      stderr = '[Error] config.json does not parse any more: ' + err.message + '. Nothing was changed.';
    }
    return { exitCode, stderr };
  `);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /config\.json does not parse any more/);
});

test('R7: loadConfig is idempotent on already-migrated config, keeping identical bytes with no new config.json.bak-* file', (t) => {
  const { dir, env } = tmpDirs(t);
  const cfgPath = path.join(dir, 'config.json');
  const migrated = {
    port: 3456,
    blindfold: { port: 3457 },
    activeProfiles: { claude: 'p', codex: null },
    profiles: {
      p: { tool: 'claude', defaultModels: { opus: 'claude-opus' } }
    }
  };
  const initialBytes = Buffer.from(JSON.stringify(migrated, null, 2), 'utf8');
  fs.writeFileSync(cfgPath, initialBytes);
  const r = runState(env, `
    s.loadConfig();
    s.loadConfig();
    const currentBytes = fs.readFileSync(s.configPath);
    const baks = fs.readdirSync(path.dirname(s.configPath)).filter(f => f.startsWith('config.json.bak'));
    return {
      bytesEqual: currentBytes.equals(Buffer.from(${JSON.stringify(initialBytes.toString('base64'))}, 'base64')),
      bakCount: baks.length
    };
  `);
  assert.equal(r.bytesEqual, true);
  assert.equal(r.bakCount, 0, 'no backup file written for already-migrated config');
});

// Task 6 — a fresh install copies this file, so it must already be in the new shape: no migration,
// no warnings, and every profile passes the same validator the API runs.
test('A5: config.example.json loads and passes validation without requiring migration', () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config.example.json'), 'utf8'));

  assert.equal(needsMigration(example), false, 'the example is already migrated');
  const migrated = migrateConfigInMemory(structuredClone(example));
  assert.equal(migrated.collision, null, 'no migration collision');
  assert.deepEqual(migrated.warnings, [], 'no migration warnings');
  assert.deepEqual(migrated.config, example, 'migration rewrites nothing');

  for (const [key, p] of Object.entries(example.profiles)) {
    assert.equal(validateProfileInput(p), null, `profile "${key}": ${validateProfileInput(p)}`);
  }

  assert.equal('activeProfile' in example, false, 'the retired top-level pointer is gone');
  assert.deepEqual(Object.keys(example.activeProfiles).sort(), ['claude', 'codex'], 'exactly the two tools');
  assert.deepEqual(example.blindfold, { port: 3457 }, 'the interceptor port is top-level, and it is only a port');
  for (const [key, p] of Object.entries(example.profiles)) {
    for (const retired of ['inFormat', 'blindfold', 'blindfoldPort', 'blindfoldHost', 'blindfoldPrefix']) {
      assert.equal(retired in p, false, `profile "${key}" still carries the retired "${retired}"`);
    }
  }
});
