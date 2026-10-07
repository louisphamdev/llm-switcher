// Idle compaction.
//
// The part worth testing hard is the session file, because nothing in any API guarantees it: the
// shape was read off a real session Claude Code wrote itself, and the only proof it works is that
// Claude Code reads it back. The test that matters is TestResumeReadsTheBoundary, which runs the
// real binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

// Async, never execFileSync: the probe server that answers Claude Code runs in this same process,
// and a blocking call would stop the event loop from ever answering it.
const run = promisify(execFile);
import http from 'node:http';
import crypto from 'node:crypto';

import {
  idleCompactPolicy, conversationKey, idleFor, noteConversation, compactIR,
  summaryMessages, clampSummary, SUMMARY_INSTRUCTION,
} from '../idlecompact.mjs';
import { sessionFileFor, claudeSessionId, writeCompaction, readLeaf, claudeConfigDir } from '../claudesession.mjs';

const long = 'X'.repeat(4000);

function agentIR(turns = 10, fill = 4000) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'fix the failing test' }] }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'assistant', content: [
      { type: 'text', text: `step ${i}` },
      { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'ls' } },
    ] });
    messages.push({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: `t${i}`, content: `turn${i}:` + 'Y'.repeat(fill) },
    ] });
  }
  return { system: 'be brief', messages, tools: [], model: 'claude-x' };
}

function policy(over = {}) {
  return idleCompactPolicy({ idleCompact: { enabled: true, idleMinutes: 15, minBytes: 1024, ...over } });
}

// ---- the policy ----

test('the feature is off until it is asked for', () => {
  assert.equal(idleCompactPolicy({}).enabled, false);
  assert.equal(idleCompactPolicy({ idleCompact: { enabled: true } }).enabled, true);
});

test('a nonsense setting falls back to the default instead of breaking', () => {
  const p = idleCompactPolicy({ idleCompact: { idleMinutes: -3, minBytes: 'x', keepRecent: 0 } });
  assert.equal(p.idleMinutes, 15);
  assert.ok(p.minBytes > 0);
  assert.equal(p.keepRecent, 6);
});

test('a conversation that was never here is not idle', () => {
  assert.equal(idleFor('nope'), 0);
});

test('the time since the last request is what the pause means', () => {
  const now = 1_000_000;
  noteConversation('k', now - 20 * 60000);
  assert.ok(Math.abs(idleFor('k', now) - 20 * 60000) < 50);
});

// ---- which conversation ----

test('the session the client names wins over its content', () => {
  const k = conversationKey('claude', { headers: { 'x-claude-code-session-id': 'abc' } }, agentIR());
  assert.equal(k, 'h:abc');
});

test('a client that names nothing is keyed on its opening request', () => {
  const k1 = conversationKey('claude', { headers: {} }, agentIR());
  const k2 = conversationKey('claude', { headers: {} }, agentIR());
  assert.equal(k1, k2, 'the same conversation keys the same both times');
  const other = agentIR();
  other.messages[0].content[0].text = 'a different task entirely';
  assert.notEqual(k1, conversationKey('claude', { headers: {} }, other));
});

test('the key survives the compaction it causes', () => {
  // The opening request is the one message a compaction keeps, which is the whole reason the
  // fallback key is built from it and not from the whole body.
  const ir = agentIR();
  const before = conversationKey('claude', { headers: {} }, ir);
  const c = compactIR(ir, policy());
  ir.messages = c.messages;
  assert.equal(conversationKey('claude', { headers: {} }, ir), before);
});

// ---- the shortened history ----

test('the opening request and the recent turns survive as bytes', () => {
  const ir = agentIR(10);
  const c = compactIR(ir, policy({ keepRecent: 6 }));
  assert.ok(c);
  assert.equal(c.messages[0].content[0].text, 'fix the failing test');
  const tail = JSON.stringify(c.messages.slice(-6));
  assert.ok(tail.includes('tool_use'), 'the recent tool calls are kept: the next turn reasons over them');
});

test('the bulky middle goes and its words stay', () => {
  // Each turn is tagged, so the test can tell an early turn from a recent one. The recent turns
  // keep their tool output on purpose: the next turn reasons over those results verbatim.
  const ir = agentIR(10);
  const c = compactIR(ir, policy({ keepRecent: 6 }));
  const text = JSON.stringify(c.messages);
  assert.ok(!text.includes('turn1:'), 'an early middle tool result came through whole');
  assert.ok(text.includes('turn9:'), 'a recent tool result was cut, so the next turn lost what it reasons over');
  assert.ok(text.includes('step 3'), 'a middle assistant message lost its text');
  assert.ok(c.dropped > 0);
});

