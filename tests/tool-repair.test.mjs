// The tool-name layer: a model answers in the vocabulary it knows, the caller only runs the tools it
// declared. Sources for every name here are collected in docs/tool-vocabulary.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolVocab, NULL_TOOL_VOCAB, tokenize, sanitizeToolName, toolNameMapForIR } from '../toolvocab.mjs';
import {
  anthropicToIR, responsesToIR, irToChatBody, irToAnthropicBody, irToVertexBody, buildAnthropicMessage, buildChatMessage, buildResponsesMessage,
  createAnthropicStream, createChatStream, createResponsesStream
} from '../formats.mjs';

const claudeTools = () => anthropicToIR({
  model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'go' }],
  tools: [
    { name: 'Read', input_schema: { properties: { file_path: { type: 'string' }, offset: { type: 'number' } } } },
    { name: 'Bash', input_schema: { properties: { command: { type: 'string' } } } },
    { name: 'Edit', input_schema: { properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } } } }
  ]
});

const consoleTool = 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_console_messages';
const networkTool = 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_network_requests';

function toolSearchHistory(extraTools = []) {
  return anthropicToIR({
    model: 'claude-opus-5-5', system: `Inspect errors with ${consoleTool} and ${networkTool}.`,
    messages: [
      { role: 'user', content: 'Inspect console errors.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'search1', name: 'ToolSearch', input: { query: `select:${consoleTool},${networkTool}`, max_results: 5 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search1', content: [
        { type: 'tool_reference', tool_name: consoleTool }, { type: 'tool_reference', tool_name: networkTool }
      ] }] }
    ],
    tools: [
      { name: 'ToolSearch', description: `Find tools such as ${consoleTool}.`, input_schema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' } } } },
      ...[consoleTool, networkTool, ...extraTools].map(name => ({ name, input_schema: { type: 'object', properties: { pageSize: { type: 'integer' } } } }))
    ]
  });
}

test('ToolSearch references, query history and instructions agree with declared aliases across upstream formats', () => {
  const ir = toolSearchHistory();
  const original = JSON.stringify(ir);
  for (const [emit, model, opts] of [
    [irToChatBody, 'zencore/space-bunny-free', {}],
    [irToChatBody, 'zencore/space-bunny-free', { thinkingMode: 'off' }],
    [irToChatBody, 'zencore/space-bunny-free', { thinkingMode: 'native' }],
    [irToAnthropicBody, 'claude-opus-5-5', {}],
    [irToVertexBody, 'gemini-3.8-flash', {}]
  ]) {
    const body = emit(ir, model, opts);
    const serialized = JSON.stringify(body);
    const names = toolNameMapForIR(ir, { allowHyphens: emit !== irToVertexBody });
    for (const name of [consoleTool, networkTool]) {
      assert.ok(serialized.includes(names.name(name)), 'model sees the declared alias');
      assert.ok(!serialized.includes(name), 'original no longer competes with the alias');
    }
    assert.equal(JSON.stringify(ir), original, 'conversion never mutates caller history');
  }
});

test('ToolSearch instructions use collision-resolved aliases instead of the reserved original name', () => {
  const reserved = sanitizeToolName(consoleTool);
  const ir = toolSearchHistory([reserved]);
  const names = toolNameMapForIR(ir);
  assert.notEqual(names.name(consoleTool), reserved);
  const body = irToChatBody(ir, 'zencore/space-bunny-free');
  assert.equal(body.tools.find(t => t.function.name === reserved).function.name, reserved);
  const references = body.messages.find(m => m.role === 'tool').content.split('\n').map(JSON.parse);
  assert.equal(references[0].tool_name, names.name(consoleTool));
  assert.ok(body.messages[0].content.includes(names.name(consoleTool)));
  const notice = irToChatBody({ ...ir, system: '' }, 'x').messages[0].content;
  assert.ok(notice.includes(names.name(consoleTool)), 'notice uses the collision-resolved declaration too');
  const vocab = createToolVocab(ir.tools);
  const response = buildAnthropicMessage({ model: 'x', tools: [{ name: 'ToolSearch', args: JSON.stringify({ query: `select:${names.name(consoleTool)},${reserved}` }) }], vocab });
  assert.equal(response.content[0].input.query, `select:${consoleTool},${reserved}`);
});

