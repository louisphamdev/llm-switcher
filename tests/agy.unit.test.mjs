// Unit tests for the Antigravity CLI (agy) in the launch state, the shims and the launch hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-switcher-agy-unit-'));
process.env.LLM_SWITCHER_STATE_DIR = tmp;
process.env.LLM_SWITCHER_CONFIG = path.join(tmp, 'config.json');
const s = await import('../state.mjs');
const shim = await import('../shim.mjs');
const plugin = await import('../plugin.mjs');

const cfgWith = (active) => ({
  activeProfiles: { claude: null, codex: null, agy: null, ...active },
  profiles: { pool: { name: 'pool', tool: 'agy', baseURL: 'https://intact.example/v1', apiKey: 'k', defaultModels: { main: 'antigravity/*' } } }
});

test('agy alone gets CLOUD_CODE_URL and starts no interceptor', () => {
  const st = s.computeLaunchState(cfgWith({ agy: 'pool' }), 3456);
  assert.equal(st.active, true);
  assert.equal(st.blindfold, null);
  assert.deepEqual(st.envAgy, [['CLOUD_CODE_URL', 'http://127.0.0.1:3456']]);
  assert.deepEqual(st.envClaude, []);
  assert.match(st.routeAgy, /^agy -> pool \| intact\.example \| antigravity\/\*/);
});

test('agy off writes no agy variables', () => {
  const st = s.computeLaunchState(cfgWith({}), 3456);
  assert.equal(st.active, false);
  assert.deepEqual(st.envAgy, []);
  assert.equal(st.routeAgy, '');
});

test('only an agy profile serves agy, and the old single pointer never turns agy on', () => {
  assert.equal(s.profileAcceptsTarget({ tool: 'agy' }, 'agy'), true);
  assert.equal(s.profileAcceptsTarget({ inFormat: 'auto' }, 'agy'), false);
  assert.equal(s.profileAcceptsTarget({ tool: 'agy' }, 'claude'), false);
  assert.equal(s.getActiveMap({ activeProfile: 'legacy' }).agy, null);
  assert.deepEqual(s.modelSlotsForProfile({ tool: 'agy' }), ['main']);
});

test('the launch files of agy are written and emptied with the others', () => {
  s.applyLaunchState(cfgWith({ agy: 'pool' }), 3456);
  assert.match(fs.readFileSync(s.paths.envAgySh, 'utf8'), /export CLOUD_CODE_URL='http:\/\/127\.0\.0\.1:3456'/);
  assert.match(fs.readFileSync(s.paths.envAgyCmd, 'utf8'), /SET "CLOUD_CODE_URL=http:\/\/127\.0\.0\.1:3456"/);
  assert.ok(fs.existsSync(s.paths.activeFlag));
  s.emptyToolEnvFiles('agy');
  assert.equal(fs.readFileSync(s.paths.envAgySh, 'utf8'), '');
  assert.equal(fs.readFileSync(s.paths.routeAgy, 'utf8'), '');
  s.applyLaunchState(cfgWith({ agy: 'pool' }), 3456);
  s.clearLaunchState(3456);
  assert.equal(fs.readFileSync(s.paths.envAgyCmd, 'utf8'), '');
  assert.equal(fs.existsSync(s.paths.activeFlag), false);
});

test('the agy shim reads only its own files, takes no CA, and scrubs a stale gateway URL only while off', () => {
  const win = shim.renderShim('agy', 'win32');
  assert.match(win, /env-agy\.cmd/);
  assert.match(win, /route-agy\.txt/);
  assert.doesNotMatch(win, /env-claude|NODE_EXTRA_CA_CERTS|STATE_HELPER/);
  assert.match(win, /if not "%TOOL_ACTIVE%"=="1" if defined CLOUD_CODE_URL call :SCRUB_URL CLOUD_CODE_URL/);
  assert.match(win, /where agy\.exe/);
  const posix = shim.renderShim('agy', 'linux');
  assert.match(posix, /env-agy\.sh/);
  assert.doesNotMatch(posix, /export NODE_EXTRA_CA_CERTS/);
  assert.match(posix, /if \[ "\$TOOL_ACTIVE" != "1" \] && \[ -n "\$_u" \]; then/);
  assert.match(shim.renderShim('claude', 'win32'), /NODE_EXTRA_CA_CERTS/, 'Claude keeps its CA block');
  assert.equal(shim.routeEvidence('agy', ' CLOUD_CODE_URL=http://127.0.0.1:3456 PATH=x'), true);
});

