# Token Optimizer Interoperability & Failure Mode Report

**How LLM Switcher acts as the protective outermost edge gateway for aggressive prompt/token optimizers (Headroom, RTK, Ponytail).**

---

## Executive Summary

Third-party prompt optimizers and token compressors — such as **Headroom**, **RTK (Rust Token Killer)**, and **Ponytail** — attempt to reduce LLM input tokens by aggressively pruning message history, truncating command stdout, or forcing extreme prompt brevity.

While these tools can reduce raw token counts in simple scenarios, **they frequently break complex agentic coding workflows** by corrupting message graphs, orphaning tool calls, and stripping reasoning parameters. When these pruned payloads hit upstream APIs directly (such as Anthropic, OpenAI, or 9Router), the provider immediately throws fatal `HTTP 400 Bad Request` errors or severely degrades reasoning depth.

**LLM Switcher solves this by acting as the outermost edge gatekeeper (`127.0.0.1:3456`).** It intercepts the pruned payload before it leaves your machine, runs its built-in **Healer Engine** to repair message graphs and restore reasoning parameters, unlocks 1M context windows, and safely converts the protocol to your upstream provider.

---

## Tool Breakdown: What They Do & How They Break Payloads

### 1. Headroom (`headroomlabs-ai/headroom`)
- **Mechanism:** Runs as a local proxy on `:8787` (or wraps CLI agents). Compresses conversation history, RAG chunks, and tool outputs using SmartCrusher (JSON), CodeCompressor (AST), and Kompress-v2-base. Also attempts "effort routing" to dial down thinking budgets.
- **Critical Failure Points:**
  - **Orphaned `tool_result` blocks:** When pruning historical turns, Headroom often discards the `assistant` turn containing a `tool_use`, while retaining the subsequent `user` turn containing the `tool_result`. Anthropic's API strictly validates tool use IDs and crashes with:
    ```
    HTTP 400 invalid_request_error: "tool_use_id 'xxx' does not correspond to any tool_use"
    ```
  - **Consecutive `user` turns:** Dropping intermediary assistant turns causes multiple user messages to sit adjacent to each other. Anthropic strictly throws:
    ```
    HTTP 400 invalid_request_error: "roles must alternate between 'user' and 'assistant'"
    ```
  - **Reasoning Suppression:** Its "effort routing" dials down `thinking.budget_tokens` on routine tool turns. On complex models (Claude Opus, Gemini Flash), this prevents the model from formulating multi-step reasoning before acting.

### 2. RTK (`rtk-ai/rtk` - Rust Token Killer)
- **Mechanism:** A single Rust binary that hooks into shell tool execution (e.g. `PreToolUse` in Claude Code / Cursor) and rewrites CLI commands (`git`, `ls`, `cat`, `grep`, `pytest`) to filter out noise, truncate lines, and inject recall tokens (`[full output: rtk recall xxx]`).
- **Critical Failure Points:**
  - **Corrupted Structural Data:** When an agent invokes a tool expecting machine-readable JSON or exact AST formatting, RTK's heuristic summaries can alter structural delimiters, causing downstream tool call parsing errors.
  - **Custom Tracking Headers:** RTK and associated tracing proxies inject headers (`x-rtk-*`, `traceparent`, `x-optimizer-id`) that some strict upstream endpoints reject if not cleanly forwarded.

### 3. Ponytail (`DietrichGebert/ponytail`)
- **Mechanism:** A behavioral prompt engineering plugin/ruleset that injects extreme conciseness instructions ("write one line, it works, YAGNI") into agent system prompts across 20+ coding tools.
- **Critical Failure Points:**
  - **Premature Execution without Reasoning:** By commanding the model to be maximally brief and avoid planning, reasoning models are discouraged from spending thinking tokens. The model outputs untested single-liners that often fail type checks and test suites.
  - **System Prompt Prefix Invalidation:** Injected rules alter the leading system prompt bytes, busting provider prompt caches unless carefully aligned.

