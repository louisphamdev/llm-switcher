// Unit tests for formats.mjs — runs offline: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicToIR, chatToIR, responsesToIR, vertexToIR,
  healToolPairs, irToChatBody, irToAnthropicBody, irToVertexBody, toGeminiSchema,
  createUpstreamNormalizer, createCollector, createThinkTagSplitter,
  createAnthropicStream, createResponsesStream, createVertexStream,
  healAnthropicPayload, estimateTokens, PLACEHOLDER_SIGNATURE, GEMINI_DUMMY_SIGNATURE,
  buildResponsesMessage, createUpstreamNormalizer as makeNormalizer, emitUpstreamBody,
  isAntigravityModel
} from '../formats.mjs';
import { assertValidAnthropicEvents } from './helpers.mjs';

test('anthropicToIR: stream defaults to false and thinking budget_tokens is preserved', () => {
  const ir = anthropicToIR({ model: 'claude-opus-4-6', max_tokens: 64000, messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled', budget_tokens: 31999 } });
  assert.equal(ir.stream, false);
  assert.deepEqual(ir.thinking, { type: 'enabled', budget: 31999 });
  const body = irToChatBody(ir, 'ag/claude-opus-4-6-thinking');
  assert.equal(body.thinking.budget_tokens, 31999);
});

test('anthropicToIR: explicit thinking disabled is not "restored" for reasoning models', () => {
  const ir = anthropicToIR({ model: 'x', messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'disabled' } });
  const body = irToChatBody(ir, 'ag/claude-opus-4-6-thinking');
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, undefined);
});

test('Chat emitter restores thinking for versioned Claude Opus model IDs', () => {
  const ir = anthropicToIR({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
  for (const model of ['ag/claude-opus-4-6', 'ag/claude-opus-4-7', 'claude-opus-5']) {
    const body = irToChatBody(ir, model);
    assert.ok(body.thinking, `${model} should receive restored thinking settings`);
  }
});

test('emitUpstreamBody: billing header stripped only for antigravity (ag/) models', () => {
  const header = 'x-anthropic-billing-header: cc_version=2.1.275.f15; cc_entrypoint=cli;';
  const fromArray = anthropicToIR({
    model: 'x', messages: [{ role: 'user', content: 'hi' }],
    system: [{ type: 'text', text: header }, { type: 'text', text: 'You are Claude Code.' }]
  });
  const fromString = anthropicToIR({ model: 'x', messages: [{ role: 'user', content: 'hi' }], system: `${header}\n\nYou are Claude Code.` });
  for (const ir of [fromArray, fromString]) {
    assert.equal(emitUpstreamBody('openai-chat', ir, 'ag/gemini-3.8-flash').messages[0].content, 'You are Claude Code.');
    assert.equal(emitUpstreamBody('vertex', ir, 'antigravity/gemini-3.8-flash').systemInstruction.parts[0].text, 'You are Claude Code.');
    for (const model of ['cc/claude-opus-4-7', 'claude-sonnet-4-6', 'openrouter/x-ai/grok']) {
      assert.ok(emitUpstreamBody('openai-chat', ir, model).messages[0].content.startsWith(header), model);
    }
  }
});

test('healAnthropicPayload: native Anthropic passthrough keeps the billing header', () => {
  const header = 'x-anthropic-billing-header: cc_version=2.1.275.f15; cc_entrypoint=cli;';
  const { payload } = healAnthropicPayload({
    model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }],
    system: [{ type: 'text', text: header }, { type: 'text', text: 'You are Claude Code.' }]
  });
  assert.equal(payload.system[0].text, header);
});

test('chatToIR: reasoning_effort "none" disables thinking', () => {
  const ir = chatToIR({ model: 'x', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'none' });
  assert.equal(ir.thinking.type, 'disabled');
});

test('healToolPairs: orphan result -> user text, missing result -> placeholder, adjacency kept', () => {
  const healed = healToolPairs([
    { role: 'user', content: 'start' },
    { role: 'tool', toolCallId: 'gone', content: 'orphan output' },
    { role: 'assistant', toolCalls: [{ id: 'a', name: 'f', args: {} }, { id: 'b', name: 'g', args: {} }] },
    { role: 'tool', toolCallId: 'x', content: 'stray' },
    { role: 'tool', toolCallId: 'a', content: 'A' },
    { role: 'user', content: 'next' }
  ]);
  assert.deepEqual(healed.map(m => m.role), ['user', 'user', 'assistant', 'tool', 'tool', 'user', 'user']);
  assert.match(healed[1].content, /orphan output/);
  assert.equal(healed[3].toolCallId, 'a');
  assert.equal(healed[4].toolCallId, 'b');
  assert.match(healed[4].content, /unavailable/);
  assert.match(healed[5].content, /stray/);
});

