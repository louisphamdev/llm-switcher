import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUpstreamPayloads } from '../upstream-stream.mjs';

async function collect(text, widths = [1, 3, 7]) {
  const bytes = Buffer.from(text); let offset = 0, i = 0;
  const body = new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    const end = Math.min(bytes.length, offset + widths[i++ % widths.length]);
    controller.enqueue(bytes.subarray(offset, end)); offset = end;
  } });
  return Array.fromAsync(readUpstreamPayloads({ body }));
}
test('multiline SSE joins data fields across CRLF, byte chunks and UTF-8', async () => {
  const text = ': ping\r\nevent: message\r\nid: 1\r\nretry: 1000\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"giữ ngữ cảnh"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  assert.deepEqual(await collect(text), [{ choices: [{ delta: { content: 'giữ ngữ cảnh' } }] }]);
});
test('Vertex JSON lines and final SSE event without delimiter both survive', async () => {
  assert.deepEqual(await collect('{"one":1}\n{"two":2}'), [{ one: 1 }, { two: 2 }]);
  assert.deepEqual(await collect('data: {"one":1}'), [{ one: 1 }]);
});
test('malformed JSON is surfaced and stopping consumption cancels the upstream', async () => {
  await assert.rejects(collect('data: {"partial":\n\n'), SyntaxError);
  let canceled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(Buffer.from('data: {"one":1}\n\n')); }, cancel() { canceled = true; } });
  for await (const item of readUpstreamPayloads({ body })) { assert.equal(item.one, 1); break; }
  assert.equal(canceled, true);
});
