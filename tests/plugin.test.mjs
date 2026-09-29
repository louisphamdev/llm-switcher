// Installing the launch hook into the two coding tools, without editing any configuration of theirs.
//
// Claude Code loads any folder under a skills directory that holds `.claude-plugin/plugin.json` as
// a plugin, on the next session, with no marketplace and no install step. Codex loads
// `$CODEX_HOME/hooks.json` by itself. So both tools get the hook from a file of their own, and
// `settings.json` and `config.toml` are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { renderClaudePlugin, renderClaudeHooks, renderCodexHooks, installPlugin, uninstallPlugin, pluginStatus } =
  await import(pathToFileURL(path.join(ROOT, 'plugin.mjs')).href);

function dirs(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-plug-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const claudeSkillsDir = path.join(home, '.claude', 'skills');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(claudeSkillsDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  return { home, claudeSkillsDir, codexHome, opts: { claudeSkillsDir, codexHome } };
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('the Claude plugin manifest and hooks name the hook script and the tool claude', () => {
  const manifest = JSON.parse(renderClaudePlugin());
  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.name.length > 0, 'a plugin needs a name, it becomes the skills-dir id');
  assert.ok(manifest.version, 'and a version');
  const hooks = JSON.parse(renderClaudeHooks());
  const entry = hooks.hooks.SessionStart[0].hooks[0];
  assert.equal(entry.type, 'command');
  assert.match(JSON.stringify(entry), /hook-status\.mjs/);
  assert.match(JSON.stringify(entry), /"claude"/, 'the claude plugin asks about claude');
  assert.doesNotMatch(JSON.stringify(entry), /codex/);
});

test('the Codex hooks file asks about codex and matches a fresh start or a resume', () => {
  const hooks = JSON.parse(renderCodexHooks());
  const group = hooks.hooks.SessionStart[0];
  assert.match(group.matcher, /startup/, 'the first open of a session');
  assert.match(group.matcher, /resume/, 'and a resumed session, which is the bypass this exists for');
  const entry = group.hooks[0];
  assert.equal(entry.type, 'command');
  assert.match(entry.command, /hook-status\.mjs/);
  assert.match(entry.command, /codex/);
});

test('install writes a plugin for Claude Code and a hooks file for Codex, and repeats cleanly', (t) => {
  const { claudeSkillsDir, codexHome, opts } = dirs(t);
  const first = installPlugin(opts);
  assert.deepEqual(first.failed, [], 'nothing failed');
  assert.deepEqual(first.installed.sort(), ['claude', 'codex']);

  const manifest = path.join(claudeSkillsDir, 'llm-switcher-status', '.claude-plugin', 'plugin.json');
  assert.ok(fs.existsSync(manifest), 'the manifest is what makes the folder a plugin');
  assert.ok(fs.existsSync(path.join(claudeSkillsDir, 'llm-switcher-status', 'hooks', 'hooks.json')));
  assert.ok(fs.existsSync(path.join(codexHome, 'hooks.json')));

  // The whole point: neither tool's own configuration file is created or changed.
  assert.equal(fs.existsSync(path.join(codexHome, 'config.toml')), false, 'config.toml is never written');

  const second = installPlugin(opts);
  assert.deepEqual(second.failed, [], 'a second install is a no-op that still succeeds');
  assert.equal(JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8')).hooks.SessionStart.length, 1,
    'and it does not add a second copy of our entry');
});

test('install keeps a Codex hook that belongs to someone else', (t) => {
  const { codexHome, opts } = dirs(t);
  fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({
    description: 'the rule gate of this machine',
    hooks: {
      PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'node rule-gate.js' }] }],
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'node someone-else.js' }] }]
    }
  }, null, 2));

  installPlugin(opts);
  const after = readJson(path.join(codexHome, 'hooks.json'));
  assert.equal(after.hooks.PreToolUse.length, 1, 'another event is untouched');
  assert.match(JSON.stringify(after.hooks.PreToolUse), /rule-gate/);
  const commands = after.hooks.SessionStart.flatMap(g => g.hooks.map(h => h.command));
  assert.ok(commands.some(c => /someone-else\.js/.test(c)), 'the other SessionStart hook survives');
  assert.ok(commands.some(c => /hook-status\.mjs/.test(c)), 'and ours is added beside it');

  const removed = uninstallPlugin(opts);
  assert.deepEqual(removed.failed, []);
  const end = readJson(path.join(codexHome, 'hooks.json'));
  const endCommands = JSON.stringify(end);
  assert.match(endCommands, /someone-else\.js/, 'uninstall leaves the other hook in place');
  assert.match(endCommands, /rule-gate/);
  assert.doesNotMatch(endCommands, /hook-status\.mjs/, 'and takes only ours away');
});

test('install refuses a Codex hooks file it cannot parse, and changes nothing', (t) => {
  const { codexHome, opts } = dirs(t);
  const f = path.join(codexHome, 'hooks.json');
  fs.writeFileSync(f, '{ not json at all');
  const r = installPlugin(opts);
  assert.equal(fs.readFileSync(f, 'utf8'), '{ not json at all', 'a file that may hold real hooks is never overwritten');
  assert.ok(r.failed.some(x => x.tool === 'codex'), 'and the refusal is reported');
  assert.ok(r.installed.includes('claude'), 'while the other tool still gets its plugin');
});

test('install leaves a folder that is not our plugin alone', (t) => {
  const { claudeSkillsDir, opts } = dirs(t);
  const dir = path.join(claudeSkillsDir, 'llm-switcher-status');
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'someone-elses-work' }));
  const r = installPlugin(opts);
  assert.match(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'), /someone-elses-work/);
  assert.ok(r.failed.some(x => x.tool === 'claude'));
});

test('status reports each tool, and says plainly when nothing is installed', (t) => {
  const { opts } = dirs(t);
  const before = pluginStatus(opts);
  assert.equal(before.claude.installed, false);
  assert.equal(before.codex.installed, false);
  installPlugin(opts);
  const after = pluginStatus(opts);
  assert.equal(after.claude.installed, true);
  assert.equal(after.codex.installed, true);
  assert.match(after.claude.path, /llm-switcher-status/);
  assert.match(after.codex.path, /hooks\.json$/);
});
