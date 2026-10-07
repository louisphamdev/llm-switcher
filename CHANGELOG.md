# Changelog — LLM Switcher

## Release 1.6.0 — 2026-10-07

- **A Codex thread now keeps the shortening, behind the same opt-in switch.** A Codex compaction is
  three writes that have to agree, all read off a thread that had compacted seven times:

  1. a `compacted` entry in the rollout file, carrying the summary and the history that replaces
     the old one;
  2. a row of type `contextCompaction` in `thread_items`, whose `item_json` is nothing but a type
     and an id -- a marker, not a summary;
  3. `thread_history_projection_state` moved forward to the byte offset and ordinal of that entry.

  The third is the one that is easy to leave out, and leaving it out looks exactly like success.
  That table records how far the store has consumed the rollout file: `next_rollout_byte_offset` is
  the size of the file, exactly, and `next_rollout_ordinal` is the ordinal after the last entry
  read. The rollout file is the record and the store is a projection of it, so an entry appended to
  the file without moving the projection is simply never read. With all three written, Codex
  resumes and answers from the summary; with the first two alone it resumes and says it has none.

  `idleCompact.codex` remains off by default, because this opens Codex's database. With no summary
  model named, no model is called: the request still goes out shortened, which is the whole of the
  saving, and nothing is spent to earn it.

## Release 1.5.3 — 2026-10-07

- **Idle compaction no longer calls a model unless one was named for it.** With no summary model set,
  a summary was written with the conversation's own model — the expensive one, on an official
  account, and the one with limits. That spends the costly model to save the tokens of a single
  turn, and on a plan with limits it is worse than doing nothing.

  There was no point paying for it either: the summary is used only to write the session file, so
  with no model named there was nothing to store and the call bought nothing. Now no model is called
  at all. The saving is unchanged — the request still leaves shortened, which is the whole of what
  this feature costs and all of what it saves without a model. Set one with
  `switch compact model <id>` to also make the shortening last.

## Release 1.5.2 — 2026-10-07

- **Codex conversations can be shortened on an idle return too, behind its own switch.**
  `idleCompact.codex`, off by default. The history is shortened in the request, which is
  where a Responses client keeps it: a Responses client reaches a Responses provider as the
  bytes it sent, so there is nothing to render through. Measured on a 25 KB conversation,
  6 KB goes out.

  The thread itself is left to Codex. Its history is a SQLite store of its own, and a
  compaction there needs two halves: a `contextCompaction` row in `thread_items`, whose
  `item_json` is nothing but a type and an id, and a `compacted` entry in the rollout file
  carrying the summary. Both were written, in the shape a real compaction takes, and Codex
  resumed as if neither existed. Something else in that store says where the summary begins;
  it was not found. So the summary is produced and the request goes out short, which saves
  the tokens of this turn, and no claim is made that the thread stays short.

## Release 1.5.1 — 2026-10-07

- **Idle compaction is now in the dashboard.** A card on the Routes page carries the switch, the pause that counts as losing the cache, the size it must exceed, and the model that writes the summary. It reads and writes `/api/idle-compact`, the same endpoint and the same key `switch compact` uses, so the page and the terminal cannot show two different settings.

  One bug came out of writing the endpoint: the field types were checked as groups, so `{"enabled":"yes"}` was accepted and then read as `false` — a typo switched the feature off without a word. Each field is now checked as the type it actually is, and a wrong type is refused rather than quietly turned into the default.

## Release 1.5.0 — 2026-10-07

