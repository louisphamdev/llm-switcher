import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GOAL_CHECK_DEFAULTS,
  goalCheckPolicy,
  validateGoalCheckPatch,
  redactGoalCheck,
  isGoalEvaluatorRequest,
  extractStoppingCondition,
  buildBoundedEvidence,
  buildJevQuestions,
  combineVerdicts,
  parseEvaluatorVerdict,
  redactSecrets
} from '../goalcheck.mjs';

import {
  resolveJevTarget,
  extractScoreFromAnswer
} from '../goalcheck-call.mjs';

test('goalcheck: policy defaults and bounded values', () => {
  const p = goalCheckPolicy({});
  assert.equal(p.enabled, false);
  assert.equal(p.backend, 'jev');
  assert.equal(p.model, 'typesafe/jev-latest');
  assert.equal(p.completeMin, 0.90);
  assert.equal(p.evidenceMin, 0.85);
  assert.equal(p.unfinishedMax, 0.10);
  assert.equal(p.timeoutMs, 8000);
  assert.equal(p.totalTimeoutMs, 25000);
  assert.equal(p.maxStateChars, 60000);

  // Clamping
  const clamped = goalCheckPolicy({
    goalCheck: {
      completeMin: 1.5,
      evidenceMin: -0.2,
      unfinishedMax: 2.0,
      timeoutMs: 100, // min 500
      totalTimeoutMs: 200000, // max 120000
      maxStateChars: 100 // min 500
    }
  });
  assert.equal(clamped.completeMin, 1.0);
  assert.equal(clamped.evidenceMin, 0.0);
  assert.equal(clamped.unfinishedMax, 1.0);
  assert.equal(clamped.timeoutMs, 500);
  assert.equal(clamped.totalTimeoutMs, 120000);
  assert.equal(clamped.maxStateChars, 500);
});

test('goalcheck: patch validation', () => {
  assert.match(validateGoalCheckPatch(null), /must be an object/);
  assert.match(validateGoalCheckPatch({ unknownField: true }), /unknown goal check field/);
  assert.match(validateGoalCheckPatch({ enabled: 'yes' }), /enabled must be a boolean/);
  assert.match(validateGoalCheckPatch({ completeMin: 1.2 }), /completeMin must be a number from 0 to 1/);
  assert.match(validateGoalCheckPatch({ completeMin: -0.1 }), /completeMin must be a number from 0 to 1/);
  assert.match(validateGoalCheckPatch({ timeoutMs: 100 }), /timeoutMs must be an integer from 500 to 60000/);
  assert.match(validateGoalCheckPatch({ baseURL: 'ftp://bad' }), /baseURL must start with http/);

  // While disabled, empty model or url is allowed
  assert.equal(validateGoalCheckPatch({ enabled: false, model: '' }), '');

  // Enabling without model is rejected
  assert.match(validateGoalCheckPatch({ enabled: true, model: '' }), /model cannot be empty/);

  // Valid patch
  assert.equal(validateGoalCheckPatch({
    enabled: true,
    model: 'typesafe/jev-latest',
    baseURL: 'https://api.example.com/v1',
    completeMin: 0.88
  }), '');
});

test('goalcheck: redaction', () => {
  const policy = { enabled: true, apiKey: 'secret-key-123', model: 'typesafe/jev-latest' };
  const redacted = redactGoalCheck(policy);
  assert.equal(redacted.apiKey, '__LLM_SWITCHER_KEEP_KEY__');
  assert.equal(redacted.hasApiKey, true);

  const noKey = redactGoalCheck({ enabled: false, apiKey: '' });
  assert.equal(noKey.apiKey, '');
  assert.equal(noKey.hasApiKey, false);
});

