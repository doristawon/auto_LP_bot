import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { RebalanceExecutor } from '../src/adapters/executor.js';
import { buildExactDepositPlan, getSqrtPriceAtTick } from '../src/math/v4-fixed.js';
import { addAllocationReceiptDeltas, allocationPairCaps, assertAllocationRawCaps,
  clipAllocationPairBalances } from '../src/execution/allocation-funding.js';

const USDG = `0x${'11'.repeat(20)}`;
const CASHCAT = `0x${'22'.repeat(20)}`;
const MOO = `0x${'33'.repeat(20)}`;
const OTHER = `0x${'44'.repeat(20)}`;
const POOL = `0x${'ab'.repeat(32)}`;
const pool = { id: POOL, token0: { address: USDG }, token1: { address: MOO } };
const caps = () => allocationPairCaps(pool, {
  allocationUpdatedAt: 123, poolId: POOL,
  tokenCaps: { [USDG]: '1000', [MOO]: { rawCap: '500', priceUsdG: 0.02 } }
});

test('pair clipping reserves other-pool USDG and prevents outside balance from enlarging caps', () => {
  const pairCaps = caps();
  const clipped = clipAllocationPairBalances(new Map([
    [USDG, 5000n], [MOO, 900n], [CASHCAT, 777n]
  ]), pairCaps);
  assert.deepEqual(clipped, { [USDG]: 1000n, [MOO]: 500n });
  assert.throws(() => assertAllocationRawCaps({ [USDG]: 1001n }, pairCaps), /exceeds/);
  assert.deepEqual(assertAllocationRawCaps({ [USDG]: 700n, [MOO]: 400n }, pairCaps),
    { [USDG]: 700n, [MOO]: 400n });
  assert.throws(() => addAllocationReceiptDeltas(clipped,
    { [USDG]: 5000n, [MOO]: 900n }, { [USDG]: 5001n, [MOO]: 900n }, {}), /expectations/);
});

test('own LP withdrawal credits only receipt-confirmed physical pair deltas', () => {
  const scoped = { [USDG]: 100n, [MOO]: 20n };
  const result = addAllocationReceiptDeltas(scoped,
    { [USDG]: 1000n, [MOO]: 500n }, { [USDG]: 1100n, [MOO]: 550n },
    { [USDG]: 100n, [MOO]: 50n });
  assert.deepEqual(result, { [USDG]: 200n, [MOO]: 70n });
  assert.throws(() => addAllocationReceiptDeltas(scoped,
    { [USDG]: 1000n, [MOO]: 500n }, { [USDG]: 1200n, [MOO]: 550n },
    { [USDG]: 100n, [MOO]: 50n }), /does not match/);
});

test('same-pool swap verifies exact input debit and credits only actual conservative output', () => {
  const pairCaps = caps();
  const scoped = { [USDG]: 800n, [MOO]: 100n };
  assert.deepEqual(assertAllocationRawCaps({ [USDG]: 250n }, pairCaps), { [USDG]: 250n });
  const after = addAllocationReceiptDeltas(scoped,
    { [USDG]: 10_000n, [MOO]: 4_000n },
    { [USDG]: 9_750n, [MOO]: 4_400n },
    { [USDG]: -250n, [MOO]: 400n });
  assert.deepEqual(after, { [USDG]: 550n, [MOO]: 500n });
  assert.throws(() => addAllocationReceiptDeltas(scoped,
    { [USDG]: 10_000n, [MOO]: 4_000n },
    { [USDG]: 9_749n, [MOO]: 4_400n },
    { [USDG]: -250n, [MOO]: 400n }), /does not match/);
});

test('allocation scope rejects missing, mismatched, negative, and duplicate raw caps', () => {
  assert.throws(() => allocationPairCaps(pool, { poolId: POOL, allocationUpdatedAt: 123,
    tokenCaps: { [USDG]: '1' } }), /missing/);
  assert.throws(() => allocationPairCaps(pool, { poolId: POOL, allocationUpdatedAt: 0,
    tokenCaps: { [USDG]: '1', [MOO]: '2' } }), /journal-compatible/);
  assert.throws(() => allocationPairCaps(pool, { poolId: `0x${'cd'.repeat(32)}`, allocationUpdatedAt: 123,
    tokenCaps: { [USDG]: '1', [MOO]: '2' } }), /journal-compatible/);
  assert.throws(() => allocationPairCaps(pool, { poolId: POOL, allocationUpdatedAt: 123,
    tokenCaps: { [USDG]: '-1', [MOO]: '2' } }), /negative/);
  assert.throws(() => clipAllocationPairBalances(new Map([[USDG, 1n], [USDG.toUpperCase(), 2n]]), caps()), /duplicate/);
});