- **A conversation that comes back after a pause no longer pays full price for a cache nobody holds.** When a Claude Code session resumes after being idle long enough, and the context is large enough to be worth it, the gateway shortens the history and writes the compaction into the session file. Off by default. `switch compact on`, and `switch compact model <id>` for the model that writes the summary (empty means the conversation's own model).

Two decisions worth naming, because the obvious alternatives are worse.

Compacting once, not every turn. Changing the prefix on every turn means no turn ever hits the cache and the conversation is summarized over and over. Compacting when a pause says the cache is gone keeps the summary stable for the turns that follow.

The session file, not the API. Claude Code builds every request from the entry chain in `~/.claude/projects/<project>/<session>.jsonl`, so a compaction written there shortens every request after it rather than only the turn that triggered it. The two entries are the ones Claude Code writes itself, read off a real session: a `compact_boundary` and a `user` entry marked `isCompactSummary`. Old entries stay in the file, as they do after Claude Code's own compaction, because a transcript a person can still read is worth more than a small file.

Codex and the Antigravity CLI are deliberately untouched. Codex compaction is a protocol item the provider gateway answers and Codex stores in its own history, so shortening a Codex request here would replace that with a summary no client records. The CLI has no session file to write.

Tests: 14, including one that runs the real Claude Code binary against a local server and reads the request it sends. With twelve synthetic turns behind a boundary, that request carries the summary and none of the twelve.

## Release 1.4.1 — 2026-10-07

- **The update comes from npm, because that is where a release is published.** The gateway asked npm what the newest version is and ran `npm install -g llm-switcher@<version>` for exactly that version. Before, the install decided: a directory with a `.git` pulled and never asked npm, and the dashboard's Update now button read as a git operation on a project that ships to npm.
- **A git checkout is the one install npm cannot serve, and it says so.** npm writes into the global prefix while the running code is the checkout itself, so the install lands somewhere nothing runs. The checkout is then asked, and it pulls fast-forward only. When npm held a release the checkout could not take, the notice names that version and what the checkout has, because "already the latest version" on its own would hide the one version the reader does not have.
- **A failed npm install no longer fails the update of a checkout.** A checkout used to update without npm in the way. Asking npm first put an install between the reader and a pull, and any failure of that install -- a version the registry does not serve, a network, a read-only prefix -- ended the update even though the checkout could still have moved. Now a checkout reports what npm did and goes on to pull; an npm install with no checkout still fails loudly, because there is nothing else to try.

Tests: 17 in `tests/update.test.mjs`, plus the rest of the suite.

## Release 1.4.0 — 2026-10-07

- **A model answers with the tool names it was trained on, and the caller only runs its own.** A Codex model says `shell` where Claude Code declared `Bash`, and the turn ends with `Error: No such tool available: shell`. The gateway now writes the call back in the vocabulary the caller declared, and says the names in the prompt so most calls never need rewriting.
  - Two layers, because neither covers the whole case. The prompt layer is one sentence in `auto` mode, and only for the tool names the caller's own prompt does not already mention: Claude Code names its tools at length, so it gets nothing and there is no second list to contradict the first. It cannot help a provider that refuses the request before the model reads it (the Zen free tier answers 403 `FreeTierError`), nor a model that ignores the list. The repair layer is behind it, and pays only on the turns that need it.
  - Only a tool the caller declared can be a target, and two declared tools of the same kind are left alone: a caller with both `Bash` and `PowerShell` cannot run the one it did not get. A namespaced name (`mcp__github__create_issue`) never leaves its namespace, because turning it into a local `Write` produces a call the caller cannot detect as wrong. A renamed tool keeps the caller's schema, so no argument key is translated and none can miss: opencode spells it `filePath`, Claude Code spells it `file_path`, and the caller's own spelling is what both the model and the caller see.
  - Arguments are matched against the caller's `input_schema` and only when exactly one key fits, the same rule openclaw arrived at separately (openclaw#16717 took 70+ failures in eight days from that shape). A key the schema does not name is left alone, and `offset: 0` is a value.
  - `Edit` is deliberately not renamed into `apply_patch`: that would translate a payload rather than a name, and a usable `old_string` needs a file the gateway does not read. `docs/tool-vocabulary.md` records the decision and the three ways to want first-class editing instead, the first of which needs no translation at all — passing the provider's own edit tool through (OpenAI's server-defined `apply_patch`, Anthropic's `text_editor`, Gemini's `replace`).
  - `docs/tool-vocabulary.md` records every name with its source, the two industry answers to this problem, and what each layer still cannot do.
