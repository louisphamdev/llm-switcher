// Minimal RFC 6455 frame reader. The blindfold capture reads a copy of the relayed bytes with it,
// and the gateway reads the Codex WS transport with it.
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
//
// A message larger than maxMessage yields one {type:'error'} item, decided from the frame
// header before the body is buffered. After an error the reader returns nothing more.
export function createFrameReader({ inflate = false, maxMessage = Infinity } = {}) {
  // Chunks are joined once, when enough bytes are present: joining on every chunk copies a
  // large frame again for each chunk that carries it.
  let pending = [];
  let pendingBytes = 0;
  let needed = 2;
  let failed = false;
  let fragments = [];
  let fragmentBytes = 0;
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
    const opts = { finishFlush: zlib.constants.Z_SYNC_FLUSH, ...(Number.isFinite(maxMessage) ? { maxOutputLength: maxMessage } : {}) };
    if (history.length) opts.dictionary = history.subarray(Math.max(0, history.length - WINDOW));
    const out = zlib.inflateRawSync(Buffer.concat([payload, TAIL]), opts);
    history = Buffer.concat([history, out]);
    if (history.length > WINDOW) history = history.subarray(history.length - WINDOW);
    return out;
  };

  return function push(chunk) {
    if (failed) return [];
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (pendingBytes < needed) return [];
    let buffer = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
    const out = [];
    const fail = (reason) => {
      failed = true;
      pending = [];
      pendingBytes = 0;
      out.push({ type: 'error', reason });
      return out;
    };

    for (;;) {
      needed = 2;
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
        needed = offset + 2;
        if (buffer.length < needed) break;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        needed = offset + 8;
        if (buffer.length < needed) break;
        const big = buffer.readBigUInt64BE(offset);
        // A frame larger than 2^53 cannot be indexed by a JS number. Nothing sends
        // one; refusing is safer than truncating the length in silence.
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return fail('frame length exceeds Number.MAX_SAFE_INTEGER');
        length = Number(big);
        offset += 8;
      }
      const messageBytes = opcode === OPCODE.continuation ? fragmentBytes + length : length;
      if (messageBytes > maxMessage) return fail(`message exceeds ${maxMessage} bytes`);

      let maskKey = null;
      if (masked) {
        needed = offset + 4;
        if (buffer.length < needed) break;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      needed = offset + length;
      if (buffer.length < needed) break;

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
        fragmentBytes = 0;
      }
      fragments.push(payload);
      fragmentBytes += payload.length;

      if (!fin) continue;

      let body = Buffer.concat(fragments);
      fragments = [];
      fragmentBytes = 0;
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

    pending = buffer.length ? [buffer] : [];
    pendingBytes = buffer.length;
    return out;
  };
}

// permessage-deflate is negotiated in the handshake. Without this test a capture
// would inflate a payload that was never compressed.
export function negotiatesDeflate(headerValue) {
  return /permessage-deflate/i.test(String(headerValue || ''));
}