test('no tool result survives without the call that made it', () => {
  // A result whose call was cut away is a request the provider refuses, so this is the invariant
  // that has to hold whatever the window lands on.
  for (const keep of [3, 4, 5, 6, 8]) {
    const c = compactIR(agentIR(12), policy({ keepRecent: keep }));
    assert.ok(c, `keepRecent=${keep} produced nothing`);
    const calls = new Set();
    for (const m of c.messages) {
      for (const p of m.content || []) {
        if (p?.type === 'tool_use') calls.add(p.id);
        if (p?.type === 'tool_result') {
          assert.ok(calls.has(p.tool_use_id), `keepRecent=${keep}: result ${p.tool_use_id} has no call`);
        }
      }
    }
  }
});

test('a conversation too short to be worth it is left alone', () => {
  assert.equal(compactIR(agentIR(2, 10), policy()), null);
  assert.equal(compactIR({ messages: [{ role: 'user', content: 'hi' }] }, policy()), null);
});

// ---- the summary ----

test('the summarizer is handed the history without its tool output', () => {
  const msgs = summaryMessages(agentIR(10), policy());
  assert.ok(msgs.length > 1);
  assert.match(msgs[0].content[0].text, /summarize/i);
  assert.ok(!JSON.stringify(msgs).includes('Y'.repeat(4000)));
});

test('an over-long summary is cut at a boundary, not mid-word', () => {
  const s = clampSummary('A'.repeat(10) + '\n\n' + 'B'.repeat(30000), policy({ summaryMaxChars: 1000 }));
  assert.ok(s.length <= 1000);
  assert.ok(!s.includes('A'.repeat(11)));
});

test('a summary of nothing is nothing', () => {
  assert.equal(clampSummary('', policy()), '');
  assert.equal(clampSummary(null, policy()), '');
});

// ---- the session file ----

function tmpSession(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-sess-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sess.jsonl');
  return { file, dir };
}

function seed(file, entries) {
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

test('the compaction is written as the two entries Claude Code writes', (t) => {
  const { file } = tmpSession(t);
  seed(file, [{ type: 'user', uuid: 'u1', sessionId: 's1', message: { role: 'user', content: 'a' } }]);
  const r = writeCompaction({ file, summary: 'the summary', sessionId: 's1', preTokens: 900, postTokens: 80 });
  assert.ok(r);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const boundary = lines.at(-2);
  const summary = lines.at(-1);
  assert.equal(boundary.type, 'system');
  assert.equal(boundary.subtype, 'compact_boundary');
  assert.equal(boundary.logicalParentUuid, 'u1', 'the chain is cut at the entry before');
  assert.equal(boundary.compactMetadata.preTokens, 900);
  assert.equal(summary.type, 'user');
  assert.equal(summary.isCompactSummary, true);
  assert.match(summary.message.content, /the summary/);
  assert.match(summary.message.content, /continued from a previous conversation/);
});

test('the old entries stay, because a transcript is worth more than a small file', (t) => {
  // This is what Claude Code itself does: its own compaction drops ~949k tokens and leaves the
  // entries. The boundary makes them unreachable, not gone.
  const { file } = tmpSession(t);
  seed(file, Array.from({ length: 20 }, (_, i) => ({ type: 'user', uuid: `u${i}`, sessionId: 's1', message: { role: 'user', content: `m${i}` } })));
  writeCompaction({ file, summary: 'the summary', sessionId: 's1' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 22);
  assert.ok(lines.some(l => l.includes('"m0"')), 'the earliest entry is still readable');
});

test('a session already compacted is not compacted twice', (t) => {
  const { file } = tmpSession(t);
  seed(file, [{ type: 'user', uuid: 'u1', sessionId: 's1', message: { role: 'user', content: 'a' } }]);
  assert.ok(writeCompaction({ file, summary: 'first', sessionId: 's1' }));
  assert.equal(writeCompaction({ file, summary: 'second', sessionId: 's1' }), null);
});

test('nothing is written where there is nothing to write', (t) => {
  const { file } = tmpSession(t);
  seed(file, [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'a' } }]);
  assert.equal(writeCompaction({ file, summary: '', sessionId: 's1' }), null);
  assert.equal(writeCompaction({ file: path.join(path.dirname(file), 'gone.jsonl'), summary: 'x' }), null);
  assert.equal(readLeaf(file).uuid, 'u1');
});

