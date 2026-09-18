import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync, execSync } from 'node:child_process';
import http from 'node:http';
import {
  ROOT_DIR, TARGETS, configPath, claudeSettingsPath, paths, loadConfig, getConfigLoadError, saveConfig,
  resolvePort, parsePort, findProfileKey, getActiveMap, setTargetProfile, activateProfile, deactivateAll,
  applyLaunchState, clearLaunchState
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

// Bỏ các cờ --port/-p khỏi positional args.
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

// Chỉ coi là "đang chạy" khi /health trả đúng chữ ký của LLM Switcher (không nhầm với tool khác chiếm port).
function checkProxyRunning(port) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 && JSON.parse(data).proxy === 'llm-switcher'); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startProxyBackground(port) {
  const log = fs.openSync(proxyLogPath, 'a');
  const child = spawn(process.execPath, [proxyScript, '--port', String(port)], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true
  });
  child.unref();
  fs.closeSync(log);
  fs.writeFileSync(paths.pidFile, String(child.pid), 'utf8');
  return child.pid;
}

async function ensureProxyRunning(port) {
  if (await checkProxyRunning(port)) {
    console.log(`Proxy is running on port ${port} (config reloaded dynamically).`);
    return;
  }
  console.log(`Starting proxy service on port ${port}...`);
  startProxyBackground(port);
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (await checkProxyRunning(port)) return;
  }
  console.error(`[Error] Proxy did not come up on port ${port}. See ${proxyLogPath} for details.`);
  process.exit(1);
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

// Tìm PID đang LISTEN đúng port (so khớp chính xác cột local address, không khớp nhầm :34560).
function listeningPids(port) {
  const pids = new Set();
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        // Proto  Local  Foreign  State  PID  — foreign "0.0.0.0:0" = đang listen (không phụ thuộc ngôn ngữ OS)
        if (parts.length >= 5 && /^TCP$/i.test(parts[0]) && parts[1].endsWith(`:${port}`) && /:0$/.test(parts[2])) {
          const pid = parseInt(parts[parts.length - 1], 10);
          if (pid > 0) pids.add(pid);
        }
      }
    } else {
      const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
      for (const s of out.split(/\s+/)) {
        const pid = parseInt(s, 10);
        if (pid > 0) pids.add(pid);
      }
    }
  } catch {}
  return [...pids];
}

async function stopProxy(port) {
  const running = await checkProxyRunning(port);
  if (fs.existsSync(paths.pidFile)) {
    // Chỉ kill theo pid file khi xác nhận switcher đang chạy, tránh kill nhầm process đã tái sử dụng PID.
    if (running) {
      const pid = parseInt(fs.readFileSync(paths.pidFile, 'utf8').trim(), 10);
      if (pid > 0) {
        try { process.kill(pid); } catch {}
      }
    }
    try { fs.unlinkSync(paths.pidFile); } catch {}
  }
  if (!running) return false;

  for (let i = 0; i < 8; i++) {
    await sleep(150);
    if (!(await checkProxyRunning(port))) return true;
  }
  // Vẫn chạy (VD được start bởi service) -> kill process đang listen port, đã xác nhận đó là LLM Switcher.
  for (const pid of listeningPids(port)) {
    if (pid === process.pid) continue;
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
      else process.kill(pid, 'SIGTERM');
    } catch {}
  }
  return true;
}

