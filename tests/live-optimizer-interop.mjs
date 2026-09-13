// LIVE test: cần gateway đang chạy (switch on) và upstream thật (tốn token).
// Test offline không cần mạng: npm test
const GATEWAY_PORT = Number(process.env.LLM_SWITCHER_PORT) || 3456;
const BASE_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

console.log('================================================================');
console.log('  LLM SWITCHER — TOKEN OPTIMIZER INTEROPERABILITY TEST SUITE   ');
console.log('  Simulating failure modes from Headroom, RTK, and Ponytail    ');
console.log('================================================================\n');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  process.stdout.write(`[TEST] ${name}... `);
  const t0 = Date.now();
  try {
    const detail = await fn();
    console.log(`PASS (${Date.now() - t0}ms)`);
    if (detail) console.log(`       ↳ ${detail}`);
    passed++;
  } catch (err) {
    console.log(`FAIL (${Date.now() - t0}ms)`);
    console.log(`       ↳ ERROR: ${err.message}`);
    failed++;
  }
}

// -----------------------------------------------------------------------------
// TEST 1: Headroom Failure Mode — Orphaned tool_result
// When Headroom prunes history to save tokens, it drops the assistant tool_use turn.
// Anthropic strictly throws: 400 invalid_request_error: 'tool_use_id does not correspond to any tool_use'
// LLM Switcher Healer Engine: Repairs orphaned result into context text -> 200 OK
// -----------------------------------------------------------------------------
await runTest('Headroom Simulation: Orphaned tool_result turn', async () => {
  const payload = {
    model: 'claude-opus-4-6',
    max_tokens: 40,
    messages: [
      { role: 'user', content: 'Context turn before pruning' },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'headroom_pruned_call_99', content: 'Database query result: 42 rows found' },
          { type: 'text', text: 'Reply: healed successfully' }
        ]
      }
    ],
    stream: false
  };

  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(payload)
  });

  if (res.status !== 200) {
    const err = await res.text();
    throw new Error(`Expected HTTP 200, got ${res.status}: ${err}`);
  }
  const json = await res.json();
  const text = json.content?.map(c => c.text).join('') || '';
  return `Healed orphaned tool_result. Response HTTP 200: "${text.slice(0, 50).replace(/\n/g, ' ')}..."`;
});

// -----------------------------------------------------------------------------
// TEST 2: Headroom Failure Mode — Consecutive User turns (Roles must alternate)
// When Headroom collapses history, multiple user turns occur back-to-back.
// Anthropic strictly throws: 400 invalid_request_error: 'roles must alternate'
// LLM Switcher Healer Engine: Merges consecutive same-role turns -> 200 OK
// -----------------------------------------------------------------------------
await runTest('Headroom Simulation: Consecutive User turns (Role alternation violation)', async () => {
  const payload = {
    model: 'claude-opus-4-6',
    max_tokens: 30,
    messages: [
      { role: 'user', content: 'User message turn 1' },
      { role: 'user', content: 'User message turn 2 (no assistant in between)' },
      { role: 'user', content: 'User message turn 3: reply pong' }
    ],
    stream: false
  };

  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(payload)
  });

  if (res.status !== 200) {
    const err = await res.text();
    throw new Error(`Expected HTTP 200, got ${res.status}: ${err}`);
  }
  const json = await res.json();
  return `Merged consecutive turns seamlessly. Stop reason: ${json.stop_reason}`;
});

// -----------------------------------------------------------------------------
// TEST 3: Headroom / RTK Failure Mode — Stripped Thinking Parameter
// Optimizer stripped the 'thinking' object to reduce tokens.
// LLM Switcher Thinking Guard: Detects reasoning model (ag/claude-opus-4-6-thinking)
// and restores thinking.budget_tokens automatically -> thinking_delta emitted!
// -----------------------------------------------------------------------------
await runTest('Thinking Guard: Restoring stripped thinking parameter on reasoning models', async () => {
  const payload = {
    model: 'claude-opus-4-6',
    max_tokens: 200,
    // Note: NO thinking parameter included (simulating optimizer stripping it)
    messages: [
      { role: 'user', content: 'Solve step by step: what is 17 * 23? Show reasoning.' }
    ],
    stream: true
  };

  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(payload)
  });

  if (res.status !== 200) {
    throw new Error(`Expected HTTP 200, got ${res.status}`);
  }

  const text = await res.text();
  const hasThinkingDelta = text.includes('thinking_delta');
  const hasSignatureDelta = text.includes('signature_delta');
  const hasTextDelta = text.includes('text_delta');

  if (!hasThinkingDelta) {
    throw new Error('Thinking Guard failed: thinking_delta was NOT emitted in stream!');
  }

  return `Automatically restored thinking: thinking_delta=${hasThinkingDelta}, signature_delta=${hasSignatureDelta}, text_delta=${hasTextDelta}`;
});

// -----------------------------------------------------------------------------
// TEST 4: RTK & Intermediary Headers Passthrough
// RTK / tracing tools inject headers: x-rtk-version, traceparent, x-request-id.
// LLM Switcher: Transparently preserves all tracking headers without rejection.
// -----------------------------------------------------------------------------
await runTest('RTK Intermediary: Custom headers and traceparent passthrough', async () => {
  const payload = {
    model: 'claude-opus-4-6',
    max_tokens: 20,
    messages: [{ role: 'user', content: 'ping' }],
    stream: false
  };

  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-rtk-version': '0.37.2',
      'x-optimizer-id': 'rtk-cli-hook',
      'traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    },
    body: JSON.stringify(payload)
  });

  if (res.status !== 200) {
    throw new Error(`Expected HTTP 200, got ${res.status}`);
  }
  return `Headers accepted cleanly with HTTP 200 OK`;
});

// -----------------------------------------------------------------------------
// TEST 5: OpenAI Chat Healer Mode — Orphaned Tool Result in Chat Completions
// Same test but over /v1/chat/completions: tool role message without prior tool_calls assistant message.
// OpenAI API strictly throws: 400 'messages with role tool must be a response to a preceding message with tool_calls'
// LLM Switcher: Converts orphaned tool to user text message -> 200 OK
// -----------------------------------------------------------------------------
await runTest('OpenAI Chat Healer: Orphaned role tool without preceding assistant tool_calls', async () => {
  const payload = {
    model: 'ag/gpt-oss-120b-medium',
    max_tokens: 30,
    messages: [
      { role: 'user', content: 'Turn 1 context' },
      { role: 'tool', tool_call_id: 'orphaned_chat_call_77', content: 'Tool execution logs: OK' },
      { role: 'user', content: 'reply pong' }
    ],
    stream: false
  };

  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (res.status !== 200) {
    const err = await res.text();
    throw new Error(`Expected HTTP 200, got ${res.status}: ${err}`);
  }
  const json = await res.json();
  return `Chat Healer rescued orphaned tool role. Stop reason: ${json.choices?.[0]?.finish_reason}`;
});

console.log('\n================================================================');
console.log(`  TEST RESULTS: ${passed} PASSED / ${failed} FAILED               `);
console.log('================================================================\n');

process.exit(failed ? 1 : 0);
