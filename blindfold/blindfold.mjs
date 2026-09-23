// ============================================================
// blindfold.mjs — make Codex reach the gateway without knowing the gateway exists
//
// PROBLEM
//   Routing Codex with `--config openai_base_url=...` works, but the CLI then prints
//   "base URL is overridden to <url>. Selecting models may not be supported or work
//   properly." on its own /model screen. No config key hides that line, because the
//   line exists to report exactly the thing we are doing.
//
// FIX
//   Leave the CLI on its official endpoint and intercept one hop lower. Codex honours
//   HTTPS_PROXY, so it sends `CONNECT chatgpt.com:443` here. This process answers that
//   CONNECT itself, terminates TLS with a leaf certificate for that host, and forwards
//   the Codex API calls to the local gateway. Its config.toml stays untouched.
//
// WHY NO SYSTEM CHANGE IS NEEDED
//   Codex reads a custom CA from the CODEX_CA_CERTIFICATE environment variable, so the
//   private CA never enters a system trust store, and no hosts file is edited. Stopping
//   this process restores normal behaviour with nothing left behind.
//
// SCOPE OF THE INTERCEPT
//   Only requests to the target host whose path starts with the Codex API prefix go to
//   the gateway. Every other path on that host, and every other host, is passed through
//   untouched — sign-in, token refresh and usage pages keep working.
// ============================================================

import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFrameReader, negotiatesDeflate } from './wsframe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// An option value that starts with "--" is the next flag, not this flag's value.
// Without that test, `--host --verbose` silently sets the target host to "--verbose"
// and nothing is ever intercepted.
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i !== -1 ? process.argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : fallback;
}

function port(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

const LISTEN_PORT = port(arg('port', process.env.LLM_SWITCHER_BLINDFOLD_PORT), 3457);
const GATEWAY_HOST = arg('gateway-host', '127.0.0.1');
const GATEWAY_PORT = port(arg('gateway-port', process.env.LLM_SWITCHER_PORT), 3456);
const TARGET_HOST = arg('host', 'chatgpt.com');
// Codex with ChatGPT auth calls https://chatgpt.com/backend-api/codex/<endpoint>;
// the gateway serves the same endpoints under /v1.
export const API_PREFIX = arg('prefix', '/backend-api/codex');
export const GATEWAY_PREFIX = arg('gateway-prefix', '/v1');
const CERT_DIR = arg('certs', path.join(HERE, 'certs'));
const VERBOSE = process.argv.includes('--verbose');
const CAPTURE_DIR = arg('capture', null);
// The switcher's admin.token. The identity probe answers HMAC(token, nonce) with it.
const TOKEN_FILE = arg('token-file', path.join(HERE, '..', 'admin.token'));

const log = (...args) => { if (VERBOSE) console.log('[blindfold]', ...args); };

// A capture file records what a genuine client sends on the wire. It must never
// record how that client authenticates, so these header values are replaced while
// the header names stay, keeping the shape of the request visible.
// Account identifiers are not credentials, but a capture is meant to be readable
// and shareable, and these name the person the traffic belongs to.
const SECRET_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key',
  'chatgpt-account-id', 'openai-organization', 'x-goog-user-project'
]);

export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? '<redacted>' : v;
  }
  return out;
}

