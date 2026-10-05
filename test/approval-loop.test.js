import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256 } from 'ethers';
import { ERC20_ABI, PERMIT2_ABI } from '../src/abi.js';
import { PERMIT2, UNISWAP_UNIVERSAL_ROUTER_212 } from '../src/constants.js';
import { RebalanceExecutor } from '../src/adapters/executor.js';
import { executeAtomicDeposit } from '../src/execution/atomic-deposit.js';
import { buildExactBalancedSwapPlan } from '../src/execution/exact-rebalance.js';
import { getLiquidityForAmount0, getLiquidityForAmount1, getSqrtPriceAtTick, MAX_UINT128 }
  from '../src/math/v4-fixed.js';

const WALLET = '0x9999999999999999999999999999999999999999';
const TOKEN0 = '0x1111111111111111111111111111111111111111';
const TOKEN1 = '0x2222222222222222222222222222222222222222';
const HOOK = '0x3333333333333333333333333333333333333333';
const POOL_ID = '0x' + '44'.repeat(32);
const token0 = { address: TOKEN0, symbol: 'T0', decimals: 18 };
const token1 = { address: TOKEN1, symbol: 'T1', decimals: 18 };
const pool = {
  id: POOL_ID,
  key: { currency0: TOKEN0, currency1: TOKEN1, fee: 3000, tickSpacing: 10, hooks: HOOK },
  token0,
  token1
};
const erc20 = new Interface(ERC20_ABI);
const permit2 = new Interface(PERMIT2_ABI);

function allowanceKey(...parts) {
  return parts.map(part => String(part).toLowerCase()).join(':');
}

function makeAllowanceHarness() {
  const tokenAllowances = new Map();
  const permitAllowances = new Map();
  const sent = [];
  const reads = [];
  const settings = new Map([['executionPaused', false]]);

  const readProvider = {
    async call(request) {
      reads.push(request);
      const to = String(request.to).toLowerCase();
      if (to === PERMIT2.toLowerCase()) {
        const parsed = permit2.parseTransaction({ data: request.data });
        if (parsed?.name !== 'allowance') throw new Error('Unexpected Permit2 read');
        const [owner, tokenAddress, spender] = parsed.args;
        const current = permitAllowances.get(allowanceKey(owner, tokenAddress, spender))
          || { amount: 0n, expiration: 0n, nonce: 0n };
        return permit2.encodeFunctionResult('allowance', [
          current.amount, current.expiration, current.nonce
        ]);
      }

      const parsed = erc20.parseTransaction({ data: request.data });
      if (parsed?.name !== 'allowance') throw new Error('Unexpected ERC20 read');
      const [owner, spender] = parsed.args;
      return erc20.encodeFunctionResult('allowance', [
        tokenAllowances.get(allowanceKey(to, owner, spender)) || 0n
      ]);
    }
  };

  const executor = Object.create(RebalanceExecutor.prototype);
  executor.config = {
    walletAddress: WALLET,
    txDeadlineSec: 300,
    permit2ExpirationSec: 3600
  };
  executor.readProvider = readProvider;
  executor.sendVerifiedTx = async request => {
    sent.push(request);
    const to = String(request.to).toLowerCase();
    if (to === PERMIT2.toLowerCase()) {
      const parsed = permit2.parseTransaction({ data: request.data });
      if (parsed?.name !== 'approve') throw new Error('Unexpected Permit2 write');
      const [tokenAddress, spender, amount, expiration] = parsed.args;
      permitAllowances.set(allowanceKey(WALLET, tokenAddress, spender), {
        amount: BigInt(amount), expiration: BigInt(expiration), nonce: 0n
      });
      return;
    }

    const parsed = erc20.parseTransaction({ data: request.data });
    if (parsed?.name !== 'approve') throw new Error('Unexpected ERC20 write');
    const [spender, amount] = parsed.args;
    tokenAllowances.set(allowanceKey(to, WALLET, spender), BigInt(amount));
  };
  executor.state = {
    getSetting(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; },
    setSetting(key, value) { settings.set(key, value); }
  };

  return { executor, sent, reads, settings, tokenAllowances, permitAllowances };
}

