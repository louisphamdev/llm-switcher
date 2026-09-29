# Changelog — LLM Switcher

## Release 1.2.4

- **Codex blindfold starts on a new machine:** A switch to a Codex profile stopped with "ca.pem is missing" on every new data directory. The certificates came only from `make-certs.sh`, which needs bash and OpenSSL. Now the switcher builds the same set with Node's crypto before it does any other check. It builds a new leaf when the leaf is missing, does not cover the three hosts, or does not match its key. It keeps a CA that still works, because Codex already trusts it.
- **1M context follows the real window:** The model list in the dashboard now reads the token limits that the gateway gives (`context_length`, `max_input_tokens`, `max_output_tokens`). When a model has a known window of less than 1M, the **1M context** box of its slot is cleared and locked. The reason shows under the field. When the gateway gives no window, the box stays free and shows a warning when it is ticked.
- **Tests:** A suite run no longer leaves an interceptor process running. Two tests that failed only on a loaded machine now pass: one waited for a lock that was already gone, and one lost its port to a test file that ran at the same time.

## Release 1.2.3

- **Update notice:** The dashboard sidebar shows the running version. When npm has a newer release, a notice shows the update command with a copy button. The new command `switch version` prints the same information. The switcher asks the npm registry at most once in 12 hours. Without an answer, no notice shows.
- **Codex daemon follows the route:** The interactive Codex TUI talks to a shared `codex app-server` daemon, and that daemon keeps the environment that it started with. As a result, the TUI bypassed the gateway after a switch. Now each change of the Codex route restarts the running daemon with the new variables. When no daemon runs, nothing starts.
- **API keys stay with their host:** A catalog refresh sent the key of the active profile to the official Anthropic and OpenAI model lists. Now a key goes only to the host of its own profile.
- **Real model catalog:** The catalog reads the model list that Codex and Claude Code keep on disk for the signed-in account. A failed refresh no longer marks the tool version as done, so the next request tries again.
- **Dashboard saves:** Every write action reported a failure after it succeeded, because the page read `ok` and the server sends `success`. Enter in a field no longer saves a half-edited profile. A text selection that ends outside the dialog no longer closes it.
- **Model slots:** Each slot is a searchable list of the provider models. The list loads when you open the Model Slots tab and sends the saved key. A profile without `outFormat` keeps it empty after a save.
- **Other fixes:** `make-certs.sh` works when the path contains a dot. `switch doctor` warns again about a Codex profile without `publicModels`. Three dashboard controls have an accessible name.
- **Tests:** The tests use the 1.2 configuration schema, never read the certificates of the checkout, and never reach the real Codex daemon, npm registry, or `claude` binary.

## Release 1.2.2

- **Structured output reaches every upstream:** A request that asks for JSON that matches a schema now keeps that schema. Before this release, the gateway did not read `output_config.format` (Claude Code) or `text.format` (Codex), so the provider got a free-text request. The schema now goes to the provider as `response_format` (OpenAI Chat), `output_config.format` (Anthropic), or `responseMimeType` with `responseSchema` (Gemini and Vertex). A request for JSON without a schema reaches Anthropic as plain text, because Anthropic has no JSON mode without a schema.

## Release 1.2.1

- **Intact Visual Architecture & Hash Routing:** Fully restructured dashboard using Intact design system, pure CSS tokens, and hash-based client routing (`#/routes`, `#/models`, `#/logs`, `#/doctor`).
- **Official Brand Icon Assets:** Integrated official brand icons for Anthropic Claude, OpenAI Codex, Google Gemini, Intact, OpenRouter, and Ollama, served statically under `/icons/*` with immutable caching and PNG/SVG whitelisting.
- **Prefetched Navigation Counters:** Navigation badges prefetch model discovery and request inspector counts immediately on page load, eliminating the delay where badges showed zero until the tab was selected.
- **Hardened Profile Slot Mapping:** Synchronized Claude model tiers (`sonnet`, `opus`, `haiku`, `fable`) and Codex model roles (`main`, `review`, `subagent`), ensuring slot persistence when editing profiles and removing redundant role tabs for Claude-targeted profiles.
- **CORS & Endpoint Fixes:** Added `x-llm-switcher-token` to preflight `Access-Control-Allow-Headers` and resolved routing precedence for `GET /api/catalog`.

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
