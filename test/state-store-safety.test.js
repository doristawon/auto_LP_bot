import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';

function removeTestDir(dir) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const target = fs.realpathSync(dir);
  if (!target.startsWith(tempRoot + path.sep)) throw new Error('Refusing to remove a path outside temp');
  fs.rmSync(target, { recursive: true, force: true });
}

test('a stale StateStore instance cannot overwrite a newer wallet journal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-state-conflict-'));
  try {
    const file = path.join(dir, 'bot-state.json');
    const first = new StateStore(file);
    const second = new StateStore(file);
    first.setSetting('activeRebalanceExecution', { phase: 'withdraw_sent', tx: '0x123' });
    assert.throws(
      () => second.setSetting('activeRebalanceExecution', null),
      /changed since it was loaded/
    );
    assert.equal(new StateStore(file).getSetting('activeRebalanceExecution').phase, 'withdraw_sent');
  } finally { removeTestDir(dir); }
});

test('corrupt state fails closed and preserves the previous readable backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-state-backup-'));
  try {
    const file = path.join(dir, 'bot-state.json');
    const state = new StateStore(file);
    state.setSetting('activeRebalanceExecution', { phase: 'withdraw_sent' });
    state.setSetting('cycle', 2);
    assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).settings.activeRebalanceExecution.phase,
      'withdraw_sent');
    fs.writeFileSync(file, '{broken');
    assert.throws(() => new StateStore(file), /State file is unreadable/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { removeTestDir(dir); }
});

test('historic points block cache is bounded without deleting current policy state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-state-cache-'));
  try {
    const file = path.join(dir, 'bot-state.json');
    const state = new StateStore(file);
    state.data.settings.activeRebalanceExecution = { phase: 'swap_sent' };
    for (let i = 0; i < 512; i++) state.data.settings[`pointsBlockAtOrAfter:${i}`] = i;
    state.setSetting('pointsBlockAtOrAfter:512', 512);
    assert.equal(Object.keys(state.data.settings).filter((key) => key.startsWith('pointsBlockAtOrAfter:')).length, 512);
    assert.equal(state.getSetting('pointsBlockAtOrAfter:0'), null);
    assert.equal(state.getSetting('activeRebalanceExecution').phase, 'swap_sent');
  } finally { removeTestDir(dir); }
});