test('every appended line is valid json', (t) => {
  // A torn line makes Claude Code drop the rest of the file, which loses the transcript.
  const { file } = tmpSession(t);
  seed(file, [{ type: 'user', uuid: 'u1', sessionId: 's1', message: { role: 'user', content: 'a' } }]);
  writeCompaction({ file, summary: 'multi\nline\nsummary', sessionId: 's1' });
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim()) JSON.parse(line);
  }
});

test('the session id comes from the header or the body Claude Code sends', () => {
  assert.equal(claudeSessionId({ headers: { 'x-claude-code-session-id': 'S1' } }, {}), 'S1');
  assert.equal(claudeSessionId({ headers: {} }, { metadata: { user_id: 'u_1_account_a_session_dead-beef' } }), 'dead-beef');
  assert.equal(claudeSessionId({ headers: {} }, {}), '');
});

test('the session file sits where Claude Code puts it', () => {
  const { file } = sessionFileFor('abc', '/opt/hermes/proj', { CLAUDE_CONFIG_DIR: '/cfg' });
  assert.equal(file, '/cfg/projects/-opt-hermes-proj/abc.jsonl');
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/x' }), '/x');
});

// ---- the real thing ----

// This is the test that settles whether writing the file does anything at all. It runs the real
// Claude Code binary against a local server and reads the request it sends.
const probe = (() => {
  let last = null;
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => {
      try { last = JSON.parse(b); } catch { /* keep the last good one */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_probe', type: 'message', role: 'assistant', model: last?.model || 'x',
        content: [{ type: 'text', text: 'probe ok' }], stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  return { server, get last() { return last; } };
})();

test('Claude Code resumes from the boundary and leaves the old turns out', { timeout: 240000, skip: !hasClaude() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-cc-'));
  await new Promise(r => probe.server.listen(0, '127.0.0.1', r));
  const port = probe.server.address().port;
  const cfg = path.join(dir, 'cfg');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'probe project\n');
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'probe-key',
    CLAUDE_CONFIG_DIR: cfg,
  };

  // One real turn, so the session file is written by Claude Code and has its own shape in it.
  await run('claude', ['-p', 'say ok', '--model', 'claude-probe-1'], { env, cwd: proj, timeout: 180000 });
  const sessions = path.join(cfg, 'projects', proj.replace(/[\\/:]/g, '-'));
  const file = fs.readdirSync(sessions).map(f => path.join(sessions, f))[0];
  const sid = path.basename(file, '.jsonl');
  const sidFromBody = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).sessionId;

  // Twelve turns of history, then a compaction boundary before them.
  const entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const leaf = entries.filter(e => e.uuid).at(-1);
  const base = (u, parent) => ({
    parentUuid: parent, isSidechain: false, userType: 'external', cwd: proj,
    version: '2.1.292', sessionId: sidFromBody || sid, uuid: u, timestamp: new Date().toISOString(),
  });
  let parent = leaf.uuid;
  for (let i = 0; i < 12; i++) {
    const u = crypto.randomUUID();
    entries.push({ ...base(u, parent), type: 'user', message: { role: 'user', content: `turn ${i} question` } });
    parent = u;
    const a = crypto.randomUUID();
    entries.push({ ...base(a, parent), type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: `answer ${i}` },
      { type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file_path: '/x/y.py' } }] } });
    parent = a;
    const t = crypto.randomUUID();
    entries.push({ ...base(t, parent), type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: `toolu_${i}`, content: long }] } });
    parent = t;
  }
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const beforeBytes = fs.statSync(file).size;

  const wrote = writeCompaction({ file, summary: 'PROBE_SUMMARY_MARKER_12345', sessionId: sid, cwd: proj });
  assert.ok(wrote, 'the boundary was written');

  await run('claude', ['-p', 'after compact, reply ok', '--model', 'claude-probe-1', '--resume', sid],
    { env, cwd: proj, timeout: 180000 });

  const sent = JSON.stringify(probe.last?.messages || []);
  assert.match(sent, /PROBE_SUMMARY_MARKER_12345/, 'the summary is what the request carries');
  assert.equal((sent.match(new RegExp(long, 'g')) || []).length, 0, 'none of the twelve turns came through');
  assert.ok(fs.statSync(file).size > beforeBytes, 'the entries are appended, not rewritten');

  await new Promise(r => probe.server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

function hasClaude() {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; }
}