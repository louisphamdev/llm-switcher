// A headless Chromium and one page, driven over the Chrome DevTools Protocol with no dependency.
// The tests use it to press the real dashboard the way a person does: a click is a mouse event at
// the pixel where the element is drawn, so a control that is hidden or covered fails the test.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.LLM_SWITCHER_CHROMIUM,
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

export function findChromium() {
  return CANDIDATES.find(p => fs.existsSync(p)) || null;
}

// undefined when this machine can run the browser tests, otherwise the reason to skip them.
export function skipReason() {
  if (typeof WebSocket === 'undefined') return 'needs a global WebSocket (Node 22 or newer)';
  if (!findChromium()) return 'needs a Chromium or Chrome binary (set LLM_SWITCHER_CHROMIUM)';
  return undefined;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  Backspace: { code: 'Backspace', vk: 8 }
};

export async function launchBrowser() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsw-chromium-'));
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
    '--disable-background-networking', '--window-size=1280,900',
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    'about:blank'
  ];
  const child = spawn(findChromium(), args, { stdio: 'ignore', env: { ...process.env, HOME: dir } });
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    try { port = Number(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || 0; } catch { /* not written yet */ }
    if (!port) await sleep(100);
  }
  if (!port) { child.kill(); throw new Error('Chromium did not open a debugging port'); }

  const pages = [];
  return {
    async newPage() {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      const page = new Page(list.webSocketDebuggerUrl);
      await page.ready();
      pages.push(page);
      return page;
    },
    async close() {
      for (const p of pages) p.close();
      child.kill();
      await new Promise(r => { child.once('exit', r); setTimeout(r, 2000); });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

export class Page {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    // What a person would notice or what the code would report: kept so a test can assert on it.
    this.problems = [];      // console errors, uncaught exceptions, failed loads
    this.badResponses = [];  // { url, status } for every HTTP 4xx and 5xx
    this.dialogs = [];       // { type, message } for every alert, confirm and prompt
    this.dialogPolicy = 'accept';
    this.inflight = new Map();   // requestId -> url, so a stuck request can be named
    this.ws.addEventListener('message', (ev) => this.#onMessage(JSON.parse(ev.data)));
  }

  async ready() {
    if (this.ws.readyState !== 1) await new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }); });
    await Promise.all(['Page', 'Runtime', 'Network', 'Log'].map(d => this.send(`${d}.enable`)));
    this.on('Runtime.consoleAPICalled', (e) => {
      if (e.type === 'error' || e.type === 'assert') this.problems.push(`console.${e.type}: ${e.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
    });
    this.on('Runtime.exceptionThrown', (e) => this.problems.push(`exception: ${e.exceptionDetails.exception?.description || e.exceptionDetails.text}`));
    this.on('Log.entryAdded', (e) => { if (e.entry.level === 'error') this.problems.push(`log: ${e.entry.text} ${e.entry.url || ''}`.trim()); });
    this.on('Network.requestWillBeSent', (e) => this.inflight.set(e.requestId, e.request.url));
    // A new document ends every request of the old one, and no event says so for some of them.
    this.on('Page.frameNavigated', (e) => { if (!e.frame.parentId) this.inflight.clear(); });
    this.on('Network.loadingFinished', (e) => this.inflight.delete(e.requestId));
    this.on('Network.responseReceived', (e) => { if (e.response.status >= 400) this.badResponses.push({ url: e.response.url, status: e.response.status }); });
    this.on('Network.loadingFailed', (e) => {
      this.inflight.delete(e.requestId);
      if (!e.canceled) this.problems.push(`load failed: ${e.errorText} ${e.requestId}`);
    });
    this.on('Page.javascriptDialogOpening', (e) => {
      this.dialogs.push({ type: e.type, message: e.message });
      this.send('Page.handleJavaScriptDialog', { accept: this.dialogPolicy === 'accept' }).catch(() => {});
    });
  }

  #onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`)); else resolve(msg.result);
    } else if (msg.method) {
      for (const cb of this.listeners.get(msg.method) || []) cb(msg.params);
    }
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() { try { this.ws.close(); } catch { /* already closed */ } }

  // Forget what happened so far, so a test asserts only on the action it just made.
  clearProblems() { this.problems.length = 0; this.badResponses.length = 0; this.dialogs.length = 0; }

  // Wait until no request is in flight for `quiet` ms. A click starts a request, and the page then
  // starts a second one to read the state back, so one quiet moment is not enough.
  async idle(quiet = 250, timeout = 8000) {
    const end = Date.now() + timeout;
    let quietSince = Date.now();
    while (Date.now() < end) {
      if (this.inflight.size > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= quiet) return;
      await sleep(25);
    }
    throw new Error(`the page still has ${this.inflight.size} request(s) in flight after ${timeout} ms: ${[...this.inflight.values()].join(', ')}`);
  }

  #loaded(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the page did not finish loading in ${timeout} ms`)), timeout);
      const done = () => {
        clearTimeout(timer);
        const handlers = this.listeners.get('Page.loadEventFired');
        handlers.splice(handlers.indexOf(done), 1);
        resolve();
      };
      this.on('Page.loadEventFired', done);
    });
  }

  async goto(url) {
    const loaded = this.#loaded();
    const { errorText, loaderId } = await this.send('Page.navigate', { url });
    if (errorText) throw new Error(`could not open ${url}: ${errorText}`);
    // A change of the #hash alone stays in the same document: no load event will follow.
    if (loaderId) await loaded; else loaded.catch(() => {});
  }

  async reload() {
    const loaded = this.#loaded();
    await this.send('Page.reload');
    await loaded;
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n${expression}`);
    return r.result.value;
  }

  // Poll until the page expression is truthy. The message says what the test was waiting for.
  async waitFor(expression, message, timeout = 5000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try { last = await this.evaluate(expression); if (last) return last; } catch (e) { last = e.message; }
      await sleep(50);
    }
    throw new Error(`timed out after ${timeout} ms waiting for: ${message}\nlast value: ${JSON.stringify(last)}\nexpression: ${expression}`);
  }

  q(selector) { return `document.querySelector(${JSON.stringify(selector)})`; }
  text(selector) { return this.evaluate(`${this.q(selector)}?.textContent.trim() ?? null`); }
  value(selector) { return this.evaluate(`${this.q(selector)}?.value ?? null`); }
  count(selector) { return this.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`); }
  exists(selector) { return this.evaluate(`Boolean(${this.q(selector)})`); }
  // Visible means drawn with a size and not hidden by display, visibility or an ancestor.
  visible(selector) {
    return this.evaluate(`(() => { const e = ${this.q(selector)}; if (!e) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && e.getClientRects().length > 0; })()`);
  }

  // The centre of the element after it scrolled into view, and what the browser draws there.
  async #target(selector) {
    return this.evaluate(`(() => {
      const e = ${this.q(selector)};
      if (!e) return { missing: true };
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return { hidden: true };
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const label = e.closest('label');
      const reachable = hit && (e.contains(hit) || hit.contains(e) || (label && label.contains(hit)));
      return { x, y, reachable, hit: hit ? hit.tagName + (hit.id ? '#' + hit.id : '') + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.split(' ').join('.') : '') : null };
    })()`);
  }

  async click(selector) {
    const t = await this.#target(selector);
    if (t.missing) throw new Error(`click: no element matches ${selector}`);
    if (t.hidden) throw new Error(`click: ${selector} has no size, a person cannot press it`);
    if (!t.reachable) throw new Error(`click: ${selector} is covered by ${t.hit}, a person cannot press it`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.x, y: t.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: t.x, y: t.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: t.x, y: t.y, button: 'left', clickCount: 1 });
  }

  // A press at a pixel, for a target that has no element of its own: the dark area outside a dialog.
  async clickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  // Press the visible button or link whose label is `text`, the way a person finds it by reading.
  async clickText(scope, text) {
    const marked = await this.evaluate(`(() => {
      document.querySelectorAll('[data-test-target]').forEach(e => e.removeAttribute('data-test-target'));
      const hit = [...document.querySelectorAll(${JSON.stringify(scope)})].filter(e => e.textContent.trim() === ${JSON.stringify(text)} && e.getClientRects().length > 0);
      if (hit.length !== 1) return hit.length;
      hit[0].setAttribute('data-test-target', '1');
      return 1;
    })()`);
    if (marked !== 1) throw new Error(`clickText: ${marked} visible match(es) for "${text}" in ${scope}, expected exactly 1`);
    await this.click('[data-test-target="1"]');
    await this.evaluate(`document.querySelector('[data-test-target]')?.removeAttribute('data-test-target')`);
  }

  // Focus the field with a click, drop the old text, then type like a person: one input event.
  async type(selector, text) {
    await this.click(selector);
    await this.evaluate(`${this.q(selector)}.select()`);
    if (text === '') await this.key('Backspace'); else await this.send('Input.insertText', { text });
  }

  async key(name) {
    const k = KEYS[name];
    if (!k) throw new Error(`key: unknown key ${name}`);
    const base = { key: name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  // A native <select> opens an operating system popup that no protocol call can press, so this sets
  // the value the way the popup would and fires the same events.
  async select(selector, value) {
    await this.click(selector);
    await this.evaluate(`(() => { const s = ${this.q(selector)}; s.value = ${JSON.stringify(value)}; if (s.value !== ${JSON.stringify(value)}) throw new Error('select: no option ' + ${JSON.stringify(value)}); s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }
}