- **Anthropic's server tools were being sent to other providers as functions.** A tool with a dated type and no `input_schema` (`web_search_20260209`, `code_execution_20250825`) runs on Anthropic's infrastructure and its result reaches the caller without the caller executing anything. `anthropicToIR` recorded it as an ordinary tool, so a provider without an equivalent was asked for a function the caller would then have to run. The IR now marks which side runs a tool, and an emitter sends only the caller's own. LiteLLM's "web search interception" moves a capability in this direction deliberately; this was the same move made by accident.

- **The window is the model's own, so there is nothing to set.** `/v1/models` no longer reports a hardcoded 1M. The gateway reads each model's window from the profile's own list and serves it as `max_context_window` (the whole window) and `context_window` (the point to compress at). A 872K Codex model now gets 872K and still compacts at its own 272K threshold, instead of planning for 1M and failing at the upstream. The list is read once an hour per profile and cached in `model-windows.json`; a list that cannot be read keeps the last one, and the Codex CLI's own cache is the fallback before the catalog template.
- **`compact_window`:** intact serves the window to compress at beside `context_length`, and the gateway reads it from any provider list that names it. `POST /api/fetch-models` returns it as `compact`, and the dashboard shows each model's window under its slot.
- **`model1M` retired:** the flag, the 1M checkbox and the hardcoded 1M check are gone. A flag left in an old `config.json` is read by nothing and is dropped when the profile is next saved. The `[1m]` scrub of a leftover `ANTHROPIC_DEFAULT_*_MODEL` value stays, as does the `[1m]` stripping in model mapping: a client may still send the marker.
- **Thinking effort survives the hop, in both directions:** one ladder (`none` … `ultra`) orders the levels, and each level has one token budget, so a level and its budget are the same request. Before, `xhigh` and `max` became `medium` on a strict OpenAI upstream, `medium`, `high` and `xhigh` all became the same 8000-token budget, and a client that asked with Anthropic `output_config.effort` and no `thinking` object had the request dropped.
  - Codex `reasoning.effort` reaches OpenAI Chat `reasoning_effort` unchanged on a forwarding gateway, and as the deepest level the target names on a strict one (`xhigh` → `high`, never `medium`).
  - It reaches Anthropic as `output_config.effort` when no budget was sent, and as `budget_tokens` otherwise. A client that sent `budget_tokens` keeps it: the same request is not restated twice.
  - Vertex asks Gemini for the budget the level stands for, and never above the 32768 Gemini takes. Gemini refuses a larger budget instead of trimming it, so the gateway trims it instead of losing the request.
  - The four levels OpenAI names keep the budgets this gateway has always read (`1024` low, `4000` medium, `8000` high), so an existing request changes nothing.
- **Claude Code Remote Control:** the README now says which hop the switcher replaces. The session bridge at `api.anthropic.com/v1/code/sessions` carries the conversation and checks the subscription, so a Remote Control session needs quota on the Claude account even when the profile routes inference elsewhere.
## Release 1.3.8

- **Update now with the new code already on disk:** The update compared the version on disk, not the version of the running gateway. When the checkout or the npm install already had the new release, the update said "Already on the latest version" and did not restart. The gateway then ran the old code and showed the update notice again and again. The gateway now restarts into the newer code on disk.
- **Windows service without a window:** The logon task started `node.exe` directly. `node.exe` is a console program, so Windows opened a terminal window for the gateway, and when you closed that window the gateway stopped. The task now starts the gateway through `conhost.exe --headless`, and no window opens. Run `switch service install` again to update an installed task.

## Release 1.3.7

- **Update notice in time:** The gateway kept the npm answer for 12 hours. A release published after the last check did not show an update button until the next day. It now asks npm again after 5 minutes.

## Release 1.3.6

