import crypto from 'node:crypto';
import { readUpstreamPayloads } from './upstream-stream.mjs';

// A gateway capsule, not OpenAI ciphertext. Both intact and this gateway use this format.
export const COMPACTION_PREFIX = 'llm-gateway-compact-v1:';
export const COMPACTION_INSTRUCTION = 'Summarize this conversation so it can replace the history. Keep the user task, decisions and reasons, changed files and commands, resolved errors and pending work. Write a complete, concise summary that a continuing agent can use without the original transcript.';

export function encodeCompaction(summary) {
  return COMPACTION_PREFIX + Buffer.from(JSON.stringify({ summary })).toString('base64url');
}

export function decodeCompaction(value) {
  if (typeof value !== 'string' || !value.startsWith(COMPACTION_PREFIX)) {
    throw new Error('Cannot convert native or legacy compaction state; resume through its original Responses provider.');
  }
  try {
    const encoded = value.slice(COMPACTION_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('invalid encoding');
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) throw new Error('invalid encoding');
    const item = JSON.parse(decoded.toString('utf8'));
    if (typeof item.summary !== 'string' || !item.summary.trim()) throw new Error('empty summary');
    return item.summary;
  } catch { throw new Error('Invalid gateway compaction capsule; history was not forwarded.'); }
}

export function expandGatewayCompactions(payload) {
  if (!Array.isArray(payload.input)) return payload;
  let changed = false;
  const input = payload.input.map(item => {
    if (item?.type !== 'compaction' || !item.encrypted_content?.startsWith(COMPACTION_PREFIX)) return item;
    changed = true;
    return { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Conversation summary from an earlier turn:\n${decodeCompaction(item.encrypted_content)}` }] };
  });
  return changed ? { ...payload, input } : payload;
}

export function compactionResponse(col, model, splitText = text => text) {
  const summary = splitText(col.text.join('')).trim();
  if (col.error || col.finish !== 'stop' || col.tools.size || !summary) {
    throw new Error('Compaction requires a complete text summary without tool calls; upstream returned incomplete or invalid output.');
  }
  if (Buffer.byteLength(summary, 'utf8') > 24 * 1024) throw new Error('Compaction summary exceeds the 24 KiB limit; history was not replaced.');
  const item = { type: 'compaction', id: `cmp_${crypto.randomUUID()}`, encrypted_content: encodeCompaction(summary) };
  return { id: `resp_${crypto.randomUUID()}`, object: 'response', status: 'completed', model, output: [item] };
}

export async function collectCompaction(upstreamRes, format, stream, normalize, col) {
  let messageStopped = false;
  const add = payload => {
    const raw = payload.response || payload;
    const reasons = format === 'openai-chat' ? (raw.choices || []).map(c => c.finish_reason)
      : format === 'vertex' ? (raw.candidates || []).map(c => c.finishReason)
        : [raw.stop_reason, raw.delta?.stop_reason];
    const accepted = format === 'openai-chat' ? ['stop'] : format === 'vertex' ? ['STOP'] : ['end_turn', 'stop_sequence'];
    if (reasons.some(r => r && !accepted.includes(r))) throw new Error('Upstream returned an incomplete compaction summary.');
    if (raw.type === 'message_stop') messageStopped = true;
    col.add(normalize(payload));
    if (col.error) throw new Error(String(col.error));
    if (Buffer.byteLength(col.text.join(''), 'utf8') > 24 * 1024) throw new Error('Compaction summary exceeds the 24 KiB limit.');
  };
  if (stream) {
    for await (const payload of readUpstreamPayloads(upstreamRes)) add(payload);
    if (format === 'anthropic' && !messageStopped) throw new Error('Compaction stream ended before message_stop.');
  } else add(await upstreamRes.json());
}

export function emitCompaction(response, emit) {
  emit('response.created', { type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } });
  emit('response.output_item.done', { type: 'response.output_item.done', sequence_number: 1, output_index: 0, item: response.output[0] });
  emit('response.completed', { type: 'response.completed', sequence_number: 2, response });
}
