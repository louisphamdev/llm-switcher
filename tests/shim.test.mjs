// Tests for shim.mjs — auto-inject env mechanism for resume sessions.
//
// Real-world failure (2026-09-18): a `claude` session launched from a shell
// that never sourced env.sh had no ANTHROPIC_BASE_URL, so it called api.anthropic.com directly,
// bypassing the gateway. The shim must plug exactly that hole without breaking the normal case.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const { SHIM_DIR, SHIMMED, pathExportLine, suggestedRcFiles, shimStatus, renderShim } =
  await import(pathToFileURL(path.join(ROOT, 'shim.mjs')).href);

// The behavioural tests run the CURRENT template, rendered into a temp dir. Running the copy
// installed in SHIM_DIR tested whatever an earlier release wrote there, or skipped.
const RENDER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shimrender-'));
if (process.platform !== 'win32') {
  for (const name of SHIMMED) {
    fs.writeFileSync(path.join(RENDER_DIR, name), renderShim(name, 'linux'));
    fs.chmodSync(path.join(RENDER_DIR, name), 0o755);
  }
}
test.after(() => fs.rmSync(RENDER_DIR, { recursive: true, force: true }));

// Run the shim with a fake PATH: fakeDir holds a mocked "real" binary.
function runShim(name, args, { active, fakeDir, extraPath = '', env = {} }) {
  const flag = path.join(ROOT, 'active.flag');
  const envSh = path.join(ROOT, 'env.sh');
  const hadFlag = fs.existsSync(flag);
  const hadEnv = fs.existsSync(envSh);
  const savedFlag = hadFlag ? fs.readFileSync(flag) : null;
  const savedEnv = hadEnv ? fs.readFileSync(envSh) : null;

  try {
    if (active) {
      fs.writeFileSync(flag, 'active');
      fs.writeFileSync(envSh, "export ANTHROPIC_BASE_URL='http://127.0.0.1:3456'\n");
    } else {
      if (fs.existsSync(flag)) fs.unlinkSync(flag);
    }
    const PATH_ = [RENDER_DIR, fakeDir, extraPath || '/usr/bin:/bin'].filter(Boolean).join(':');
    return execFileSync(path.join(RENDER_DIR, name), args, {
      encoding: 'utf8', env: { ...process.env, ...env, PATH: PATH_ }, timeout: 15000
    }).trim();
  } finally {
    if (savedFlag !== null) fs.writeFileSync(flag, savedFlag);
    else if (fs.existsSync(flag)) fs.unlinkSync(flag);
    if (savedEnv !== null) fs.writeFileSync(envSh, savedEnv);
    else if (fs.existsSync(envSh)) fs.unlinkSync(envSh);
  }
}

function makeFakeBin(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shimtest-'));
  fs.writeFileSync(path.join(dir, name),
    '#!/usr/bin/env bash\necho "BASE=${ANTHROPIC_BASE_URL:-NONE} ARGS=$*"\n');
  fs.chmodSync(path.join(dir, name), 0o755);
  return dir;
}

test('shim injects gateway env when the gateway is ON (the --resume fix)', (t) => {
  if (process.platform === 'win32') return t.skip('posix only');
  const fake = makeFakeBin('claude');
  const out = runShim('claude', ['--resume', 'abc'], { active: true, fakeDir: fake });
  assert.match(out, /BASE=http:\/\/127\.0\.0\.1:3456/, 'env must be injected');
  assert.match(out, /ARGS=--resume abc/, 'arguments must be preserved');
});

test('shim stays transparent when the gateway is OFF', (t) => {
  if (process.platform === 'win32') return t.skip('posix only');
  const fake = makeFakeBin('claude');
  const out = runShim('claude', ['--resume'], { active: false, fakeDir: fake });
  assert.match(out, /BASE=NONE/, 'gateway off must not force route');
  assert.match(out, /ARGS=--resume/);
});

test('shim never recurses into itself', (t) => {
  if (process.platform === 'win32') return t.skip('posix only');
  const fake = makeFakeBin('claude');
  // If the shim called itself, the command would hang until timeout and throw.
  const out = runShim('claude', ['x'], { active: true, fakeDir: fake });
  assert.match(out, /ARGS=x/);
});

test('shim fails loudly (127) when the real binary is missing', (t) => {
  if (process.platform === 'win32') return t.skip('posix only');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'shimempty-'));
  assert.throws(
    () => runShim('claude', [], { active: true, fakeDir: empty }),
    (err) => err.status === 127,
    'missing real binary must report clear error, not fail silently'
  );
});

