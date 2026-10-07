// Idle-triggered compaction.
//
// A conversation that pauses long enough loses the provider's prompt cache. The next request pays
// full price for a prefix the provider no longer holds, and it pays it again on the turn after
// that if nothing changes. How long a provider keeps its cache is its own business and differs
// per provider: Anthropic 5 minutes by default and 1 hour when the request asks for it, OpenAI 30
// minutes, Gemini and DeepSeek publish no lifetime at all. So the time is a setting, not a
// constant, and the default is the longest of those that is documented rather than the shortest,
// because compacting a cache that is still warm throws history away and pays the cache write
// again for nothing.
//
// What this does with the result is the part that matters, and it depends on the client:
//
//   - The request that is on its way out is shortened, so this turn costs the tokens of the
//     summary instead of the tokens of the history. That saving is real whichever client it is.
//   - For Claude Code the session file is also written, so the next resume starts from the
//     summary instead of from the history. Claude Code reads that file to build every request, so
//     the shortening lasts rather than lasting one turn.
//
// Codex needs neither half of that from here. Its compaction is a protocol item, not a file: a
// compaction_trigger in, one compaction output item out, and Codex stores it in its own history.
// The right place to serve that is the provider gateway, which can see the item, rather than a
// client-side gateway that would have to rewrite a thread file to reach the same state.
//
// Not every turn of a long session is compacted, and that is deliberate. Compacting on every turn
// would change the prefix every turn, so no turn would ever hit the cache, and the conversation
// would be summarized over and over. Compacting once, when a long pause says the cache is gone,
// keeps the summary stable for the turns that follow and spends one extra model call.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IDLE_COMPACT_KEY = 'idleCompact';

// Defaults. The idle time is the one setting worth being wrong about: too short and a warm cache
// is thrown away, too long and the history is paid for at full price on a turn that had no cache
// to lose anyway.
const DEFAULTS = {
  enabled: false,
  model: '',
  idleMinutes: 15,
  minBytes: 64 * 1024,
  keepRecent: 6,
  summaryMaxChars: 24000,
  sessionLookbackHours: 72,
};

export function idleCompactPolicy(cfg) {
  const raw = cfg?.[IDLE_COMPACT_KEY];
  const p = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  p.enabled = p.enabled === true;
  p.model = typeof p.model === 'string' ? p.model.trim() : '';
  p.idleMinutes = Number.isFinite(+p.idleMinutes) && +p.idleMinutes > 0 ? +p.idleMinutes : DEFAULTS.idleMinutes;
  p.minBytes = Number.isFinite(+p.minBytes) && +p.minBytes > 0 ? +p.minBytes : DEFAULTS.minBytes;
  p.keepRecent = Number.isFinite(+p.keepRecent) && +p.keepRecent > 0 ? Math.floor(+p.keepRecent) : DEFAULTS.keepRecent;
  p.summaryMaxChars = Number.isFinite(+p.summaryMaxChars) && +p.summaryMaxChars > 0
    ? Math.floor(+p.summaryMaxChars) : DEFAULTS.summaryMaxChars;
  p.sessionLookbackHours = Number.isFinite(+p.sessionLookbackHours) && +p.sessionLookbackHours > 0
    ? +p.sessionLookbackHours : DEFAULTS.sessionLookbackHours;
  p.idleMs = p.idleMinutes * 60000;
  return p;
}

// ---- when a conversation was last here ----

// A gateway restart forgets every conversation, which costs one compaction and nothing else: the
// next request is treated as new, which is the safe direction to be wrong in.
const seen = new Map();

function prune(now) {
  const cutoff = now - DEFAULTS.sessionLookbackHours * 3600000;
  for (const [k, t] of seen) if (t < cutoff) seen.delete(k);
}

/** Records that this conversation has just been answered. */
export function noteConversation(key, at = Date.now()) {
  if (!key) return;
  if (seen.size > 20000) prune(at);
  seen.set(key, at);
}

/** Milliseconds since this conversation last asked for something, or 0 when it is not known. */
export function idleFor(key, now = Date.now()) {
  if (!key) return 0;
  const t = seen.get(key);
  if (!t) return 0;
  return now - t;
}

// ---- which conversation this is ----

// Claude Code names its session in a header and again inside metadata.user_id. Codex names it in
// prompt_cache_key. A client that names nothing is keyed on the opening request instead, which is
// the one message a compaction does not remove, so the key survives the compaction itself.
export function conversationKey(_clientFormat, req, ir) {
  const header = req?.headers?.['x-claude-code-session-id'];
  if (header) return `h:${header}`;
  const pck = ir?.promptCacheKey;
  if (pck) return `p:${pck}`;
  const uid = ir?.metadataUserId;
  if (typeof uid === 'string') {
    const m = /_session_([0-9a-f-]{8,})/i.exec(uid);
    if (m) return `u:${m[1]}`;
    if (/^[0-9a-f-]{36}$/i.test(uid)) return `u:${uid}`;
  }
  const first = firstUserText(ir);
  if (first) return `c:${crypto.createHash('sha256').update(first).digest('hex').slice(0, 16)}`;
  return '';
}

