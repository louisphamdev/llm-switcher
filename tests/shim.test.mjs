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

// Run the shim with a fake PATH: fakeDir holds a mocked "real" binary.
function runShim(name, args, { active, fakeDir, extraPath = '' }) {
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
    const PATH_ = [SHIM_DIR, fakeDir, extraPath || '/usr/bin:/bin'].filter(Boolean).join(':');
    return execFileSync(path.join(SHIM_DIR, name), args, {
      encoding: 'utf8', env: { ...process.env, PATH: PATH_ }, timeout: 15000
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
  if (!fs.existsSync(path.join(SHIM_DIR, 'claude'))) return t.skip('shim not installed');
  const fake = makeFakeBin('claude');
  const out = runShim('claude', ['--resume', 'abc'], { active: true, fakeDir: fake });
  assert.match(out, /BASE=http:\/\/127\.0\.0\.1:3456/, 'env must be injected');
  assert.match(out, /ARGS=--resume abc/, 'arguments must be preserved');
});

test('shim stays transparent when the gateway is OFF', (t) => {
  if (process.platform === 'win32') return t.skip('posix only');
  if (!fs.existsSync(path.join(SHIM_DIR, 'claude'))) return t.skip('shim not installed');
  const fake = makeFakeBin('claude');
  const out = runShim('claude', ['--resume'], { active: false, fakeDir: fake });
  assert.match(out, /BASE=NONE/, 'gateway off must not force route');
  assert.match(out, /ARGS=--resume/);
});

test('shim never recurses into itself', (t) => {
  if (process.platform === 'win32') return t.skip('posix only');
  if (!fs.existsSync(path.join(SHIM_DIR, 'claude'))) return t.skip('shim not installed');
  const fake = makeFakeBin('claude');
  // If the shim called itself, the command would hang until timeout and throw.
  const out = runShim('claude', ['x'], { active: true, fakeDir: fake });
  assert.match(out, /ARGS=x/);
});

test('shim fails loudly (127) when the real binary is missing', (t) => {
  if (process.platform === 'win32') return t.skip('posix only');
  if (!fs.existsSync(path.join(SHIM_DIR, 'claude'))) return t.skip('shim not installed');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'shimempty-'));
  assert.throws(
    () => runShim('claude', [], { active: true, fakeDir: empty }),
    (err) => err.status === 127,
    'missing real binary must report clear error, not fail silently'
  );
});

test('helpers report PATH guidance and shim wiring', () => {
  assert.ok(pathExportLine().includes(SHIM_DIR));
  assert.ok(suggestedRcFiles().length > 0);
  const st = shimStatus();
  assert.equal(st.dir, SHIM_DIR);
  assert.deepEqual(st.shims.map(s => s.name), SHIMMED);
});

test('Codex shim injects documented config overrides on POSIX and Windows', () => {
  for (const platform of ['linux', 'win32']) {
    const body = renderShim('codex', platform);
    assert.match(body, /openai_base_url/);
    assert.match(body, /model=.+main|model=main/);
    assert.match(body, /review_model/);
    assert.match(body, /agents\.default_subagent_model/);
    assert.match(body, /model_context_window/);
    assert.match(body, /model_auto_compact_token_limit/);
  }
});

test('Claude shim does not receive Codex config overrides', () => {
  assert.doesNotMatch(renderShim('claude', 'linux'), /agents\.default_subagent_model/);
  assert.doesNotMatch(renderShim('claude', 'win32'), /CODEX_SWITCHER_ARGS/);
});
