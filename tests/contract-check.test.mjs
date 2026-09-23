// `switch contract-check`: it turns open findings of intact into JSON test data, and never into
// JavaScript. Every path, enum value and name in a finding or a fixture is untrusted text, so the
// hostile-finding test hashes every .mjs file of the repository before and after a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCheck, loadExclusions, matchExclusion, FINDING_ID_RE } from '../contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOSTILE = "x');require('child_process')";

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lsw-${name}-`));
}

// One fake intact: it serves the findings list and one fixture per known trace id.
function fakeIntact({ findings = [], fixtures = {} } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/contracts/findings') {
      if (url.searchParams.get('status') !== 'open') return send(400, { error: 'status must be open' });
      return send(200, { findings });
    }
    const fixture = /^\/api\/contracts\/fixtures\/(.+)$/.exec(url.pathname);
    if (fixture) {
      const body = fixtures[decodeURIComponent(fixture[1])];
      return body ? send(200, body) : send(404, { error: 'no fixture' });
    }
    send(404, { error: 'not found' });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        seen,
        settings: () => ({ url: `http://127.0.0.1:${port}`, apiKey: 'k', enabled: true }),
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

const leaf = (p, extra = {}) => ({ path: p, type: 'string', len: 12, enum: '', deltas: 1, ...extra });

// A fixture of one Anthropic request: the text block survives the converter, `metadata.user_id`
// does not, so the same shape proves both a passing and a failing replay.
function anthropicRequestFixture(traceId, extraLeaves = []) {
  return {
    traceId,
    model: 'up-sonnet',
    clientFormat: 'anthropic',
    upstreamFormat: 'openai-chat',
    halves: [
      {
        half: 'switcher',
        direction: 'request',
        records: [{
          event: '',
          leaves: [
            leaf('model', { enum: 'up-sonnet' }),
            leaf('max_tokens', { type: 'number' }),
            leaf('messages[].role', { enum: 'user' }),
            leaf('messages[].content[].type', { enum: 'text' }),
            leaf('messages[].content[].text', { len: 24 }),
            ...extraLeaves
          ]
        }]
      }
    ]
  };
}

const finding = (over = {}) => ({
  id: 'f-1',
  model: 'up-sonnet',
  clientFormat: 'anthropic',
  direction: 'request',
  path: 'metadata.user_id',
  class: 'lost',
  status: 'open',
  exemptTrace: 't-1',
  ...over
});

function mjsHashes() {
  const out = {};
  for (const name of fs.readdirSync(ROOT)) {
    if (name.endsWith('.mjs')) out[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, name))).digest('hex');
  }
  for (const dir of ['tests', 'blindfold', 'skills']) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith('.mjs')) out[`${dir}/${name}`] = crypto.createHash('sha256').update(fs.readFileSync(path.join(full, name))).digest('hex');
    }
  }
  return out;
}

// ---------------------------------------------------------------- exclusions

test('the exclusion list names the intentional normalizations of the converter', () => {
  const list = loadExclusions();
  assert.ok(Array.isArray(list) && list.length >= 2, 'the list is read from contract-exclusions.json');
  for (const item of list) {
    assert.match(item.id, /^[a-z0-9-]{1,64}$/);
    assert.ok(item.reason.length > 20, `${item.id} must say why it is intentional`);
    assert.ok(Array.isArray(item.paths) && item.paths.length, `${item.id} must name paths`);
  }
  const reasons = list.map(i => i.reason).join(' ');
  assert.match(reasons, /healToolPairs/);
  assert.match(reasons, /signature/i);
});

test('an excluded path matches only in its own direction', () => {
  const list = loadExclusions();
  const placeholder = list.find(i => /healToolPairs/.test(i.reason));
  const p = placeholder.paths[0];
  assert.ok(matchExclusion({ path: p, direction: 'request' }, list), 'the listed path is excluded');
  assert.equal(matchExclusion({ path: p, direction: 'response' }, list), null, 'the other direction is not');
  assert.equal(matchExclusion({ path: `${p}.not_listed`, direction: 'request' }, list), null);
});

test('a finding id is one url-safe word, never a path', () => {
  assert.match('f-1', FINDING_ID_RE);
  assert.match('A_9-z', FINDING_ID_RE);
  assert.equal(FINDING_ID_RE.test('../../formats.mjs'), false);
  assert.equal(FINDING_ID_RE.test(HOSTILE), false);
  assert.equal(FINDING_ID_RE.test(''), false);
  assert.equal(FINDING_ID_RE.test('a'.repeat(65)), false);
});

// ---------------------------------------------------------------- the check