test('irToChatBody: every tool_calls message is immediately followed by its tool results', () => {
  const ir = anthropicToIR({
    model: 'x', messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 't1', name: 'read', input: { p: 1 } }] },
      { role: 'user', content: [{ type: 'text', text: 'interrupt' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'late' }] }
    ]
  });
  const { messages } = irToChatBody(ir, 'gpt-4o');
  const i = messages.findIndex(m => m.tool_calls);
  assert.equal(messages[i + 1].role, 'tool');
  assert.equal(messages[i + 1].tool_call_id, 't1');
  assert.ok(!messages.slice(i + 2).some(m => m.role === 'tool'), 'late result must not be emitted as a dangling tool message');
});

test('responsesToIR: parallel function_call items merge into one assistant turn; developer -> system', () => {
  const ir = responsesToIR({
    model: 'x', instructions: 'sys', input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev rules' }] },
      { role: 'user', content: 'do two things' },
      { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{}' },
      { type: 'function_call', call_id: 'c2', name: 'b', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: '1' },
      { type: 'function_call_output', call_id: 'c2', output: '2' }
    ]
  });
  assert.equal(ir.system, 'sys\n\ndev rules');
  const { messages } = irToChatBody(ir, 'gpt-4o');
  const roles = messages.map(m => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'tool']);
  assert.equal(messages[2].tool_calls.length, 2);
});

test('vertexToIR: functionCall/functionResponse are paired by generated ids', () => {
  const ir = vertexToIR({
    contents: [
      { role: 'user', parts: [{ text: 'weather?' }] },
      { role: 'model', parts: [{ functionCall: { name: 'w', args: { c: 'A' } } }, { functionCall: { name: 'w', args: { c: 'B' } } }] },
      { role: 'function', parts: [{ functionResponse: { name: 'w', response: { t: 1 } } }, { functionResponse: { name: 'w', response: { t: 2 } } }] }
    ]
  });
  const calls = ir.messages[1].toolCalls.map(t => t.id);
  const results = ir.messages.filter(m => m.role === 'tool').map(m => m.toolCallId);
  assert.deepEqual(results, calls);
  const { messages } = irToChatBody(ir, 'gpt-4o');
  assert.equal(messages.filter(m => m.role === 'tool').length, 2);
});

test('irToVertexBody: functionResponse uses the function name and parallel responses share one content', () => {
  const ir = anthropicToIR({
    model: 'x', messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: {} }, { type: 'tool_use', id: 'toolu_2', name: 'grep', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '[1,2]' }, { type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] }
    ],
    thinking: { type: 'enabled', budget_tokens: 2048 }
  });
  const body = irToVertexBody(ir);
  const fr = body.contents[2].parts.map(p => p.functionResponse);
  assert.deepEqual(fr.map(f => f.name), ['read', 'grep']);
  assert.deepEqual(fr[0].response, { result: [1, 2] });
  assert.equal(body.generationConfig.thinkingConfig.includeThoughts, true);
});

test('toGeminiSchema strips unsupported JSON Schema keywords', () => {
  const s = toGeminiSchema({
    $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
    properties: { a: { type: ['string', 'null'], format: 'uri' }, b: { const: 'x' }, additionalProperties: { type: 'number' } },
    required: ['a', 'zzz']
  });
  assert.equal(s.$schema, undefined);
  assert.equal(s.additionalProperties, undefined);
  assert.deepEqual(s.properties.a, { type: 'string', nullable: true });
  assert.deepEqual(s.properties.b, { enum: ['x'], type: 'string' });
  assert.ok(s.properties.additionalProperties, 'a property literally named additionalProperties is kept');
  assert.deepEqual(s.required, ['a']);
});

