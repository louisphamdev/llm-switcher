// A raw WebSocket client for the gateway tests. It sends the handshake headers Codex sends (a
// User-Agent, a profile header), which the WebSocket of Node cannot set.
import net from 'node:net';
import crypto from 'node:crypto';
import { createFrameReader } from '../blindfold/wsframe.mjs';

// One masked client frame, as RFC 6455 requires from a client.
export function clientFrame(opcode, payload) {
  const data = Buffer.from(payload);
  const len = data.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 0xff])
      : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  const mask = crypto.randomBytes(4);
  return Buffer.concat([head, mask, Buffer.from(data.map((b, i) => b ^ mask[i & 3]))]);
}

// Opens /v1/responses on the gateway. `messages` collects every JSON text frame the gateway sends.
export function openResponsesWs(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    socket.write(`GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n${extra}\r\n`);
    let head = Buffer.alloc(0);
    const read = createFrameReader();
    const messages = [];
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      const collect = (c) => { for (const f of read(c)) if (f.type === 'text') messages.push(JSON.parse(f.payload.toString())); };
      socket.on('data', collect);
      const rest = head.subarray(end + 4);
      if (rest.length) collect(rest);
      resolve({
        reply: head.subarray(0, end).toString(),
        messages,
        send: (obj) => socket.write(clientFrame(1, JSON.stringify(obj))),
        close: () => socket.destroy()
      });
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}