// The opening request is read from the IR rather than from the raw body, because by this point the
// body has been parsed once already and the IR is what the rest of the gateway works with.
function firstUserText(ir) {
  for (const m of ir?.messages || []) {
    if (m.role !== 'user' || m.role === 'tool') continue;
    const t = textOf(m);
    if (t) return t.slice(0, 2000);
  }
  return '';
}

function textOf(msg) {
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  let out = '';
  for (const part of c) {
    if (typeof part === 'string') { out += part; continue; }
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') out += part.text || '';
  }
  return out;
}

// ---- the history, shortened ----

// The middle keeps its words and loses its tool calls and their results, because those are most
// of the weight of a session and none of what a summary is for. The opening request and the last
// few messages are kept as they are: the opening request is what the session is for, and the last
// few messages are what the next turn reasons over.
export function compactIR(ir, policy) {
  const msgs = ir.messages || [];
  if (msgs.length < policy.keepRecent + 2) return null;

  const head = msgs.findIndex(m => m.role === 'user' && m.role !== 'tool');
  if (head < 0) return null;
  let tail = msgs.length - policy.keepRecent;
  if (tail <= head + 1) return null;
  // A tool result whose call was cut is a request the provider refuses, so the tail never starts
  // on one.
  while (tail < msgs.length && isToolResult(msgs[tail])) tail++;
  if (tail <= head + 1) return null;

  const kept = [];
  kept.push(...msgs.slice(0, head));
  kept.push(msgs[head]);
  const middle = [];
  for (let i = head + 1; i < tail; i++) {
    const m = msgs[i];
    if (m.role === 'tool' || m.role === 'assistant' && m.toolCalls) continue;
    const t = textOf(m).trim();
    if (!t) continue;
    middle.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: trimText(t, policy.userChars ?? 3000) });
  }
  kept.push(...middle);
  kept.push(...msgs.slice(tail));
  // Where a summary belongs: right after the opening request, before the text that stands in for
  // the middle. That is where Claude Code puts its own, and a reader meets it as the first thing
  // after being told what it is.
  return {
    messages: kept,
    insertAt: head + 1,
    middle: middle.length,
    dropped: (tail - head - 1) - middle.length,
  };
}

function isToolResult(msg) {
  if (!msg) return false;
  if (msg.role === 'tool') return true;
  return Array.isArray(msg.content) && msg.content.some(p => p && (p.type === 'tool_result'));
}

function trimText(t, max) {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return (nl > max / 2 ? cut.slice(0, nl) : cut) + `\n[... ${t.length - max} more characters cut here ...]`;
}

// ---- the summary request ----

// The instruction names what a continuation needs, because "summarize this" produces something
// useless to the agent that has to keep working: the decisions and their reasons, the files that
// changed, the errors and their fixes, and what is still open.
export const SUMMARY_INSTRUCTION = 'Summarize this conversation so it can replace the history. ' +
  'Keep: what was asked, the decisions made and why, the files and commands that changed things, ' +
  'the errors and how they were resolved, and what is still pending. Drop: full tool output, ' +
  'intermediate reasoning, and anything already superseded. Write plain prose a continuing agent ' +
  'can act on without the original transcript.';

// The history handed to the summarizer is text only and already cut down, so the summarizer is not
// asked to read a megabyte of tool output to produce a paragraph.
export function summaryMessages(ir, policy) {
  const compacted = compactIR(ir, policy) || { messages: (ir.messages || []).slice(-policy.keepRecent) };
  const msgs = [{ role: 'user', content: [{ type: 'text', text: SUMMARY_INSTRUCTION }] }];
  for (const m of compacted.messages) {
    const t = textOf(m).trim();
    if (t) msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: trimText(t, policy.userChars ?? 3000) }] });
  }
  return msgs;
}

/** What a session file records: the words of the summary, cut to the budget. */
export function clampSummary(text, policy) {
  const s = String(text || '').trim();
  if (s.length <= policy.summaryMaxChars) return s;
  const cut = s.slice(0, policy.summaryMaxChars);
  const nl = cut.lastIndexOf('\n\n');
  if (nl > policy.summaryMaxChars / 2) return cut.slice(0, nl);
  const dot = cut.lastIndexOf('. ');
  if (dot > policy.summaryMaxChars / 2) return cut.slice(0, dot + 1);
  return cut;
}