function makeExecutor(allocation = { version: 1, enabled: true, allocations: [
  { poolId: POOL, weightBps: 10_000 }
] }, updatedAt = 123) {
  const settings = new Map([['investmentAllocation', allocation], ['investmentAllocationUpdatedAt', updatedAt]]);
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.config = { walletAddress: `0x${'99'.repeat(20)}` };
  executor.state = {
    getSetting(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; },
    setSetting(key, value) { settings.set(key, value); }
  };
  return { executor, settings };
}

test('actual executor scope validation requires the saved pool and never falls back to full wallet', () => {
  const { executor } = makeExecutor();
  const scope = { allocationUpdatedAt: 123, poolId: POOL,
    tokenCaps: { [USDG]: '1000', [MOO]: '500' } };
  assert.equal(executor.assertAllocationFundingScope(pool, scope), scope);
  assert.deepEqual(executor.clipPairToAllocation(pool, { raw0: 2000n, raw1: 50n }, scope),
    { raw0: 1000n, raw1: 50n });
  const pricedScope = { ...scope, tokenCaps: { [USDG]: { rawCap: '1000', priceUsdG: 1 },
    [MOO]: { rawCap: '500', priceUsdG: 0.02 } } };
  assert.deepEqual(executor.clipPairToAllocation(pool, { raw0: 2000n, raw1: 900n }, pricedScope),
    { raw0: 1000n, raw1: 500n });
  for (const missing of [null, { ...scope, allocationUpdatedAt: 122 },
    { ...scope, poolId: `0x${'cd'.repeat(32)}` }, { ...scope, tokenCaps: { [USDG]: '1' } }]) {
    assert.throws(() => executor.assertAllocationFundingScope(pool, missing), /scope|required|cap|allocation/i);
    assert.throws(() => executor.clipPairToAllocation(pool, { raw0: 9999n, raw1: 9999n }, missing), /scope|required|cap|allocation/i);
  }
  const { executor: disabled } = makeExecutor({ version: 1, enabled: false, allocations: [] });
  assert.throws(() => disabled.clipPairToAllocation(pool, { raw0: 1n, raw1: 1n }, scope), /disabled|saved wallet configuration/i);
  const { executor: wrongPool } = makeExecutor({ version: 1, enabled: true,
    allocations: [{ poolId: `0x${'cd'.repeat(32)}`, weightBps: 10000 }] });
  assert.throws(() => wrongPool.assertAllocationFundingScope(pool, scope), /not in the current saved allocation/);
});

test('actual capital-moving entry points reject absent or disabled allocation scope before RPC or writes', async () => {
  const position = { id: `0x${'12'.repeat(32)}`, shares: 1n, tickLower: -10, tickUpper: 10 };
  const { executor } = makeExecutor();
  const calls = { rpc: 0, writes: 0 };
  executor.readRawPairBalances = async () => { calls.rpc++; throw new Error('unexpected RPC'); };
  executor.assertLiveReady = async () => { calls.rpc++; throw new Error('unexpected readiness probe'); };
  executor.sendVerifiedTx = async () => { calls.writes++; throw new Error('unexpected write'); };
  await assert.rejects(executor.execute({ pool, destinationPool: pool, position }), /scope|required|allocation/i);
  await assert.rejects(executor.topUpPoolPosition({ pool, position }), /scope|required|allocation/i);
  await assert.rejects(executor.executeCrossPool({ pool, position }, pool), /scope|required|allocation/i);
  assert.deepEqual(calls, { rpc: 0, writes: 0 });

  const scope = { allocationUpdatedAt: 123, priceObservedAt: Date.now(), poolId: POOL,
    tokenCaps: { [USDG]: '1000', [MOO]: '500' } };
  const { executor: disabled } = makeExecutor({ version: 1, enabled: false, allocations: [] });
  disabled.config = { dryRun: false, enableLiveWrites: true, walletAddress: executor.config.walletAddress };
  await assert.rejects(disabled.execute({ pool, destinationPool: pool, position,
    allocationFundingScope: scope }), /disabled|saved wallet configuration/i);
  await assert.rejects(disabled.topUpPoolPosition({ pool, position, allocationFundingScope: scope }), /disabled|scope/i);
  await assert.rejects(disabled.executeCrossPool({ pool, position, allocationFundingScope: scope }, pool), /disabled|scope/i);
});