test('only structured references and ToolSearch queries change; caller data, schemas and unknown tools survive', () => {
  const ir = toolSearchHistory();
  const unknown = 'mcp__not_declared__inspect';
  ir.messages[0].content = `User data mentions ${consoleTool}.`;
  ir.messages[1].toolCalls.push({ id: 'data1', name: consoleTool, args: { pageSize: 0, query: consoleTool } });
  ir.messages.push({ role: 'tool', toolCallId: 'data1', content: `Log contains ${consoleTool}.` });
  ir.messages[2].toolResultParts.push({ type: 'tool_reference', tool_name: unknown });
  ir.tools[1].parameters.properties.query = { type: 'string', const: consoleTool };
  const body = irToChatBody(ir, 'x');
  assert.equal(body.messages.find(m => m.role === 'user').content, ir.messages[0].content);
  assert.equal(body.messages.find(m => m.tool_call_id === 'data1').content, `Log contains ${consoleTool}.`);
  const calls = body.messages.find(m => m.tool_calls).tool_calls;
  assert.deepEqual(JSON.parse(calls[1].function.arguments), { pageSize: 0, query: consoleTool });
  assert.equal(JSON.parse(calls[0].function.arguments).max_results, 5);
  assert.ok(body.messages.find(m => m.tool_call_id === 'search1').content.includes(unknown));
  assert.equal(body.tools[1].function.parameters.properties.query.const, consoleTool);
  const vocab = createToolVocab(ir.tools);
  assert.equal(vocab.name(unknown), unknown);
  const malformed = '{"query":"select:';
  assert.equal(vocab.args('ToolSearch', malformed), malformed);
});

test('fragmented streamed ToolSearch queries restore original names before the client executes them', () => {
  const ir = toolSearchHistory();
  const vocab = createToolVocab(ir.tools);
  const args = JSON.stringify({ query: `select:${sanitizeToolName(consoleTool)},${sanitizeToolName(networkTool)}`, max_results: 5 });
  for (const create of [createAnthropicStream, createChatStream, createResponsesStream]) {
    const events = [];
    const renderer = create((event, data) => events.push({ event, data }), 'x', { vocab });
    renderer.start();
    renderer.tool({ index: 0, id: 'search2', name: 'ToolSearch', args: '' });
    for (let i = 0; i < args.length; i += 7) renderer.tool({ index: 0, args: args.slice(i, i + 7) });
    renderer.finish('tool_calls', { hasTools: true });
    let restored;
    if (create === createAnthropicStream) restored = events.filter(e => e.data?.delta?.type === 'input_json_delta').map(e => e.data.delta.partial_json).join('');
    else if (create === createChatStream) restored = events.flatMap(e => e.data?.choices?.[0]?.delta?.tool_calls || []).map(c => c.function?.arguments || '').join('');
    else restored = events.find(e => e.event === 'response.output_item.done').data.item.arguments;
    assert.deepEqual(JSON.parse(restored), { query: `select:${consoleTool},${networkTool}`, max_results: 5 });
  }
  const argsUnrelated = JSON.stringify({ query: sanitizeToolName(consoleTool) });
  assert.equal(vocab.args(consoleTool, argsUnrelated), argsUnrelated, 'other tools keep their arguments');
});

