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
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// The shims read the launch files from the state dir. A private one keeps the checkout's files untouched.
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'shimstate-'));
process.env.LLM_SWITCHER_STATE_DIR = STATE;

const { SHIM_DIR, SHIMMED, pathExportLine, pathOrderHint, suggestedRcFiles, shimStatus, renderShim } =
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
test.after(() => {
  fs.rmSync(RENDER_DIR, { recursive: true, force: true });
  fs.rmSync(STATE, { recursive: true, force: true });
});

// Run the shim with a fake PATH: fakeDir holds a mocked "real" binary. `files` are launch files to
// write into the state dir first; every other launch file is removed.
function runShim(name, args, { active, fakeDir, extraPath = '', env = {}, files = {} }) {
  for (const f of fs.readdirSync(STATE)) fs.rmSync(path.join(STATE, f), { force: true });
  if (active) {
    fs.writeFileSync(path.join(STATE, 'active.flag'), 'active');
    // One file per tool (A1). The value is the interceptor proxy of R2 — never a base URL the
    // tool would read as its own endpoint (R1).
    fs.writeFileSync(path.join(STATE, `env-${name}.sh`), "export HTTPS_PROXY='http://127.0.0.1:3457'\n");
  }
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(STATE, f), content);
  const PATH_ = [RENDER_DIR, fakeDir, extraPath || '/usr/bin:/bin', path.dirname(process.execPath)]
    .filter(Boolean).join(path.delimiter);
  return execFileSync(path.join(RENDER_DIR, name), args, {
    encoding: 'utf8', env: { ...process.env, ...env, PATH: PATH_ }, timeout: 15000
  }).trim();
}

// Prints every value the switcher could have touched, so a test can see both what was scrubbed
// and what must have been kept.
function makeEnvBin(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shimenv-'));
  fs.writeFileSync(path.join(dir, name),
    '#!/usr/bin/env bash\n'
    + 'echo "HTTPS_PROXY=${HTTPS_PROXY:-NONE} BASE=${ANTHROPIC_BASE_URL:-NONE} OPENAI=${OPENAI_BASE_URL:-NONE} MODEL=${ANTHROPIC_MODEL:-NONE} DEFOPUS=${ANTHROPIC_DEFAULT_OPUS_MODEL:-NONE} CA=${NODE_EXTRA_CA_CERTS:-NONE}"\n'
    + 'echo "DEFOTHER=${ANTHROPIC_DEFAULT_SONNET_MODEL:-NONE} CAX=${LLM_SWITCHER_CODEX_MAIN_MODEL:-NONE} MYSET=${LLM_SWITCHER_MY_SETTING:-NONE}"\n'
    + 'printf \'%s\\n\' "$@"\n');
  fs.chmodSync(path.join(dir, name), 0o755);
  return dir;
}

// A fake binary that prints every argument on its own line, so the test sees argument boundaries.
function makeArgvBin(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shimargv-'));
  fs.writeFileSync(path.join(dir, name), '#!/usr/bin/env bash\necho "HTTPS_PROXY=${HTTPS_PROXY:-NONE}"\nprintf \'%s\\n\' "$@"\n');
  fs.chmodSync(path.join(dir, name), 0o755);
  return dir;
}

function makeFakeBin(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shimtest-'));
  fs.writeFileSync(path.join(dir, name),
    '#!/usr/bin/env bash\necho "BASE=${ANTHROPIC_BASE_URL:-NONE} ARGS=$*"\n');
  fs.chmodSync(path.join(dir, name), 0o755);
  return dir;
}

