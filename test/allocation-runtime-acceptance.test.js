import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoLpBot } from '../src/bot.js';

const USDG = `0x${'11'.repeat(20)}`;
const CASHCAT = `0x${'22'.repeat(20)}`;
const MOO = `0x${'33'.repeat(20)}`;
const POOL_A = `0x${'a1'.repeat(32)}`;
const POOL_B = `0x${'b2'.repeat(32)}`;
const Q96 = 1n << 96n;
const units = (n, decimals) => BigInt(n) * 10n ** BigInt(decimals);
const sqrtForHumanSpot = (price, decimals0, decimals1) =>
  BigInt(Math.round(Math.sqrt(price * 10 ** (decimals1 - decimals0)) * Number(Q96)));

function makePool(id, asset, stableFirst, assetPrice, fees) {
  const stable = { address: USDG, symbol: 'USDG', decimals: 6 };
  const meme = { address: asset, symbol: asset === CASHCAT ? 'CASHCAT' : 'MOO', decimals: 18 };
  const token0 = stableFirst ? stable : meme;
  const token1 = stableFirst ? meme : stable;
  const humanSpot = stableFirst ? 1 / assetPrice : assetPrice;
  return {
    id, token0, token1, positions: [{ shares: 0n, tickLower: -100, tickUpper: 100,
      owed0: token0.address === USDG ? units(fees.usdg, 6) : units(fees.asset, 18),
      owed1: token1.address === USDG ? units(fees.usdg, 6) : units(fees.asset, 18) }]
  , _initialState: { paused: false, liquidity: 100n,
    sqrtPriceX96: sqrtForHumanSpot(humanSpot, token0.decimals, token1.decimals) } };
}

function makeBot() {
  const pools = [
    makePool(POOL_A, CASHCAT, true, 0.01, { usdg: 2, asset: 1000 }),
    makePool(POOL_B, MOO, false, 0.02, { usdg: 3, asset: 500 })
  ];
  const settings = new Map([
    ['investmentAllocation', { version: 1, enabled: true, allocations: [
      { poolId: POOL_A, weightBps: 7000 }, { poolId: POOL_B, weightBps: 3000 }
    ] }],
    ['investmentAllocationUpdatedAt', 1234]
  ]);
  const calls = { block: 0, poolState: 0, balances: 0, positionScan: 0, saved: 0 };
  const bot = Object.create(AutoLpBot.prototype);
  bot.config = { usdgAddress: USDG, logFromBlock: 1, reorgLookbackBlocks: 10,
    targetMode: 'legacy', targetPoolIds: ['legacy'], targetSymbols: ['OLD'] };
  bot.state = {
    getSetting(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; },
    setSetting(key, value) { settings.set(key, value); calls.saved++; }
  };
  bot.ledger = { append() {} };
  bot.market = { pools };
  bot.snapshot = { pools: [], portfolio: { positions: [] }, bot: {} };
  bot.providers = { readProvider: { async getBlockNumber() { calls.block++; return 987; } } };
  bot.fables = {
    async readPoolState(pool) { calls.poolState++; return pool._initialState; },
    async discoverPositions() { calls.positionScan++; return { positions: [] }; },
    async readWalletBalances() { calls.balances++; return {}; }
  };
  bot.allocationFunding = null;
  bot.cycleActive = false;
  bot.initializing = false;
  bot.rpcManagementActive = false;
  return { bot, pools, settings, calls };
}

const balances = {
  [USDG]: { raw: units(100, 6), amount: 100 },
  [CASHCAT]: { raw: units(1000, 18), amount: 1000 },
  [MOO]: { raw: units(500, 18), amount: 500 }
};

test('disabling allocation ignores stale paused pools and preserves saved ratios without revalidation', () => {
  const { bot, pools, settings } = makeBot();
  pools.forEach(pool => { pool.state = { paused: true, liquidity: 0n }; });
  bot.applyStoredExecutionTarget = () => { bot.config.targetMode = 'allowlist'; };
  const result = bot.setInvestmentAllocation({ enabled: false, allocations: [] });
  assert.equal(result.enabled, false);
  assert.equal(settings.get('investmentAllocation').allocations.length, 2);
  assert.equal(bot.config.targetMode, 'allowlist');
});