- **Dashboard from a bookmark:** In 1.3.4 the tab kept the token in `sessionStorage`. A bookmark, a typed URL or a new tab then had no token: every call got HTTP 401, and the dashboard showed no profiles and every route as OFF. The token is now in `localStorage`, so after one `switch ui` every tab of that browser works. The page still does not carry the token.
- **Dashboard without a token:** The header now says to open the dashboard with `switch ui`. Before, it said "Gateway is idle", which looked like a config with no routes.

## Release 1.3.5

- **Dashboard motion:** The switch, the checkbox, the dialog, the toast and the tooltip used easing curves that overshoot and bounce back. They now use one smooth ease-out curve (`--ease-out`). The durations did not change.
- **Dashboard elevation:** The dialog, the toast and the model list used a wide 50 px shadow on top of their border. The shadow is now short and tight, so the border defines the edge, in both themes.
- **Dialog tabs on a phone:** At 390 px wide, the profile dialog cut off the **Model Slots** tab, and the tab bar hides its scrollbar. On a narrow screen the tabs now have less padding, and they wrap if they still do not fit.
- **API key field:** The field has `autocomplete="off"`, so a password manager does not offer to save the key.
- **Update now that times out:** The message "The new gateway did not answer" now also says what the last check saw: the gateway from before the update, an HTTP status, or a network error.

## Release 1.3.4

- **The dashboard page carries no token:** `/ui` sent `admin.token` in the page, and any program on the machine can load `/ui`. The page now gets the token only from the `#token=` of the private launcher that `switch ui` opens (a file with mode 0600). The tab keeps it in `sessionStorage`, so it does not stay in the browser after the tab closes. A tab opened at `/ui` directly says to use `switch ui`. `switch status` and the gateway start line say the same.
- **Tests:** The agy shim tests start a real relay and send a real request through it. The request must reach the gateway with the Google token, and a gateway without a valid proof must get nothing. The Update now test waits longer than the page polls, so a failure shows what the page saw.

## Release 1.3.3

- **agy runs behind a relay:** A routed agy no longer gets the gateway port. The shim starts it behind `agy-relay.mjs`, which holds its own loopback port for as long as agy runs. For each connection, the relay asks the gateway for its identity proof on the same socket and sends agy's request only after the proof holds. Before, the shim checked the gateway only at launch, so a gateway that stopped during an agy session left its port free for another program to take, with agy's Google token sent to it. If the proof fails now, agy gets a 502 and the token stays in the relay.
- **A relay key that no page serves:** The relay accepts only `relayProof`, an HMAC keyed by `gateway.secret`, a random file next to `admin.token`. The gateway makes it at startup and keeps no copy. The dashboard page carries `admin.token`, so a proof keyed by it could be made by any program that loads the page. A gateway older than the relay gets a 502 that says to restart it.
- **A `.cmd` agy gets its arguments unchanged:** The relay starts a `.cmd` or `.bat` agy through `%SystemRoot%\System32\cmd.exe /e:ON /v:OFF /d /c` with the quoting of the Rust standard library since CVE-2024-24576. `%` cannot expand a variable, and `&` or `|` cannot start a second command. A line break, or a command line over 8191 characters, stops the relay before agy starts, with a hint to pipe the prompt on stdin.
- **`switch off` and `switch port` leave another instance alone:** They stopped or rewrote the installed service even when it ran the gateway of another port. A second instance (`LLM_SWITCHER_PORT`) then stopped the first one. The service now counts only for the port its definition names. The test suite triggered the same fault and stopped the real gateway of the machine.

## Release 1.3.2

