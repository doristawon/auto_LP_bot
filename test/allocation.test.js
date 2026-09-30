import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAllocationFunding, normalizeInvestmentAllocation,
  usdGAssetPriceFromPool, valuePoolPositionsUsdG } from '../src/analytics/allocation.js';
import { rangeAmounts } from '../src/analytics/liquidity.js';

const USDG = `0x${'11'.repeat(20)}`;
const CASHCAT = `0x${'22'.repeat(20)}`;
const MOO = `0x${'33'.repeat(20)}`;
const POOL_A = `0x${'a1'.repeat(32)}`;
const POOL_B = `0x${'b2'.repeat(32)}`;
const addr = (n) => `0x${String(n).repeat(40)}`;
const pool = (id, token, symbol) => ({ id, token0: { address: token, symbol, decimals: 18 },
  token1: { address: USDG, symbol: 'USDG', decimals: 18 },
  state: { paused: false, liquidity: 1n } });
const pools = [pool(POOL_A, CASHCAT, 'CASHCAT'), pool(POOL_B, MOO, 'MOO')];
const allocation = normalizeInvestmentAllocation({ enabled: true, allocations: [
  { poolId: POOL_A, weightBps: 7000 }, { poolId: POOL_B, weightBps: 3000 }
] }, pools, USDG);

test('allocation validates strict booleans, unique pools, pool support and 10000 bps', () => {
  assert.equal(allocation.enabled, true);
  assert.throws(() => normalizeInvestmentAllocation({ allocations: [] }, pools, USDG), /enabled/);
  assert.throws(() => normalizeInvestmentAllocation({ enabled: true, allocations: [
    { poolId: POOL_A, weightBps: 7000 }, { poolId: POOL_A, weightBps: 3000 }
  ] }, pools, USDG), /重複/);
  assert.throws(() => normalizeInvestmentAllocation({ enabled: true, allocations: [
    { poolId: POOL_A, weightBps: 7000 }, { poolId: POOL_B, weightBps: 2000 }
  ] }, pools, USDG), /10000/);
  assert.equal(normalizeInvestmentAllocation({ enabled: true, allocations: [
    { poolId: POOL_A, weightBps: 10000 }
  ] }, pools, USDG).allocations[0].weightBps, 10000);
  assert.throws(() => normalizeInvestmentAllocation({ enabled: true, allocations: [
    { poolId: POOL_A, weightBps: 7000 }, { poolId: `0x${'c3'.repeat(32)}`, weightBps: 3000 }
  ] }, pools, USDG), /登錄清單/);
});

test('allocation rejects native, paused, and shared meme-token pool pairs', () => {
  const nativePool = { ...pool(POOL_B, MOO, 'MOO'), token0: { address: addr(0), symbol: 'ETH', decimals: 18 } };
  assert.throws(() => normalizeInvestmentAllocation({ enabled: true, allocations: [
    { poolId: POOL_B, weightBps: 10000 }
  ] }, [nativePool], USDG), /ERC20/);
  assert.throws(() => normalizeInvestmentAllocation({ enabled: true, allocations: [
    { poolId: POOL_A, weightBps: 7000 }, { poolId: POOL_B, weightBps: 3000 }
  ] }, [pools[0], { ...pools[1], token0: pools[0].token0 }], USDG), /共用/);
  assert.throws(() => normalizeInvestmentAllocation({ enabled: true, allocations: [
    { poolId: POOL_A, weightBps: 10000 }
  ] }, [{ ...pools[0], state: { paused: true, liquidity: 1n } }], USDG), /暫停/);
});