test('every open lost finding with a fixture becomes one JSON file, and the table names it', async () => {
  const excluded = loadExclusions()[0];
  const lab = await fakeIntact({
    findings: [
      finding(),
      finding({ id: 'f-excluded', path: excluded.paths[0], direction: excluded.direction, exemptTrace: 't-1' }),
      finding({ id: 'f-nofixture', exemptTrace: 't-missing' }),
      finding({ id: 'f-renamed', class: 'renamed', mapping: 'thinking', exemptTrace: 't-1' }),
      finding({ id: HOSTILE, exemptTrace: 't-1' })
    ],
    fixtures: { 't-1': anthropicRequestFixture('t-1') }
  });
  const dir = tmpDir('check');
  const lines = [];
  try {
    const out = await runCheck({ settings: lab.settings, dir, log: l => lines.push(l) });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(fs.readdirSync(dir), ['f-1.json'], 'only the lost finding with a fixture is written');

    const written = JSON.parse(fs.readFileSync(path.join(dir, 'f-1.json'), 'utf8'));
    assert.equal(written.finding.id, 'f-1');
    assert.equal(written.fixture.traceId, 't-1');

    const row = (id) => out.rows.find(r => r.id === id);
    assert.equal(row('f-1').file, 'tests/contract/f-1.json');
    assert.equal(row('f-excluded').file, 'excluded');
    assert.equal(row('f-nofixture').file, 'no fixture');
    assert.equal(row('f-renamed').file, '-');
    assert.equal(out.rows.filter(r => r.skipped).length, 1, 'the hostile id is skipped');

    const table = lines.join('\n');
    assert.ok(table.includes('f-1') && table.includes('excluded') && table.includes('no fixture'), table);
    assert.ok(table.includes('up-sonnet') && table.includes('request') && table.includes('lost'), table);
    assert.equal(table.includes('require('), false, 'a hostile id is never printed verbatim');
    assert.ok(lab.seen.some(u => u.includes('status=open')), 'only open findings are pulled');
  } finally {
    await lab.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hostile finding changes no .mjs file and lands in the JSON as plain data', async () => {
  const hostilePath = `metadata.${HOSTILE}`;
  const lab = await fakeIntact({
    findings: [finding({ id: 'f-hostile', path: hostilePath })],
    fixtures: { 't-1': anthropicRequestFixture('t-1', [leaf(hostilePath)]) }
  });
  const dir = tmpDir('hostile');
  const before = mjsHashes();
  try {
    const out = await runCheck({ settings: lab.settings, dir, log: () => {} });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(mjsHashes(), before, 'no source file may change');
    assert.deepEqual(fs.readdirSync(dir), ['f-hostile.json'], 'the file name is the validated id only');
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'f-hostile.json'), 'utf8'));
    assert.equal(written.finding.path, hostilePath, 'the hostile text survives as data, unchanged');
  } finally {
    await lab.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a finding whose fixture is 404 writes nothing, and a down intact is an error', async () => {
  const lab = await fakeIntact({ findings: [finding({ exemptTrace: 'gone' })] });
  const dir = tmpDir('nofix');
  try {
    const out = await runCheck({ settings: lab.settings, dir, log: () => {} });
    assert.equal(out.ok, true);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(out.rows[0].file, 'no fixture');
  } finally {
    await lab.close();
  }

  const down = await runCheck({ settings: () => ({ url: 'http://127.0.0.1:1', apiKey: 'k', enabled: true }), dir, log: () => {} });
  assert.equal(down.ok, false);
  assert.ok(down.error, 'an unreachable intact gives a message');
  assert.deepEqual(fs.readdirSync(dir), [], 'a failed pull writes nothing');
  fs.rmSync(dir, { recursive: true, force: true });

  const off = await runCheck({ settings: () => ({ url: '', apiKey: '', enabled: false }), dir: tmpDir('off'), log: () => {} });
  assert.equal(off.ok, false, 'a lab that is not configured is an error, not an empty run');
});

test('switch contract-check exits 2 when intact does not answer', async () => {
  const dir = tmpDir('cli');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    profiles: {}, activeProfiles: {},
    contractLab: { url: 'http://127.0.0.1:1', apiKey: 'k', enabled: true }
  }));
  const env = { ...process.env, LLM_SWITCHER_CONFIG: path.join(dir, 'config.json'), LLM_SWITCHER_STATE_DIR: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude') };
  const run = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'switch.mjs'), 'contract-check'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /intact/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the fixed runner

