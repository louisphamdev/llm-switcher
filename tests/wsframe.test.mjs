// Tests for blindfold/wsframe.mjs — the frame reader that a capture uses.
//
// Why it exists (2026-09-20): a Codex completion does not travel over HTTP. The
// blindfold log shows `upgrade passthrough /backend-api/codex/responses`, so the
// request that matters is a WebSocket and a capture of HTTP alone records the
// handshake and nothing else.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createFrameReader, negotiatesDeflate, OPCODE } from '../blindfold/wsframe.mjs';

// Build a frame the way a client does: masked, because RFC 6455 requires every
// client frame to be masked and an unmasking bug is invisible without a test.
function frame(opcode, payload, { fin = true, mask = false, rsv1 = false } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = [(fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode];
  let lengthBytes = [];
  if (body.length < 126) {
    lengthBytes = [];
    head.push((mask ? 0x80 : 0) | body.length);
  } else if (body.length < 65536) {
    head.push((mask ? 0x80 : 0) | 126);
    const b = Buffer.alloc(2); b.writeUInt16BE(body.length); lengthBytes = [...b];
  } else {
    head.push((mask ? 0x80 : 0) | 127);
    const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(body.length)); lengthBytes = [...b];
  }
  const key = mask ? Buffer.from([0x01, 0x02, 0x03, 0x04]) : Buffer.alloc(0);
  const masked = Buffer.from(body);
  if (mask) for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from(head), Buffer.from(lengthBytes), key, masked]);
}

test('a masked client frame is unmasked', () => {
  const read = createFrameReader();
  const out = read(frame(OPCODE.text, '{"type":"response.create"}', { mask: true }));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'text');
  assert.equal(out[0].payload.toString(), '{"type":"response.create"}');
});

test('an unmasked server frame is read as it is', () => {
  const read = createFrameReader();
  const out = read(frame(OPCODE.text, 'hello'));
  assert.equal(out[0].payload.toString(), 'hello');
});

// A TCP chunk boundary has nothing to do with a frame boundary. Both directions
// of this split must work, or a capture loses whole messages at random.
test('one frame split across chunks is reassembled', () => {
  const read = createFrameReader();
  const f = frame(OPCODE.text, 'split me please', { mask: true });
  assert.deepEqual(read(f.subarray(0, 3)), []);
  assert.deepEqual(read(f.subarray(3, 7)), []);
  const out = read(f.subarray(7));
  assert.equal(out[0].payload.toString(), 'split me please');
});

test('several frames in one chunk are all returned', () => {
  const read = createFrameReader();
  const out = read(Buffer.concat([
    frame(OPCODE.text, 'one', { mask: true }),
    frame(OPCODE.text, 'two', { mask: true }),
    frame(OPCODE.text, 'three', { mask: true })
  ]));
  assert.deepEqual(out.map((m) => m.payload.toString()), ['one', 'two', 'three']);
});

test('a fragmented message is joined, and only the final frame is emitted', () => {
  const read = createFrameReader();
  const first = read(frame(OPCODE.text, 'part one ', { fin: false, mask: true }));
  assert.deepEqual(first, [], 'a non-final frame must not be emitted on its own');
  const out = read(frame(OPCODE.continuation, 'part two', { mask: true }));
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.toString(), 'part one part two');
});

// 126 and 127 select a 2-byte and an 8-byte length. Getting either offset wrong
// shifts every later frame, so the whole stream decodes as noise.
test('the extended length forms are read', () => {
  const read = createFrameReader();
  const medium = 'x'.repeat(300);
  assert.equal(read(frame(OPCODE.text, medium, { mask: true }))[0].payload.toString(), medium);
  const large = 'y'.repeat(70000);
  assert.equal(read(frame(OPCODE.text, large, { mask: true }))[0].payload.toString(), large);
});

test('a control frame is reported and does not break a fragmented message', () => {
  const read = createFrameReader();
  read(frame(OPCODE.text, 'start ', { fin: false, mask: true }));
  const ping = read(frame(OPCODE.ping, '', { mask: true }));
  assert.equal(ping[0].type, 'ping');
  assert.equal(ping[0].control, true);
  const out = read(frame(OPCODE.continuation, 'end', { mask: true }));
  assert.equal(out[0].payload.toString(), 'start end', 'the ping must not join the message');
});

test('a permessage-deflate payload is inflated when the handshake negotiated it', () => {
  const text = '{"type":"response.output_text.delta","delta":"PONG"}';
  // A permessage-deflate sender ends the message with Z_SYNC_FLUSH, which leaves
  // the empty block 00 00 ff ff, and then strips those four bytes. Z_FINISH, the
  // default of deflateRawSync, does not produce that tail at all.
  const deflated = zlib.deflateRawSync(Buffer.from(text), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  assert.deepEqual([...deflated.subarray(deflated.length - 4)], [0x00, 0x00, 0xff, 0xff]);
  const body = deflated.subarray(0, deflated.length - 4);
  const read = createFrameReader({ inflate: true });
  const out = read(frame(OPCODE.text, body, { mask: true, rsv1: true }));
  assert.equal(out[0].compressed, true);
  assert.equal(out[0].payload.toString(), text);
});

// Measured on a real Codex stream (2026-09-20): inflating each message on its own
// decoded the first and lost the next 20 with "invalid distance too far back".
// permessage-deflate keeps the compression window between messages by default.
test('a second compressed message decodes, because the inflate context is kept', async () => {
  // One sender stream, flushed per message: that is what context takeover means.
  const sender = zlib.createDeflateRaw({ windowBits: 15 });
  const chunks = [];
  sender.on('data', (c) => chunks.push(c));
  const deflate = (text) => new Promise((resolve) => {
    const before = Buffer.concat(chunks).length;
    sender.write(Buffer.from(text));
    sender.flush(zlib.constants.Z_SYNC_FLUSH, () => {
      const all = Buffer.concat(chunks);
      resolve(all.subarray(before, all.length - 4));
    });
  });
  const first = '{"type":"codex.rate_limits","rate_limits":{"used_percent":2}}';
  const second = '{"type":"codex.rate_limits","rate_limits":{"used_percent":3}}';
  const payloads = [await deflate(first), await deflate(second)];

  const read = createFrameReader({ inflate: true });
  const a = read(frame(OPCODE.text, payloads[0], { rsv1: true }));
  const b = read(frame(OPCODE.text, payloads[1], { rsv1: true }));
  assert.equal(a[0].payload.toString(), first);
  assert.equal(b[0].payload.toString(), second, 'the second message must decode as well');
  assert.equal(b[0].note, undefined, 'no decode failure is expected');
});

test('a payload that cannot be inflated keeps a reason instead of noise', () => {
  const read = createFrameReader({ inflate: true });
  const out = read(frame(OPCODE.text, Buffer.from([0xff, 0xfe, 0xfd]), { mask: true, rsv1: true }));
  assert.equal(out[0].compressed, true);
  assert.match(out[0].note, /cannot inflate permessage-deflate payload/);
});

test('deflate is only used when the handshake asked for it', () => {
  assert.equal(negotiatesDeflate('permessage-deflate; client_max_window_bits'), true);
  assert.equal(negotiatesDeflate('PERMESSAGE-DEFLATE'), true);
  assert.equal(negotiatesDeflate('x-webkit-deflate-frame'), false);
  assert.equal(negotiatesDeflate(undefined), false);
  assert.equal(negotiatesDeflate(''), false);
});
