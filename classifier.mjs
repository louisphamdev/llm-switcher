/**
 * Jev-powered Semantic Classifier & Router for llm-switcher
 * Evaluates prompt complexity using TypeSafe System One (Jev) models
 * and maps intent to optimal model tier (haiku, sonnet, opus).
 */

export const DEFAULT_JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_JEV_MODEL = 'jev-latest';
export const OPENROUTER_JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
export const OPENROUTER_JEV_MODEL = 'typesafe/jev-1.13';

export const TIER_CRITERIA = {
  haiku: 'Mechanical task, template fill, single fact lookup, extraction, binary decision, short formatting',
  sonnet: 'Multi-step coding, refactor, search across files, general programming, document drafting',
  opus: 'Architecture design, security analysis, deep reasoning, race conditions, migration plans, complex synthesis',
};

/**
 * Fast synchronous heuristic fallback when offline or no API key is set.
 */
export function heuristicClassify(prompt = '') {
  const text = String(prompt || '').toLowerCase();

  // Heavy reasoning or safety critical indicators -> opus
  const opusKeywords = [
    'architecture', 'security audit', 'race condition', 'deadlock', 'concurrency',
    'threat model', 'penetration', 'migration plan', 'adversarial', 'formal verification'
  ];
  if (opusKeywords.some((kw) => text.includes(kw))) {
    return 'opus';
  }

  // Trivial or mechanical indicators -> haiku
  const haikuKeywords = [
    'translate', 'format json', 'extract', 'regex', 'rename', 'single word',
    'yes or no', 'spell check', 'fix typo', 'convert to csv'
  ];
  if (text.length < 120 && haikuKeywords.some((kw) => text.includes(kw))) {
    return 'haiku';
  }

  // Default balanced tier
  return 'sonnet';
}

/**
 * Resolves Jev API key from environment.
 */
export function findJevKey(env = process.env) {
  if (typeof env?.TYPESAFE_API_KEY === 'string' && env.TYPESAFE_API_KEY.trim().length > 0) {
    return { key: env.TYPESAFE_API_KEY.trim(), source: 'typesafe' };
  }
  if (typeof env?.JEV_API_KEY === 'string' && env.JEV_API_KEY.trim().length > 0) {
    return { key: env.JEV_API_KEY.trim(), source: 'openrouter' };
  }
  return null;
}

/**
 * Classifies prompt into optimal model tier using TypeSafe Jev.
 * Falls back safely to heuristic on missing key, timeout, or network error.
 */
export async function classifyPrompt({
  prompt,
  apiKey,
  url,
  model,
  timeoutMs = 5000,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const fallbackTier = heuristicClassify(prompt);

  const keyInfo = apiKey ? { key: apiKey, source: 'custom' } : findJevKey(env);
  if (!keyInfo) {
    return {
      tier: fallbackTier,
      confidence: 0.5,
      source: 'heuristic',
      reason: 'no-key',
    };
  }

  const endpointUrl = url || (keyInfo.source === 'openrouter' ? OPENROUTER_JEV_URL : DEFAULT_JEV_URL);
  const modelName = model || (keyInfo.source === 'openrouter' ? OPENROUTER_JEV_MODEL : DEFAULT_JEV_MODEL);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = {
      state: String(prompt || ''),
      model: modelName,
      questions: {
        recommended_tier: {
          type: 'choice',
          instructions: 'Determine the optimal model tier for this task according to complexity and reasoning depth required.',
          criteria: TIER_CRITERIA,
        },
      },
    };

    const res = await fetchImpl(endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${keyInfo.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return {
        tier: fallbackTier,
        confidence: 0.5,
        source: 'heuristic',
        reason: `http-${res.status}`,
      };
    }

    const data = await res.json();
    const ans = data?.answers?.recommended_tier;
    if (!ans || typeof ans.choice !== 'string') {
      return {
        tier: fallbackTier,
        confidence: 0.5,
        source: 'heuristic',
        reason: 'bad-response',
      };
    }

    const tier = ['haiku', 'sonnet', 'opus'].includes(ans.choice) ? ans.choice : fallbackTier;
    const confidence = typeof ans.confidence === 'number' ? Number(ans.confidence.toFixed(3)) : 0.8;

    return {
      tier,
      confidence,
      distribution: ans.distribution || null,
      source: 'jev',
      model: data.model || modelName,
    };
  } catch (err) {
    clearTimeout(timer);
    const reason = err?.name === 'AbortError' ? 'timeout' : 'network';
    return {
      tier: fallbackTier,
      confidence: 0.5,
      source: 'heuristic',
      reason,
    };
  }
}