// The runner is one committed file. It is driven here over a directory of synthetic cases, so a
// real finding is never needed to prove that a lost field fails and a kept field passes.
function runRunner(dir) {
  // NODE_TEST_CONTEXT makes a child report to its parent runner instead of setting its own exit
  // code, and this test reads exactly that code.
  const { NODE_TEST_CONTEXT, ...clean } = process.env;
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--test', path.join(ROOT, 'tests/contract/run.test.mjs')], {
      cwd: ROOT,
      env: { ...clean, LLM_SWITCHER_CONTRACT_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stdout += d; });
    child.on('close', status => resolve({ status, stdout }));
  });
}

test('the runner passes with no case, fails on a lost field and passes on a kept field', async () => {
  const empty = tmpDir('runner-empty');
  const emptyRun = await runRunner(empty);
  assert.equal(emptyRun.status, 0, emptyRun.stdout);

  const lost = tmpDir('runner-lost');
  fs.writeFileSync(path.join(lost, 'f-lost.json'), JSON.stringify({
    finding: finding({ id: 'f-lost', path: 'metadata.user_id' }),
    fixture: anthropicRequestFixture('t-1', [leaf('metadata.user_id', { len: 20 })])
  }));
  const lostRun = await runRunner(lost);
  assert.notEqual(lostRun.status, 0, 'a field the converter drops must fail');
  assert.ok(lostRun.stdout.includes('f-lost'), lostRun.stdout);

  const kept = tmpDir('runner-kept');
  fs.writeFileSync(path.join(kept, 'f-kept.json'), JSON.stringify({
    finding: finding({ id: 'f-kept', path: 'messages[].content[].text' }),
    fixture: anthropicRequestFixture('t-1')
  }));
  const keptRun = await runRunner(kept);
  assert.equal(keptRun.status, 0, keptRun.stdout);

  for (const d of [empty, lost, kept]) fs.rmSync(d, { recursive: true, force: true });
});

test('a renamed finding passes only when the value reaches its target path', async () => {
  const fixture = {
    traceId: 't-3',
    model: 'up-sonnet',
    clientFormat: 'anthropic',
    upstreamFormat: 'openai-chat',
    halves: [{
      half: 'intact',
      direction: 'response',
      records: [{ event: '', leaves: [leaf('choices[].delta.reasoning_content', { len: 18 })] }]
    }]
  };
  const base = finding({ direction: 'response', class: 'renamed', path: 'choices[].delta.reasoning_content' });

  const good = tmpDir('runner-renamed-ok');
  fs.writeFileSync(path.join(good, 'f-ren.json'), JSON.stringify({ finding: { ...base, id: 'f-ren', mapping: 'content[].thinking' }, fixture }));
  const okRun = await runRunner(good);
  assert.equal(okRun.status, 0, okRun.stdout);

  const bad = tmpDir('runner-renamed-bad');
  fs.writeFileSync(path.join(bad, 'f-ren-bad.json'), JSON.stringify({ finding: { ...base, id: 'f-ren-bad', mapping: 'content[].text' }, fixture }));
  const badRun = await runRunner(bad);
  assert.notEqual(badRun.status, 0, 'the wrong target path must fail');

  for (const d of [good, bad]) fs.rmSync(d, { recursive: true, force: true });
});