test('the agy hook is merged into hooks.json, unquoted, and removed without touching other hooks', () => {
  const agyHome = path.join(tmp, 'agy');
  fs.mkdirSync(agyHome, { recursive: true });
  const file = path.join(agyHome, 'hooks.json');
  fs.writeFileSync(file, JSON.stringify({ 'lint-checker': { PostToolUse: [] } }));
  const opts = { agyHome, claudeSkillsDir: path.join(tmp, 'skills'), codexHome: path.join(tmp, 'codex') };
  const r = plugin.installPlugin(opts, 'test');
  assert.ok(r.installed.includes('agy'), JSON.stringify(r));
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(doc['lint-checker'], 'another hook stays');
  const cmd = doc[plugin.AGY_HOOK_NAME].SessionStart[0].command;
  assert.match(cmd, /^node \S+\/hook-status\.mjs agy$/);
  assert.doesNotMatch(cmd, /["\\]/, 'agy keeps quotes literally, so the command has none');
  assert.equal(plugin.pluginStatus(opts).agy.installed, true);
  plugin.uninstallPlugin(opts);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['lint-checker']);
  assert.equal(plugin.agyHookCommand('C:/Program Files/x/hook-status.mjs'), null, 'a path with a space cannot be run by agy');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the launch files of every tool stay out of git and out of the npm package', () => {
  const ignored = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split(/\r?\n/);
  for (const tool of s.TOOLS) {
    for (const f of [`env-${tool}.cmd`, `env-${tool}.sh`, `route-${tool}.txt`]) {
      assert.ok(ignored.includes(f), `${f} must be ignored: it holds this machine's route`);
    }
  }
});

test('migration keeps the agy pointer and renames every pointer of a command-word profile', () => {
  const mig = (cfg) => s.migrateConfigInMemory(cfg).config.activeProfiles;
  assert.equal(mig({ profiles: { old: { baseURL: 'x' }, a: { tool: 'agy', baseURL: 'x' } }, activeProfiles: { claude: null, codex: null, agy: 'a' } }).agy, 'a');
  assert.equal(mig({ profiles: { agy: { tool: 'claude', baseURL: 'x' } }, activeProfiles: { claude: 'agy' } }).claude, 'agy-profile');
  assert.equal(mig({ profiles: { agy: { tool: 'agy', baseURL: 'x' } }, activeProfiles: { agy: 'agy' } }).agy, 'agy-profile');
  assert.equal(mig({ profiles: { agy: { tool: 'codex', baseURL: 'x' } }, activeProfiles: { codex: 'agy' } }).codex, 'agy-profile');
  assert.equal(mig({ profiles: { c: { tool: 'claude', baseURL: 'x' } }, activeProfiles: { agy: 'c' } }).agy, null);
});

test('every target alias of the switch command is a reserved command word', () => {
  // A word that is not reserved can also be a profile key, and then `switch <word>` is ambiguous.
  const src = fs.readFileSync(new URL('../switch.mjs', import.meta.url), 'utf8');
  const literal = src.match(/const TARGET_ALIASES = (\{[^}]*\})/)[1];
  const aliases = Function(`return ${literal}`)();
  for (const key of Object.keys(aliases)) assert.ok(s.COMMAND_WORDS.has(key), `${key} is not in COMMAND_WORDS`);
});

