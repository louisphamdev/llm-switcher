// The text of each OS service definition that `switch service install` writes, and how the CLI
// reads the port back. Pure functions, apart from writeServiceFile, so each one is testable here.
import fs from 'node:fs';
import path from 'node:path';

// A service does not inherit the installing shell. Without these it would read another config.json
// or clean another settings.json than the shell that installed it.
const SERVICE_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'LLM_SWITCHER_CONFIG', 'LLM_SWITCHER_STATE_DIR', 'LLM_SWITCHER_BLINDFOLD_CERTS'];

export function serviceEnv(env = process.env) {
  return SERVICE_ENV_KEYS.filter(k => env[k]).map(k => [k, env[k]]);
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const systemdQuote = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

export function systemdUnit({ nodeBin, script, port, env = [] }) {
  return `[Unit]
Description=LLM Switcher Local Gateway
After=network.target

[Service]
ExecStart=${systemdQuote(nodeBin)} ${systemdQuote(script)} --port ${port}
${env.map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}\n`).join('')}Restart=always

[Install]
WantedBy=default.target
`;
}

export function launchdPlist({ nodeBin, script, port, logPath, env = [] }) {
  const envBlock = env.length
    ? `  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`).join('\n')}
  </dict>
`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.llmswitcher.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(script)}</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
${envBlock}  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

// Task Scheduler reads the command and its arguments from two elements, so no path goes through
// the quoting rules of a /TR command line. A task made with /TR also stops after 72 hours by
// default; PT0S removes that limit.
export function scheduledTaskXml({ nodeBin, script, port, userId }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>LLM Switcher Local Gateway</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(nodeBin)}</Command>
      <Arguments>${xmlEscape(`"${script}" --port ${port}`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// schtasks prints /Query /XML as UTF-16 when its output is a pipe.
export function decodeConsoleText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[1] === 0x00) return buf.toString('utf16le');
  return buf.toString('utf8');
}

/** The port on a service definition's command line, or null. */
export function portFromServiceText(text) {
  const flat = String(text).replace(/<\/?string>\s*/g, ' ');
  const n = parseInt(/--port\s+(\d+)/.exec(flat)?.[1], 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/** Writes a service definition. Returns the backup path when it replaced different content. */
export function writeServiceFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  try {
    if (fs.readFileSync(file, 'utf8') !== content) {
      backup = `${file}.bak`;
      fs.copyFileSync(file, backup);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.writeFileSync(file, content, 'utf8');
  return backup;
}