test('malformed saved allocation entries fail closed before any executor RPC or write', async () => {
  const invalidConfigs = [
    { version: 1, enabled: false, allocations: [{ poolId: POOL, weightBps: 9000 }] },
    { version: 1, enabled: true, allocations: [{ poolId: 'bad', weightBps: 10_000 }] },
    { version: 1, enabled: true, allocations: [
      { poolId: POOL, weightBps: 5000 }, { poolId: POOL, weightBps: 5000 }
    ] },
    { version: 1, enabled: true, allocations: [{ poolId: POOL, weightBps: 9999 }] }
  ];
  for (const invalid of invalidConfigs) {
    const { executor } = makeExecutor(invalid);
    let rpcOrWriteCalls = 0;
    executor.readRawPairBalances = async () => { rpcOrWriteCalls++; throw new Error('unexpected RPC'); };
    executor.assertLiveReady = async () => { rpcOrWriteCalls++; throw new Error('unexpected readiness probe'); };
    executor.sendVerifiedTx = async () => { rpcOrWriteCalls++; throw new Error('unexpected write'); };
    await assert.rejects(executor.execute({ pool, destinationPool: pool,
      position: { id: `0x${'12'.repeat(32)}`, shares: 1n } }), /schema is invalid/);
    assert.equal(rpcOrWriteCalls, 0);
  }
});

test('allocation job revalidation rejects changed saved configuration after refreshed physical balances', () => {
  const { executor, settings } = makeExecutor();
  const scope = { allocationUpdatedAt: 123, priceObservedAt: Date.now(), poolId: POOL,
    tokenCaps: { [USDG]: '1000', [MOO]: '500' } };
  assert.deepEqual(executor.clipPairToAllocation(pool, { raw0: 3000n, raw1: 800n }, scope),
    { raw0: 1000n, raw1: 500n });
  settings.set('investmentAllocationUpdatedAt', 124);
  assert.throws(() => executor.assertAllocationJobCurrent(pool, scope), /scope|required|allocation/i);
});

test('nonterminal journal keeps the entire wallet write path frozen', () => {
  const { executor, settings } = makeExecutor();
  for (const phase of ['withdraw_sent', 'swap_confirmed', 'recovery_required']) {
    settings.set('activeRebalanceExecution', { id: `job:${phase}`, phase });
    assert.throws(() => executor.assertNoUnfinishedExecution(), /requires recovery/);
  }
  settings.set('activeRebalanceExecution', { id: 'job:failed', phase: 'failed' });
  assert.doesNotThrow(() => executor.assertNoUnfinishedExecution());
});

test('actual journal serializer durably preserves the allocation scope and remaining scoped flow', () => {
  const { executor, settings } = makeExecutor();
  const scope = { allocationUpdatedAt: 123, poolId: POOL, weightBps: 10_000,
    tokenCaps: { [USDG]: '1000', [MOO]: '500' } };
  executor.saveJournal({ id: 'job:allocation', phase: 'swap_confirmed',
    allocationFundingScope: scope,
    allocationPhysicalBaselineRaw: { raw0: '2000', raw1: '900' },
    allocationScopedBaselineRaw: { raw0: '1000', raw1: '500' },
    allocationRemainingRaw: { raw0: '750', raw1: '600' } });
  const journal = settings.get('activeRebalanceExecution');
  assert.deepEqual(journal.allocationFundingScope, scope);
  assert.deepEqual(journal.allocationPhysicalBaselineRaw, { raw0: '2000', raw1: '900' });
  assert.deepEqual(journal.allocationScopedBaselineRaw, { raw0: '1000', raw1: '500' });
  assert.deepEqual(journal.allocationRemainingRaw, { raw0: '750', raw1: '600' });
});

