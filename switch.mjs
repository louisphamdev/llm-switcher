import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync, execSync } from 'node:child_process';
import {
  ROOT_DIR, TARGETS, configPath, claudeSettingsPath, paths, loadConfig, getConfigLoadError, saveConfig,
  resolvePort, parsePort, findProfileKey, getActiveMap, setTargetProfile, activateProfile, deactivateAll,
  applyLaunchState, clearLaunchState, computeLaunchState,
  modelSlotsForProfile, modelForSlot, model1MForSlot, readAdminToken, openLog,
  probeGateway, probeBlindfold, blindfoldPreflight, stopRecordedBlindfold, writeDashboardLauncher
} from './state.mjs';
import {
  SHIM_DIR, installShims, uninstallShims, shimStatus, pathExportLine,
  suggestedRcFiles, auditRunningProcesses
} from './shim.mjs';

const proxyScript = path.join(ROOT_DIR, 'proxy.mjs');
const proxyLogPath = path.join(ROOT_DIR, 'proxy.log');
const userProfile = os.homedir();

const config = loadConfig();
if (!config) {
  const err = getConfigLoadError();
  console.error(`[Error] Cannot load ${configPath}: ${err ? err.message : 'file not found'}`);
  if (!fs.existsSync(configPath)) {
    console.error(`Create it first:  cp config.example.json config.json   (then edit baseURL / apiKey)`);
  }
  process.exit(1);
}

const TARGET_ALIASES = {
  claude: 'anthropic', anthropic: 'anthropic',
  codex: 'responses', responses: 'responses',
  openai: 'openai-chat', chat: 'openai-chat', 'openai-chat': 'openai-chat',
  vertex: 'vertex', gemini: 'vertex'
};