test('the runner rebuilds a stream event by event and splits an accumulated path into its deltas', async () => {
  const dir = tmpDir('runner-stream');
  const fixture = {
    traceId: 't-2',
    model: 'up-sonnet',
    clientFormat: 'anthropic',
    upstreamFormat: 'openai-chat',
    halves: [{
      half: 'intact',
      direction: 'response',
      records: [{
        event: '',
        leaves: [
          leaf('choices[].index', { type: 'number' }),
          leaf('choices[].delta.content', { len: 30, deltas: 3 })
        ]
      }]
    }]
  };
  fs.writeFileSync(path.join(dir, 'f-stream.json'), JSON.stringify({
    finding: finding({ id: 'f-stream', direction: 'response', path: 'choices[].delta.content' }),
    fixture
  }));
  const run = await runRunner(dir);
  assert.equal(run.status, 0, run.stdout);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fixture path with prototype pollution segments fails safely', async () => {
  const dir = tmpDir('runner-proto');
  fs.writeFileSync(path.join(dir, 'f-proto.json'), JSON.stringify({
    finding: finding({ id: 'f-proto', path: '__proto__.polluted' }),
    fixture: anthropicRequestFixture('t-proto', [leaf('__proto__.polluted', { len: 10 })])
  }));
  const run = await runRunner(dir);
  assert.notEqual(run.status, 0, 'prototype pollution path must fail');
  assert.match(run.stdout, /__proto__|prototype|constructor/i, 'message must explain failure');
  assert.equal(({}).polluted, undefined, 'Object.prototype must not be polluted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a finding on a number leaf passes when kept and fails when dropped, and unsupported leaves are skipped', async () => {
  const dir = tmpDir('runner-leaf-types');

  // Kept number leaf: max_tokens in Anthropic request
  fs.writeFileSync(path.join(dir, 'f-num-kept.json'), JSON.stringify({
    finding: finding({ id: 'f-num-kept', path: 'max_tokens' }),
    fixture: anthropicRequestFixture('t-num-1')
  }));
  const run1 = await runRunner(dir);
  assert.equal(run1.status, 0, 'kept number leaf must pass');

  // Dropped number leaf: metadata.dropped_num in Anthropic request
  fs.writeFileSync(path.join(dir, 'f-num-dropped.json'), JSON.stringify({
    finding: finding({ id: 'f-num-dropped', path: 'metadata.dropped_num' }),
    fixture: anthropicRequestFixture('t-num-2', [leaf('metadata.dropped_num', { type: 'number' })])
  }));
  fs.rmSync(path.join(dir, 'f-num-kept.json'));
  const run2 = await runRunner(dir);
  assert.notEqual(run2.status, 0, 'dropped number leaf must fail');

  // Unsupported leaf types: bool, null, enum, object, array -> should not fail the suite (skipped)
  for (const t of ['bool', 'null', 'object', 'array']) {
    fs.writeFileSync(path.join(dir, `f-skip-${t}.json`), JSON.stringify({
      finding: finding({ id: `f-skip-${t}`, path: `metadata.${t}_field` }),
      fixture: anthropicRequestFixture(`t-${t}`, [leaf(`metadata.${t}_field`, { type: t })])
    }));
  }
  fs.writeFileSync(path.join(dir, 'f-skip-enum.json'), JSON.stringify({
    finding: finding({ id: 'f-skip-enum', path: 'metadata.enum_field' }),
    fixture: anthropicRequestFixture('t-enum', [leaf('metadata.enum_field', { enum: 'some_val' })])
  }));
  fs.rmSync(path.join(dir, 'f-num-dropped.json'));
  const run3 = await runRunner(dir);
  assert.equal(run3.status, 0, 'cases on bool, null, enum, object or array leaves must not fail the suite');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a synthetic Anthropic stream case with delta.text deltas: 3 passes through a correct converter', async () => {
  const dir = tmpDir('runner-anthropic-deltas');
  const fixture = {
    traceId: 't-ant-deltas',
    model: 'up-sonnet',
    clientFormat: 'anthropic',
    upstreamFormat: 'anthropic',
    halves: [{
      half: 'intact',
      direction: 'response',
      records: [{
        event: 'content_block_delta',
        leaves: [
          leaf('type', { enum: 'content_block_delta' }),
          leaf('delta.type', { enum: 'text_delta' }),
          leaf('delta.text', { len: 30, deltas: 3 })
        ]
      }]
    }]
  };
  const run = await runRunner(dir);
  assert.equal(run.status, 0, run.stdout);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stale fixtures are removed on a successful check', async () => {
  const lab = await fakeIntact({
    findings: [finding({ id: 'f-fresh' })],
    fixtures: { 't-1': anthropicRequestFixture('t-1') }
  });
  const dir = tmpDir('prune-ok');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stale.json'), '{"stale":true}');
    fs.writeFileSync(path.join(dir, 'run.test.mjs'), '// runner must stay');
    const out = await runCheck({ settings: lab.settings, dir, log: () => {} });
    assert.equal(out.ok, true, out.error);
    assert.equal(fs.existsSync(path.join(dir, 'stale.json')), false, 'stale.json must be removed');
    assert.equal(fs.existsSync(path.join(dir, 'f-fresh.json')), true, 'f-fresh.json must exist');
    assert.equal(fs.existsSync(path.join(dir, 'run.test.mjs')), true, 'run.test.mjs must never be touched');
  } finally {
    await lab.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed pull keeps existing fixtures including stale ones', async () => {
  const dir = tmpDir('prune-fail');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stale.json'), '{"stale":true}');
  const down = await runCheck({ settings: () => ({ url: 'http://127.0.0.1:1', apiKey: 'k', enabled: true }), dir, log: () => {} });
  assert.equal(down.ok, false);
  assert.equal(fs.existsSync(path.join(dir, 'stale.json')), true, 'failed pull must delete nothing');
  fs.rmSync(dir, { recursive: true, force: true });
});
