# Changelog — LLM Switcher

## Release 1.2.8

- **Launch notice:** A person opened `claude` or `codex`, and nothing on screen said that the switcher took the traffic. The shim now raises a notice at launch. On Windows it is a desktop toast, because both tools can claim the whole screen and hide a printed line. On Linux and macOS it is one line on stderr. The notice names the profile, the host, the model, and the 1M window.
- **Only a routed tool:** The notice appears only while that tool has a profile. A tool on its official endpoint stays silent. `switch off codex` empties `route-codex.txt`, and the codex shim then says nothing.
- **New files:** `route-claude.txt` and `route-codex.txt` hold the notice text. The switcher writes each one with the env file of the same tool. `notify-route.ps1` raises the toast, and it needs no PowerShell module.
- **Tests:** New tests prove the state files and the notice. One test runs the real `.cmd` shim through cmd.exe with a fake `powershell` on PATH. It reads what the shim asked for.
- **A second notice, inside the tool:** The shim notice needs the shim directory first on `PATH`. A person who keeps their own `claude` wrapper never sees it. `switch plugin install` adds a hook that runs inside each tool instead. It reports three states: routed and the gateway answers, routed and the gateway does not answer, and not routed. The second state used to appear only as a connection error with no cause.
- **No configuration file is opened:** Claude Code loads `~/.claude/skills/llm-switcher-status/` as a plugin on the next session, with no marketplace and no install step. Codex reads `~/.codex/hooks.json` by itself. `settings.json` and `config.toml` stay closed. An existing `~/.codex/hooks.json` is merged, and a file that does not parse is refused.
- **The notice is optional:** `switch plugin install` is a choice. Install nothing and the gateway still routes every request.

### Found by pressing the dashboard like a person

A pass over the running dashboard in a real browser, with real clicks and real keys, never a value
set through the page's own JavaScript. Each item below has a browser test that reproduces it.

- **A narrow window hid the navigation:** At 400 px the sidebar collapsed to its padding, 16 px, and the navigation was drawn outside it. No link could be pressed. The `@media` rule set `height: auto` but kept `overflow-y: auto` from the base rule, and a grid item that scrolls has an automatic minimum size of zero. The rule now resets `overflow`.
- **A card stayed in the editing state:** After Escape, Cancel or a press on the dark area, the card kept its ring and its button still read "Editing Profile". `closeProfileModal` never cleared the key that the render reads.
- **The keyboard stayed outside the dialog:** Opening a profile dialog left the focus on the button behind the overlay, so the first Tab walked into the page under the dialog. The dialog now takes the focus when it opens.
- **A connection result from the profile before:** A new profile opened showing the "HTTP 200 OK" and the latency of the profile opened before it. The three result fields are emptied on every open.
- **A double-click on Save sent two saves:** One double-click sent two `POST /api/save-profile`. The button is disabled while the request runs, the same way the catalog sync button already was.
- **A model search with no match looked broken:** Every row was hidden while the headers kept the counts of the full list, and nothing said why the list was empty. The count follows the filter now, and an empty result says so in words.
- **Tests:** Eight new browser tests, one for each finding. Two more findings from that pass did not reproduce under a real click and are kept as guards rather than reported as bugs.

### Linux and Node 18

- **Tests on Node 18 and 20:** `engines` accepts Node 18.17 and later, but four tests failed on Node 18 and Node 20. A global `WebSocket` client arrived in Node 22, and `zlib.zstdCompressSync` arrived in Node 22.15. The runtime code already tested for zstd before it used it, so only the tests assumed the newer runtime. The three WebSocket tests and the zstd assertion now skip when the runtime does not hold those APIs.
- **A zstd capture on an older runtime:** `DECODERS` mapped `zstd` to `zlib.zstdDecompressSync`, which is `undefined` before Node 22.15. The capture then wrote the compressed bytes as UTF-8 noise, and that noise is what the decoder table exists to prevent. The capture now holds `[capture: cannot decode zstd body of N bytes: zstd is not supported by this Node.js version]`.
- **`LLM_SWITCHER_HOME` and the background service:** The README gives `LLM_SWITCHER_HOME` as the override for the data folder, but `switch service install` did not copy it into the systemd unit or the launchd plist. The service then read a different `config.json` and a different `admin.token` than the command that installed it. The variable now goes into the unit with the other three.
- **Mode of the data folder:** The Quick Start created the data folder with `mkdir -p`, so a common umask left it readable by the group and by everyone. `state.mjs` applies mode 700 only when it creates the folder itself. The README now uses `mkdir -p -m 700`.
- **Notes for the Linux service:** The unit is a systemd user service, so it starts at login and not at boot. On a headless host, run `loginctl enable-linger $USER` first. `ExecStart` holds the path of the running Node binary. After you remove that Node version, run `switch service install` again.

### The profile switch

