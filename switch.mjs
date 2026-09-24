#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import {
  ROOT_DIR, STATE_DIR, TARGETS, configPath, claudeSettingsPath, paths, loadConfig, getConfigLoadError, saveConfig,
  resolvePort, parsePort, findProfileKey, getActiveMap, setTargetProfile, activateProfile, deactivateAll,
  applyLaunchState, clearLaunchState, computeLaunchState,
  modelSlotsForProfile, modelForSlot, model1MForSlot, readAdminToken, adminTokenPath, openLog,
  probeGateway, probeBlindfold, blindfoldPreflight, stopRecordedBlindfold, writeDashboardLauncher,
  contractLabSettings, codexPublicModelsWarning
} from './state.mjs';
import { runProbe, runCheck } from './contract.mjs';
import {
  SHIM_DIR, installShims, uninstallShims, shimStatus, pathExportLine, pathOrderHint,
  suggestedRcFiles, auditRunningProcesses
} from './shim.mjs';
import {
  serviceEnv, systemdUnit, launchdPlist, scheduledTaskXml, decodeConsoleText, portFromServiceText, writeServiceFile
} from './service.mjs';

const proxyScript = path.join(ROOT_DIR, 'proxy.mjs');
const proxyLogPath = paths.proxyLog;
const userProfile = os.homedir();

const config = loadConfig();
if (!config) {
  const err = getConfigLoadError();
  console.error(`[Error] Cannot load ${configPath}: ${err ? err.message : 'file not found'}`);
  if (!fs.existsSync(configPath)) {
    console.error(`Create it first:  cp "${path.join(ROOT_DIR, 'config.example.json')}" "${configPath}"   (then edit baseURL / apiKey)`);
  }
  process.exit(1);
}

const TARGET_ALIASES = {
  claude: 'anthropic', anthropic: 'anthropic',
  codex: 'responses', responses: 'responses',
  openai: 'openai-chat', chat: 'openai-chat', 'openai-chat': 'openai-chat',
  vertex: 'vertex', gemini: 'vertex'
};

// Strip --port/-p and their value from positional args. -p is the global option everywhere, as in
// resolvePort; `switch port <n>` is the command that changes the port.
function positionalArgs() {
  const out = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') { i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

// config.json is edited by hand and through the dashboard, so its strings reach the terminal
// untrusted. A control character could rewrite the screen or the window title.
const show = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');

function getTargetPort() {
  return resolvePort(process.argv.slice(2), config);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A port answer is not enough: probeGateway checks HMAC(admin.token, nonce), so a process that
// replays a /health body counts as foreign, not as this switcher.
async function checkProxyRunning(port) {
  return (await probeGateway(port)) === 'ours';
}

function startProxyBackground(port) {
  const log = openLog(proxyLogPath);
  const child = spawn(process.execPath, [proxyScript, '--port', String(port)], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true
  });
  child.unref();
  fs.closeSync(log);
  return child.pid;
}

// 'silent' is a listener that never answered: a hung gateway of ours, or another program.
const isHeld = (state) => state === 'foreign' || state === 'silent' || state === 'legacy';

function refuseForeignPort(port, owner, state = 'foreign') {
  if (state === 'legacy') {
    console.error(`[Error] An llm-switcher gateway older than 1.1.1 runs on port ${port}. Stop it, then run \`switch on\` again.`);
    console.error('        It cannot prove its identity, so this switcher does not stop it. Nothing was changed.');
    process.exit(1);
  }
  console.error(state === 'silent'
    ? `[Error] Port ${port} accepts connections but does not answer. A hung ${owner} or another program holds it.`
    : `[Error] Port ${port} is held by another process, not by ${owner}.`);
  console.error('        Stop that process, or choose another port with `switch port <n>`. Nothing was changed.');
  process.exit(1);
}

async function ensureProxyRunning(port) {
  const state = await probeGateway(port);
  if (state === 'ours') {
    console.log(`Proxy is running on port ${port} (config reloaded dynamically).`);
    return;
  }
  if (isHeld(state)) refuseForeignPort(port, 'this switcher', state);
  // An installed service owns the gateway: a detached copy next to it would be a second gateway.
  // A service whose port cannot be read is started too, never doubled.
  const svc = installedService();
  const svcPort = svc ? servicePort(svc) : null;
  if (svc && (svcPort === port || svcPort === null)) {
    console.log(`Starting the ${svc} service${svcPort ? ` on port ${port}` : ''}...`);
    serviceStart(svc);
  } else {
    console.log(`Starting proxy service on port ${port}...`);
    startProxyBackground(port);
  }
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if ((await probeGateway(port)) === 'ours') return;
  }
  console.error(`[Error] Proxy did not come up on port ${port}. See ${proxyLogPath} for details.`);
  if (svc && svcPort === null) console.error(`        The ${svc} service definition could not be read. Run \`switch service install\` again.`);
  process.exit(1);
}

// The gateway owns the blindfold interceptor. After every write of launch state the CLI asks it to
// bring the interceptor in line with config.json.
async function requestBlindfoldSync(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/blindfold/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-llm-switcher-token': readAdminToken() || '' },
      body: '{}',
      signal: AbortSignal.timeout(15000)
    });
    return await r.json();
  } catch (err) {
    return { ok: false, error: `the gateway on port ${port} did not answer: ${err.message}` };
  }
}