test('irToAnthropicBody: thinking constraints (budget < max_tokens, no top_k, temperature 1)', () => {
  const ir = chatToIR({ model: 'x', messages: [{ role: 'user', content: 'hi' }], max_tokens: 3000, temperature: 0.2, reasoning_effort: 'high' });
  ir.params.topK = 5;
  const body = irToAnthropicBody(ir, 'claude-opus-4-6');
  assert.ok(body.thinking.budget_tokens < body.max_tokens);
  assert.equal(body.temperature, undefined);
  assert.equal(body.top_k, undefined);

  const small = irToAnthropicBody(chatToIR({ model: 'x', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, reasoning_effort: 'high' }), 'claude');
  assert.equal(small.thinking, undefined, 'thinking dropped when max_tokens <= 1024');
});

test('irToAnthropicBody: never emits empty text blocks', () => {
  const ir = chatToIR({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: 'hi' }] }] });
  const body = irToAnthropicBody(ir, 'claude');
  assert.ok(body.messages.every(m => m.content.every(b => b.type !== 'text' || b.text)));
});

test('normalizer: usage-only OpenAI chunk is counted; vertex tool calls get distinct indexes', () => {
  const chat = createUpstreamNormalizer('openai-chat');
  const col = createCollector();
  col.add(chat({ choices: [{ delta: { content: 'hi' } }] }));
  col.add(chat({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 1000 } } }));
  assert.equal(col.prompt, 1200);
  assert.equal(col.completion(), 7);
  assert.equal(col.cached, 1000);

  const vtx = createUpstreamNormalizer('vertex');
  const a = vtx({ candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: { x: 1 } } }] } }] });
  const b = vtx({ candidates: [{ content: { parts: [{ functionCall: { name: 'g', args: { y: 2 } } }] } }] });
  assert.notEqual(a.tools[0].index, b.tools[0].index);
});