test('actual same-pool allocation bootstrap scopes both assets with no conversion route and at most one balance swap', async () => {
  const { executor, settings } = makeExecutor();
  const bootstrapPool = {
    id: POOL,
    token0: { address: USDG, symbol: 'USDG', decimals: 18 },
    token1: { address: MOO, symbol: 'MOO', decimals: 18 },
    key: { currency0: USDG, currency1: MOO, fee: 3000, tickSpacing: 10, hooks: `0x${'55'.repeat(20)}` },
    state: { tick: 39121, sqrtPriceX96: getSqrtPriceAtTick(39121),
      paused: false, liquidity: 100n }
  };
  const rawStable = 100n * 10n ** 18n;
  const rawMoo = 5000n * 10n ** 18n;
  const scope = { allocationUpdatedAt: 123, priceObservedAt: Date.now(), poolId: POOL,
    weightBps: 10_000, availableUsdG: 200,
    tokenCaps: { [USDG]: { rawCap: rawStable.toString(), priceUsdG: 1 },
      [MOO]: { rawCap: rawMoo.toString(), priceUsdG: 0.02 } } };
  const erc20 = new Interface(['function balanceOf(address) view returns(uint256)']);
  const requestQuotes = new Map();
  Object.assign(executor, {
    config: { ...executor.config, chainId: 4663, usdgAddress: USDG, autoTopupDustBps: 0,
      tightWidthBps: 120, rangePreset: 'custom-bps', swapSlippageBps: 50, depositSlippageBps: 50,
      depositLiquidityReserveBps: 10, fablesWalk: 0, txDeadlineSec: 1200,
      maxPriceImpactBps: 200, topUpMinGasReserveWei: 1n },
    fables: { async readPoolState() { return bootstrapPool.state; },
      encodeDeposit() { return '0x1234'; } },
    writeProvider: { async send(method, params) {
      if (method === 'eth_chainId') return '0x1237';
      assert.equal(method, 'eth_simulateV1');
      const calls = params[0].blockStateCalls[0].calls;
      let stable = rawStable, moo = rawMoo;
      return [{ calls: calls.map((call) => {
        const quote = requestQuotes.get(call.data);
        if (quote) {
          if (quote.tokenIn === USDG) { stable -= BigInt(quote.rawAmountIn); moo += BigInt(quote.rawAmountOut); }
          else { moo -= BigInt(quote.rawAmountIn); stable += BigInt(quote.rawAmountOut); }
        }
        return { status: '0x1', gasUsed: '0x5208',
          returnData: call.data.startsWith(erc20.getFunction('balanceOf').selector)
            ? erc20.encodeFunctionResult('balanceOf', [call.to.toLowerCase() === USDG ? stable : moo])
            : '0x', logs: [] };
      }) }];
    } },
    quoter: {
      selectSamePairSwapPool: async () => ({ pool: bootstrapPool }),
      async quoteExactInputSingleRaw(_pool, tokenIn, rawAmountIn) {
        const rawAmountOut = tokenIn === 0 ? BigInt(rawAmountIn) * 50n : BigInt(rawAmountIn) / 50n;
        return { rawAmountIn: BigInt(rawAmountIn), rawAmountOut,
          minRawAmountOut: rawAmountOut, tokenIn: tokenIn === 0 ? USDG : MOO,
          tokenOut: tokenIn === 0 ? MOO : USDG };
      }
    },
    router: { buildV4ExactInputSingle({ quote }) {
      const data = '0x'+BigInt(quote.rawAmountIn).toString(16).padStart(64, '0');
      requestQuotes.set(data, quote);
      return { router: `0x${'66'.repeat(20)}`, data, value: 0n };
    } },
    readRawTokenBalances: async () => new Map([[USDG, rawStable], [MOO, rawMoo]]),
    buildTopUpApprovalRequests: async () => [],
    assertValidDeposit() {},
    findWalletDepositEvent() { return { rangeId: `0x${'ef'.repeat(32)}`, liquidity: 100n }; },
    getUsdPrice(address) { return address.toLowerCase() === USDG ? 1 : 0.02; }
  });
  const plan = executor.allocationBootstrapPlan(bootstrapPool, scope, 1n, 200);
  const preview = await executor.preflightCrossPoolSequence(plan, bootstrapPool);
  assert.equal(preview.status, 'full-sequence-simulated');
  const preparedDeposit = preview.depositPlan;
  const preparedSwap = preview.balanceSwap?.plan;
  const approvalChecks = [];
  executor.buildTopUpApprovalRequests = async (_pool, swap, deposit) => {
    approvalChecks.push({ swap, deposit });
    return [];
  };
  const resimulated = await executor.resimulatePreparedAllocationBootstrap(plan, bootstrapPool, preview);
  assert.equal(resimulated.pendingApprovalCount, 0);
  assert.equal(resimulated.depositPlan.amount0Max, preparedDeposit.amount0Max);
  assert.equal(resimulated.depositPlan.amount1Max, preparedDeposit.amount1Max);
  assert.equal(approvalChecks[0].deposit, preparedDeposit);
  if (preparedSwap) assert.equal(approvalChecks[0].swap, preparedSwap);
  assert.equal(resimulated.scopedBefore, preview.scopedBefore, 'resimulation cannot enlarge this pool funding scope');
  assert.equal(resimulated.simulatedCallCount, preview.preparedCapitalCalls.length);
  const oldBefore = preview.before;
  preview.before = new Map(oldBefore);
  preview.before.set(USDG, oldBefore.get(USDG) + 1n);
  await assert.rejects(executor.resimulatePreparedAllocationBootstrap(plan, bootstrapPool, preview), /balances changed/);
  preview.before = oldBefore;
  executor.buildTopUpApprovalRequests = async () => [{ label: 'still missing' }];
  await assert.rejects(executor.resimulatePreparedAllocationBootstrap(plan, bootstrapPool, preview), /allowances are not ready/);
  executor.buildTopUpApprovalRequests = async () => [];
  await assert.rejects(executor.resimulatePreparedAllocationBootstrap(plan, bootstrapPool,
    { ...preview, deadline: 1 }), /deadline expired/);
  await assert.rejects(executor.resimulatePreparedAllocationBootstrap(plan, bootstrapPool,
    { ...preview, finalTarget: { tickLower: 0, tickUpper: 1 } }), /range moved out of range/);
  const validEvent = executor.findWalletDepositEvent;
  executor.findWalletDepositEvent = () => null;
  await assert.rejects(executor.resimulatePreparedAllocationBootstrap(plan, bootstrapPool, preview), /did not mint/);
  executor.findWalletDepositEvent = validEvent;
  assert.equal(preview.scopedBefore.get(USDG), rawStable);
  assert.equal(preview.scopedBefore.get(MOO), rawMoo);
  assert.deepEqual(preview.routeSwaps, []);
  assert.ok(preview.balanceSwap === null || typeof preview.balanceSwap === 'object');
  assert.ok(preview.funding.every((entry) => BigInt(entry.maxSpendRaw) <= BigInt(scope.tokenCaps[entry.address].rawCap)));
  settings.set('allocationDepositFailures', { [POOL]: { count: 1, at: Date.now() } });
  const recovered = await executor.preflightCrossPoolSequence(plan, bootstrapPool);
  assert.equal(recovered.recoverExistingPair, true);
  assert.equal(recovered.balanceSwap, null, 'confirmed failed-deposit recovery must reuse existing pair inventory');
  assert.equal(recovered.preparedCapitalCalls.length, 1);
  assert.equal(recovered.preparedCapitalCalls[0].to, bootstrapPool.key.hooks);
});

