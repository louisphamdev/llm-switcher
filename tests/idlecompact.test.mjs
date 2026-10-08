import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseToIR } from '../formats.mjs';
import { idleCompactPolicy, validateIdleCompactPatch, conversationKey, compactIR,
  compactRawHistory, compactResponsesInput, summaryMessages, summaryReplacement, clampSummary } from '../idlecompact.mjs';
import { IdlePrefixCache, compactCacheKey } from '../idlecache.mjs';
import { askSummary } from '../idlecall.mjs';

const policy = (over = {}) => idleCompactPolicy({ idleCompact: { enabled: true, ...over } });
const fixture = () => {
  const messages = [{ role: 'user', content: 'Fix the failing test' }];
  for (let i = 0; i < 12; i++) messages.push(
    { role: 'assistant', content: [{ type: 'text', text: `DECISION_${i}: preserve the contract` },
      { type: 'tool_use', id: `call_${i}`, name: 'Read', input: { file_path: `file_${i}` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call_${i}`, content: `RESULT_${i}:` + 'X'.repeat(4000) }] });
  return { model: 'claude-probe', system: 'Be concise', messages, stream: false };
};
const req = (session = 'one', token = 'owner') => ({ headers: { 'x-claude-code-session-id': session, authorization: `Bearer ${token}` } });
const profile = { baseURL: 'http://127.0.0.1:1234', apiKey: 'PRIVATE_PROVIDER_KEY', outFormat: 'anthropic' };

function cacheFixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-prefix-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 100000000;
  const cache = new IdlePrefixCache(dir, { now: () => now, ...options });
  return { dir, cache, advance(ms) { now += ms; } };
}

function keyFor(body = fixture(), request = req(), prof = profile, p = policy(), name = 'profile') {
  return compactCacheKey('anthropic', request, body, parseToIR('anthropic', body), prof, name, p);
}

test('config accepts all supported fields and rejects unknown, wrong type, zero, and fractional counts', () => {
  assert.equal(idleCompactPolicy({}).enabled, false);
  assert.equal(idleCompactPolicy({}).codex, false);
  assert.equal(validateIdleCompactPatch({ enabled: true, codex: true, userChars: 128,
    summaryMaxChars: 256, sessionLookbackHours: 168 }), '');
  assert.equal(validateIdleCompactPatch({ model: null }), '');
  assert.equal(idleCompactPolicy({ idleCompact: { model: null } }).model, null);
  for (const patch of [{ unknown: 1 }, { codex: 'yes' }, { userChars: 0 },
    { keepRecent: 2.5 }, { minBytes: 8191 }, { idleMinutes: Infinity }, { model: {} }]) {
    assert.notEqual(validateIdleCompactPatch(patch), '', JSON.stringify(patch));
  }
  const p = idleCompactPolicy({ idleCompact: { idleMinutes: '4', minBytes: -5,
    keepRecent: 10000, userChars: 1, unknown: 9 } });
  assert.equal(p.idleMinutes, 15);
  assert.equal(p.minBytes, 65536);
  assert.equal(p.keepRecent, 100);
  assert.equal(p.userChars, 128);
  assert.equal('unknown' in p, false);
});

test('only explicit session identifiers establish cache identity', () => {
  const ir = parseToIR('anthropic', fixture());
  assert.equal(conversationKey('anthropic', { headers: {} }, ir), '');
  assert.equal(conversationKey('anthropic', req(), ir), 'h:one');
  assert.equal(conversationKey('responses', { headers: { 'thread-id': 'thread-A' } }, {}), 'h:thread-A');
  assert.equal(conversationKey('responses', { headers: { 'x-codex-turn-metadata': '{"session_id":"thread-B"}' } }, {}), 'h:thread-B');
  assert.equal(conversationKey('responses', { headers: {} }, { promptCacheKey: 'thread-C' }), 'p:thread-C');
});

test('scope separates sessions, callers, profiles, models, system prompts, tools, and policies', () => {
  const body = fixture();
  const base = keyFor(body);
  const others = [keyFor(body, req('two')), keyFor(body, req('one', 'other-owner')),
    keyFor(body, req(), { ...profile, baseURL: 'http://other' }), keyFor(body, req(), profile, policy(), 'other-profile'),
    keyFor({ ...body, model: 'other-model' }), keyFor({ ...body, system: 'other-system' }),
    keyFor({ ...body, tools: [{ name: 'Write' }] }), keyFor(body, req(), profile, policy({ model: 'summary' }))];
  assert.ok(others.every(key => key !== base));
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.equal(keyFor(body, { headers: {} }), '');
});

test('actual parsed assistant tool call keeps its accompanying decision text', () => {
  const body = fixture();
  const ir = parseToIR('anthropic', body);
  assert.ok(ir.messages[1].toolCalls);
  const compacted = compactIR(ir, policy());
  assert.match(JSON.stringify(compacted.messages), /DECISION_1:/);
  assert.doesNotMatch(JSON.stringify(compacted.messages), /RESULT_1:/);
  assert.match(JSON.stringify(summaryMessages(ir, policy())), /DECISION_1:/);
  assert.doesNotMatch(JSON.stringify(summaryMessages(ir, policy())), /X{4000}/);
});

test('raw compact prefix keeps exact opening and suffix without dangling tool results', () => {
  const body = fixture();
  for (const keepRecent of [1, 2, 3, 6, 9]) {
    const p = policy({ keepRecent });
    const compacted = compactRawHistory(body.messages, 'anthropic', p);
    assert.ok(compacted);
    assert.deepEqual(compacted.history[0], body.messages[0]);
    assert.deepEqual(compacted.history.slice(compacted.replacement.length), body.messages.slice(compacted.prefixCount));
    const calls = new Set();
    for (const message of compacted.history) for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use') calls.add(block.id);
      if (block.type === 'tool_result') assert.ok(calls.has(block.tool_use_id));
    }
  }
});

test('a result deeper in the tail keeps its older call, and malformed orphan input is forwarded', () => {
  const body = fixture();
  body.messages[20] = { role: 'user', content: 'result still pending' };
  body.messages.push({ role: 'user', content: 'An intervening question' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_9', content: 'delayed result' }] });
  const compacted = compactRawHistory(body.messages, 'anthropic', policy({ keepRecent: 2 }));
  assert.ok(compacted.prefixCount <= 19);
  const orphan = structuredClone(body.messages);
  orphan.at(-1).content[0].tool_use_id = 'missing';
  assert.equal(compactRawHistory(orphan, 'anthropic', policy({ keepRecent: 2 })), null);
});

test('multiple calls pair correctly, mixed result text survives, and missing or duplicate IDs are rejected', () => {
  const body = fixture();
  body.messages[2].content.push({ type: 'text', text: 'USER_DECISION_KEEP' });
  const good = compactRawHistory(body.messages, 'anthropic', policy());
  assert.match(JSON.stringify(good.replacement), /USER_DECISION_KEEP/);
  for (const change of [messages => delete messages[1].content[1].id,
    messages => messages[3].content[1].id = 'call_0',
    messages => messages[4].content[0].tool_use_id = 'call_0']) {
    const messages = structuredClone(body.messages); change(messages);
    assert.equal(compactRawHistory(messages, 'anthropic', policy()), null);
  }
  body.messages.at(-2).content.push({ type: 'tool_use', id: 'concurrent', name: 'Bash', input: {} });
  body.messages.at(-1).content.push({ type: 'tool_result', tool_use_id: 'concurrent', content: 'parallel result' });
  assert.ok(compactRawHistory(body.messages, 'anthropic', policy({ keepRecent: 1 })));
});

test('unknown Anthropic server tools and tool references prevent shortening', () => {
  for (const type of ['server_tool_use', 'web_search_tool_result', 'bash_code_execution_tool_result', 'tool_reference']) {
    const body = fixture(); body.messages.at(-1).content.push({ type, id: 'server-id', content: 'result' });
    assert.equal(compactRawHistory(body.messages, 'anthropic', policy()), null, type);
  }
});

test('Responses assistant text uses output_text and deeper custom tool results retain calls', () => {
  const input = [{ role: 'developer', content: 'policy' }, { role: 'user', content: 'task' }];
  for (let i = 0; i < 10; i++) input.push(
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `decision ${i}` }] },
    { type: 'custom_tool_call', call_id: `c${i}`, name: 'shell', input: 'ls' },
    { type: 'custom_tool_call_output', call_id: `c${i}`, output: 'X'.repeat(4000) });
  input[25] = { type: 'message', role: 'user', content: 'output pending' };
  input.push({ role: 'user', content: 'new turn' }, { type: 'custom_tool_call_output', call_id: 'c7', output: 'delayed' });
  const compacted = compactRawHistory(input, 'responses', policy({ keepRecent: 2 }));
  assert.ok(compacted);
  const assistant = compacted.replacement.find(item => item.role === 'assistant');
  assert.equal(assistant.content[0].type, 'output_text');
  const calls = new Set();
  for (const item of compactResponsesInput(input, policy({ keepRecent: 2 }))) {
    if (item.type === 'custom_tool_call') calls.add(item.call_id);
    if (item.type === 'custom_tool_call_output') assert.ok(calls.has(item.call_id));
  }
});

test('stable cached prefix preserves every new suffix turn and survives a gateway restart', t => {
  const { cache, dir, advance } = cacheFixture(t);
  const body = fixture(); const p = policy(); const key = keyFor(body);
  assert.equal(cache.visit(key, body.messages, p).history, null);
  advance(16 * 60000);
  assert.equal(cache.visit(key, body.messages, p).idleMs, 16 * 60000);
  const compacted = compactRawHistory(body.messages, 'anthropic', p);
  assert.ok(cache.create(key, body.messages, compacted.prefixCount, compacted.replacement, p));
  const suffix = [{ role: 'assistant', content: 'NEW_ANSWER' }, { role: 'user', content: 'NEW_REQUEST' }];
  const resumed = new IdlePrefixCache(dir, { now: cache.now });
  const result = resumed.visit(key, [...body.messages, ...suffix], p);
  assert.deepEqual(result.history, [...compacted.replacement, ...body.messages.slice(compacted.prefixCount), ...suffix]);
  assert.deepEqual(resumed.visit(key, [...body.messages, ...suffix], p).history, result.history);
  const contents = fs.readFileSync(path.join(dir, 'idle-compact', `${key}.json`), 'utf8');
  assert.doesNotMatch(contents, /PRIVATE_PROVIDER_KEY|Bearer owner|RESULT_1:/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, 'idle-compact')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'idle-compact', `${key}.json`)).mode & 0o777, 0o600);
  }
});

test('native client compact or edited history invalidates cached prefix and rejects late summary', t => {
  const { cache } = cacheFixture(t); const body = fixture(); const p = policy(); const key = keyFor(body);
  const compacted = compactRawHistory(body.messages, 'anthropic', p);
  const original = cache.create(key, body.messages, compacted.prefixCount, compacted.replacement, p);
  assert.equal(cache.visit(key, [{ role: 'user', content: 'NATIVE SUMMARY' }], p).history, null);
  assert.equal(cache.upgrade(key, original.generation, summaryReplacement(compacted, 'OLD'), p), false);
  const second = cache.create(key, body.messages, compacted.prefixCount, compacted.replacement, p);
  assert.equal(cache.upgrade(key, original.generation, summaryReplacement(compacted, 'OLD'), p), false);
  assert.equal(cache.upgrade(key, second.generation, summaryReplacement(compacted, 'CURRENT'), p), true);
  const suffix = [{ role: 'user', content: 'AFTER SUMMARY REQUEST' }];
  assert.deepEqual(cache.visit(key, [...body.messages, ...suffix], p).history.at(-1), suffix[0]);
});

test('corrupt, oversized, expired, and unavailable cache state safely forwards original history', t => {
  const { cache, dir, advance } = cacheFixture(t); const p = policy(); const key = keyFor(); const body = fixture();
  cache.visit(key, body.messages, p);
  const file = path.join(dir, 'idle-compact', `${key}.json`);
  fs.writeFileSync(file, '{bad');
  assert.equal(cache.visit(key, body.messages, p).history, null);
  fs.writeFileSync(file, 'X'.repeat(2 * 1024 * 1024 + 1));
  assert.equal(cache.visit(key, body.messages, p).history, null);
  advance(73 * 3600000);
  assert.equal(cache.visit(key, body.messages, p).idleMs, 0);
  const impossible = path.join(dir, 'file'); fs.writeFileSync(impossible, 'x');
  assert.equal(new IdlePrefixCache(impossible).visit(key, body.messages, p).history, null);
});

test('parseable corruption and a symlinked cache directory cannot replace history or delete external files', t => {
  const { cache, dir } = cacheFixture(t); const p = policy(); const body = fixture(); const key = keyFor(body);
  const compacted = compactRawHistory(body.messages, 'anthropic', p);
  const record = cache.create(key, body.messages, compacted.prefixCount, compacted.replacement, p);
  const file = path.join(dir, 'idle-compact', `${key}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...record, replacement: [{ role: 'user', content: 'CORRUPT' }] }));
  assert.equal(cache.visit(key, body.messages, p).history, null);
  if (process.platform === 'win32') return;
  fs.rmSync(path.join(dir, 'idle-compact'), { recursive: true });
  const outside = path.join(dir, 'outside'); fs.mkdirSync(outside);
  const external = path.join(outside, `${key}.json`); fs.writeFileSync(external, JSON.stringify(record));
  fs.symlinkSync(outside, path.join(dir, 'idle-compact'), 'dir');
  const before = fs.readFileSync(external);
  assert.equal(cache.visit(key, body.messages, p).history, null);
  assert.deepEqual(fs.readFileSync(external), before);
});

test('cache expires by configured lookback and never touches Claude transcripts or either Codex rollout/SQLite file', async t => {
  const { cache, dir, advance } = cacheFixture(t);
  const clientDir = path.join(dir, 'clients'); fs.mkdirSync(clientDir);
  const files = ['claude.jsonl', 'thread-A.jsonl', 'thread-B.jsonl', 'thread_history_1.sqlite'];
  for (const file of files) fs.writeFileSync(path.join(clientDir, file), `original ${file}`);
  const before = files.map(file => fs.readFileSync(path.join(clientDir, file)));
  const p = policy(); const body = fixture(); const compacted = compactRawHistory(body.messages, 'anthropic', p);
  for (let i = 0; i < 8; i++) { advance(1); cache.create(keyFor(body, req(`session-${i}`)), body.messages, compacted.prefixCount, compacted.replacement, p); }
  assert.equal(fs.readdirSync(path.join(dir, 'idle-compact')).length, 8);
  advance(p.sessionLookbackHours * 3600000 + 1);
  cache.prune(p);
  assert.equal(fs.readdirSync(path.join(dir, 'idle-compact')).length, 0);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(clientDir, file)), before[i]));
});

