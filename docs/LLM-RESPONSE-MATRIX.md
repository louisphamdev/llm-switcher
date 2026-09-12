# LLM Provider Response Matrix

How different LLM APIs shape their responses — and how `llm-switcher`
normalizes them. Companion machine-readable file: [`response-matrix.json`](response-matrix.json).

## Method

- **Live-sampled (primary):** 48 responses from an OpenAI-compatible gateway
  (9Router, 2026-09-12): **8 backend families × 6 variants**
  (`base-stream`, `think-stream`, `think-nostream`, `tool-stream`,
  `trunc-stream` with `max_tokens: 40`, `effort-stream` with
  `reasoning_effort: high`). Reasoning prompts were used on purpose —
  trivial prompts (e.g. "pong") often produce **no** thinking trace at all.
- **Doc-based (secondary):** OpenRouter reasoning docs, Vertex AI
  `generateContent` REST shape, OpenAI/Anthropic API references — used to
  cover field names this gateway never emits (e.g. `reasoning_details[]`,
  Vertex `thought` parts, `thoughtSignature`).

No credentials or personal data appear in the samples.

## TL;DR

| # | Finding |
|---|---|
| 1 | Same gateway, different field names per backend: `reasoning_content` (claude/openai/nvidia/gemini-stream), `reasoning` + `reasoning_content` **duplicated** (zai), nothing at all (qwen/plain). |
| 2 | **Non-streaming drops hidden thinking** on most backends — only `content` (+ token counters) comes back. Streaming is the only reliable way to get thinking blocks. |
| 3 | Usage shapes differ: single total chunk (OpenAI-style), per-token deltas (Cloudflare-style `qwen`/`zai` with `neurons`), or **absent in stream** (`gpt-oss` family) — count deltas manually as fallback. |
| 4 | `finish_reason` may arrive in the **first** chunk (qwen) or repeat per chunk; always take the **last** non-null value. |
| 5 | Tool calls may stream split across chunks (qwen: 6 chunks) or whole; args may be `string` (OpenAI) or `object` (Vertex `functionCall.args`). |
| 6 | Request-side: thinking budgets `< 1024` are rejected (400); `reasoning_effort` is rejected by some backends (503 `INVALID_ARGUMENT` on `gpt-oss`); gateways cool down after bad requests (`reset after Ns`). |

## 1. Envelopes

### 1.1 OpenAI Chat Completions (most common)

Non-stream:
```json
{"id":"chatcmpl-...","object":"chat.completion","created":1789184460,"model":"...claude-opus-4-6-thinking",
 "choices":[{"index":0,"message":{"role":"assistant","content":"pong"},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":2043,"completion_tokens":15,"total_tokens":2058}}
```

Stream (`data:` lines, terminal `[DONE]`):
```
data: {"...","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}
data: {"...","choices":[{"index":0,"delta":{"reasoning_content":"p"},"finish_reason":null}]}
data: {"...","choices":[{"index":0,"delta":{"content":"p"},"finish_reason":null}]}
data: {"...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{...}}
data: [DONE]
```

### 1.2 Vertex `generateContent` (native)

Non-stream:
```json
{"candidates":[{"content":{"role":"model","parts":[
   {"text":"plan...","thought":true,"thoughtSignature":"..."},
   {"text":"answer"},
   {"functionCall":{"name":"calc","args":{"expr":"2+2"}}}]},
  "finishReason":"STOP"}],
 "usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,"totalTokenCount":30}}
```
Stream (`:streamGenerateContent?alt=sse`): same objects as `data:` lines, incremental parts.

### 1.3 Anthropic Messages (native target)

```json
{"id":"msg_...","type":"message","role":"assistant","model":"...",
 "content":[{"type":"thinking","thinking":"...","signature":"..."},
            {"type":"text","text":"..."},
            {"type":"tool_use","id":"...","name":"...","input":{}}],
 "stop_reason":"end_turn",
 "usage":{"input_tokens":0,"output_tokens":0}}
```

### 1.4 OpenRouter extensions (doc-based)

- `message.reasoning` / `delta.reasoning` (plain string; `reasoning_content` is an accepted alias).
- `message.reasoning_details[]` / `delta.reasoning_details[]` with typed items:
  `reasoning.text {text, signature}`, `reasoning.summary {summary}`,
  `reasoning.encrypted {data}` (+ `id`, `format`, `index`).
- Request: unified `reasoning: {effort | max_tokens, exclude, enabled}`;
  Anthropic minimum budget **1024**; Gemini 3 uses `thinkingLevel`
  (`minimal|low|medium|high`) instead of token budgets.

## 2. Reasoning / thinking — where it actually appears (live)

`R` = `reasoning_content`, `r` = `reasoning`, `–` = absent.

| Backend | base-stream | think-stream | think-nostream | tool-stream | trunc-stream |
|---|---|---|---|---|---|
| claude-budget (opus-4-6-thinking) | R | R | – (content only!) | R + tools | R |
| claude-adaptive (sonnet-4-6) | – | – | – | tools, no R | – |
| gemini (3.8-flash-high) | R (hard tasks only) | R | – (+`reasoning_tokens` counter) | tools, no R | R |
| openai (gpt-oss-120b) | R | R | – | R + tools | R, no content |
| qwen (qwq-32b) | – (CoT leaks into `content`) | – | – (long CoT as content) | tools split ×6 chunks | – |
| zai (glm-4.7-flash) | R **and** r (same text twice!) | R + r | R + r, `content: null` | R + r + tools | R + r |
| nvidia (nemotron) | R (no usage in stream!) | R | – | R + tools | R |
| plain (gpt-4o-mini) | – | – | – (+`padding` junk field) | tools | – |