test('allocation bootstrap refits refreshed swap output within unchanged exact approval and funding caps', async () => {
  const executor = Object.create(RebalanceExecutor.prototype);
  const unit = 10n ** 18n;
  const target = { tickLower: 39000, tickUpper: 39400 };
  const livePool = { id: POOL, key: { hooks: OTHER },
    token0: { address: USDG }, token1: { address: MOO } };
  const original = buildExactDepositPlan({ rawAmount0: 50n * unit, rawAmount1: 2500n * unit,
    sqrtPriceX96: getSqrtPriceAtTick(39121), ...target });
  const prepared = { before: new Map([[USDG, 500n * unit], [MOO, 0n]]),
    routeSwaps: [], withdrawCall: null, deadline: Math.floor(Date.now()/1000) + 1200,
    funding: [{ address: USDG, maxSpendRaw: 100n * unit }, { address: MOO, maxSpendRaw: 0n }],
    depositPlan: original, finalTarget: target,
    balanceSwap: { plan: { tokenIn: 0, tokenOut: 1, rawAmountIn: 50n * unit } },
    preparedCapitalCalls: [{ to: CASHCAT, data: '0xaaaa', value: 0n, gasLimit: 500000 },
      { to: OTHER, data: '0xdddd', value: 0n, gasLimit: 700000 }] };
  const erc20 = new Interface(['function balanceOf(address) view returns(uint256)']);
  let stableAfter = 450n * unit;
  let encoded;
  const submissions = [];
  Object.assign(executor, {
    config: { chainId: 4663, walletAddress: OTHER, depositSlippageBps: 50, depositLiquidityReserveBps: 10 },
    assertAllocationJobCurrent() {}, buildTopUpApprovalRequests: async () => [],
    readRawTokenBalances: async () => prepared.before,
    fables: { readPoolState: async () => ({ tick: 39160, sqrtPriceX96: getSqrtPriceAtTick(39160),
      paused: false, liquidity: 1n }), encodeDeposit(_pool, _target, liquidity, cap0, cap1) {
      encoded = { liquidity, cap0, cap1 }; return '0xeeee';
    } },
    findWalletDepositEvent: () => ({ liquidity: 1n }),
    writeProvider: { async send(method, params) {
      if (method === 'eth_chainId') return '0x1237';
      const calls = params[0].blockStateCalls[0].calls;
      submissions.push(calls);
      return [{ calls: calls.map((call) => ({ status: '0x1', gasUsed: '0x5208', logs: [],
        returnData: call.data.startsWith(erc20.getFunction('balanceOf').selector)
          ? erc20.encodeFunctionResult('balanceOf', [call.to === USDG ? stableAfter : 2475n * unit]) : '0x' })) }];
    } }
  });
  const plan = { allocationBootstrap: true, allocationFundingScope: {} };
  const result = await executor.resimulatePreparedAllocationBootstrap(plan, livePool, prepared,
    { router: CASHCAT, data: '0xbbbb', value: 0n });
  assert.equal(result.depositPlan.amount0Max, original.amount0Max);
  assert.equal(result.depositPlan.amount1Max, original.amount1Max);
  assert.equal(encoded.cap0, original.amount0Max);
  assert.equal(encoded.cap1, original.amount1Max);
  assert.ok(encoded.liquidity < original.liquidity, 'latest output/price changes adjust liquidity, not approvals');
  assert.equal(submissions.length, 2, 'preview plus complete swap/deposit simulation are both required');
  assert.equal(submissions.at(-1)[0].data, '0xbbbb');
  assert.equal(submissions.at(-1).at(-1).data, '0xeeee');
  assert.strictEqual(result.funding, prepared.funding);
  stableAfter = 449n * unit;
  await assert.rejects(executor.resimulatePreparedAllocationBootstrap(plan, livePool, prepared), /scoped exact input/);
});

