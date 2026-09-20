// Tests for blindfold/blindfold.mjs — the routing decision of a TLS-intercepting proxy.
//
// Real-world failure (2026-09-20, adversarial review): the first version decided with a
// bare `startsWith(API_PREFIX)` on the raw request target. Node does not normalize a
// request target, but the gateway does (`new URL(...).pathname`). So
// `/backend-api/codex/%2e%2e/api/logs` passed the prefix test, was forwarded as
// `/v1/%2e%2e/api/logs`, and the gateway resolved it to `/api/logs`. The forwarded
// headers also forge a loopback Host, which satisfies the admin API's only guard.
// One request through the proxy could read the provider API key.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isGatewayPath, toGatewayPath, isInterceptedHost, isPrivateDestination,
  API_PREFIX, GATEWAY_PREFIX
} from '../blindfold/blindfold.mjs';

test('a dot-segment escape never reaches the gateway', () => {
  for (const attack of [
    '/backend-api/codex/%2e%2e/api/logs',
    '/backend-api/codex/../api/logs',
    '/backend-api/codex/%2E%2E/%2e%2e/api/fetch-models',
    '/backend-api/codex/a/../../api/save-profile'
  ]) {
    assert.equal(isGatewayPath(attack), false, `must not route: ${attack}`);
  }
});

test('a path that only shares the prefix string is passed through', () => {
  assert.equal(isGatewayPath('/backend-api/codex-usage'), false);
  assert.equal(isGatewayPath('/backend-api/codexfoo'), false);
  assert.equal(isGatewayPath('/backend-api/codex_settings'), false);
});

test('a real Codex API path is routed, and its query string survives', () => {
  assert.equal(isGatewayPath('/backend-api/codex/responses'), true);
  assert.equal(isGatewayPath(API_PREFIX), true);
  assert.equal(toGatewayPath('/backend-api/codex/x?y=1&z=2'), `${GATEWAY_PREFIX}/x?y=1&z=2`);
  assert.equal(toGatewayPath('/backend-api/codex/responses'), `${GATEWAY_PREFIX}/responses`);
});

// A CONNECT to any other host must be tunneled, not intercepted: the process then
// only copies bytes and never holds that host's plaintext.
test('only the target host is intercepted; every other public host is tunneled', () => {
  assert.equal(isInterceptedHost('chatgpt.com'), true);
  for (const other of ['api.openai.com', 'auth.openai.com', 'example.com', 'chatgpt.com.evil.test']) {
    assert.equal(isInterceptedHost(other), false, `must not intercept ${other}`);
    assert.equal(isPrivateDestination(other), false, `must tunnel ${other}`);
  }
});

// The listener is a proxy on loopback, so every local process can ask it for a
// destination. A local destination would turn it into a way to reach a service that
// listens only on this machine.
test('a local or private destination is refused', () => {
  for (const local of [
    'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]',
    '10.0.0.5', '192.168.1.10', '172.16.0.1', '172.31.255.254', '169.254.169.254', ''
  ]) {
    assert.equal(isPrivateDestination(local), true, `must refuse ${local || '(empty)'}`);
  }
  // A public address that only looks similar stays allowed.
  for (const publicHost of ['172.32.0.1', '11.0.0.1', '193.168.1.10']) {
    assert.equal(isPrivateDestination(publicHost), false, `must not refuse ${publicHost}`);
  }
});

test('a malformed target is refused rather than guessed', () => {
  for (const bad of ['', null, undefined, 'http://evil.example/backend-api/codex/responses']) {
    assert.equal(isGatewayPath(bad), false, `must not route: ${String(bad)}`);
  }
});