test('queued mode change suppresses allocation writes', async () => {
  const { bot, pools } = makeBot();
  bot.allocationUpdatePending = true;
  bot.getAllocationFundingScope = () => { throw new Error('must not plan capital writes'); };
  assert.equal(await bot.runAllocationExecutionCycle(pools, []), null);
});

test('paused strategy can disable during a read-only cycle without enabling capital execution', () => {
  const { bot } = makeBot();
  bot.cycleActive = true; bot.executionPaused = true;
  bot.applyStoredExecutionTarget = () => {};
  assert.equal(bot.setInvestmentAllocation({ enabled: false }).enabled, false);
  assert.equal(bot.executionPaused, true);
  assert.throws(() => bot.setInvestmentAllocation({ enabled: true }), /目前掃描/);
});

test('Bot fresh allocation valuation uses pool-local spot orientation and includes LP fees', async () => {
  const { bot, pools } = makeBot();
  const result = await bot.refreshAllocationFundingSnapshot({ pools, walletBalances: balances, asOfBlock: 987 });
  assert.equal(result.status, 'ready');
  assert.equal(result.asOfBlock, 987);
  assert.equal(result.allocationUpdatedAt, 1234);
  assert.ok(Math.abs(result.totalUsdG - 145) < 1e-7,
    `expected $145 USDG total including $12 and $13 fee equity, got ${result.totalUsdG}`);
  const a = result.byPool.find((entry) => entry.poolId === POOL_A);
  const b = result.byPool.find((entry) => entry.poolId === POOL_B);
  // 1000 CASHCAT at $0.01 plus $2 owed USDG; 500 MOO at $0.02 plus $3 owed USDG.
  assert.ok(Math.abs(a.lpEquityUsdG - 12) < 1e-7);
  assert.ok(Math.abs(b.lpEquityUsdG - 13) < 1e-7);
  assert.deepEqual(Object.keys(a.tokenCaps).sort(), [CASHCAT, USDG].sort());
  assert.deepEqual(Object.keys(b.tokenCaps).sort(), [MOO, USDG].sort());
});

test('cached allocation GET returns scope copies without RPC and mutation fails while operation is active', async () => {
  const { bot, pools, calls, settings } = makeBot();
  await bot.refreshAllocationFundingSnapshot({ pools, walletBalances: balances, asOfBlock: 987 });
  const snapshot = bot.getInvestmentAllocationSnapshot();
  assert.equal(snapshot.status, 'ready');
  const before = { ...calls };
  const scope = bot.getAllocationFundingScope(POOL_A);
  const originalCap = bot.getAllocationFundingScope(POOL_A).tokenCaps[USDG];
  scope.tokenCaps[USDG] = '999';
  assert.equal(bot.getAllocationFundingScope(POOL_A).tokenCaps[USDG], originalCap, 'scope token caps must be defensive copies');
  assert.deepEqual(calls, before, 'cached GET/scope must not make RPC calls');
  for (const busy of ['cycleActive', 'initializing', 'rpcManagementActive']) {
    bot[busy] = true;
    assert.throws(() => bot.setInvestmentAllocation({ enabled: true }), /current wallet operation|目前掃描/);
    bot[busy] = false;
  }
  assert.equal(calls.saved, 0);
  assert.equal(settings.get('investmentAllocationUpdatedAt'), 1234);
});

test('malformed persisted allocation config is reported blocked and never normalized to legacy disabled', () => {
  const { bot, settings } = makeBot();
  for (const malformed of [
    { version: 2, enabled: false, allocations: [] },
    { version: 1, enabled: false, allocations: [{ poolId: 'bad', weightBps: 10_000 }] },
    { version: 1, enabled: false, allocations: [null] },
    { version: 1, enabled: false, allocations: [{ poolId: POOL_A, weightBps: 9000 }] },
    { version: 1, enabled: true, allocations: [{ poolId: POOL_A, weightBps: 9999 }] }
  ]) {
    settings.set('investmentAllocation', malformed);
    assert.equal(bot.getInvestmentAllocationConfig().invalid, true);
    assert.equal(bot.getInvestmentAllocationConfig().enabled, true);
    assert.equal(bot.getInvestmentAllocationSnapshot().status, 'blocked');
  }
});

