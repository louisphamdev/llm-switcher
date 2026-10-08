import crypto from 'node:crypto';

// Writing a tool call back in the vocabulary the client declared.
//
// A tool name is not an identifier an API checks. The client sends its tools, the model answers
// with a name, and the client runs the call or refuses it ("No such tool available: read"). The
// gateway converts protocols; it cannot convert the model's preference. What it can do is notice
// that the model answered in a different vocabulary and write the call back in the client's.
//
// Two rules hold no matter what the name looks like:
//
//   1. Only a tool the client declared is a candidate. A client that never declared `Bash` cannot
//      run a `shell` call, so rewriting it to some other name changes nothing and hides the error.
//   2. Nothing is guessed while two declared tools are both plausible. Claude Code on macOS has no
//      `Glob` and no `Grep`; a session with both `Bash` and `PowerShell` has two shell tools. When
//      the choice is not clear the name stands, and the client reports the mismatch itself, which is
//      the honest path: a wrong call runs, a refused one does not.
//
// The capability names below are the ones each coding tool documents, with their sources collected in
// docs/tool-vocabulary.md. Capabilities that are not interchangeable stay apart: `apply_patch` speaks
// a diff, Claude Code's `Edit` speaks old_string/new_string, so a patch is never rewritten into an
// Edit. The same holds for `Monitor`, which watches a command rather than running one.
//
// Edit and patch are the one pair here that is a decision rather than an oversight, so it is recorded
// in both places. Renaming `Edit` to `apply_patch` would translate a payload, not a name: a usable
// `old_string` needs the file, and a gateway does not read one. The result would be a call that looks
// right and fails, which is worse than a name the model got wrong. docs/tool-vocabulary.md has the
// three ways to want this instead, and the first of them needs no translation at all: pass the
// provider's own edit tool through — OpenAI's server-defined `apply_patch`, Anthropic's `text_editor`,
// Gemini's `replace`.

const CAP_SHELL = 'shell';
const CAP_READ = 'read';
const CAP_WRITE = 'write';
const CAP_EDIT = 'edit';
const CAP_PATCH = 'patch';
const CAP_SEARCH = 'search';
const CAP_GLOB = 'glob';
const CAP_LIST = 'list';
const CAP_PLAN = 'plan';
const CAP_WEB = 'web';
const CAP_WEBSEARCH = 'websearch';
const CAP_MONITOR = 'monitor';
const CAP_LSP = 'lsp';
const CAP_SKILL = 'skill';
const CAP_AGENT = 'agent';
const CAP_ASK = 'ask';

// The name each tool documents, as it stands. Case is irrelevant to a name a model reaches for, and
// MCP servers are case-sensitive, so this is only ever read on the model's side of the boundary.
const NAME_CAPABILITY = new Map([
  // Claude Code — code.claude.com/docs/en/tools.md
  ['bash', CAP_SHELL], ['powershell', CAP_SHELL], ['monitor', CAP_MONITOR],
  ['read', CAP_READ], ['write', CAP_WRITE], ['edit', CAP_EDIT], ['multiedit', CAP_EDIT],
  ['notebookedit', CAP_EDIT], ['notebookread', CAP_READ],
  ['grep', CAP_SEARCH], ['glob', CAP_GLOB],
  ['todowrite', CAP_PLAN], ['taskcreate', CAP_PLAN], ['taskget', CAP_PLAN], ['taskupdate', CAP_PLAN],
  ['tasklist', CAP_LIST], ['taskstop', CAP_PLAN], ['taskoutput', CAP_READ],
  ['webfetch', CAP_WEB], ['websearch', CAP_WEBSEARCH],
  ['lsp', CAP_LSP], ['skill', CAP_SKILL], ['agent', CAP_AGENT], ['askuserquestion', CAP_ASK],
  ['toolsearch', CAP_LIST], ['listmcpresourcestool', CAP_LIST], ['readmcpresourcetool', CAP_READ],

  // Codex CLI — developers.openai.com codex prompting guide, openai/codex codex-rs
  ['shell', CAP_SHELL], ['cmd', CAP_SHELL], ['run_terminal_cmd', CAP_SHELL], ['runterminalcmd', CAP_SHELL],
  ['apply_patch', CAP_PATCH], ['update_plan', CAP_PLAN], ['todo_write', CAP_PLAN],
  ['read_file', CAP_READ], ['list_dir', CAP_LIST], ['glob_file_search', CAP_GLOB], ['rg', CAP_SEARCH],

  // OpenCode — opencode.ai/docs/tools/
  ['edit', CAP_EDIT], ['write', CAP_WRITE], ['read', CAP_READ], ['grep', CAP_SEARCH],
  ['glob', CAP_GLOB], ['todowrite', CAP_PLAN], ['webfetch', CAP_WEB], ['websearch', CAP_WEBSEARCH],
  ['lsp', CAP_LSP], ['skill', CAP_SKILL], ['question', CAP_ASK],

  // Other agents the gateway meets — bytedance/trae-agent, QwenLM/qwen-code
  ['run_shell_command', CAP_SHELL], ['str_replace_editor', CAP_EDIT], ['str_replace_based_edit_tool', CAP_EDIT],
  ['list_directory', CAP_LIST], ['read_file', CAP_READ], ['write_file', CAP_WRITE], ['file_search', CAP_GLOB],
  ['web_fetch', CAP_WEB]
].map(([name, cap]) => [name.toLowerCase(), cap]));

