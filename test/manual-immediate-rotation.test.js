import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoLpBot } from '../src/bot.js';

const wallet = '0x0000000000000000000000000000000000000001';
const sourceId = '0x' + '11'.repeat(32);
const destinationId = '0x' + '22'.repeat(32);
const positionId = '0x' + '33'.repeat(32);
const token = (n, symbol) => ({
  address: '0x' + n.toString(16).padStart(40, '0'), symbol, decimals: 6
});

function harness() {
  const source = { id: sourceId, token0: token(10, 'USDG'), token1: token(11, 'EARN'),
    positions: [{ id: positionId, shares: 100n, outside: false }],
    state: { paused: false, liquidity: 1n } };
  const destination = { id: destinationId, token0: token(10, 'USDG'), token1: token(12, 'MOO'),
    positions: [], state: { paused: false, liquidity: 1n } };
  const bot = Object.create(AutoLpBot.prototype);
  bot.config = { walletAddress: wallet, dashboardManualControlEnabled: true,
    dryRun: false, enableLiveWrites: true, targetMode: 'allowlist',
    minRebalanceIntervalSec: 0, maxRebalancesPerHour: 10 };
  bot.market = { pools: [source, destination], fablesStats: { pools: new Map() } };
  bot.state = { getSetting() { return 0; }, recentRebalances() { return []; } };
  bot.ledger = { append() {} };
  bot.executionPaused = false;
  bot.cycleActive = false;
  bot.getInvestmentTargetSettings = () => ({ mode: 'specific-pool', poolId: destinationId });
  bot.runOnce = async (options) => {
    assert.equal(options.executeRebalances, false);
    return { blockNumber: 100, portfolio: { positions: [
      { id: positionId, poolId: sourceId, shares: '100' }
    ] } };
  };
  let executions = 0;
  bot.executor = {
    async assertLiveReady() {}, assertNoUnfinishedExecution() {},
    async preflightCrossPoolSequence() { return {
      totalImpactBps: 120, simulatedGasUsed: '500000', simulatedCallCount: 3,
      pendingApprovalCount: 0, finalTarget: { tickLower: -100, tickUpper: 100 }
    }; }
  };
  bot.maybeRebalance = async (_pool, _position, options) => {
    assert.equal(options.manualImmediate, true);
    executions++;
    return { status: 'completed' };
  };
  return { bot, get executions() { return executions; } };
}

test('manual immediate rotation binds a short-lived preview to wallet, source LP and saved destination', async () => {
  const h = harness();
  const request = { poolId: sourceId, positionId, destinationPoolId: destinationId };
  await assert.rejects(() => h.bot.manualImmediateRotation({ ...request, previewId: 'missing' }),
    /預演已過期或目標變更/);
  const preview = await h.bot.manualImmediateRotation({ ...request, previewOnly: true });
  assert.equal(preview.status, 'ready');
  assert.equal(preview.destinationPair, 'USDG/MOO');
  assert.equal(h.executions, 0);
  await assert.rejects(() => h.bot.manualImmediateRotation({ ...request, previewId: 'wrong' }),
    /預演已過期或目標變更/);
  const second = await h.bot.manualImmediateRotation({ ...request, previewOnly: true });
  await assert.rejects(() => h.bot.manualImmediateRotation({ ...request,
    previewId: second.previewId, maxCostBps: 400 }), /預演已過期或目標變更/);
  const third = await h.bot.manualImmediateRotation({ ...request, previewOnly: true });
  assert.deepEqual(await h.bot.manualImmediateRotation({ ...request, previewId: third.previewId }),
    { status: 'completed' });
  assert.equal(h.executions, 1);
  await assert.rejects(() => h.bot.manualImmediateRotation({ ...request, previewId: third.previewId }),
    /預演已過期或目標變更/);
});

test('manual immediate rotation rejects a changed saved destination after preview', async () => {
  const h = harness();
  const request = { poolId: sourceId, positionId, destinationPoolId: destinationId };
  const preview = await h.bot.manualImmediateRotation({ ...request, previewOnly: true });
  h.bot.getInvestmentTargetSettings = () => ({ mode: 'apr-highest', poolId: destinationId });
  await assert.rejects(() => h.bot.manualImmediateRotation({ ...request, previewId: preview.previewId }),
    /請先儲存指定池/);
  assert.equal(h.executions, 0);
});

test('manual cost override is bound to one preview and capped at five percent', async () => {
  const h = harness();
  const request = { poolId: sourceId, positionId, destinationPoolId: destinationId };
  await assert.rejects(() => h.bot.manualImmediateRotation({ ...request,
    previewOnly: true, maxCostBps: 501 }), /1 至 500 bps/);
  const preview = await h.bot.manualImmediateRotation({ ...request,
    previewOnly: true, maxCostBps: 400 });
  assert.equal(preview.maxCostBps, 400);
  await assert.rejects(() => h.bot.manualImmediateRotation({ ...request,
    previewId: preview.previewId, maxCostBps: 350 }), /預演已過期或目標變更/);
  assert.equal(h.executions, 0);
});

test('explicit manual preview ignores automatic rebalance cooldown and quota', async () => {
  const h = harness();
  h.bot.config.minRebalanceIntervalSec = 3600;
  h.bot.config.maxRebalancesPerHour = 0;
  h.bot.state.getSetting = (key, fallback) => key === 'walletTopologyCooldownUntil'
    ? Date.now() + 3600_000 : fallback;
  h.bot.state.recentRebalances = () => [{ ts: Date.now() }];
  const preview = await h.bot.manualImmediateRotation({
    poolId: sourceId, positionId, destinationPoolId: destinationId, previewOnly: true
  });
  assert.equal(preview.status, 'ready');
  assert.ok(preview.expiresAt - Date.now() > 9 * 60_000);
  assert.equal(h.executions, 0);
});
