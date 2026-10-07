// The summary call.
//
// One extra model call, made once, when a long conversation comes back after a pause. It is not
// free and it is not fast, and both costs are the price of not paying for the history on every
// turn of the new window.
//
// It is a separate call rather than a turn of the conversation because the answer serves two
// readers with different needs: the person waiting for the answer to their own question, and the
// agent that will read the summary next time. Folding them together would mean either the person
// reads a summary instead of an answer, or the summary is a summary of a summary.
//
// The model it uses is a setting, and empty means the one this conversation is already talking
// to. A cheaper model writes a cheaper summary and a worse one: the summary replaces the history,
// so what it leaves out is gone. That is the reader's call to make, not this gateway's.

import { clampSummary, summaryMessages } from './idlecompact.mjs';

/** Asks for the summary. Returns the text, or '' when nothing usable came back. */
export async function askSummary({ ir, policy, profile, mappedModel, model, build, fetchImpl = fetch, timeoutMs = 180000 }) {
  const msgs = summaryMessages(ir, policy);
  if (!msgs.length) return '';

  const ir2 = { ...ir, messages: msgs, stream: false, tools: [], toolChoice: null };
  const { url, headers, upBody } = build(profile, model, ir2);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(upBody),
      signal: ac.signal,
    });
    if (!res.ok) return '';
    const raw = await res.text();
    return clampSummary(answerText(raw, ir2), policy);
  } catch {
    // A summary that could not be produced is not a reason to fail the turn. The caller still
    // shortens the request, because a shortened history is worth having even with nothing
    // written to the session file.
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// The answer's text, from whichever shape came back.
function answerText(raw, ir) {
  let doc;
  try { doc = JSON.parse(raw); } catch { return ''; }
  if (Array.isArray(doc?.content)) {
    return doc.content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n');
  }
  if (doc?.choices?.[0]?.message?.content) return String(doc.choices[0].message.content);
  if (Array.isArray(doc?.output)) {
    let out = '';
    for (const item of doc.output) {
      if (typeof item?.text === 'string') out += item.text;
      for (const c of item?.content || []) if (c?.type === 'output_text' || c?.type === 'text') out += c.text || '';
    }
    return out;
  }
  if (Array.isArray(doc?.candidates)) {
    return doc.candidates.map(c => (c?.content?.parts || []).map(p => p.text || '').join('')).join('\n');
  }
  return '';
}