// The key of the relay proof: random, independent of admin.token, served by no route, and the only
// key the relay accepts. Each case runs state.mjs in a child process, so it reads its own directory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = pathToFileURL(path.join(ROOT, 'state.mjs')).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gwsecret-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const TOKEN = 'c'.repeat(64);

function dir(name) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'admin.token'), TOKEN);
  return d;
}
// Runs `code` (an async function body that gets `s`, the state module) against directory `d`.
function inState(d, code) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const s = await import(${JSON.stringify(STATE)}); const out = await (async () => { ${code} })(); process.stdout.write(JSON.stringify(out ?? null));`], {
    env: { ...process.env, LLM_SWITCHER_CONFIG: path.join(d, 'config.json'), LLM_SWITCHER_STATE_DIR: d }, encoding: 'utf8'
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}
const secretOf = (d) => fs.readFileSync(path.join(d, 'gateway.secret'), 'utf8');

test('ensureGatewaySecret replaces a missing, empty or blank file and keeps a good one', () => {
  const d = dir('ensure');
  inState(d, 's.ensureGatewaySecret()');
  const first = secretOf(d);
  assert.match(first, /^[0-9a-f]{64}$/, 'hex only, no trailing newline');
  inState(d, 's.ensureGatewaySecret()');
  assert.equal(secretOf(d), first, 'an existing secret is kept');
  for (const blank of ['', '  \n\t']) {
    fs.writeFileSync(path.join(d, 'gateway.secret'), blank);
    inState(d, 's.ensureGatewaySecret()');
    assert.match(secretOf(d), /^[0-9a-f]{64}$/, `a file of ${JSON.stringify(blank)} is replaced`);
  }
  assert.deepEqual(fs.readdirSync(d).filter(f => f.endsWith('.tmp')), [], 'no temporary file is left');
});

test('the secret is random: never derived from admin.token or from the directory', () => {
  const a = dir('indep-a');
  const b = dir('indep-b');
  inState(a, 's.ensureGatewaySecret()');
  inState(b, 's.ensureGatewaySecret()');
  const first = secretOf(a);
  assert.notEqual(first, secretOf(b), 'two directories with the same admin.token');
  assert.notEqual(first, TOKEN);
  fs.rmSync(path.join(a, 'gateway.secret'));
  inState(a, 's.ensureGatewaySecret()');
  assert.notEqual(secretOf(a), first, 'the same directory and token again');
});

test('relayProof is an HMAC keyed by the raw bytes of gateway.secret', () => {
  const d = dir('binding');
  const raw = 'f'.repeat(64);
  fs.writeFileSync(path.join(d, 'gateway.secret'), raw);
  const out = inState(d, `return { secret: s.readGatewaySecret(), proof: s.relayProof('n1', { port: 3456, pid: 77 }) };`);
  assert.equal(out.secret, raw);
  assert.equal(out.proof, crypto.createHmac('sha256', raw).update('relay|3456|77|n1').digest('hex'));
});

test('without gateway.secret there is no proof at all, and no fallback to admin.token', () => {
  const d = dir('nofallback');
  const out = inState(d, `return { secret: s.readGatewaySecret(), proof: s.relayProof('n1', { port: 3456, pid: 77 }) };`);
  assert.deepEqual(out, { secret: null, proof: '' });
});

test('ensureGatewaySecret throws when it cannot write, and leaves no temporary file', () => {
  const d = dir('throws');
  fs.mkdirSync(path.join(d, 'gateway.secret'));
  assert.throws(() => inState(d, 's.ensureGatewaySecret()'));
  assert.deepEqual(fs.readdirSync(d).filter(f => f.endsWith('.tmp')), []);
});

test('the blindfold proof keeps its exact formula', async () => {
  const s = await import(STATE);
  const proof = s.identityProof('n2', { role: 'blindfold', port: 3457, pid: 9, gatewayPort: 3456, activeTools: 'codex' }, TOKEN);
  assert.equal(proof, crypto.createHmac('sha256', TOKEN).update('blindfold|3457|9|3456|codex|n2').digest('hex'));
});

test('only state.mjs touches gateway.secret: no other module of the package can read or serve it', () => {
  const files = [...fs.readdirSync(ROOT).filter(f => f.endsWith('.mjs')).map(f => path.join(ROOT, f)),
    ...fs.readdirSync(path.join(ROOT, 'blindfold')).filter(f => f.endsWith('.mjs')).map(f => path.join(ROOT, 'blindfold', f))];
  assert.ok(files.length > 10, 'the scan found the package modules');
  for (const f of files) {
    if (path.basename(f) === 'state.mjs') continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const name of ['gateway.secret', 'readGatewaySecret', 'gatewaySecretPath']) {
      assert.equal(src.includes(name), false, `${path.relative(ROOT, f)} mentions ${name}`);
    }
  }
  const proxy = fs.readFileSync(path.join(ROOT, 'proxy.mjs'), 'utf8');
  assert.match(proxy, /ensureGatewaySecret\(\);/, 'the gateway makes its secret at startup and keeps no copy');
  assert.match(proxy, /relayProof\(/);
});

test('gateway.secret stays out of git and out of the npm package', () => {
  assert.ok(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).includes('gateway.secret'));
});

test('the .cmd command line: cmd.exe switches, quoting and the 8191 limit', async () => {
  const { batCommandLine, CMD_LIMIT } = await import(pathToFileURL(path.join(ROOT, 'agy-relay-lib.mjs')).href);
  const ok = batCommandLine('C:\\a\\agy.cmd', ['x']);
  assert.deepEqual(ok.args.slice(0, 4), ['/e:ON', '/v:OFF', '/d', '/c']);
  assert.equal(batCommandLine('C:\\a\\agy.cmd', ['50%']).args[4].includes('50%%cd:~,%'), true);
  assert.equal(CMD_LIMIT, 8191);
  // The /c string is `"` + `"C:\a\agy.cmd"` + ` ` + the argument + `"`: 17 code units around it.
  const room = CMD_LIMIT - '""C:\\a\\agy.cmd" "'.length;
  assert.equal(batCommandLine('C:\\a\\agy.cmd', ['z'.repeat(room)]).args[4].length, CMD_LIMIT);
  assert.ok(batCommandLine('C:\\a\\agy.cmd', ['z'.repeat(room + 1)]).error);
  // Counted in UTF-16 code units, not bytes: é is one unit and two UTF-8 bytes.
  assert.ok(batCommandLine('C:\\a\\agy.cmd', ['é'.repeat(room - 2)]).args, 'non-ASCII is not refused early');
  assert.ok(batCommandLine('C:\\a\\agy".cmd', []).error);
  assert.ok(batCommandLine('C:\\a\\', []).error);
});
