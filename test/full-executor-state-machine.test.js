import test from 'node:test';
import assert from 'node:assert/strict';
import { id, zeroPadValue } from 'ethers';
import { RebalanceExecutor } from '../src/adapters/executor.js';
import { V4QuoterAdapter } from '../src/adapters/quoter.js';
import { DEPOSITED_EVENT } from '../src/abi.js';
import { buildExactDepositPlan, getSqrtPriceAtTick } from '../src/math/v4-fixed.js';

const wallet = '0x0000000000000000000000000000000000000001';
const hook = '0x08E52564Bad99E05a694b4809F397edcA417A080';
const pool = {
  id: '0x' + 'ab'.repeat(32),
  key: {
    currency0: '0x0000000000000000000000000000000000000011',
    currency1: '0x0000000000000000000000000000000000000022',
    fee: 8388608,
    tickSpacing: 10,
    hooks: hook
  },
  token0: { address: '0x0000000000000000000000000000000000000011', symbol: 'T0', decimals: 18 },
  token1: { address: '0x0000000000000000000000000000000000000022', symbol: 'T1', decimals: 18 },
  state: { tick: 1100, sqrtPriceX96: getSqrtPriceAtTick(1100), paused: false, liquidity: 1n }
};
const position = {
  id: '0x' + '11'.repeat(32),
  tickLower: 900,
  tickUpper: 1000,
  shares: 1_000_000_000_000_000_000n,
  outside: true,
  shouldRebalance: true,
  rebalanceReason: 'oor_delay_confirmed'
};

function createHarness({ failSwap = false, failPreflight = false, failWithdraw = false } = {}) {
  const events = [];
  const settings = new Map();
  const balances = [
    { raw0: 10_000_000_000_000_000_000n, raw1: 10_000_000_000_000_000_000n },
    { raw0: 110_000_000_000_000_000_000n, raw1: 10_000_000_000_000_000_000n }
  ];
  let balanceIndex = 0;
  let postSwapBalance = null;
  let lastSwapQuote = null;
  let depositedLiquidity = null;
  const state = {
    getSetting(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; },
    setSetting(key, value) { settings.set(key, value); }
  };
  const fables = {
    async readPoolState() { return { tick: 1100, sqrtPriceX96: getSqrtPriceAtTick(1100), paused: false, liquidity: 1n }; },
    async readRangeKey() {
      return {
        exists: true,
        key: pool.key,
        tickLower: 980,
        tickUpper: 1220
      };
    },
    encodeDeposit(_pool, _range, liquidity) {
      depositedLiquidity = liquidity;
      return '0xdeadbeef';
    }
  };
  const executor = new RebalanceExecutor(
    null,
    null,
    {
      dryRun: false,
      enableLiveWrites: true,
      enableAutoRedeploy: true,
      walletAddress: wallet,
      withdrawSlippageBps: 50,
      swapSlippageBps: 50,
      depositSlippageBps: 50,
      depositLiquidityReserveBps: 10,
      depositTickTolerance: 0,
      autoTopupDustBps: 25,
      usdgAddress: pool.token1.address,
      tightWidthBps: 120,
      txDeadlineSec: 1200,
      fablesWalk: 1000,
      allowZeroMinOut: false,
      confirmations: 1,
      oorShallowThresholdPct: 0.5
    },
    fables,
    { append(type, data) { events.push({ type, data }); } },
    () => 0,
    state
  );

  executor.assertLiveReady = async () => {};
  executor.assertNoUnfinishedExecution = () => {};
  executor.assertPlanStillOutOfRange = async (plan) => {
    plan.pool.state = { tick: 1100, sqrtPriceX96: getSqrtPriceAtTick(1100), paused: false, liquidity: 1n };
    return plan.pool.state;
  };
  executor.readRawPairBalances = async () => {
    if (balanceIndex < balances.length) return balances[balanceIndex++];
    return postSwapBalance || balances.at(-1);
  };
  executor.readPositionShares = async (_pool, rangeId) => rangeId === position.id ? 0n : 5_000_000_000_000_000n;
  executor.ensureSwapAllowances = async () => {};
  executor.ensureHookAllowance = async () => {};
  executor.assertExactHookAllowance = async () => {};
  executor.getPinnedFeeOverrides = async () => ({ gasPrice: 1n });
  executor.assertTopUpGasBudget = async () => {};
  executor.preflightSamePoolSequence = async () => {
    if (failPreflight) throw new Error('mock full-sequence preflight failure');
    return { status: 'full-sequence-simulated', callCount: 4, simulatedGasUsed: '1000000' };
  };
  executor.quoter = Object.assign(new V4QuoterAdapter(null), {
    async quoteExactInputSingleRaw(_pool, tokenIn, rawAmountIn, slippageBps) {
      rawAmountIn = BigInt(rawAmountIn);
      const sqrt = getSqrtPriceAtTick(1100);
      const q192 = 1n << 192n;
      const rawAmountOut = tokenIn === 0
        ? rawAmountIn * sqrt * sqrt / q192
        : rawAmountIn * q192 / (sqrt * sqrt);
      return {
        rawAmountIn: rawAmountIn.toString(),
        rawAmountOut: rawAmountOut.toString(),
        minRawAmountOut: (rawAmountOut * BigInt(10000 - slippageBps) / 10000n).toString(),
        tokenIn: tokenIn === 0 ? pool.token0.address : pool.token1.address,
        tokenOut: tokenIn === 0 ? pool.token1.address : pool.token0.address,
        zeroForOne: tokenIn === 0
      };
    }
  });
  executor.router = {
    buildV4ExactInputSingle({ quote, deadline }) {
      lastSwapQuote = quote;
      return { router: '0x0000000000000000000000000000000000000099', data: '0x1234', value: 0n, quote, deadline };
    },
    async simulateV4ExactInputSingle() { return '0x'; }
  };
  let sent = 0;
  executor.sendVerifiedTx = async ({ label, onSent }) => {
    sent++;
    const hash = '0x' + sent.toString(16).padStart(64, '0');
    if (onSent) onSent(hash);
    if (failWithdraw && label === 'guardedWithdrawAndClaim') {
      const error = new Error('confirmed withdraw revert');
      error.code = 'TRANSACTION_REVERTED'; error.receipt = { hash, status: 0, blockNumber: 100 };
      throw error;
    }
    if (failSwap && label === 'v4SwapExactInputSingle') throw new Error('mock swap failure');
    if (label === 'v4SwapExactInputSingle') {
      const before = balances.at(-1);
      const input = BigInt(lastSwapQuote.rawAmountIn);
      const output = BigInt(lastSwapQuote.rawAmountOut);
      postSwapBalance = lastSwapQuote.zeroForOne
        ? { raw0: before.raw0 - input, raw1: before.raw1 + output }
        : { raw0: before.raw0 + output, raw1: before.raw1 - input };
    }
    return {
      hash,
      status: 1,
      logs: label === 'fablesDeposit' ? [{
        address: hook,
        topics: [
          id(DEPOSITED_EVENT),
          zeroPadValue(wallet, 32),
          '0x' + '22'.repeat(32)
        ],
        data: '0x' + (5_000_000_000_000_000n).toString(16).padStart(64, '0')
      }] : []
    };
  };
  executor.findWalletDepositEvent = (_pool, receipt) => {
    if (!receipt.logs?.length) return null;
    return { rangeId: '0x' + '22'.repeat(32), liquidity: 5_000_000_000_000_000n };
  };
  return {
    executor, events, settings, sentCount: () => sent,
    depositedLiquidity: () => depositedLiquidity,
    postSwapBalance: () => postSwapBalance
  };
}

