// Network transport and schema validation for Jev System One decision API.
import { buildJevQuestions } from './goalcheck.mjs';

/**
 * Resolve effective URL and API key for Jev decision call.
 */
export function resolveJevTarget(policy = {}, profiles = {}) {
  let url = '';
  let apiKey = policy.apiKey || '';
  const model = policy.model || 'typesafe/jev-latest';

  const sourceProf = policy.sourceProfile ? profiles[policy.sourceProfile] : null;

  if (policy.decisionEndpoint && /^https?:\/\//i.test(policy.decisionEndpoint)) {
    url = policy.decisionEndpoint;
  } else if (policy.decisionEndpoint && policy.baseURL) {
    const base = policy.baseURL.replace(/\/+$/, '');
    const path = policy.decisionEndpoint.replace(/^\/+/, '');
    url = `${base}/${path}`;
  } else if (policy.baseURL) {
    url = `${policy.baseURL.replace(/\/+$/, '')}/systemone`;
  } else if (sourceProf && sourceProf.baseURL) {
    url = `${sourceProf.baseURL.replace(/\/+$/, '')}/systemone`;
  }

  if (!apiKey && sourceProf && sourceProf.apiKey) {
    // Only inherit key if not overridden to a different host
    apiKey = sourceProf.apiKey;
  }

  return { url, apiKey, model };
}

/**
 * Extract probability / score in [0, 1] from a Jev typed answer.
 */
export function extractScoreFromAnswer(answer) {
  if (!answer || typeof answer !== 'object') return Number.NaN;
  if (typeof answer.noul === 'number' && Number.isFinite(answer.noul)) {
    return answer.noul;
  }
  if (typeof answer.score === 'number' && Number.isFinite(answer.score)) {
    return answer.score;
  }
  if (answer.probabilities && typeof answer.probabilities.yes === 'number' && Number.isFinite(answer.probabilities.yes)) {
    return answer.probabilities.yes;
  }
  if (answer.choice === 'yes' && typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)) {
    return answer.confidence;
  }
  if (answer.choice === 'no' && typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)) {
    return Math.round((1 - answer.confidence) * 1e6) / 1e6;
  }
  return Number.NaN;
}

/**
 * Call Jev System One decision endpoint.
 */
export async function callJev({
  url,
  model,
  apiKey,
  state,
  questions,
  timeoutMs = 8000,
  signal,
  fetchImpl = globalThis.fetch
}) {
  if (!url) {
    return { ok: false, reason: 'missing-url', message: 'No decision URL configured' };
  }
  if (!apiKey) {
    return { ok: false, reason: 'no-key', message: 'No API key configured for decision endpoint' };
  }

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const effectiveTimeout = Number.isFinite(timeoutMs) ? Math.max(500, Math.min(60000, timeoutMs)) : 8000;
  const timer = setTimeout(() => ac.abort(), effectiveTimeout);
  const startTime = Date.now();

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, state, questions }),
      signal: ac.signal
    });

    const latencyMs = Date.now() - startTime;

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return {
        ok: false,
        reason: `http-${res.status}`,
        message: `HTTP ${res.status}: ${errBody.slice(0, 150)}`,
        latencyMs
      };
    }

    let data;
    try {
      data = JSON.parse(await res.text());
    } catch {
      return { ok: false, reason: 'bad-response', message: 'Response was not valid JSON', latencyMs };
    }

    if (!data || typeof data !== 'object' || !data.answers || typeof data.answers !== 'object') {
      return { ok: false, reason: 'bad-response', message: 'Response missing answers map', latencyMs };
    }

    const completeScore = extractScoreFromAnswer(data.answers.complete);
    const evidenceScore = extractScoreFromAnswer(data.answers.evidence);
    const unfinishedScore = extractScoreFromAnswer(data.answers.unfinished);

    if (Number.isNaN(completeScore) || Number.isNaN(evidenceScore) || Number.isNaN(unfinishedScore)) {
      return {
        ok: false,
        reason: 'missing-answers',
        message: 'One or more required answer scores (complete, evidence, unfinished) are missing or NaN',
        latencyMs,
        raw: data
      };
    }

    return {
      ok: true,
      scores: {
        complete: completeScore,
        evidence: evidenceScore,
        unfinished: unfinishedScore
      },
      model: data.model || model,
      latencyMs,
      raw: data
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const isTimeout = ac.signal.aborted;
    return {
      ok: false,
      reason: isTimeout ? 'timeout' : 'network',
      message: isTimeout ? `Request timed out after ${effectiveTimeout}ms` : (err.message || 'Network error'),
      latencyMs
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Probe connection with a minimal synthetic decision query.
 */
export async function testJevConnection({
  baseURL,
  decisionEndpoint,
  apiKey,
  model,
  sourceProfile,
  profiles = {},
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch
}) {
  const policy = { baseURL, decisionEndpoint, apiKey, model, sourceProfile };
  const target = resolveJevTarget(policy, profiles);

  if (!target.url) {
    return { ok: false, error: 'Could not resolve decision URL. Specify Base URL or choose a profile.' };
  }
  if (!target.apiKey) {
    return { ok: false, error: 'No API key provided or available from selected profile.' };
  }

  const testState = 'The user asked to add a unit test for password validation. The assistant created tests/auth.test.mjs and ran node --test tests/auth.test.mjs, which passed with 0 errors.';
  const testQuestions = buildJevQuestions('Add a unit test for password validation');

  const res = await callJev({
    url: target.url,
    model: target.model,
    apiKey: target.apiKey,
    state: testState,
    questions: testQuestions,
    timeoutMs,
    fetchImpl
  });

  if (!res.ok) {
    return { ok: false, error: res.message || res.reason || 'Probe failed', latencyMs: res.latencyMs };
  }

  return {
    ok: true,
    message: `Connected successfully to ${target.model} at ${target.url} (${res.latencyMs}ms)`,
    latencyMs: res.latencyMs,
    scores: res.scores
  };
}