test('helpers report PATH guidance and shim wiring', () => {
  assert.ok(pathExportLine().includes(SHIM_DIR));
  assert.ok(suggestedRcFiles('linux').length > 0);
  const st = shimStatus();
  assert.equal(st.dir, SHIM_DIR);
  assert.deepEqual(st.shims.map(s => s.name), SHIMMED);
});

test('Codex shim injects documented config overrides on POSIX and Windows', () => {
  for (const platform of ['linux', 'win32']) {
    const body = renderShim('codex', platform);
    assert.match(body, /openai_base_url/);
    // The main model stays official (from the user's config.toml): forcing the
    // internal "main" alias here used to make first-party IDs bypass the proxy.
    assert.doesNotMatch(body, /--config model=main/);
    assert.match(body, /review_model/);
    assert.match(body, /agents\.default_subagent_model/);
    assert.match(body, /model_context_window/);
    assert.match(body, /model_auto_compact_token_limit/);
    assert.match(body, /model_catalog_json/);
  }
});

// The /model picker reads the local catalog file and the --config values, never
// /v1/models. A literal `review_model=review` therefore printed the switcher's
// own slot names straight into the Codex UI (found 2026-09-20).
test('Codex shim passes official role names through, never a hard-coded slot alias', () => {
  for (const platform of ['linux', 'win32']) {
    const body = renderShim('codex', platform);
    assert.doesNotMatch(body, /review_model=["']?review["']?\s/, 'slot alias must not be hard-coded');
    assert.doesNotMatch(body, /default_subagent_model=["']?subagent["']?\s/, 'slot alias must not be hard-coded');
    assert.match(body, /review_model=.*LLM_SWITCHER_CODEX_REVIEW_MODEL/);
    assert.match(body, /default_subagent_model=.*LLM_SWITCHER_CODEX_SUBAGENT_MODEL/);
  }
});

// Blindfold's HTTPS_PROXY belongs to Codex alone. The claude shim sources the shared
// env file, so the proxy variables live in a Codex-only file that only this shim reads.
test('only the Codex shim loads the Codex-only environment file', () => {
  for (const platform of ['linux', 'win32']) {
    assert.match(renderShim('codex', platform), /env-codex\.(cmd|sh)/);
    assert.doesNotMatch(renderShim('claude', platform), /env-codex/);
  }
});

test('Claude shim does not receive Codex config overrides', () => {
  assert.doesNotMatch(renderShim('claude', 'linux'), /agents\.default_subagent_model/);
  assert.doesNotMatch(renderShim('claude', 'win32'), /CODEX_SWITCHER_ARGS/);
  assert.doesNotMatch(renderShim('claude', 'win32'), /model_catalog_json/);
});

// README promises that the main role reaches Codex as the `model` override.
test('Codex shim passes the main model as --config model', (t) => {
  if (process.platform === 'win32') return t.skip('posix only');
  const fake = makeFakeBin('codex');
  const withModel = runShim('codex', ['exec'], { active: false, fakeDir: fake, env: { LLM_SWITCHER_CODEX_MAIN_MODEL: 'gpt-x' } });
  assert.match(withModel, /--config model="gpt-x"/);
  const without = runShim('codex', ['exec'], { active: false, fakeDir: fake, env: { LLM_SWITCHER_CODEX_MAIN_MODEL: '' } });
  assert.doesNotMatch(without, /--config model=/);
  assert.match(renderShim('codex', 'win32'), /if defined LLM_SWITCHER_CODEX_MAIN_MODEL set "CODEX_SWITCHER_ARGS=%CODEX_SWITCHER_ARGS% --config model=/);
});

// setx truncates at 1024 characters and writes the merged system+user PATH into the user key;
// in PowerShell %PATH% is not expanded at all. The Windows advice must use neither.
test('Windows PATH advice never uses setx or %PATH%, and names no POSIX rc file', () => {
  const line = pathExportLine('win32');
  assert.ok(!/setx/i.test(line), line);
  assert.ok(!line.includes('%PATH%'), line);
  assert.match(line, /SetEnvironmentVariable\('Path'/);
  assert.match(line, /'User'\)/, 'only the User-scope Path changes');
  assert.ok(line.includes(SHIM_DIR));
  assert.deepEqual(suggestedRcFiles('win32'), []);
});

// cmd.exe `if exist` is only sure to work with the native backslash path; the TOML value keeps '/'.
test('the Windows shim tests the catalog with a native path', () => {
  const body = renderShim('codex', 'win32');
  assert.match(body, /if exist "%SWITCHER_DIR%\\model-catalog\.json"/);
  assert.match(body, /--config model_catalog_json=[^\r\n]*\/model-catalog\.json/);
});
