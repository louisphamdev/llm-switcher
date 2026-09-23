// One fixed runner for every contract finding. `switch contract-check` writes only JSON files
// beside this one; this file never changes, so no text of a finding or a fixture ever becomes
// JavaScript. With no JSON file it passes with zero cases.
//
// Each case rebuilds a payload from the recorded SHAPE: a unique marker per string leaf, padded
// to the recorded length. The case passes when the marker of the finding's path survives the
// converter. The shape of a fixture and of a finding is documented in docs/contracts.md of intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseToIR, emitUpstreamBody, healAnthropicPayload,
  createUpstreamNormalizer, createCollector, splitThinkTags,
  buildAnthropicMessage, buildChatMessage, buildResponsesMessage, buildVertexMessage
} from '../../formats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASE_DIR = process.env.LLM_SWITCHER_CONTRACT_DIR || HERE;

const markerFor = (index, len) => {
  const base = `LSWMARKER${index}Z`;
  return base.length >= len ? base : base + 'x'.repeat(len - base.length);
};

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function assertSafePath(p) {
  for (const seg of String(p || '').split('.')) {
    const key = seg.replace(/(?:\[\])*$/, '');
    if (FORBIDDEN_SEGMENTS.has(key)) {
      throw new Error(`Forbidden segment in path "${p}": "${key}" may pollute prototype`);
    }
  }
}

// The drift path syntax: `messages[].content[].text`. One `[]` is one array level, and every
// array is rebuilt with a single element, so leaves that share a prefix share that element.
function parsePath(p) {
  assertSafePath(p);
  const parts = [];
  for (const segment of String(p).split('.')) {
    const m = /^(.*?)((?:\[\])*)$/.exec(segment);
    if (m[1]) parts.push({ key: m[1] });
    for (let i = 0; i < m[2].length / 2; i++) parts.push({ index: 0 });
  }
  return parts;
}

function setAt(root, rawPath, value) {
  const parts = parsePath(rawPath);
  if (!parts.length) return;
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i].index ?? parts[i].key;
    if (cur[key] === null || typeof cur[key] !== 'object') cur[key] = parts[i + 1].index === undefined ? {} : [];
    cur = cur[key];
  }
  const last = parts.at(-1);
  cur[last.index ?? last.key] = value;
}

function readAt(root, rawPath) {
  let cur = root;
  for (const part of parsePath(rawPath)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part.index ?? part.key];
  }
  return cur;
}

// An enum leaf keeps its recorded value, because the converter reads it (`type`, `role`,
// `stop_reason`). Every other leaf gets a value that appears nowhere else in the payload.
function valueOf(lf, index, chunk) {
  const type = String(lf.type || 'string');
  if (type === 'number') return 1000 + index;
  if (type === 'bool' || type === 'boolean') return true;
  if (type === 'null') return null;
  if (type === 'object') return {};
  if (type === 'array') return [];
  if (lf.enum) return lf.enum;
  return chunk ?? markerFor(index, Number(lf.len) || 0);
}

/** One document per recorded event, and one document per delta of an accumulated leaf. */
function buildDocs(records, markers) {
  const docs = [];
  let index = 0;
  for (const record of records || []) {
    const leaves = (record.leaves || []).filter(lf => lf && lf.path && lf.type !== 'cut');
    const numbered = leaves.map(lf => ({ lf, index: index++ }));
    for (const { lf, index: i } of numbered) {
      const type = lf.type || 'string';
      if (!lf.enum) {
        if (type === 'string') {
          markers.set(lf.path, markerFor(i, Number(lf.len) || 0));
        } else if (type === 'number') {
          markers.set(lf.path, 1000 + i);
        }
      }
    }
    const deltas = Math.max(1, ...numbered.map(({ lf }) => Number(lf.deltas) || 1));
    for (let d = 0; d < deltas; d++) {
      const doc = {};
      let wrote = false;
      for (const { lf, index: i } of numbered) {
        const own = Math.max(1, Number(lf.deltas) || 1);
        if (own === 1 && d > 0 && !lf.enum) continue;
        let chunk;
        if (own > 1) {
          const whole = markers.get(lf.path) ?? markerFor(i, Number(lf.len) || 0);
          const size = Math.ceil(whole.length / own);
          chunk = whole.slice(d * size, (d + 1) * size);
        }
        setAt(doc, lf.path, valueOf(lf, i, chunk));
        wrote = true;
      }
      if (wrote) docs.push(doc);
    }
  }
  return docs;
}