test('normalizer: Anthropic block indexes are remapped to 0-based tool indexes', () => {
  const n = createUpstreamNormalizer('anthropic');
  const start = n({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_x', name: 'f' } });
  const delta = n({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } });
  assert.equal(start.tools[0].index, 0);
  assert.equal(delta.tools[0].index, 0);
});

test('think tag splitter handles tags split across chunks', () => {
  const think = [];
  const text = [];
  const sp = createThinkTagSplitter(t => think.push(t), t => text.push(t));
  for (const c of ['<thi', 'nk>plan', ' A</th', 'ink>', 'answer a < b']) sp.push(c);
  sp.flush();
  assert.equal(think.join(''), 'plan A');
  assert.equal(text.join(''), 'answer a < b');
});

test('Anthropic renderer: think -> tool -> think -> text produces a valid event sequence', () => {
  const events = [];
  const r = createAnthropicStream((event, data) => events.push({ event, data }), 'm');
  r.start();
  r.think('a');
  r.tool({ index: 0, id: 'c1', name: 'f', args: '{"x"' });
  r.tool({ index: 0, args: ':1}' });
  r.think('b', 'sig123');
  r.text('hello');
  r.tool({ index: 1, id: 'c2', name: 'g', args: '{}' });
  r.text('more');
  r.finish('stop', { prompt: 100, completion: 5, cached: 40, hasTools: true });
  assertValidAnthropicEvents(events);
  const md = events.find(e => e.event === 'message_delta').data;
  assert.equal(md.delta.stop_reason, 'tool_use');
  assert.equal(md.usage.input_tokens, 60);
  assert.equal(md.usage.cache_read_input_tokens, 40);
  assert.ok(events.some(e => e.data.delta?.signature === 'lsw1.sig123'), 'foreign signature is wrapped, never passed off as an Anthropic signature');
});

test('Responses renderer: emits output_item.done for every item with full content', () => {
  const events = [];
  const r = createResponsesStream((event, data) => events.push({ event, data }), 'm');
  r.start();
  r.think('reason');
  r.text('Hel');
  r.text('lo');
  r.tool({ index: 0, id: 'call_1', name: 'shell', args: '{"cmd":' });
  r.tool({ index: 0, args: '"ls"}' });
  r.finish('stop', { prompt: 10, completion: 3 });

  const seqs = events.map(e => e.data.sequence_number);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
  const done = events.filter(e => e.event === 'response.output_item.done').map(e => e.data.item);
  assert.deepEqual(done.map(i => i.type), ['reasoning', 'message', 'function_call']);
  assert.equal(done[1].content[0].text, 'Hello');
  assert.equal(done[2].arguments, '{"cmd":"ls"}');
  assert.equal(done[2].call_id, 'call_1');
  const completed = events.at(-1).data.response;
  assert.equal(completed.output.length, 3);
  assert.equal(completed.usage.total_tokens, 13);
});

test('Vertex renderer: streamed tool deltas are emitted as one complete functionCall', () => {
  const chunks = [];
  const r = createVertexStream((_, d) => chunks.push(d), 'm');
  r.tool({ index: 0, id: 'c', name: 'f', args: '{"a"' });
  r.tool({ index: 0, args: ':1}' });
  r.finish('tool_calls', {});
  const calls = chunks.flatMap(c => c.candidates[0].content.parts).filter(p => p.functionCall);
  assert.deepEqual(calls, [{ functionCall: { name: 'f', args: { a: 1 } } }]);
});

test('thinkingMode: native sends only reasoning_effort, no prompt injection; off sends nothing', () => {
  const ir = anthropicToIR({ model: 'x', max_tokens: 8000, system: 'SYS', messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled', budget_tokens: 10000 } });
  const auto = irToChatBody(ir, 'gpt-4o');
  assert.ok(auto.thinking && auto.messages[0].content.includes('<think>'));

  const native = irToChatBody(ir, 'gpt-4o', { thinkingMode: 'native' });
  assert.equal(native.thinking, undefined);
  assert.equal(native.reasoning_effort, 'high');
  assert.equal(native.messages[0].content, 'SYS');
  assert.equal(native.max_completion_tokens, 8000);
  assert.equal(native.max_tokens, undefined);

  const restoreIr = anthropicToIR({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(irToChatBody(restoreIr, 'ag/claude-opus-4-6-thinking', { thinkingMode: 'native' }).reasoning_effort, undefined, 'native does not restore');

  const off = irToChatBody(ir, 'ag/claude-opus-4-6-thinking', { thinkingMode: 'off' });
  assert.equal(off.thinking, undefined);
  assert.equal(off.reasoning_effort, undefined);
});

test('healAnthropicPayload: untouched when valid (bytes can be forwarded as-is)', () => {
  const payload = {
    model: 'claude', thinking: { type: 'enabled', budget_tokens: 2048 }, messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'EqRealSig' }, { type: 'tool_use', id: 't1', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', cache_control: { type: 'ephemeral' } }] }
    ]
  };
  const r = healAnthropicPayload(payload);
  assert.equal(r.changed, false);
  assert.equal(r.payload, payload);
});

test('healAnthropicPayload: orphan/missing/misplaced tool_result and placeholder thinking', () => {
  const r = healAnthropicPayload({
    model: 'claude', thinking: { type: 'enabled', budget_tokens: 2048 }, messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'pruned', content: 'old' }, { type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'fake', signature: PLACEHOLDER_SIGNATURE }, { type: 'tool_use', id: 'a', name: 'f', input: {} }, { type: 'tool_use', id: 'b', name: 'g', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: 'note' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'A' }] }
    ]
  });
  assert.equal(r.changed, true);
  const [first, assistant, last] = r.payload.messages;
  assert.deepEqual(first.content.map(b => b.type), ['text', 'text']);
  assert.deepEqual(assistant.content.map(b => b.type), ['tool_use', 'tool_use'], 'placeholder-signed thinking stripped');
  assert.deepEqual(last.content.map(b => b.type), ['tool_result', 'tool_result', 'text'], 'results first, merged user turns');
  assert.equal(last.content[0].tool_use_id, 'a');
  assert.equal(last.content[1].tool_use_id, 'b');
  assert.equal(r.payload.thinking, undefined, 'thinking disabled because last assistant turn lost its thinking block');
  assert.equal(r.payload.messages.length, 3);
});

test('estimateTokens ignores base64 payloads', () => {
  const big = 'A'.repeat(400000);
  const n = estimateTokens({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }, { type: 'image', source: { type: 'base64', data: big } }] }] });
  assert.ok(n < 2000, String(n));
});