test('repairing one parallel Chat ToolSearch call never flushes another unfinished query', () => {
  const vocab = createToolVocab(toolSearchHistory().tools);
  const events = [];
  const renderer = createChatStream((event, data) => events.push(data), 'x', { vocab });
  renderer.start();
  renderer.tool({ index: 0, name: 'ToolSearch', args: '{"query":"select:' });
  renderer.tool({ index: 1, name: 'ToolSearch', args: JSON.stringify({ query: `select:${sanitizeToolName(networkTool)}` }) });
  renderer.tool({ index: 0, args: `${sanitizeToolName(consoleTool)}"}` });
  renderer.finish('tool_calls');
  for (const [index, original] of [[0, consoleTool], [1, networkTool]]) {
    const args = events.flatMap(e => e.choices?.[0]?.delta?.tool_calls || [])
      .filter(c => c.index === index).map(c => c.function?.arguments || '').join('');
    assert.equal(JSON.parse(args).query, `select:${original}`);
  }
});

// A model that answers `read` when the caller declared `Read` ends the turn with
// "No such tool available: read". The name comes back in the caller's words.
test('a name the model reached for comes back in the caller own words', () => {
  const vocab = createToolVocab(claudeTools().tools);
  assert.equal(vocab.name('read'), 'Read');
  assert.equal(vocab.name('shell'), 'Bash');
  assert.equal(vocab.name('str_replace_editor'), 'Edit');
  assert.equal(vocab.name('read_file'), 'Read', 'the name Codex is trained on');
  assert.equal(vocab.name('run_shell_command'), 'Bash', 'the name Gemini is trained on');
  assert.equal(vocab.name('execute_command'), 'Bash');
});

test('a name the caller already declared is never touched', () => {
  const vocab = createToolVocab(claudeTools().tools);
  for (const own of ['Read', 'Bash', 'Edit']) assert.equal(vocab.name(own), own);
  assert.equal(vocab.name('WebFetch'), 'WebFetch', 'a name it did not declare and that says nothing');
  assert.equal(vocab.name('totally_unknown'), 'totally_unknown');
});

// Two declared tools of the same kind: which one the model meant is not knowable, and the wrong one
// runs. Claude Code on Windows declares both Bash and PowerShell.
test('two tools of the same kind are left alone rather than one being chosen', () => {
  const ir = anthropicToIR({
    model: 'x', messages: [],
    tools: [
      { name: 'Bash', input_schema: { properties: {} } },
      { name: 'PowerShell', input_schema: { properties: {} } },
      { name: 'Read', input_schema: { properties: {} } }
    ]
  });
  const vocab = createToolVocab(ir.tools);
  assert.equal(vocab.name('shell'), 'shell', 'no shell tool was renamed');
  assert.equal(vocab.name('read'), 'Read', 'the unambiguous one still is');
});

// mcp__github__create_issue becoming a local Write produces a call the caller cannot detect as wrong:
// it runs, and it writes a file instead of opening an issue.
test('a namespaced name never leaves its namespace', () => {
  const ir = anthropicToIR({
    model: 'x', messages: [],
    tools: [
      { name: 'Write', input_schema: { properties: {} } },
      { name: 'mcp__github__create_issue', input_schema: { properties: {} } }
    ]
  });
  const vocab = createToolVocab(ir.tools);
  assert.equal(vocab.name('mcp__github__create_issue'), 'mcp__github__create_issue');
  assert.equal(vocab.name('mcp__github__write_file'), 'mcp__github__write_file');
});

// Who runs the tool decides whether a name may move at all. Anthropic runs a server tool and its
// result reaches the caller without the caller executing anything; handing it back as a client tool
// moves the work to the user's machine, where nothing can see that it happened.
test('a tool the provider runs is neither renamed nor offered as a client tool', () => {
  const ir = anthropicToIR({
    model: 'claude-opus-4-6', messages: [],
    tools: [
      { name: 'Read', input_schema: { properties: { file_path: { type: 'string' } } } },
      { name: 'Bash', input_schema: { properties: { command: { type: 'string' } } } },
      { type: 'web_search_20260209', name: 'web_search' }
    ]
  });
  assert.deepEqual(ir.tools.map(t => [t.name, t.side]), [
    ['Read', 'client'], ['Bash', 'client'], ['web_search', 'provider']
  ]);
  const vocab = createToolVocab(ir.tools);
  assert.equal(vocab.name('web_search'), 'web_search', 'a server tool is never a rename target');
});