test('empty summary model calls neither builder nor provider', async () => {
  let called = false;
  assert.equal(await askSummary({ ir: parseToIR('anthropic', fixture()), policy: policy(), profile,
    model: 'official-expensive-model', build() { called = true; }, fetchImpl() { called = true; } }), '');
  assert.equal(called, false);
});

test('summary builder exceptions, HTTP failures, tool-only output, and ignored abort are contained with diagnostics', async () => {
  const ir = parseToIR('anthropic', fixture()); const p = policy({ model: 'free-summary' });
  const diagnostics = []; const base = { ir, policy: p, profile, model: 'mapped-summary', onDiagnostic: e => diagnostics.push(e.code) };
  assert.equal(await askSummary({ ...base, build() { throw new Error('bad route'); } }), '');
  const build = () => ({ url: 'http://unused', headers: {}, upBody: {} });
  assert.equal(await askSummary({ ...base, build, fetchImpl: async () => new Response('', { status: 429 }) }), '');
  assert.equal(await askSummary({ ...base, build, fetchImpl: async () => new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'c', name: 'Read' }] })) }), '');
  assert.equal(await askSummary({ ...base, build, timeoutMs: 10, fetchImpl: () => new Promise(() => {}) }), '');
  assert.deepEqual(diagnostics, ['summary-call-failed', 'summary-http-failed', 'summary-empty-output', 'summary-timeout']);
});