const APPLY_PATCH_TOOL = { type: 'custom', name: 'apply_patch', description: 'Edit files.', format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch hunk+ end_patch' } };

test('Codex tools: custom -> function(input), namespace flattened, local_shell, hosted tools dropped', () => {
  const ir = responsesToIR({
    model: 'x',
    tools: [
      APPLY_PATCH_TOOL,
      { type: 'namespace', name: 'mcp_fs', description: 'fs', tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { p: { type: 'string' } } } }] },
      { type: 'local_shell' },
      { type: 'web_search', external_web_access: true }
    ],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'patch it' }] },
      { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
      { type: 'function_call', call_id: 'c2', namespace: 'mcp_fs', name: 'read', arguments: '{"p":"a"}' },
      { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Done!' }] },
      { type: 'function_call_output', call_id: 'c2', output: 'contents' }
    ]
  });
  assert.deepEqual(ir.tools.map(t => t.name), ['apply_patch', 'mcp_fs__read', 'local_shell']);
  assert.deepEqual(ir.tools[0].parameters.required, ['input']);
  assert.match(ir.tools[0].description, /start: begin_patch/);
  const { messages } = irToChatBody(ir, 'gpt-4o');
  const call = messages.find(m => m.tool_calls);
  assert.deepEqual(call.tool_calls.map(t => t.function.name), ['apply_patch', 'mcp_fs__read']);
  assert.deepEqual(JSON.parse(call.tool_calls[0].function.arguments), { input: '*** Begin Patch\n*** End Patch' });
  assert.equal(messages.find(m => m.tool_call_id === 'c1').content, 'Done!');
});

test('Codex tools: responses output items restore custom_tool_call / namespace / local_shell_call', () => {
  const ir = responsesToIR({ model: 'x', input: 'go', tools: [APPLY_PATCH_TOOL, { type: 'namespace', name: 'mcp_fs', tools: [{ type: 'function', name: 'read' }] }, { type: 'local_shell' }] });
  const events = [];
  const r = createResponsesStream((event, data) => events.push({ event, data }), 'm', { toolMeta: ir.toolMeta });
  r.start();
  r.tool({ index: 0, id: 'call_p', name: 'apply_patch', args: '{"input":"*** Begin' });
  r.tool({ index: 0, args: ' Patch\n*** End Patch"}' });
  r.tool({ index: 1, id: 'call_r', name: 'mcp_fs__read', args: '{"p":"a"}' });
  r.tool({ index: 2, id: 'call_s', name: 'local_shell', args: '{"command":["ls","-la"]}' });
  r.finish('tool_calls', {});
  const done = events.filter(e => e.event === 'response.output_item.done').map(e => e.data.item);
  assert.deepEqual(done[0], { id: done[0].id, type: 'custom_tool_call', status: 'completed', call_id: 'call_p', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' });
  assert.equal(done[1].type, 'function_call');
  assert.equal(done[1].name, 'read');
  assert.equal(done[1].namespace, 'mcp_fs');
  assert.deepEqual(done[2].action.command, ['ls', '-la']);
  assert.equal(done[2].type, 'local_shell_call');
  assert.ok(!events.some(e => e.event === 'response.function_call_arguments.delta' && e.data.item_id === done[0].id), 'no function deltas for custom tools');

  const msg = buildResponsesMessage({ model: 'm', text: [''], tools: [{ id: 'call_p', name: 'apply_patch', args: '{"input":"X"}' }], toolMeta: ir.toolMeta });
  assert.deepEqual(msg.output.map(o => o.type), ['custom_tool_call']);
  assert.equal(msg.output[0].input, 'X');
});

test('Gemini: captured thoughtSignature is replayed on the functionCall part; dummy only for Gemini 3 current turn', () => {
  const n = makeNormalizer('vertex');
  const ev = n({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'w', args: {} }, thoughtSignature: 'SIG_1' }, { functionCall: { name: 'w', args: { b: 1 } } }] } }] });
  const [a, b] = ev.tools;
  assert.ok(a.id && b.id && a.id !== b.id);

  const history = (ids) => anthropicToIR({
    model: 'x', messages: [
      { role: 'user', content: 'weather' },
      { role: 'assistant', content: ids.map((id, i) => ({ type: 'tool_use', id, name: 'w', input: { i } })) },
      { role: 'user', content: ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: '{"t":1}' })) }
    ]
  });

  const body = irToVertexBody(history([a.id, b.id]), 'gemini-3-pro');
  assert.equal(body.contents[1].parts[0].thoughtSignature, 'SIG_1');
  assert.equal(body.contents[1].parts[1].thoughtSignature, undefined, 'only first parallel call carries a signature');
  assert.equal(body.contents[2].role, 'user');
  assert.equal(body.contents[2].parts.length, 2);

  const unknown = irToVertexBody(history(['toolu_from_claude']), 'gemini-3-flash');
  assert.equal(unknown.contents[1].parts[0].thoughtSignature, GEMINI_DUMMY_SIGNATURE);
  const old = irToVertexBody(history(['toolu_from_claude']), 'gemini-2.5-pro');
  assert.equal(old.contents[1].parts[0].thoughtSignature, undefined);

  const past = anthropicToIR({
    model: 'x', messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'old_call', name: 'w', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old_call', content: 'ok' }] },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'new question' }
    ]
  });
  assert.equal(irToVertexBody(past, 'gemini-3-pro').contents[1].parts[0].thoughtSignature, undefined, 'previous turns are not validated');
});

