// Unit tests cho state.mjs (chỉ các hàm thuần, không ghi flag/env file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveMap, setTargetProfile, activateProfile, deactivateProfile, deleteProfile,
  computeLaunchState, findProfileKey, isValidProfileKey, resolvePort, redactConfig, MASKED_KEY
} from '../state.mjs';

const makeCfg = () => ({
  port: 4000,
  activeProfile: 'router',
  profiles: {
    router: { inFormat: 'auto', apiKey: 'sk-1', defaultModels: { opus: 'o', sonnet: 's' }, model1M: { sonnet: true } },
    codexOnly: { inFormat: 'responses', apiKey: 'sk-2', defaultModels: { opus: 'gpt-x' }, model1M: { opus: true } }
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
  assert.equal(st.codex1M, 'gpt-x');
  const env = Object.fromEntries(st.env);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4000');
  assert.equal(env.CODEX_MODEL, 'gpt-x');

  const off = makeCfg();
  off.activeProfiles = { anthropic: null, responses: null, 'openai-chat': null, vertex: null };
  assert.equal(computeLaunchState(off, 4000).active, false);
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