- **A backup with the API keys on every switch:** `setTargetProfile` and `activateProfile` still wrote the legacy `activeProfile` pointer. `needsMigration` reports any configuration that holds that key, so the next load migrated the file again and wrote another `config.json.bak-*`. Each backup is a full copy of `config.json`, with every provider API key, and the backups stayed after a success. Neither function writes the pointer now. `ensureActiveMap` already folds a legacy pointer into `activeProfiles`, and a load still migrates an old file once. Four switches left three backups before this change and none after it.
- **A placeholder profile activated without a warning:** With the unedited `config.example.json`, `switch on` printed `[SUCCESS]` and routed to `https://YOUR-ROUTER-HOST/v1`. Only `switch doctor` gave a warning. Activation now uses the same `hasPlaceholder` test as `doctor`, and it names the file to edit. Activation only warns and does not refuse, so a scripted setup still works.
- **Tests:** New tests cover the service environment keys, `hasPlaceholder`, and a migrated configuration that does not need migration again after a switch. One test pins the same invariant on `deleteProfile`, the third place that can write the legacy pointer.

### Ports, shells, and what the package serves

- **A second instance had no port for the interceptor:** `--port` and `LLM_SWITCHER_PORT` move the gateway through `resolvePort`, but `computeLaunchState` read the interceptor port from `config.json` alone. `LLM_SWITCHER_BLINDFOLD_PORT` reached a hand-started `blindfold.mjs` and nothing else. A gateway sent to 3457 also landed on the port of the interceptor. The interceptor port now follows the same precedence as the gateway port, and it moves off the gateway port when the two meet. The README names both variables together.
- **A fish user got a line that fish cannot run:** The PATH hint printed `export PATH="..."`, which is not fish syntax, and it named `~/.profile`, which fish does not read. The hint now names `~/.config/fish/config.fish` and gives `fish_add_path -m`. zsh and bash keep what they had.
- **`switch on` installs the shims:** The README gave `switch shim install` as a separate step. `switch on` already installs the shims and prints what it installed. The README now says so, and it names the one case that still needs the command: a set `LLM_SWITCHER_STATE_DIR`.
- **What the package says it serves:** The description, both README taglines and the dashboard subtitle gave OpenAI and Gemini as clients. This gateway accepts two clients, Claude Code and Codex, and `toIR` accepts no other input format. OpenAI, Anthropic and Vertex are upstreams. All four texts now say that.
- **A test that failed on a loaded machine:** The lock test released the lock 400 ms after it started the child, then asserted that the child waited 100 ms or more. A spawn plus an import measured 163 to 541 ms on Node 18, so the child sometimes found the lock gone. The test now counts the 400 ms from the moment the child reports its start, the same way the test below it does.

## Release 1.2.7

- **Save from the dashboard:** The dashboard sent `tool: "auto"` for a profile that serves both tools. The gateway refuses that value. As a result, a new profile with the default tool, four of the five templates, and a save of any both-tools profile all failed. Now the dashboard saves `tool: null` for such a profile. The Vertex AI template uses `claude`.
- **New profile with a used key:** A new profile with the key of an existing profile replaced that profile and its API key without a warning. Now the dashboard refuses the save and names the key.
- **Turn all routes on:** After you turned every route off, "Activate compatible routes" gave only one profile a route. Codex stayed on the official endpoint. Now each tool gets its own profile, the same way as the `target` form of `/api/toggle`.
- **Failed switch:** After a failed switch, the dashboard kept the state that the person had pressed. Now it reads the state from the gateway again, so the switch, the badges, and the file agree.
- **Element ids:** The sidebar and the page header both used the id `btn-toggle`. The header button is now `btn-toggle-routes`.
- **Unsaved changes:** The dashboard never asked before it threw away typed text. Now the close button, Cancel, a press on the dark area, and Escape ask "Discard unsaved changes?" when you typed something. A refresh of the state no longer wipes the text you are typing.
- **Save with no change:** Every save added `thinkingMode: "auto"` and an empty `model1M` to the profile. Now a save with no edit leaves the profile as it was.
- **Emptied slots:** A model slot that you emptied, and a 1M box that you cleared, came back after the save. Now the save keeps what the form shows.
- **Tests:** New browser tests press the real dashboard: routes, profile forms, model slots, connection test, delete, catalog, and request inspector. After each step they check that the page, the gateway, and `config.json` say the same. They need Chromium and a global `WebSocket` (Node 22 or newer). Without them, the tests skip. Set `LLM_SWITCHER_CHROMIUM` to use another browser binary.

## Release 1.2.6

- **Deactivate in the dashboard:** The Deactivate button did not change the configuration, but the dashboard showed "deactivated". The dashboard sends `deactivate: true` and the profile key in `profile`. The gateway read `deactivate` as the profile key, so no target matched. Now `POST /api/switch` accepts both forms: `{"profile": "x", "deactivate": true}` and `{"deactivate": "x"}`.
- **No silent success:** If the profile is not active, `POST /api/switch` now answers `404` with the error `Profile "x" is not active`. If `deactivate` is `true` and no profile is named, it answers `400`. Before, both requests answered `200` with `success: true`.

## Release 1.2.5

- **Dashboard controls:** The dashboard controls use MIT elements from Uiverse.io galaxy as a base. The CSS gives the name of each author.
- **Switch and checkbox:** The switch knob moves with a short spring and stretches while you press it. When a switch is off, a ring keeps its track visible. A checkbox shows a tick that grows when you select it.
- **Feedback:** A toast shows a status dot and a bar for the time until it closes. A styled tooltip replaces the browser tooltip for each item that has a title. Test Connection and Sync Models show a spinner while they run. The dialog fades in.
- **Accessibility:** A switch and a checkbox show a 2px outline when they have keyboard focus. When the system asks for reduced motion, only the spinner moves.

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