// The schema is the caller's to declare, so the argument keys are matched against it rather than
// against a table of what each tool is called.
test('arguments are renamed only against the caller own schema, and a falsy value survives', () => {
  const vocab = createToolVocab(claudeTools().tools);
  const read = vocab.args('read', JSON.stringify({ path: 'a.ts', offset: 0 }));
  assert.deepEqual(JSON.parse(read), { file_path: 'a.ts', offset: 0 }, 'offset 0 is a value, not an absence');

  // A tool whose schema already has the key: nothing is touched.
  const bash = vocab.args('shell', JSON.stringify({ command: 'ls' }));
  assert.deepEqual(JSON.parse(bash), { command: 'ls' });

  // A key the schema does not name stays: the caller may still read it.
  const edit = vocab.args('Edit', JSON.stringify({ file_path: 'a', note: 'keep me' }));
  assert.deepEqual(JSON.parse(edit), { file_path: 'a', note: 'keep me' });

  // Arguments cut off by the upstream are passed through, not rewritten.
  const broken = vocab.args('read', '{"path": "a.t');
  assert.equal(broken, '{"path": "a.t');
});

// The whole turn, non-streaming, through the emitter the caller reads.
test('a non-streaming answer hands the caller its own tool name and its own arguments', () => {
  const ir = claudeTools();
  const vocab = createToolVocab(ir.tools);
  const body = buildAnthropicMessage({
    model: 'claude-opus-4-6', text: [], think: [], finish: 'tool_calls',
    tools: [{ id: 't1', name: 'read', args: '{"path":"a.ts","offset":0}' }], vocab
  });
  const use = body.content.find(c => c.type === 'tool_use');
  assert.equal(use.name, 'Read');
  assert.deepEqual(use.input, { file_path: 'a.ts', offset: 0 });
  assert.equal(body.stop_reason, 'tool_use');

  const chat = buildChatMessage({ model: 'm', text: [], tools: [{ id: 't1', name: 'shell', args: '{"command":"ls"}' }], vocab });
  const call = chat.choices[0].message.tool_calls[0].function;
  assert.equal(call.name, 'Bash');
  assert.equal(call.arguments, '{"command":"ls"}');

  const codex = buildResponsesMessage({ model: 'm', text: [], tools: [{ id: 'c1', name: 'read', args: '{"path":"a"}' }], vocab });
  assert.equal(codex.output.find(i => i.type === 'function_call').name, 'Read');
});

// With no declared tools there is nothing to map, so the layer costs nothing and changes nothing.
test('a request that declared no tools is passed through untouched', () => {
  const vocab = createToolVocab([]);
  assert.equal(vocab.name('read'), 'read');
  assert.equal(vocab.args('read', '{"path":"a"}'), '{"path":"a"}');
  const body = buildAnthropicMessage({ model: 'm', text: [], tools: [{ id: 't', name: 'read', args: '{}' }], vocab });
  assert.equal(body.content[0].name, 'read');
  assert.equal(NULL_TOOL_VOCAB.name('x'), 'x');
});

