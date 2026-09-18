// Test cho shim.mjs — cơ chế auto-inject env vào phiên resume.
//
// Ca hỏng thật ngoài đời (2026-09-18): một phiên `claude` mở từ shell chưa
// source env.sh không có ANTHROPIC_BASE_URL nên gọi thẳng api.anthropic.com,
// bỏ qua gateway. Shim phải bịt đúng lỗ đó mà không phá trường hợp bình thường.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const { SHIM_DIR, SHIMMED, pathExportLine, suggestedRcFiles, shimStatus } =
  await import(path.join(ROOT, 'shim.mjs'));

// Chạy shim trong PATH giả: fakeDir chứa binary "thật" giả lập.
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
  assert.match(out, /BASE=http:\/\/127\.0\.0\.1:3456/, 'env phải được inject');
  assert.match(out, /ARGS=--resume abc/, 'tham số phải giữ nguyên');
});

test('shim stays transparent when the gateway is OFF', (t) => {
  if (process.platform === 'win32') return t.skip('posix only');
  if (!fs.existsSync(path.join(SHIM_DIR, 'claude'))) return t.skip('shim not installed');
  const fake = makeFakeBin('claude');
  const out = runShim('claude', ['--resume'], { active: false, fakeDir: fake });
  assert.match(out, /BASE=NONE/, 'gateway tắt thì không được ép route');
  assert.match(out, /ARGS=--resume/);
});

test('shim never recurses into itself', (t) => {
  if (process.platform === 'win32') return t.skip('posix only');
  if (!fs.existsSync(path.join(SHIM_DIR, 'claude'))) return t.skip('shim not installed');
  const fake = makeFakeBin('claude');
  // Nếu shim tự gọi chính nó, lệnh sẽ treo tới timeout và ném lỗi.
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
    'thiếu binary thật phải báo lỗi rõ, không im lặng'
  );
});

test('helpers report PATH guidance and shim wiring', () => {
  assert.ok(pathExportLine().includes(SHIM_DIR));
  assert.ok(suggestedRcFiles().length > 0);
  const st = shimStatus();
  assert.equal(st.dir, SHIM_DIR);
  assert.deepEqual(st.shims.map(s => s.name), SHIMMED);
});
