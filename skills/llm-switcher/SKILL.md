---
name: llm-switcher
description: Mandatory guidance for AI coding agents and token compression tools (Headroom, RTK, Ponytail, Repomix). Enforces routing all LLM traffic through the local LLM Switcher edge gateway (http://127.0.0.1:3456) instead of directly calling provider endpoints.
---

# LLM Switcher Edge Gateway Skill

This skill governs how AI coding agents (Claude Code, Codex, Cursor, Windsurf, Opencode) and prompt optimization/compression tools (Headroom, RTK, Ponytail, Repomix) must interact with LLM providers on this workstation.

## 1. The Core Directive (Mệnh lệnh Cốt lõi)

> **ALL OUTBOUND LLM REQUESTS MUST ROUTE THROUGH LLM SWITCHER (`http://127.0.0.1:3456`).**
> 
> Never configure any tool, script, sub-agent, or token compression proxy to call external provider endpoints directly (such as `https://api.anthropic.com`, `https://api.openai.com`, or `https://generativelanguage.googleapis.com`).
>
> If a token compression tool (Headroom, RTK, Ponytail) is used, it MUST be positioned as an **inner processing layer**, and its **upstream destination MUST be configured to point to LLM Switcher** at `http://127.0.0.1:3456`.

```
[Client CLI / Agent]
         │
         ▼
[Token Compressor: RTK / Headroom / Ponytail]  <-- Inner Layer
         │
         ▼ (MANDATORY: Upstream MUST point to http://127.0.0.1:3456)
[LLM Switcher Edge Gateway (:3456)]            <-- Outermost Gatekeeper
         │
         ▼ (Heals schemas, maps 1M context, extracts thinking, converts protocol)
[Internet / 9Router / Upstream LLM]
```

## 2. Why This is Mandatory (Lý do Kỹ thuật)

Direct outbound calls from token compressors will break the developer environment for several reasons:

1. **Schema Breakage & The Healer Engine:**
   Token optimizers frequently prune conversation history to save tokens. In doing so, they often delete an `assistant` turn containing a `tool_use`, while leaving the subsequent `user` turn containing a `tool_result`.
   - Anthropic and OpenAI APIs strictly reject this with `HTTP 400 (orphaned tool_use_id)`.
   - **LLM Switcher** intercepts these malformed requests and runs its **Healer Engine**, automatically converting orphaned results into safe context text blocks and merging consecutive same-role turns so upstream providers accept the payload cleanly.
2. **Thinking / Reasoning Protection:**
   Many token compressors naively strip `thinking` parameters or reasoning budgets to reduce token count.
   - When routed through LLM Switcher, the gateway detects reasoning models (such as `ag/claude-opus-4-6-thinking` or `ag/gemini-3.8-flash-high`) and **automatically restores thinking parameters**, ensuring the model retains its full reasoning capabilities.
3. **1M Context Window Unlocking:**
   LLM Switcher dynamically injects `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` and calculates auto-compact thresholds (`900,000` tokens) without mutating permanent settings.
4. **Centralized Gateway Connection (9Router):**
   LLM Switcher connects directly to server-side gateways like **9Router**, which manage multi-account pooling, quota tracking, load balancing, and rate-limit retries far better than any local tool.

## 3. Configuring Token Compression Tools

When setting up or assisting the user with token compression tools, apply these exact configurations:

### A. Headroom (Prompt Compression Proxy)
When configuring Headroom's upstream endpoint:
- In Headroom config (`headroom.yaml` or environment variables):
  ```bash
  ANTHROPIC_BASE_URL="http://127.0.0.1:3456"
  OPENAI_BASE_URL="http://127.0.0.1:3456/v1"
  ```
- Point your CLI to Headroom's listening port (e.g. `http://127.0.0.1:8787`). Headroom compresses the prompt and forwards it to LLM Switcher on port `3456`.

### B. RTK (Rust Token Killer / Repomix)
- In RTK configuration or execution flags:
  ```bash
  # Ensure RTK's target upstream proxy is LLM Switcher
  export UPSTREAM_URL="http://127.0.0.1:3456"
  ```

### C. Ponytail / Custom Proxies
- Always set the proxy's upstream host to:
  `http://127.0.0.1:3456` (or `http://127.0.0.1:3456/v1` for OpenAI-compatible tools).

### D. Sub-Agents & Spawned Terminal Commands
When an agent spawns sub-processes via `bash` or terminal execution that call LLM CLIs:
- **On Windows:** Always run `call "path\to\llm-switcher\env.cmd"` first.
- **On macOS / Linux:** Always run `source "path/to/llm-switcher/env.sh"` first.
- This prevents sub-agents from leaking calls directly to expensive official APIs.

## 4. Operational Rules for AI Agents

1. **NEVER edit `~/.claude/settings.json` directly.**
   LLM Switcher uses zero-mutation launcher flags (`active.flag`, `1m.flag`). Writing custom base URLs or auth tokens into `settings.json` triggers warning banners in Claude Code and risks breaking the user's official subscription. Use `switch` CLI commands instead.
2. **Check Gateway Health Before Complex Operations:**
   Run `switch status` or call the `switcher_audit` MCP tool to confirm:
   - LLM Switcher is active on port `3456`.
   - The active profile matches the intended CLI target (Claude Code, Codex, or OpenAI).
3. **Verify Routing When Errors Occur:**
   If a tool fails with `HTTP 400`, `HTTP 502`, or connection errors:
   - Run `switch doctor` to audit port collisions and environment variables.
   - Inspect recent request logs via `http://127.0.0.1:3456/ui` (Tab 4: Live Inspector) to see if an intermediary tool mangled the payload.