// Tokens, for a name no tool documents. Only a token one vocabulary uses for one thing is here, so a
// name built from these words reads as a single capability rather than as a guess. A name with no
// capability token is not repaired at all.
const TOKEN_CAPABILITY = new Map([
  ['shell', CAP_SHELL], ['bash', CAP_SHELL], ['sh', CAP_SHELL], ['zsh', CAP_SHELL], ['cmd', CAP_SHELL],
  ['command', CAP_SHELL], ['commands', CAP_SHELL], ['terminal', CAP_SHELL], ['console', CAP_SHELL],
  ['exec', CAP_SHELL], ['execute', CAP_SHELL], ['run', CAP_SHELL], ['spawn', CAP_SHELL], ['process', CAP_SHELL],
  ['monitor', CAP_MONITOR],
  ['read', CAP_READ], ['cat', CAP_READ], ['view', CAP_READ], ['open', CAP_READ],
  ['write', CAP_WRITE], ['create', CAP_WRITE], ['dump', CAP_WRITE], ['save', CAP_WRITE],
  ['edit', CAP_EDIT], ['replace', CAP_EDIT], ['modify', CAP_EDIT], ['multiedit', CAP_EDIT],
  ['strreplace', CAP_EDIT], ['streditor', CAP_EDIT], ['stredit', CAP_EDIT],
  ['patch', CAP_PATCH], ['applypatch', CAP_PATCH],
  ['grep', CAP_SEARCH], ['rg', CAP_SEARCH], ['ripgrep', CAP_SEARCH], ['ugrep', CAP_SEARCH],
  ['grepcontent', CAP_SEARCH],
  ['glob', CAP_GLOB], ['filesearch', CAP_GLOB], ['globfiles', CAP_GLOB],
  ['list', CAP_LIST], ['ls', CAP_LIST], ['dir', CAP_LIST], ['directory', CAP_LIST],
  ['plan', CAP_PLAN], ['todo', CAP_PLAN], ['todos', CAP_PLAN], ['todowrite', CAP_PLAN], ['updateplan', CAP_PLAN],
  ['fetch', CAP_WEB], ['webfetch', CAP_WEB], ['url', CAP_WEB], ['http', CAP_WEB], ['download', CAP_WEB],
  ['websearch', CAP_WEBSEARCH],
  ['lsp', CAP_LSP], ['skill', CAP_SKILL],
  ['agent', CAP_AGENT], ['subagent', CAP_AGENT],
  ['question', CAP_ASK], ['ask', CAP_ASK]
]);