// Streaming: the name arrives first and is fixed at once. The arguments arrive in pieces, so a call
// whose keys are renamed is held back and handed over whole, before the block closes.
test('a streamed answer renames the name at once and holds the arguments only when it must', () => {
  const vocab = createToolVocab(claudeTools().tools);

  const plain = [];
  const a = createAnthropicStream((e, d) => plain.push([e, d]), 'm', { vocab });
  a.start();
  a.tool({ index: 0, id: 't1', name: 'Bash', args: '{"command":' });
  a.tool({ index: 0, args: '"ls"}' });
  a.finish('tool_calls', {});
  assert.deepEqual(plain.find(([e]) => e === 'content_block_start')[1].content_block.name, 'Bash');
  // A call the caller already names is not buffered at all: every fragment goes straight out.
  assert.deepEqual(
    plain.filter(([, d]) => d.delta?.type === 'input_json_delta').map(([, d]) => d.delta.partial_json),
    ['{"command":', '"ls"}']
  );

  const fixed = [];
  const b = createAnthropicStream((e, d) => fixed.push([e, d]), 'm', { vocab });
  b.start();
  b.tool({ index: 0, id: 't1', name: 'read', args: '{"path"' });
  b.tool({ index: 0, args: ':"a.ts","offset":0}' });
  b.finish('tool_calls', {});
  assert.equal(fixed.find(([e]) => e === 'content_block_start')[1].content_block.name, 'Read');
  const deltas = fixed.filter(([, d]) => d.delta?.type === 'input_json_delta').map(([, d]) => d.delta.partial_json);
  assert.deepEqual(deltas, ['{"file_path":"a.ts","offset":0}'], 'one delta, with the caller own key');
  // The block never closes with arguments still pending.
  const stopAt = fixed.findIndex(([e, d]) => e === 'content_block_stop' && d.type === 'content_block_stop');
  const lastArgAt = fixed.findIndex(([, d]) => d.delta?.type === 'input_json_delta');
  assert.ok(lastArgAt < stopAt, 'the arguments arrive before the block stops');
});

// Codex runs a tool when the whole item arrives, so a renamed call carries its repaired arguments
// with that item and streams no argument deltas of its own.
test('a streamed Codex call is repaired in the item Codex runs', () => {
  const ir = responsesToIR({
    model: 'gpt-5.6-sol', input: 'go',
    tools: [{ type: 'function', name: 'Read', parameters: { properties: { file_path: { type: 'string' } } } },
            { type: 'function', name: 'Bash', parameters: { properties: { command: { type: 'string' } } } }]
  });
  const vocab = createToolVocab(ir.tools);
  const events = [];
  const r = createResponsesStream((e, d) => events.push([e, d]), 'm', { vocab, toolMeta: ir.toolMeta });
  r.start();
  r.tool({ index: 0, id: 'c1', name: 'read', args: '{"path":"a.ts"' });
  r.tool({ index: 0, args: '}' });
  r.finish('tool_calls', {});
  const added = events.find(([e]) => e === 'response.output_item.added')[1].item;
  const done = events.find(([e]) => e === 'response.output_item.done')[1].item;
  assert.equal(added.name, 'Read');
  assert.equal(added.arguments, '', 'nothing is streamed for a call whose keys are renamed');
  assert.equal(done.arguments, '{"file_path":"a.ts"}');
  assert.equal(events.some(([e]) => e === 'response.function_call_arguments.delta'), false);
});

test('tokenize reads a name the way the model that coined it saw it', () => {
  assert.deepEqual(tokenize('TodoWrite'), ['Todo', 'Write']);
  assert.deepEqual(tokenize('str_replace_editor'), ['str', 'replace', 'editor']);
  assert.deepEqual(tokenize('mcp__fs__read'), ['mcp', 'fs', 'read']);
  assert.deepEqual(tokenize('filePath'), ['file', 'Path']);
});

// ---- steering the model instead of repairing every call ----
//
// A model answers with the tool names it was trained on, whatever the caller declared. Naming the
// caller's names in the prompt is cheaper than repairing each such call, but only where the caller
// has not already named them: a second list for a prompt that already carries one is a second thing
// for the model to weigh, and this is where the collision would come from.

function noticeIn(system, toolNames, opts = {}) {
  const ir = anthropicToIR({
    model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'go' }],
    ...(system ? { system } : {}),
    tools: toolNames.map(n => ({ name: n, input_schema: { properties: {} } }))
  });
  const body = irToChatBody(ir, 'gpt-5.6-sol', opts);
  const sys = body.messages.find(m => m.role === 'system');
  return sys ? sys.content : '';
}