export function captureName(method, url, now = Date.now()) {
  const safe = String(url || '/').split('?')[0].replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${now}-${String(method || 'GET').toUpperCase()}-${safe || 'root'}.json`;
}

const CAPTURE_LIMIT = 200000;
// The capture decodes a copy of each WS message. A larger message is not recorded; the relay
// itself still forwards every byte.
const CAPTURE_MAX_MESSAGE = 64 * 1024 * 1024;
// Captures that wait for their quiet period. A SIGTERM writes them before the process exits.
const pendingFlushes = new Set();
const clip = (s) => (s.length > CAPTURE_LIMIT ? s.slice(0, CAPTURE_LIMIT) + '...[truncated]' : s);

// A client asks for gzip, so the bytes on the wire are compressed. Reading them as
// UTF-8 yields binary noise, which is what a capture recorded before this existed.
// The proxy forwards the compressed bytes untouched; only the copy is decoded.
const DECODERS = {
  gzip: zlib.gunzipSync,
  'x-gzip': zlib.gunzipSync,
  br: zlib.brotliDecompressSync,
  deflate: zlib.inflateSync,
  zstd: zlib.zstdDecompressSync
};

export function decodeBody(buffer, contentEncoding) {
  const name = String(contentEncoding || '').trim().toLowerCase();
  const decode = DECODERS[name];
  if (!decode) return buffer.toString('utf8');
  try {
    return decode(buffer).toString('utf8');
  } catch (err) {
    // An aborted or truncated stream cannot be decoded. Say so in the file rather
    // than writing noise that reads like a malformed response from the provider.
    return `[capture: cannot decode ${name} body of ${buffer.length} bytes: ${err.message}]`;
  }
}

// A capture holds full prompts and answers, so the directory is 0700 and each file 0600. A
// directory that another account owns is refused: it could read the files or plant symlinks.
const refusedCaptureDirs = new Set();

export function writeCaptureFile(dir, fileName, record, { uid = process.getuid?.() } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // lstat: a symlink planted at the capture path would otherwise pass the owner test for its target.
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) {
    if (!refusedCaptureDirs.has(dir)) {
      refusedCaptureDirs.add(dir);
      console.error(`[blindfold] capture refused: ${dir} is a symlink or is owned by another account. Nothing is recorded.`);
    }
    return false;
  }
  fs.chmodSync(dir, 0o700);
  // tmp + rename: a kill mid-write keeps the previous complete file, and the rename replaces a
  // planted symlink instead of writing through it.
  const file = path.join(dir, fileName);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  return true;
}

// A capture is a diagnostic. Failing to write one must never fail the request.
function writeCapture(record, fileName) {
  if (!CAPTURE_DIR) return;
  try {
    writeCaptureFile(CAPTURE_DIR, fileName || captureName(record.method, record.url), record);
  } catch (err) {
    log('capture failed:', err.message);
  }
}

// Decide on the NORMALIZED path, never on the raw request target.
//
// Node hands over the target exactly as the client wrote it, but the gateway resolves
// it with `new URL(...)`. A raw-target test therefore accepts a string the gateway
// later reads as a different path: `/backend-api/codex/%2e%2e/api/logs` becomes
// `/api/logs`, which is the gateway's admin API. The forwarded headers forge a
// loopback Host, so the admin API's only guard is satisfied by construction.
//
// A segment boundary is required as well, otherwise `/backend-api/codex-usage`
// (a real ChatGPT path) is stolen from the host it belongs to.
function normalizedTarget(url) {
  if (typeof url !== 'string' || !url.startsWith('/')) return null;
  try {
    return new URL(url, 'http://blindfold.invalid');
  } catch {
    return null;
  }
}

export function isGatewayPath(url) {
  const parsed = normalizedTarget(url);
  if (!parsed) return false;
  const p = parsed.pathname;
  return p === API_PREFIX || p.startsWith(`${API_PREFIX}/`);
}

export function toGatewayPath(url) {
  const parsed = normalizedTarget(url);
  if (!parsed) return null;
  // The query string must survive: the gateway reads it.
  return GATEWAY_PREFIX + parsed.pathname.slice(API_PREFIX.length) + parsed.search;
}

// Codex's ChatGPT credentials. The gateway never reads them, and the gateway port is plain
// HTTP that another local account can hold once it is free, so they stay on this side.
const GATEWAY_STRIPPED = ['authorization', 'proxy-authorization', 'cookie', 'chatgpt-account-id', 'openai-organization'];

// The gateway answers only to a loopback Host, so rewrite it. Origin carries the
// intercepted hostname and would fail the same check.
export function gatewayHeaders(headers, { host = GATEWAY_HOST, port = GATEWAY_PORT } = {}) {
  const out = { ...headers };
  out.host = `${host}:${port}`;
  delete out.origin;
  for (const name of GATEWAY_STRIPPED) delete out[name];
  return out;
}

// A relay holds two connections. When one side fails or leaves early, end the other:
// otherwise the client waits forever, or the upstream keeps streaming (and spending).
function bindExchange(res, upstream) {
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  upstream.on('response', (upRes) => {
    upRes.on('error', () => res.destroy());
    upRes.on('close', () => { if (!upRes.complete) res.destroy(); });
  });
}

function failExchange(res, status, contentType, body) {
  if (res.destroyed) return;
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

// A stalled peer must not hold a socket open for the life of the process.
const IDLE_TIMEOUT_MS = 120000;

function armTimeout(socket, onTimeout) {
  socket.setTimeout(IDLE_TIMEOUT_MS, onTimeout);
}

// ---------- the TLS endpoint that pretends to be TARGET_HOST ----------

const mitm = https.createServer();

// Collect a copy for the capture file while the bytes keep flowing. Buffering to
// write the file first would hold back a streamed response. Both routes record,
// because on a host with no gateway prefix every exchange is a passthrough and a
// capture that skipped them would always be empty.
function recordExchange(req) {
  if (!CAPTURE_DIR) return null;
  const reqChunks = [];
  req.on('data', (c) => reqChunks.push(c));
  return (upRes) => {
    const resChunks = [];
    upRes.on('data', (c) => resChunks.push(c));
    upRes.on('end', () => writeCapture({
      method: req.method,
      url: req.url,
      requestHeaders: redactHeaders(req.headers),
      requestBody: clip(decodeBody(Buffer.concat(reqChunks), req.headers['content-encoding'])),
      status: upRes.statusCode,
      responseHeaders: redactHeaders(upRes.headers),
      responseBody: clip(decodeBody(Buffer.concat(resChunks), upRes.headers['content-encoding']))
    }));
  };
}

export function relayToGateway(req, res, { host = GATEWAY_HOST, port = GATEWAY_PORT } = {}) {
  log('gateway', req.method, req.url);
  const record = recordExchange(req);

  const upstream = http.request({
    host,
    port,
    method: req.method,
    path: toGatewayPath(req.url),
    headers: gatewayHeaders(req.headers, { host, port })
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    if (record) record(upRes);
    upRes.pipe(res);
  });
  bindExchange(res, upstream);
  upstream.on('error', (err) => {
    failExchange(res, 502, 'application/json', JSON.stringify({ error: { message: `gateway unreachable: ${err.message}` } }));
  });
  req.pipe(upstream);
}

mitm.on('request', (req, res) => {
  if (!isGatewayPath(req.url)) return passThroughRequest(req, res);
  relayToGateway(req, res);
});

// Everything that is not a Codex API call goes to the real host, so sign-in and
// usage pages behave exactly as they do without this process.
function passThroughRequest(req, res) {
  log('passthrough', req.method, req.url);
  const record = recordExchange(req);
  const upstream = https.request({
    host: TARGET_HOST,
    servername: TARGET_HOST,
    port: 443,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: TARGET_HOST }
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    if (record) record(upRes);
    upRes.pipe(res);
  });
  bindExchange(res, upstream);
  upstream.on('error', (err) => {
    failExchange(res, 502, 'text/plain', `upstream unreachable: ${err.message}`);
  });
  req.pipe(upstream);
}

// Relay a WebSocket and record the messages that cross it.
//
// A Codex completion is a WebSocket, not an HTTP POST, so without this the capture
// of the one call that matters holds the handshake and nothing else. Every byte is
// still forwarded unchanged; the frame reader works on a copy.
function captureUpgrade(req, clientSocket, target) {
  log('ws capture started for', req.url);
  const messages = [];
  const name = captureName(req.method, req.url);
  let handshake = Buffer.alloc(0);
  let readFromClient = null;
  let readFromServer = null;
  let written = 0;

  const collect = (from, frames) => {
    for (const f of frames) {
      if (written >= CAPTURE_LIMIT) return;
      // An error item has no payload, and its reader decodes nothing more from this side.
      const text = f.payload ? f.payload.toString('utf8') : '';
      written += text.length;
      messages.push({ from, type: f.type, ...(f.compressed ? { compressed: true } : {}),
        ...(f.note ? { note: f.note } : {}), ...(f.reason ? { reason: f.reason } : {}),
        payload: clip(text) });
    }
    if (frames.length) scheduleFlush();
  };
  let scheduleFlush = () => {};

  // Backpressure: a plain write() loses what pipe() gives for free, and a slow peer
  // would then grow an unbounded buffer inside this process.
  target.on('drain', () => clientSocket.resume());
  clientSocket.on('drain', () => target.resume());

  target.on('data', (chunk) => {
    if (!clientSocket.write(chunk)) target.pause();
    if (readFromServer) return collect('server', readFromServer(chunk));

    // The 101 response has to be parsed before any frame: it names the extension,
    // and inflating a payload that was never compressed produces noise.
    handshake = Buffer.concat([handshake, chunk]);
    const end = handshake.indexOf('\r\n\r\n');
    if (end === -1) return;
    const text = handshake.subarray(0, end).toString('latin1');
    const inflate = negotiatesDeflate(/^sec-websocket-extensions:(.*)$/im.exec(text)?.[1]);
    readFromServer = createFrameReader({ inflate, maxMessage: CAPTURE_MAX_MESSAGE });
    readFromClient = createFrameReader({ inflate, maxMessage: CAPTURE_MAX_MESSAGE });
    const rest = handshake.subarray(end + 4);
    if (rest.length) collect('server', readFromServer(rest));
  });

  clientSocket.on('data', (chunk) => {
    if (!target.write(chunk)) clientSocket.pause();
    if (readFromClient) collect('client', readFromClient(chunk));
  });

  // Do not wait for 'close' to write the file. A WebSocket stays open, and when the
  // client process exits the socket can be collected without ever emitting 'close',
  // so a capture that only wrote on close wrote nothing at all. Flush shortly after
  // the traffic goes quiet instead, and keep flushing as more messages arrive.
  let timer = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pendingFlushes.delete(flush);
    writeCapture({
      method: req.method,
      url: req.url,
      protocol: 'websocket',
      requestHeaders: redactHeaders(req.headers),
      messageCount: messages.length,
      messages
    }, name);
  };
  scheduleFlush = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 800);
    timer.unref?.();
    pendingFlushes.add(flush);
  };
  for (const s of [clientSocket, target]) {
    s.on('close', flush);
    s.on('end', flush);
  }
}

// WebSocket upgrades: relay the raw TCP stream once the handshake is written.
function relayUpgrade(req, clientSocket, head, target, readyEvent, headers, requestPath, route) {
  let ready = false;
  target.on(readyEvent, () => {
    ready = true;
    log('upgrade', route, requestPath);
    const lines = [`${req.method} ${requestPath} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    target.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) target.write(head);
    if (!CAPTURE_DIR) {
      clientSocket.pipe(target).pipe(clientSocket);
      return;
    }
    captureUpgrade(req, clientSocket, target);
  });

  // Either side closing ends the other, in capture mode too, where no pipe carries it. end() lets the
  // last buffered frames (a close frame, for one) reach the peer; destroy follows if it never closes.
  const finish = (s) => { s.end(); setTimeout(() => s.destroy(), 5000).unref(); };
  target.on('close', () => finish(clientSocket));
  clientSocket.on('close', () => finish(target));
  target.on('error', (err) => {
    log('upgrade', route, 'failed:', err.code || err.message);
    if (!ready && clientSocket.writable) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    else clientSocket.destroy();
  });
  clientSocket.on('error', () => target.destroy());
}