// `TodoWrite` is one word to the model that made it; `str_replace_editor` is three.
export function tokenize(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

// `mcp__github__create_issue` belongs to the github server. A namespace is kept as a whole and
// joined by single underscores so a multi-word server name still compares.
function namespaceOf(name) {
  const m = /^([a-z0-9]+(?:__[a-z0-9]+)+)__([A-Za-z0-9_]+)$/.exec(String(name || ''));
  return m ? m[1].split('__').join('_').toLowerCase() : null;
}

// What the name is for: the documented one when a tool documents this exact name, else the set of
// capabilities its tokens carry. Empty means the name says nothing and nothing is rewritten.
function capabilitiesOf(name) {
  const exact = NAME_CAPABILITY.get(String(name || '').toLowerCase());
  if (exact) return new Set([exact]);
  const set = new Set();
  for (const token of tokenize(name)) {
    const cap = TOKEN_CAPABILITY.get(token.toLowerCase());
    if (cap) set.add(cap);
  }
  return set;
}

// A key is the same key however it is spelled: file_path, filePath and file-path are one name.
function normalizeKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function schemaKeysOf(tool) {
  const props = tool?.parameters?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [];
  return Object.keys(props);
}

// Which schema key an incoming key is another way of writing. Two ways, strongest first:
//
//   1. the same letters: filePath, file-path and file_path are one key.
//   2. one name inside the other: path and file_path, dir and dir_path. Only for a string value, so a
//      number or a flag is never moved into a longer name it happens to sit inside.
//
// One candidate or nothing. Two schema keys that both fit is a guess, and a wrong key is an argument
// the caller will refuse in a way that names the wrong thing.
function schemaMatch(key, value, keys) {
  const shape = normalizeKey(key);
  if (!shape) return null;
  const exact = keys.filter(k => normalizeKey(k) === shape);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  if (typeof value !== 'string') return null;
  const loose = keys.filter(k => {
    const other = normalizeKey(k);
    return other !== shape && (other.includes(shape) || shape.includes(other));
  });
  return loose.length === 1 ? loose[0] : null;
}

/**
 * The arguments as the client's schema names them.
 *
 * A rename happens only when the schema names exactly one key this one is another way of writing, and
 * that key is not already used. A key the schema does not name is left alone: the client may still
 * read it, and a dropped key is a lost instruction. A falsy value is a value.
 */
function repairArgs(args, tool) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const keys = schemaKeysOf(tool);
  if (!keys.length) return args;
  const entries = Object.entries(args);
  const renames = new Map();
  for (const [key, value] of entries) {
    if (keys.includes(key)) continue;                    // the schema already has this one
    const target = schemaMatch(key, value, keys);
    if (!target || Object.hasOwn(args, target)) continue; // no single fit, or the client has both
    renames.set(key, target);
  }
  if (!renames.size) return args;
  // Rebuilt in the original order, with each renamed key standing where the old one stood: an
  // argument list is read by people in diffs, and a reordered one hides what changed.
  const out = {};
  for (const [key, value] of entries) {
    const target = renames.get(key);
    if (target) out[target] = value;
    else out[key] = value;
  }
  return out;
}

/**
 * Sanitize a tool name to conform to upstream API length and character constraints.
 * OpenAI Chat: 1-64 letters, digits, underscores or hyphens (^[a-zA-Z0-9_-]{1,64}$).
 * Vertex AI / Gemini: 1-64 alphanumeric or underscore (^[a-zA-Z_][a-zA-Z0-9_]*$).
 * If length > 64, preserves a 32-char head, 22-char tail, and embeds an 8-char sha256 hash.
 */
export function sanitizeToolName(name, { allowHyphens = true } = {}) {
  if (typeof name !== 'string' || !name) return 'tool';
  const pattern = allowHyphens ? /[^a-zA-Z0-9_-]/g : /[^a-zA-Z0-9_]/g;
  let cleaned = name.replace(pattern, '_');
  if (!allowHyphens && /^[0-9]/.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }
  if (cleaned.length <= 64 && cleaned === name) return name;
  if (cleaned.length <= 64) return cleaned;
  const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
  const head = cleaned.slice(0, 32);
  const tail = cleaned.slice(-22);
  return `${head}_${hash}_${tail}`;
}

