import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskHalf } from '../contract.mjs';

// The 16 leaks of the 1.1.4 report, plus the positions 1.1.4 already covered. A marker anywhere in a
// value must not survive, whatever the key; only the enum values intact's reducer reads may stay.
const M = (tag) => `LEAK_${tag}`;
const cases = {
  anthropic_citation: { content: [{ type: 'text', text: 'x', citations: [{ type: 'char_location', cited_text: M('cited_text'), document_title: M('document_title') }] }] },
  anthropic_document: { messages: [{ role: 'user', content: [{ type: 'document', title: M('doc_title'), context: M('doc_context'), source: { type: 'text', media_type: 'text/plain', data: M('doc_data') } }] }] },
  anthropic_web_result: { content: [{ type: 'web_search_tool_result', tool_use_id: 't', content: [{ type: 'web_search_result', url: M('url'), title: M('web_title'), encrypted_content: M('enc') }] }] },
  anthropic_thinking: { content: [{ type: 'thinking', thinking: M('thinking'), signature: 'SIG_opaque' }] },
  anthropic_system_blocks: { system: [{ type: 'text', text: M('system_block') }] },
  anthropic_stop: { stop_sequences: [M('stop_seq')], stop_sequence: M('stop_sequence_resp') },
  openai_logprobs: { choices: [{ logprobs: { content: [{ token: M('token'), top_logprobs: [{ token: M('top_token') }] }] } }] },
  openai_name: { messages: [{ role: 'user', name: M('participant_name'), content: 'x' }] },
  openai_tool_msg: { messages: [{ role: 'tool', tool_call_id: 'c1', content: M('tool_content') }] },
  responses_annotation: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'url_citation', url: M('ann_url'), title: M('ann_title') }] }] }] },
  responses_websearch: { output: [{ type: 'web_search_call', action: { type: 'search', query: M('search_query') } }] },
  responses_input_items: { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: M('input_text') }] }, { type: 'function_call_output', call_id: 'c', output: M('fc_output') }, { type: 'input_file', filename: M('filename'), file_data: M('file_data') }] },
  gemini_filedata: { contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'application/pdf', fileUri: M('fileUri') } }, { text: M('gemini_text') }] }] },
  gemini_func: { contents: [{ parts: [{ functionCall: { name: 'f', args: { q: M('fc_args') } } }, { functionResponse: { name: 'f', response: { r: M('fr_resp') } } }] }] },
  error_echo: { type: 'error', error: { type: 'invalid_request_error', message: M('error_message') } },
  tool_desc: { tools: [{ name: 'Bash', description: M('tool_description'), input_schema: { type: 'object' } }] },
  // An enum key does not keep free text: a value with a space, or one under user data, is masked.
  enum_free_text: { type: `${M('type_text')} with space`, metadata: { type: M('meta_type') }, model: M('model_ok') },
  json_keys: { messages: [{ role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'f', arguments: JSON.stringify({ [M('arg_key')]: 1 }) } }] }] }
};

for (const [name, obj] of Object.entries(cases)) {
  test(`no marker survives: ${name}`, () => {
    const out = maskHalf(JSON.stringify(obj));
    const left = (out.match(/LEAK_[A-Za-z_]+/g) || []).filter((m) => m !== 'LEAK_model_ok');
    assert.deepEqual(left, [], out);
  });
}

test('the enum values the reducer reads stay as sent', () => {
  const out = JSON.parse(maskHalf(JSON.stringify({
    model: 'claude-opus-4-6', type: 'message', role: 'assistant', stop_reason: 'end_turn', object: 'chat.completion',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 3 }
  })));
  assert.equal(out.model, 'claude-opus-4-6');
  assert.equal(out.type, 'message');
  assert.equal(out.role, 'assistant');
  assert.equal(out.stop_reason, 'end_turn');
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.content[0].type, 'tool_use');
  assert.equal(out.usage.input_tokens, 3);
  assert.match(out.content[0].name, /^x+$/);
});

test('SSE with CRLF and a non-JSON data line leaks nothing', () => {
  const sse = 'event: message_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"LEAK_sse_text"}}\r\n\r\ndata: not json LEAK_sse_raw\n\n';
  const out = maskHalf(sse);
  assert.ok(!/LEAK_/.test(out), out);
  assert.ok(out.includes('"text_delta"'));
});