test('confirmed allocation deposit revert is deferred only with unchanged balances, no pending nonce and bounded retries', async () => {
  const { executor, settings } = makeExecutor();
  const hash = `0x${'aa'.repeat(32)}`;
  const scope = { allocationUpdatedAt: 123, poolId: POOL,
    tokenCaps: { [USDG]: '1000', [MOO]: '500' } };
  const plan = { allocationBootstrap: true, allocationFundingScope: scope };
  const journal = { phase: 'deposit_sent', tx: { deposit: hash, routeSwaps: [] },
    allocationRemainingRaw: { [USDG]: '100', [MOO]: '400' } };
  const error = { code: 'TRANSACTION_REVERTED', message: 'known deposit revert',
    receipt: { hash, status: 0, blockNumber: 500 } };
  const before = { raw0: 100n, raw1: 400n };
  let after = before;
  let pending = 50;
  const events = [];
  executor.ledger = { append(type, data) { events.push({ type, data }); } };
  executor.readRawPairBalances = async () => after;
  executor.readProvider = { async getTransactionCount(_wallet, tag) { return tag === 'pending' ? pending : 50; } };
  assert.equal(await executor.deferConfirmedAllocationDepositFailure(plan, pool, journal,
    { ...error, code: 'BROADCAST_OUTCOME_UNCERTAIN' }, before), false);
  assert.equal(await executor.deferConfirmedAllocationDepositFailure(plan, pool, journal,
    { ...error, receipt: { ...error.receipt, hash: `0x${'bb'.repeat(32)}` } }, before), false);
  after = { ...before, raw0: 99n };
  assert.equal(await executor.deferConfirmedAllocationDepositFailure(plan, pool, journal, error, before), false);
  after = before; pending = 51;
  assert.equal(await executor.deferConfirmedAllocationDepositFailure(plan, pool, journal, error, before), false);
  pending = 50;
  assert.equal(await executor.deferConfirmedAllocationDepositFailure(plan, pool, journal, error, before), true);
  assert.equal(settings.get('activeRebalanceExecution').phase, 'failed');
  assert.deepEqual(settings.get('activeRebalanceExecution').allocationRemainingRaw, journal.allocationRemainingRaw);
  assert.equal(settings.get('allocationDepositFailures')[POOL].count, 1);
  assert.equal(events[0].type, 'rebalance.deposit_retry_deferred');
  assert.equal(await executor.deferConfirmedAllocationDepositFailure(plan, pool, journal, error, before), true);
  assert.equal(await executor.deferConfirmedAllocationDepositFailure(plan, pool, journal, error, before), false,
    'third failed deposit within the hour must remain locked for inspection');
});

