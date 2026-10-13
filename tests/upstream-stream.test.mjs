import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUpstreamPayloads, parseIdleMs } from '../upstream-stream.mjs';

async function collect(text, widths = [1, 3, 7]) {
  const bytes = Buffer.from(text); let offset = 0, i = 0;
  const body = new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    const end = Math.min(bytes.length, offset + widths[i++ % widths.length]);
    controller.enqueue(bytes.subarray(offset, end)); offset = end;
  } });
  const values = [];
  for await (const value of readUpstreamPayloads({ body })) values.push(value);
  return values;
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

test('an upstream that goes silent mid-stream ends with an error after the idle limit', async () => {
  // A dead HTTP/2 session can hold a stream open with no bytes (router-for-me/CLIProxyAPI#6534).
  let sent = false;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(Buffer.from('data: {"a":1}\n\n')); }
      return new Promise(() => {});
    },
    cancel() { cancelled = true; }
  });
  const values = [];
  await assert.rejects(async () => {
    for await (const v of readUpstreamPayloads({ body }, { idleMs: 50 })) values.push(v);
  }, /sent nothing for/);
  assert.deepEqual(values, [{ a: 1 }]);
  assert.ok(cancelled, 'the silent upstream body is cancelled');
});

test('parseIdleMs keeps the idle limit inside what setTimeout accepts', () => {
  // Node fires a timer of a negative, infinite or > 2^31-1 delay after 1 ms.
  assert.equal(parseIdleMs('3000000000'), 2147483647);
  for (const bad of ['-5', 'Infinity', 'abc', '0', '0.5']) assert.equal(parseIdleMs(bad), 300000, bad);
  assert.equal(parseIdleMs('120000'), 120000);
  assert.equal(parseIdleMs(undefined), 300000);
});

test('the idle limit counts the gap between reads, not the whole stream', async () => {
  let n = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (n === 5) return controller.close();
      await new Promise(r => setTimeout(r, 60));
      controller.enqueue(Buffer.from(`data: {"n":${n++}}\n\n`));
    }
  });
  const values = [];
  for await (const v of readUpstreamPayloads({ body }, { idleMs: 200 })) values.push(v.n);
  assert.deepEqual(values, [0, 1, 2, 3, 4]);
});
