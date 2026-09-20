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

// A capture is a diagnostic. Failing to write one must never fail the request.
function writeCapture(record, fileName) {
  if (!CAPTURE_DIR) return;
  try {
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(CAPTURE_DIR, fileName || captureName(record.method, record.url)),
      JSON.stringify(record, null, 2), 'utf8');
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

// The gateway answers only to a loopback Host, so rewrite it. Origin carries the
// intercepted hostname and would fail the same check.
function gatewayHeaders(headers) {
  const out = { ...headers };
  out.host = `${GATEWAY_HOST}:${GATEWAY_PORT}`;
  delete out.origin;
  return out;
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

mitm.on('request', (req, res) => {
  if (!isGatewayPath(req.url)) return passThroughRequest(req, res);

  log('gateway', req.method, req.url);
  const record = recordExchange(req);

  const upstream = http.request({
    host: GATEWAY_HOST,
    port: GATEWAY_PORT,
    method: req.method,
    path: toGatewayPath(req.url),
    headers: gatewayHeaders(req.headers)
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    if (record) record(upRes);
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `gateway unreachable: ${err.message}` } }));
  });
  req.pipe(upstream);
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
  upstream.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`upstream unreachable: ${err.message}`);
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
      const text = f.payload.toString('utf8');
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
    readFromServer = createFrameReader({ inflate });
    readFromClient = createFrameReader({ inflate });
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
    timer = null;
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
  };
  for (const s of [clientSocket, target]) {
    s.on('close', flush);
    s.on('end', flush);
  }
}

// WebSocket upgrades: relay the raw TCP stream once the handshake is written.
mitm.on('upgrade', (req, clientSocket, head) => {
  const toGateway = isGatewayPath(req.url);
  const target = toGateway
    ? net.connect(GATEWAY_PORT, GATEWAY_HOST)
    : tls.connect({ host: TARGET_HOST, port: 443, servername: TARGET_HOST });

  const headers = toGateway ? gatewayHeaders(req.headers) : { ...req.headers, host: TARGET_HOST };
  const requestPath = toGateway ? toGatewayPath(req.url) : req.url;

  target.on(toGateway ? 'connect' : 'secureConnect', () => {
    log('upgrade', toGateway ? 'gateway' : 'passthrough', requestPath);
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

  const close = () => { target.destroy(); clientSocket.destroy(); };
  target.on('error', close);
  clientSocket.on('error', close);
});

mitm.on('tlsClientError', (err) => log('tls client error:', err.message));
mitm.on('clientError', (err, socket) => {
  log('client error:', err.code || err.message);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

// ---------- the HTTP proxy Codex talks to ----------

const proxy = http.createServer((req, res) => {
  // A plain (non-CONNECT) proxy request. Codex uses HTTPS, so this is only a probe.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('llm-switcher blindfold proxy\n');
});

// This listener is a proxy, so anything that reaches it can ask for an arbitrary
// destination. It binds to loopback, but every local process can still use it. Refuse
// a destination that is itself local: without that test it is a way to reach services
// that only listen on the machine, and the cloud metadata address.
const PRIVATE_HOST = /^(localhost$|127\.|0\.0\.0\.0$|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i;

export function isInterceptedHost(host) {
  return host === TARGET_HOST;
}

export function isPrivateDestination(host) {
  return !host || PRIVATE_HOST.test(host);
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

  if (isPrivateDestination(host)) {
    log('refused CONNECT', target);
    clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  tunnel(host, destPort, clientSocket, head);
});

// Any other host keeps its own end-to-end TLS: this process only copies bytes and
// never sees the plaintext.
function tunnel(host, destPort, clientSocket, head) {
  log('tunnel CONNECT', `${host}:${destPort}`);
  const upstream = net.connect(destPort, host, () => {
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