// With the gateway up it reconciles; with it down only a stop is safe, and stopping never spawns.
// When the sync fails and no target wants an interceptor any more, the CLI stops it itself.
async function syncOrStopBlindfold(port, cfg) {
  if (await checkProxyRunning(port)) {
    const r = await requestBlindfoldSync(port);
    if (r.ok || computeLaunchState(cfg, port).blindfold) return r;
  }
  return stopRecordedBlindfold();
}

// Same atomic, private write as saveConfig, for bytes that must come back unchanged.
function restoreConfigBytes(bytes) {
  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, configPath);
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      execFileSync('open', [url], { stdio: 'ignore' });
    } else {
      execFileSync('xdg-open', [url], { stdio: 'ignore' });
    }
  } catch {}
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
  } catch {}
}

// Find PIDs LISTENing on exactly this port (exact-match the local address column, avoids mismatching :34560).
function listeningPids(port) {
  const pids = new Set();
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        // Proto  Local  Foreign  State  PID — foreign "0.0.0.0:0" means listening (independent of OS language)
        if (parts.length >= 5 && /^TCP$/i.test(parts[0]) && parts[1].endsWith(`:${port}`) && /:0$/.test(parts[2])) {
          const pid = parseInt(parts[parts.length - 1], 10);
          if (pid > 0) pids.add(pid);
        }
      }
      return [...pids];
    }
    try {
      const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const s of out.split(/\s+/)) {
        const pid = parseInt(s, 10);
        if (pid > 0) pids.add(pid);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // Minimal Linux images ship ss (iproute2) but no lsof.
      const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
      for (const m of out.matchAll(/pid=(\d+)/g)) pids.add(parseInt(m[1], 10));
    }
  } catch {}
  return [...pids];
}

// Returns 'stopped', 'not-running', 'not-ours', 'legacy', 'silent' or 'still-running'. The kill targets the process that
// listens on the port, right after the identity probe confirmed that listener is this switcher.
async function stopProxy(port) {
  const state = await probeGateway(port);
  // Gone means the port is free; a slow answer is not proof that the gateway stopped.
  const waitGone = async () => {
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      if ((await probeGateway(port)) === 'free') return true;
    }
    return false;
  };
  // Our own unit needs no identity proof: its manager stops it. That also covers a unit that is
  // still starting (the port is free) and a hung gateway under the unit (the probe is silent).
  const svc = installedService();
  const ownUnit = svc && [port, null].includes(servicePort(svc));
  if (state === 'free') {
    if (!ownUnit) return 'not-running';
    serviceStop(svc);
    return 'stopped';
  }
  if (state === 'foreign') return 'not-ours';
  if (state === 'legacy') return 'legacy';
  if (state === 'silent') {
    if (ownUnit) {
      serviceStop(svc);
      if (await waitGone()) return 'stopped';
    }
    return 'silent';
  }
  // A supervisor restarts what we kill, so a service is stopped through its manager first.
  if (svc) {
    serviceStop(svc);
    if (await waitGone()) return 'stopped';
  }
  for (const pid of listeningPids(port)) if (pid !== process.pid) killPid(pid);
  return (await waitGone()) ? 'stopped' : 'still-running';
}

