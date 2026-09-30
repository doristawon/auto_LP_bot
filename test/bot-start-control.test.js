import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoLpBot } from '../src/bot.js';
import { registerSensitiveValues } from '../src/logger.js';

const POOL_ID = '0x' + '11'.repeat(32);
const WALLET = '0x00000000000000000000000000000000000000aa';

function makeBot() {
  const settings = new Map();
  const probes = { guard: 0 };
  const bot = Object.create(AutoLpBot.prototype);
  bot.config = {
    walletAddress: WALLET,
    chainId: 4663,
    rpcUrls: ['https://example.invalid'],
    dryRun: false,
    enableLiveWrites: true,
    enableAutoRedeploy: true,
    privateKey: 'configured-test-signer',
    eip7702GuardAddress: WALLET,
    eip7702GuardVerified: true,
    pollIntervalMs: 15_000,
    rpcRequestTimeoutMs: 30_000
  };
  bot.state = {
    getSetting(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; },
    setSetting(key, value) { settings.set(key, value); }
  };
  bot.ledger = { append() {} };
  bot.executor = { async assertAtomicGuardReady() { probes.guard++; } };
  bot.market = { pools: [{ id: POOL_ID }] };
  bot.snapshot = {
    generatedAt: Date.now(),
    pools: [{ id: POOL_ID, positions: [{ shares: '1' }] }],
    portfolio: { positions: [{ shares: '1' }] },
    bot: {}
  };
  bot.walletImportState = { status: 'ready', address: WALLET };
  bot.walletProfiles = new Map();
  bot.rpcHealth = [{ ok: true, chainId: 4663 }];
  bot.providers = { rawProviders: [{}], readProvider: {} };
  bot.guardReadinessCache = new WeakMap();
  bot.executionPaused = true;
  bot.cycleActive = true;
  bot.getSelectedExecutionTargetPoolId = () => POOL_ID;
  bot.getInvestmentTargetSettings = () => ({ mode: 'apr-highest' });
  bot.getInvestmentTargetSnapshot = () => ({ mode: 'apr-highest', poolId: POOL_ID });
  bot.getRuntimeIntervals = () => ({});
  return { bot, settings, probes };
}

test('start control accepts a healthy paused bot during a routine monitor cycle', async () => {
  const { bot, settings } = makeBot();
  const status = await bot.controlStatus();
  assert.equal(status.cycleActive, true);
  assert.equal(status.startReadiness.ready, true);
  assert.deepEqual(status.startReadiness.blockers, []);
  const started = await bot.startExecution('dashboard');
  assert.equal(started.ok, true);
  assert.equal(bot.executionPaused, false);
  assert.equal(settings.get('executionPaused'), false);
});

test('start control still blocks an unfinished capital-moving execution', async () => {
  const { bot, settings } = makeBot();
  settings.set('activeRebalanceExecution', { phase: 'withdraw_sent', startedAt: Date.now() });
  const status = await bot.controlStatus();
  assert.ok(status.startReadiness.blockers.includes('execution-busy'));
  const started = await bot.startExecution('dashboard');
  assert.equal(started.ok, false);
  assert.equal(bot.executionPaused, true);
});

test('dashboard guard readiness coalesces requests and caches success for five minutes by wallet and provider', async () => {
  const { bot, probes } = makeBot();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    await Promise.all([bot.controlStatus(), bot.controlStatus()]);
    assert.equal(probes.guard, 1);
    await bot.controlStatus();
    assert.equal(probes.guard, 1);
    now += 5 * 60_000 + 1;
    await bot.controlStatus();
    assert.equal(probes.guard, 2);
    bot.config.walletAddress = '0x00000000000000000000000000000000000000bb';
    await bot.controlStatus();
    assert.equal(probes.guard, 3);
    bot.providers.readProvider = {};
    await bot.controlStatus();
    assert.equal(probes.guard, 4);
  } finally {
    Date.now = originalNow;
  }
});

test('dashboard guard readiness caches failure for one minute then retries', async () => {
  const { bot, probes } = makeBot();
  const originalNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  bot.executor.assertAtomicGuardReady = async () => {
    probes.guard++;
    throw new Error('unavailable');
  };
  try {
    await bot.controlStatus();
    await bot.controlStatus();
    assert.equal(probes.guard, 1);
    now += 60_000 + 1;
    await bot.controlStatus();
    assert.equal(probes.guard, 2);
  } finally {
    Date.now = originalNow;
  }
});

