// Codex's thread store.
//
// Codex compacts by writing three things that have to agree, and all three were read off a real
// thread that had compacted seven times:
//
//   1. a `compacted` entry in the rollout file, carrying the summary and the history that replaces
//      the old one;
//   2. a row of type contextCompaction in thread_items, whose item_json is nothing but a type and
//      an id -- a marker, not a summary;
//   3. thread_history_projection_state moved forward to the byte offset and ordinal of the entry
//      just written.
//
// The third is the one that is easy to miss, and it is why writing the first two looks like it
// worked and then changes nothing. thread_history_projection_state tracks how far the store has
// consumed the rollout file: next_rollout_byte_offset is the size of the file, exactly, and
// next_rollout_ordinal is the ordinal after the last entry read. The rollout file is the record;
// the store is a projection of it. Append to the file without moving the projection and the entry
// is simply unread.
//
// This writes all three, and it is opt-in, and it is opt-in because it opens Codex's database. It
// never deletes: earlier items stay, as they stay after Codex's own compaction, and the marker is
// what makes them unreachable.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const uuid = () => crypto.randomUUID();

function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(env.HOME || '', '.codex');
}

/** The rollout file of the most recent thread: sessions/YYYY/MM/DD/rollout-<stamp>-<id>.jsonl */
export function latestRollout(env = process.env, now = new Date()) {
  const root = codexHome(env);
  let newest = { file: '', mtime: 0 };
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        try {
          const m = fs.statSync(p).mtimeMs;
          if (m > newest.mtime) newest = { file: p, mtime: m };
        } catch { /* vanished under us, keep looking */ }
      }
    }
  };
  walk(path.join(root, 'sessions'), 0);
  return newest.file;
}

/**
 * Writes a compaction into the thread Codex is working on. Returns what it wrote, or null when it
 * wrote nothing -- which is never an error: the turn is still shortened on the wire either way.
 */
export async function writeCodexCompaction({ summary, env = process.env, now = Date.now() }) {
  const text = String(summary || '').trim();
  if (!text) return null;

  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(path.join(codexHome(env), 'thread_history_1.sqlite'));
  } catch {
    return null;
  }

  try {
    const thread = db.prepare(
      'SELECT thread_id FROM thread_items GROUP BY thread_id ORDER BY MAX(rollout_ordinal) DESC LIMIT 1'
    ).get();
    if (!thread) return null;
    const tid = thread.thread_id;

    const turn = db.prepare(
      'SELECT turn_id FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1'
    ).get(tid);
    const turnId = turn?.turn_id || uuid();

    // The ordinal follows the projection, not MAX(rollout_ordinal): an entry appended to the file
    // moves the projection's ordinal on, and the two are not the same number.
    const proj = db.prepare(
      'SELECT next_rollout_byte_offset AS off, next_rollout_ordinal AS ord FROM thread_history_projection_state WHERE thread_id = ?'
    ).get(tid);
    const ordinal = proj?.ord ?? (db.prepare('SELECT MAX(rollout_ordinal) AS m FROM thread_items WHERE thread_id = ?').get(tid)?.m ?? 0) + 1;

    const file = latestRollout(env);
    if (!file) return null;

    const itemId = uuid();
    const entry = {
      timestamp: new Date(now).toISOString(),
      ordinal,
      type: 'compacted',
      payload: {
        message: text,
        // The summary doubles as the one message that survives, so the thread keeps something to
        // answer from even if nothing else is carried over.
        replacement_history: [{
          type: 'message',
          id: 'msg_' + uuid().replace(/-/g, '').slice(0, 24),
          role: 'user',
          content: [{ type: 'input_text', text }],
        }],
        window_number: 1,
      },
    };
    const line = JSON.stringify(entry) + '\n';

    // Appended in place. A rename would swap the file Codex holds open, and its next append
    // would land on the old inode, taking everything written since with it.
    fs.appendFileSync(file, line);
    const size = fs.statSync(file).size;

    db.prepare(
      'INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type, updated_at_ordinal, started_at_ms, completed_at_ms) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(tid, turnId, itemId, ordinal, now, JSON.stringify({ type: 'contextCompaction', id: itemId }),
      'contextCompaction', ordinal, now, now);

    // The part that is easy to leave out, and without which the first two are unread.
    db.prepare(
      'UPDATE thread_history_projection_state SET next_rollout_byte_offset = ?, next_rollout_ordinal = ? WHERE thread_id = ?'
    ).run(size, ordinal, tid);

    db.close();
    return { threadId: tid, ordinal, bytes: size, chars: text.length };
  } catch {
    try { db?.close(); } catch { /* already closed */ }
    return null;
  }
}