- **Codex over WebSocket crosses Bifrost:** Codex uses its WebSocket transport by default. The gateway now sends each WebSocket turn to intact `/v1/responses` as one HTTP request with the whole conversation, and sends each event back as one frame. Before, these turns took the convert route. A stream that stops before `response.completed` ends the turn with `response.failed`.
- **All Codex clients cross Bifrost:** `codex exec` sends `codex_exec/` in its `User-Agent`, not `codex_cli_rs/`. The gateway takes `codex_cli_rs`, `codex_exec`, `codex_vscode` and `codex_sdk_ts` as one client. Before, `codex exec` never crossed Bifrost.
- **`make-certs.sh` and a Windows path:** The script read a lone argument such as `C:\Users\me\certs` as a host name and ignored it, so it rebuilt the certificates of the checkout instead. A running interceptor then served a leaf from the old CA, and Codex failed with `workspace routing discovery failed`. A backslash now marks a path.
- **Tests:** `npm test` no longer rebuilds the certificates of the checkout. The suite runs on Linux, macOS and Windows in CI, and on Node 18.

## Release 1.3.1

- **agy note:** `switch plugin status` now names agy 1.2.14. This release of agy also loads `~/.gemini/antigravity-cli/hooks.json` but does not run its hooks (measured 2026-10-03), so the shim toast is still the notice for agy.
- **Tests:** A test covers an error in a converted agy stream. The error goes to agy bare, as Code Assist sends it. The agy end-to-end tests now pass in any order.

## Release 1.3.0

- **Antigravity CLI (`agy`):** A third tool, beside Claude Code and Codex. A profile with `"tool": "agy"` routes it, and `switch agy <profile>` turns it on. `switch off agy` turns it off and leaves the other tools alone. The dashboard has an agy row and an **agy on intact** template.
- **No proxy and no certificate for agy:** The `agy` shim sets `CLOUD_CODE_URL` to the gateway. agy is a Go program, and Go on Windows trusts only the system store, so an interceptor would need a certificate in that store. `CLOUD_CODE_URL` needs none. agy also ignores `HTTPS_PROXY`.
- **What agy sends where:** Only the agent turns of agy go to its profile. Checkpoint summaries, the model list, quota, sign-in state and analytics go to Google with the token of the person, unchanged. While agy is off, every call goes to Google.
- **Remote control:** agy reaches its remote control through `jetski-webchannel.googleapis.com`, not through `CLOUD_CODE_URL`. It stays connected while the switcher routes agy.
- **Model slot:** An agy profile has one slot, `main`. A `*` in the value stands for the model that agy picked, so `antigravity/*` keeps the choice of agy on an intact pool.
- **Conversion:** An agent turn on any other upstream is converted from Code Assist and back. Each answer chunk is wrapped as `{"response": …, "traceId": …}`, and each function call keeps its id, so agy matches the tool result.
- **Bifrost for agy and Codex:** When intact names the client of a model (`bifrost_ua`), the request crosses unchanged. agy goes to `/v1/v1internal:<method>` and Codex (HTTP) to `/v1/responses`. Only the key changes. The Google token of agy never reaches intact. Codex over the WebSocket transport keeps the normal route.
- **Usage of a passthrough:** The usage tap reads Gemini `usageMetadata`, so a Bifrost answer of agy reports its tokens in the inspector.
- **Launch notice:** `switch plugin install` also writes an entry into `~/.gemini/antigravity-cli/hooks.json`. agy 1.2.7 loads this file but does not run global hooks yet, so the shim toast is the notice for agy today. `switch plugin status` says so.
- **The agy shim proves the gateway first:** agy sends its Google token in clear text to `CLOUD_CODE_URL`, so the shim asks the gateway for its identity proof (`verify-gateway.mjs`). If no proof comes within 3 seconds, the shim removes the variable and agy keeps its official endpoint.
- **Passthrough limits:** A Code Assist call that the gateway does not route has an idle limit (`LLM_SWITCHER_CODE_ASSIST_TIMEOUT_MS`, default 5 minutes). A broken upstream answer cuts the connection to agy instead of ending it as if it were complete.
- **Passthrough headers:** A call to Google keeps every header of agy, `x-goog-*` included. Only the headers of the gateway (`x-llm-profile`, `x-profile`, `x-llm-switcher-token`, `x-intact-*`) and the proxy headers (`proxy-authorization`, `x-forwarded-*`, `x-real-ip`) are removed.
- **No silent fallback to Google:** While agy is routed, an agent turn that the gateway cannot route gets an error. A config that never loaded gives 503. A named profile that does not exist gives 400. A body that does not parse gives 400. A request with no model on a `*` slot gives 400.
- **Bifrost lookup:** A failed lookup (no answer, or any answer that is not 2xx, a 404 too) keeps the normal route for 30 seconds only (`LLM_SWITCHER_BIFROST_RETRY_MS`), and the gateway prints one line for each series of failures. Before, an error answer held the normal route for 10 minutes without a word.
- **Broken Bifrost stream:** If a Bifrost or direct stream breaks, the gateway cuts the connection. Before, the client got a clean end of a half answer.
- **`switch plugin`:** Each tool installs on its own, so a fault in one hooks file does not stop the others. If the path of `hook-status.mjs` holds a space, agy is skipped (`[Skip]`), not failed. An agy `hooks.json` whose root is not an object is never changed. `switch plugin status` names an agy `hooks.json` that does not parse.
- **Migration:** The migration of an old `config.json` keeps `activeProfiles.agy`, and a pointer to a profile renamed because its key became a command word (`agy` becomes `agy-profile`) follows the rename.
- **`switch shim status` on Windows:** It now finds the command the way Windows does, by directory and then by `PATHEXT`. Before, an `agy.exe` earlier on `PATH` than the shim was reported as "shim active".
- **The launch files of agy** (`env-agy.*`, `route-agy.txt`) are ignored by git and npm, like those of the other tools.
- **Needs intact 0.1.14 or newer** for Bifrost of agy and Codex.

