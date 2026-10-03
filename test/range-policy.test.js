import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutoLpBot } from '../src/bot.js';
import { StateStore } from '../src/state.js';

test('OOR policy persists across restart and stays isolated per wallet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-range-policy-'));
  try {
    const file = path.join(dir, 'state.json');
    const bot = { config: { oorConfirmDelayMin: 15, oorMinExcursionPct: 0 },
      state: new StateStore(file), ledger: { append() {} } };
    assert.deepEqual(AutoLpBot.prototype.setRangePolicy.call(bot, { confirmDelayMin: 5, minExcursionPct: 0.25 }),
      { confirmDelayMin: 5, minExcursionPct: 0.25 });
    assert.equal(bot.config.oorConfirmDelayMs, 300000);
    assert.throws(() => AutoLpBot.prototype.setRangePolicy.call(bot, { confirmDelayMin: 0 }));
    assert.equal(bot.config.oorConfirmDelayMin, 5);
    bot.state = new StateStore(file); bot.config = {};
    bot.baseRangePolicy = { confirmDelayMin: 15, minExcursionPct: 0.5 };
    AutoLpBot.prototype.applyStoredRangePolicy.call(bot);
    assert.equal(bot.config.oorMinExcursionPct, 0.25);
    bot.state = new StateStore(path.join(dir, 'wallet2.json'));
    AutoLpBot.prototype.applyStoredRangePolicy.call(bot);
    assert.equal(bot.config.oorConfirmDelayMin, 15);
    assert.equal(bot.config.oorMinExcursionPct, 0.5);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
