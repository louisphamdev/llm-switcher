// Minimal RFC 6455 frame reader, for the capture file only.
//
// The proxy relays the raw bytes untouched; this reader works on a copy. It exists
// because a Codex completion travels over a WebSocket, so a capture that only
// records HTTP sees the handshake and nothing else.
//
// Scope on purpose: it reassembles data messages and reports control frames. It
// does not answer a ping, does not close a connection and never writes a byte back.

import zlib from 'node:zlib';

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa
};

const NAME = Object.fromEntries(Object.entries(OPCODE).map(([k, v]) => [v, k]));

// A frame reader is a stream parser: a TCP chunk carries any number of frames, and
// one frame can be split across chunks. It buffers until a whole frame is present.
export function createFrameReader({ inflate = false } = {}) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = null;
  let fragmentCompressed = false;

  // The sender ends each message with Z_SYNC_FLUSH and strips the empty block it
  // leaves, so the reader appends those four bytes back.
  //
  // permessage-deflate uses context takeover by default: message two can reference
  // the compression window of message one. Inflating each message on its own fails
  // with "invalid distance too far back" from the second message onward. Measured
  // on a real Codex stream: 20 of 22 messages were lost that way.
  //
  // The window is restored by passing what was already decoded as the dictionary.
  // Raw deflate back-references reach into exactly that data, and 32 KiB is the
  // largest window the format can address, so older output cannot be referenced.
  //
  // A node zlib stream would keep the context by itself, but only asynchronously:
  // its synchronous entry point closes the handle after one call, so the second
  // message throws. This reader is synchronous, so the dictionary is the way.
  const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);
  const WINDOW = 32768;
  let history = Buffer.alloc(0);

  const inflateMessage = (payload) => {
    if (!inflate) return payload;
    const opts = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
    if (history.length) opts.dictionary = history.subarray(Math.max(0, history.length - WINDOW));
    const out = zlib.inflateRawSync(Buffer.concat([payload, TAIL]), opts);
    history = Buffer.concat([history, out]);
    if (history.length > WINDOW) history = history.subarray(history.length - WINDOW);
    return out;
  };

  return function push(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    const out = [];

    for (;;) {
      if (buffer.length < 2) break;
      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv1 = (b0 & 0x40) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < offset + 2) break;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) break;
        const big = buffer.readBigUInt64BE(offset);
        // A frame larger than 2^53 cannot be indexed by a JS number. Nothing sends
        // one; refusing is safer than truncating the length in silence.
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return [{ type: 'error', reason: 'frame length exceeds Number.MAX_SAFE_INTEGER' }];
        length = Number(big);
        offset += 8;
      }

      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) break;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) break;

      let payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }

      if (opcode >= 0x8) {
        // A control frame is never fragmented and never continues a data message.
        out.push({ type: NAME[opcode] || `opcode-${opcode}`, payload, control: true });
        continue;
      }

      if (opcode !== OPCODE.continuation) {
        fragmentOpcode = opcode;
        fragmentCompressed = rsv1;
        fragments = [];
      }
      fragments.push(payload);

      if (!fin) continue;

      let body = Buffer.concat(fragments);
      fragments = [];
      let note;
      if (fragmentCompressed) {
        try {
          body = inflateMessage(body);
        } catch (err) {
          note = `cannot inflate permessage-deflate payload: ${err.message}`;
        }
      }
      out.push({
        type: NAME[fragmentOpcode] || `opcode-${fragmentOpcode}`,
        payload: body,
        compressed: fragmentCompressed,
        ...(note ? { note } : {})
      });
      fragmentOpcode = null;
      fragmentCompressed = false;
    }

    return out;
  };
}

// permessage-deflate is negotiated in the handshake. Without this test a capture
// would inflate a payload that was never compressed.
export function negotiatesDeflate(headerValue) {
  return /permessage-deflate/i.test(String(headerValue || ''));
}