async function changePort(newPortStr) {
  const p = parsePort(newPortStr);
  if (!p) {
    console.error(`[Error] Invalid port: "${newPortStr}". Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
  const oldPort = resolvePort([], config);
  // Refuse before anything stops: the old gateway keeps running when the new port is taken.
  const target = await probeGateway(p);
  if (isHeld(target)) refuseForeignPort(p, 'this switcher', target);
  const svc = installedService();
  const wasRunning = await checkProxyRunning(oldPort);
  // Stop the old gateway even when a service is installed: it may be a copy started outside the unit.
  if (wasRunning) {
    console.log(`Stopping gateway on current port ${oldPort}...`);
    if ((await stopProxy(oldPort)) === 'still-running') {
      console.error(`[Error] The gateway on port ${oldPort} did not stop. The port is unchanged.`);
      process.exit(1);
    }
  }
  // Re-read just before the write: a dashboard save made while the gateway stopped must survive.
  const fresh = loadConfig() || config;
  fresh.port = p;
  saveConfig(fresh);
  if (process.env.LLM_SWITCHER_PORT) {
    console.log(`[WARN] LLM_SWITCHER_PORT env var is set and overrides config.json.`);
  }
  // A gateway that does not come up on the new port puts config.json and the gateway back. A detached
  // gateway that was started for the new port is stopped first: it may still come up after the wait.
  let startedPid = null;
  const rollBack = async (why) => {
    console.error(`[Error] ${why}`);
    if (startedPid) killPid(startedPid);
    const back = loadConfig() || fresh;
    back.port = oldPort;
    saveConfig(back);
    if (svc) installService(oldPort);
    else if (wasRunning) startProxyBackground(oldPort);
    let up = !svc && !wasRunning;
    for (let i = 0; i < 20 && !up; i++) { await sleep(250); up = await checkProxyRunning(oldPort); }
    console.error(`        config.json is back on port ${oldPort}${up ? '' : `, but no gateway answers there. See ${proxyLogPath}`}.`);
    process.exit(1);
  };
  if (svc) {
    // The unit fixes the port on its command line, so it is rewritten and restarted, not fought.
    console.log(`Reinstalling the ${svc} service on port ${p}...`);
    if (!installService(p)) await rollBack(`The ${svc} service could not be installed for port ${p}.`);
    let up = false;
    for (let i = 0; i < 20 && !up; i++) { await sleep(250); up = await checkProxyRunning(p); }
    if (!up) await rollBack(`The ${svc} service did not come up on port ${p}. See ${proxyLogPath}.`);
  } else if (wasRunning) {
    console.log(`Restarting gateway on new port ${p}...`);
    startedPid = startProxyBackground(p);
    let up = false;
    for (let i = 0; i < 20 && !up; i++) { await sleep(250); up = await checkProxyRunning(p); }
    if (!up) await rollBack(`The gateway did not come up on port ${p}. See ${proxyLogPath}.`);
  }
  reportSettings(applyLaunchState(fresh, p).settings);
  if (await checkProxyRunning(p)) {
    const bf = await requestBlindfoldSync(p);
    if (!bf.ok) {
      console.error(`[Error] ${bf.error}`);
      process.exit(1);
    }
  }
  console.log(`[SUCCESS] Port updated to ${p}.`);
}

function printProfile(profile) {
  console.log(`Input Target: ${show(profile.inFormat || 'auto').toUpperCase()}`);
  console.log(`Routing:      ${profile.outFormat ? `out=${show(profile.outFormat)}` : `mode=${show(profile.mode || 'hybrid')}`}`);
  console.log(`Upstream:     ${show(profile.baseURL || '(not set)')}`);
  for (const slot of modelSlotsForProfile(profile)) {
    const model = modelForSlot(profile, slot);
    if (model) console.log(`${(slot[0].toUpperCase() + slot.slice(1) + ':').padEnd(14)}${show(model)}${model1MForSlot(profile, slot) ? '  [1M]' : ''}`);
  }
}

function printTargets(activeMap) {
  const labels = { anthropic: 'Claude Code', responses: 'Codex', 'openai-chat': 'OpenAI Chat', vertex: 'Vertex' };
  for (const t of TARGETS) {
    console.log(`  ${labels[t].padEnd(12)} (${t.padEnd(11)}) -> ${activeMap[t] ? show(activeMap[t]) : 'OFF (official)'}`);
  }
}

// Applies the switch to a copy of `base`. Exits on an error; nothing is written here.
function planSwitch(base, key, cliTarget) {
  const planned = structuredClone(base);
  const err = cliTarget ? setTargetProfile(planned, cliTarget, key) : activateProfile(planned, key);
  if (err) {
    console.error(`[Error] ${show(err)}`);
    process.exit(1);
  }
  return planned;
}

function refuseBlindfoldProblem(planned, port) {
  const bf = computeLaunchState(planned, port).blindfold;
  const problem = bf && blindfoldPreflight(bf);
  if (!problem) return bf;
  console.error(`[Error] ${problem}`);
  console.error('        Or set "blindfold": false in the profile. Nothing was changed.');
  process.exit(1);
}

async function turnOn(profileName, cliTarget) {
  const port = getTargetPort();
  const wanted = profileName || config.activeProfile || Object.keys(config.profiles)[0];
  const key = findProfileKey(config, wanted);
  if (!key) {
    console.error(`[Error] Profile "${show(wanted)}" not found in config.json!`);
    console.error(`Available profiles: ${show(Object.keys(config.profiles).join(', ')) || '(none)'}`);
    process.exit(1);
  }

  // Plan on a copy. Nothing is written until every check below passes.
  let planned = planSwitch(config, key, cliTarget);
  console.log(`Activating profile: [${show(planned.profiles[key].name || key)}] (${show(key)})${cliTarget ? ` for ${cliTarget}` : ''} on port ${port}...`);

  const gatewayState = await probeGateway(port);
  if (isHeld(gatewayState)) refuseForeignPort(port, 'this switcher', gatewayState);
  const plannedBlindfold = refuseBlindfoldProblem(planned, port);
  if (plannedBlindfold) {
    const held = (await probeBlindfold(plannedBlindfold.port)).state;
    if (isHeld(held)) refuseForeignPort(plannedBlindfold.port, "this switcher's blindfold interceptor", held);
  }
  await ensureProxyRunning(port);

  // Plan again on the file as it is now: a dashboard save made while the gateway started must survive.
  const current = loadConfig();
  if (!current || getConfigLoadError()) {
    console.error(`[Error] config.json does not parse any more: ${getConfigLoadError()?.message}. Nothing was changed.`);
    process.exit(1);
  }
  planned = planSwitch(current, key, cliTarget);
  refuseBlindfoldProblem(planned, port);
  const profile = planned.profiles[key];

  const previousBytes = fs.readFileSync(configPath);
  saveConfig(planned);
  const savedBytes = fs.readFileSync(configPath);
  const st = applyLaunchState(planned, port);
  reportSettings(st.settings);
  const bf = await requestBlindfoldSync(port);
  if (!bf.ok) {
    console.error(`[Error] ${bf.error}`);
    // Put back exactly what was there, unless another writer saved in the meantime: then its
    // change wins and nothing is restored. clearLaunchState would also switch off unrelated targets
    // and run the settings.json cleaner, so the previous state is re-applied instead.
    if (!fs.readFileSync(configPath).equals(savedBytes)) {
      console.error('        config.json changed while the interceptor started, so it is not restored. Check it, then run the command again.');
      process.exit(1);
    }
    restoreConfigBytes(previousBytes);
    applyLaunchState(JSON.parse(previousBytes.toString('utf8')), port, { cleanSettings: false });
    const back = await requestBlindfoldSync(port);
    console.error('        The previous config.json and launcher files are restored.');
    if (!back.ok) console.error(`        The previous interceptor did not come back: ${back.error}`);
    process.exit(1);
  }

  // Self-install shims: with them, `claude --resume` sessions launched from a shell that never sourced env.sh
  // still route through the gateway. settings.json stays untouched so Claude Code shows no banner.
  // A shim bakes in the state dir; outside the checkout that is usually a temporary directory, and the shim
  // would outlive it.
  if (process.env.LLM_SWITCHER_STATE_DIR) {
    console.log('\n[Shim] Not installed automatically: LLM_SWITCHER_STATE_DIR is set. Run `switch shim install` to install shims for that directory.');
  } else try {
    const { installed, error } = installShims();
    if (error) console.warn(`[Shim] ${error}`);
    const sh = shimStatus();
    if (installed.length) console.log(`\n[Shim] Installed launcher shims: ${installed.join(', ')}`);
    if (!sh.onPath) {
      console.log(`[Shim] NOT on PATH yet — resumed sessions will still bypass the gateway.`);
      const rc = suggestedRcFiles()[0];
      console.log(rc ? `       Add this line to ${rc} and open a new terminal:` : '       Run this command once, then open a new terminal:');
      console.log(`           ${pathExportLine()}`);
    }
  } catch (err) {
    console.warn(`[Shim] ${err.message}`);
  }

  console.log(`\n[SUCCESS] Switched to profile "${show(profile.name || key)}".`);
  printProfile(profile);
  console.log('\nActive targets:');
  printTargets(getActiveMap(planned));
  console.log(`\nClaude 1M:    ${describeClaude1M(st)}`);
  console.log(`Codex 1M:     ${st.codex1M ? 'ACTIVE (1,000,000 tokens)' : 'OFF'}`);
  const codexKey = getActiveMap(planned).responses;
  const codexWarning = codexPublicModelsWarning(show(codexKey), planned.profiles[codexKey]);
  if (codexWarning) console.warn(`\n[WARN] ${codexWarning}`);
}

async function turnOff(targetArg) {
  const port = getTargetPort();
  if (targetArg) {
    const target = TARGET_ALIASES[targetArg.toLowerCase()];
    if (!target) {
      console.error(`[Error] Unknown target "${targetArg}". Use one of: claude, codex, openai, vertex`);
      process.exit(1);
    }
    setTargetProfile(config, target, null);
    saveConfig(config);
    const st = applyLaunchState(config, port);
    reportSettings(st.settings);
    const bf = await syncOrStopBlindfold(port, config);
    if (!bf.ok) {
      console.error(`[Error] ${target} is switched back, but the blindfold interceptor is not in line: ${bf.error}`);
      process.exit(1);
    }
    console.log(`[SUCCESS] ${target} switched back to official endpoint. Other targets unchanged:`);
    printTargets(getActiveMap(config));
    return;
  }

  console.log('Deactivating Proxy and restoring official endpoints...');
  deactivateAll(config);
  saveConfig(config);
  reportSettings(clearLaunchState(port));
  const bf = await syncOrStopBlindfold(port, config);
  if (!bf.ok) console.error(`[Error] The blindfold interceptor did not stop: ${bf.error}`);
  const result = await stopProxy(port);
  if (result === 'still-running') {
    console.error(`[Error] The gateway on port ${port} is still running. Stop it by hand; the launcher files are already cleared.`);
    process.exit(1);
  }
  if (result === 'legacy') {
    console.error(`[Error] An llm-switcher gateway older than 1.1.1 runs on port ${port}. Stop it, then run \`switch on\` again.`);
    process.exit(1);
  }
  if (result === 'not-ours' || result === 'silent') {
    console.error(result === 'silent'
      ? `[Error] Port ${port} accepts connections but does not answer, so it is not proven to be this switcher. It was not stopped.`
      : `[Error] Port ${port} is held by a process that did not prove it is this switcher. It was not stopped.`);
    process.exit(1);
  }
  console.log(result === 'stopped' ? 'Stopped local proxy service.' : 'Proxy service was not running.');
  if (!bf.ok) process.exit(1);
  console.log('\n[SUCCESS] Switched back to Claude Official Subscription. Run `switch on` to re-enable.');
}