test('goalcheck: evaluator request detection', () => {
  const validEvaluatorPayload = {
    system: 'You are evaluating a stop-condition hook in Claude Code. Read the conversation transcript carefully...',
    messages: [
      { role: 'user', content: 'Fix the bug in auth.js' },
      { role: 'assistant', content: 'Fixed in commit 123' },
      {
        role: 'user',
        content: 'Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.\n\nCondition: Fix the bug in auth.js'
      }
    ],
    tools: []
  };

  const res = isGoalEvaluatorRequest('anthropic', validEvaluatorPayload, { 'user-agent': 'claude-cli/2.1.295' });
  assert.equal(res.isEvaluator, true);
  assert.equal(res.isSupported, true);
  assert.equal(res.condition, 'Fix the bug in auth.js');

  // Normal request without stop-hook system prompt
  const normalPayload = {
    system: 'You are Claude, a helpful AI assistant.',
    messages: [{ role: 'user', content: 'What is the goal of AI?' }]
  };
  assert.deepEqual(isGoalEvaluatorRequest('anthropic', normalPayload), { isEvaluator: false, isSupported: false });

  // Non-anthropic client
  assert.deepEqual(isGoalEvaluatorRequest('responses', validEvaluatorPayload), { isEvaluator: false, isSupported: false });

  // Evaluator template but with execution tools -> recognized but unsupported shape
  const toolPayload = { ...validEvaluatorPayload, tools: [{ name: 'bash', description: 'run' }] };
  const toolRes = isGoalEvaluatorRequest('anthropic', toolPayload);
  assert.equal(toolRes.isEvaluator, true);
  assert.equal(toolRes.isSupported, false);
});

test('goalcheck: extract stopping condition', () => {
  const payload = {
    messages: [
      { role: 'user', content: 'Earlier chat' },
      { role: 'user', content: 'Based on transcript...\n\nCondition: Ensure all unit tests pass with 0 failures.' }
    ]
  };
  assert.equal(extractStoppingCondition(payload), 'Ensure all unit tests pass with 0 failures.');
});

test('goalcheck: bounded evidence building and secret redaction', () => {
  const payload = {
    messages: [
      { role: 'user', content: 'Please deploy using key sk-1234567890abcdef1234' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running test suite' },
          { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'npm test' } }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'Pass: 167 tests', is_error: false }
        ]
      },
      {
        role: 'user',
        content: 'Based on transcript...\n\nCondition: Tests must pass'
      }
    ]
  };

  const ev = buildBoundedEvidence(payload, 5000);
  assert.equal(ev.stateTooLarge, false);
  assert.ok(ev.state.includes('STOPPING CONDITION:\n\nTests must pass'));
  assert.ok(ev.state.includes('[Tool Call call_1]: bash({"command":"npm test"})'));
  assert.ok(ev.state.includes('[Tool Result call_1]: is_error=false\nPass: 167 tests'));
  // Secret should be redacted
  assert.ok(!ev.state.includes('sk-1234567890abcdef1234'));
  assert.ok(ev.state.includes('[REDACTED_SECRET]'));

  // Test size overflow
  const evSmall = buildBoundedEvidence(payload, 100);
  assert.equal(evSmall.stateTooLarge, true);
  assert.ok(evSmall.chars > 100);
});

test('goalcheck: parseEvaluatorVerdict', () => {
  assert.deepEqual(parseEvaluatorVerdict('{"ok": true, "reason": "all fixed"}'), {
    ok: true,
    reason: 'all fixed',
    impossible: false
  });

  assert.deepEqual(parseEvaluatorVerdict('```json\n{"ok": false, "reason": "test failed", "impossible": true}\n```'), {
    ok: false,
    reason: 'test failed',
    impossible: true
  });

  assert.deepEqual(parseEvaluatorVerdict('malformed non-json text'), {
    malformed: true,
    raw: 'malformed non-json text'
  });
});