test('empty allocation bootstrap becomes ready from pool-local valuation without position scanning', async () => {
  const { bot, pools, settings, calls } = makeBot();
  bot.state.setSetting('investmentAllocation', { version: 1, enabled: true, allocations: [
    { poolId: POOL_A, weightBps: 7000 }, { poolId: POOL_B, weightBps: 3000 }
  ] });
  bot.state.setSetting('investmentAllocationUpdatedAt', Date.now());
  for (const pool of pools) pool.positions = [];
  const result = await bot.refreshAllocationFundingSnapshot({ pools, walletBalances: balances, asOfBlock: 988 });
  assert.equal(result.status, 'ready');
  assert.equal(result.totalUsdG, 120);
  assert.equal(bot.getInvestmentAllocationSnapshot().status, 'ready');
  assert.equal(calls.positionScan, 0);
});

test('enabled and freshly valued allocation permits live startup for a zero-LP wallet', async () => {
  const { bot, pools, settings } = makeBot();
  bot.config = { ...bot.config, walletAddress: `0x${'44'.repeat(20)}`, privateKey: 'synthetic-test-only',
    chainId: 4663, dryRun: false, enableLiveWrites: true, enableAutoRedeploy: true,
    eip7702GuardAddress: `0x${'55'.repeat(20)}`, eip7702GuardVerified: true,
    rpcRequestTimeoutMs: 30_000, pollIntervalMs: 15_000, rpcUrls: ['https://example.invalid'],
    targetMode: 'wallet-active', targetPoolIds: [], targetSymbols: [] };
  bot.market.pools = pools;
  bot.market.pools.forEach((pool) => { pool.state = pool._initialState; pool.positions = []; });
  bot.snapshot = { generatedAt: Date.now(), pools: pools.map((pool) => ({ ...pool, positions: [] })),
    portfolio: { positions: [] }, bot: {} };
  bot.walletImportState = { status: 'ready', address: bot.config.walletAddress };
  bot.walletProfiles = new Map();
  bot.rpcHealth = [{ ok: true, chainId: 4663 }];
  bot.providers = { rawProviders: [{}], readProvider: { async getBlockNumber() { return 987; } } };
  bot.executionPaused = true;
  bot.cycleActive = false;
  bot.resumeExecutionAfterStartup = false;
  bot.getSelectedExecutionTargetPoolId = () => '';
  bot.getInvestmentTargetSettings = () => ({ mode: 'wallet-active' });
  bot.getInvestmentTargetSnapshot = () => ({ mode: 'wallet-active', poolId: null });
  bot.getRuntimeIntervals = () => ({});
  bot.getUiGuardReadiness = async () => ({ ready: true, error: null });
  await bot.refreshAllocationFundingSnapshot({ pools, walletBalances: balances, asOfBlock: 987 });
  assert.equal(bot.getInvestmentAllocationSnapshot().status, 'ready');
  const status = await bot.controlStatus();
  assert.equal(status.startReadiness.ready, true, `zero-LP allocation startup blockers: ${status.startReadiness.blockers.join(',')}`);
  assert.deepEqual(status.startReadiness.blockers, []);
  assert.equal((await bot.startExecution('dashboard')).ok, true);
  assert.equal(bot.executionPaused, false);
  assert.equal(settings.get('investmentAllocation').enabled, true);
});

