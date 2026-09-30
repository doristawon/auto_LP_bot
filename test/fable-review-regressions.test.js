import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { RebalanceExecutor } from '../src/adapters/executor.js';
import { AutoLpBot } from '../src/bot.js';
import { journalTransactions } from '../src/execution/journal-transactions.js';
import { buildExactDepositPlan, getAmountsForLiquidity, getSqrtPriceAtTick } from '../src/math/v4-fixed.js';

const hash = '0x' + 'ab'.repeat(32);
const pool = { id: hash, token0: { address: '0x' + '11'.repeat(20) },
  token1: { address: '0x' + '22'.repeat(20) }, key: { hooks: '0x' + '33'.repeat(20) } };
const erc = new Interface(['function balanceOf(address) view returns(uint256)']);
const hook = new Interface(['function balanceOf(address,bytes32) view returns(uint256)']);
function harness() {
  const settings = new Map(), events = [];
  const e = Object.create(RebalanceExecutor.prototype);
  e.config = { walletAddress: '0x' + '44'.repeat(20) };
  e.state = { getSetting: (key, fallback) => settings.has(key) ? settings.get(key) : fallback,
    setSetting: (key, value) => settings.set(key, value) };
  e.ledger = { all: () => events, append: (type, data) => events.push({ type, ...data }) };
  e.writeProvider = { async call(tx) {
    return tx.to.toLowerCase() === pool.key.hooks ? hook.encodeFunctionResult('balanceOf', [30n])
      : erc.encodeFunctionResult('balanceOf', [tx.to.toLowerCase() === pool.token0.address ? 10n : 20n]);
  }, async getTransactionCount() { return 7; } };
  return { e, settings, events };
}

test('tight deposit remains within fixed caps across the entire permitted tick band', () => {
  for (const tick of [-99, -50, 0, 98, 99]) {
    const args = { rawAmount0: 10n ** 20n, rawAmount1: 10n ** 20n,
      sqrtPriceX96: getSqrtPriceAtTick(tick), tickLower: -100, tickUpper: 100,
      slippageBps: 50, tickToleranceTicks: -1 };
    const plan = buildExactDepositPlan(args);
    const tolerance = Math.max(3, Math.ceil(Math.min(tick + 100, 100 - tick) / 10));
    for (let t = tick - tolerance; t <= tick + tolerance + 1; t++) {
      const need = getAmountsForLiquidity(getSqrtPriceAtTick(t), getSqrtPriceAtTick(-100),
        getSqrtPriceAtTick(100), plan.liquidity, true);
      assert.ok(need.amount0 <= plan.amount0Max && need.amount1 <= plan.amount1Max, `tick ${tick} -> ${t}`);
    }
    assert.ok(plan.amount0Max <= args.rawAmount0 && plan.amount1Max <= args.rawAmount1);
    assert.deepEqual(buildExactDepositPlan({ ...args, tickToleranceTicks: 0 }),
      buildExactDepositPlan({ ...args, tickToleranceTicks: undefined }));
  }
});

for (const phase of ['withdraw_sent', 'swap_sent', 'deposit_sent']) {
  test(`confirmed ${phase} no-op requires matching receipt, balances, shares and nonce`, async () => {
    const { e, settings } = harness();
    const key = phase.split('_')[0], journal = { phase, tx: { [key]: hash } };
    const args = { pool, journal, phase, baseline: { raw0: '10', raw1: '20' },
      position: { id: hash, shares: '30' }, error: { code: 'TRANSACTION_REVERTED', message: 'reverted',
        receipt: { status: 0, hash, blockNumber: 100 } } };
    assert.equal(await e.reconcileConfirmedNoOp({ ...args, baseline: { raw0: '11', raw1: '20' } }), false);
    assert.equal(await e.reconcileConfirmedNoOp({ ...args, position: { id: hash, shares: '31' } }), false);
    assert.equal(await e.reconcileConfirmedNoOp({ ...args, error: { ...args.error, code: 'BROADCAST_OUTCOME_UNCERTAIN' } }), false);
    assert.equal(await e.reconcileConfirmedNoOp({ ...args, journal: { ...journal, tx: { ...journal.tx, routeSwaps: [hash] } } }), false);
    e.writeProvider.getTransactionCount = async (_, tag) => tag === 'latest' ? 7 : 8;
    assert.equal(await e.reconcileConfirmedNoOp(args), false);
    e.writeProvider.getTransactionCount = async () => 7;
    assert.equal(await e.reconcileConfirmedNoOp(args), true);
    assert.equal(settings.get('activeRebalanceExecution').phase, 'failed');
    assert.equal(await e.reconcileConfirmedNoOp(args), true);
    assert.equal(await e.reconcileConfirmedNoOp(args), false, 'bounded retries');
  });
}

test('startup only clears provably unsent journals and never ambiguous broadcasts', async () => {
  const { e, settings, events } = harness();
  const journal = { phase: 'prepared', startedAt: Date.now() - 1000, tx: {} };
  for (const unsafe of [{ ...journal, startedAt: undefined }, { ...journal, tx: { swap: hash } },
    { ...journal, pendingTx: { hash } }, { ...journal, phase: 'recovery_required' }]) {
    settings.set('activeRebalanceExecution', unsafe);
    assert.equal(await e.reconcileStartupJournal(), false);
  }
  settings.set('activeRebalanceExecution', journal);
  events.push({ type: 'tx.broadcast_pending', hash, ts: Date.now() });
  assert.equal(await e.reconcileStartupJournal(), false);
  events.push({ type: 'tx.reverted', hash, ts: Date.now() });
  assert.equal(await e.reconcileStartupJournal(), true);
});

test('allocation failures back off and pause only when recovery is required', async () => {
  const { e, settings } = harness();
  const bot = Object.create(AutoLpBot.prototype);
  bot.state = e.state; bot.ledger = e.ledger; bot.config = {};
  bot.setExecutionPaused = (value) => { bot.executionPaused = value; };
  settings.set('activeRebalanceExecution', { phase: 'recovery_required' });
  const result = await bot.runAllocationJob(pool, 'bootstrap', async () => { throw new Error('failed'); });
  assert.equal(result.status, 'failed'); assert.equal(bot.executionPaused, true);
  assert.equal((await bot.runAllocationJob(pool, 'bootstrap', async () => { throw new Error('must not run'); })).status, 'deferred');
});

test('recovery flattens route swaps and validates every hash', () => {
  assert.deepEqual(journalTransactions({ tx: { withdraw: hash, routeSwaps: [hash], swap: null } }),
    [{ phase: 'withdraw', hash }, { phase: 'routeSwaps:0', hash }]);
  assert.throws(() => journalTransactions({ tx: { routeSwaps: ['bad'] } }), /invalid/);
});
