# Tool vocabulary: what each coding tool calls its tools

A tool name is not an identifier the API checks. A client declares its tools, the model answers
with a name, and the client either runs the call or refuses it:

```
Error: No such tool available: read
```

This happens when the model prefers a different vocabulary from the client's. It is not an
interoperability bug: the same prompt sometimes answers with the right name and sometimes with the
wrong one, because the model is choosing between two vocabularies it knows, not because a field was
translated badly.

The gateway converts protocols. It cannot convert the model's preference. What it can do is write
the answer back in the vocabulary the client itself declared, and tell the model which names are on
the table.

This file records the vocabularies, with their sources, so the mapping table in `toolvocab.mjs` is
auditable instead of remembered.

## Claude Code

Source: [Tools reference](https://code.claude.com/docs/en/tools.md). The page states the names "are
the exact strings you use in permission rules, subagent tool lists, and hook matchers".

| Capability | Tools | Inputs |
| --- | --- | --- |
| Shell | `Bash`, `PowerShell`, `Monitor` | `command`, `description`, `timeout`, `run_in_background`; `Monitor` takes `ws: { url, protocols }` or `command`, plus `timeout_ms` |
| Read a file | `Read` | `file_path`, `offset`, `limit` |
| Write a file | `Write` | `file_path`, `content` |
| Edit a file | `Edit`, `NotebookEdit` | `file_path`, `old_string`, `new_string`, `replace_all`; `NotebookEdit` takes `notebook_path`, `cell_id`, `new_source`, `edit_mode`, `cell_type` |
| Search file contents | `Grep` | `pattern`, `path`, `glob`, `type`, `output_mode` (`files_with_matches`, `content`, `count`), `offset`, `head_limit`, `multiline` |
| Find files by name | `Glob` | `pattern`, `path` |
| Task list | `TodoWrite`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `TaskStop`, `TaskOutput` | |
| Web | `WebFetch`, `WebSearch`, `PushNotification` | `url`, `prompt`; `query` |
| Code intelligence | `LSP` | |
| Subagent | `Agent`, `ListAgents`, `SendMessage`, `SubagentHandback` | `description`, `prompt`, `subagent_type` |
| Skills | `Skill` | |
| MCP | `ToolSearch`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `WaitForMcpServers` | |
| Plan mode | `EnterPlanMode`, `ExitPlanMode` | |

Two facts from that page shape the mapping:

- **`Glob` and `Grep` are absent by default on macOS, Linux and WSL.** Claude Code searches there
  through the `Bash` tool instead, so on those platforms a search-shaped name may legitimately mean
  `Bash`, and a shell-shaped name may legitimately mean `Glob` or `Grep`. Two declared tools can
  both be plausible for one upstream name, and then the right answer is to change nothing.
- **`Bash`, `PowerShell` and `Monitor` all run a command.** A name like `run_in_terminal_cmd` has
  three possible targets on one session, depending on which of them the client exposes.

## Codex CLI

Sources: [Codex prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide.md),
`codex-rs/core/prompt_with_apply_patch_instructions.md` and `codex-rs/core/src/tools/handlers/plan.rs`
in [openai/codex](https://github.com/openai/codex).

| Capability | Tools | Inputs |
| --- | --- | --- |
| Shell | `shell`; the guide also names `cmd`, `run_terminal_cmd` | `command` (array) |
| Apply a patch | `apply_patch` (a custom tool with a Lark grammar, or the server-defined tool) | freeform patch text, or `{"command": ["apply_patch", "*** Begin Patch..."]}` |
| Plan | `update_plan`; the guide also names `todo_write` | |
| Read a file | `read_file` | `path` |
| List a directory | `list_dir` | |
| Find files | `glob_file_search` | |
| Search contents | `rg` | |

Codex's own prompt says: "Use the apply_patch shell command to edit files (NEVER try applypatch or
apply-patch, only apply_patch)". The model is therefore trained to reach for `shell` and
`apply_patch` by name, whatever the client's tools are called. This is the source of the mismatch
that shows up on a Claude Code session.

## OpenCode

The tool list at [opencode.ai/docs/tools](https://opencode.ai/docs/tools/) names `bash`. The source
does not: `packages/opencode/src/tool/registry.ts` registers `shell: Tool.init(shell)`, and there is
no `bash.ts` in that directory. The schemas below are read from
`packages/opencode/src/tool/*.ts` on `dev`, not from the docs page.

| Tool id | Source file | Inputs |
| --- | --- | --- |
| `shell` | `shell.ts` | `command` |
| `read` | `read.ts` | `filePath`, `offset`, `limit` |
| `write` | `write.ts` | `filePath`, `content` |
| `edit` | `edit.ts` | `filePath`, `oldString`, `newString`, `replaceAll` |
| `apply_patch` | `apply_patch.ts` | `patchText` |
| `grep` | `grep.ts` | `pattern`, `path`, `include` |
| `glob` | `glob.ts` | `pattern`, `path` |
| `webfetch` | `webfetch.ts` | `url`, format, `timeout` |
| `websearch` | `websearch.ts` | `query`, `numResults`, `livecrawl`, `type`, `contextMaxCharacters` |
| `todowrite` | `todo.ts` | `todos` |

OpenCode's argument keys are camelCase. Claude Code's are snake_case: `file_path`, `old_string`,
`new_string`, `replace_all`. Only `command`, `pattern`, `path` and `query` are spelled the same in
both.

## The rule that follows from the two spellings

A renamed tool carries the caller's own schema. The model reads `edit` with `file_path` and calls it
that way; the name goes back to `Edit` and the arguments never moved.

Translating the argument keys into the provider's spelling is not needed and is not safe. The
provider only checks the name, the schema is the caller's to declare, and a key the caller's schema
does not have is one the caller will reject. The case that looks like it needs it, Gemini's `replace`
requiring `instruction` that Claude Code's `Edit` cannot produce, is solved by not requiring it: the
schema sent is the caller's, so nothing is invented and no value is fabricated.

## Other agents the gateway meets

These are the names models reach for when they answer from their own training instead of the client's
list. They come from the agent projects that made those names standard.

| Name | Source | Capability |
| --- | --- | --- |
| `str_replace_editor`, `str_replace_based_edit_tool` | [bytedance/trae-agent](https://github.com/bytedance/trae-agent) `TextEditorTool` | edit; `command` is one of `view`, `create`, `str_replace`, `insert`, with `path`, `old_str`, `new_str`, `file_text`, `insert_line` |
| `run_shell_command` | [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) `docs/developers/tools/shell.md` | shell; `command`, `directory`, `description`, `is_background` |
| `list_directory`, `read_file`, `write_file`, `file_search`, `web_fetch` | common open-agent conventions | list, read, write, find, fetch |

## What the gateway does with this

Two rules, both driven by the tool list the client sent rather than by a table of names:

1. **Never invent a name.** Only a tool the client declared can be a target. A client that never
   declared `Bash` cannot run a `shell` call, so rewriting it to something else changes nothing and
   hides the error.
2. **Never guess between two plausible tools.** Claude Code on macOS may have no `Glob` and no
   `Grep`; a session with both `Bash` and `PowerShell` has two shell tools. In those cases the name is
   left alone, and the client reports the mismatch itself, which is the honest path.

A name with a namespace never crosses into another namespace, and never out of one. Turning
`mcp__github__create_issue` into `Write` produces a call the client cannot detect as wrong: it runs.
A wrong local file write is worse than a failed turn.

## Two layers, and what each cannot do

Naming the caller's tools in the prompt is cheaper than repairing every call, so the gateway says so
first. It adds one sentence, in `auto` mode only, and only for the names the caller's own system
prompt does not already mention — a client that lists its tools in its prompt (Claude Code does, at
length) gets nothing at all, so there is no second list for the model to weigh against the first.

That layer does not cover two cases, which is why the repair layer exists behind it:

- A provider that **refuses** the request before the model reads anything, such as the Zen free tier
  answering 403 FreeTierError for a tool list it does not recognise. No prompt can reach a request
  that never starts.
- A model trained hard on one vocabulary and deaf to the list, such as one reaching for `applypatch`
  after its own prompt said `apply_patch`.

The repair layer covers those, at a cost paid only on the turns that need it.

## The one mapping that is a decision: Edit is not apply_patch

Claude Code's `Edit` and Codex's `apply_patch` both mean "change a file", and neither is renamed into
the other. This is deliberate, and it is the only pair in the tables above that is not simply "these
are not the same thing".

**Why.** A rename translates a name; this would translate a payload. `Edit` takes `file_path`,
`old_string` and `new_string`, and the old string has to appear exactly once in a file the caller has
read. `apply_patch` takes a unified diff envelope — `*** Begin Patch`, then `Add File` / `Update
File` / `Delete File` / `Move to` sections and hunks. Turning one into the other means reading the
target file to turn each hunk into an exact-match pair. A gateway does not read files, and Claude Code
also enforces read-before-edit, which a gateway cannot satisfy or know.

So the best a gateway could produce is a call that looks correct and fails, or one that matches the
wrong occurrence and edits the wrong thing. A refused turn is visible and costs a turn; a wrong edit
that lands is not.

**What it would cost to do properly, if someone wants it anyway.** Not a rename: a semantic translator
with file access, its own error cases, and a guarantee it cannot make. Not worth it at a gateway.

**The three ways to get the same result, in order of preference.**

1. **Pass the provider's own edit tool through.** No translation, and the real semantics. OpenAI
   serves `apply_patch` as a server-defined Responses tool — `tools=[{"type": "apply_patch"}]`, with
   `apply_patch_call` items in the output (OpenAI, *Apply Patch*). Anthropic publishes `text_editor`
   with its own schema among its client tools (*Tool use with Claude*: "tools with Anthropic-defined
   schemas, such as `bash` and `text_editor`"), and Gemini's first-class editor is `replace`. Today the
   gateway marks all of these `provider`-side and drops them from a converted request, because the
   caller never executes them. Offering one to a caller that wants first-class editing is a new
   capability with its own design — the tool runs provider-side, so the approval and the result path
   are the provider's — and it is the right answer to "the model should edit files natively" rather
   than to "the model said `apply_patch` and the caller said `Edit`".
2. **Give the caller a tool that already speaks diff**, if the client allows custom tools. Codex does
   this with a freeform `custom` tool carrying a Lark grammar, and opencode's `apply_patch` takes
   `patchText`. A client that can accept that has no mismatch to repair at all. It is the same reason
   `custom` tools and `local_shell` are never renamed here: their payload is written for their name.
3. **Rename nothing and let the repair layer handle the residue**, which is what happens now: `Edit`
   keeps its name, the prompt layer names it, and the one call in a hundred that still answers
   `str_replace_editor` is matched on capability — `edit` to `edit`, one candidate, no guessing.

If option 1 or 2 is ever taken, this file and the comment above `capEdit` are the place to change,
and `Edit` should still not be renamed on the way out.

## How the rest of the industry handles it

Worth knowing before changing either layer, because four answers are already in use:

- **The prompt is the fix most teams reach for.** Codex's own prompt says "NEVER try applypatch or
  apply-patch, only apply_patch", and users put the same line in `AGENTS.md` (openai/codex#2072). The
  lesson from langchain-ai/deepagents#3188 is that the tool *description* beats system-prompt
  coaching, because a worked example inside the description sits right next to the schema: a
  description that taught `path` while the schema declared `file_path` broke every read call.
- **Accepting several spellings at the receiving end** is the other common answer. openclaw#16717 took
  70+ failures in eight days from one schema that accepted both `path` and `file_path` while the
  handler read only one, and fixed it with `args.file_path || args.path`. That is the same rule as
  the argument matching here, arrived at separately.
- **Constrained decoding** (OpenAI `strict`, vLLM guided decoding) guarantees the *arguments* match
  the schema, and vLLM says so plainly for `auto`: "Arguments may be malformed or not match the
  schema". It says nothing about the *name*. Nothing in any of these mechanisms constrains a tool call
  to a name the caller declared, which is the gap both layers here sit in.
- **Tool-call repair as a first-class hook** exists in the AI SDK as `repairToolCall`, with
  `NoSuchToolError`, `InvalidToolInputError` and `ToolCallRepairError`. Its strategies are to re-ask a
  stronger model or regenerate the arguments with structured outputs — and its own example returns
  `null` for an unknown tool name, on the grounds that a name is not something to repair. LiteLLM's
  tool-calling surface has no name mapping at all; its "interception" work moves provider-executed
  capabilities (web search, a code sandbox) to the gateway, which is the mirror image of the bug this
  file's axis was added for.

## Where the vocabulary is enforced rather than preferred

`zencore`, the service in front of OpenCode Zen, measures this: the free tier answers a request with
403 FreeTierError when the tool names are not `read` and `shell`. That is the OpenCode source spelling
above, not the docs page's `bash`, which is why the check is on `shell`.

That turns the rule above from a nicety into a requirement. The caller declares `Read` and `Bash`;
the upstream refuses the request outright. The two ways forward are to append a stub tool with an empty
schema, or to rename the caller's real tools to the names the upstream demands and rename the answer
back. The stub is worse than it looks: the model answers with the stub's name, the caller has no tool
by that name, and the caller reports `No such tool available`. The stub is how that error gets
manufactured in the first place.

So: rename the tool, keep the caller's schema, keep the caller's description, and record the map. The
names appear in three places and all three have to move together — the `tools` array, the tool calls
already in the transcript, and the answer. A `tools` array that says `read` while the transcript shows
a call to `Read` reads to the model as two different tools, which is worse than having changed
nothing.