test('existing MOO LP equity is credited before shared USDG; own meme token is capped to its pool', () => {
  const amounts = (value) => ({ raw: BigInt(value) * 10n ** 18n, amount: value });
  const result = computeAllocationFunding({
    allocation,
    pools,
    lpEquityUsdG: { [POOL_A]: 0, [POOL_B]: 30 },
    walletBalances: { [CASHCAT]: amounts(80), [MOO]: amounts(50), [USDG]: amounts(100) },
    pricesUsdG: new Map([[CASHCAT, 1], [MOO, 1]]),
    usdgAddress: USDG,
    priceObservedAt: 1_000,
    asOfBlock: 99,
    nowMs: 1_001
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.totalUsdG, 260);
  const a = result.byPool.find((entry) => entry.poolId === POOL_A);
  const b = result.byPool.find((entry) => entry.poolId === POOL_B);
  assert.equal(a.targetUsdG, 182);
  assert.equal(b.targetUsdG, 78);
  assert.equal(a.tokenCaps[CASHCAT], String(80n * 10n ** 18n));
  assert.equal(b.tokenCaps[MOO], String(48n * 10n ** 18n));
  assert.equal(BigInt(a.tokenCaps[USDG]) + BigInt(b.tokenCaps[USDG]), 100n * 10n ** 18n);
  assert.equal(b.lpEquityUsdG, 30);
  assert.ok(b.availableUsdG <= 48);
});

test('overweight in-range LP gets no idle USDG and missing prices or LP valuations block funding', () => {
  const amounts = (value) => ({ raw: BigInt(value) * 10n ** 18n, amount: value });
  const args = {
    allocation, pools,
    lpEquityUsdG: { [POOL_A]: 0, [POOL_B]: 200 },
    walletBalances: { [CASHCAT]: amounts(1), [MOO]: amounts(100), [USDG]: amounts(50) },
    pricesUsdG: { [CASHCAT]: 1, [MOO]: 1 }, usdgAddress: USDG,
    priceObservedAt: 1_000, nowMs: 1_001
  };
  const result = computeAllocationFunding(args);
  assert.equal(result.status, 'ready');
  assert.equal(result.byPool.find((entry) => entry.poolId === POOL_B).sharedUsdgAvailableUsdG, 0);
  assert.equal(result.byPool.find((entry) => entry.poolId === POOL_B).tokenCaps[USDG], '0');
  assert.equal(computeAllocationFunding({ ...args, pricesUsdG: {} }).status, 'blocked');
  assert.equal(computeAllocationFunding({ ...args, lpEquityUsdG: { [POOL_A]: 0 } }).status, 'blocked');
  assert.equal(computeAllocationFunding({ ...args, priceObservedAt: 1, nowMs: 400_000 }).reason, 'market-price-stale');
});

test('pool capital does not exceed its allocation when wallet token balance is concentrated in one asset', () => {
  const result = computeAllocationFunding({
    allocation, pools,
    lpEquityUsdG: { [POOL_A]: 0, [POOL_B]: 0 },
    walletBalances: { [CASHCAT]: { raw: 1_000_000n, amount: 100 },
      [MOO]: { raw: 0n, amount: 0 }, [USDG]: { raw: 0n, amount: 0 } },
    pricesUsdG: { [CASHCAT]: 1, [MOO]: 1 }, usdgAddress: USDG,
    priceObservedAt: 1_000, nowMs: 1_001
  });
  const a = result.byPool.find((entry) => entry.poolId === POOL_A);
  const b = result.byPool.find((entry) => entry.poolId === POOL_B);
  assert.ok(a.availableUsdG <= a.targetUsdG);
  assert.equal(b.availableUsdG, 0);
  assert.equal(b.tokenCaps[MOO], '0');
});

test('fresh USDG pool spot prices have the same orientation in either token order and LP value includes owed fees', () => {
  const q96 = 1n << 96n;
  const make = (token0, token1, spot1Per0, low, high) => ({
    id: POOL_A,
    token0: { address: token0, symbol: token0 === USDG ? 'USDG' : 'MOO', decimals: 18 },
    token1: { address: token1, symbol: token1 === USDG ? 'USDG' : 'MOO', decimals: 18 },
    state: { sqrtPriceX96: BigInt(Math.floor(Math.sqrt(spot1Per0) * Number(q96))) },
    positions: [{ shares: 10n ** 18n, tickLower: low, tickUpper: high,
      owed0: token0 === USDG ? 0n : 2n * 10n ** 18n,
      owed1: token1 === USDG ? 0n : 2n * 10n ** 18n }]
  });
  const stableFirst = make(USDG, MOO, 125, 4800, 4860);
  const stableLast = make(MOO, USDG, 0.008, -4860, -4800);
  assert.ok(Math.abs(usdGAssetPriceFromPool(stableFirst, USDG).priceUsdG - 0.008) < 1e-8);
  assert.ok(Math.abs(usdGAssetPriceFromPool(stableLast, USDG).priceUsdG - 0.008) < 1e-8);
  for (const candidate of [stableFirst, stableLast]) {
    const valued = valuePoolPositionsUsdG(candidate, USDG);
    const amounts = rangeAmounts(candidate.positions[0].shares, candidate.state.sqrtPriceX96,
      candidate.positions[0].tickLower, candidate.positions[0].tickUpper, 18, 18);
    const nonStableOwed = 2;
    const expected = (candidate.token0.address === USDG
      ? amounts.amount0 + (amounts.amount1 + nonStableOwed) * 0.008
      : (amounts.amount0 + nonStableOwed) * 0.008 + amounts.amount1);
    assert.ok(Math.abs(valued.lpEquityUsdG - expected) < 1e-7);
  }
});
