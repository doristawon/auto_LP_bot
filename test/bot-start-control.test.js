import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoLpBot } from '../src/bot.js';

const POOL_ID = '0x' + '11'.repeat(32);
const WALLET = '0x00000000000000000000000000000000000000aa';

function makeBot() {
  const settings = new Map();
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
  bot.executor = { async assertAtomicGuardReady() {} };
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
  bot.executionPaused = true;
  bot.cycleActive = true;
  bot.getSelectedExecutionTargetPoolId = () => POOL_ID;
  bot.getInvestmentTargetSettings = () => ({ mode: 'apr-highest' });
  bot.getInvestmentTargetSnapshot = () => ({ mode: 'apr-highest', poolId: POOL_ID });
  bot.getRuntimeIntervals = () => ({});
  return { bot, settings };
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
