#!/usr/bin/env node
// Exits 0 only when the gateway named by a CLOUD_CODE_URL proves that it is this switcher.
//
// agy sends its Google token in clear text to CLOUD_CODE_URL, so the agy shim runs this before it
// hands the variable over. Any doubt fails closed: then agy keeps its official endpoint.
//
// Usage: node verify-gateway.mjs <url>
import { probeGateway } from './state.mjs';

// A probe that hangs must never hold agy at its start.
const LIMIT_MS = 3000;
setTimeout(() => {
  process.stdout.write('timeout');
  process.exit(1);
}, LIMIT_MS).unref();

async function check(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'invalid'; }
  // The switcher writes 127.0.0.1 only. localhost can resolve to ::1, which the probe never asks.
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') return 'not-the-switcher-address';
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'no-port';
  return probeGateway(port);
}

check(process.argv[2])
  .then((state) => {
    process.stdout.write(String(state));
    process.exit(state === 'ours' ? 0 : 1);
  })
  .catch(() => {
    process.stdout.write('error');
    process.exit(1);
  });