test('OpenAI-compatible Gemini: extra_content.google.thought_signature is captured and echoed back', () => {
  const n = makeNormalizer('openai-chat');
  n({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_g', type: 'function', function: { name: 'f', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG_OAI' } } }] } }] });
  const ir = anthropicToIR({
    model: 'x', messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_g', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_g', content: 'ok' }] }
    ]
  });
  const body = irToChatBody(ir, 'gemini-3-pro');
  assert.equal(body.messages.find(m => m.tool_calls).tool_calls[0].extra_content.google.thought_signature, 'SIG_OAI');
  const plain = irToChatBody(anthropicToIR({ model: 'x', messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'other', name: 'f', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'other', content: 'ok' }] }] }), 'gpt-4o');
  assert.equal(plain.messages.find(m => m.tool_calls).tool_calls[0].extra_content, undefined);
});

test('toGeminiSchema: bare string shorthands become Schema objects (Vertex 400 fix)', () => {
  assert.deepEqual(toGeminiSchema('object'), { type: 'object', properties: {} });
  assert.deepEqual(toGeminiSchema('string'), { type: 'string' });
  assert.deepEqual(
    toGeminiSchema({ type: 'object', properties: { tags: { type: 'array', items: 'object' }, n: 'string' } }),
    { type: 'object', properties: { tags: { type: 'array', items: { type: 'object', properties: {} } }, n: { type: 'string' } } }
  );
});

test('toGeminiSchema: local $refs are inlined, $defs dropped', () => {
  const schema = {
    type: 'object',
    properties: { msg: { $ref: '#/$defs/Part', description: 'a part' } },
    $defs: { Part: { type: 'object', properties: { text: { type: 'string' } } } }
  };
  assert.deepEqual(toGeminiSchema(schema), {
    type: 'object',
    properties: { msg: { type: 'object', properties: { text: { type: 'string' } }, description: 'a part' } }
  });
  assert.deepEqual(toGeminiSchema({ $ref: '#/$defs/Missing' }), {});
});

test('toGeminiSchema: anyOf-null unions collapse to nullable', () => {
  assert.deepEqual(
    toGeminiSchema({ anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] }),
    { type: 'array', items: { type: 'string' }, nullable: true }
  );
  const multi = toGeminiSchema({ anyOf: [{ type: 'string' }, { type: 'integer' }] });
  assert.equal(multi.anyOf.length, 2);
});

test('toGeminiSchema: garbage required entries and extra keys are stripped', () => {
  const out = toGeminiSchema({
    type: 'object',
    properties: { a: { type: 'string' } },
    required: [{ type: 'a' }, 'b'],
    additionalProperties: true
  });
  assert.deepEqual(out.required, []);
  assert.equal(out.additionalProperties, undefined);
});

test('isAntigravityModel gates the Gemini-safe tool rewrite', () => {
  assert.ok(isAntigravityModel('ag/gemini-3.8-flash'));
  assert.ok(isAntigravityModel('antigravity/x'));
  assert.ok(!isAntigravityModel('gpt-5-codex'));
});

test('createResponsesStream.error carries a mapped code (Codex retryable failures)', () => {
  const events = [];
  const s = createResponsesStream((e, d) => events.push({ event: e, data: d }), 'ag/mock');
  s.start();
  s.error('slow down', 'rate_limit_exceeded');
  assert.deepEqual(events.slice(0, 2).map(e => e.event), ['response.created', 'response.in_progress']);
  const failed = events.find(e => e.event === 'response.failed');
  assert.equal(failed.data.response.status, 'failed');
  assert.equal(failed.data.response.error.code, 'rate_limit_exceeded');
  assert.match(failed.data.response.id, /^resp_/);
});