// The flag carries the main session model only; haiku 1M reaches Claude Code through its tier variable.
function describeClaude1M(st) {
  if (!st.claude1MTiers?.length) return 'OFF';
  return `ACTIVE (${st.claude1MTiers.map(t => `${t}[1m]`).join(', ')})${st.claude1M ? `, main session ${st.claude1M}` : ''}`;
}

// Only a CLI whose target is active is expected to go through the gateway.
function auditActiveClis() {
  const map = getActiveMap(config);
  return auditRunningProcesses([map.anthropic && 'claude', map.responses && 'codex'].filter(Boolean));
}

// settings.json edits are never silent: name every value the switcher removed.
function reportSettings(result) {
  if (result?.removed?.length) console.log(`[settings.json] Removed switcher-written values: ${result.removed.join(', ')}`);
  if (result?.error) console.warn(`[settings.json] Not cleaned: ${result.error}`);
}

async function showStatus() {
  const port = getTargetPort();
  const gateway = await probeGateway(port);
  const isRunning = gateway === 'ours';
  const activeMap = getActiveMap(config);
  const flagged = fs.existsSync(paths.activeFlag);

  console.log('=== LLM Switcher Status ===');
  const held = { legacy: `OLD GATEWAY (< 1.1.1) ON PORT ${port}: stop it, then run \`switch on\``, foreign: `PORT ${port} HELD BY ANOTHER PROCESS`, silent: `PORT ${port} DOES NOT ANSWER (hung gateway or another program)` };
  console.log(`Proxy Service:  ${isRunning ? `RUNNING (port ${port})` : held[gateway] || 'STOPPED'}`);
  console.log(`Web UI:         http://127.0.0.1:${port}/ui`);
  console.log(`Launcher Flag:  ${flagged ? 'active.flag present' : 'absent (launchers use official endpoints)'}`);
  if (flagged && !isRunning) {
    console.log(`[WARN] active.flag exists but proxy is STOPPED -> launched CLIs will fail to connect. Run 'switch on' or 'switch off'.`);
  }
  console.log(`Claude 1M:      ${flagged ? describeClaude1M(computeLaunchState(config, port)) : 'OFF'}`);
  console.log(`Codex 1M Flag:  ${fs.existsSync(paths.flagCodex1M) ? 'ACTIVE' : 'OFF'}`);
  console.log('\nActive targets:');
  printTargets(activeMap);
  console.log('\nAvailable profiles:');
  for (const [key, p] of Object.entries(config.profiles)) {
    const mark = Object.values(activeMap).includes(key) ? '* ' : '  ';
    console.log(`${mark}${show(key).padEnd(20)} : [${show(p.inFormat || 'auto')}->${show(p.outFormat || p.mode || 'hybrid')}] ${show(p.name)} (${show(p.baseURL || 'no baseURL')})`);
  }
}