test('goalcheck: combineVerdicts decision matrix', () => {
  const thresholds = { completeMin: 0.90, evidenceMin: 0.85, unfinishedMax: 0.10 };

  // 1. Native rejected
  const nativeFalse = combineVerdicts({
    nativeVerdict: { ok: false, reason: 'missing file' },
    jevResult: { ok: true, scores: { complete: 0.99, evidence: 0.99, unfinished: 0.01 } },
    thresholds
  });
  assert.equal(nativeFalse.ok, false);
  assert.equal(nativeFalse.reason, 'missing file');
  assert.equal(nativeFalse.verdictType, 'Blocked');

  // 2. Native impossible
  const nativeImp = combineVerdicts({
    nativeVerdict: { ok: false, impossible: true, reason: 'unsolvable' },
    jevResult: null,
    thresholds
  });
  assert.equal(nativeImp.ok, false);
  assert.equal(nativeImp.impossible, true);
  assert.equal(nativeImp.verdictType, 'Blocked');

  // 3. Native unavailable / malformed
  const nativeBad = combineVerdicts({
    nativeVerdict: { malformed: true },
    jevResult: { ok: true },
    thresholds
  });
  assert.equal(nativeBad.ok, false);
  assert.equal(nativeBad.verdictType, 'Unavailable');

  // 4. Native ok: true AND Jev passes all 3 thresholds
  const bothPass = combineVerdicts({
    nativeVerdict: { ok: true, reason: 'tests passed' },
    jevResult: { ok: true, scores: { complete: 0.95, evidence: 0.92, unfinished: 0.04 } },
    thresholds
  });
  assert.equal(bothPass.ok, true);
  assert.equal(bothPass.verdictType, 'Allowed');
  assert.equal(bothPass.reason, 'tests passed');

  // 5. Native ok: true BUT Jev complete fails
  const completeFail = combineVerdicts({
    nativeVerdict: { ok: true, reason: 'audit pass claimed' },
    jevResult: { ok: true, scores: { complete: 0.14, evidence: 0.88, unfinished: 0.63 } },
    thresholds
  });
  assert.equal(completeFail.ok, false);
  assert.equal(completeFail.verdictType, 'Blocked');
  assert.match(completeFail.reason, /complete=0.14 < min 0.90/);
  assert.match(completeFail.reason, /unfinished=0.63 > max 0.10/);

  // 6. Native ok: true BUT Jev state too large
  const stateLarge = combineVerdicts({
    nativeVerdict: { ok: true, reason: 'done' },
    jevResult: { stateTooLarge: true, chars: 70000, maxChars: 60000 },
    thresholds
  });
  assert.equal(stateLarge.ok, false);
  assert.equal(stateLarge.verdictType, 'Insufficient evidence');

  // 7. Native ok: true BUT Jev HTTP/network error
  const jevErr = combineVerdicts({
    nativeVerdict: { ok: true, reason: 'done' },
    jevResult: { ok: false, reason: 'http-502', message: 'HTTP 502 Bad Gateway' },
    thresholds
  });
  assert.equal(jevErr.ok, false);
  assert.equal(jevErr.verdictType, 'Unavailable');

  // 8. Native ok: true BUT Jev score NaN or missing
  const jevNaN = combineVerdicts({
    nativeVerdict: { ok: true, reason: 'done' },
    jevResult: { ok: true, scores: { complete: Number.NaN, evidence: 0.9, unfinished: 0.05 } },
    thresholds
  });
  assert.equal(jevNaN.ok, false);
  assert.equal(jevNaN.verdictType, 'Unavailable');
});

test('goalcheck-call: target resolution and score extraction', () => {
  const profiles = {
    'intact-claude': {
      baseURL: 'https://intact.example.com/v1',
      apiKey: 'intact-key-xyz'
    }
  };

  // From sourceProfile
  const t1 = resolveJevTarget({ sourceProfile: 'intact-claude', model: 'typesafe/jev-latest' }, profiles);
  assert.equal(t1.url, 'https://intact.example.com/v1/systemone');
  assert.equal(t1.apiKey, 'intact-key-xyz');
  assert.equal(t1.model, 'typesafe/jev-latest');

  // Override baseURL and key
  const t2 = resolveJevTarget({
    baseURL: 'https://custom.provider.com/api',
    apiKey: 'custom-key',
    model: 'typesafe/jev-custom'
  }, profiles);
  assert.equal(t2.url, 'https://custom.provider.com/api/systemone');
  assert.equal(t2.apiKey, 'custom-key');
  assert.equal(t2.model, 'typesafe/jev-custom');

  // Full decisionEndpoint override
  const t3 = resolveJevTarget({
    decisionEndpoint: 'https://alpha.decision.org/judge',
    apiKey: 'k'
  });
  assert.equal(t3.url, 'https://alpha.decision.org/judge');

  // Score extraction
  assert.equal(extractScoreFromAnswer({ noul: 0.85 }), 0.85);
  assert.equal(extractScoreFromAnswer({ score: 0.72 }), 0.72);
  assert.equal(extractScoreFromAnswer({ probabilities: { yes: 0.93 } }), 0.93);
  assert.equal(extractScoreFromAnswer({ choice: 'yes', confidence: 0.89 }), 0.89);
  assert.equal(extractScoreFromAnswer({ choice: 'no', confidence: 0.80 }), 0.20);
  assert.ok(Number.isNaN(extractScoreFromAnswer({ invalid: true })));
});