export function relayUpgradeToGateway(req, clientSocket, head, { host = GATEWAY_HOST, port = GATEWAY_PORT } = {}) {
  relayUpgrade(req, clientSocket, head, net.connect(port, host), 'connect',
    gatewayHeaders(req.headers, { host, port }), toGatewayPath(req.url), 'gateway');
}

mitm.on('upgrade', (req, clientSocket, head) => {
  if (isGatewayPath(req.url)) return relayUpgradeToGateway(req, clientSocket, head);
  relayUpgrade(req, clientSocket, head, tls.connect({ host: TARGET_HOST, port: 443, servername: TARGET_HOST }),
    'secureConnect', { ...req.headers, host: TARGET_HOST }, req.url, 'passthrough');
});

mitm.on('tlsClientError', (err) => log('tls client error:', err.message));
mitm.on('clientError', (err, socket) => {
  log('client error:', err.code || err.message);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

// ---------- the HTTP proxy Codex talks to ----------

// A plain (non-CONNECT) request is a probe. With ?challenge=<nonce> it proves identity: only a
// process that reads admin.token can answer HMAC(token, nonce), and it names the arguments it runs with.
export function identityAnswer(url) {
  const challenge = new URL(url || '/', 'http://blindfold.invalid').searchParams.get('challenge');
  if (!challenge) return null;
  const fields = { role: 'blindfold', port: LISTEN_PORT, pid: process.pid, gatewayPort: GATEWAY_PORT, host: TARGET_HOST, prefix: API_PREFIX };
  let proof = '';
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    // Same fields and order as identityProof in state.mjs.
    const msg = [fields.role, fields.port, fields.pid, fields.gatewayPort, fields.host, fields.prefix, challenge].join('|');
    if (token) proof = crypto.createHmac('sha256', token).update(msg).digest('hex');
  } catch {}
  return { proxy: 'llm-switcher-blindfold', proof, ...fields };
}

const proxy = http.createServer((req, res) => {
  const identity = identityAnswer(req.url);
  if (identity) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(identity));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('llm-switcher blindfold proxy\n');
});