async function openUI() {
  const port = getTargetPort();
  await ensureProxyRunning(port);
  // The browser gets a private file path, never the token: a command line is readable by every account.
  const url = `http://127.0.0.1:${port}/ui`;
  console.log(`Opening Web UI: ${url}`);
  openBrowser(writeDashboardLauncher(url));
}

const SYSTEMD_UNIT = path.join(userProfile, '.config', 'systemd', 'user', 'llm-switcher.service');
const LAUNCHD_PLIST = path.join(userProfile, 'Library', 'LaunchAgents', 'com.llmswitcher.gateway.plist');

// systemctl --user needs the user bus. A shell without a login session (su, cron, ssh -T) has no
// XDG_RUNTIME_DIR, and then every call fails although the user manager runs.
function systemctlUser(args, opts = {}) {
  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR && process.getuid) env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  return execFileSync('systemctl', ['--user', ...args], { env, ...opts });
}

/** 'systemd' | 'launchd' | 'schtasks' | null */
function installedService() {
  if (process.platform === 'win32') {
    try {
      execFileSync('schtasks', ['/Query', '/TN', 'LLMSwitcher'], { stdio: 'ignore' });
      return 'schtasks';
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') return fs.existsSync(LAUNCHD_PLIST) ? 'launchd' : null;
  return fs.existsSync(SYSTEMD_UNIT) ? 'systemd' : null;
}

function serviceStart(kind) {
  try {
    if (kind === 'systemd') systemctlUser(['start', 'llm-switcher'], { stdio: 'ignore' });
    else if (kind === 'launchd') execFileSync('launchctl', ['load', LAUNCHD_PLIST], { stdio: 'ignore' });
    else if (kind === 'schtasks') execFileSync('schtasks', ['/Run', '/TN', 'LLMSwitcher'], { stdio: 'ignore' });
  } catch {}
}

/** The port on the service's command line, or null when it cannot be read. */
function servicePort(kind) {
  try {
    if (kind === 'systemd') return portFromServiceText(fs.readFileSync(SYSTEMD_UNIT, 'utf8'));
    if (kind === 'launchd') return portFromServiceText(fs.readFileSync(LAUNCHD_PLIST, 'utf8'));
    if (kind === 'schtasks') return portFromServiceText(decodeConsoleText(execFileSync('schtasks', ['/Query', '/TN', 'LLMSwitcher', '/XML'])));
  } catch {}
  return null;
}

function reportBackup(backup) {
  if (backup) console.log(`[Service] The previous definition differed and is kept as ${backup}.`);
}

// KeepAlive / Restart=always restart a killed gateway, so a service stops through its manager.
function serviceStop(kind) {
  try {
    if (kind === 'systemd') systemctlUser(['stop', 'llm-switcher'], { stdio: 'ignore' });
    else if (kind === 'launchd') execFileSync('launchctl', ['unload', LAUNCHD_PLIST], { stdio: 'ignore' });
    else if (kind === 'schtasks') execFileSync('schtasks', ['/End', '/TN', 'LLMSwitcher'], { stdio: 'ignore' });
  } catch {}
}

// Writes the service for `port` and (re)starts it, so a running unit picks up the new command line.
function installService(port) {
  const nodeBin = process.execPath;
  const env = serviceEnv();
  if (process.platform === 'win32') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-switcher-task-'));
    try {
      const userId = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : os.userInfo().username;
      const xmlPath = path.join(dir, 'task.xml');
      // Task Scheduler reads the XML as UTF-16, the encoding it declares.
      fs.writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(scheduledTaskXml({ nodeBin, script: proxyScript, port, userId }), 'utf16le')]));
      execFileSync('schtasks', ['/Create', '/TN', 'LLMSwitcher', '/XML', xmlPath, '/F'], { stdio: 'inherit' });
      try { execFileSync('schtasks', ['/End', '/TN', 'LLMSwitcher'], { stdio: 'ignore' }); } catch {}
      execFileSync('schtasks', ['/Run', '/TN', 'LLMSwitcher'], { stdio: 'ignore' });
      if (env.length) console.log(`[WARN] The scheduled task does not receive ${env.map(([k]) => k).join(', ')}. Set them as User environment variables.`);
      console.log('[SUCCESS] Installed and started Windows Scheduled Task "LLMSwitcher" (auto-starts on logon).');
      return true;
    } catch (err) {
      console.error('[Error] Failed to register the scheduled task:', err.message);
      return false;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  if (process.platform === 'darwin') {
    try {
      reportBackup(writeServiceFile(LAUNCHD_PLIST, launchdPlist({ nodeBin, script: proxyScript, port, logPath: proxyLogPath, env })));
      try { execFileSync('launchctl', ['unload', LAUNCHD_PLIST], { stdio: 'ignore' }); } catch {}
      execFileSync('launchctl', ['load', LAUNCHD_PLIST], { stdio: 'inherit' });
      console.log('[SUCCESS] Installed and started macOS launchd service.');
      return true;
    } catch (e) {
      console.error('[Error] Failed to install the launchd service:', e.message);
      return false;
    }
  }
  try {
    reportBackup(writeServiceFile(SYSTEMD_UNIT, systemdUnit({ nodeBin, script: proxyScript, port, env })));
    systemctlUser(['daemon-reload'], { stdio: 'inherit' });
    systemctlUser(['enable', 'llm-switcher'], { stdio: 'inherit' });
    systemctlUser(['restart', 'llm-switcher'], { stdio: 'inherit' });
    console.log('[SUCCESS] Installed and started systemd user service.');
    return true;
  } catch (e) {
    console.error('[Error] Failed to install the systemd service:', e.message);
    return false;
  }
}

