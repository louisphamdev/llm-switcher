// SSE dispatches one event at a blank line; data fields are joined with newlines.
// Vertex also sends bare JSON lines. Keep both framings without parsing data fields separately.
export async function* readUpstreamPayloads(upstreamRes) {
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data = [], finished = false;
  const parse = value => {
    const text = value.trim();
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
      const chunk = await reader.read();
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
