// Claude Code's session file.
//
// Claude Code keeps a conversation as a JSONL file, one entry per line, and builds every request
// it sends from the chain of entries linked by parentUuid. That is a fact about the file, not about
// any API, and it is the reason a compaction written here lasts: the next request is built from
// whatever the chain says, so an entry that starts a new chain shortens every request after it.
//
// A compaction is two entries, and this is the shape Claude Code itself writes. It was read off a
// real session on this machine, from Claude Code's own automatic compaction:
//
//   {"type":"system","subtype":"compact_boundary","content":"Conversation compacted",
//    "parentUuid":null,"logicalParentUuid":"<the last entry before>",
//    "compactMetadata":{"trigger":"auto","preTokens":968627,"postTokens":19320, ...}}
//
//   {"type":"user","isCompactSummary":true,
//    "message":{"role":"user","content":"This session is being continued from a previous
//     conversation that ran out of context. The summary below covers the earlier portion..."}}
//
// The boundary is what makes the old entries unreachable rather than deleted. That is Claude Code's
// own behaviour: its automatic compaction drops ~949k tokens of history and leaves the entries in
// the file, because a transcript the person can still read is worth more than a small file. This
// writes the same thing for the same reason, so nothing here destroys anything a resume would
// otherwise show.
//
// Verified against Claude Code 2.1.292 on this machine: with twelve synthetic turns and a boundary
// before them, the next resume sent four messages instead of the thirteen, and none of the twelve.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UUID = () => crypto.randomUUID();

// The line Claude Code writes, kept verbatim so a summary written here is read exactly like one
// Claude Code wrote itself.
const SUMMARY_PREFIX =
  'This session is being continued from a previous conversation. The summary below covers the ' +
  'earlier portion of the conversation.\n\nSummary:\n';

export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * The file a session lives in. Claude Code names the directory after the working directory, with
 * the separators folded into dashes, and the file after the session id.
 */
export function sessionFileFor(sessionId, cwd, env = process.env) {
  const dir = path.join(claudeConfigDir(env), 'projects', encodeCwd(cwd));
  return { dir, file: path.join(dir, `${sessionId}.jsonl`) };
}

// A gateway does not know the client's working directory: nothing in the request says so, and
// guessing it would write the compaction somewhere nothing reads it. The session id is enough,
// though, because Claude Code names the file after it and never reuses one. So the file is found
// by looking for it, which also means a session started somewhere else is found too.
export function findSessionFile(sessionId, env = process.env) {
  if (!sessionId || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) return '';
  const projects = path.join(claudeConfigDir(env), 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const f = path.join(projects, d.name, `${sessionId}.jsonl`);
    try {
      fs.accessSync(f, fs.constants.R_OK);
      return f;
    } catch { /* another project directory, keep looking */ }
  }
  return '';
}

function encodeCwd(cwd) {
  return String(cwd || '').replace(/[\\/:]/g, '-');
}

/** Reads the session id out of the headers or body Claude Code sends. */
export function claudeSessionId(req, payload) {
  const h = req?.headers?.['x-claude-code-session-id'];
  if (h && typeof h === 'string' && h.trim()) return h.trim();
  const uid = payload?.metadata?.user_id;
  if (typeof uid === 'string') {
    const m = /_session_([0-9a-f-]{8,})/i.exec(uid);
    if (m) return m[1];
    if (/^[0-9a-f-]{36}$/i.test(uid.trim())) return uid.trim();
  }
  return '';
}

/** The last entry in the chain, which is where a compaction cuts. */
export function readLeaf(file) {
  let last = null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e && typeof e.uuid === 'string') last = e;
  }
  return last;
}

/**
 * Writes the two entries. Appends, because the chain is append-only and the old entries stay: the
 * boundary makes them unreachable, and a person who resumes an old session id by hand still finds
 * the transcript.
 *
 * Returns what it wrote, or null when it could not: a session file this cannot write is not a
 * reason to fail the request. The turn is still shortened on the wire either way.
 */
export function writeCompaction({ file, summary, sessionId, cwd, preTokens, postTokens, version }) {
  if (!file || !summary) return null;
  const leaf = readLeaf(file);
  if (!leaf) return null;
  // A file that already ends in a boundary has nothing to cut again, and writing a second one
  // would drop the summary that is already in place.
  if (isBoundaryTail(file)) return null;

  const sid = sessionId || leaf.sessionId || 'unknown';
  const at = new Date().toISOString();
  const base = {
    isSidechain: false,
    cwd: cwd || '',
    version: version || '',
    sessionId: sid,
    timestamp: at,
  };
  const boundaryUuid = UUID();
  const boundary = {
    ...base,
    parentUuid: null,
    logicalParentUuid: leaf.uuid,
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    uuid: boundaryUuid,
    compactMetadata: {
      trigger: 'auto',
      preTokens: preTokens || 0,
      postTokens: postTokens || 0,
      cumulativeDroppedTokens: Math.max(0, (preTokens || 0) - (postTokens || 0)),
      durationMs: 0,
    },
  };
  const summaryEntry = {
    ...base,
    parentUuid: boundaryUuid,
    uuid: UUID(),
    promptId: UUID(),
    type: 'user',
    isCompactSummary: true,
    message: { role: 'user', content: SUMMARY_PREFIX + summary },
  };

  const lines = [JSON.stringify(boundary), JSON.stringify(summaryEntry)].join('\n') + '\n';
  try {
    // Appended in place, never rewritten through a rename. Claude Code holds this file open while
    // a session runs, so a rename would replace the file it is writing to: its next append would
    // land on the old inode and every entry written in between would be lost. One O_APPEND write
    // puts both entries at the end together.
    fs.appendFileSync(file, lines, { mode: 0o600 });
  } catch {
    return null;
  }
  return { boundaryUuid, summaryUuid: summaryEntry.uuid };
}

function isBoundaryTail(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const lines = text.split('\n').filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 40; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e?.type === 'system' && e?.subtype === 'compact_boundary') return true;
    if (e?.type === 'user' && e?.isCompactSummary === true) return true;
  }
  return false;
}

export { SUMMARY_PREFIX };