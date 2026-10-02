import test from 'node:test';
import assert from 'node:assert/strict';
import { describeExecutionProgress } from '../src/dashboard/execution-progress.js';
import { AutoLpBot } from '../src/bot.js';
import { RebalanceExecutor } from '../src/adapters/executor.js';
import { DashboardServer } from '../src/dashboard/server.js';
import { registerSensitiveValues } from '../src/logger.js';

const hash = digit => '0x' + digit.repeat(64);
const journal = phase => ({ id: 'synthetic-job', phase, startedAt: 1000,
  updatedAt: 2000, pair: 'TOKEN/USDG', oldPosition: { id: 'range' },
  tx: { withdraw: hash('1'), swap: hash('2'), deposit: hash('3') } });

test('stepper follows receipt phases rather than a guessed completion percentage', () => {
  const pending = describeExecutionProgress({ ...journal('withdraw_sent'), tx: { withdraw: hash('1') } });
  assert.deepEqual(pending.steps.map(item => item.status), ['completed', 'active', 'pending', 'pending', 'pending']);
  assert.equal(pending.transactions[0].status, 'pending');
  const swapping = describeExecutionProgress({ ...journal('swap_sent'), tx: { withdraw: hash('1'), swap: hash('2') } });
  assert.equal(swapping.transactions[0].status, 'confirmed');
  assert.equal(swapping.transactions[1].status, 'pending');
  assert.equal(swapping.currentStepLabel, '換幣');
  const deposited = describeExecutionProgress(journal('deposit_confirmed'));
  assert.deepEqual(deposited.steps.map(item => item.status), ['completed', 'completed', 'completed', 'completed', 'active']);
  assert.ok(deposited.transactions.every(item => item.status === 'confirmed'));
  assert.equal(Object.hasOwn(deposited, 'percent'), false);
});

test('topup skips withdrawal; deposit-only also skips swap without hiding the flow', () => {
  const progress = describeExecutionProgress({ ...journal('deposit_preflighted'), kind: 'liquidity_top_up',
    swapPolicy: 'deposit-only', tx: {} });
  assert.equal(progress.label, '餘額加倉');
  assert.equal(progress.steps[1].status, 'skipped');
  assert.equal(progress.steps[2].status, 'skipped');
  assert.equal(progress.steps[3].status, 'active');
});

test('uncertain broadcasts and recovery never claim that the active transaction is confirmed', () => {
  const pendingTx = { hash: hash('2'), label: 'v4SwapExactInputSingle', previousPhase: 'swap_preflighted' };
  const progress = describeExecutionProgress({ ...journal('recovery_required'), lastKnownPhase: 'swap_sent',
    tx: { withdraw: hash('1') }, pendingTx });
  assert.equal(progress.status, 'recovery');
  assert.equal(progress.steps[2].status, 'attention');
  assert.equal(progress.lastTransaction.hash, hash('2'));
  assert.equal(progress.lastTransaction.status, 'unknown');
  assert.equal(progress.transactions[0].status, 'confirmed');
  const failed = describeExecutionProgress({ ...journal('failed'), lastKnownPhase: 'deposit_sent' });
  assert.equal(failed.steps[3].status, 'failed');
  assert.equal(failed.transactions.find(item => item.step === 'deposit').status, 'unknown');
});

test('presentation excludes calldata and secrets, validates hashes, and handles unknown phases', () => {
  registerSensitiveValues(['synthetic-progress-secret']);
  const progress = describeExecutionProgress({ ...journal('new-phase'), error: 'synthetic-progress-secret',
    privateKey: 'synthetic-progress-secret', pendingTx: { data: 'secret-calldata', hash: 'invalid' } });
  const json = JSON.stringify(progress);
  assert.equal(json.includes('synthetic-progress-secret'), false);
  assert.equal(json.includes('secret-calldata'), false);
  assert.equal(json.includes('privateKey'), false);
  assert.equal(progress.stepIndex, 0);
  assert.equal(describeExecutionProgress(null), null);
});