// This listener is a proxy, so anything that reaches it can ask for an arbitrary
// destination. It binds to loopback, but every local process can still use it. Refuse
// a destination that is itself local: without that test it is a way to reach services
// that only listen on the machine, and the cloud metadata address.
// Addresses this proxy never tunnels to: loopback, unspecified, private, link-local and shared address
// space (cloud metadata services live in both), benchmark and IETF blocks, and unique-local IPv6.
// BlockList also matches IPv4-mapped IPv6 forms.
const LOCAL_RANGES = new net.BlockList();
for (const [prefix, bits] of [['0.0.0.0', 8], ['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['169.254.0.0', 16], ['100.64.0.0', 10], ['198.18.0.0', 15], ['192.0.0.0', 24]]) {
  LOCAL_RANGES.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]]) {
  LOCAL_RANGES.addSubnet(prefix, bits, 'ipv6');
}

export function isInterceptedHost(host) {
  return host === TARGET_HOST;
}

// Decides on an address, never on a spelling: `0`, `2130706433`, `127.1` and names such as
// localtest.me all resolve to loopback. Something that is not an address counts as local.
export function isLocalAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return true;
  if (LOCAL_RANGES.check(address, family === 6 ? 'ipv6' : 'ipv4')) return true;
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address; decide on that one. Both also carry
  // public addresses, so the whole prefix cannot be refused.
  if (family === 6) {
    const b = ipv6Bytes(address);
    const nat64 = b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every(x => x === 0);
    const inner = nat64 ? b.slice(12) : b[0] === 0x20 && b[1] === 0x02 ? b.slice(2, 6) : null;
    if (inner) return isLocalAddress(inner.join('.'));
  }
  return false;
}

