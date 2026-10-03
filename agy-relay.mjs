#!/usr/bin/env node
// Runs agy behind a relay that holds its own loopback port for exactly as long as agy runs.
//
// agy sends its Google token in clear text to CLOUD_CODE_URL. The shim checks the gateway once,
// at launch. A gateway that stops later frees its port, and another program can take it. So agy
// talks only to this relay: for each connection it asks the gateway for its relay proof on the
// socket it will use, and sends agy's bytes only after that proof holds.
//
// Usage: node agy-relay.mjs <gateway-url> <agy> [args...]
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { relayProof } from './state.mjs';
import { gatewayPort, readAnswer, batCommandLine } from './agy-relay-lib.mjs';

// The proof of a live gateway takes milliseconds; a squatter gains nothing from a longer wait.
const PROOF_MS = 3000;
const MAX_PROBE_ANSWER = 64 * 1024;

// The gateway on a new socket: { sock } when it proved itself with the relay key (state.mjs),
// otherwise { old: true } for a gateway built before relayProof, or {} for anything else. Only the
// first case gets agy's bytes, on this same socket, so no other process can answer them.
function provenSocket(port) {
  return new Promise((resolve) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', onFail);
      sock.off('close', onFail);
      if (result.sock) return resolve(result);
      sock.destroy();
      resolve(result);
    };
    const onFail = () => finish({});
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_PROBE_ANSWER) return finish({});
      const answer = readAnswer(buf);
      if (!answer) return;
      // Nothing may follow the probe answer: those bytes would reach agy as its own answer.
      if (answer.status !== 200 || answer.rest.length) return finish({});
      let body;
      try { body = JSON.parse(answer.text); } catch { return finish({}); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return finish({});
      if (body.proxy !== 'llm-switcher' || body.port !== port) return finish({});
      // An absent field, never a falsy one: relayProof '' must still fail the check below.
      if (!Object.hasOwn(body, 'relayProof')) return finish({ old: true });
      const expected = relayProof(nonce, { port, pid: body.pid });
      finish(Boolean(expected) && body.relayProof === expected ? { sock } : {});
    };
    const timer = setTimeout(onFail, PROOF_MS);
    sock.on('data', onData);
    sock.on('error', onFail);
    sock.on('close', onFail);
    sock.write(`GET /health?challenge=${nonce} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`);
  });
}

// agy shows a Code Assist error, and its request stays in this process.
function refusal(message) {
  const body = JSON.stringify({ error: { code: 502, status: 'UNAVAILABLE', message } });
  return `HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}
const NOT_PROVED = 'LLM Switcher: the gateway did not prove its identity, so this request was not sent. Run `switch on`, or `switch off agy`.';
const OLD_GATEWAY = 'LLM Switcher: the running gateway is older than this relay. Restart it: `switch off`, then `switch on`.';

function startRelay(port) {
  // pauseOnConnect: agy's bytes stay unread until the gateway on this connection has proved itself.
  const server = net.createServer({ pauseOnConnect: true }, async (client) => {
    client.on('error', () => client.destroy());
    const { sock: up, old } = await provenSocket(port);
    if (client.destroyed) return up?.destroy();
    if (!up) {
      client.end(refusal(old ? OLD_GATEWAY : NOT_PROVED));
      client.resume(); // read and drop the request; nothing of it leaves this process
      return;
    }
    up.on('error', () => client.destroy());
    client.on('close', () => up.destroy());
    up.on('close', () => client.destroy());
    client.pipe(up);
    up.pipe(client);
    client.resume();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// A .cmd/.bat cannot start without cmd.exe. It is always the one in System32: a bare name would be
// looked up in the current directory first.
function launch(file, args, env) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const line = batCommandLine(file, args);
    if (line.error) {
      console.error(`[llm-switcher] cannot start agy: ${line.error}`);
      process.exit(2);
    }
    const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    return spawn(cmd, line.args, { stdio: 'inherit', env, windowsVerbatimArguments: true });
  }
  return spawn(file, args, { stdio: 'inherit', env });
}

const [gatewayUrl, agy, ...args] = process.argv.slice(2);
if (!agy) {
  console.error('Usage: node agy-relay.mjs <gateway-url> <agy> [args...]');
  process.exit(2);
}
if (args.some(a => a.includes('\0'))) {
  console.error('[llm-switcher] cannot start agy: an argument holds a NUL character.');
  process.exit(2);
}

const env = { ...process.env };
delete env.CLOUD_CODE_URL;
const port = gatewayPort(gatewayUrl);
if (port) {
  const server = await startRelay(port);
  env.CLOUD_CODE_URL = `http://127.0.0.1:${server.address().port}`;
} else {
  console.error(`[llm-switcher] ${String(gatewayUrl)} is not the address of this switcher's gateway; agy uses its official endpoint.`);
}

const child = launch(agy, args, env);
// Ctrl+C reaches agy and this relay together. agy decides what it means; the relay ends with agy.
process.on('SIGINT', () => {});
if (process.platform === 'win32') process.on('SIGBREAK', () => {});
process.on('SIGTERM', () => child.kill());
child.on('error', (err) => {
  console.error(`[llm-switcher] cannot start agy (${agy}): ${err.message}`);
  process.exit(127);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