test('allocation mutation blocks a nonterminal journal but allows a terminal failed journal', () => {
  const { bot, pools, settings, calls } = makeBot();
  bot.market.pools = pools;
  pools.forEach((pool) => { pool.state = pool._initialState; });
  const savesBeforeJournal = calls.saved;
  bot.state.setSetting('activeRebalanceExecution', { phase: 'swap_sent', startedAt: Date.now() });
  assert.throws(() => bot.setInvestmentAllocation({ enabled: true }), /current wallet operation|execution|journal/i);
  bot.state.setSetting('activeRebalanceExecution', { phase: 'failed', startedAt: Date.now() });
  assert.doesNotThrow(() => bot.setInvestmentAllocation({ enabled: true }));
  assert.equal(settings.get('investmentAllocation').enabled, true);
  assert.equal(calls.saved, savesBeforeJournal + 4, 'two journal fixture writes and two allocation settings are persisted');
});

test('fresh allocation scan preserves LP range decoration for the top-up scheduler', async () => {
  const { bot, pools } = makeBot();
  bot.config.dryRun = true;
  bot.executionPaused = false;
  const pool = pools[0];
  pool.state = { ...pool._initialState, tick: 0 };
  pool.positions = [{ id: `0x${'66'.repeat(32)}`, shares: 10n ** 18n,
    tickLower: -100, tickUpper: 100, owed0: 0n, owed1: 0n, outside: false }];
  bot.config.autoTopupEnabled = true;
  bot.config.autoTopupMinIdleUsd = 1;
  bot.config.autoTopupMinIntervalSec = 60;
  bot.config.autoTopupDustBps = 100;
  bot.config.topUpMinGasReserveWei = 1n;
  bot.config.maxSwapPriceImpactBps = 200;
  for (const candidate of pools) candidate.state = { ...candidate._initialState, tick: 0 };
  bot.fables.readPoolState = async (candidate) => candidate.state;
  bot.fables.discoverPositions = async (candidate) => ({ positions: candidate.id === POOL_A
    ? [{ id: pool.positions[0].id, shares: 10n ** 18n, tickLower: -100, tickUpper: 100, owed0: 0n, owed1: 0n }]
    : [] });
  let decorateCalls = 0;
  bot.decoratePosition = async (_pool, position) => {
    decorateCalls++;
    position.outside = false;
    position.shouldRebalance = false;
  };
  bot.getInvestmentAllocationSnapshot = () => ({ status: 'ready' });
  bot.getAllocationFundingScope = (poolId) => ({ availableUsdG: poolId === POOL_A ? 20 : 0, poolId,
    allocationUpdatedAt: 1234, tokenCaps: { [USDG]: '1000000', [CASHCAT]: '1000000' } });
  let topUpCalled = 0;
  bot.executor = { async topUpPoolPosition() { topUpCalled++; return { status: 'completed' }; } };
  const result = await bot.runAllocationExecutionCycle(pools, []);
  assert.equal(result?.status, 'completed');
  assert.equal(topUpCalled, 1, 'fresh range scan should retain inside/in-range eligibility');
  assert.equal(decorateCalls, 1, 'only post-top-up refresh rescans; the cycle uses its fresh input');
});

test('allocation bootstraps the empty second pool before topping up the first healthy pool', async () => {
  const { bot, pools } = makeBot();
  bot.config.dryRun = true;
  bot.config.autoTopupEnabled = true;
  bot.config.autoTopupMinIdleUsd = 1;
  bot.executionPaused = false;
  for (const pool of pools) pool.state = { ...pool._initialState, tick: 0 };
  pools[0].positions = [{ id: 'healthy', shares: 1n, outside: false }];
  pools[1].positions = [];
  bot.refreshAllocationFundingSnapshot = async () => {};
  bot.getInvestmentAllocationSnapshot = () => ({ status: 'ready' });
  bot.getAllocationFundingScope = (poolId) => ({ poolId, availableUsdG: 20 });
  const jobs = [];
  bot.executor = {
    async executeAllocationBootstrap({ pool }) { jobs.push(pool.id); return { status: 'completed' }; },
    async topUpPoolPosition() { throw new Error('Healthy pool top-up must not starve an empty allocation'); }
  };
  const result = await bot.runAllocationExecutionCycle(pools, []);
  assert.equal(result.status, 'completed');
  assert.deepEqual(jobs, [POOL_B]);
});