test('allocation bootstrap inherits only its own explicitly configured swap cost limit', () => {
  const { executor } = makeExecutor();
  Object.assign(executor.config, { maxSwapPriceImpactBps: 200,
    autoTopupSwapEnabled: true, autoTopupSwapPoolId: POOL, autoTopupMaxSwapPriceImpactBps: 350 });
  assert.equal(executor.allocationSwapMaxImpactBps(pool), 350);
  assert.equal(executor.allocationSwapMaxImpactBps({ id: `0x${'cc'.repeat(32)}` }), 200);
  executor.config.autoTopupSwapEnabled = false;
  assert.equal(executor.allocationSwapMaxImpactBps(pool), 200);
});

test('scoped deposit simulation only reduces liquidity after a matching final amount-cap failure', async () => {
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.config = { walletAddress: OTHER, chainId: 4663 };
  const plan = { liquidity: 1000n, amount0Max: 100n, amount1Max: 200n, required0: 100n, required1: 200n };
  const calls = [{ to: OTHER, data: '0xaaaa', value: 0n, gasLimit: 100000 },
    { to: OTHER, data: '0xbbbb', value: 0n, gasLimit: 700000 }];
  const errorData = (required, cap) => '0x0f569baf'+BigInt(required).toString(16).padStart(64,'0')
    +BigInt(cap).toString(16).padStart(64,'0');
  let simulations = 0;
  let alwaysFails = false;
  let cap = 100n;
  executor.writeProvider = { async send(method, params) {
    if(method==='eth_chainId')return '0x1237';
    assert.equal(method,'eth_simulateV1');
    simulations++;
    const submitted = params[0].blockStateCalls[0].calls;
    return [{ calls: submitted.map((_call,index) => index===submitted.length-1 && (simulations===1||alwaysFails)
      ? {status:'0x0',error:{message:'amount cap',data:errorData(125n,cap)}}
      : {status:'0x1',logs:[]}) }];
  } };
  const result = await executor.simulateScopedDepositSequence(calls,plan,liquidity=>'0x'+liquidity.toString(16));
  assert.equal(result.depositPlan.liquidity,798n);
  assert.equal(result.depositPlan.amount0Max,plan.amount0Max);
  assert.equal(result.depositPlan.amount1Max,plan.amount1Max);
  assert.equal(calls.at(-1).data,'0xbbbb','original requests remain immutable');
  assert.equal(simulations,2);
  alwaysFails=true;simulations=0;
  await assert.rejects(executor.simulateScopedDepositSequence(calls,plan,()=> '0xcccc'),/amount cap/);
  assert.equal(simulations,3,'simulation retries are bounded');
  cap=99n;simulations=0;
  await assert.rejects(executor.simulateScopedDepositSequence(calls,plan,()=> '0xcccc'),/amount cap/);
  assert.equal(simulations,1,'unrelated cap failures must not be refitted');
});

