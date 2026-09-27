import assert from 'node:assert/strict';
import test from 'node:test';
import { AutoLpBot } from '../src/bot.js';

test('global points backfill scans bounded windows and records incomplete coverage', async () => {
  const settings = new Map();
  const cursors = new Map();
  const calls = [];
  const bot = Object.create(AutoLpBot.prototype);
  bot.config = { reorgLookbackBlocks: 64 };
  bot.points = { predictionStartMs: () => 12345 };
  bot.state = {
    getSetting: (key, fallback) => settings.has(key) ? settings.get(key) : fallback,
    setSetting: (key, value) => settings.set(key, value),
    getCursor: (key, fallback) => cursors.has(key) ? cursors.get(key) : fallback,
    setCursor: (key, value) => cursors.set(key, value)
  };
  bot.blockAtOrAfterTimestamp = async () => 1000;
  bot.fables = {
    scanGlobalSwaps: async (_pools, fromBlock, toBlock) => {
      calls.push([fromBlock, toBlock]);
      return [];
    }
  };
  bot.ledger = { appendUnique: () => {} };

  await bot.scanGlobalPointFees([], 50000);
  assert.deepEqual(calls[0], [1000, 10999]);
  assert.equal(cursors.get('pointsGlobalSwapsV2'), 11000);
  assert.equal(settings.get('pointsGlobalScanProgress').complete, false);

  await bot.scanGlobalPointFees([], 50000);
  assert.deepEqual(calls[1], [10936, 20935]);
  assert.equal(cursors.get('pointsGlobalSwapsV2'), 20936);

  cursors.set('pointsGlobalSwapsV2', 49950);
  await bot.scanGlobalPointFees([], 50000);
  assert.deepEqual(calls[2], [49886, 50000]);
  assert.equal(settings.get('pointsGlobalScanProgress').complete, true);
});
