import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const userProfile = os.homedir();
const claudeSettingsPath = path.join(userProfile, '.claude', 'settings.json');
const claudeBackupPath = path.join(userProfile, '.claude', 'settings.json.bak-pre-9router-proxy');
const pidFilePath = path.join(__dirname, 'proxy.pid');
const activeFlagPath = path.join(__dirname, 'active.flag');
const flag1MPath = path.join(__dirname, '1m.flag'); // Claude Code launcher flag
const flagCodex1MPath = path.join(__dirname, 'codex-1m.flag'); // Codex launcher flag
const flagOpenAI1MPath = path.join(__dirname, 'openai-1m.flag'); // OpenAI launcher flag
const envCmdPath = path.join(__dirname, 'env.cmd');
const envShPath = path.join(__dirname, 'env.sh');

function getTargetPort() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      const p = parseInt(args[i + 1], 10);
      if (!isNaN(p) && p > 0 && p <= 65535) return p;
    }
  }
  const envP = parseInt(process.env.PORT || process.env.LLM_SWITCHER_PORT, 10);
  if (!isNaN(envP) && envP > 0 && envP <= 65535) return envP;
  return config.port || 3456;
}

async function checkProxyRunning(port) {
  const p = port || getTargetPort();
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${p}/health`, { timeout: 1000 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startProxyBackground(port) {
  const proxyScript = path.join(__dirname, 'proxy.mjs');
  const targetPort = port || getTargetPort();
  const child = spawn(process.execPath, [proxyScript, '--port', String(targetPort)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  fs.writeFileSync(pidFilePath, String(child.pid), 'utf8');
  return child.pid;
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      execSync(`start ${url}`, { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    }
  } catch {}
}

function stopProxy(port) {
  const targetPort = port || getTargetPort();
  if (fs.existsSync(pidFilePath)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFilePath, 'utf8').trim(), 10);
      if (!isNaN(pid)) {
        try { process.kill(pid); } catch {}
      }
    } catch {}
    try { fs.unlinkSync(pidFilePath); } catch {}
  }

  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${targetPort} | findstr LISTENING`, { encoding: 'utf8' });
      const lines = out.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && !isNaN(parseInt(pid, 10)) && pid !== '0') {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        }
      }
    } else {
      execSync(`lsof -ti :${targetPort} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
    }
  } catch {}
}

async function changePort(newPortStr) {
  const p = parseInt(newPortStr, 10);
  if (isNaN(p) || p <= 0 || p > 65535) {
    console.error(`[Error] Invalid port: "${newPortStr}". Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
  const oldPort = config.port || 3456;
  const isRunning = await checkProxyRunning(oldPort);
  if (isRunning) {
    console.log(`Stopping gateway on current port ${oldPort}...`);
    stopProxy(oldPort);
  }
  config.port = p;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log(`[SUCCESS] Port updated to ${p} in config.json.`);
  if (isRunning) {
    console.log(`Restarting gateway on new port ${p}...`);
    await turnOn(config.activeProfile);
  }
}

async function turnOn(targetProfileName, cliTarget) {
  const availableProfiles = Object.keys(config.profiles);
  const profileKey = (targetProfileName || config.activeProfile || '9router').toLowerCase();
  const targetPort = getTargetPort();

  if (!config.profiles[profileKey]) {
    console.error(`[Error] Profile "${profileKey}" not found in config.json!`);
    console.error(`Available profiles: ${availableProfiles.join(', ')}`);
    process.exit(1);
  }

  const selectedProfile = config.profiles[profileKey];
  config.activeProfile = profileKey;
  if (!config.activeProfiles) {
    config.activeProfiles = {
      anthropic: profileKey,
      responses: profileKey,
      'openai-chat': profileKey,
      vertex: profileKey
    };
  }
  if (cliTarget) {
    config.activeProfiles[cliTarget] = profileKey;
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  console.log(`Activating profile: [${selectedProfile.name}] (${profileKey}) on port ${targetPort}...`);

  const isRunning = await checkProxyRunning(targetPort);
  if (!isRunning) {
    console.log(`Starting proxy service on port ${targetPort}...`);
    startProxyBackground(targetPort);
    let retries = 10;
    while (retries-- > 0) {
      await new Promise(r => setTimeout(r, 300));
      if (await checkProxyRunning(targetPort)) break;
    }
  } else {
    console.log(`Proxy is running on port ${targetPort} (config reloaded dynamically).`);
  }

  fs.writeFileSync(activeFlagPath, profileKey, 'utf8');

  const inFmt = selectedProfile.inFormat || 'auto';
  const has1M = Boolean(selectedProfile.model1M?.opus || selectedProfile.model1M?.sonnet || selectedProfile.model1M?.fable || selectedProfile.model1M?.haiku);
  const primaryModel = selectedProfile.defaultModels?.opus || selectedProfile.defaultModels?.sonnet || selectedProfile.defaultModels?.haiku || '';

  // 1. Claude Code 1M: CHỈ bật khi profile chọn input là 'anthropic' hoặc 'auto'
  const isClaudeTarget = (inFmt === 'anthropic' || inFmt === 'auto');
  const claudeTier1M = selectedProfile.model1M?.opus ? 'opus[1m]' :
                       selectedProfile.model1M?.sonnet ? 'sonnet[1m]' :
                       selectedProfile.model1M?.fable ? 'fable[1m]' : null;
  if (isClaudeTarget && claudeTier1M) {
    fs.writeFileSync(flag1MPath, claudeTier1M, 'utf8');
  } else if (fs.existsSync(flag1MPath)) {
    try { fs.unlinkSync(flag1MPath); } catch {}
  }

  // 2. Codex CLI 1M: bật khi input là 'responses' hoặc 'auto'
  const isCodexTarget = (inFmt === 'responses' || inFmt === 'auto');
  if (isCodexTarget && has1M) {
    fs.writeFileSync(flagCodex1MPath, primaryModel || '1000000', 'utf8');
  } else if (fs.existsSync(flagCodex1MPath)) {
    try { fs.unlinkSync(flagCodex1MPath); } catch {}
  }

  // 3. OpenAI CLI 1M: bật khi input là 'openai-chat' hoặc 'auto'
  const isOpenAITarget = (inFmt === 'openai-chat' || inFmt === 'auto');
  if (isOpenAITarget && has1M) {
    fs.writeFileSync(flagOpenAI1MPath, primaryModel || '1000000', 'utf8');
  } else if (fs.existsSync(flagOpenAI1MPath)) {
    try { fs.unlinkSync(flagOpenAI1MPath); } catch {}
  }

  // 4. Sinh file env.cmd và env.sh
  const envCmdLines = ['@echo off', `REM Auto-generated environment for profile: ${selectedProfile.name}`];
  const envShLines = ['#!/usr/bin/env sh', `# Auto-generated environment for profile: ${selectedProfile.name}`];

  if (isClaudeTarget) {
    envCmdLines.push(`SET "ANTHROPIC_BASE_URL=http://127.0.0.1:${config.port}"`);
    envCmdLines.push('SET "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1"');
    envShLines.push(`export ANTHROPIC_BASE_URL="http://127.0.0.1:${config.port}"`);
    envShLines.push('export CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1');
    if (claudeTier1M) {
      envCmdLines.push(`SET "ANTHROPIC_MODEL=${claudeTier1M}"`);
      envCmdLines.push('SET "CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000"');
      envCmdLines.push('SET "CLAUDE_CODE_AUTO_COMPACT_WINDOW=900000"');
      envShLines.push(`export ANTHROPIC_MODEL="${claudeTier1M}"`);
      envShLines.push('export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000');
      envShLines.push('export CLAUDE_CODE_AUTO_COMPACT_WINDOW=900000');
    }
  }

  if (isCodexTarget) {
    envCmdLines.push(`SET "CODEX_BASE_URL=http://127.0.0.1:${config.port}/v1"`);
    envCmdLines.push(`SET "OPENAI_BASE_URL=http://127.0.0.1:${config.port}/v1"`);
    envShLines.push(`export CODEX_BASE_URL="http://127.0.0.1:${config.port}/v1"`);
    envShLines.push(`export OPENAI_BASE_URL="http://127.0.0.1:${config.port}/v1"`);
    if (has1M) {
      envCmdLines.push('SET "CODEX_MAX_CONTEXT_TOKENS=1000000"');
      envCmdLines.push('SET "CODEX_AUTO_COMPACT_WINDOW=900000"');
      envShLines.push('export CODEX_MAX_CONTEXT_TOKENS=1000000');
      envShLines.push('export CODEX_AUTO_COMPACT_WINDOW=900000');
      if (primaryModel) {
        envCmdLines.push(`SET "CODEX_MODEL=${primaryModel}"`);
        envShLines.push(`export CODEX_MODEL="${primaryModel}"`);
      }
    }
  }

  if (isOpenAITarget && !isCodexTarget) {
    envCmdLines.push(`SET "OPENAI_BASE_URL=http://127.0.0.1:${config.port}/v1"`);
    envShLines.push(`export OPENAI_BASE_URL="http://127.0.0.1:${config.port}/v1"`);
    if (has1M) {
      envCmdLines.push('SET "OPENAI_MAX_CONTEXT_TOKENS=1000000"');
      envShLines.push('export OPENAI_MAX_CONTEXT_TOKENS=1000000');
    }
  }

  try {
    fs.writeFileSync(envCmdPath, envCmdLines.join('\r\n'), 'utf8');
    fs.writeFileSync(envShPath, envShLines.join('\n'), 'utf8');
  } catch {}

  // Keep ~/.claude/settings.json 100% clean (no ANTHROPIC_AUTH_TOKEN or custom models)
  if (fs.existsSync(claudeSettingsPath)) {
    let settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    if (settings.env) {
      delete settings.env.ANTHROPIC_BASE_URL;
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
      delete settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME;
      delete settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME;
      delete settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME;
      delete settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME;
    }
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }

  console.log(`\n[SUCCESS] Switched to profile "${selectedProfile.name}".`);
  console.log(`Input Target: ${inFmt.toUpperCase()}`);
  console.log(`Routing Mode: ${selectedProfile.mode.toUpperCase()}`);
  console.log(`Upstream:     ${selectedProfile.baseURL}`);
  console.log(`Opus:         ${selectedProfile.defaultModels.opus}`);
  console.log(`Sonnet:       ${selectedProfile.defaultModels.sonnet}`);
  console.log(`Haiku:        ${selectedProfile.defaultModels.haiku}`);
  if (selectedProfile.defaultModels?.fable) {
    console.log(`Fable:        ${selectedProfile.defaultModels.fable}`);
  }
  if (isClaudeTarget) {
    console.log(`Claude 1M:    ${claudeTier1M ? `ACTIVE (${claudeTier1M})` : 'OFF'}`);
  } else {
    console.log(`Claude 1M:    DISABLED (Profile targets ${inFmt.toUpperCase()})`);
  }
  if (isCodexTarget) {
    console.log(`Codex 1M:     ${has1M ? 'ACTIVE (1,000,000 tokens)' : 'OFF'}`);
  }
  console.log('Settings.json is 100% clean (no warning banners).');
}

async function turnOff() {
  console.log('Deactivating Proxy and restoring Claude Official...');
  stopProxy();
  const flags = [activeFlagPath, flag1MPath, flagCodex1MPath, flagOpenAI1MPath, envCmdPath, envShPath];
  for (const f of flags) {
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
  console.log('Stopped local proxy service.');

  if (fs.existsSync(claudeSettingsPath)) {
    let settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    if (settings.env) {
      delete settings.env.ANTHROPIC_BASE_URL;
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
      delete settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME;
      delete settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME;
      delete settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME;
      delete settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
      delete settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME;
    }
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }

  console.log('\n[SUCCESS] Switched back to Claude Official Subscription.');
}

async function showStatus() {
  const isRunning = await checkProxyRunning(config.port);
  const isProxyActive = fs.existsSync(activeFlagPath) && isRunning;
  const is1MActive = fs.existsSync(flag1MPath) && isProxyActive;
  const isCodex1M = fs.existsSync(flagCodex1MPath) && isProxyActive;
  const activeProfile = config.profiles[config.activeProfile] || { name: config.activeProfile };
  const inFmt = activeProfile.inFormat || 'auto';

  console.log('=== LLM Switcher Status ===');
  console.log(`Proxy Service:  ${isRunning ? `RUNNING (port ${config.port})` : 'STOPPED'}`);
  console.log(`Web UI:         http://127.0.0.1:${config.port}/ui`);
  console.log(`Active Profile: [${activeProfile.name}] (${config.activeProfile})`);
  console.log(`Input Target:   ${inFmt.toUpperCase()}`);
  console.log(`Routing Mode:   ${activeProfile.mode ? activeProfile.mode.toUpperCase() : 'N/A'}`);
  console.log(`Formats:        in=${inFmt} -> out=${activeProfile.outFormat || ('auto-by-' + (activeProfile.mode || 'hybrid'))}`);
  console.log(`Active State:   ${isProxyActive ? `PROXY ACTIVE -> ${activeProfile.name}` : 'OFFICIAL SUBSCRIPTION'}`);
  if (inFmt === 'anthropic' || inFmt === 'auto') {
    console.log(`Claude 1M Flag: ${is1MActive ? 'ACTIVE (CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000)' : 'OFF (Standard 200k)'}`);
  } else {
    console.log(`Claude 1M Flag: OFF (profile input is ${inFmt.toUpperCase()}, not Claude Code)`);
  }
  if (inFmt === 'responses' || inFmt === 'auto') {
    console.log(`Codex 1M Flag:  ${isCodex1M ? 'ACTIVE (CODEX_MAX_CONTEXT_TOKENS=1000000)' : 'OFF'}`);
  }
  console.log(`Settings File:  100% Clean (no warning banners)`);
  console.log('\nAvailable profiles:');
  for (const [key, p] of Object.entries(config.profiles)) {
    const mark = key === config.activeProfile ? '* ' : '  ';
    console.log(`${mark}- ${key.padEnd(16)} : [${p.inFormat || 'auto'}->${p.outFormat || p.mode}] ${p.name} (${p.baseURL})`);
  }
}

async function openUI() {
  const isRunning = await checkProxyRunning(config.port);
  if (!isRunning) {
    console.log(`Starting proxy service on port ${config.port}...`);
    startProxyBackground();
    let retries = 10;
    while (retries-- > 0) {
      await new Promise(r => setTimeout(r, 300));
      if (await checkProxyRunning(config.port)) break;
    }
  }
  const url = `http://127.0.0.1:${config.port}/ui`;
  console.log(`Opening Web UI: ${url}`);
  openBrowser(url);
}

function manageService(action) {
  const proxyScript = path.join(__dirname, 'proxy.mjs');
  const nodeBin = process.execPath;
  const targetPort = getTargetPort();

  if (action === 'install') {
    if (process.platform === 'win32') {
      try {
        execSync(`schtasks /Create /TN "LLMSwitcher" /TR "\"${nodeBin}\" \"${proxyScript}\"" /SC ONLOGON /RL HIGHEST /F`, { stdio: 'inherit' });
        console.log('[SUCCESS] Installed Windows Scheduled Task "LLMSwitcher" (auto-starts on logon).');
        execSync(`schtasks /Run /TN "LLMSwitcher"`, { stdio: 'ignore' });
        console.log('[SUCCESS] Started background service.');
      } catch (err) {
        console.error('Failed to register task:', err.message);
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
    <string>${nodeBin}</string>
    <string>${proxyScript}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>`;
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, plistContent, 'utf8');
      try {
        execSync(`launchctl load "${plistPath}"`, { stdio: 'inherit' });
        console.log('[SUCCESS] Installed and started macOS launchd service.');
      } catch (e) {
        console.error('Failed to load launchd service:', e.message);
      }
    } else {
      const servicePath = path.join(userProfile, '.config', 'systemd', 'user', 'llm-switcher.service');
      const serviceContent = `[Unit]
Description=LLM Switcher Local Gateway
After=network.target

[Service]
ExecStart=${nodeBin} ${proxyScript} --port ${targetPort}
Restart=always

[Install]
WantedBy=default.target`;
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
        execSync('schtasks /Delete /TN "LLMSwitcher" /F', { stdio: 'inherit' });
        console.log('[SUCCESS] Removed Windows Scheduled Task "LLMSwitcher".');
      } catch (err) {
        console.error('Failed to delete task (may not exist):', err.message);
      }
    } else if (process.platform === 'darwin') {
      const plistPath = path.join(userProfile, 'Library', 'LaunchAgents', 'com.llmswitcher.gateway.plist');
      if (fs.existsSync(plistPath)) {
        try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' }); } catch {}
        try { fs.unlinkSync(plistPath); } catch {}
      }
      console.log('[SUCCESS] Removed macOS launchd service.');
    } else {
      try {
        execSync('systemctl --user disable --now llm-switcher', { stdio: 'ignore' });
        const servicePath = path.join(userProfile, '.config', 'systemd', 'user', 'llm-switcher.service');
        if (fs.existsSync(servicePath)) fs.unlinkSync(servicePath);
      } catch {}
      console.log('[SUCCESS] Removed systemd user service.');
    }
    stopProxy();
    return;
  }

  console.log('Usage: switch service [install|uninstall]');
}

async function runDoctor() {
  console.log('=== LLM Switcher System Doctor ===\n');
  const isRunning = await checkProxyRunning(config.port);
  let allHealthy = true;

  // 1. Kiểm tra proxy liveness
  if (isRunning) {
    console.log(`[PASS] Gateway service is RUNNING on http://127.0.0.1:${config.port}`);
  } else {
    console.log(`[WARN] Gateway service is STOPPED. Run 'switch on' or 'switch start' to activate.`);
    allHealthy = false;
  }

  // 2. Kiểm tra ~/.claude/settings.json
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
      if (s.env?.ANTHROPIC_BASE_URL) {
        console.log(`[WARN] ~/.claude/settings.json contains hardcoded ANTHROPIC_BASE_URL="${s.env.ANTHROPIC_BASE_URL}".`);
        console.log(`       This triggers warning banners in Claude Code. Run 'switch off' to clean.`);
        allHealthy = false;
      } else {
        console.log(`[PASS] ~/.claude/settings.json is clean (zero-mutation compliant).`);
      }
    } catch {
      console.log(`[WARN] ~/.claude/settings.json exists but is not valid JSON.`);
    }
  } else {
    console.log(`[PASS] ~/.claude/settings.json does not exist (clean official state).`);
  }

  // 3. Kiểm tra biến môi trường
  const anthBase = process.env.ANTHROPIC_BASE_URL;
  if (anthBase) {
    if (!anthBase.includes('127.0.0.1') && !anthBase.includes('localhost')) {
      console.log(`[ALERT] Current ANTHROPIC_BASE_URL="${anthBase}" points to an external host!`);
      console.log(`        It should point to LLM Switcher (http://127.0.0.1:${config.port}) or your local optimizer tool.`);
      allHealthy = false;
    } else {
      console.log(`[PASS] ANTHROPIC_BASE_URL points to local address: ${anthBase}`);
    }
  } else {
    console.log(`[INFO] ANTHROPIC_BASE_URL is not set in current shell (launcher wrapper will inject on demand).`);
  }

  // 4. Kiểm tra cờ 1M
  const is1M = fs.existsSync(flag1MPath);
  const isCodex1M = fs.existsSync(flagCodex1MPath);
  console.log(`[INFO] Active flags: Claude 1M=${is1M ? 'YES' : 'NO'}, Codex 1M=${isCodex1M ? 'YES' : 'NO'}`);

  // 5. Kiểm tra file nạp môi trường
  const hasEnvCmd = fs.existsSync(envCmdPath);
  console.log(`[INFO] Universal environment loader: env.cmd=${hasEnvCmd ? 'READY' : 'PENDING'}`);

  console.log('\n--- Intermediary Token Optimizers (Headroom / RTK / Ponytail) ---');
  console.log(`If using a token compressor, ensure its upstream target is configured to http://127.0.0.1:${config.port}.`);
  console.log('LLM Switcher will act as the final edge gatekeeper to heal schemas, unlock 1M, and preserve thinking.');

  console.log(`\nDoctor summary: ${allHealthy ? 'ALL CHECKS PASSED (HEALTHY)' : 'ATTENTION RECOMMENDED (CHECK WARNINGS ABOVE)'}`);
}

const rawArg = (process.argv[2] || '').toLowerCase();
const subArg = (process.argv[3] || '').toLowerCase();

if (rawArg === 'off' || rawArg === 'stop') {
  await turnOff();
} else if (rawArg === 'port' || rawArg === '-p') {
  await changePort(subArg);
} else if (rawArg === 'doctor' || rawArg === 'audit') {
  await runDoctor();
} else if (rawArg === 'service' || rawArg === 'daemon') {
  manageService(subArg || 'status');
} else if (rawArg === 'claude' || rawArg === 'anthropic') {
  await turnOn(subArg, 'anthropic');
} else if (rawArg === 'codex' || rawArg === 'responses') {
  await turnOn(subArg, 'responses');
} else if (rawArg === 'openai' || rawArg === 'chat') {
  await turnOn(subArg, 'openai-chat');
} else if (rawArg === 'vertex') {
  await turnOn(subArg, 'vertex');
} else if (rawArg === 'ui' || rawArg === 'web' || rawArg === 'gui') {
  await openUI();
} else if (rawArg === 'status' || rawArg === 'st') {
  await showStatus();
} else if (rawArg === 'on' || rawArg === 'start') {
  await turnOn(subArg || config.activeProfile || '9router');
} else if (config.profiles[rawArg]) {
  await turnOn(rawArg);
} else {
  console.log('Usage:');
  console.log('  switch ui                      # Open Web UI dashboard');
  console.log('  switch status                  # Show multi-CLI active status');
  console.log('  switch doctor                  # Audit environment, settings & routing');
  console.log('  switch <profile>               # Switch active profile');
  console.log('  switch claude <profile>        # Set active profile for Claude Code');
  console.log('  switch codex <profile>         # Set active profile for Codex');
  console.log('  switch openai <profile>        # Set active profile for OpenAI Chat');
  console.log('  switch vertex <profile>        # Set active profile for Vertex');
  console.log('  switch service install         # Install OS background autostart service');
  console.log('  switch service uninstall       # Uninstall background autostart service');
  console.log('  switch off                     # Restore Official Subscription');
}
