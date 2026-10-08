import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicToIR, responsesToIR, irToChatBody, irToVertexBody, irToAnthropicBody } from '../formats.mjs';
import { createToolVocab } from '../toolvocab.mjs';

const prefix = 'llm-gateway-compact-v1:';
const compact = summary => ({ type: 'compaction', encrypted_content: prefix + Buffer.from(JSON.stringify({ summary })).toString('base64url') });

test('converted Responses replays gateway compaction and refuses unknown ciphertext', () => {
  const body = irToChatBody(responsesToIR({ input: [compact('KEEP_DECISION'), { role: 'user', content: 'continue' }] }), 'm');
  assert.match(JSON.stringify(body.messages), /KEEP_DECISION/);
  assert.doesNotMatch(JSON.stringify(body.messages), /llm-gateway-compact/);
  assert.throws(() => responsesToIR({ input: [{ type: 'compaction', encrypted_content: 'opaque-native-ciphertext' }] }), /compaction/i);
});

test('explicit true and false strict survive Responses to Chat', () => {
  for (const strict of [true, false]) {
    const ir = responsesToIR({ input: 'go', tools: [{ type: 'function', name: 'f', strict,
      parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false } }] });
    assert.equal(irToChatBody(ir, 'm').tools[0].function.strict, strict);
  }
});

test('Vertex tool names remain unique and reverse to the correct declaration, history and choice', () => {
  const names = ['mcp__server-a__read', 'mcp__server_a__read'];
  for (const order of [names, [...names].reverse()]) {
    const ir = anthropicToIR({ tools: order.map(name => ({ name, input_schema: { type: 'object' } })), tool_choice: { type: 'tool', name: names[0] },
      messages: [{ role: 'assistant', content: names.map((name, i) => ({ type: 'tool_use', id: `c${i}`, name, input: {} })) },
        { role: 'user', content: names.map((_, i) => ({ type: 'tool_result', tool_use_id: `c${i}`, content: 'ok' })) }] });
    const body = irToVertexBody(ir, 'gemini-2.5-pro');
    const emitted = body.tools[0].functionDeclarations.map(t => t.name);
    assert.equal(new Set(emitted).size, 2);
    const vocab = createToolVocab(ir.tools, { allowHyphens: false });
    assert.deepEqual(emitted.map(n => vocab.name(n)), order);
    const calls = body.contents.find(c => c.role === 'model').parts.map(p => p.functionCall.name);
    assert.deepEqual(calls.map(n => vocab.name(n)), names);
    assert.equal(vocab.name(body.toolConfig.functionCallingConfig.allowedFunctionNames[0]), names[0]);
    assert.equal(emitted[order.indexOf(names[1])], names[1], 'valid original stays reserved');
  }
});

test('tool-result image reaches Chat, Anthropic and Vertex without becoming text', () => {
  const ir = anthropicToIR({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'image-call', name: 'screen', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'image-call', content: [
      { type: 'text', text: 'screenshot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
    ] }] }
  ] });
  const chat = irToChatBody(ir, 'm');
  const tool = chat.messages.find(m => m.role === 'tool');
  assert.equal(tool.content, 'screenshot');
  const image = chat.messages.find(m => m.role === 'user' && Array.isArray(m.content));
  assert.equal(image.content.find(p => p.type === 'image_url').image_url.url, 'data:image/png;base64,iVBORw0KGgo=');
  const anthropic = irToAnthropicBody(ir, 'm');
  assert.equal(anthropic.messages.at(-1).content[0].content[1].source.data, 'iVBORw0KGgo=');
  const vertex = irToVertexBody(ir, 'gemini-2.5-pro');
  assert.match(JSON.stringify(vertex.contents), /"inlineData":\{"mimeType":"image\/png","data":"iVBORw0KGgo="\}/);
  assert.doesNotMatch(tool.content, /omitted|base64/);
});