test('allocation deposits retain one percent liquidity headroom without changing legacy reserves', () => {
  const {executor,settings}=makeExecutor();
  executor.config.depositLiquidityReserveBps=10;
  assert.equal(executor.getDepositLiquidityReserveBps(),100);
  executor.config.depositLiquidityReserveBps=250;
  assert.equal(executor.getDepositLiquidityReserveBps(),250);
  settings.set('investmentAllocation',{version:1,enabled:false,allocations:[]});
  executor.config.depositLiquidityReserveBps=10;
  assert.equal(executor.getDepositLiquidityReserveBps(),10);
});

test('deposit recovery preference requires a prior confirmed-failure marker and both pair tokens', () => {
  const {executor,settings}=makeExecutor();
  assert.equal(executor.shouldRecoverAllocationWithExistingPair(pool,{raw0:1n,raw1:1n}),false);
  settings.set('allocationDepositFailures',{[POOL]:{count:1,at:Date.now()}});
  executor.config.usdgAddress = USDG;
  const valued = { ...pool, token0: { ...pool.token0, decimals: 18 }, token1: { ...pool.token1, decimals: 18 },
    state: { sqrtPriceX96: getSqrtPriceAtTick(0) } };
  assert.equal(executor.shouldRecoverAllocationWithExistingPair(valued,{raw0:20n*10n**18n,raw1:20n*10n**18n}),true);
  assert.equal(executor.shouldRecoverAllocationWithExistingPair(valued,{raw0:20n*10n**18n,raw1:1n}),false);
  settings.set('allocationDepositFailures',{[POOL]:{count:1,at:Date.now()-3_600_001}});
  assert.equal(executor.shouldRecoverAllocationWithExistingPair(valued,{raw0:20n*10n**18n,raw1:20n*10n**18n}),false);
  assert.equal(executor.shouldRecoverAllocationWithExistingPair(pool,{raw0:1n,raw1:0n}),false);
  assert.equal(executor.shouldRecoverAllocationWithExistingPair({id:OTHER},{raw0:1n,raw1:1n}),false);
});

test('actual wallet write queue is serial and reports active and queued writes', async () => {
  const { executor } = makeExecutor();
  executor.writeTail = Promise.resolve();
  executor.activeWrites = 0;
  executor.queuedWrites = 0;
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = executor.runWalletWrite(async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:end');
    return 'first-result';
  });
  const second = executor.runWalletWrite(async () => {
    events.push('second:start');
    return 'second-result';
  });
  assert.equal(executor.hasPendingWrite, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first-result', 'second-result']);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
  assert.equal(executor.hasPendingWrite, false);
});

test('actual receipt parser counts wallet endpoint Transfer net for a V3 multi-hop route', () => {
  const { executor } = makeExecutor();
  const wallet = executor.config.walletAddress;
  const routerA = `0x${'77'.repeat(20)}`;
  const routerB = `0x${'88'.repeat(20)}`;
  const otherAsset = `0x${'aa'.repeat(20)}`;
  const transfer = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log = (token, from, to, amount) => ({ address: token,
    ...transfer.encodeEventLog(transfer.getEvent('Transfer'), [from, to, amount]) });
  const result = executor.getAllocationWalletReceiptDeltas({ logs: [
    log(USDG, wallet, routerA, 100n),
    log(otherAsset, routerA, routerB, 95n),
    log(MOO, routerB, wallet, 80n)
  ] }, [pool.token0, pool.token1]);
  assert.deepEqual(result, { raw0: -100n, raw1: 80n });
});

test('actual receipt parser and scoped flow accept a single-sided LP withdrawal with one zero delta', () => {
  const { executor } = makeExecutor();
  const wallet = executor.config.walletAddress;
  const transfer = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const encoded = transfer.encodeEventLog(transfer.getEvent('Transfer'), [
    `0x${'77'.repeat(20)}`, wallet, 90n
  ]);
  const result = executor.getAllocationWalletReceiptDeltas({ logs: [{ address: USDG, ...encoded }] },
    [pool.token0, pool.token1]);
  assert.deepEqual(result, { raw0: 90n, raw1: 0n });
  const expected = result.raw0 === 0n ? {} : { [USDG]: result.raw0 };
  const scoped = addAllocationReceiptDeltas({ [USDG]: 10n, [MOO]: 7n },
    { [USDG]: 100n, [MOO]: 50n }, { [USDG]: 190n, [MOO]: 50n }, expected);
  assert.deepEqual(scoped, { [USDG]: 100n, [MOO]: 7n });
});