Notes:
- Gemini emits `R` as **one big chunk** (not token-split); others stream it token by token.
- Easy prompts may yield zero thinking even on thinking-capable models, while
  `reasoning_tokens` in usage still counts hidden work.
- `zai` duplicates every reasoning delta under both keys — parsers must take the
  **first** match, never concatenate.

## 3. Tool calls (live)

| Backend | Shape |
|---|---|
| OpenAI-style | `tool_calls: [{id, type:"function", function:{name, arguments:"{...}"}}]`, whole or split across chunks |
| qwen | same shape, but split across ~6 delta chunks; `finish_reason:"stop"` repeats per chunk |
| zai | same shape + duplicated reasoning alongside |
| Vertex native | `parts: [{functionCall:{name, args:{...}}}]` (args is an **object**), no id |
| plain (gh) | same shape; stream interleaves `content:null` chunks |

Missing ids are synthesized as `call_<ts>_<index>`; args objects are stringified
for OpenAI-shaped outputs and parsed back to objects for Anthropic/Vertex outputs.

## 4. Usage accounting (live)

| Backend | Stream usage | Keys |
|---|---|---|
| claude/adaptive/gemini/plain | one final chunk | `prompt_tokens, completion_tokens, total_tokens` (+ `completion_tokens_details.reasoning_tokens` on gemini, `prompt_tokens_details.cached_tokens` where cached) |
| qwen/zai (Cloudflare) | **every** chunk | per-token deltas (`completion_tokens: 1` × N) + `neurons`, sometimes `estimated`; prompt total only on first chunk |
| nvidia | `usage: null` per chunk, one real total at end (`estimated` flag) | same keys as OpenAI-style |
| openai (gpt-oss) | **none in stream** | count deltas manually |

Rule used by the proxy: `prompt = MAX(seen)`, `completion = MAX(SUM(deltas), LAST)`,
fallback to locally counted deltas when upstream sends nothing.

## 5. Finish reasons, ids, errors (live)

- Observed `finish_reason`: `stop`, `tool_calls`, `length` (also `STOP`/`MAX_TOKENS`/`SAFETY…` on Vertex-native). Mapping: `stop→end_turn`, `length→max_tokens`, `tool_calls→tool_use` (Anthropic); `STOP/MAX_TOKENS/SAFETY` (Vertex output).
- If any tool call was seen, the final stop is forced to `tool_use` regardless.
- Id prefixes vary (`chatcmpl-`, `chatcmpl-msg_`, `chatcmpl-req_`, `id-…`); outputs are normalized to `msg_` / `chatcmpl-` / `resp_` per client protocol.
- Error envelope: `{"error":{"message":"[backend/model] [400]: {...} (reset after Ns)"}}` — note the cooldown hint; back off instead of retrying hot.
- Junk to ignore: `padding`, `copilot_usage`, `service_tier`, `system_fingerprint`, `logprobs`, `neurons`, `estimated`, `refusal`, `annotations`, `audio`, `token_ids`, empty `choices: []` chunks, doubled `[DONE]`.

## 6. Request-side gotchas (live)

- `thinking: {type:"enabled", budget_tokens:<1024}` → HTTP 400. Clamp to ≥ 1024.
- `reasoning_effort: "high"` → HTTP 503 `INVALID_ARGUMENT` on `gpt-oss`-class backends. Only send effort levels the backend accepts.
- `include_reasoning: true` (legacy) is accepted but changes nothing observable.
- Omitting `stream` defaults to **streaming** on some gateways — always send it explicitly.
- `stream_options: {include_usage:true}` is required by spec for stream usage, though some gateways send usage anyway.

## 7. How the proxy maps this (`formats.mjs`)

- `smartReasoning / smartText / smartToolCalls / smartUsage / smartFinish` — accept every field name above, first-match wins (no double-count).
- `normalizeUpstream(parsed, outFormat)` — one SSE chunk **or** one full JSON → canonical events `{think, text, tools, finish, usage}`; also walks native Anthropic event types and Vertex `candidates`.
- Renderers emit the client protocol: `createAnthropicStream` (thinking+signature → `thinking_delta`, `<think>`-tag fallback with split-tag buffering), `createChatStream` (`reasoning_content` extension), `createResponsesStream` (Codex reasoning summary + deltas), `createVertexStream` (`thought` parts + `thoughtSignature` passthrough when genuine).
- Known non-goals: hidden thinking that the backend never returns (gemini non-stream counters, qwen CoT-in-content) cannot be recovered; encrypted `reasoning.encrypted.data` blobs are skipped as thinking text.

## 8. Reproduce

Send the same prompt matrix (`base/think/nostream/tool/trunc/effort` × `stream on/off`)
against any OpenAI-compatible `/chat/completions` endpoint and record, per chunk,
`delta` key sets, reasoning/text presence, `finish_reason` sequence, usage key
sets, and id prefixes. A reasoning-heavy prompt is required — trivial prompts
often yield no thinking trace. Never commit keys; keep sampler scripts out of
the repo.