test('completed summary persists after the active execution journal is cleared', () => {
  const settings = new Map(), executor = Object.create(RebalanceExecutor.prototype);
  executor.state = { setSetting: (key, value) => settings.set(key, value),
    getSetting: (key, fallback) => settings.get(key) ?? fallback };
  const current = executor.patchJournal(journal('deposit_sent'), { phase: 'deposit_confirmed' });
  const done = executor.patchJournal(current, { phase: 'completed', completedAt: 3000 });
  executor.clearJournal();
  assert.equal(settings.get('activeRebalanceExecution'), null);
  assert.equal(settings.get('lastExecutionProgress').status, 'completed');
  assert.equal(settings.get('lastExecutionProgress').finishedAt, 3000);
  assert.equal(done.lastKnownPhase, 'deposit_confirmed');
});

test('a reconciled failed receipt is marked reverted; route swaps retain their own confirmation state', () => {
  const reverted = describeExecutionProgress({ ...journal('failed'), lastKnownPhase: 'withdraw_sent',
    tx: { withdraw: hash('1') }, reconciliation: { hash: hash('1'), status: 0 } });
  assert.equal(reverted.lastTransaction.status, 'reverted');
  const routes = describeExecutionProgress({ ...journal('route_swap_sent'),
    destinationPoolId: 'new-pool', tx: { withdraw: hash('1'), routeSwaps: [hash('2'), hash('3')] } });
  assert.equal(routes.label, '換倉');
  assert.deepEqual(routes.transactions.map(tx => tx.status), ['confirmed', 'confirmed', 'pending']);
});

test('atomic swap and deposit phases expose one combined transaction and never a second pending hash', () => {
  const atomicHash = hash('4');
  const preflight = describeExecutionProgress({ ...journal('atomic_preflighted'),
    atomicSwapRequired: true, tx: { withdraw: hash('1') } });
  assert.equal(preflight.currentStepLabel, '換幣');
  assert.equal(preflight.steps[2].status, 'active');
  assert.equal(preflight.steps[3].status, 'pending');
  assert.equal(preflight.steps[2].status === 'skipped', false);

  const sent = describeExecutionProgress({ ...journal('atomic_sent'), atomicSwapRequired: true,
    tx: { withdraw: hash('1'), atomicSwapDeposit: atomicHash } });
  const atomicTransactions = sent.transactions.filter(item => item.hash === atomicHash);
  assert.equal(atomicTransactions.length, 1);
  assert.equal(atomicTransactions[0].label, '換幣＋一次存入 LP');
  assert.equal(atomicTransactions[0].status, 'pending');
  assert.equal(sent.transactions.some(item => item.hash === hash('3')), false);

  const confirmed = describeExecutionProgress({ ...journal('atomic_confirmed'), atomicSwapRequired: true,
    tx: { atomicSwapDeposit: atomicHash } });
  assert.equal(confirmed.currentStepLabel, '核對');
  assert.equal(confirmed.transactions[0].status, 'confirmed');
});

test('atomic retry lists confirmed reverts and keeps swap visible when swapping is required', () => {
  const revertedHash = hash('5');
  const progress = describeExecutionProgress({ ...journal('atomic_retry'), atomicSwapRequired: true,
    tx: { atomicSwapDeposit: null, atomicReverts: [revertedHash] } });
  assert.equal(progress.currentStepLabel, '換幣');
  assert.equal(progress.steps[2].status, 'active');
  assert.equal(progress.transactions.length, 1);
  assert.equal(progress.transactions[0].hash, revertedHash);
  assert.equal(progress.transactions[0].status, 'reverted');
});

test('atomic deposit-only mode labels its single receipt without showing swap as pending', () => {
  const progress = describeExecutionProgress({ ...journal('atomic_sent'), atomicSwapRequired: false,
    tx: { atomicSwapDeposit: hash('6') } });
  assert.equal(progress.currentStepLabel, '存入 LP');
  assert.equal(progress.steps[2].status, 'skipped');
  assert.equal(progress.transactions.length, 1);
  assert.equal(progress.transactions[0].label, '一次存入 LP');
});