---

## The Healer Engine: How LLM Switcher Protects the Workflow

LLM Switcher sits between the optimizer tool and the upstream LLM:

```
[CLI Agent] ──> [Optimizer: Headroom / RTK] ──> [LLM Switcher :3456] ──> [Upstream / 9Router]
                                                 │
                                                 ├── 1. Heal Orphaned tool_results
                                                 ├── 2. Merge Consecutive Turns
                                                 ├── 3. Restore Stripped Thinking
                                                 └── 4. Enforce 1M Context
```

### Protection Matrix: Before vs. After

| Scenario | Direct to Upstream (Without Switcher) | Through LLM Switcher (Healer Engine) |
|---|---|---|
| **Orphaned `tool_result` turn** | ❌ **HTTP 400 Crash**: `tool_use_id does not correspond to any tool_use` | ✅ **HTTP 200 OK**: Heals orphaned result into contextual text block `[Tool Result (id)]: ...` |
| **Consecutive `user` turns** | ❌ **HTTP 400 Crash**: `roles must alternate` | ✅ **HTTP 200 OK**: Merges consecutive turns into a single valid turn seamlessly |
| **Stripped `thinking` parameters** | ⚠️ **Degraded AI**: Reasoning disabled, model outputs shallow single-liners | ✅ **HTTP 200 OK**: Detects reasoning models and automatically restores safe thinking budget |
| **Orphaned `tool` role in Chat API** | ❌ **HTTP 400 Crash**: `tool role must respond to tool_calls` | ✅ **HTTP 200 OK**: Converts orphaned tool message into user context |
| **Custom tracking headers** | ⚠️ Connection dropped / unrecognized header warnings | ✅ **HTTP 200 OK**: Cleanly passes through `traceparent`, `x-request-id`, `x-rtk-*` |

---

## Test Methodology & Verification Suite

We created an automated verification suite in [`tests/live-optimizer-interop.mjs`](../tests/live-optimizer-interop.mjs) that systematically replicates the failure modes of each tool:

### Running the Test Suite
```bash
node tests/live-optimizer-interop.mjs
```

### Live Test Results
```text
================================================================
  LLM SWITCHER — TOKEN OPTIMIZER INTEROPERABILITY TEST SUITE   
  Simulating failure modes from Headroom, RTK, and Ponytail    
================================================================

[TEST] Headroom Simulation: Orphaned tool_result turn... PASS (8840ms)
       ↳ Healed orphaned tool_result. Response HTTP 200: "It looks like you've shared a fragment of context ..."
[TEST] Headroom Simulation: Consecutive User turns (Role alternation violation)... PASS (2683ms)
       ↳ Merged consecutive turns seamlessly. Stop reason: end_turn
[TEST] Thinking Guard: Restoring stripped thinking parameter on reasoning models... PASS (5372ms)
       ↳ Automatically restored thinking: thinking_delta=true, signature_delta=true, text_delta=true
[TEST] RTK Intermediary: Custom headers and traceparent passthrough... PASS (2453ms)
       ↳ Headers accepted cleanly with HTTP 200 OK
[TEST] OpenAI Chat Healer: Orphaned role tool without preceding assistant tool_calls... PASS (1561ms)
       ↳ Chat Healer rescued orphaned tool role. Stop reason: length

================================================================
  TEST RESULTS: 5 PASSED / 0 FAILED               
================================================================
```

---

## Recommended User Setup

For developers using prompt optimization tools:
1. Keep the optimizer installed in your CLI tool as usual.
2. In the optimizer's configuration (e.g. `headroom.yaml` or RTK upstream settings), set the upstream target URL to **LLM Switcher** (`http://127.0.0.1:3456`).
3. Enjoy prompt compression savings without worrying about broken conversation graphs, HTTP 400 crashes, or lost reasoning depth.
