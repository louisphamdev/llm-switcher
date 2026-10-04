// The dashboard, pressed like a person presses it: a real gateway, a real browser, real clicks.
// The other UI tests read the source of ui.html or call the API with a payload the test wrote.
// Neither can see a dashboard that sends the wrong payload, or that says "done" when nothing changed.
// So each test ends with the same check: what the page shows must equal what is on disk.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, skipReason } from './cdp.mjs';
import { startDashboardFixture } from './dashboard-fixture.mjs';

const TOOLS = ['claude', 'codex', 'agy'];
const LABEL = { claude: 'Claude', codex: 'Codex', agy: 'agy' };
const MASKED = '__LLM_SWITCHER_KEEP_KEY__';
// A profile's `tool` in config.json is one tool, or nothing for a profile that serves both.
const VALID_TOOLS = [undefined, null, 'claude', 'codex', 'agy'];

describe('dashboard, driven in a real browser', { skip: skipReason() }, () => {
  let fx, browser, page;

  before(async () => {
    fx = await startDashboardFixture();
    browser = await launchBrowser();
    page = await browser.newPage();
    // Once per tab, as the launcher of `switch ui` does; the tab keeps the token from then on.
    await page.goto(fx.tokenUrl());
  });

  // Close the tab itself, then raise the main one: a tab left in the background gets throttled
  // timers and no animation frames, which stalls every later test.
  async function closeTab(tab) {
    await tab.send('Page.close').catch(() => {});
    tab.close();
    await page.send('Page.bringToFront');
  }

  it('a new tab, opened from a bookmark after switch ui ran once, shows the profiles', async () => {
    const fresh = await browser.newPage();
    try {
      await fresh.goto(fx.dashboardUrl + '#/routes');
      await fresh.waitFor(`document.querySelectorAll('#profiles-grid .pcard').length === ${Object.keys(fx.config().profiles).length}`, 'the profile cards');
    } finally {
      await closeTab(fresh);
    }
  });

  it('a browser that never got the launcher token says so on the page, not only in a toast', async () => {
    const fresh = await browser.newPage();
    try {
      await fresh.goto(fx.dashboardUrl + '#/routes');
      await fresh.evaluate(`localStorage.clear(), sessionStorage.clear()`);
      await fresh.reload();
      await fresh.waitFor(`/switch ui/.test(document.getElementById('status-sub')?.textContent || '')`, 'the switch ui hint in the header');
    } finally {
      await closeTab(fresh);
      // The storage is shared by the origin, so the main tab needs the token again. A #hash change
      // alone fires no load event, so leave the page first.
      await page.goto('about:blank');
      await page.goto(fx.tokenUrl());
    }
  });

  after(async () => {
    // The gateway must stop even when the browser cleanup throws, or it holds this process open.
    try {
      await browser?.close();
    } finally {
      await fx?.stop();
    }
  });

  beforeEach(async () => {
    fx.upstream.mode = 'ok';
    fx.writeConfig(fx.baseline());
    await open('#/routes');
  });

  async function open(hash = '#/routes') {
    page.dialogPolicy = 'accept';
    await page.goto('about:blank');   // a fresh load every time, never a same-document #hash change
    await page.goto(fx.dashboardUrl + hash);
    await page.waitFor(`document.querySelectorAll('#profiles-grid .pcard').length === ${Object.keys(fx.config().profiles).length}`, 'the profile cards');
    await page.idle();
    page.clearProblems();
  }

  // Do what a person does, wait for the page to finish talking to the gateway, then check.
  async function act(what) {
    page.clearProblems();
    await page.evaluate(`document.getElementById('toast').textContent = ''`);
    await what();
    await page.idle();
  }

  const toast = () => page.text('#toast');
  const switchOf = (key) => `label.switch:has(input[aria-label*="(${key})"])`;
  const cardNumber = (key) => Object.keys(fx.config().profiles).indexOf(key) + 1;
  const modalOpen = () => page.visible('#profile-modal-overlay .modal');
  const profiles = () => fx.config().profiles;
  // What the page shows for the routes, read from the screen.
  const readScreen = () => page.evaluate(`(() => {
    const text = id => document.getElementById(id)?.textContent.trim();
    return {
      badges: { claude: text('badge-slot-claude'), codex: text('badge-slot-codex'), agy: text('badge-slot-agy') },
      selects: { claude: document.getElementById('select-slot-claude').value, codex: document.getElementById('select-slot-codex').value, agy: document.getElementById('select-slot-agy').value },
      aside: text('status-aside-indicator'),
      cards: [...document.querySelectorAll('#profiles-grid .pcard')].map(c => ({
        key: c.querySelector('.mono.faint').textContent.trim(),
        status: c.querySelector('.status').textContent.trim(),
        checked: c.querySelector('.switch input').checked
      }))
    };
  })()`);

  // What the page must show, worked out from the config file alone.
  function expectedScreen(cfg) {
    const active = cfg.activeProfiles;
    const on = TOOLS.filter(t => active[t]);
    return {
      badges: { claude: active.claude || 'OFF', codex: active.codex || 'OFF', agy: active.agy || 'OFF' },
      selects: { claude: active.claude || '', codex: active.codex || '', agy: active.agy || '' },
      aside: on.length ? `Active (${on.length})` : 'Idle',
      cards: Object.keys(cfg.profiles).map(key => {
        const tools = TOOLS.filter(t => active[t] === key);
        return { key, status: tools.length ? `Active (${tools.map(t => LABEL[t]).join(', ')})` : 'Idle', checked: tools.length > 0 };
      })
    };
  }

  // No console error, no uncaught exception, no HTTP 4xx or 5xx that the test did not expect.
  function expectQuiet(step, { allowStatus = [] } = {}) {
    // Chromium also logs each HTTP error as a console line; a status the test allowed is not a problem.
    const problems = page.problems.filter(p => {
      const status = /Failed to load resource: the server responded with a status of (\d+)/.exec(p)?.[1];
      return !(status && allowStatus.includes(Number(status)));
    });
    assert.deepEqual(problems, [], `${step}: the page reported problems`);
    assert.deepEqual(page.badResponses.filter(r => !allowStatus.includes(r.status)), [], `${step}: the gateway answered with an error status`);
  }

  // The page, the gateway's own answer and the file on disk must all say the same thing.
  async function expectScreenMatchesDisk(step, opts) {
    const cfg = fx.config();
    const served = (await fx.api('/api/status')).json;
    // A config written before agy existed has no agy key: on disk that means agy is off.
    assert.deepEqual(served.activeProfiles, { agy: null, ...cfg.activeProfiles }, `${step}: the gateway reports routes that are not on disk`);
    assert.deepEqual(await readScreen(), expectedScreen(cfg), `${step}: the page and the file disagree`);
    expectQuiet(step, opts);
  }

  // ---- the profile form, the way a person fills it ----

  const newProfile = () => page.clickText('#ph-actions button', '+ Add Profile');
  const editProfile = (key) => page.click(`#profiles-grid .pcard:nth-child(${cardNumber(key)}) button`);
  const saveForm = () => page.clickText('#profile-form .mf button', 'Save Profile');
  const tab = (name) => page.click(`#tab-button-${name}`);
  const useTemplate = (label) => page.clickText('#tab-general button', label);

  async function fillForm({ key, name, url, apiKey, tool }) {
    await tab('general');
    if (key !== undefined) await page.type('#p-key', key);
    if (name !== undefined) await page.type('#p-name', name);
    if (url !== undefined) await page.type('#p-url', url);
    if (apiKey !== undefined) await page.type('#p-key-val', apiKey);
    if (tool !== undefined) { await tab('routing'); await page.select('#p-tool', tool); await tab('general'); }
  }

  // ---- routes ----

  it('shows the routes that are on disk, with no error', async () => {
    await expectScreenMatchesDisk('first load');
    assert.match(await page.text('#app-version'), /^v\d+\.\d+\.\d+$/);
    assert.equal(await page.visible('#update-notice'), true, 'the registry stand-in offers a newer release');
  });

  it('gives every element an id of its own', async () => {
    const twice = await page.evaluate(`(() => { const ids = [...document.querySelectorAll('[id]')].map(e => e.id); return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]; })()`);
    assert.deepEqual(twice, [], 'an id used twice makes getElementById and the labels point at the wrong element');
  });

  describe('the switch on a profile card', () => {
    it('turns one profile off and on again for the tool it serves, and leaves the other tool alone', async () => {
      await act(() => page.click(switchOf('intact-claude')));
      assert.match(await toast(), /intact-claude deactivated/);
      assert.deepEqual(fx.config().activeProfiles, { claude: null, codex: 'intact-codex', agy: null });
      await expectScreenMatchesDisk('claude profile off');

      await act(() => page.click(switchOf('intact-claude')));
      assert.match(await toast(), /intact-claude activated/);
      assert.deepEqual(fx.config().activeProfiles, { claude: 'intact-claude', codex: 'intact-codex', agy: null });
      await expectScreenMatchesDisk('claude profile back on');
    });

    it('turns a profile that serves both tools on for both, and off again', async () => {
      await act(() => page.click(switchOf('shared')));
      assert.deepEqual(fx.config().activeProfiles, { claude: 'shared', codex: 'shared', agy: null });
      await expectScreenMatchesDisk('shared on');

      await act(() => page.click(switchOf('shared')));
      assert.deepEqual(fx.config().activeProfiles, { claude: null, codex: null, agy: null });
      await expectScreenMatchesDisk('shared off');
    });

    it('never says "deactivated" for a change it did not make, and shows what is really on disk', async () => {
      // Another tab, or `switch` in a terminal, already turned the profile off: the card is stale.
      const cfg = fx.config();
      cfg.activeProfiles.claude = null;
      fx.writeConfig(cfg);
      await act(() => page.click(switchOf('intact-claude')));
      const said = await toast();
      assert.doesNotMatch(said, /deactivated/, `the toast claims a change: "${said}"`);
      await expectScreenMatchesDisk('stale card', { allowStatus: [404, 409] });
    });
  });

  describe('the route list of each tool', () => {
    it('sets a route for one tool and can return it to the official endpoint', async () => {
      await act(() => page.select('#select-slot-claude', 'shared'));
      assert.deepEqual(fx.config().activeProfiles, { claude: 'shared', codex: 'intact-codex', agy: null });
      await expectScreenMatchesDisk('claude to shared');

      await act(() => page.select('#select-slot-codex', ''));
      assert.deepEqual(fx.config().activeProfiles, { claude: 'shared', codex: null, agy: null });
      await expectScreenMatchesDisk('codex to official');
    });

    it('offers each tool only the profiles that can serve it', async () => {
      const options = (id) => page.evaluate(`[...document.querySelectorAll('#${id} option')].map(o => o.value)`);
      assert.deepEqual(await options('select-slot-claude'), ['', 'intact-claude', 'shared']);
      assert.deepEqual(await options('select-slot-codex'), ['', 'intact-codex', 'shared']);
    });
  });

  describe('the buttons that turn every route off and on', () => {
    it('"Use official endpoints" in the page header turns every route off', async () => {
      await act(() => page.clickText('#ph-actions button', 'Use official endpoints'));
      assert.deepEqual(fx.config().activeProfiles, { claude: null, codex: null, agy: null });
      await expectScreenMatchesDisk('all off');
      const labels = await page.evaluate(`[...document.querySelectorAll('#ph-actions button')].map(b => b.textContent.trim())`);
      assert.deepEqual(labels, ['+ Add Profile', 'Activate compatible routes', 'Refresh']);
    });

    it('turning every route off and on again gives each tool its route back', async () => {
      await act(() => page.clickText('#ph-actions button', 'Use official endpoints'));
      await act(() => page.clickText('#ph-actions button', 'Activate compatible routes'));
      assert.deepEqual(fx.config().activeProfiles, { claude: 'intact-claude', codex: 'intact-codex', agy: null }, 'off and on lost a route');
      await expectScreenMatchesDisk('off and on');
    });

    it('"Toggle All" in the sidebar does the same as the header button', async () => {
      await act(() => page.click('.prefs button.btn-outline'));
      assert.deepEqual(fx.config().activeProfiles, { claude: null, codex: null, agy: null });
      await expectScreenMatchesDisk('sidebar toggle');
    });
  });

  // ---- creating a profile ----

  describe('creating a profile', () => {
    // The form starts on "All compatible tools (auto)", so a person who only fills the name and the
    // address gets that choice. It has to save, and the saved profile has to be one the gateway can use.
    for (const tool of ['auto', 'claude', 'codex']) {
      it(`saves a new profile for tool "${tool}" and the gateway can route to it`, async () => {
        await act(() => newProfile());
        assert.equal(await modalOpen(), true);
        assert.equal(await page.text('#form-title'), 'Add New Provider Profile');
        await fillForm({ key: `new-${tool}`, name: `New ${tool}`, url: `${fx.upstreamBase}/chat/v1`, apiKey: 'sk-new-key', tool });
        await act(() => saveForm());

        assert.match(await toast(), /saved successfully/, 'the save was refused');
        assert.equal(await modalOpen(), false);
        const saved = profiles()[`new-${tool}`];
        assert.ok(saved, 'the profile is not on disk');
        assert.equal(saved.apiKey, 'sk-new-key');
        assert.ok(VALID_TOOLS.includes(saved.tool), `the profile is saved with tool ${JSON.stringify(saved.tool)}, which the gateway cannot route`);
        expectQuiet('after save');

        // A profile that was saved must be usable: turning it on has to assign at least one tool.
        await act(() => page.click(switchOf(`new-${tool}`)));
        const active = fx.config().activeProfiles;
        assert.ok(Object.values(active).includes(`new-${tool}`), `turning on the saved profile changed nothing: ${JSON.stringify(active)}`);
        await expectScreenMatchesDisk('new profile on');
      });
    }

    for (const template of [['intact', 'intact'], ['9Router', '9router'], ['OpenRouter', 'openrouter'], ['Vertex AI', 'vertex'], ['Local Server', 'local']]) {
      const [label, key] = template;
      it(`the "${label}" template fills the form and saves`, async () => {
        await act(() => newProfile());
        await useTemplate(label);
        assert.equal(await page.value('#p-key'), key, 'the template sets the key of a new profile');
        assert.ok(['auto', 'claude', 'codex'].includes(await page.value('#p-tool')), `the template picks tool "${await page.value('#p-tool')}", which is not in the list`);
        await act(() => saveForm());
        assert.match(await toast(), /saved successfully/, 'the save was refused');
        const saved = profiles()[key];
        assert.ok(saved, 'the profile is not on disk');
        assert.ok(VALID_TOOLS.includes(saved.tool), `the profile is saved with tool ${JSON.stringify(saved.tool)}`);
        expectQuiet('after template save');
      });
    }

    it('refuses a key with a space and an empty address without sending anything', async () => {
      await act(() => newProfile());
      await fillForm({ key: 'bad key', name: 'Bad', url: `${fx.upstreamBase}/v1` });
      const before = JSON.stringify(fx.config());
      await act(() => saveForm());
      assert.equal(await modalOpen(), true, 'the dialog closed on an invalid key');
      assert.equal(JSON.stringify(fx.config()), before);

      await fillForm({ key: 'good-key', url: '' });
      await act(() => saveForm());
      assert.equal(await modalOpen(), true, 'the dialog closed without an address');
      assert.equal(JSON.stringify(fx.config()), before);
      expectQuiet('invalid form');
    });

    it('does not overwrite an existing profile that has the same key', async () => {
      // The control: the same form with a free key saves. Without it, a refused save would pass below.
      await act(() => newProfile());
      await fillForm({ key: 'free-key', name: 'Free', url: 'http://127.0.0.1:1/v1', apiKey: 'sk-free', tool: 'claude' });
      await act(() => saveForm());
      assert.ok(profiles()['free-key'], 'the control save was refused, so this test proves nothing');

      const before = JSON.stringify(profiles().shared);
      page.dialogPolicy = 'dismiss';
      await act(() => newProfile());
      await fillForm({ key: 'shared', name: 'Another shared', url: 'http://127.0.0.1:1/v1', apiKey: 'sk-other', tool: 'claude' });
      await act(() => saveForm());
      assert.equal(JSON.stringify(profiles().shared), before, 'a new profile replaced the profile "shared" and its key without asking');
    });
  });

  // ---- editing a profile ----

  describe('editing a profile', () => {
    for (const key of ['intact-claude', 'intact-codex', 'shared']) {
      it(`opening "${key}" and saving with no change leaves it as it was`, async () => {
        const before = profiles()[key];
        await act(() => editProfile(key));
        assert.equal(await modalOpen(), true);
        await act(() => saveForm());
        assert.match(await toast(), /saved successfully/, 'the save was refused');
        assert.deepEqual(profiles()[key], before, 'a save with no edit changed the profile');
        await expectScreenMatchesDisk('save with no change');
      });
    }

    it('shows the name and address, keeps the key read only, and never puts the API key on the page', async () => {
      await act(() => editProfile('intact-claude'));
      assert.equal(await page.value('#p-key'), 'intact-claude');
      assert.equal(await page.evaluate(`document.getElementById('p-key').readOnly`), true);
      assert.equal(await page.value('#p-name'), 'Intact Claude');
      assert.equal(await page.value('#p-key-val'), MASKED);
      assert.equal(await page.evaluate(`document.documentElement.outerHTML.includes('sk-secret-claude')`), false, 'the secret is in the page');
      assert.equal(JSON.stringify((await fx.api('/api/status')).json).includes('sk-secret'), false, 'the status answer carries a secret');
    });

    it('renames a profile and keeps its API key and its models', async () => {
      const before = profiles()['intact-claude'];
      await act(() => editProfile('intact-claude'));
      await fillForm({ name: 'Renamed Claude' });
      await act(() => saveForm());
      const after = profiles()['intact-claude'];
      assert.equal(after.name, 'Renamed Claude');
      assert.deepEqual({ ...after, name: before.name }, before, 'a rename changed something else');
      await expectScreenMatchesDisk('rename');
      assert.match(await page.text(`#profiles-grid .pcard:nth-child(${cardNumber('intact-claude')}) .nm`), /Renamed Claude/);
    });

    it('replaces the API key when a new one is typed', async () => {
      await act(() => editProfile('shared'));
      await fillForm({ apiKey: 'sk-rotated' });
      await act(() => saveForm());
      assert.equal(profiles().shared.apiKey, 'sk-rotated');
    });

    it('takes a route away when the profile can no longer serve that tool', async () => {
      await act(() => editProfile('intact-claude'));
      await tab('routing');
      await page.select('#p-tool', 'codex');
      await act(() => saveForm());
      assert.equal(fx.config().activeProfiles.claude, null, 'Claude still routes to a profile that only serves Codex');
      await expectScreenMatchesDisk('tool changed');
    });

    for (const [how, close] of [
      ['the close button', () => page.click('#profile-modal-overlay .mh button.icon')],
      ['Cancel', () => page.clickText('#profile-form .mf button', 'Cancel')],
      ['a press on the dark area', () => page.clickAt(5, 5)],
      // Inside a text field Escape belongs to the field, so the focus leaves the field first.
      ['the Escape key', async () => { await page.click('#form-title'); await page.key('Escape'); }]
    ]) {
      it(`closes with ${how} and saves nothing`, async () => {
        const before = JSON.stringify(fx.config());
        await act(() => editProfile('shared'));
        await fillForm({ name: 'Typed but not saved' });
        await act(() => close());
        assert.equal(await modalOpen(), false, 'the dialog is still open');
        assert.equal(JSON.stringify(fx.config()), before);
        await act(() => editProfile('shared'));
        assert.equal(await page.value('#p-name'), 'Shared Router', 'the form keeps text that was never saved');
      });
    }

    it('asks before it throws away typed text, and says nothing when nothing was typed', async () => {
      await act(() => editProfile('shared'));
      await act(() => page.clickText('#profile-form .mf button', 'Cancel'));
      assert.deepEqual(page.dialogs, [], 'a dialog asked about changes that were never made');
      assert.equal(await modalOpen(), false);

      page.dialogPolicy = 'dismiss';
      await act(() => editProfile('shared'));
      await fillForm({ name: 'Typed but not saved' });
      await act(() => page.clickText('#profile-form .mf button', 'Cancel'));
      assert.match(page.dialogs.at(-1)?.message ?? '', /Discard unsaved changes/, 'no question before the typed text was lost');
      assert.equal(await modalOpen(), true, 'the dialog closed although the person said no');
      assert.equal(await page.value('#p-name'), 'Typed but not saved');

      page.dialogPolicy = 'accept';
      await act(() => page.clickText('#profile-form .mf button', 'Cancel'));
      assert.equal(await modalOpen(), false);
    });

    it('keeps typed text when the page reads the state again', async () => {
      await act(() => editProfile('shared'));
      await fillForm({ name: 'Half typed' });
      await act(() => page.evaluate('loadStatus()'));     // what a 409 does behind the dialog
      assert.equal(await page.value('#p-name'), 'Half typed', 'a refresh wiped the text the person was typing');
    });

    it('does not save when Enter is pressed in a field', async () => {
      const before = JSON.stringify(fx.config());
      await act(() => editProfile('shared'));
      await fillForm({ name: 'Half typed' });
      await act(() => page.key('Enter'));
      assert.equal(await modalOpen(), true);
      assert.equal(JSON.stringify(fx.config()), before);
    });
  });

  // ---- model slots ----

  describe('model slots', () => {
    const modelsStatus = () => page.text('#models-status span');
    const comboOptions = (slot) => page.evaluate(`[...document.querySelectorAll('#p-${slot}-list .combo-opt .id')].map(e => e.textContent.trim())`);

    it('lists the models of the provider when the tab opens', async () => {
      await act(() => editProfile('intact-claude'));
      await act(() => tab('models'));
      await page.waitFor(`document.querySelector('#models-status')?.dataset.state === 'ready'`, 'the model list');
      assert.equal(await modelsStatus(), '3 models');
      assert.equal(await page.evaluate(`document.getElementById('models-status').dataset.state`), 'ready');
      assert.deepEqual(fx.upstream.received.filter(r => r.url.endsWith('/models')).at(-1)?.headers.authorization, 'Bearer sk-secret-claude', 'the stored key was not sent for the list');
    });

    it('picks a model with the mouse, with the keyboard, and keeps a name the provider does not list', async () => {
      await act(() => editProfile('intact-claude'));
      await act(() => tab('models'));
      await page.waitFor(`document.querySelector('#models-status')?.dataset.state === 'ready'`, 'the model list');

      await page.click('.combo:has(#p-sonnet) .combo-toggle');
      assert.deepEqual(await comboOptions('sonnet'), ['up-alpha', 'up-beta', 'up-gamma']);
      await page.click('#p-sonnet-list .combo-opt:nth-child(2)');
      assert.equal(await page.value('#p-sonnet'), 'up-beta');

      await page.type('#p-opus', 'gam');
      assert.deepEqual(await comboOptions('opus'), ['up-gamma'], 'typing does not filter the list');
      await page.key('ArrowDown');
      await page.key('Enter');
      assert.equal(await page.value('#p-opus'), 'up-gamma');
      assert.equal(await modalOpen(), true, 'Enter in a slot closed the dialog');

      await page.type('#p-haiku', 'my-own-model');
      await page.key('Escape');
      assert.equal(await modalOpen(), true, 'Escape in a slot closed the dialog');
      assert.equal(await page.value('#p-haiku'), 'my-own-model');

      await act(() => saveForm());
      const models = profiles()['intact-claude'].defaultModels;
      assert.equal(models.sonnet, 'up-beta');
      assert.equal(models.opus, 'up-gamma');
      assert.equal(models.haiku, 'my-own-model');
    });

    it('locks the 1M box for a model under 1M, and saves the box for a model that has it', async () => {
      await act(() => editProfile('intact-claude'));
      await act(() => tab('models'));
      await page.waitFor(`document.querySelector('#models-status')?.dataset.state === 'ready'`, 'the model list');
      await page.type('#p-sonnet', 'up-alpha');    // window 200000
      assert.equal(await page.evaluate(`document.getElementById('p-sonnet-1m').disabled`), true, 'the box is free for a 200K model');
      assert.match(await page.text('#p-sonnet-1m-note'), /200K.*under 1M/);
      await page.type('#p-opus', 'up-beta');       // window 1000000
      assert.equal(await page.evaluate(`document.getElementById('p-opus-1m').disabled`), false);
      await page.click('label:has(#p-opus-1m)');
      assert.equal(await page.evaluate(`document.getElementById('p-opus-1m').checked`), true);
      await act(() => saveForm());
      assert.equal(profiles()['intact-claude'].model1M?.opus, true);
      assert.notEqual(profiles()['intact-claude'].model1M?.sonnet, true);
    });

    it('says why the list did not load and loads it on Retry', async () => {
      fx.upstream.mode = 'deny';
      await act(() => editProfile('intact-claude'));
      await act(() => tab('models'));
      await page.waitFor(`document.querySelector('#models-status')?.dataset.state === 'error'`, 'the error state');
      assert.match(await modelsStatus(), /Models not loaded: bad key/);
      fx.upstream.mode = 'ok';
      await act(() => page.clickText('#models-status button', 'Retry'));
      await page.waitFor(`document.querySelector('#models-status')?.dataset.state === 'ready'`, 'the model list after Retry');
      assert.equal(await modelsStatus(), '3 models');
    });

    it('clears a model slot and a 1M box that the person emptied', async () => {
      const cfg = fx.config();
      cfg.profiles['intact-claude'].model1M = { opus: true };
      fx.writeConfig(cfg);
      await open('#/routes');
      await act(() => editProfile('intact-claude'));
      await act(() => tab('models'));
      await page.waitFor(`document.querySelector('#models-status')?.dataset.state === 'ready'`, 'the model list');
      await page.type('#p-sonnet', '');
      await page.key('Escape');    // the list of suggestions covers the boxes below until it closes
      await page.click('label:has(#p-opus-1m)');
      assert.equal(await page.evaluate(`document.getElementById('p-opus-1m').checked`), false);
      await act(() => saveForm());
      const saved = profiles()['intact-claude'];
      assert.equal(saved.defaultModels.sonnet, undefined, 'the emptied slot came back');
      assert.equal(saved.defaultModels.opus, 'up-opus');
      assert.ok(!saved.model1M?.opus, 'the unticked 1M box came back');
    });

    it('shows the slots of the tool that the profile serves', async () => {
      await act(() => editProfile('intact-claude'));
      await act(() => tab('models'));
      const slots = () => page.evaluate(`[...document.querySelectorAll('#slot-fields input[role=combobox]')].map(i => i.id)`);
      assert.deepEqual(await slots(), ['p-sonnet', 'p-opus', 'p-haiku', 'p-fable']);
      await tab('routing');
      await page.select('#p-tool', 'codex');
      await tab('models');
      assert.deepEqual(await slots(), ['p-main', 'p-review', 'p-subagent']);
    });
  });

  // ---- testing the connection ----

  describe('Test Connection', () => {
    const run = async () => {
      await act(() => editProfile('intact-claude'));
      await act(() => page.click('#btn-test-conn'));
      await page.waitFor(`!document.getElementById('btn-test-conn').disabled`, 'the test to finish');
    };

    it('reports a healthy provider with its latency and a sample', async () => {
      await run();
      assert.match(await page.text('#test-status-badge'), /HTTP 200 OK/);
      assert.match(await page.text('#test-latency'), /Latency: \d+ms/);
      assert.match(await page.text('#test-sample'), /Final answer/);
      assert.equal(await page.text('#btn-test-conn'), 'Test Connection');
    });

    for (const mode of ['deny', 'down']) {
      it(`reports a failure when the provider answers "${mode}"`, async () => {
        fx.upstream.mode = mode;
        await run();
        assert.match(await page.text('#test-status-badge'), /Failed/);
        assert.match(await page.text('#test-sample'), /^Error:/);
        assert.equal(await page.evaluate(`document.getElementById('btn-test-conn').disabled`), false, 'the button stays disabled after a failure');
        assert.match(await toast(), /connection failed/i);
      });
    }
  });

  // ---- deleting a profile ----

  describe('deleting a profile', () => {
    it('keeps the profile when the person says no', async () => {
      page.dialogPolicy = 'dismiss';
      const before = JSON.stringify(fx.config());
      await act(() => editProfile('shared'));
      await act(() => page.click('#btn-delete'));
      assert.match(page.dialogs.at(-1)?.message ?? '', /Delete provider profile "shared"/);
      assert.equal(JSON.stringify(fx.config()), before);
    });

    it('removes the profile and its route when the person says yes', async () => {
      await act(() => editProfile('intact-claude'));
      await act(() => page.click('#btn-delete'));
      assert.match(await toast(), /deleted/);
      assert.equal(profiles()['intact-claude'], undefined);
      assert.equal(fx.config().activeProfiles.claude, null, 'Claude still routes to a profile that is gone');
      await page.waitFor(`document.querySelectorAll('#profiles-grid .pcard').length === 2`, 'the card to go');
      await expectScreenMatchesDisk('after delete');
    });
  });

  // ---- moving around ----

  describe('the pages and the theme', () => {
    const view = () => page.evaluate(`[...document.querySelectorAll('.view-panel')].filter(p => p.style.display !== 'none').map(p => p.id)`);

    it('opens each page from the sidebar and follows the back button', async () => {
      for (const [nav, id, title] of [['models', 'view-models', 'Dynamic Model Catalog'], ['logs', 'view-logs', 'Request Inspector'], ['doctor', 'view-doctor', 'System Health & Doctor'], ['routes', 'view-routes', 'Routes & Profiles']]) {
        await act(() => page.click(`#sideNav a[data-nav="${nav}"]`));
        assert.deepEqual(await view(), [id], `${nav}: wrong page`);
        assert.equal(await page.text('#page-title'), title);
        assert.equal(await page.evaluate(`document.querySelector('#sideNav [aria-current="page"]')?.dataset.nav`), nav, `${nav}: the sidebar does not mark it`);
      }
      await page.evaluate('history.back()');
      await page.waitFor(`document.getElementById('view-doctor').style.display === 'block'`, 'the back button');
      expectQuiet('navigation');
    });

    it('shows the routes page for an address it does not know', async () => {
      await open('#/nowhere');
      assert.deepEqual(await view(), ['view-routes']);
    });

    it('keeps the page a person is on after a reload', async () => {
      await open('#/logs');
      assert.deepEqual(await view(), ['view-logs']);
      await page.reload();
      assert.deepEqual(await view(), ['view-logs']);
    });

    it('switches the theme and remembers it after a reload', async () => {
      await act(() => page.click('#btn-theme-light'));
      assert.equal(await page.evaluate('document.documentElement.dataset.theme'), 'light');
      assert.equal(await page.evaluate(`document.getElementById('btn-theme-light').getAttribute('aria-pressed')`), 'true');
      await page.reload();
      assert.equal(await page.evaluate('document.documentElement.dataset.theme'), 'light', 'the theme is lost after a reload');
      await act(() => page.click('#btn-theme-dark'));
      assert.equal(await page.evaluate('document.documentElement.dataset.theme'), 'dark');
    });

    it('shows the gateway port and the interceptor port on the Doctor page', async () => {
      await open('#/doctor');
      assert.equal(await page.text('.stats .gateway-port'), String(fx.port));
      assert.equal(await page.text('#blindfold-port-display'), `Port ${fx.config().blindfold.port}`);
    });
  });

  describe('the model catalog', () => {
    it('lists the models of both tools from the lists they keep on disk', async () => {
      await open('#/models');
      await page.waitFor(`document.querySelectorAll('#catalog-claude-items .row').length === 3`, 'the Claude models');
      assert.equal(await page.count('#catalog-codex-items .row'), 2);
      assert.match(await page.text('#badge-claude-count'), /^3 models/);
      assert.match(await page.text('#badge-codex-count'), /^2 models/);
      assert.equal(await page.text('#ct-models'), '5');
    });

    it('filters the list as a person types in the search box', async () => {
      await open('#/models');
      await page.waitFor(`document.querySelectorAll('#catalog-claude-items .row').length === 3`, 'the Claude models');
      await act(() => page.type('#catalog-search', 'sol'));
      const shown = await page.evaluate(`[...document.querySelectorAll('#catalog-claude-items .row, #catalog-codex-items .row')].filter(r => r.style.display !== 'none').map(r => r.querySelector('.mono').textContent.trim())`);
      assert.deepEqual(shown, ['gpt-5.6-sol']);
      await act(() => page.type('#catalog-search', ''));
      assert.equal(await page.evaluate(`[...document.querySelectorAll('#catalog-claude-items .row, #catalog-codex-items .row')].filter(r => r.style.display !== 'none').length`), 5);
    });

    it('syncs and copies a model name', async () => {
      await open('#/models');
      await page.waitFor(`document.querySelectorAll('#catalog-claude-items .row').length === 3`, 'the Claude models');
      await act(() => page.click('#btn-sync-catalog'));
      await page.waitFor(`!document.getElementById('btn-sync-catalog').disabled`, 'the sync to finish');
      assert.equal(await page.count('#catalog-claude-items .row'), 3);
      await act(() => page.clickText('#catalog-codex-items .row:first-child button', 'Copy'));
      assert.match(await toast(), /Copied gpt-5\.6-sol/);
      expectQuiet('catalog');
    });
  });

  describe('the request inspector', () => {
    it('lists a request that went through the gateway, and clears the list', async () => {
      const sent = await fx.messages();
      assert.equal(sent.status, 200, sent.text);
      await open('#/logs');
      await page.waitFor(`document.querySelectorAll('#inspector-logs-container .log-item').length === 1`, 'the request row');
      const row = await page.text('#inspector-logs-container .log-item');
      assert.match(row, /\/v1\/messages/);
      assert.match(row, /intact-claude/);
      assert.equal(await page.text('#ct-logs'), '1');

      await act(() => page.clickText('#view-logs button', 'Clear Logs'));
      await page.waitFor(`document.querySelector('#inspector-logs-container')?.textContent.includes('No requests recorded')`, 'the empty list');
      expectQuiet('inspector');
    });

    it('shows a new request by itself while auto-refresh is on, and stops when it is off', async () => {
      await open('#/logs');
      await fx.api('/api/logs/clear', {});
      await fx.messages();
      await page.waitFor(`document.querySelectorAll('#inspector-logs-container .log-item').length === 1`, 'the request row with auto-refresh on', 6000);
      await page.click('#chk-auto-refresh-logs');
      await fx.messages();
      await new Promise(r => setTimeout(r, 3600));
      assert.equal(await page.count('#inspector-logs-container .log-item'), 1, 'the list moved while auto-refresh was off');
    });
  });

  describe('a change made outside the dashboard', () => {
    it('keeps a profile that a terminal added, and shows it after the next action', async () => {
      const cfg = fx.config();
      cfg.profiles.terminal = { ...cfg.profiles.shared, name: 'Added in a terminal' };
      fx.writeConfig(cfg);
      await act(() => page.click(switchOf('intact-claude')));
      assert.ok(fx.config().profiles.terminal, 'the dashboard wrote over the profile a terminal added');
      await page.waitFor(`document.querySelectorAll('#profiles-grid .pcard').length === 4`, 'the new profile card');
      await expectScreenMatchesDisk('after outside edit');
    });
  });
  // Found by a human-behaviour pass over the running dashboard on 2026-09-29: a real browser, real
  // clicks and real keys, never a value set through the page's own JavaScript. Each test here is the
  // reproduction of one finding from that pass.
  describe('what a person notices when pressing the dashboard hard', () => {
    const editButtons = () => page.evaluate(
      `[...document.querySelectorAll('#profiles-grid .pcard button')].map(b => b.textContent.trim()).filter(t => /Edit/.test(t))`
    );

    it('gives a card back its normal Edit button after a close that saved nothing', async () => {
      await editProfile('intact-claude');
      await page.waitFor('document.getElementById("profile-modal-overlay").style.display === "grid"', 'the dialog');
      await page.key('Escape');
      await page.waitFor('document.getElementById("profile-modal-overlay").style.display === "none"', 'the dialog to close');
      assert.deepEqual((await editButtons()).filter(t => /Editing/.test(t)), [],
        'a dialog closed without saving left the card in the editing state');
    });

    it('moves the keyboard into the dialog when it opens', async () => {
      await editProfile('intact-claude');
      await page.waitFor('document.getElementById("profile-modal-overlay").style.display === "grid"', 'the dialog');
      const inside = await page.evaluate(
        `document.getElementById('profile-modal-overlay').contains(document.activeElement)`
      );
      assert.equal(inside, true, 'the focus stayed behind the overlay, so the first Tab leaves the dialog');
    });

    it('never shows the connection result of the profile opened before', async () => {
      await editProfile('intact-claude');
      await page.waitFor('document.getElementById("profile-modal-overlay").style.display === "grid"', 'the dialog');
      await act(() => page.clickText('#profile-modal-overlay button', 'Test Connection'));
      await page.waitFor(`document.getElementById('test-result').textContent.trim().length > 0`, 'a result');
      await page.key('Escape');
      await act(() => page.clickText('button', '+ Add Profile'));
      assert.equal(await page.text('#test-result'), '',
        'an untested new profile showed the connection result of the profile opened before it');
    });

    it('sends one save for one double-click on Save Profile', async () => {
      await act(() => page.clickText('button', '+ Add Profile'));
      await page.type('#p-key', 'dbl');
      await page.type('#p-name', 'Double click');
      await page.type('#p-url', 'https://dbl.example.io/v1');
      await page.type('#p-key-val', 'sk-dbl');
      page.clearProblems();
      const save = '#profile-modal-overlay button[type="submit"]';
      await page.click(save);
      await page.click(save);
      await page.idle();
      assert.equal(page.sent('POST', '/api/save-profile').length, 1,
        'a double-click sent the save twice, because the button is not disabled while it runs');
    });

    it('says so when a model search matches nothing', async () => {
      await open('#/models');
      await page.waitFor(`document.querySelectorAll('#catalog-claude-items .row').length > 0`, 'the catalog rows');
      await page.type('#catalog-search', 'zzz-nothing-matches-this-zzz');
      await page.waitFor(
        `[...document.querySelectorAll('#catalog-claude-items .row, #catalog-codex-items .row')].every(r => r.offsetParent === null)`,
        'every row hidden'
      );
      const shown = await page.evaluate(`(() => {
        const visible = (e) => e.offsetParent !== null;
        const message = [...document.querySelectorAll('#view-models *')]
          .some(e => visible(e) && /no match|nothing matches|no model/i.test(e.textContent));
        const badge = document.getElementById('badge-claude-count');
        return { message, badge: badge && visible(badge) ? badge.textContent.trim() : '' };
      })()`);
      assert.equal(shown.message, true, 'an empty result looked like a broken page: no message at all');
      assert.doesNotMatch(shown.badge, /^[1-9]/, `the header kept the unfiltered count: "${shown.badge}"`);
    });

    it('keeps the navigation reachable on a narrow window', async () => {
      await page.resize(400, 900);
      try {
        const box = await page.evaluate(`(() => {
          const aside = document.querySelector('aside'), nav = document.querySelector('aside nav');
          const a = aside.getBoundingClientRect(), n = nav.getBoundingClientRect();
          return { navHeight: n.height, navBottom: n.bottom, asideBottom: a.bottom, asideHeight: a.height };
        })()`);
        assert.ok(box.navHeight > 0, 'the navigation has no height at 400 px');
        assert.ok(box.navBottom <= box.asideBottom + 1,
          `the navigation is drawn outside the sidebar (nav bottom ${box.navBottom}, sidebar bottom ${box.asideBottom}, sidebar height ${box.asideHeight})`);
        assert.equal(await page.visible('aside nav a'), true, 'no navigation link is visible at 400 px');
      } finally {
        await page.resize(1280, 900);
      }
    });

    it('shows every dialog tab whole on a phone', async () => {
      await page.resize(390, 844);
      try {
        await editProfile('intact-claude');
        await page.waitFor('document.getElementById("profile-modal-overlay").style.display === "grid"', 'the dialog');
        const cut = await page.evaluate(`(() => {
          const bar = document.querySelector('#profile-form .tabs').getBoundingClientRect();
          return [...document.querySelectorAll('#profile-form .tabs .tab-btn')]
            .filter(b => { const r = b.getBoundingClientRect(); return r.left < bar.left - 0.5 || r.right > bar.right + 0.5; })
            .map(b => b.textContent.trim());
        })()`);
        assert.deepEqual(cut, [], 'these tabs are cut off by the tab bar at 390 px');
      } finally {
        await page.resize(1280, 900);
      }
    });

    it('does not let a long profile name break the dialog header', async () => {
      const cfg = fx.config();
      cfg.profiles['intact-claude'].name = 'N'.repeat(300);
      fx.writeConfig(cfg);
      await open('#/routes');
      await editProfile('intact-claude');
      await page.waitFor('document.getElementById("profile-modal-overlay").style.display === "grid"', 'the dialog');
      const t = await page.evaluate(`(() => {
        const e = document.getElementById('form-title');
        return { scroll: e.scrollWidth, client: e.clientWidth };
      })()`);
      assert.ok(t.scroll <= t.client + 1,
        `the header text is wider than its box (${t.scroll} > ${t.client}), so it clips mid-character`);
    });

    it('opens the payload preview while auto-refresh is on', async () => {
      const sent = await fx.messages();
      assert.equal(sent.status, 200, sent.text);
      await open('#/logs');
      await page.waitFor(`document.querySelectorAll('#inspector-logs-container details').length >= 1`, 'at least one log row with a preview');
      assert.equal(await page.evaluate(`document.getElementById('chk-auto-refresh-logs').checked`), true,
        'this test needs the default, which is auto-refresh on');
      // One click, the way a person clicks. A control that the poll detaches fails right here.
      await page.click('#inspector-logs-container details summary');
      const opened = await page.evaluate(`Boolean(document.querySelector('#inspector-logs-container details[open]'))`);
      assert.equal(opened, true, 'the poll replaces the row, so the preview cannot be opened while it runs');
    });
  });
});
