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
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const log = (...args) => { if (VERBOSE) console.log('[blindfold]', ...args); };

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

mitm.on('request', (req, res) => {
  if (!isGatewayPath(req.url)) return passThroughRequest(req, res);

  log('gateway', req.method, req.url);
  const upstream = http.request({
    host: GATEWAY_HOST,
    port: GATEWAY_PORT,
    method: req.method,
    path: toGatewayPath(req.url),
    headers: gatewayHeaders(req.headers)
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
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
  const upstream = https.request({
    host: TARGET_HOST,
    servername: TARGET_HOST,
    port: 443,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: TARGET_HOST }
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`upstream unreachable: ${err.message}`);
  });
  req.pipe(upstream);
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
    clientSocket.pipe(target).pipe(clientSocket);
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
