# Changelog — LLM Switcher

## Release 1.2.0

- **Zero-Mutation Interceptor Invariant:** The gateway now operates strictly in the network path via the blindfold interceptor, never modifying user configuration files like `~/.claude/settings.json` or `~/.codex/config.toml`. Loopback base URLs (`ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`) are scrubbed by shims so traffic routes through `HTTPS_PROXY` cleanly.
- **Concurrent Multi-Tool Support (`claude` & `codex`):** `activeProfiles` in `config.json` now configures `{ claude, codex }` independently. Switching tools updates the interceptor dynamically over `POST /_control/active-tools` without dropping in-flight connections or restarting ports.
- **Auto-Discovery & Dynamic Model Catalog:** Automatically discovers official models for Claude Code & Codex; detects tool version updates and refreshes mappings on the fly (`switch models`).
- **Automated Configuration Migration:** Legacy configurations with single `activeProfile` or legacy format keys are atomically migrated on startup with automatic backup (`config.json.bak-*`) and CAS protection.
- **Gemini / Vertex Schema Healing:** Empty tool input schemas (`{}`) are automatically normalized to valid JSON schema objects with type definition before forwarding upstream, eliminating HTTP 400 schema rejection errors.
- **Windows Shim Reliability:** Windows `.cmd` launcher shims enforce strict CRLF formatting, preventing cmd.exe label lookup offsets (`SCRUB_TIER`), and reference the certificate bundle at `blindfold/certs/ca.pem`.
- **Refreshed Web UI:** Modernized dashboard with real-time target indicators, tool-specific profiles, and model context-window tracking.

## Release 1.1.10

- **Self-improvement with intact:** Integration with intact credential proxy and contract lab.

## Release 1.1.9

- **Dashboard:** Open `http://127.0.0.1:3456/ui` directly. The page carries the admin token securely.

## Release 1.1.8

- **Claude Code tools:** Fixed tool schema values of `0`, `false`, `""` or `null` being converted to empty object schemas, resolving Gemini HTTP 400 errors.
- **Shim PATH order:** Improved PATH order diagnostic in `switch shim status` and `switch doctor`.

## Release 1.1.7

- **Codex tools:** Model catalog keeps Codex in direct tool mode; reads tools from `additional_tools` input items.

## Release 1.1.6

- **Codex over WebSocket:** Gateway tracks WebSocket sessions. Multi-turn sessions using `previous_response_id` retrieve earlier turns seamlessly.
- **Codex warmup:** `response.create` with `generate: false` answered locally without spending model calls.
- **Codex model name:** Fixed false "high-risk cyber activity" warnings by stopping unwanted `OpenAI-Model: main` headers.

## Release 1.1.5

- **Contract lab privacy:** Masking allowlist ensures all client prompts, code, and files are completely redacted before uploading samples.

## Release 1.1.4

- **Contract lab privacy:** Initial client-side masking implementation.

## Release 1.1.3

- **Dashboard:** Improved access token error messaging and reorganized model settings.

## Release 1.1.2

- **npm package:** Released as global npm package `llm-switcher`.
- **LibreSSL compatibility:** Added macOS default LibreSSL support for certificate generation.