test('A1: claude shim sources env-claude.sh, never a shared file, and sets no base URL', (t) => {
  if (process.platform === 'win32') return t.skip('posix only');
  const fake = makeEnvBin('claude');
  const lines = runShim('claude', ['--resume', 'abc'], { active: true, fakeDir: fake }).split('\n');
  // R2: the tool reaches the interceptor through its own proxy variable, not through a
  // rewritten endpoint — that would be the switcher configuring the tool (vision, F1).
  assert.match(lines[0], /^HTTPS_PROXY=http:\/\/127\.0\.0\.1:3457 /);
  assert.match(lines[0], / BASE=NONE /, 'R1: no value the tool reads as configuration');
  assert.match(lines[0], / OPENAI=NONE /);
  assert.match(lines[0], / CA=NONE$/, 'ca.pem is absent: never export a path that does not exist');
  assert.deepEqual(lines.slice(2), ['--resume', 'abc'], 'arguments must be preserved');
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

// A2 / F3: Codex is told NOTHING. It keeps the endpoint and the model names of its own
// config.toml; the switcher only stands at the network hop (vision, R1). Checked as text so it
// runs on Windows too, where the POSIX behaviour below is skipped.
test('A2: codex shim passes no config override', () => {
  for (const platform of ['win32', 'linux']) {
    const body = renderShim('codex', platform);
    assert.doesNotMatch(body, /--config/, platform);
    assert.doesNotMatch(body, /model_catalog_json/, platform);
    assert.doesNotMatch(body, /CODEX_SWITCHER_ARGS/, platform);
    assert.doesNotMatch(body, /openai_base_url/, platform);
    assert.doesNotMatch(body, /model_context_window/, platform);
    assert.doesNotMatch(body, /review_model/, platform);
    assert.doesNotMatch(body, /default_subagent_model/, platform);
    assert.doesNotMatch(body, /model_auto_compact_token_limit/, platform);
    assert.doesNotMatch(body, /model-catalog/, platform);
  }
  // The tool's own arguments must still arrive untouched.
  assert.match(renderShim('codex', 'linux'), /exec "\$REAL" "\$@"/);
  assert.match(renderShim('codex', 'win32'), /call "%%i" %\*/);
});

// Behaviour on POSIX: the shim, run against the launch files, wires Codex to the interceptor
// and nothing else, then hands its arguments through unchanged.
test('codex shim wires only the interceptor proxy and passes its arguments through', (t) => {
  if (process.platform === 'win32') return t.skip('posix only');
  const out = runShim('codex', ['exec', 'hi'], {
    fakeDir: makeArgvBin('codex'),
    files: { 'active.flag': 'active' }
  }).split('\n');
  assert.equal(out[0], 'HTTPS_PROXY=http://127.0.0.1:3457', 'the interceptor is the only wiring');
  assert.deepEqual(out.slice(1), ['exec', 'hi'], 'arguments must be preserved');
  // Gateway off: no proxy is forced and the tool runs as-is.
  const off = runShim('codex', ['exec'], { fakeDir: makeArgvBin('codex') }).split('\n');
  assert.deepEqual(off, ['HTTPS_PROXY=NONE', 'exec']);
});

test('Claude shim never loads the Codex-only file or passes Codex overrides', (t) => {
  if (process.platform === 'win32') return t.skip('posix only');
  // env-codex.sh carries a deliberately different port: if the claude shim ever sourced it,
  // that value would show up instead of the claude one.
  const out = runShim('claude', ['--resume'], {
    fakeDir: makeArgvBin('claude'),
    files: { 'env-codex.sh': "export HTTPS_PROXY='http://127.0.0.1:9999'\n" }
  }).split('\n');
  assert.equal(out[0], 'HTTPS_PROXY=http://127.0.0.1:3457', 'only env-claude.sh was sourced');
  assert.deepEqual(out.slice(1), ['--resume']);
});

// Windows cannot execute the .cmd here, so the Windows template is checked as text.
// A1: exactly one env file per tool, the shared one is never called, and an empty file means
// the tool is off (A13). The recorded port is read because R8 needs it to recognize a stale
// loopback URL left by an earlier switch on.
test('A1: the Windows shim loads only its own tool env file and never the shared one', () => {
  assert.match(renderShim('claude', 'win32'), /env-claude\.cmd/);
  assert.doesNotMatch(renderShim('claude', 'win32'), /env-codex/);
  assert.match(renderShim('codex', 'win32'), /env-codex\.cmd/);
  for (const n of ['claude', 'codex']) {
    const b = renderShim(n, 'win32');
    assert.doesNotMatch(b, /\\env\.cmd\b/, `${n}: the shared file is never called (F5)`);
    assert.match(b, /active\.flag/, n);
    assert.match(b, /%%~zA GTR 0/, `${n}: a non-empty file decides that the tool runs`);
    assert.match(b, /gateway\.port/, `${n}: R8 reads the recorded port`);
    assert.match(b, /setlocal/, `${n}: nothing leaks back into the caller's shell`);
  }
});

// A7 / R8: every entry of the table is scrubbed, and only that. The proxy comes from the tool's
// own env file, never from the shim, and every OTHER LLM_SWITCHER_* name is a user setting.
test('A7: the Windows shim implements the R8 table and keeps every other value', () => {
  for (const b of [renderShim('claude', 'win32'), renderShim('codex', 'win32')]) {
    assert.match(b, /:SCRUB_URL/, 'loopback gateway URLs');
    assert.match(b, /:SCRUB_TIER/, 'the per-tier [1m] suffix');
    assert.match(b, /opus\[1m\]/);
    assert.match(b, /sonnet\[1m\]/);
    assert.match(b, /haiku\[1m\]/);
    assert.match(b, /fable\[1m\]/);
    assert.match(b, /ANTHROPIC_DEFAULT_OPUS_MODEL/);
    assert.match(b, /CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT/);
    assert.match(b, /CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
    assert.match(b, /OPENAI_MAX_CONTEXT_TOKENS/);
    assert.match(b, /findstr \/b \/c:"LLM_SWITCHER_CODEX_"/, 'only the shim inputs are removed');
    assert.doesNotMatch(b, /set "HTTPS_PROXY=/, 'R1: the shim writes no endpoint of its own');
    assert.doesNotMatch(b, /set "ANTHROPIC_BASE_URL=/, 'R1: no value the tool reads');
  }
});

// Each shim reads only its own tool file: that is what keeps one tool from capturing the
// other's environment (A1, F5).
test('only the Windows Codex shim loads the Codex-only environment file', () => {
  for (const platform of ['win32']) {
    assert.match(renderShim('codex', platform), /env-codex\.(cmd|sh)/);
    assert.doesNotMatch(renderShim('claude', platform), /env-codex/);
  }
});

test('Windows Claude shim does not receive Codex config overrides', () => {
  assert.doesNotMatch(renderShim('claude', 'win32'), /CODEX_SWITCHER_ARGS/);
  assert.doesNotMatch(renderShim('claude', 'win32'), /model_catalog_json/);
});

// R2 on Windows: the bundle is built by a FILE, never `node -e "..."`. cmd.exe re-parses quotes
// and reads %2 out of a percent-encoded path, so a checkout under a directory with a space
// would corrupt the program or its arguments.
test('R2: the Windows shim builds the CA bundle through the helper file', () => {
  const b = renderShim('claude', 'win32');
  assert.match(b, /node "%STATE_HELPER%"/);
  assert.match(b, /ensure-ca-bundle\.mjs/);
  assert.doesNotMatch(b, /node -e/);
  assert.match(b, /set "INHERITED_CA=%NODE_EXTRA_CA_CERTS%"/, 'captured before the tool env runs');
  assert.match(b, /%SWITCHER_DIR%\\blindfold\\certs\\ca\.pem/);
  assert.match(b, /if not "%TOOL_ACTIVE%"=="1" goto :CA_DONE/, 'nothing happens while claude is off');
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

// Codex takes its CA from the tool env file (CODEX_CA_CERTIFICATE) and needs no bundle of its
// own; only the Claude path does this work.
test('R2: the Codex shim never builds a CA bundle', () => {
  const body = renderShim('codex', 'win32');
  assert.doesNotMatch(body, /CA_BUNDLE/);
  assert.doesNotMatch(body, /ensure-ca-bundle/);
  assert.doesNotMatch(body, /ca\.pem/);
});

// The shim runs whatever env.sh says. It must not source a file, or a directory, that another account owns.
test('the POSIX shims source launch files only when this account owns them', () => {
  for (const name of SHIMMED) {
    const body = renderShim(name, 'linux');
    for (const line of body.split('\n').filter(l => /^\s*\. "\$SWITCHER_DIR\//.test(l))) {
      const file = line.trim().slice(3, -1);
      assert.match(body, new RegExp(`\\[ -O "\\$SWITCHER_DIR" \\] && \\[ -O "${file.replace(/[$/.]/g, (c) => `\\${c}`)}" \\]`), `${name}: ${file}`);
    }
  }
});

// ISS-CC-LS-002: on zsh a later line in .zshrc or .zprofile can prepend npm-global or Homebrew
// ahead of the shim. The hint names both files and says the line must come last.
test('pathOrderHint tells a zsh user to put the export last in .zshrc and .zprofile', () => {
  const shell = process.env.SHELL;
  process.env.SHELL = '/bin/zsh';
  try {
    const text = pathOrderHint('darwin').join('\n');
    assert.match(text, /LAST/);
    assert.match(text, /\.zshrc/);
    assert.match(text, /\.zprofile/);
    assert.ok(text.includes(pathExportLine('darwin')));
  } finally {
    if (shell === undefined) delete process.env.SHELL; else process.env.SHELL = shell;
  }
});

// A8. The three defects below were invisible to every text assertion above, and only showed up
// when the generated .cmd was run: cmd.exe could not find :SCRUB_TIER, and the 127.0.0.1 base
// URL survived the scrub so the tool bypassed the interceptor entirely. Render the real shim,
// point it at a fake `claude`, and read what the child actually saw.
test('A8: the Windows shim scrubs a loopback base URL and resolves every subroutine', (t) => {
  if (process.platform !== 'win32') return t.skip('cmd.exe only');
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shimwin-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shimfake-'));
  t.after(() => {
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(fakeDir, { recursive: true, force: true });
  });

  // The fake real binary reports exactly the variables the R8 scrub must have decided about.
  fs.writeFileSync(path.join(fakeDir, 'claude.cmd'),
    '@echo off\r\necho BASE=[%ANTHROPIC_BASE_URL%] HTTPS=[%HTTPS_PROXY%] CA=[%NODE_EXTRA_CA_CERTS%]\r\n');

  fs.writeFileSync(path.join(STATE, 'active.flag'), 'active');
  fs.writeFileSync(path.join(STATE, 'env-claude.cmd'), 'SET "HTTPS_PROXY=http://127.0.0.1:3457"\r\n');

  const shim = path.join(shimDir, 'shim.cmd');
  fs.writeFileSync(shim, renderShim('claude', 'win32'), 'utf8');

  const child = spawnSync('cmd.exe', ['/d', '/c', shim, '--version'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // Replaced, not appended: the shim must find the fake binary and nothing named claude
      // from this machine, and where/findstr must still resolve.
      PATH: [fakeDir, shimDir, path.join(process.env.SystemRoot, 'System32'), path.dirname(process.execPath)]
        .join(path.delimiter),
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet[1m]',
      NODE_EXTRA_CA_CERTS: ''
    },
    timeout: 30000
  });
  const all = `${child.stdout || ''}${child.stderr || ''}`;
  assert.doesNotMatch(all, /cannot find the batch label/, 'a .cmd written with bare LF loses subroutine lookup');
  assert.match(child.stdout || '', /BASE=\[\]/,
    'R8: a loopback gateway base URL is scrubbed, so the tool reaches the interceptor');
  assert.match(child.stdout || '', /HTTPS=\[http:\/\/127\.0\.0\.1:3457\]/,
    'R2: the proxy comes from the env file of this tool');
});
