import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoLpBot } from '../src/bot.js';
import { RebalanceExecutor } from '../src/adapters/executor.js';

const pool = {
  id: '0xpool',
  key: { hooks: '0x0000000000000000000000000000000000000001' },
  token0: { symbol: 'USDG' },
  token1: { symbol: 'MEME' },
  state: { tick: 1200 }
};
const position = {
  id: '0x' + '11'.repeat(32),
  tickLower: 900,
  tickUpper: 1000,
  shares: 1n,
  owed0: 0n,
  owed1: 0n,
  outside: true,
  shouldRebalance: true,
  target: { tickLower: 1100, tickUpper: 1300 }
};

test('dry-run rebalance never commits cooldown/history or resets OOR state', async () => {
  const calls = { setPosition: 0, recordRebalance: 0, settings: [] };
  const bot = {
    state: {
      getSetting() { return 0; },
      recentRebalances() { return []; },
      setPosition() { calls.setPosition++; },
      recordRebalance() { calls.recordRebalance++; },
      setSetting(k, v) { calls.settings.push([k, v]); }
    },
    ledger: { append() {} },
    executionPaused: false,
    config: { maxRebalancesPerHour: 3, minRebalanceIntervalSec: 300 },
    async assertStillOutOfRangeBeforeRebalance() { return true; },
    executor: { async execute() { return { status: 'dry-run' }; } }
  };

  await AutoLpBot.prototype.maybeRebalance.call(bot, pool, { ...position });
  assert.equal(calls.setPosition, 0);
  assert.equal(calls.recordRebalance, 0);
  assert.ok(calls.settings.some(([k, v]) => k === 'lastAction' && String(v).startsWith('dry-run ')));
});

test('live executor fails closed unless auto-redeploy and atomic guard are explicitly enabled', async () => {
  const writes = [];
  const executor = new RebalanceExecutor(
    null,
    null,
    { dryRun: false, enableLiveWrites: true },
    {
      async readPoolState() { return { tick: 1200 }; }
    },
    { append(type, data) { writes.push({ type, data }); } },
    () => 0
  );

  await assert.rejects(
    executor.execute({ pool: { ...pool }, position: { ...position }, currentTick: 1200 }),
    /ENABLE_AUTO_REDEPLOY is not enabled/
  );
  assert.equal(writes.some((x) => x.type === 'tx.sent'), false);
});

test('executor refuses even dry-run when price has returned in range', async () => {
  const events = [];
  const executor = new RebalanceExecutor(
    null,
    null,
    { dryRun: true, enableLiveWrites: false },
    {
      async readPoolState() { return { tick: 950 }; }
    },
    { append(type, data) { events.push({ type, data }); } },
    () => 0
  );

  await assert.rejects(
    executor.execute({ pool: { ...pool }, position: { ...position }, currentTick: 1200 }),
    /Absolute in-range hold/
  );
  assert.ok(events.some((x) => x.type === 'rebalance.blocked'));
  assert.equal(events.some((x) => x.type === 'rebalance.dry_run'), false);
});

test('unfinished capital-moving journal blocks another automatic rebalance', () => {
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.state = {
    getSetting() {
      return { id: 'exec-1', phase: 'recovery_required' };
    }
  };
  assert.throws(
    () => executor.assertNoUnfinishedExecution(),
    /Unfinished rebalance execution requires recovery/
  );
});