const pluginDirs = (name) => {
  const root = path.join(tmp, name);
  const opts = { agyHome: path.join(root, 'agy'), claudeSkillsDir: path.join(root, 'skills'), codexHome: path.join(root, 'codex') };
  for (const d of Object.values(opts)) fs.mkdirSync(d, { recursive: true });
  return opts;
};

test('a hook script path with a space skips agy, and the other tools still install', () => {
  const opts = { ...pluginDirs('space'), hookScript: path.join(tmp, 'Program Files', 'hook-status.mjs') };
  const r = plugin.installPlugin(opts);
  assert.deepEqual(r.installed.sort(), ['claude', 'codex']);
  assert.deepEqual(r.failed, []);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].tool, 'agy');
  assert.match(r.skipped[0].reason, /space/);
  assert.equal(fs.existsSync(path.join(opts.agyHome, 'hooks.json')), false);
});

test('an agy hooks.json whose root is not an object is left exactly as it is', () => {
  for (const body of ['[{"a":1}]', '"text"', '7']) {
    const opts = pluginDirs(`root-${body.length}`);
    const file = path.join(opts.agyHome, 'hooks.json');
    fs.writeFileSync(file, body);
    const inst = plugin.installPlugin(opts);
    assert.equal(inst.failed.find(f => f.tool === 'agy')?.tool, 'agy', `install ${body}`);
    assert.equal(fs.readFileSync(file, 'utf8'), body);
    const un = plugin.uninstallPlugin(opts);
    assert.ok(un.installed.includes('agy') && !un.failed.length, `uninstall ${body}: our hook cannot be there`);
    assert.equal(fs.readFileSync(file, 'utf8'), body);
  }
});

test('a tool whose install throws is reported, and the other tools still install', () => {
  const opts = pluginDirs('throws');
  // A directory where the file must go makes the write throw.
  fs.mkdirSync(path.join(opts.codexHome, 'hooks.json'));
  const r = plugin.installPlugin(opts);
  assert.ok(r.installed.includes('claude') && r.installed.includes('agy'), JSON.stringify(r));
  assert.equal(r.failed.find(f => f.tool === 'codex')?.tool, 'codex');
});

test('plugin status names an agy hooks.json that does not parse', () => {
  const opts = pluginDirs('status-broken');
  fs.writeFileSync(path.join(opts.agyHome, 'hooks.json'), '{ broken');
  const st = plugin.pluginStatus(opts).agy;
  assert.equal(st.installed, false);
  assert.match(st.error, /parse/);
  fs.writeFileSync(path.join(opts.agyHome, 'hooks.json'), '[]');
  assert.match(plugin.pluginStatus(opts).agy.error, /object/);
});

test('the agy launch hook warns when agy is routed and no gateway answers, and is silent when it is not routed', async () => {
  const { spawnSync } = await import('node:child_process');
  const net = await import('node:net');
  const closed = await new Promise((resolve) => { const sv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = sv.address(); sv.close(() => resolve(port)); }); });
  const run = () => spawnSync(process.execPath, [new URL('../hook-status.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'agy'], {
    env: { ...process.env, LLM_SWITCHER_STATE_DIR: tmp, LLM_SWITCHER_CONFIG: path.join(tmp, 'config.json'), LLM_SWITCHER_PORT: String(closed) },
    encoding: 'utf8'
  });
  fs.writeFileSync(s.paths.routeAgy, 'agy -> pool | intact.example | antigravity/*');
  fs.writeFileSync(s.paths.activeFlag, '1');
  try {
    const warned = JSON.parse(run().stdout);
    assert.match(warned.systemMessage, /^WARNING: .*agy -> pool/);
    fs.writeFileSync(s.paths.routeAgy, '');
    assert.deepEqual(JSON.parse(run().stdout), {});
  } finally {
    fs.rmSync(s.paths.routeAgy, { force: true });
    fs.rmSync(s.paths.activeFlag, { force: true });
  }
});