test('confirmed first-capital revert reaches reconciliation instead of freezing an unchanged wallet', async () => {
  const { executor, settings, sentCount } = createHarness({ failWithdraw: true });
  let checked = false;
  executor.reconcileConfirmedNoOp = async ({ phase, baseline, error, journal }) => {
    checked = true;
    assert.equal(phase, 'withdraw_sent'); assert.equal(error.receipt.status, 0);
    assert.equal(baseline.raw0, '10000000000000000000');
    executor.patchJournal(journal, { phase: 'failed' });
    return true;
  };
  const result = await executor.execute({ pool: structuredClone(pool), position: { ...position }, currentTick: 1100 });
  assert.equal(result.status, 'deferred'); assert.equal(checked, true);
  assert.equal(sentCount(), 1); assert.equal(settings.get('activeRebalanceExecution').phase, 'failed');
});

test('full executor advances only after receipts and completes with new LP shares', async () => {
  const { executor, events, settings, sentCount, depositedLiquidity, postSwapBalance } = createHarness();
  const result = await executor.execute({ pool: structuredClone(pool), position: { ...position }, currentTick: 1100 });
  assert.equal(result.status, 'completed');
  assert.ok(result.withdrawHash);
  assert.ok(result.swapHash);
  assert.ok(result.depositHash);
  assert.equal(settings.get('activeRebalanceExecution'), null);
  assert.ok(events.some((x) => x.type === 'rebalance.completed'));
  const completed = events.find((x) => x.type === 'rebalance.completed').data;
  assert.deepEqual(completed.initialWalletFundingRaw, {
    raw0: '10000000000000000000', raw1: '10000000000000000000'
  });
  assert.deepEqual(completed.dustRetainedRaw, { raw0: '0', raw1: '25000000000000000' });
  assert.deepEqual(completed.combinedFundingRaw, {
    raw0: '110000000000000000000', raw1: '9975000000000000000'
  });
  assert.equal(sentCount(), 3); // withdraw, swap, one LP deposit
  const oldWithdrawalOnlyInventory = {
    raw0: postSwapBalance().raw0 - 10_000_000_000_000_000_000n,
    raw1: postSwapBalance().raw1 - 10_000_000_000_000_000_000n
  };
  const oldDeposit = buildExactDepositPlan({
    rawAmount0: oldWithdrawalOnlyInventory.raw0,
    rawAmount1: oldWithdrawalOnlyInventory.raw1,
    sqrtPriceX96: getSqrtPriceAtTick(1100),
    tickLower: 980, tickUpper: 1220,
    slippageBps: 50, liquidityReserveBps: 10
  });
  assert.ok(depositedLiquidity() > oldDeposit.liquidity);
});

test('post-withdraw swap failure records recovery_required and leaves execution locked', async () => {
  const { executor, events, settings } = createHarness({ failSwap: true });
  await assert.rejects(
    executor.execute({ pool: structuredClone(pool), position: { ...position }, currentTick: 1100 }),
    /mock swap failure/
  );
  const journal = settings.get('activeRebalanceExecution');
  assert.equal(journal.phase, 'recovery_required');
  assert.ok(journal.tx.withdraw);
  assert.ok(events.some((x) => x.type === 'rebalance.recovery_required'));
});

test('failed full-sequence preflight leaves principal in the original LP', async () => {
  const { executor, events, settings, sentCount } = createHarness({ failPreflight: true });
  await assert.rejects(
    executor.execute({ pool: structuredClone(pool), position: { ...position }, currentTick: 1100 }),
    /mock full-sequence preflight failure/
  );
  assert.equal(sentCount(), 0);
  assert.equal(settings.get('activeRebalanceExecution').phase, 'failed');
  assert.equal(events.some((x) => x.type === 'rebalance.recovery_required'), false);
});
