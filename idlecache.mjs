// Gateway-owned prefix cache. Client transcripts and databases are never opened here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { conversationKey } from './idlecompact.mjs';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const VERSION = 1;

export function policyFingerprint(policy) {
  return digest(policy);
}

export function compactCacheKey(clientFormat, req, payload, ir, profile, profileKey, policy) {
  const session = conversationKey(clientFormat, req, ir);
  if (!session) return '';
  // Credentials influence scope but only the final digest is stored on disk.
  return digest({ clientFormat, session, profileKey, profile,
    principal: [req?.headers?.authorization || '', req?.headers?.['x-api-key'] || '',
      req?.headers?.['x-llm-switcher-token'] || ''],
    context: { model: payload.model, system: payload.system, instructions: payload.instructions,
      tools: payload.tools, toolChoice: payload.tool_choice }, policy });
}

function validRecord(r, key) {
  if (!r || r.version !== VERSION || r.key !== key || !Number.isFinite(r.seenAt) || r.seenAt < 0) return false;
  const allowed = ['version', 'key', 'seenAt', 'prefixCount', 'prefixHash', 'replacement',
    'replacementHash', 'generation', 'createdAt'];
  if (Object.keys(r).some(field => !allowed.includes(field))) return false;
  if (!('prefixCount' in r)) return Object.keys(r).every(field => ['version', 'key', 'seenAt'].includes(field));
  return Number.isInteger(r.prefixCount) && r.prefixCount > 0 && r.prefixCount <= 100000 &&
    /^[a-f0-9]{64}$/.test(r.prefixHash) && typeof r.generation === 'string' &&
    /^[a-f0-9-]{36}$/.test(r.generation) && Array.isArray(r.replacement) &&
    /^[a-f0-9]{64}$/.test(r.replacementHash) && digest(r.replacement) === r.replacementHash &&
    r.replacement.length > 0 && r.replacement.length <= 100000 &&
    r.replacement.every(item => item && typeof item === 'object' && !Array.isArray(item) &&
      (typeof item.role === 'string' || typeof item.type === 'string')) &&
    Number.isFinite(r.createdAt) && r.createdAt >= 0;
}

export class IdlePrefixCache {
  constructor(stateDir, { now = () => Date.now(), onDiagnostic = () => {} } = {}) {
    this.dir = path.join(stateDir, 'idle-compact');
    this.now = now;
    this.onDiagnostic = onDiagnostic;
  }

  diagnostic(code) {
    try { this.onDiagnostic(code); } catch { /* diagnostics cannot fail a client turn */ }
  }

  file(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid cache key');
    return path.join(this.dir, `${key}.json`);
  }

  load(key, policy) {
    try {
      const dirStat = fs.lstatSync(this.dir);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('invalid cache directory');
      const file = this.file(key);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) throw new Error('invalid cache file');
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!validRecord(record, key)) throw new Error('invalid cache record');
      if (this.now() - record.seenAt > policy.sessionLookbackHours * 3600000 ||
          record.seenAt > this.now() + 60000 ||
          ('createdAt' in record && (record.createdAt > this.now() + 60000 ||
            this.now() - record.createdAt > policy.sessionLookbackHours * 3600000))) {
        this.remove(key);
        return null;
      }
      return record;
    } catch (err) {
      if (err.code !== 'ENOENT') { this.diagnostic('cache-read-failed'); this.remove(key); }
      return null;
    }
  }

  remove(key) {
    try {
      const stat = fs.lstatSync(this.dir);
      if (stat.isDirectory() && !stat.isSymbolicLink()) fs.unlinkSync(this.file(key));
    } catch { /* missing or unavailable is safe */ }
  }

  save(record, policy) {
    let tmp;
    try {
      if (!validRecord(record, record.key)) throw new Error('invalid cache record');
      const bytes = JSON.stringify(record);
      if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw new Error('cache record too large');
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(this.dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid cache directory');
      fs.chmodSync(this.dir, 0o700);
      const file = this.file(record.key);
      tmp = `${file}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
      this.prune(policy);
      return true;
    } catch {
      if (tmp) try { fs.unlinkSync(tmp); } catch { /* unavailable */ }
      this.diagnostic('cache-write-failed');
      return false;
    }
  }

  prune(policy) {
    // Expire records using the configured session lookback, without evicting live sessions.
    try {
      const stat = fs.lstatSync(this.dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid cache directory');
      for (const entry of fs.readdirSync(this.dir)) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
        const key = entry.slice(0, -5);
        this.load(key, policy);
      }
    } catch { this.diagnostic('cache-prune-failed'); }
  }

  matches(record, history) {
    return Array.isArray(history) && history.length >= record.prefixCount &&
      digest(history.slice(0, record.prefixCount)) === record.prefixHash;
  }

  /** Return the previous pause and a cached rewrite; exact original suffix is kept verbatim. */
  visit(key, history, policy) {
    if (!key || !Array.isArray(history)) return { idleMs: 0, history: null, record: null };
    let record = this.load(key, policy);
    const idleMs = record ? Math.max(0, this.now() - record.seenAt) : 0;
    if (record?.prefixCount && !this.matches(record, history)) {
      record = null;
    }
    const shortened = record?.prefixCount
      ? [...record.replacement, ...history.slice(record.prefixCount)] : null;
    const touched = { ...(record || { version: VERSION, key }), seenAt: this.now() };
    if (!this.save(touched, policy)) return { idleMs: 0, history: null, record: null };
    return { idleMs: record ? idleMs : 0, history: shortened, record: touched };
  }

  create(key, history, prefixCount, replacement, policy) {
    const record = { version: VERSION, key, seenAt: this.now(), createdAt: this.now(),
      prefixCount, prefixHash: digest(history.slice(0, prefixCount)), replacement,
      replacementHash: digest(replacement),
      generation: crypto.randomUUID() };
    return this.save(record, policy) ? record : null;
  }

  /** A late summary can upgrade only the generation that asked for it. */
  upgrade(key, generation, replacement, policy) {
    const record = this.load(key, policy);
    if (!record?.prefixCount || record.generation !== generation) return false;
    return this.save({ ...record, replacement, replacementHash: digest(replacement),
      generation: crypto.randomUUID() }, policy);
  }
}