function ipv6Bytes(address) {
  let text = address.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) text = `${text.slice(0, -dotted[1].length)}0:0`;
  const [head, rest] = text.split('::');
  const h = head ? head.split(':') : [];
  const r = rest === undefined ? null : rest ? rest.split(':') : [];
  const groups = r === null ? h : [...h, ...Array(8 - h.length - r.length).fill('0'), ...r];
  const bytes = groups.flatMap(g => { const n = parseInt(g || '0', 16); return [n >> 8, n & 0xff]; });
  if (dotted) bytes.splice(12, 4, ...dotted[1].split('.').map(Number));
  return bytes;
}

// Resolve once and connect to the address that was checked: a second lookup could answer with
// a local address (DNS rebinding). Every answer must be public, not only the first.
export async function checkDestination(host, { lookup = dns.lookup } = {}) {
  const bare = String(host || '').replace(/^\[(.*)\]$/, '$1');
  if (!bare) return { refused: 'no host' };
  let answers;
  try {
    answers = await lookup(bare, { all: true, verbatim: true });
  } catch (err) {
    return { refused: `cannot resolve: ${err.code || err.message}`, status: 502 };
  }
  const local = answers.find(a => isLocalAddress(a.address));
  if (!answers.length || local) return { refused: `resolves to local address ${local?.address || '(none)'}` };
  return { address: answers[0].address };
}