test('a caller that never names its tools gets the list, and nothing else changes', () => {
  const sys = noticeIn('', ['Read', 'Bash', 'Edit']);
  assert.match(sys, /use exactly these names/i);
  for (const n of ['Read', 'Bash', 'Edit']) assert.ok(sys.includes(n), `${n} is missing from the notice`);
});

// Claude Code names its tools at length in its own prompt. A second list would compete with it, so
// nothing is added and the caller's text is passed through byte for byte.
test('a prompt that already names every tool gets nothing added', () => {
  const prompt = 'You are Claude Code. Use Read to view a file, Bash to run a command, Edit to change one.';
  assert.equal(noticeIn(prompt, ['Read', 'Bash', 'Edit']), prompt);
});

test('a prompt that names some of them gets only the rest', () => {
  const sys = noticeIn('Use Read to view a file.', ['Read', 'Bash']);
  assert.match(sys, /^Use Read to view a file\./);
  assert.ok(sys.includes('Bash'), 'the name the prompt did not carry is added');
  assert.ok(!/Read, Bash/.test(sys), 'and the one it already had is not repeated');
});

test('one tool cannot be confused with another, so nothing is said', () => {
  assert.equal(noticeIn('', ['Read']), '');
  assert.equal(noticeIn('', []), '');
});

// A tool the provider runs is not in the list: the caller never executes it, so naming it would only
// invite the model to call something the gateway dropped.
test('a tool the provider runs is never named', () => {
  const ir = anthropicToIR({
    model: 'x', messages: [],
    tools: [
      { name: 'Read', input_schema: { properties: {} } },
      { name: 'Bash', input_schema: { properties: {} } },
      { type: 'web_search_20260209', name: 'web_search' }
    ]
  });
  const sys = irToChatBody(ir, 'gpt-5.6-sol').messages.find(m => m.role === 'system').content;
  assert.ok(!sys.includes('web_search'), `a server tool was named: ${sys}`);
});

// native never touches the system prompt, and that is a contract with the people who chose it; off
// sends no reasoning parameters at all, and a tool name is neither.
test('native and off add nothing, whatever the caller declared', () => {
  assert.equal(noticeIn('', ['Read', 'Bash'], { thinkingMode: 'native' }), '');
  assert.equal(noticeIn('', ['Read', 'Bash'], { thinkingMode: 'off' }), '');
});

// The notice and the think guide are two different instructions about two different things, and a
// non-reasoning model that was asked to think gets both.
test('the notice and the think guide coexist', () => {
  const ir = anthropicToIR({
    model: 'gpt-4o', messages: [{ role: 'user', content: 'go' }],
    thinking: { type: 'enabled', budget_tokens: 2048 },
    tools: [{ name: 'Read', input_schema: { properties: {} } }, { name: 'Bash', input_schema: { properties: {} } }]
  });
  const sys = irToChatBody(ir, 'gpt-4o').messages.find(m => m.role === 'system').content;
  assert.ok(sys.includes('<think> and </think>'), `the think guide is missing: ${sys}`);
  assert.match(sys, /use exactly these names/i);
});

