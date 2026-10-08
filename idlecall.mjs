// Optional, independently routed summary call. Empty model means no model is called.
import { clampSummary, summaryMessages } from './idlecompact.mjs';

export async function askSummary({ ir, policy, profile, model, build, fetchImpl = fetch,
  timeoutMs = 30000, onDiagnostic = () => {} }) {
  if (!policy?.model || !model) return '';
  const report = (code, status) => { try { onDiagnostic({ code, ...(status ? { status } : {}) }); } catch {} };
  let timer;
  try {
    const messages = summaryMessages(ir, policy);
    if (messages.length < 2) { report('summary-empty-input'); return ''; }
    const ir2 = { ...ir, messages, model, stream: false, tools: [], toolChoice: null };
    // Build and serialization are inside the failure boundary too: a bad route cannot reject
    // the promise before the caller installs its error handler.
    const { url, headers, upBody } = build(profile, model, ir2);
    const body = JSON.stringify(upBody);
    const ac = new AbortController();
    const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(180000, timeoutMs)) : 30000;
    timer = setTimeout(() => ac.abort(), boundedTimeout);
    // Race an abort as well: test doubles and nonstandard fetch implementations may ignore it.
    const timedOut = new Promise((_, reject) => {
      ac.signal.addEventListener('abort', () => {
        const error = new Error('summary timeout'); error.name = 'AbortError'; reject(error);
      }, { once: true });
    });
    const result = await Promise.race([(async () => {
      const res = await fetchImpl(url, { method: 'POST', headers, body, signal: ac.signal });
      if (!res.ok) { report('summary-http-failed', res.status); return ''; }
      const text = clampSummary(answerText(await res.text()), policy);
      if (!text) report('summary-empty-output');
      return text;
    })(), timedOut]);
    return result;
  } catch (error) {
    report(error?.name === 'AbortError' ? 'summary-timeout' : 'summary-call-failed');
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function answerText(raw) {
  let doc;
  try { doc = JSON.parse(raw); } catch { return ''; }
  // A tool response is not a summary, even if accompanied by some assistant text.
  if (doc?.content?.some?.(part => part?.type === 'tool_use') ||
      doc?.choices?.[0]?.message?.tool_calls?.length ||
      doc?.output?.some?.(item => ['function_call', 'custom_tool_call', 'local_shell_call'].includes(item?.type)) ||
      doc?.candidates?.some?.(candidate => candidate?.content?.parts?.some?.(part => part.functionCall))) return '';
  if (Array.isArray(doc?.content)) return doc.content.filter(part => part?.type === 'text')
    .map(part => typeof part.text === 'string' ? part.text : '').join('\n');
  if (typeof doc?.choices?.[0]?.message?.content === 'string') return doc.choices[0].message.content;
  if (Array.isArray(doc?.output)) return doc.output.flatMap(item =>
    (Array.isArray(item?.content) ? item.content : []).filter(part => ['output_text', 'text'].includes(part?.type)))
    .map(part => typeof part.text === 'string' ? part.text : '').join('\n');
  if (Array.isArray(doc?.candidates)) return doc.candidates.map(candidate =>
    (candidate?.content?.parts || []).map(part => typeof part.text === 'string' ? part.text : '').join('')).join('\n');
  return '';
}
