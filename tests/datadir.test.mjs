import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDataDir } from '../state.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-sw-datadir-'));

test('a git checkout keeps its data next to the code', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.git'));
  assert.equal(resolveDataDir(root, {}, '/home/u'), root);
});

test('an npm install keeps its data in the home directory, so an upgrade cannot erase it', () => {
  const root = tmp();
  assert.equal(resolveDataDir(root, {}, '/home/u'), path.join('/home/u', '.llm-switcher'));
});

test('LLM_SWITCHER_HOME overrides both', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.git'));
  assert.equal(resolveDataDir(root, { LLM_SWITCHER_HOME: '/data/sw' }, '/home/u'), path.resolve('/data/sw'));
});

test('the switch command file starts with a node shebang, as npm bin requires', () => {
  const first = fs.readFileSync(new URL('../switch.mjs', import.meta.url), 'utf8').split('\n')[0];
  assert.equal(first, '#!/usr/bin/env node');
});

test('package.json is publishable and exposes the switch command', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.bin?.switch, 'switch.mjs');
  assert.ok(fs.existsSync(new URL('../LICENSE', import.meta.url)), 'LICENSE file exists');
});