async function manageService(action) {
  const port = getTargetPort();

  if (action === 'install') {
    if (!installService(port)) process.exit(1);
    return;
  }

  if (action === 'uninstall') {
    const kind = installedService();
    // Running uninstall twice is a successful no-op.
    if (!kind) {
      console.log('[INFO] No LLM Switcher service is installed.');
      return;
    }
    serviceStop(kind);
    let removed = true;
    try {
      if (kind === 'schtasks') {
        execFileSync('schtasks', ['/Delete', '/TN', 'LLMSwitcher', '/F'], { stdio: 'inherit' });
      } else if (kind === 'launchd') {
        fs.unlinkSync(LAUNCHD_PLIST);
      } else {
        try { systemctlUser(['disable', '--now', 'llm-switcher'], { stdio: 'ignore' }); } catch {}
        fs.unlinkSync(SYSTEMD_UNIT);
        try { systemctlUser(['daemon-reload'], { stdio: 'ignore' }); } catch {}
      }
    } catch (err) {
      removed = false;
      console.error(`[Error] Could not remove the ${kind} service: ${err.message}`);
    }
    if (removed) console.log(`[SUCCESS] Removed the ${kind} service.`);
    const stopped = await stopProxy(port);
    if (stopped === 'still-running') console.error(`[Error] The gateway on port ${port} is still running.`);
    if (!removed || stopped === 'still-running') process.exit(1);
    return;
  }

  console.log('Usage: switch service [install|uninstall]');
}

async function manageShim(action = 'status') {
  const act = (action || 'status').toLowerCase();

  if (act === 'install' || act === 'on') {
    const { installed, skipped, error } = installShims();
    if (error) { console.error(`[Error] ${error}`); process.exit(1); }
    if (installed.length) console.log(`[OK] Installed shims: ${installed.join(', ')} → ${SHIM_DIR}`);
    for (const s of skipped) console.log(`[SKIP] ${s.name}: ${s.reason}`);

    const st = shimStatus();
    if (!st.onPath) {
      console.log(`\n[ACTION REQUIRED] Add the shim dir to PATH so it precedes the real binaries:`);
      console.log(`    ${pathExportLine()}`);
      const rcFiles = suggestedRcFiles();
      if (rcFiles.length) {
        console.log(`\nAppend that line to one of:`);
        for (const rc of rcFiles) console.log(`    ${rc}`);
      } else {
        console.log(`\nRun that command once; it changes only your User-scope Path.`);
      }
      console.log(`\nThen open a new terminal (or 'exec $SHELL') and verify:`);
      console.log(`    switch shim status`);
    } else {
      console.log(`\n[PASS] ${SHIM_DIR} is already on PATH (position ${st.position}).`);
      console.log(`Resumed sessions ('claude --resume') now route through the gateway automatically.`);
    }
    return;
  }

  if (act === 'uninstall' || act === 'off' || act === 'remove') {
    const { removed, failed } = uninstallShims();
    if (removed.length) console.log(`[OK] Removed shims: ${removed.join(', ')}`);
    for (const f of failed) console.error(`[Error] Could not remove the ${f.name} shim: ${f.reason}`);
    if (!removed.length && !failed.length) console.log('[INFO] No switcher shims found.');
    console.log(`You may also remove the PATH line for ${SHIM_DIR} from your shell rc.`);
    if (failed.length) process.exit(1);
    return;
  }

  // status
  const st = shimStatus();
  console.log('=== Shim status (auto-inject for resumed sessions) ===\n');
  console.log(`Shim dir: ${st.dir}`);
  console.log(`On PATH : ${st.onPath ? `YES (position ${st.position})` : 'NO'}`);
  if (!st.onPath) console.log(`          Add: ${pathExportLine()}`);
  console.log('');
  for (const s of st.shims) {
    if (!s.installed) { console.log(`[MISS] ${s.name}: shim not installed — run 'switch shim install'`); continue; }
    if (s.active) console.log(`[PASS] ${s.name}: shim active → ${s.effective}`);
    else console.log(`[WARN] ${s.name}: shim installed but '${s.name}' resolves to ${s.effective || '(not found)'} — PATH order wrong`);
  }
  if (st.onPath && st.shims.some(s => s.installed && !s.active)) for (const line of pathOrderHint()) console.log(`       ${line}`);

  const audit = auditActiveClis();
  if (!audit.supported) console.log('\n[INFO] The running-session check is not supported on Windows.');
  else if (audit.procs.length) {
    console.log('\n--- Running CLI processes ---');
    for (const p of audit.procs) {
      if (p.hasEnv === true) console.log(`[PASS] pid ${p.pid} (${p.name}): routed through the gateway`);
      else if (p.hasEnv === false) console.log(`[ALERT] pid ${p.pid} (${p.name}): NO gateway route — this session bypasses the gateway!\n        ${show(p.cmd)}\n        Fix: quit it and re-run from a shell where the shim is on PATH.`);
      else console.log(`[INFO] pid ${p.pid} (${p.name}): its environment cannot be read here`);
    }
  }
}

