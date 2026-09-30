import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { RebalanceExecutor } from '../src/adapters/executor.js';
import { getSqrtPriceAtTick } from '../src/math/v4-fixed.js';
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
      return [{ calls: calls.map((call) => ({ status: '0x1', gasUsed: '0x5208',
        returnData: call.data.startsWith(erc20.getFunction('balanceOf').selector)
          ? erc20.encodeFunctionResult('balanceOf', [call.to.toLowerCase() === USDG ? rawStable * 2n : rawMoo * 2n])
          : '0x', logs: [] })) }];
    } },
    quoter: {
      selectSamePairSwapPool: async () => ({ pool: bootstrapPool }),
      async quoteExactInputSingleRaw(_pool, tokenIn, rawAmountIn) {
        const rawAmountOut = tokenIn === 0 ? BigInt(rawAmountIn) * 50n : BigInt(rawAmountIn) / 50n;
        return { rawAmountIn: BigInt(rawAmountIn), rawAmountOut,
          minRawAmountOut: rawAmountOut, tokenOut: tokenIn === 0 ? MOO : USDG };
      }
    },
    router: { buildV4ExactInputSingle() { return { router: `0x${'66'.repeat(20)}`, data: '0x1234', value: 0n }; } },
    readRawTokenBalances: async () => new Map([[USDG, rawStable], [MOO, rawMoo]]),
    buildTopUpApprovalRequests: async () => [],
    assertValidDeposit() {},
    findWalletDepositEvent() { return { rangeId: `0x${'ef'.repeat(32)}`, liquidity: 100n }; },
    getUsdPrice(address) { return address.toLowerCase() === USDG ? 1 : 0.02; }
  });
  const plan = executor.allocationBootstrapPlan(bootstrapPool, scope, 1n, 200);
  const preview = await executor.preflightCrossPoolSequence(plan, bootstrapPool);
  assert.equal(preview.status, 'full-sequence-simulated');
  assert.equal(preview.scopedBefore.get(USDG), rawStable);
  assert.equal(preview.scopedBefore.get(MOO), rawMoo);
  assert.deepEqual(preview.routeSwaps, []);
  assert.ok(preview.balanceSwap === null || typeof preview.balanceSwap === 'object');
  assert.ok(preview.funding.every((entry) => BigInt(entry.maxSpendRaw) <= BigInt(scope.tokenCaps[entry.address].rawCap)));
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