function makePreflightHarness() {
  const events = [];
  const settings = new Map();
  const calls = { simulations: 0, estimates: 0, populates: 0, signs: 0, chainIds: 0, broadcasts: [] };
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.config = {
    chainId: 8453,
    maxGasGwei: 100,
    walletAddress: WALLET,
    confirmations: 1
  };
  executor.state = {
    getSetting(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; },
    setSetting(key, value) { settings.set(key, value); }
  };
  executor.ledger = { append(type, data) { events.push({ type, data }); } };
  executor.readProvider = {
    async call() { calls.simulations++; return '0x'; }
  };
  executor.writeProvider = {
    async getFeeData() {
      return { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
    },
    async getBlock() { return { baseFeePerGas: 900_000_000n }; },
    async send(method) {
      assert.equal(method, 'eth_chainId');
      calls.chainIds++;
      return '0x2105';
    },
    async broadcastTransaction(raw) {
      calls.broadcasts.push(raw);
      return { hash: keccak256(raw), async wait() {
        return { status: 1, blockNumber: 1, gasUsed: 21_000n, gasPrice: 1_000_000_000n };
      } };
    }
  };
  executor.signer = {
    async estimateGas() { calls.estimates++; return 21_000n; },
    async populateTransaction(request) { calls.populates++; return { ...request, nonce: 3 }; },
    async signTransaction() { calls.signs++; return '0x1234'; }
  };
  executor.getUsdPrice = () => 0;
  return { executor, calls, events };
}

test('a finite funding cap is reused across smaller swap refits', async () => {
  const h = makeAllowanceHarness();

  await h.executor.ensureSwapAllowances(token0, 60n, { allowanceCap: 100n });
  await h.executor.ensureSwapAllowances(token0, 50n, { allowanceCap: 100n });
  await h.executor.ensureSwapAllowances(token0, 35n, { allowanceCap: 100n });

  assert.deepEqual(h.sent.map(request => request.label), [
    'approve:T0:permit2',
    'permit2:T0:router'
  ]);
  const erc20Approval = erc20.parseTransaction({ data: h.sent[0].data });
  const permit2Approval = permit2.parseTransaction({ data: h.sent[1].data });
  assert.equal(BigInt(erc20Approval.args[1]), 100n);
  assert.equal(BigInt(permit2Approval.args[2]), 100n);
  assert.ok(BigInt(permit2Approval.args[2]) <= MAX_UINT128);
});

test('a pre-withdrawal allowance within its saved gross cap is reused for smaller net funding', async () => {
  const h = makeAllowanceHarness();
  const expiration = Math.floor(Date.now() / 1000) + 3600;
  h.tokenAllowances.set(allowanceKey(TOKEN0, WALLET, PERMIT2), 100n);
  h.permitAllowances.set(allowanceKey(WALLET, TOKEN0, UNISWAP_UNIVERSAL_ROUTER_212), {
    amount: 100n, expiration, nonce: 0n
  });

  const result = await h.executor.ensureSwapAllowances(token0, 50n, {
    allowanceCap: 80n,
    reuseAllowanceCap: 100n
  });

  assert.deepEqual(result, { broadcasted: false, broadcastCount: 0, reused: true });
  assert.equal(h.sent.length, 0);
});

test('swap input and authorization cap must stay within the finite funding envelope', async () => {
  const h = makeAllowanceHarness();

  await assert.rejects(
    h.executor.ensureSwapAllowances(token0, 101n, { allowanceCap: 100n }),
    /finite authorization cap/
  );
  await assert.rejects(
    h.executor.ensureSwapAllowances(token0, 1n, { allowanceCap: MAX_UINT128 + 1n }),
    /finite authorization cap/
  );
  assert.equal(h.sent.length, 0);
  assert.equal(h.reads.length, 0);
});

test('top-up preview requests use the finite cap and reject a swap above it', async () => {
  const h = makeAllowanceHarness();
  const zeroDeposit = { amount0Max: 0n, amount1Max: 0n };
  const approvals = await h.executor.buildTopUpApprovalRequests(
    pool,
    { direction: 'zeroForOne', tokenIn: 0, rawAmountIn: 60n },
    zeroDeposit,
    { swapAllowanceCaps: { raw0: 100n, raw1: 80n } }
  );

  assert.deepEqual(approvals.map(request => request.label), [
    'approve:T0:permit2',
    'permit2:T0:router'
  ]);
  const erc20Approval = erc20.parseTransaction({ data: approvals[0].tx.data });
  const permit2Approval = permit2.parseTransaction({ data: approvals[1].tx.data });
  assert.equal(BigInt(erc20Approval.args[1]), 100n);
  assert.equal(BigInt(permit2Approval.args[2]), 100n);

  await assert.rejects(
    h.executor.buildTopUpApprovalRequests(
      pool,
      { direction: 'zeroForOne', tokenIn: 0, rawAmountIn: 101n },
      zeroDeposit,
      { swapAllowanceCaps: { raw0: 100n, raw1: 80n } }
    ),
    /finite authorization cap/
  );
});

test('pause at an approval before-broadcast gate prevents the approval write', async () => {
  const h = makeAllowanceHarness();
  let broadcasts = 0;
  h.executor.sendVerifiedTx = async request => {
    h.sent.push(request);
    h.settings.set('executionPaused', true);
    request.beforeBroadcast();
    broadcasts++;
  };

  await assert.rejects(
    h.executor.ensureSwapAllowances(token0, 40n, { allowanceCap: 100n }),
    /Execution is paused before swap approval/
  );
  assert.equal(h.sent.length, 1);
  assert.equal(typeof h.sent[0].beforeBroadcast, 'function');
  assert.equal(broadcasts, 0);
});

test('opaque transaction preflight proofs reject forgery, request changes, replay, and expiry', async () => {
  const fees = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
  const request = { to: TOKEN0, data: '0x1234', value: 0n, feeOverrides: fees };
  const invalidProof = error => error.code === 'INVALID_PREFLIGHT' && error.preBroadcastFailure === true;

  {
    const h = makePreflightHarness();
    const proof = await h.executor.preflightVerifiedTx(request);
    await assert.rejects(h.executor.sendVerifiedTx({ label: 'forged-proof', ...request,
      preflight: Object.freeze({ ...proof }) }), invalidProof);
    assert.equal(h.calls.populates, 0);
    assert.equal(h.calls.signs, 0);
    assert.equal(h.calls.broadcasts.length, 0);
    assert.equal(h.events.length, 0);
  }

  {
    const h = makePreflightHarness();
    const proof = await h.executor.preflightVerifiedTx(request);
    await assert.rejects(h.executor.sendVerifiedTx({ label: 'changed-request', ...request,
      data: '0x5678', preflight: proof }), invalidProof);
    // A mismatched attempt consumes the one-shot proof too.
    await assert.rejects(h.executor.sendVerifiedTx({ label: 'replayed-proof', ...request,
      preflight: proof }), invalidProof);
    assert.equal(h.calls.populates, 0);
    assert.equal(h.calls.broadcasts.length, 0);
    assert.equal(h.events.length, 0);
  }

  {
    const h = makePreflightHarness();
    const proof = await h.executor.preflightVerifiedTx(request);
    await h.executor.sendVerifiedTx({ label: 'valid-proof', ...request, preflight: proof });
    await assert.rejects(h.executor.sendVerifiedTx({ label: 'reused-proof', ...request,
      preflight: proof }), invalidProof);
    assert.equal(h.calls.broadcasts.length, 1, 'replay must not trigger a second broadcast');
  }
});

test('transaction preflight expiry is checked after populate, sign, and chain ID waits', async () => {
  const realNow = Date.now;
  const fees = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
  const request = { to: TOKEN0, data: '0x1234', value: 0n, feeOverrides: fees };

  for (const boundary of ['populate', 'sign', 'chainId']) {
    let fakeNow = 1_000_000;
    Date.now = () => fakeNow;
    try {
      const h = makePreflightHarness();
      const advanceClock = () => { if (boundary === 'populate') fakeNow += 20_001; };
      h.executor.signer.populateTransaction = async tx => {
        h.calls.populates++;
        advanceClock();
        return { ...tx, nonce: 3 };
      };
      h.executor.signer.signTransaction = async () => {
        h.calls.signs++;
        if (boundary === 'sign') fakeNow += 20_001;
        return '0x1234';
      };
      h.executor.writeProvider.send = async method => {
        assert.equal(method, 'eth_chainId');
        h.calls.chainIds++;
        if (boundary === 'chainId') fakeNow += 20_001;
        return '0x2105';
      };
      const proof = await h.executor.preflightVerifiedTx(request);
      let onSent = 0;
      await assert.rejects(h.executor.sendVerifiedTx({ label: `expired-${boundary}`,
        ...request, preflight: proof, onSent: () => { onSent++; } }), error =>
        error.code === 'PREFLIGHT_EXPIRED' && error.preBroadcastFailure === true,
      `expiry should be enforced after ${boundary}`);
      assert.equal(onSent, 0, `${boundary} expiry must not persist a sent hash`);
      assert.equal(h.calls.broadcasts.length, 0, `${boundary} expiry must not broadcast`);
      assert.equal(h.events.length, 0, `${boundary} expiry must not write broadcast ledger events`);
    } finally {
      Date.now = realNow;
    }
  }
});

test('secant balancing reduces quote calls while keeping input and preferred output ratio bounded', async () => {
  const rawAmount0 = 1_000_000_000_000_000_000_000n;
  const rawAmount1 = 100_000_000_000_000_000_000n;
  const sqrtPriceX96 = getSqrtPriceAtTick(0);
  const sqrtA = getSqrtPriceAtTick(-200);
  const sqrtB = getSqrtPriceAtTick(200);
  const quotedInputs = [];
  const quoter = {
    async quoteExactInputSingleRaw(_pool, tokenIn, rawAmountIn, slippageBps) {
      rawAmountIn = BigInt(rawAmountIn);
      quotedInputs.push(rawAmountIn);
      const rawAmountOut = rawAmountIn * 997n / 1000n;
      return {
        rawAmountIn: String(rawAmountIn),
        rawAmountOut: String(rawAmountOut),
        minRawAmountOut: String(rawAmountOut * BigInt(10_000 - slippageBps) / 10_000n),
        tokenIn: tokenIn === 0 ? TOKEN0 : TOKEN1,
        tokenOut: tokenIn === 0 ? TOKEN1 : TOKEN0
      };
    }
  };

  const plan = await buildExactBalancedSwapPlan({
    pool,
    quoter,
    rawAmount0,
    rawAmount1,
    sqrtPriceX96,
    tickLower: -200,
    tickUpper: 200,
    slippageBps: 50,
    iterations: 22,
    preferRemainderTokenIndex: 1,
    preferredRemainderBps: 25
  });

  assert.equal(plan.direction, '0_to_1');
  assert.ok(quotedInputs.length < 22, 'smooth quotes should converge before the bisection bound');
  assert.ok(quotedInputs.length <= 4, 'secant interpolation should converge in a small bounded number of quotes');
  assert.ok(quotedInputs.every(amount => amount > 0n && amount <= rawAmount0),
    'every interpolated exact-input amount must remain within available token0 inventory');
  assert.ok(plan.rawAmountIn > 0n && plan.rawAmountIn <= rawAmount0);
  assert.equal(BigInt(plan.quote.rawAmountIn), plan.rawAmountIn);
  assert.equal(plan.projectedRaw0, rawAmount0 - plan.rawAmountIn);
  assert.equal(plan.projectedRaw1, rawAmount1 + BigInt(plan.quote.rawAmountOut));
  assert.equal(BigInt(plan.quote.minRawAmountOut),
    BigInt(plan.quote.rawAmountOut) * 9_950n / 10_000n);
  assert.ok(plan.priceImpactBps <= 200);

  const capacity0 = getLiquidityForAmount0(sqrtPriceX96, sqrtB, plan.projectedRaw0);
  const capacity1 = getLiquidityForAmount1(sqrtA, sqrtPriceX96, plan.projectedRaw1);
  const targetRatioError = capacity0 * 10_025n - capacity1 * 10_000n;
  const absoluteError = targetRatioError < 0n ? -targetRatioError : targetRatioError;
  const maxCapacity = capacity0 > capacity1 ? capacity0 : capacity1;
  assert.ok(absoluteError <= maxCapacity,
    'preferred 25 bps capacity ratio should meet the normalized 1 bps stopping tolerance');
});

function makeAtomicRetryHarness({ onFit = () => {} } = {}) {
  const settings = new Map([['executionPaused', false]]);
  const funding = { raw0: 100n, raw1: 80n };
  const balances = { raw0: 1000n, raw1: 800n };
  const target = { tickLower: -100, tickUpper: 100 };
  const fits = [];
  const approvals = [];
  const sendRequests = [];
  const journalHistory = [];
  let preflightCalls = 0;

  const executor = {
    config: {
      walletAddress: WALLET,
      usdgAddress: TOKEN1,
      tightWidthBps: 120,
      rangePreset: 'custom-bps',
      depositSlippageBps: 50,
      topUpMinGasReserveWei: 1n
    },
    state: { getSetting: (key, fallback) => settings.has(key) ? settings.get(key) : fallback },
    ledger: { append() {} },
    signer: { estimateGas: async () => 100_000n },
    readProvider: {
      async call() {
        preflightCalls++;
        if (preflightCalls === 1) {
          throw Object.assign(new Error('stale sequential simulation'), {
            code: 'SEQUENTIAL_SIMULATION_REVERT'
          });
        }
        return '0x';
      }
    },
    router: { buildV4ExactInputSingle: () => ({ router: UNISWAP_UNIVERSAL_ROUTER_212,
      data: '0x12345678', value: 0n }) },
    fables: { readPoolState: async () => ({
      tick: 0, sqrtPriceX96: getSqrtPriceAtTick(0), paused: false
    }) },
    assertAtomicGuardReady: async () => {},
    assertTopUpGasBudget: async () => {},
    getPinnedFeeOverrides: async () => ({ gasPrice: 1n }),
    deadline: () => 9_999_999_999,
    prepareRangeBalancedSwap: async options => {
      fits.push(options);
      onFit(fits.length);
      const rawAmountIn = [60n, 50n, 40n][fits.length - 1];
      return {
        target,
        postState: { tick: 0, sqrtPriceX96: getSqrtPriceAtTick(0) },
        swapPlan: {
          direction: 'zeroForOne',
          tokenIn: 0,
          rawAmountIn,
          quote: { minRawAmountOut: 12n, rawAmountOut: 13n }
        }
      };
    },
    ensureSwapAllowances: async (token, amount, options) => {
      approvals.push({ token, amount: BigInt(amount), options });
    },
    readRawPairBalances: async () => balances,
    patchJournal: (journal, patch) => {
      const next = { ...journal, ...patch };
      journalHistory.push(next);
      return next;
    },
    sendVerifiedTx: async request => {
      sendRequests.push(request);
      request.beforeBroadcast();
      throw new Error('stop after final gate');
    }
  };

  return { executor, funding, balances, target, fits, approvals, sendRequests, journalHistory };
}

test('atomic preflight retry reuses one capped approval and does not refit twice', async () => {
  const h = makeAtomicRetryHarness();
  const journal = {
    id: 'approval-loop-test',
    kind: 'rebalance',
    phase: 'prepared',
    startedAt: Date.now(),
    poolId: POOL_ID,
    pair: 'T0/T1',
    tx: {}
  };

  await assert.rejects(executeAtomicDeposit.call(h.executor, {
    pool,
    target: h.target,
    funding: h.funding,
    balances: h.balances,
    journal
  }), /stop after final gate/);

  assert.equal(h.fits.length, 3,
    'first attempt fits before and after approval; retry fits once using the existing cap');
  assert.equal(h.approvals.length, 1,
    'the same input token must not receive another approval on preflight retry');
  assert.equal(h.approvals[0].token, token0);
  assert.equal(h.approvals[0].amount, 60n);
  assert.equal(h.approvals[0].options.allowanceCap, h.funding.raw0);
  assert.ok(h.fits.every(options => options.swapAllowanceCaps.raw0 === h.funding.raw0));
  assert.equal(h.sendRequests.length, 1);
  assert.equal(typeof h.sendRequests[0].beforeBroadcast, 'function');
  assert.ok(h.journalHistory.some(entry =>
    entry.atomicRetryReason === 'preflight-price-changed'));
});

test('atomic broadcast-stage retry is limited to typed pre-broadcast failures', async () => {
  const h = makeAtomicRetryHarness();
  const preflights = [];
  let sendAttempts = 0;
  h.executor.preflightVerifiedTx = async request => {
    preflights.push(request);
    return Object.freeze({ gasEstimate: 100_000n, feeOverrides: { gasPrice: 1n } });
  };
  h.executor.sendVerifiedTx = async request => {
    h.sendRequests.push(request);
    sendAttempts++;
    if (sendAttempts === 1) {
      throw Object.assign(new Error('late pre-sign simulation reverted'), {
        code: 'CALL_EXCEPTION', preBroadcastFailure: true
      });
    }
    request.beforeBroadcast();
    throw new Error('stop after late retry');
  };
  const journal = {
    id: 'approval-loop-late-prebroadcast-test', kind: 'rebalance', phase: 'prepared',
    startedAt: Date.now(), poolId: POOL_ID, pair: 'T0/T1', tx: {}
  };

  await assert.rejects(executeAtomicDeposit.call(h.executor, {
    pool, target: h.target, funding: h.funding, balances: h.balances, journal
  }), /stop after late retry/);

  assert.equal(sendAttempts, 2, 'a typed pre-broadcast failure should trigger one bounded retry');
  assert.equal(preflights.length, 2);
  assert.equal(h.fits.length, 3, 'the retry refits once after the original approval');
  assert.equal(h.approvals.length, 1, 'the retry should reuse its finite approval cap');
  const retry = h.journalHistory.find(entry => entry.phase === 'atomic_retry');
  assert.equal(retry.atomicRetryStage, 'broadcast');
  assert.equal(retry.atomicRetryReason, 'preflight-price-changed');
});

test('atomic planning stops after five minutes before another approval or broadcast', async () => {
  const realNow = Date.now;
  let fakeNow = 1_000_000;
  Date.now = () => fakeNow;
  try {
    const h = makeAtomicRetryHarness({ onFit: () => { fakeNow += 300_001; } });
    const journal = {
      id: 'approval-loop-deadline-test', kind: 'rebalance', phase: 'prepared',
      startedAt: fakeNow, poolId: POOL_ID, pair: 'T0/T1', tx: {}
    };

    await assert.rejects(executeAtomicDeposit.call(h.executor, {
      pool, target: h.target, funding: h.funding, balances: h.balances, journal
    }), /Atomic planning exceeded five minutes/);
    assert.equal(h.fits.length, 1);
    assert.equal(h.approvals.length, 0);
    assert.equal(h.sendRequests.length, 0);
    assert.equal(h.journalHistory.some(entry => entry.atomicRetryReason), false);
  } finally {
    Date.now = realNow;
  }
});

test('approval receipt time is excluded from the bounded atomic planning budget', async () => {
  const realNow = Date.now;
  let fakeNow = 2_000_000;
  Date.now = () => fakeNow;
  try {
    const h = makeAtomicRetryHarness();
    let poolStateReads = 0;
    h.executor.fables.readPoolState = async () => {
      poolStateReads++;
      return { tick: 0, sqrtPriceX96: getSqrtPriceAtTick(0), paused: false };
    };
    h.executor.ensureSwapAllowances = async (token, amount, options) => {
      h.approvals.push({ token, amount: BigInt(amount), options });
      fakeNow += 360_001;
      return { broadcasted: false, broadcastCount: 0, reused: true };
    };
    const journal = {
      id: 'approval-loop-excluded-approval-time-test', kind: 'rebalance', phase: 'prepared',
      startedAt: fakeNow, poolId: POOL_ID, pair: 'T0/T1', tx: {}
    };

    await assert.rejects(executeAtomicDeposit.call(h.executor, {
      pool, target: h.target, funding: h.funding, balances: h.balances, journal
    }), /stop after final gate/);

    assert.equal(h.fits.length, 2, 'the second fit is only for the independent preflight retry');
    assert.equal(h.approvals.length, 1);
    assert.equal(poolStateReads, 2, 'reused allowance needs no extra fresh-state fit');
    assert.equal(h.sendRequests.length, 1, 'planning resumes after the bounded approval wait');
  } finally {
    Date.now = realNow;
  }
});

test('approval CALL_EXCEPTION is terminal and is not treated as a retryable fit failure', async () => {
  const h = makeAtomicRetryHarness();
  h.executor.ensureSwapAllowances = async (token, amount, options) => {
    h.approvals.push({ token, amount: BigInt(amount), options });
    throw Object.assign(new Error('approval simulation reverted'), { code: 'CALL_EXCEPTION' });
  };
  const journal = {
    id: 'approval-loop-approval-error-test', kind: 'rebalance', phase: 'prepared',
    startedAt: Date.now(), poolId: POOL_ID, pair: 'T0/T1', tx: {}
  };

  await assert.rejects(executeAtomicDeposit.call(h.executor, {
    pool, target: h.target, funding: h.funding, balances: h.balances, journal
  }), /approval simulation reverted/);
  assert.equal(h.fits.length, 1);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.sendRequests.length, 0);
  assert.equal(h.journalHistory.some(entry => entry.atomicRetryReason), false);
});

test('retry stage resets to validation so a later validation CALL_EXCEPTION is terminal', async () => {
  const h = makeAtomicRetryHarness();
  let physicalReads = 0;
  h.executor.readRawPairBalances = async () => {
    physicalReads++;
    if (physicalReads === 2) {
      throw Object.assign(new Error('validation balance read failed'), { code: 'CALL_EXCEPTION' });
    }
    return h.balances;
  };
  const journal = {
    id: 'approval-loop-stage-reset-test', kind: 'rebalance', phase: 'prepared',
    startedAt: Date.now(), poolId: POOL_ID, pair: 'T0/T1', tx: {}
  };

  await assert.rejects(executeAtomicDeposit.call(h.executor, {
    pool, target: h.target, funding: h.funding, balances: h.balances, journal
  }), /validation balance read failed/);
  assert.equal(physicalReads, 2);
  assert.equal(h.fits.length, 2);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.sendRequests.length, 0);
  const retries = h.journalHistory.filter(entry => entry.phase === 'atomic_retry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].atomicRetryStage, 'preflight');
});