async function runDoctor() {
  const port = getTargetPort();
  console.log('=== LLM Switcher System Doctor ===\n');
  const isRunning = await checkProxyRunning(port);
  let allHealthy = true;
  const warn = (msg) => { console.log(msg); allHealthy = false; };

  // 1. Check proxy liveness
  if (isRunning) {
    console.log(`[PASS] Gateway service is RUNNING on http://127.0.0.1:${port}`);
  } else {
    warn(`[WARN] Gateway service is STOPPED on port ${port}. Run 'switch on' to activate.`);
  }

  // 2. Check which profiles the targets point to
  const activeMap = getActiveMap(config);
  for (const [t, key] of Object.entries(activeMap)) {
    if (!key) continue;
    const p = config.profiles[key];
    if (!p) warn(`[WARN] Target ${t} points to missing profile "${show(key)}".`);
    else if (!p.baseURL || /YOUR-|REPLACE-ME/i.test(`${p.baseURL} ${p.apiKey}`)) warn(`[WARN] Profile "${show(key)}" (${t}) still has placeholder baseURL/apiKey.`);
    if (p && t === 'responses') {
      const codexWarning = codexPublicModelsWarning(show(key), p);
      if (codexWarning) warn(`[WARN] ${codexWarning}`);
    }
  }

  // 3. Launcher flags match proxy state
  if (fs.existsSync(paths.activeFlag) && !isRunning) {
    warn(`[WARN] active.flag exists but proxy is stopped: launched CLIs will get ECONNREFUSED.`);
  }

  // 4. Check ~/.claude/settings.json
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
      if (s.env?.ANTHROPIC_BASE_URL) {
        warn(`[WARN] ${claudeSettingsPath} contains hardcoded ANTHROPIC_BASE_URL="${s.env.ANTHROPIC_BASE_URL}".`);
        console.log(`       This triggers warning banners in Claude Code. Run 'switch on' / 'switch off' to clean.`);
      } else {
        console.log(`[PASS] ${claudeSettingsPath} has no proxy overrides.`);
      }
    } catch {
      warn(`[WARN] ${claudeSettingsPath} exists but is not valid JSON.`);
    }
  } else {
    console.log(`[PASS] ${claudeSettingsPath} does not exist (clean official state).`);
  }

  // 5. Check environment variables
  const anthBase = process.env.ANTHROPIC_BASE_URL;
  if (anthBase) {
    if (!/\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(anthBase)) {
      warn(`[ALERT] Current ANTHROPIC_BASE_URL="${anthBase}" points to an external host!`);
      console.log(`        It should point to LLM Switcher (http://127.0.0.1:${port}) or your local optimizer tool.`);
    } else {
      console.log(`[PASS] ANTHROPIC_BASE_URL points to local address: ${anthBase}`);
    }
  } else {
    console.log(`[INFO] ANTHROPIC_BASE_URL is not set in current shell (launcher wrapper will inject on demand).`);
  }

  console.log(`[INFO] Claude 1M: ${describeClaude1M(computeLaunchState(config, port))}. Codex 1M flag: ${fs.existsSync(paths.flagCodex1M) ? 'YES' : 'NO'}`);
  console.log(`[INFO] Universal environment loader: env.cmd=${fs.existsSync(paths.envCmd) ? 'READY' : 'PENDING'}`);
  if (fs.existsSync(proxyLogPath)) console.log(`[INFO] Background proxy log: ${proxyLogPath}`);

  // 6. Shims — safety net for resumed sessions / shells that never sourced env.sh
  console.log('\n--- Launcher shims (resumed sessions) ---');
  const sh = shimStatus();
  if (!sh.onPath) {
    warn(`[WARN] ${SHIM_DIR} is not on PATH — 'claude --resume' from a clean shell will BYPASS the gateway.`);
    console.log(`       Fix: switch shim install   then add:  ${pathExportLine()}`);
  } else {
    console.log(`[PASS] Shim dir on PATH (position ${sh.position}).`);
  }
  for (const s of sh.shims) {
    if (!s.installed) warn(`[WARN] No shim for '${s.name}' — run 'switch shim install'.`);
    else if (!s.active) warn(`[WARN] '${s.name}' resolves to ${s.effective || '(not found)'} instead of the shim — PATH order wrong.`);
    else console.log(`[PASS] '${s.name}' routed through shim.`);
  }
  if (sh.onPath && sh.shims.some(s => s.installed && !s.active)) for (const line of pathOrderHint()) console.log(`       ${line}`);

  // 7. Running processes missing env => those sessions call the provider directly
  const audit = auditActiveClis();
  if (!audit.supported) console.log('[INFO] The running-session check is not supported on Windows.');
  else {
    for (const p of audit.procs) {
      if (p.hasEnv === false) {
        warn(`[ALERT] pid ${p.pid} (${p.name}) has NO gateway route — that session bypasses the gateway.`);
        console.log(`        ${show(p.cmd)}`);
        console.log(`        Fix: quit it, then re-run from a shell where the shim is on PATH.`);
      }
    }
  }

  console.log('\n--- Intermediary Token Optimizers (Headroom / RTK / Ponytail) ---');
  console.log(`If using a token compressor, ensure its upstream target is configured to http://127.0.0.1:${port}.`);
  console.log('LLM Switcher will act as the final edge gatekeeper to heal schemas, unlock 1M, and preserve thinking.');

  console.log(`\nDoctor summary: ${allHealthy ? 'ALL CHECKS PASSED (HEALTHY)' : 'ATTENTION RECOMMENDED (CHECK WARNINGS ABOVE)'}`);
}