test('dashboard guard readiness redacts registered secrets in cached API errors', async () => {
  const { bot, probes } = makeBot();
  const secretOne = 'guard-secret-one-6f82a19d';
  const secretTwo = 'guard-secret-two-4c91b72e';
  registerSensitiveValues([secretOne, secretTwo]);
  bot.executor.assertAtomicGuardReady = async () => {
    probes.guard++;
    throw new Error(`RPC rejected credential ${secretOne}; fallback token ${secretTwo}`);
  };

  const first = await bot.controlStatus();
  const cached = await bot.controlStatus();
  assert.equal(probes.guard, 1);
  for (const status of [first, cached]) {
    assert.equal(status.guard.runtimeReady, false);
    assert.ok(!JSON.stringify(status).includes(secretOne));
    assert.ok(!JSON.stringify(status).includes(secretTwo));
    assert.equal(status.guard.error.includes('[REDACTED]'), true);
  }
});

test('setting a specific pool clears target-required only for that wallet and keeps the idle guard', async () => {
  const setupTargetBot = () => {
    const { bot } = makeBot();
    bot.cycleActive = false;
    bot.getSelectedExecutionTargetPoolId = AutoLpBot.prototype.getSelectedExecutionTargetPoolId.bind(bot);
    bot.getInvestmentTargetSettings = AutoLpBot.prototype.getInvestmentTargetSettings.bind(bot);
    bot.applyStoredExecutionTarget = () => {};
    bot.getInvestmentTargetSnapshot = () => ({
      mode: bot.state.getSetting('investmentTargetMode', 'apr-highest'),
      poolId: bot.state.getSetting('investmentTargetPoolId', null)
    });
    bot.market.pools = [{ id: POOL_ID, state: { paused: false, liquidity: 1n },
      token0: { address: '0x0000000000000000000000000000000000000001', symbol: 'USDG' },
      token1: { address: '0x0000000000000000000000000000000000000002', symbol: 'CASHCAT' } }];
    bot.snapshot.pools = [{ id: POOL_ID, positions: [{ shares: '1' }] }];
    return bot;
  };
  const firstWallet = setupTargetBot();
  const secondWallet = setupTargetBot();

  assert.ok((await firstWallet.controlStatus()).startReadiness.blockers.includes('target-required'));
  firstWallet.setInvestmentTarget('specific-pool', POOL_ID);
  const firstStatus = await firstWallet.controlStatus();
  const secondStatus = await secondWallet.controlStatus();
  assert.equal(firstStatus.selectedExecutionTargetPoolId, POOL_ID);
  assert.ok(!firstStatus.startReadiness.blockers.includes('target-required'));
  assert.ok(secondStatus.startReadiness.blockers.includes('target-required'));
  assert.equal(secondWallet.getSelectedExecutionTargetPoolId(), '');

  firstWallet.cycleActive = true;
  assert.throws(() => firstWallet.setInvestmentTarget('specific-pool', POOL_ID), /current monitor cycle/);
});

test('startup restores a previously running bot only after its first successful scan', async () => {
  const { bot } = makeBot();
  let scans = 0;
  let starts = 0;
  bot.config.pollIntervalMs = 0;
  bot.running = false;
  bot.resumeExecutionAfterStartup = true;
  bot.initialize = async () => {};
  bot.schedulePointsSimulation = () => {};
  bot.runOnce = async () => { scans++; bot.running = false; };
  bot.startExecution = async (source) => {
    assert.equal(source, 'startup-restore');
    assert.equal(scans, 1);
    starts++;
    return { ok: true };
  };
  await bot.start();
  assert.equal(starts, 1);
  assert.equal(bot.resumeExecutionAfterStartup, false);
});

test('explicit dashboard pause cancels pending startup restore', () => {
  const { bot } = makeBot();
  bot.resumeExecutionAfterStartup = true;
  bot.setExecutionPaused(true, 'dashboard');
  assert.equal(bot.resumeExecutionAfterStartup, false);
});

test('explicit dashboard start cancels pending startup restore', () => {
  const { bot } = makeBot();
  bot.resumeExecutionAfterStartup = true;
  bot.setExecutionPaused(false, 'dashboard');
  assert.equal(bot.resumeExecutionAfterStartup, false);
  assert.equal(bot.executionPaused, false);
});
