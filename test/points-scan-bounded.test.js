import assert from 'node:assert/strict';
import test from 'node:test';
import { AutoLpBot } from '../src/bot.js';
import { POINTS_DAY_MS } from '../src/analytics/points.js';
import { FABLES_POINTS_START_MS } from '../src/constants.js';

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

test('global swap day assignment uses two block timestamps and one day-boundary lookup', async () => {
  const bot = Object.create(AutoLpBot.prototype);
  const day = FABLES_POINTS_START_MS + 2 * POINTS_DAY_MS;
  const timestamps = { 100: day + 10_000, 200: day + POINTS_DAY_MS + 10_000 };
  const reads = [];
  bot.blockTimestamp = async (block) => { reads.push(block); return timestamps[block]; };
  bot.blockAtOrAfterTimestamp = async (at) => {
    assert.equal(at, day + POINTS_DAY_MS);
    return 150;
  };
  const swaps = [100, 149, 150, 200].map((blockNumber) => ({ blockNumber }));
  const times = await bot.campaignSwapTimestamps(swaps, 200, {});
  assert.deepEqual(reads, [100, 200]);
  assert.ok(times[0] >= day && times[0] < day + POINTS_DAY_MS);
  assert.ok(times[1] >= day && times[1] < day + POINTS_DAY_MS);
  assert.ok(times[2] >= day + POINTS_DAY_MS && times[2] < day + 2 * POINTS_DAY_MS);
  assert.ok(times[3] >= day + POINTS_DAY_MS && times[3] < day + 2 * POINTS_DAY_MS);
});
