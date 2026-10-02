#!/usr/bin/env node
// Reports the switcher route to a coding tool at the start of a session.
//
// The shim toast fires only when the shim runs, and that needs the shim directory first on PATH.
// This runs inside the tool, so it reports even when the launcher is the person's own script. Claude
// Code, Codex and agy each read one JSON object from stdout and take `systemMessage` from it.
//
// Two rules hold, whatever happens:
//   - It prints exactly one JSON object and exits 0. A hook must never fail a session.
//   - A tool with no profile gets an empty object. Silence for a tool on its official endpoint.
//
// Usage: node hook-status.mjs <claude|codex|agy>
import fs from 'node:fs';

const TOOLS = ['claude', 'codex', 'agy'];
const ROUTE_FILE = { claude: 'routeClaude', codex: 'routeCodex', agy: 'routeAgy' };

const readOrEmpty = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
};

async function message(tool) {
  if (!TOOLS.includes(tool)) return {};
  // Imported here, not at the top: a failure to load the state module must still print an object.
  const s = await import('./state.mjs');

  // The route file is written with the env file of the same tool, so it is empty exactly when that
  // tool is not routed. One read answers both "is the switcher on" and "is this tool on".
  const route = readOrEmpty(s.paths[ROUTE_FILE[tool]]).trim();
  if (!route || !fs.existsSync(s.paths.activeFlag)) return {};

  const port = s.resolvePort([], s.loadConfig() || {});
  const state = await s.probeGateway(port);
  if (state === 'ours') {
    return { systemMessage: `LLM Switcher is ON. ${route}. This tool does not reach its official endpoint.` };
  }
  // The dangerous state: the launch files route the tool, and nothing answers. The tool fails on
  // its first request with a connection error that names no cause.
  const held = state === 'free'
    ? `the gateway on port ${port} does not answer`
    : `port ${port} does not answer as this switcher (another program holds it)`;
  return {
    systemMessage: `WARNING: LLM Switcher is set to route this tool (${route}), but ${held}. `
      + 'The tool cannot reach the provider. Run `switch on` to start the gateway, '
      + 'or `switch off` to use the official endpoint.'
  };
}

message(process.argv[2])
  .then((out) => process.stdout.write(JSON.stringify(out)))
  .catch(() => process.stdout.write('{}'))
  .finally(() => process.exit(0));