// Strip --port/-p flags from positional args.
function positionalArgs() {
  const out = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || (argv[i] === '-p' && i > 0)) { i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

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
const isHeld = (state) => state === 'foreign' || state === 'silent';

function refuseForeignPort(port, owner, state = 'foreign') {
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
  const svc = installedService();
  if (svc && servicePort(svc) === port) {
    console.log(`Starting the ${svc} service on port ${port}...`);
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
async function syncOrStopBlindfold(port) {
  if (await checkProxyRunning(port)) {
    const r = await requestBlindfoldSync(port);
    if (!r.ok) console.warn(`[Blindfold] ${r.error}`);
    return r;
  }
  await stopRecordedBlindfold();
  return { ok: true };
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

// Returns 'stopped', 'not-running', 'not-ours', 'silent' or 'still-running'. The kill targets the process that
// listens on the port, right after the identity probe confirmed that listener is this switcher.
async function stopProxy(port) {
  const state = await probeGateway(port);
  if (state === 'free') return 'not-running';
  if (state === 'foreign') return 'not-ours';
  if (state === 'silent') return 'silent';
  // Gone means the port is free; a slow answer is not proof that the gateway stopped.
  const waitGone = async () => {
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      if ((await probeGateway(port)) === 'free') return true;
    }
    return false;
  };
  // A supervisor restarts what we kill, so a service is stopped through its manager first.
  const svc = installedService();
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
  if (svc) {
    // The unit fixes the port on its command line, so it is rewritten and restarted, not fought.
    console.log(`Reinstalling the ${svc} service on port ${p}...`);
    if (!installService(p)) process.exit(1);
    let up = false;
    for (let i = 0; i < 20 && !up; i++) { await sleep(250); up = await checkProxyRunning(p); }
    if (!up) {
      console.error(`[Error] The ${svc} service did not come up on port ${p}. See ${proxyLogPath}.`);
      process.exit(1);
    }
  } else if (wasRunning) {
    console.log(`Restarting gateway on new port ${p}...`);
    await ensureProxyRunning(p);
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
  console.log(`Input Target: ${(profile.inFormat || 'auto').toUpperCase()}`);
  console.log(`Routing:      ${profile.outFormat ? `out=${profile.outFormat}` : `mode=${profile.mode || 'hybrid'}`}`);
  console.log(`Upstream:     ${profile.baseURL || '(not set)'}`);
  for (const slot of modelSlotsForProfile(profile)) {
    const model = modelForSlot(profile, slot);
    if (model) console.log(`${(slot[0].toUpperCase() + slot.slice(1) + ':').padEnd(14)}${model}${model1MForSlot(profile, slot) ? '  [1M]' : ''}`);
  }
}

function printTargets(activeMap) {
  const labels = { anthropic: 'Claude Code', responses: 'Codex', 'openai-chat': 'OpenAI Chat', vertex: 'Vertex' };
  for (const t of TARGETS) {
    console.log(`  ${labels[t].padEnd(12)} (${t.padEnd(11)}) -> ${activeMap[t] || 'OFF (official)'}`);
  }
}

async function turnOn(profileName, cliTarget) {
  const port = getTargetPort();
  const wanted = profileName || config.activeProfile || Object.keys(config.profiles)[0];
  const key = findProfileKey(config, wanted);
  if (!key) {
    console.error(`[Error] Profile "${wanted}" not found in config.json!`);
    console.error(`Available profiles: ${Object.keys(config.profiles).join(', ') || '(none)'}`);
    process.exit(1);
  }

  // Plan on a copy. Nothing is written until every check below passes.
  const planned = structuredClone(config);
  const err = cliTarget ? setTargetProfile(planned, cliTarget, key) : activateProfile(planned, key);
  if (err) {
    console.error(`[Error] ${err}`);
    process.exit(1);
  }
  const profile = planned.profiles[key];
  console.log(`Activating profile: [${profile.name || key}] (${key})${cliTarget ? ` for ${cliTarget}` : ''} on port ${port}...`);

  const gatewayState = await probeGateway(port);
  if (isHeld(gatewayState)) refuseForeignPort(port, 'this switcher', gatewayState);
  const plannedState = computeLaunchState(planned, port);
  if (plannedState.blindfold) {
    const problem = blindfoldPreflight(plannedState.blindfold);
    if (problem) {
      console.error(`[Error] ${problem}`);
      console.error('        Or set "blindfold": false in the profile. Nothing was changed.');
      process.exit(1);
    }
    const held = (await probeBlindfold(plannedState.blindfold.port)).state;
    if (isHeld(held)) refuseForeignPort(plannedState.blindfold.port, "this switcher's blindfold interceptor", held);
  }
  await ensureProxyRunning(port);

  const previousBytes = fs.readFileSync(configPath);
  saveConfig(planned);
  const st = applyLaunchState(planned, port);
  reportSettings(st.settings);
  const bf = await requestBlindfoldSync(port);
  if (!bf.ok) {
    // Put back exactly what was there. clearLaunchState would also switch off unrelated targets
    // and run the settings.json cleaner, so the previous state is re-applied instead.
    restoreConfigBytes(previousBytes);
    applyLaunchState(JSON.parse(previousBytes.toString('utf8')), port, { cleanSettings: false });
    const back = await requestBlindfoldSync(port);
    console.error(`[Error] ${bf.error}`);
    console.error('        The previous config.json and launcher files are restored.');
    if (!back.ok) console.error(`        The previous interceptor did not come back: ${back.error}`);
    process.exit(1);
  }

  // Self-install shims: with them, `claude --resume` sessions launched from a shell that never sourced env.sh
  // still route through the gateway. settings.json stays untouched so Claude Code shows no banner.
  try {
    const { installed } = installShims();
    const sh = shimStatus();
    if (installed.length) console.log(`\n[Shim] Installed launcher shims: ${installed.join(', ')}`);
    if (!sh.onPath) {
      console.log(`[Shim] NOT on PATH yet — resumed sessions will still bypass the gateway.`);
      const rc = suggestedRcFiles()[0];
      console.log(rc ? `       Add this line to ${rc} and open a new terminal:` : '       Run this command once, then open a new terminal:');
      console.log(`           ${pathExportLine()}`);
    }
  } catch {}

  console.log(`\n[SUCCESS] Switched to profile "${profile.name || key}".`);
  printProfile(profile);
  console.log('\nActive targets:');
  printTargets(getActiveMap(planned));
  console.log(`\nClaude 1M:    ${describeClaude1M(st)}`);
  console.log(`Codex 1M:     ${st.codex1M ? 'ACTIVE (1,000,000 tokens)' : 'OFF'}`);
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
    await syncOrStopBlindfold(port);
    console.log(`[SUCCESS] ${target} switched back to official endpoint. Other targets unchanged:`);
    printTargets(getActiveMap(config));
    return;
  }

  console.log('Deactivating Proxy and restoring official endpoints...');
  deactivateAll(config);
  saveConfig(config);
  reportSettings(clearLaunchState(port));
  await syncOrStopBlindfold(port);
  const result = await stopProxy(port);
  if (result === 'still-running') {
    console.error(`[Error] The gateway on port ${port} is still running. Stop it by hand; the launcher files are already cleared.`);
    process.exit(1);
  }
  if (result === 'not-ours' || result === 'silent') {
    console.error(result === 'silent'
      ? `[Error] Port ${port} accepts connections but does not answer, so it is not proven to be this switcher. It was not stopped.`
      : `[Error] Port ${port} is held by a process that did not prove it is this switcher. It was not stopped.`);
    process.exit(1);
  }
  console.log(result === 'stopped' ? 'Stopped local proxy service.' : 'Proxy service was not running.');
  console.log('\n[SUCCESS] Switched back to Claude Official Subscription. Run `switch on` to re-enable.');
}

// The flag carries the main session model only; haiku 1M reaches Claude Code through its tier variable.
function describeClaude1M(st) {
  if (!st.claude1MTiers?.length) return 'OFF';
  return `ACTIVE (${st.claude1MTiers.map(t => `${t}[1m]`).join(', ')})${st.claude1M ? `, main session ${st.claude1M}` : ''}`;
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
  const held = { foreign: `PORT ${port} HELD BY ANOTHER PROCESS`, silent: `PORT ${port} DOES NOT ANSWER (hung gateway or another program)` };
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
    console.log(`${mark}${key.padEnd(20)} : [${p.inFormat || 'auto'}->${p.outFormat || p.mode || 'hybrid'}] ${p.name || ''} (${p.baseURL || 'no baseURL'})`);
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

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    let text = '';
    if (kind === 'systemd') text = fs.readFileSync(SYSTEMD_UNIT, 'utf8');
    else if (kind === 'launchd') text = fs.readFileSync(LAUNCHD_PLIST, 'utf8').replace(/<\/?string>\s*/g, ' ');
    else if (kind === 'schtasks') text = execFileSync('schtasks', ['/Query', '/TN', 'LLMSwitcher', '/XML'], { encoding: 'utf8' });
    return parsePort(/--port\s+(\d+)/.exec(text)?.[1]);
  } catch {
    return null;
  }
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
  if (process.platform === 'win32') {
    try {
      // execFileSync quotes correctly for schtasks; no /RL HIGHEST needed (gateway needs no admin rights).
      execFileSync('schtasks', ['/Create', '/TN', 'LLMSwitcher', '/TR', `"${nodeBin}" "${proxyScript}" --port ${port}`, '/SC', 'ONLOGON', '/F'], { stdio: 'inherit' });
      try { execFileSync('schtasks', ['/End', '/TN', 'LLMSwitcher'], { stdio: 'ignore' }); } catch {}
      execFileSync('schtasks', ['/Run', '/TN', 'LLMSwitcher'], { stdio: 'ignore' });
      console.log('[SUCCESS] Installed and started Windows Scheduled Task "LLMSwitcher" (auto-starts on logon).');
      return true;
    } catch (err) {
      console.error('[Error] Failed to register task (ONLOGON tasks may require an elevated terminal):', err.message);
      return false;
    }
  }
  if (process.platform === 'darwin') {
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.llmswitcher.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(proxyScript)}</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>StandardOutPath</key>
  <string>${xmlEscape(proxyLogPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(proxyLogPath)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>`;
    fs.mkdirSync(path.dirname(LAUNCHD_PLIST), { recursive: true });
    fs.writeFileSync(LAUNCHD_PLIST, plistContent, 'utf8');
    try {
      try { execFileSync('launchctl', ['unload', LAUNCHD_PLIST], { stdio: 'ignore' }); } catch {}
      execFileSync('launchctl', ['load', LAUNCHD_PLIST], { stdio: 'inherit' });
      console.log('[SUCCESS] Installed and started macOS launchd service.');
      return true;
    } catch (e) {
      console.error('[Error] Failed to load launchd service:', e.message);
      return false;
    }
  }
  const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
  const serviceContent = `[Unit]
Description=LLM Switcher Local Gateway
After=network.target

[Service]
ExecStart=${q(nodeBin)} ${q(proxyScript)} --port ${port}
Restart=always

[Install]
WantedBy=default.target
`;
  fs.mkdirSync(path.dirname(SYSTEMD_UNIT), { recursive: true });
  fs.writeFileSync(SYSTEMD_UNIT, serviceContent, 'utf8');
  try {
    systemctlUser(['daemon-reload'], { stdio: 'inherit' });
    systemctlUser(['enable', 'llm-switcher'], { stdio: 'inherit' });
    systemctlUser(['restart', 'llm-switcher'], { stdio: 'inherit' });
    console.log('[SUCCESS] Installed and started systemd user service.');
    return true;
  } catch (e) {
    console.error('[Error] Failed to start systemd service:', e.message);
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
    serviceStop(kind);
    if (process.platform === 'win32') {
      try {
        execFileSync('schtasks', ['/Delete', '/TN', 'LLMSwitcher', '/F'], { stdio: 'inherit' });
        console.log('[SUCCESS] Removed Windows Scheduled Task "LLMSwitcher".');
      } catch (err) {
        console.error('Failed to delete task (may not exist):', err.message);
      }
    } else if (process.platform === 'darwin') {
      try { fs.unlinkSync(LAUNCHD_PLIST); } catch {}
      console.log('[SUCCESS] Removed macOS launchd service.');
    } else {
      try { systemctlUser(['disable', '--now', 'llm-switcher'], { stdio: 'ignore' }); } catch {}
      try { if (fs.existsSync(SYSTEMD_UNIT)) fs.unlinkSync(SYSTEMD_UNIT); } catch {}
      try { systemctlUser(['daemon-reload'], { stdio: 'ignore' }); } catch {}
      console.log('[SUCCESS] Removed systemd user service.');
    }
    return stopProxy(port);
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
    const { removed } = uninstallShims();
    console.log(removed.length ? `[OK] Removed shims: ${removed.join(', ')}` : '[INFO] No switcher shims found.');
    console.log(`You may also remove the PATH line for ${SHIM_DIR} from your shell rc.`);
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

  const audit = auditRunningProcesses();
  if (audit.supported && audit.procs.length) {
    console.log('\n--- Running CLI processes ---');
    for (const p of audit.procs) {
      if (p.hasEnv === true) console.log(`[PASS] pid ${p.pid}: has ANTHROPIC_BASE_URL`);
      else if (p.hasEnv === false) console.log(`[ALERT] pid ${p.pid}: NO gateway env — this session bypasses the gateway!\n        ${p.cmd}\n        Fix: quit it and re-run from a shell where the shim is on PATH.`);
      else console.log(`[INFO] pid ${p.pid}: cannot read env (permission)`);
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
    if (!p) warn(`[WARN] Target ${t} points to missing profile "${key}".`);
    else if (!p.baseURL || /YOUR-|REPLACE-ME/i.test(`${p.baseURL} ${p.apiKey}`)) warn(`[WARN] Profile "${key}" (${t}) still has placeholder baseURL/apiKey.`);
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

  // 7. Running processes missing env => those sessions call the provider directly
  const audit = auditRunningProcesses();
  if (audit.supported && audit.procs.length) {
    for (const p of audit.procs) {
      if (p.hasEnv === false) {
        warn(`[ALERT] pid ${p.pid} has NO gateway env — that session bypasses the gateway.`);
        console.log(`        ${p.cmd}`);
        console.log(`        Fix: quit it, then re-run from a shell where the shim is on PATH.`);
      }
    }
  }

  console.log('\n--- Intermediary Token Optimizers (Headroom / RTK / Ponytail) ---');
  console.log(`If using a token compressor, ensure its upstream target is configured to http://127.0.0.1:${port}.`);
  console.log('LLM Switcher will act as the final edge gatekeeper to heal schemas, unlock 1M, and preserve thinking.');

  console.log(`\nDoctor summary: ${allHealthy ? 'ALL CHECKS PASSED (HEALTHY)' : 'ATTENTION RECOMMENDED (CHECK WARNINGS ABOVE)'}`);
}

const [rawCmd = '', subArg = ''] = positionalArgs();
const cmd = rawCmd.toLowerCase();

if (cmd === 'off' || cmd === 'stop') {
  await turnOff(subArg);
} else if (cmd === 'port' || cmd === '-p') {
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
  console.log('\nGlobal option: --port <n> (or env LLM_SWITCHER_PORT)');
}