async function changePort(newPortStr) {
  const p = parsePort(newPortStr);
  if (!p) {
    console.error(`[Error] Invalid port: "${newPortStr}". Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
  const oldPort = parsePort(config.port) || 3456;
  const isRunning = await checkProxyRunning(oldPort);
  if (isRunning) {
    console.log(`Stopping gateway on current port ${oldPort}...`);
    await stopProxy(oldPort);
  }
  config.port = p;
  saveConfig(config);
  console.log(`[SUCCESS] Port updated to ${p} in config.json.`);
  if (process.env.PORT || process.env.LLM_SWITCHER_PORT) {
    console.log(`[WARN] PORT / LLM_SWITCHER_PORT env var is set and overrides config.json.`);
  }
  if (isRunning) {
    console.log(`Restarting gateway on new port ${p}...`);
    await ensureProxyRunning(p);
  }
  applyLaunchState(config, p);
}

function printProfile(profile) {
  const d = profile.defaultModels || {};
  console.log(`Input Target: ${(profile.inFormat || 'auto').toUpperCase()}`);
  console.log(`Routing:      ${profile.outFormat ? `out=${profile.outFormat}` : `mode=${profile.mode || 'hybrid'}`}`);
  console.log(`Upstream:     ${profile.baseURL || '(not set)'}`);
  for (const tier of ['opus', 'sonnet', 'haiku', 'fable']) {
    if (d[tier]) console.log(`${(tier[0].toUpperCase() + tier.slice(1) + ':').padEnd(14)}${d[tier]}${profile.model1M?.[tier] ? '  [1M]' : ''}`);
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

  const err = cliTarget ? setTargetProfile(config, cliTarget, key) : activateProfile(config, key);
  if (err) {
    console.error(`[Error] ${err}`);
    process.exit(1);
  }
  saveConfig(config);

  const profile = config.profiles[key];
  console.log(`Activating profile: [${profile.name || key}] (${key})${cliTarget ? ` for ${cliTarget}` : ''} on port ${port}...`);
  await ensureProxyRunning(port);
  const st = applyLaunchState(config, port);

  // Tự cài shim: nhờ nó, phiên `claude --resume` mở từ shell chưa source env.sh
  // vẫn đi qua gateway. Không đụng settings.json nên Claude Code không hiện banner.
  try {
    const { installed } = installShims();
    const sh = shimStatus();
    if (installed.length) console.log(`\n[Shim] Installed launcher shims: ${installed.join(', ')}`);
    if (!sh.onPath) {
      console.log(`[Shim] NOT on PATH yet — resumed sessions will still bypass the gateway.`);
      console.log(`       Add this line to ${suggestedRcFiles()[0]} and open a new terminal:`);
      console.log(`           ${pathExportLine()}`);
    }
  } catch {}

  console.log(`\n[SUCCESS] Switched to profile "${profile.name || key}".`);
  printProfile(profile);
  console.log('\nActive targets:');
  printTargets(getActiveMap(config));
  console.log(`\nClaude 1M:    ${st.claude1M ? `ACTIVE (${st.claude1M})` : 'OFF'}`);
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
    applyLaunchState(config, port);
    console.log(`[SUCCESS] ${target} switched back to official endpoint. Other targets unchanged:`);
    printTargets(getActiveMap(config));
    return;
  }

  console.log('Deactivating Proxy and restoring official endpoints...');
  deactivateAll(config);
  saveConfig(config);
  clearLaunchState();
  const stopped = await stopProxy(port);
  console.log(stopped ? 'Stopped local proxy service.' : 'Proxy service was not running.');
  console.log('\n[SUCCESS] Switched back to Claude Official Subscription. Run `switch on` to re-enable.');
}

async function showStatus() {
  const port = getTargetPort();
  const isRunning = await checkProxyRunning(port);
  const activeMap = getActiveMap(config);
  const flagged = fs.existsSync(paths.activeFlag);

  console.log('=== LLM Switcher Status ===');
  console.log(`Proxy Service:  ${isRunning ? `RUNNING (port ${port})` : 'STOPPED'}`);
  console.log(`Web UI:         http://127.0.0.1:${port}/ui`);
  console.log(`Launcher Flag:  ${flagged ? 'active.flag present' : 'absent (launchers use official endpoints)'}`);
  if (flagged && !isRunning) {
    console.log(`[WARN] active.flag exists but proxy is STOPPED -> launched CLIs will fail to connect. Run 'switch on' or 'switch off'.`);
  }
  console.log(`Claude 1M Flag: ${fs.existsSync(paths.flag1M) ? `ACTIVE (${fs.readFileSync(paths.flag1M, 'utf8').trim()})` : 'OFF'}`);
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
  const url = `http://127.0.0.1:${port}/ui`;
  console.log(`Opening Web UI: ${url}`);
  openBrowser(url);
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function manageService(action) {
  const nodeBin = process.execPath;
  const port = getTargetPort();

  if (action === 'install') {
    if (process.platform === 'win32') {
      try {
        // execFileSync tự quote đúng cho schtasks; không cần /RL HIGHEST (gateway không cần quyền admin).
        execFileSync('schtasks', ['/Create', '/TN', 'LLMSwitcher', '/TR', `"${nodeBin}" "${proxyScript}" --port ${port}`, '/SC', 'ONLOGON', '/F'], { stdio: 'inherit' });
        console.log('[SUCCESS] Installed Windows Scheduled Task "LLMSwitcher" (auto-starts on logon).');
        execFileSync('schtasks', ['/Run', '/TN', 'LLMSwitcher'], { stdio: 'ignore' });
        console.log('[SUCCESS] Started background service.');
      } catch (err) {
        console.error('Failed to register task (ONLOGON tasks may require an elevated terminal):', err.message);
      }
    } else if (process.platform === 'darwin') {
      const plistPath = path.join(userProfile, 'Library', 'LaunchAgents', 'com.llmswitcher.gateway.plist');
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
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, plistContent, 'utf8');
      try {
        execFileSync('launchctl', ['load', plistPath], { stdio: 'inherit' });
        console.log('[SUCCESS] Installed and started macOS launchd service.');
      } catch (e) {
        console.error('Failed to load launchd service:', e.message);
      }
    } else {
      const servicePath = path.join(userProfile, '.config', 'systemd', 'user', 'llm-switcher.service');
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
      fs.mkdirSync(path.dirname(servicePath), { recursive: true });
      fs.writeFileSync(servicePath, serviceContent, 'utf8');
      try {
        execSync('systemctl --user daemon-reload && systemctl --user enable --now llm-switcher', { stdio: 'inherit' });
        console.log('[SUCCESS] Installed and started systemd user service.');
      } catch (e) {
        console.error('Failed to start systemd service:', e.message);
      }
    }
    return;
  }

  if (action === 'uninstall') {
    if (process.platform === 'win32') {
      try {
        execFileSync('schtasks', ['/End', '/TN', 'LLMSwitcher'], { stdio: 'ignore' });
      } catch {}
      try {
        execFileSync('schtasks', ['/Delete', '/TN', 'LLMSwitcher', '/F'], { stdio: 'inherit' });
        console.log('[SUCCESS] Removed Windows Scheduled Task "LLMSwitcher".');
      } catch (err) {
        console.error('Failed to delete task (may not exist):', err.message);
      }
    } else if (process.platform === 'darwin') {
      const plistPath = path.join(userProfile, 'Library', 'LaunchAgents', 'com.llmswitcher.gateway.plist');
      if (fs.existsSync(plistPath)) {
        try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch {}
        try { fs.unlinkSync(plistPath); } catch {}
      }
      console.log('[SUCCESS] Removed macOS launchd service.');
    } else {
      try {
        execSync('systemctl --user disable --now llm-switcher', { stdio: 'ignore' });
      } catch {}
      const servicePath = path.join(userProfile, '.config', 'systemd', 'user', 'llm-switcher.service');
      try { if (fs.existsSync(servicePath)) fs.unlinkSync(servicePath); } catch {}
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
      console.log(`\nAppend that line to one of:`);
      for (const rc of suggestedRcFiles()) console.log(`    ${rc}`);
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

  // 1. Kiểm tra proxy liveness
  if (isRunning) {
    console.log(`[PASS] Gateway service is RUNNING on http://127.0.0.1:${port}`);
  } else {
    warn(`[WARN] Gateway service is STOPPED on port ${port}. Run 'switch on' to activate.`);
  }

  // 2. Kiểm tra profile đang trỏ tới
  const activeMap = getActiveMap(config);
  for (const [t, key] of Object.entries(activeMap)) {
    if (!key) continue;
    const p = config.profiles[key];
    if (!p) warn(`[WARN] Target ${t} points to missing profile "${key}".`);
    else if (!p.baseURL || /YOUR-|REPLACE-ME/i.test(`${p.baseURL} ${p.apiKey}`)) warn(`[WARN] Profile "${key}" (${t}) still has placeholder baseURL/apiKey.`);
  }

  // 3. Flag launcher khớp với trạng thái proxy
  if (fs.existsSync(paths.activeFlag) && !isRunning) {
    warn(`[WARN] active.flag exists but proxy is stopped: launched CLIs will get ECONNREFUSED.`);
  }

  // 4. Kiểm tra ~/.claude/settings.json
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

  // 5. Kiểm tra biến môi trường
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

  console.log(`[INFO] Active flags: Claude 1M=${fs.existsSync(paths.flag1M) ? 'YES' : 'NO'}, Codex 1M=${fs.existsSync(paths.flagCodex1M) ? 'YES' : 'NO'}`);
  console.log(`[INFO] Universal environment loader: env.cmd=${fs.existsSync(paths.envCmd) ? 'READY' : 'PENDING'}`);
  if (fs.existsSync(proxyLogPath)) console.log(`[INFO] Background proxy log: ${proxyLogPath}`);

  // 6. Shim — lớp bảo đảm cho phiên resume / shell chưa source env.sh
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

  // 7. Process đang chạy mà thiếu env => phiên đó đang gọi thẳng nhà cung cấp
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