test('configured summary uses supplied mapped model, stripped tools, and bounded text', async () => {
  const p = policy({ model: 'summary-alias', summaryMaxChars: 256 }); let sent;
  const result = await askSummary({ ir: parseToIR('anthropic', fixture()), policy: p, profile, model: 'mapped-cheap',
    build(_profile, model, ir) { assert.equal(model, 'mapped-cheap'); assert.equal(ir.model, model);
      assert.deepEqual(ir.tools, []); return { url: 'http://mock', headers: {}, upBody: { model, messages: ir.messages } }; },
    fetchImpl: async (_url, options) => { sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'SUMMARY ' + 'X'.repeat(1000) } }] })); } });
  assert.ok(result.length <= 256);
  assert.equal(sent.model, 'mapped-cheap');
  assert.match(JSON.stringify(sent.messages), /DECISION_1:/);
  assert.equal(clampSummary(null, p), '');
});

test('invalid legacy numeric text budgets preserve complete text while wrong types default', () => {
  for (const value of [0, -1, NaN, Infinity]) {
    const p = policy({ userChars: value, summaryMaxChars: value });
    const text = '完整原文'.repeat(10000);
    assert.equal(clampSummary(text, p), text);
    const msgs = summaryMessages({messages:[{role:'user', content:text}]}, p);
    assert.equal(JSON.stringify(msgs).includes(text), true);
  }
  assert.equal(clampSummary('X'.repeat(50000), policy({summaryMaxChars:1})).length, 50000);
  for (const value of [null, [], {}, '0', true]) {
    const p = policy({userChars:value,summaryMaxChars:value});
    assert.equal(p.userChars, 3000); assert.equal(p.summaryMaxChars, 24000);
  }
});
