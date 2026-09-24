import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskHalf } from '../contract.mjs';

const SECRET = 'SECRET-PII-marker';
const KEEP = 'keep-model-name';
const bytes = (s) => Buffer.byteLength(s);

// Every body puts SECRET in each place a client writes its own content, and KEEP in fields that
// analysis needs. After masking, SECRET must be gone and KEEP must stay.
const bodies = {
  anthropic: {
    model: KEEP, max_tokens: 64, system: [{ type: 'text', text: `sys ${SECRET}` }],
    metadata: { user_id: `u ${SECRET}` },
    tools: [{ name: 'get_weather', description: 'Current weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: `hi ${SECRET}` },
      { role: 'assistant', content: [{ type: 'thinking', thinking: `t ${SECRET}`, signature: 'sig' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: `c ${SECRET}` } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: `r ${SECRET}` }] },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: `img ${SECRET}` } }] }
    ]
  },
  openaiChat: {
    model: KEEP, user: `u ${SECRET}`, temperature: 0.2,
    messages: [
      { role: 'system', content: `s ${SECRET}` },
      { role: 'user', content: [{ type: 'text', text: `q ${SECRET}` }, { type: 'image_url', image_url: { url: `data:${SECRET}` } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: JSON.stringify({ city: `c ${SECRET}` }) } }] },
      { role: 'tool', tool_call_id: 'call_1', content: `o ${SECRET}` }
    ]
  },
  responses: {
    model: KEEP, instructions: `i ${SECRET}`,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `q ${SECRET}` }] },
      { type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: JSON.stringify({ city: `c ${SECRET}` }) },
      { type: 'function_call_output', call_id: 'c1', output: `o ${SECRET}` },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: `r ${SECRET}` }], encrypted_content: `e ${SECRET}` }
    ]
  },
  gemini: {
    systemInstruction: { parts: [{ text: `s ${SECRET}` }] },
    contents: [
      { role: 'user', parts: [{ text: `q ${SECRET}` }] },
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: `c ${SECRET}` } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: `t ${SECRET}` } } }] }
    ]
  }
};

for (const [name, body] of Object.entries(bodies)) {
  test(`${name}: client content is masked, analysis fields stay`, () => {
    const raw = JSON.stringify(body);
    const out = maskHalf(raw);
    assert.ok(!out.includes(SECRET), `${name} leaks content: ${out}`);
    const parsed = JSON.parse(out);
    if (body.model) assert.equal(parsed.model, KEEP);
    assert.ok(out.includes('get_weather'), 'tool names stay');
    if (raw.includes('"type":')) assert.ok(out.includes('"type":'), 'types stay');
  });
}

test('masking keeps the byte length of every masked string', () => {
  const out = JSON.parse(maskHalf(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'héllo wörld' }] })));
  assert.equal(bytes(out.messages[0].content), bytes('héllo wörld'));
  assert.match(out.messages[0].content, /^x+$/);
});

test('a JSON string argument keeps its keys and masks its values', () => {
  const out = JSON.parse(maskHalf(JSON.stringify(bodies.openaiChat)));
  const args = JSON.parse(out.messages[2].tool_calls[0].function.arguments);
  assert.deepEqual(Object.keys(args), ['city']);
  assert.match(args.city, /^x+$/);
});

test('an SSE stream masks every data line and keeps event names', () => {
  const sse = [
    'event: message_start', `data: ${JSON.stringify({ type: 'message_start', message: { model: KEEP, role: 'assistant', content: [] } })}`, '',
    'event: content_block_delta', `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `a ${SECRET}` } })}`, '',
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `b ${SECRET}` } }] })}`, '',
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: `c ${SECRET}` })}`, '',
    'data: [DONE]', ''
  ].join('\n');
  const out = maskHalf(sse);
  assert.ok(!out.includes(SECRET), out);
  assert.ok(out.includes('event: content_block_delta'));
  assert.ok(out.includes('"text_delta"') && out.includes(KEEP));
  assert.ok(out.includes('data: [DONE]'));
});

test('text that is not JSON, or a cut body, is masked whole', () => {
  const cut = JSON.stringify(bodies.anthropic).slice(0, 120);
  for (const t of [`plain ${SECRET}`, cut]) {
    const out = maskHalf(t);
    assert.ok(!out.includes('SECRET'), out);
    assert.equal(bytes(out), bytes(t));
  }
});
