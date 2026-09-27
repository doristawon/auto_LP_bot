import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoLpBot } from '../src/bot.js';

const pool = {
  id: '0x' + 'ab'.repeat(32),
  token0: { address: '0x0000000000000000000000000000000000000001', symbol: 'USDG' },
  token1: { address: '0x0000000000000000000000000000000000000002', symbol: 'EARN' },
  state: { tick: 950, paused: false },
  positions: [{ id: '0x' + 'cd'.repeat(32), shares: 1n, tickLower: 900, tickUpper: 1000,
    outside: false }]
};

function fixture() {
  const settings = new Map();
  const calls = [];
  const bot = {
    config: { autoTopupEnabled: true, dryRun: false, enableLiveWrites: true,
      enableAutoRedeploy: true, privateKey: 'test-only', autoTopupMinIdleUsd: 25,
      autoTopupDustBps: 25, autoTopupMinIntervalSec: 1800, topUpMinGasReserveWei: 200_000_000_000_000n },
    executionPaused: false,
    state: {
      getSetting(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; },
      setSetting(key, value) { settings.set(key, value); }
    },
    ledger: { append() {} },
    priceOf(address) { return address.toLowerCase() === pool.token0.address.toLowerCase() ? 1 : 0.00003; },
    getInvestmentTargetSettings() { return { mode: 'apr-highest', poolId: '' }; },
    executor: { async topUpPoolPosition(request) { calls.push(request); return { status: 'completed' }; } }
  };
  const balances = {
    [pool.token0.address.toLowerCase()]: { amount: 93 },
    [pool.token1.address.toLowerCase()]: { amount: 4_000_000 }
  };
  return { bot, balances, calls };
}

test('in-range idle pair inventory is offered to the current target once per cooldown', async () => {
  const { bot, balances, calls } = fixture();
  const first = await AutoLpBot.prototype.maybeTopUpIdleBalance.call(bot, [pool], balances);
  assert.equal(first.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pool.id, pool.id);
  assert.equal(calls[0].dustBps, 25);
  assert.equal(calls[0].minGasReserveWei, 200_000_000_000_000n);
  const second = await AutoLpBot.prototype.maybeTopUpIdleBalance.call(bot, [pool], balances);
  assert.equal(second, null);
  assert.equal(calls.length, 1);
});

test('top-up never targets an OOR position, paused pool, or a different specific target', async () => {
  const { bot, balances, calls } = fixture();
  const oor = { ...pool, positions: [{ ...pool.positions[0], outside: true }] };
  assert.equal(await AutoLpBot.prototype.maybeTopUpIdleBalance.call(bot, [oor], balances), null);
  const paused = { ...pool, state: { ...pool.state, paused: true } };
  assert.equal(await AutoLpBot.prototype.maybeTopUpIdleBalance.call(bot, [paused], balances), null);
  bot.getInvestmentTargetSettings = () => ({ mode: 'specific-pool', poolId: '0x' + 'ef'.repeat(32) });
  assert.equal(await AutoLpBot.prototype.maybeTopUpIdleBalance.call(bot, [pool], balances), null);
  assert.equal(calls.length, 0);
});

test('APR highest mode adds to the existing in-range LP until OOR rotation', async () => {
  const { bot, balances, calls } = fixture();
  bot.resolveInvestmentTarget = () => ({ ...pool, id: '0x' + 'ef'.repeat(32) });
  const result = await AutoLpBot.prototype.maybeTopUpIdleBalance.call(bot, [pool], balances);
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 1);
});
