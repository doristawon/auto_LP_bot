import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { AutoLpBot } from '../src/bot.js';
import { EIP7702_GUARD_ABI } from '../src/abi.js';

function fixture(error) {
  const settings = new Map();
  const events = [];
  const pool = { id: 'pool-1', token0: { symbol: 'USDG' }, token1: { symbol: 'PONS' }, state: { tick: 1200 } };
  const position = { id: 'position-1', outside: true, shouldRebalance: true,
    tickLower: 900, tickUpper: 1000, target: { tickLower: 1100, tickUpper: 1300 } };
  const bot = Object.assign(Object.create(AutoLpBot.prototype), {
    state: {
      getSetting(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; },
      setSetting(key, value) { settings.set(key, value); },
      recentRebalances() { return []; }
    },
    ledger: { append(type, data) { events.push({ type, data }); } },
    executionPaused: false,
    market: { pools: [pool], fablesStats: { pools: new Map() } },
    config: { maxRebalancesPerHour: 3, minRebalanceIntervalSec: 300 },
    getInvestmentTargetSettings() { return { mode: 'apr-highest', poolId: '' }; },
    async refreshAprForRebalance() {},
    resolveInvestmentTarget(sourcePool) { return sourcePool; },
    async assertStillOutOfRangeBeforeRebalance() { return true; },
    executor: { async execute() { throw error; } },
    setExecutionPaused(value) { this.executionPaused = value; }
  });
  return { bot, pool, position, settings, events };
}

test('rebalance events, backoff and result retain the decoded guard error without calldata', async () => {
  const guard = new Interface(EIP7702_GUARD_ABI);
  const data = guard.encodeErrorResult('LiquidityBelowMinimum', []);
  const error = Object.assign(new Error('unknown custom error calldata=0x' + 'ab'.repeat(1000)), { data });
  const { bot, pool, position, settings, events } = fixture(error);
  const result = await bot.maybeRebalance(pool, position);
  const failed = events.find(event => event.type === 'rebalance.failed').data;
  const backoff = Object.values(settings.get('rebalanceFailureBackoffs'))[0];
  assert.equal(result.status, 'failed');
  assert.equal(result.guardError, 'LiquidityBelowMinimum');
  assert.equal(failed.errorSelector, data);
  assert.match(result.error, /流動性低於最低限制/);
  assert.equal(failed.error, result.error);
  assert.equal(backoff.reason, result.error);
  assert.doesNotMatch(JSON.stringify({ result, events, backoff }), /abababab|unknown custom error/);
});

test('post-withdraw failure keeps recovery pause and uses the same journal decoded cause', async () => {
  const error = Object.assign(new Error('unknown custom error'), { executionJournalId: 'execution-1' });
  const { bot, pool, position, settings, events } = fixture(error);
  settings.set('activeRebalanceExecution', { id: 'execution-1', phase: 'recovery_required',
    tx: { withdraw: '0xconfirmed-withdraw' }, guardError: 'LiquidityBelowMinimum',
    errorSelector: '0xb6470697', atomicRetryGuardError: 'ExcessResidual', atomicRetrySelector: '0x6af2a037' });
  const result = await bot.maybeRebalance(pool, position);
  assert.equal(result.guardError, 'LiquidityBelowMinimum');
  assert.equal(bot.executionPaused, true);
  assert.ok(events.some(event => event.type === 'rebalance.auto_paused'));
});

test('allocation failure uses the same concise guard summary', async () => {
  const error = Object.assign(new Error('execution reverted (unknown custom error)'), { data: '0x6af2a037' });
  const { bot, pool, events } = fixture(error);
  const result = await bot.runAllocationJob(pool, 'bootstrap', async () => { throw error; });
  const failed = events.find(event => event.type === 'allocation.job_failed').data;
  assert.equal(failed.guardError, 'ExcessResidual');
  assert.match(result.reason, /殘餘代幣/);
  assert.equal(failed.error, result.reason);
});