// Refusals are printed without --verbose, once per host: a VPN or split DNS can resolve a
// public name to a private address, and the user must be able to see why it fails.
const reportedRefusals = new Set();
function reportRefusal(target, reason) {
  log('refused CONNECT', target, reason);
  if (reportedRefusals.has(target) || reportedRefusals.size > 1000) return;
  reportedRefusals.add(target);
  console.error(`[blindfold] refused CONNECT ${target}: ${reason}`);
}

proxy.on('connect', (req, clientSocket, head) => {
  const target = String(req.url || '');
  const sep = target.lastIndexOf(':');
  const host = sep > 0 ? target.slice(0, sep) : target;
  const destPort = port(target.slice(sep + 1), 443);

  if (isInterceptedHost(host)) {
    log('intercept CONNECT', target);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) clientSocket.unshift(head);
    // Hand the raw socket to the TLS endpoint: it completes the handshake with our leaf.
    return mitm.emit('connection', clientSocket);
  }

  // The lookup is asynchronous: the socket can fail before the answer arrives.
  clientSocket.on('error', () => clientSocket.destroy());
  checkDestination(host).then(({ address, refused, status = 403 }) => {
    if (clientSocket.destroyed) return;
    if (refused) {
      reportRefusal(target, refused);
      clientSocket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
      return;
    }
    tunnel(address, destPort, clientSocket, head, target);
  });
});

// Any other host keeps its own end-to-end TLS: this process only copies bytes and
// never sees the plaintext.
function tunnel(address, destPort, clientSocket, head, target) {
  log('tunnel CONNECT', target, '->', address);
  const upstream = net.connect(destPort, address, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    clientSocket.pipe(upstream).pipe(clientSocket);
  });
  const close = () => { upstream.destroy(); clientSocket.destroy(); };
  armTimeout(upstream, close);
  armTimeout(clientSocket, close);
  upstream.on('error', () => {
    try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
    close();
  });
  clientSocket.on('error', close);
}

// Only a bind failure is fatal. A later server error must not be reported as one.
let listening = false;
proxy.on('error', (err) => {
  if (listening) return console.error(`[blindfold] proxy error: ${err.message}`);
  console.error(`[blindfold] cannot listen on ${LISTEN_PORT}: ${err.message}`);
  process.exit(1);
});

export function start() {
  try {
    const context = {
      key: fs.readFileSync(path.join(CERT_DIR, 'leaf.key')),
      cert: fs.readFileSync(path.join(CERT_DIR, 'leaf.pem'))
    };
    mitm.setSecureContext(context);
  } catch (err) {
    console.error(`[blindfold] cannot read the leaf certificate in ${CERT_DIR}: ${err.message}`);
    console.error('[blindfold] run blindfold/make-certs.sh first');
    process.exit(1);
  }

  if (CAPTURE_DIR) {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, () => {
        for (const flush of [...pendingFlushes]) flush();
        process.exit(0);
      });
    }
  }

  proxy.listen(LISTEN_PORT, '127.0.0.1', () => {
    listening = true;
    console.log(`[blindfold] proxy on http://127.0.0.1:${LISTEN_PORT}`);
    console.log(`[blindfold] ${TARGET_HOST}${API_PREFIX}/* -> http://${GATEWAY_HOST}:${GATEWAY_PORT}${GATEWAY_PREFIX}/*`);
    console.log(`[blindfold] every other path on ${TARGET_HOST} is re-originated to the real host`);
    console.log('[blindfold] every other public host is tunneled; local destinations are refused');
  });
}

// Importing this module (tests) must not open a socket.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