test('official reposition progress deduplicates its one hash and keeps uncertain sends unknown', () => {
  const officialHash = hash('7');
  const sent = describeExecutionProgress({ ...journal('official_sent'),
    tx: { officialReposition: officialHash }, pendingTx: { hash: officialHash,
      label: 'guardedRepositionAndClaim', previousPhase: 'official_preflighted' } });
  assert.equal(sent.label, '再平衡');
  assert.deepEqual(sent.steps.map(item => item.key), ['preflight', 'officialReposition', 'verify']);
  assert.equal(sent.steps[1].label, '領取手續費＋官方一次再平衡');
  assert.equal(sent.transactions.length, 1);
  assert.equal(sent.transactions[0].hash, officialHash);
  assert.equal(sent.transactions[0].status, 'pending');

  const uncertain = describeExecutionProgress({ ...journal('recovery_required'),
    lastKnownPhase: 'official_sent', tx: { officialReposition: officialHash } });
  assert.equal(uncertain.status, 'recovery');
  assert.equal(uncertain.transactions.length, 1);
  assert.equal(uncertain.transactions[0].status, 'unknown');
  assert.notEqual(uncertain.status, 'completed');

  const confirmed = describeExecutionProgress({ ...journal('official_confirmed'),
    tx: { officialReposition: officialHash } });
  assert.equal(confirmed.transactions.length, 1);
  assert.equal(confirmed.transactions[0].status, 'confirmed');
  assert.equal(confirmed.steps[2].status, 'active');
});

function botFixture(active = null) {
  const settings = new Map([['activeRebalanceExecution', active]]);
  const bot = Object.create(AutoLpBot.prototype);
  bot.config = { walletAddress: '0x0000000000000000000000000000000000000011', pollIntervalMs: 300000,
    rangeCheckIntervalMs: 300000, oorConfirmDelayMin: 15, rpcRequestTimeoutMs: 30000 };
  bot.state = { getSetting: (key, fallback) => settings.get(key) ?? fallback };
  bot.snapshot = { generatedAt: Date.now(), portfolio: { positions: [
    { poolId: 'pool', id: 'range', shares: '1', outside: false, pair: 'TOKEN/USDG' }
  ] } };
  bot.getSelectedExecutionTargetPoolId = () => 'pool';
  bot.nextMonitorAt = Date.now() + 200000;
  bot.executionPaused = false; bot.cycleActive = false;
  bot.controlStatus = () => { throw new Error('Full status must not be called by the progress feed'); };
  bot.providers = new Proxy({}, { get() { throw new Error('Progress feed must not touch RPC'); } });
  bot.getUiGuardReadiness = () => { throw new Error('Progress feed must not probe the guard'); };
  return bot;
}

test('lightweight status derives timing and progress without RPC or guard probes', () => {
  const bot = botFixture();
  const status = bot.getExecutionStatus();
  assert.equal(status.rebalanceTiming.phase, 'in-range');
  assert.equal(status.rebalanceTiming.targetAt, bot.nextMonitorAt);
  assert.equal(status.executionProgress, null);
  assert.equal(Object.hasOwn(status, 'activeRebalanceExecution'), false);
});

test('lightweight HTTP status is wallet scoped and continues while the wallet is executing', async () => {
  const primary = botFixture(), worker = botFixture(journal('swap_sent'));
  worker.cycleActive = true;
  let requested = null;
  const fleet = { getBot(address) { requested = address; return worker; } };
  const server = new DashboardServer({ dashboardEnabled: true, dashboardHost: '127.0.0.1', dashboardPort: 0 },
    primary, {}, {}, fleet);
  await server.start();
  try {
    const response = await fetch('http://127.0.0.1:' + server.server.address().port + '/api/execution/status',
      { headers: { 'X-Wallet-Address': 'selected-worker' } });
    const body = await response.json();
    assert.equal(response.status, 200); assert.equal(requested, 'selected-worker');
    assert.equal(body.executionBusy, true); assert.equal(body.rebalanceTiming.phase, 'executing');
    assert.equal(body.executionProgress.currentStepLabel, '換幣');
  } finally { await server.stop(); }
});