/**
 * The vocabulary one request declared. `declared` is the client's own tool list, as `ir.tools` holds
 * it: `{ name, parameters }`, the same names and schemas the client will check the call against.
 *
 * A list with no tools, or one where nothing can be confused, leaves every call untouched.
 */
export function createToolVocab(declared) {
  // Only a tool the caller executes can be a rename target. A tool the provider runs answers in
  // band and its result reaches the caller without the caller executing anything; handing such a
  // call back as a client tool moves the work, silently, to the machine the user is sitting at.
  const tools = (Array.isArray(declared) ? declared : [])
    .filter(t => t && typeof t.name === 'string' && t.name && t.side !== 'provider');
  const byName = new Map();
  const candidates = [];
  const shortenedToOriginal = new Map();

  for (const t of tools) {
    const caps = capabilitiesOf(t.name);
    const safeChat = sanitizeToolName(t.name, { allowHyphens: true });
    const safeVertex = sanitizeToolName(t.name, { allowHyphens: false });
    if (safeChat !== t.name) {
      shortenedToOriginal.set(safeChat, t.name);
    }
    if (safeVertex !== t.name) {
      shortenedToOriginal.set(safeVertex, t.name);
    }
    const entry = { tool: t, name: t.name, namespace: namespaceOf(t.name), caps };
    // Keyed by the exact spelling: a client checks tool names exactly, so `read` is not the same
    // tool as `Read` to it, and that difference is the whole reason this layer exists.
    byName.set(t.name, entry);
    candidates.push(entry);
  }
  // Nothing is gained when the client declared one tool and the model answered with another name:
  // there is no second answer to pick between, so the call stands and the client reports it.
  const useful = candidates.length >= 2 && candidates.some(c => c.caps.size > 0);

  function isShortened(upstream) {
    const raw = String(upstream || '');
    return shortenedToOriginal.has(raw);
  }

  function name(upstream) {
    const raw = String(upstream || '');
    if (!raw || raw === 'tool') return upstream;
    if (shortenedToOriginal.has(raw)) return shortenedToOriginal.get(raw);
    if (byName.has(raw)) return upstream;                 // already the client's own name
    if (!useful) return upstream;
    const ns = namespaceOf(raw);
    if (ns) return upstream;                              // a server's tool never becomes a local one
    const want = capabilitiesOf(raw);
    if (!want.size) return upstream;
    let winner = null;
    let ties = 0;
    for (const c of candidates) {
      if (c.namespace) continue;                          // and the other way round
      let covers = true;
      for (const cap of want) {
        if (!c.caps.has(cap)) { covers = false; break; }
      }
      if (!covers) continue;
      ties++;
      winner = c;
    }
    // One tool covers everything the name asks for, and only one does.
    return ties === 1 ? winner.name : upstream;
  }

  function args(upstream, argsJson) {
    const fixedName = name(upstream);
    if (!useful && !shortenedToOriginal.has(String(upstream || ''))) return argsJson;
    const target = byName.get(fixedName);
    if (!target) return argsJson;
    let parsed;
    try {
      parsed = JSON.parse(argsJson || '{}');
    } catch {
      return argsJson;   // a truncated payload is passed through: changing bytes helps nobody
    }
    const repaired = repairArgs(parsed, target.tool);
    if (repaired === parsed) return argsJson;
    return JSON.stringify(repaired);
  }

  return {
    name,
    args,
    isShortened,
    /** Both halves at once, for a call that is already whole. */
    repair(upstream, argsJson) {
      const fixedName = name(upstream);
      return { name: fixedName, args: args(upstream, argsJson), renamed: fixedName !== upstream };
    }
  };
}

/** A vocabulary that never rewrites anything, for a request that declared no tools. */
export const NULL_TOOL_VOCAB = Object.freeze({
  name: n => n,
  args: (n, a) => a,
  isShortened: () => false,
  repair: (n, a) => ({ name: n, args: a, renamed: false })
});