// ----------------------------------------------------
// Contract probe
// ----------------------------------------------------
function optionValue(name) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';
}

// One line per request, so a run can be read while it is still going. A model name comes from
// config.json, so it is printed through `show` like any other configured string.
async function runContractProbe() {
  const port = getTargetPort();
  const token = readAdminToken();
  if (!token) {
    console.error(`[Error] No admin token yet (${adminTokenPath}). Start the gateway first: switch on`);
    process.exit(1);
  }
  const model = optionValue('--model');
  console.log(`Probing gateway 127.0.0.1:${port} — model, format, variant, trace id, status`);
  const { rows, unreachable } = await runProbe({
    port, token, config, model,
    log: (line) => console.log(show(line))
  });
  if (!rows.length) console.log(model ? `No active profile maps to "${show(model)}".` : 'No active profile maps a model.');
  const ok = rows.filter(r => r.status === 200).length;
  console.log(`${rows.length} requests, ${ok} answered 200.`);
  if (unreachable) {
    console.error(`[Error] The gateway on port ${port} did not answer. Start it with: switch on`);
    process.exit(1);
  }
}

// The findings and the fixtures are untrusted text, so `runCheck` prints its own sanitized rows
// and this wrapper only decides the exit code: 2 means intact could not be read.
async function runContractCheck() {
  const out = await runCheck({ settings: () => contractLabSettings(config) });
  if (!out.ok) {
    console.error(`[Error] ${out.error}`);
    process.exit(2);
  }
}

const [rawCmd = '', subArg = ''] = positionalArgs();
const cmd = rawCmd.toLowerCase();

if (cmd === 'off' || cmd === 'stop') {
  await turnOff(subArg);
} else if (cmd === 'port') {
  await changePort(subArg);
} else if (cmd === 'doctor' || cmd === 'audit') {
  await runDoctor();
} else if (cmd === 'service' || cmd === 'daemon') {
  await manageService(subArg.toLowerCase() || 'status');
} else if (cmd === 'shim' || cmd === 'shims') {
  await manageShim(subArg.toLowerCase() || 'status');
} else if (Object.hasOwn(TARGET_ALIASES, cmd)) {
  await turnOn(subArg, TARGET_ALIASES[cmd]);
} else if (cmd === 'ui' || cmd === 'web' || cmd === 'gui') {
  await openUI();
} else if (cmd === 'contract-probe') {
  await runContractProbe();
} else if (cmd === 'contract-check') {
  await runContractCheck();
} else if (cmd === 'status' || cmd === 'st') {
  await showStatus();
} else if (cmd === 'on' || cmd === 'start') {
  await turnOn(subArg);
} else if (cmd && findProfileKey(config, rawCmd)) {
  await turnOn(rawCmd);
} else {
  console.log('Usage:');
  console.log('  switch ui                      # Open Web UI dashboard');
  console.log('  switch status                  # Show multi-CLI active status');
  console.log('  switch doctor                  # Audit environment, settings & routing');
  console.log('  switch on [profile]            # Start gateway & activate profile for all compatible targets');
  console.log('  switch <profile>               # Activate profile for all compatible targets');
  console.log('  switch claude <profile>        # Set active profile for Claude Code');
  console.log('  switch codex <profile>         # Set active profile for Codex');
  console.log('  switch openai <profile>        # Set active profile for OpenAI Chat');
  console.log('  switch vertex <profile>        # Set active profile for Vertex');
  console.log('  switch port <number>           # Change gateway port');
  console.log('  switch service install         # Install OS background autostart service');
  console.log('  switch service uninstall       # Uninstall background autostart service');
  console.log('  switch shim install            # Auto-inject env into resumed sessions (claude --resume)');
  console.log('  switch shim status             # Check shims + detect sessions bypassing the gateway');
  console.log('  switch shim uninstall          # Remove launcher shims');
  console.log('  switch off [target]            # Restore official endpoints (all, or one target)');
  console.log('  switch contract-probe [--model m] # Drive the contract-lab variants through the gateway');
  console.log('  switch contract-check          # Turn the open contract findings into failing tests');
  console.log('\nGlobal option: --port <n> (or env LLM_SWITCHER_PORT)');
}