// Tool names longer than 64 characters (e.g. MCP plugin tools) must be sanitized for OpenAI/Gemini
// APIs (<= 64 chars, ^[a-zA-Z0-9_-]{1,64}$) and mapped back in responses.
test('sanitizeToolName: enforces 1-64 character length and valid identifier charset', () => {
  assert.equal(sanitizeToolName('Bash'), 'Bash');
  assert.equal(sanitizeToolName('Read'), 'Read');
  assert.equal(sanitizeToolName('mcp__github__create_issue'), 'mcp__github__create_issue');

  const name64 = 'a'.repeat(64);
  assert.equal(sanitizeToolName(name64), name64);

  // Exact problematic tool from chrome-devtools MCP (70 chars)
  const chromeDevToolsTool = 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_console_messages';
  assert.equal(chromeDevToolsTool.length, 70);
  const sanitized = sanitizeToolName(chromeDevToolsTool);
  assert.ok(sanitized.length <= 64, `length must be <= 64, got ${sanitized.length}`);
  assert.equal(sanitized.length, 64);
  assert.match(sanitized, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.ok(sanitized.startsWith('mcp__plugin_chrome-devtools-mcp_'));
  assert.ok(sanitized.endsWith('_list_console_messages'));

  // Another long tool with different suffix gets a distinct hash
  const networkTool = 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_network_requests';
  const sanitizedNetwork = sanitizeToolName(networkTool);
  assert.equal(sanitizedNetwork.length, 64);
  assert.notEqual(sanitized, sanitizedNetwork);

  // allowHyphens: false for Vertex/Gemini
  const vertexSanitized = sanitizeToolName(chromeDevToolsTool, { allowHyphens: false });
  assert.equal(vertexSanitized.length, 64);
  assert.match(vertexSanitized, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
  assert.ok(!vertexSanitized.includes('-'));
});

test('createToolVocab: round-trips >64 char tool names back to client declared name', () => {
  const longName = 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_console_messages';
  const ir = anthropicToIR({
    model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'check console' }],
    tools: [
      { name: longName, input_schema: { properties: { count: { type: 'number' } } } }
    ]
  });

  const vocab = createToolVocab(ir.tools);
  const upstreamSafe = sanitizeToolName(longName);
  assert.notEqual(upstreamSafe, longName);
  assert.equal(upstreamSafe.length, 64);

  // Model answers with the sanitized name -> vocab recovers original declared name
  assert.equal(vocab.name(upstreamSafe), longName);
  assert.ok(vocab.isShortened(upstreamSafe));

  // Streaming does not hold arguments for shortened names (they keep caller's schema)
  const deltas = [];
  const renderer = createAnthropicStream((event, data) => deltas.push({ event, data }), 'claude-opus-4-6', { vocab });
  renderer.start();
  renderer.tool({ index: 0, id: 'call_1', name: upstreamSafe, args: '{"count": 10}' });
  renderer.finish('stop');

  const startBlock = deltas.find(d => d.event === 'content_block_start');
  assert.equal(startBlock.data.content_block.name, longName);

  const jsonDelta = deltas.find(d => d.event === 'content_block_delta' && d.data.delta.type === 'input_json_delta');
  assert.ok(jsonDelta, 'input_json_delta should be emitted');
  assert.equal(jsonDelta.data.delta.partial_json, '{"count": 10}');

  // Non-streaming builder also restores the original name
  const msg = buildAnthropicMessage({
    model: 'claude-opus-4-6',
    tools: [{ index: 0, id: 'call_1', name: upstreamSafe, args: '{"count": 10}' }],
    finish: 'tool_calls',
    vocab
  });
  const toolUse = msg.content.find(c => c.type === 'tool_use');
  assert.equal(toolUse.name, longName);
});

test('irToChatBody: serializes long tool names, assistant history, and toolChoice within 64 chars', () => {
  const longName = 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_console_messages';
  const ir = anthropicToIR({
    model: 'gpt-4o',
    messages: [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: longName, input: { count: 5 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] }
    ],
    tools: [
      { name: longName, input_schema: { properties: { count: { type: 'number' } } } }
    ]
  });
  ir.toolChoice = { name: longName };

  const body = irToChatBody(ir, 'gpt-4o');

  // Declared tools must have <=64 char function names matching regex
  assert.ok(body.tools && body.tools.length === 1);
  const toolFn = body.tools[0].function;
  assert.ok(toolFn.name.length <= 64);
  assert.match(toolFn.name, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(toolFn.name, sanitizeToolName(longName));

  // Assistant turn in history must have its tool call name shortened too
  const asstMsg = body.messages.find(m => m.role === 'assistant');
  assert.ok(asstMsg && asstMsg.tool_calls && asstMsg.tool_calls.length === 1);
  assert.equal(asstMsg.tool_calls[0].function.name, sanitizeToolName(longName));

  // toolChoice must be shortened
  assert.equal(body.tool_choice.function.name, sanitizeToolName(longName));
});
