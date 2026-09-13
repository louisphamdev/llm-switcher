import assert from 'node:assert/strict';

// Kiểm tra chuỗi event Anthropic hợp lệ: index tăng dần theo thứ tự start, delta chỉ vào block đang mở.
export function assertValidAnthropicEvents(events) {
  const open = new Set();
  const seen = new Set();
  let expectedNext = 0;
  for (const { event, data } of events) {
    if (event === 'content_block_start') {
      assert.equal(data.index, expectedNext, `block index must be sequential (got ${data.index}, want ${expectedNext})`);
      assert.ok(!seen.has(data.index), `index ${data.index} reused`);
      seen.add(data.index);
      open.add(data.index);
      expectedNext++;
    } else if (event === 'content_block_delta') {
      assert.ok(open.has(data.index), `delta for block ${data.index} which is not open`);
    } else if (event === 'content_block_stop') {
      assert.ok(open.has(data.index), `stop for block ${data.index} which is not open`);
      open.delete(data.index);
    } else if (event === 'message_stop') {
      assert.equal(open.size, 0, 'all blocks must be closed before message_stop');
    }
  }
}