function clientMessage(clientFormat, args) {
  if (clientFormat === 'anthropic') return buildAnthropicMessage(args);
  if (clientFormat === 'responses') return buildResponsesMessage(args);
  if (clientFormat === 'vertex') return buildVertexMessage(args);
  return buildChatMessage(args);
}

// Request: the tool's request becomes the upstream request. Response: the upstream answer, event
// by event, becomes the answer the tool receives.
function convert(fixture, direction, docs) {
  const model = String(fixture.model || 'contract-model');
  const clientFormat = String(fixture.clientFormat || 'anthropic');
  const upstreamFormat = String(fixture.upstreamFormat || 'openai-chat');
  if (direction === 'request') {
    const payload = docs[0] || {};
    if (clientFormat === 'anthropic' && upstreamFormat === 'anthropic') return healAnthropicPayload(payload).payload;
    return emitUpstreamBody(upstreamFormat, parseToIR(clientFormat, payload), model);
  }
  const normalize = createUpstreamNormalizer(upstreamFormat);
  const col = createCollector();
  for (const doc of docs) col.add(normalize(doc));
  const split = splitThinkTags(col.text.join(''));
  return clientMessage(clientFormat, {
    model,
    think: [...col.think, split.think].filter(Boolean),
    text: [split.text],
    tools: [...col.tools.values()].sort((a, b) => a.index - b.index),
    finish: col.finish,
    prompt: col.prompt,
    completion: col.completion(),
    cached: col.cached,
    reasoning: col.reasoning,
    sig: col.sig
  });
}

function caseFiles() {
  try {
    return fs.readdirSync(CASE_DIR).filter(n => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

test('every contract finding replays through the converter', async (t) => {
  for (const name of caseFiles()) {
    await t.test(name, (sub) => {
      const { finding, fixture } = JSON.parse(fs.readFileSync(path.join(CASE_DIR, name), 'utf8'));
      assertSafePath(finding.path);
      if (finding.mapping) assertSafePath(finding.mapping);
      const direction = String(finding.direction || 'request');
      // The input of the diff: the tool's request for one direction, the upstream answer for the other.
      const wantHalf = direction === 'request' ? 'switcher' : 'intact';
      const half = (fixture.halves || []).find(h => h.half === wantHalf && h.direction === direction);
      assert.ok(half, `the fixture has no ${wantHalf} half of the ${direction} direction`);

      let targetLeaf = null;
      for (const rec of half.records || []) {
        for (const lf of rec.leaves || []) {
          if (lf && lf.path === finding.path) {
            targetLeaf = lf;
            break;
          }
        }
        if (targetLeaf) break;
      }

      if (targetLeaf) {
        const leafType = String(targetLeaf.type || 'string');
        if (targetLeaf.enum || ['bool', 'boolean', 'null', 'object', 'array'].includes(leafType)) {
          sub.skip(`skipped: unsupported leaf type "${targetLeaf.enum ? 'enum' : leafType}" for finding ${finding.id}`);
          return;
        }
      }

      const markers = new Map();
      const docs = buildDocs(half.records, markers);
      const marker = markers.get(finding.path);
      assert.ok(marker !== undefined, `the fixture has no leaf at ${JSON.stringify(finding.path)}`);

      const out = convert(fixture, direction, docs);
      if (finding.class === 'renamed' && finding.mapping) {
        const got = readAt(out, finding.mapping);
        assert.ok(String(got ?? '').includes(String(marker)), `${finding.id}: the value of the renamed field is not at its target path`);
        return;
      }
      assert.ok(JSON.stringify(out).includes(String(marker)), `${finding.id}: the converter loses this field`);
    });
  }
});