## Release 1.2.12

- **Update now:** The update notice on the dashboard has an **Update now** button. The gateway installs the release, and a new gateway process starts on the new code. Then the dashboard reloads. `switch update` does the same from a terminal.
- **Safe for a git checkout:** A git checkout updates with `git pull --ff-only`. If the checkout has local changes, or commits that are not on the upstream branch, the update stops and changes nothing.
- **Open requests:** Open requests on the gateway finish on the old code. The Codex interceptor stops and the new gateway starts it again, so a Codex request that is open at that moment fails one time. The old process stays as the parent of the new process, so a service manager keeps the process that it started.
- **Update at logon:** `switch service install` adds `--autoupdate` to the service. The gateway then installs the newest release before it starts. `--no-autoupdate` installs the service without the flag. Run `switch service install` again to add the flag to a service that is already installed. `switch port` keeps the choice of the installed service.
- **macOS and Linux:** launchd and `systemd --user` start the gateway with a short `PATH`, and an npm from Homebrew or nvm is not on it. The update now runs npm with the directory of the running `node` first on `PATH`.

## Release 1.2.11

- **Test connection on a Bifrost model:** The test sent a plain `ping` request, and Anthropic answers that with a fake 429 for a Claude Code account. Now, when intact names `bifrost_ua` for the model, the test reports that the key works and the model is served, and it sends no message.

## Release 1.2.10

- **Bifrost in the log:** The log line and the request inspector showed `anthropic -> openai-chat` for a Bifrost request, because the gateway logged the profile's `outFormat` before it checked Bifrost. Now both show `bifrost`.
- **Bifrost and the contract lab:** A sampled Bifrost exchange went to intact labeled with the profile's `outFormat`. intact then compared an Anthropic request with an OpenAI conversion that never ran. Now the label is `anthropic`.

## Release 1.2.9

- **Bifrost:** Claude Code that reaches a Claude Code account on intact now goes through unchanged. Only the key changes. Before, a `convert` profile, or a `hybrid` profile with a `claude/...` model, changed the request to OpenAI Chat. The `direct` route also ran the healer and `thinkingMode`. Now the gateway asks intact for `bifrost_ua` of the mapped model. If the `User-Agent` of the client starts with this value, the gateway sends every client header, the body bytes, and the query string. There is no setting. intact 0.1.10 or newer gives `bifrost_ua`.

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
