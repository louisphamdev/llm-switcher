// SSE dispatches one event at a blank line; data fields are joined with newlines.
// Vertex also sends bare JSON lines. Keep both framings without parsing data fields separately.
// `state.done` turns true on an OpenAI [DONE] line, which ends a stream cleanly even without a finish reason.
// A stream that sends no byte for `state.idleMs` ends with an error: a dead HTTP/2 session can hold it open
// with no bytes, and the default limit of the HTTP client is not this module's to rely on.
export const UPSTREAM_IDLE_MS = Number(process.env.LLM_SWITCHER_UPSTREAM_IDLE_MS) || 300000;

export async function* readUpstreamPayloads(upstreamRes, state = {}) {
  const reader = upstreamRes.body.getReader();
  const idleMs = state.idleMs || UPSTREAM_IDLE_MS;
  const read = () => {
    let timer;
    const idle = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`upstream stream sent nothing for ${Math.round(idleMs / 1000)}s`)), idleMs);
    });
    return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
  };
  const decoder = new TextDecoder();
  let buffer = '', data = [], finished = false;
  const parse = value => {
    const text = value.trim();
    if (text === '[DONE]') state.done = true;
    if (!text || text === '[DONE]') return null;
    return JSON.parse(text);
  };
  function line(value) {
    if (value.endsWith('\r')) value = value.slice(0, -1);
    if (!value) { const payload = data.join('\n'); data = []; return parse(payload); }
    if (value.startsWith('data:')) { data.push(value.slice(5).replace(/^ /, '')); return null; }
    if (value.startsWith('{') && !data.length) return parse(value);
    return null;
  }
  try {
    while (true) {
      const chunk = await read();
      if (chunk.done) { finished = true; buffer += decoder.decode(); break; }
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const payload = line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (payload) yield payload;
      }
    }
    if (buffer) { const payload = line(buffer); if (payload) yield payload; }
    // Tolerate an upstream's missing final blank line; completion is validated by the caller.
    const tail = parse(data.join('\n')); if (tail) yield tail;
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
