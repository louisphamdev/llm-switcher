// Pure helpers of agy-relay.mjs, kept apart so tests can import them without starting a relay.

// The switcher writes 127.0.0.1 only. localhost can resolve to ::1, which no proof covers.
export function gatewayPort(raw) {
  let u;
  try { u = new URL(raw); } catch { return 0; }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') return 0;
  const port = Number(u.port);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0;
}

// One complete HTTP/1.1 answer at the start of `buf`: { status, text, rest }, or null while it is
// still incomplete. An answer with no length cannot share its socket, so it counts as a failure.
export function readAnswer(buf) {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
  const status = Number(lines[0].split(' ')[1]);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const rest = buf.subarray(end + 4);
  if (/close/i.test(headers.connection || '')) return { status: 0, text: '', rest };
  if (headers['content-length'] !== undefined) {
    const n = Number(headers['content-length']);
    if (!Number.isInteger(n) || n < 0) return { status: 0, text: '', rest };
    if (rest.length < n) return null;
    return { status, text: rest.subarray(0, n).toString('utf8'), rest: rest.subarray(n) };
  }
  if (/chunked/i.test(headers['transfer-encoding'] || '')) {
    const parts = [];
    let off = 0;
    for (;;) {
      const lineEnd = rest.indexOf('\r\n', off);
      if (lineEnd < 0) return null;
      const size = parseInt(rest.subarray(off, lineEnd).toString('latin1'), 16);
      if (!Number.isInteger(size) || size < 0) return { status: 0, text: '', rest };
      if (size === 0) {
        if (rest.length < lineEnd + 4) return null;
        return { status, text: Buffer.concat(parts).toString('utf8'), rest: rest.subarray(lineEnd + 4) };
      }
      if (rest.length < lineEnd + 2 + size + 2) return null;
      parts.push(rest.subarray(lineEnd + 2, lineEnd + 2 + size));
      off = lineEnd + 2 + size + 2;
    }
  }
  return { status: 0, text: '', rest };
}

// The longest string cmd.exe takes after /c.
export const CMD_LIMIT = 8191;
const SAFE = /^[A-Za-z0-9#$*+\-./:?@\\_]$/;

// One argument for a batch file, as the Rust standard library builds it since CVE-2024-24576
// (make_bat_command_line): `"` becomes `""`, and `%` becomes `%%cd:~,%`, which expands to `%`, so
// cmd.exe never expands a %name% or %name:x=y% that came from the argument.
function batArg(arg) {
  const quote = arg === '' || arg.endsWith('\\') || [...arg].some(c => !SAFE.test(c));
  let out = quote ? '"' : '';
  let backslashes = 0;
  for (const c of arg) {
    if (c === '\\') {
      backslashes++;
    } else {
      if (c === '"') out += `${'\\'.repeat(backslashes)}"`;
      else if (c === '%') out += '%%cd:~,';
      backslashes = 0;
    }
    out += c;
  }
  if (quote) out += `${'\\'.repeat(backslashes)}"`;
  return out;
}

// The cmd.exe arguments that run a .cmd/.bat with `args` unchanged: { args } or { error }.
export function batCommandLine(script, args) {
  if (script.includes('"') || script.endsWith('\\')) return { error: `the path of agy (${script}) cannot hold " or end with \\` };
  for (const a of args) {
    if (/[\r\n]/.test(a)) return { error: 'an argument holds a line break, which a .cmd or .bat agy cannot receive. Pipe the prompt on stdin instead.' };
  }
  const inner = `"${[`"${script.replace(/%/g, '%%cd:~,%')}"`, ...args.map(batArg)].join(' ')}"`;
  if (inner.length > CMD_LIMIT) return { error: `the command line is longer than ${CMD_LIMIT} characters, the limit of cmd.exe. Pipe the prompt on stdin instead.` };
  return { args: ['/e:ON', '/v:OFF', '/d', '/c', inner] };
}
