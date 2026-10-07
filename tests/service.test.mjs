// Unit tests for service.mjs: the text of each OS service definition, and how the CLI reads the
// port back (audit N-5, LC-2, LC-3). Windows itself is not available here; these tests pin what
// the XML says, not how Task Scheduler runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  systemdUnit, launchdPlist, scheduledTaskXml, portFromServiceText, autoupdateFromServiceText, decodeConsoleText, serviceEnv, writeServiceFile
} from '../service.mjs';

const HAS_XMLLINT = (() => { try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('serviceEnv passes only the variables that change where the gateway reads and writes', () => {
  const env = serviceEnv({ CLAUDE_CONFIG_DIR: '/c', LLM_SWITCHER_CONFIG: '/cfg.json', LLM_SWITCHER_BLINDFOLD_CERTS: '', HOME: '/h', PATH: '/bin' });
  assert.deepEqual(env, [['CLAUDE_CONFIG_DIR', '/c'], ['LLM_SWITCHER_CONFIG', '/cfg.json']]);
  // The data folder override must reach the service too, or it reads another config.json.
  assert.deepEqual(serviceEnv({ LLM_SWITCHER_HOME: '/data' }), [['LLM_SWITCHER_HOME', '/data']]);
});

test('systemd unit quotes the command and carries the environment', () => {
  const text = systemdUnit({ nodeBin: '/opt/node dir/node', script: '/srv/llm switcher/proxy.mjs', port: 4000, env: [['CLAUDE_CONFIG_DIR', '/home/a b/.claude']] });
  assert.match(text, /^ExecStart="\/opt\/node dir\/node" "\/srv\/llm switcher\/proxy.mjs" --port 4000$/m);
  assert.match(text, /^Environment="CLAUDE_CONFIG_DIR=\/home\/a b\/.claude"$/m);
  assert.equal(portFromServiceText(text), 4000);
});

const plist = () => launchdPlist({ nodeBin: '/n', script: '/a&b/proxy.mjs', port: 4001, logPath: '/l<og>', env: [['CLAUDE_CONFIG_DIR', '/x&y']] });
const taskXml = () => scheduledTaskXml({ nodeBin: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\A & B\\llm-switcher\\proxy.mjs', port: 4002, userId: 'PC\\a&b', systemRoot: 'C:\\Windows' });

test('the plist and the task XML are well-formed', { skip: !HAS_XMLLINT && 'needs xmllint' }, () => {
  execFileSync('xmllint', ['--noout', '-'], { input: plist() });
  execFileSync('xmllint', ['--noout', '-'], { input: taskXml().replace('encoding="UTF-16"', 'encoding="UTF-8"') });
});

test('launchd plist escapes values and carries the environment', () => {
  const text = plist();
  assert.match(text, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>CLAUDE_CONFIG_DIR<\/key>\s*<string>\/x&amp;y<\/string>/);
  assert.equal(portFromServiceText(text), 4001);
});

test('Windows task XML keeps the command and its arguments apart and has no run-time limit', () => {
  const xml = taskXml();
  // node.exe is a console program: started directly at logon it opens a terminal window, and closing
  // that window stops the gateway. conhost --headless gives it a console that nobody sees.
  assert.match(xml, /<Command>C:\\Windows\\System32\\conhost.exe<\/Command>/);
  assert.match(xml, /<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; &quot;C:\\Users\\A &amp; B\\llm-switcher\\proxy.mjs&quot; --port 4002<\/Arguments>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>PC\\a&amp;b<\/UserId>/);
  assert.equal(portFromServiceText(xml), 4002);
});

test('the port is read back from UTF-16 console output, as schtasks /Query /XML prints it', () => {
  const xml = scheduledTaskXml({ nodeBin: 'node.exe', script: 'proxy.mjs', port: 4567, userId: 'u' });
  assert.equal(portFromServiceText(decodeConsoleText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]))), 4567);
  assert.equal(portFromServiceText(decodeConsoleText(Buffer.from(xml, 'utf16le'))), 4567);
  assert.equal(portFromServiceText(decodeConsoleText(Buffer.from(xml, 'utf8'))), 4567);
  assert.equal(portFromServiceText('no port here'), null);
});

test('autoupdate flag is placed into task XML, systemd unit, and launchd plist', () => {
  const xml = scheduledTaskXml({ nodeBin: 'node.exe', script: 'proxy.mjs', port: 3456, userId: 'u', autoupdate: true });
  assert.match(xml, /<Arguments>--headless &quot;node\.exe&quot; &quot;proxy\.mjs&quot; --port 3456 --autoupdate<\/Arguments>/);
  assert.equal(portFromServiceText(xml), 3456);

  const unit = systemdUnit({ nodeBin: '/usr/bin/node', script: '/opt/proxy.mjs', port: 3456, autoupdate: true });
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/proxy\.mjs" --port 3456 --autoupdate/);
  assert.equal(portFromServiceText(unit), 3456);

  const plistText = launchdPlist({ nodeBin: '/node', script: '/proxy.mjs', port: 3456, logPath: '/log', autoupdate: true });
  assert.match(plistText, /<string>--autoupdate<\/string>/);
  assert.equal(portFromServiceText(plistText), 3456);
});

// `switch port` rewrites the service. It must keep the choice that `service install --no-autoupdate` made.
test('the autoupdate flag is read back from each service definition', () => {
  for (const autoupdate of [true, false]) {
    const texts = [
      scheduledTaskXml({ nodeBin: 'node.exe', script: 'proxy.mjs', port: 3456, userId: 'u', autoupdate }),
      systemdUnit({ nodeBin: '/usr/bin/node', script: '/opt/proxy.mjs', port: 3456, autoupdate }),
      launchdPlist({ nodeBin: '/node', script: '/proxy.mjs', port: 3456, logPath: '/log', autoupdate })
    ];
    for (const text of texts) assert.equal(autoupdateFromServiceText(text), autoupdate);
  }
});

test('writeServiceFile keeps a hand-edited definition as .bak before it replaces it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsw-svc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sub', 'llm-switcher.service');
  assert.equal(writeServiceFile(file, 'one'), null, 'a new file needs no backup');
  assert.equal(writeServiceFile(file, 'one'), null, 'the same content needs no backup');
  fs.writeFileSync(file, 'hand edit');
  assert.equal(writeServiceFile(file, 'two'), `${file}.bak`);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), 'hand edit');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
});
