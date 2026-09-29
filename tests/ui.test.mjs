import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui.html'), 'utf8');

function functionBody(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in ui.html`);
  return html.slice(start, html.indexOf('\n    }\n', start));
}

// The UI holds a redacted config, so a saved key reaches the server as MASKED_KEY.
// The server resolves it only from the profile named in `key`.
test('Browse Models sends the profile key, so a masked API key resolves to the stored one', () => {
  assert.match(functionBody('fetchModelList'), /key:\s*formLoadedKey/);
});

// Every admin write endpoint answers { success: true } (proxy.mjs). A check on `ok` reads undefined
// and reports a failure after the write already reached disk.
test('the UI reads `success` from every admin write endpoint', () => {
  const writes = ['/api/switch', '/api/toggle', '/api/save-profile', '/api/delete-profile', '/api/catalog/refresh', '/api/logs/clear'];
  for (const endpoint of writes) {
    let at = html.indexOf(`api('${endpoint}'`);
    assert.ok(at >= 0, `${endpoint} is not called`);
    for (; at >= 0; at = html.indexOf(`api('${endpoint}'`, at + 1)) {
      const check = html.slice(at, html.indexOf('\n', html.indexOf('if (data.', at)));
      assert.match(check, /if \(data\.success\)/, `${endpoint} is checked with the wrong field`);
    }
  }
});

test('Enter in a profile field does not submit the form', () => {
  assert.match(html, /id="profile-form"[^>]*onkeydown="blockImplicitSubmit\(event\)"/);
  const guard = functionBody('blockImplicitSubmit');
  assert.match(guard, /e\.key === 'Enter'/);
  assert.match(guard, /preventDefault\(\)/);
});

test('the overlay closes the dialog only for a press that started on the overlay', () => {
  assert.match(html, /id="profile-modal-overlay"[^>]*onmousedown="overlayPressed = event\.target === this"/);
  assert.match(html, /id="profile-modal-overlay"[^>]*onclick="if \(overlayPressed && event\.target === this\) closeProfileModal\(\)"/);
});

test('Escape inside a dialog field is left to the field', () => {
  const start = html.indexOf("window.addEventListener('keydown'");
  const handler = html.slice(start, html.indexOf('});', start));
  assert.match(handler, /closest(\?\.)?\('input, select, textarea'\)/);
});

// X1: one searchable combobox per slot replaces the shared datalist and the chip box.
test('each model slot is its own combobox with its own listbox', () => {
  const slotInput = html.match(/<input type="text" id="p-\$\{s\.id\}"[^>]*>/)?.[0] || '';
  assert.match(slotInput, /role="combobox"/);
  assert.match(slotInput, /aria-controls="p-\$\{s\.id\}-list"/);
  assert.match(slotInput, /aria-autocomplete="list"/);
  assert.doesNotMatch(slotInput, /list="model-options"/, 'no shared datalist');
  assert.match(html, /<ul class="combo-list" id="p-\$\{s\.id\}-list" role="listbox"/);
  for (const gone of ['id="model-browser"', '<datalist id="model-options"', 'function selectModel(', 'function renderModelBrowser(', 'id="btn-fetch-models"']) {
    assert.ok(!html.includes(gone), `${gone} is still in ui.html`);
  }
});

test('opening the Model Slots tab loads the provider models once per source', () => {
  assert.match(functionBody('switchTab'), /if \(tabId === 'tab-models'\) ensureModelsLoaded\(\)/);
  const ensure = functionBody('ensureModelsLoaded');
  assert.match(ensure, /modelsSourceKey\(\)/);
  assert.match(ensure, /fetchModelList\(\)/);
  assert.match(html, /id="models-status"[^>]*aria-live="polite"/);
});

test('the combobox keeps the keyboard inside the field', () => {
  const keys = functionBody('onComboKeydown');
  for (const k of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) assert.match(keys, new RegExp(`'${k}'`));
  assert.match(keys, /stopPropagation\(\)/, 'Escape and Enter do not reach the dialog');
  // An option is chosen on mousedown, before the field loses the focus.
  assert.match(functionBody('renderComboOptions'), /onmousedown/);
  // scrollIntoView also scrolls the dialog body and pushes the other slots out of view.
  assert.doesNotMatch(functionBody('setComboActive'), /scrollIntoView/);
  assert.match(functionBody('placeCombo'), /maxHeight/, 'the list fits the room it opens into');
});

// A profile without outFormat routes by the model. Loading it as 'openai-chat' made every save write
// that value, which changed the routing of a profile the user did not touch.
test('a profile without outFormat keeps auto routing through a save', () => {
  assert.match(html, /<select id="p-outformat">\s*<option value="">/);
  assert.match(html, /getElementById\('p-outformat'\)\.value = p\.outFormat \|\| '';/);
});

// The 1M box is locked only when the model's window is known and under 1M. An unknown window
// only warns: many gateways list no limits at all.
test('contextVerdict locks only a window known to be under 1M', () => {
  const verdict = new Function(functionBody('contextVerdict') + '\n    }\n    return contextVerdict;')();
  assert.equal(verdict(undefined).kind, 'unknown');
  assert.equal(verdict({ output: 32000 }).kind, 'unknown');
  assert.equal(verdict({ context: 200000 }).kind, 'small');
  assert.equal(verdict({ context: 200000 }).window, 200000);
  assert.equal(verdict({ input: 1000000 }).kind, 'ok');
  assert.equal(verdict({ context: 1048576 }).kind, 'ok');
});

test('each 1M box names its slot and points at its note', () => {
  const slots = functionBody('renderModelSlots');
  assert.match(slots, /aria-label="1M context for \$\{escapeHtml\(s\.name\)\}"/);
  assert.match(slots, /aria-describedby="p-\$\{s\.id\}-1m-note"/);
  assert.match(slots, /class="slot-1m-note" id="p-\$\{s\.id\}-1m-note" role="status"/);
  assert.doesNotMatch(html, /\.slot-1m-note:empty \{ display: none/);
});
