import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExactBalancedSwapPlan, quotePriceImpactBps } from '../src/execution/exact-rebalance.js';
import { buildRangeBalancedSwapPlan } from '../src/execution/range-balanced-swap.js';
import {
  getSqrtPriceAtTick
} from '../src/math/v4-fixed.js';

const Q96 = 1n << 96n;
const pool = {
  id: 'synthetic-pool',
  token0: { address: '0x0000000000000000000000000000000000000010' },
  token1: { address: '0x0000000000000000000000000000000000000020' }
};
const base = {
  pool,
  quoter: {
    async quoteExactInputSingleRaw(_pool, tokenIn, rawAmountIn) {
      rawAmountIn = BigInt(rawAmountIn);
      const rawAmountOut = rawAmountIn * 999n / 1000n;
      return {
        rawAmountIn: rawAmountIn.toString(),
        rawAmountOut: rawAmountOut.toString(),
        minRawAmountOut: (rawAmountOut * 995n / 1000n).toString(),
        tokenIn: tokenIn === 0 ? pool.token0.address : pool.token1.address,
        tokenOut: tokenIn === 0 ? pool.token1.address : pool.token0.address
      };
    }
  },
  rawAmount0: 1_000_000n,
  rawAmount1: 100_000n,
  state: { tick: 0, sqrtPriceX96: Q96, slot: 1 },
  target: { tickLower: -100, tickUpper: 100 },
  slippageBps: 50,
  maxPriceImpactBps: 350
};

test('retargets from the pinned tick and keeps each refinement paired with its preview', async () => {
  const seen = [];
  const ticks = [21, 41, 61];
  let previews = 0;
  const result = await buildRangeBalancedSwapPlan({
    ...base,
    chooseTarget(tick) {
      seen.push(tick);
      return { tickLower: tick - 5, tickUpper: tick + 15 };
    },
    async previewSwap(plan) {
      const tick = ticks[previews++];
      return { tick, sqrtPriceX96: getSqrtPriceAtTick(tick),
        balances: { raw0: '900000', raw1: '199000' }, callCount: previews };
    }
  });
  assert.deepEqual(seen, [0, 21, 41, 61]);
  assert.deepEqual(result.target, { tickLower: result.postState.tick - 5,
    tickUpper: result.postState.tick + 15 });
  assert.equal(result.postState.callCount, ticks.indexOf(result.postState.tick) + 1);
  assert.deepEqual(result.postState.balances, { raw0: '900000', raw1: '199000' });
  assert.equal(result.refinements, 2);
  assert.ok(result.capacityMismatchBps >= 0);
});

test('quote and preview memoization is limited to a single pinned planning block', async () => {
  const run = async pinnedBlockTag => {
    const quoteCounts = new Map();
    let selections = 0;
    let previews = 0;
    const quoter = {
      async selectSamePairSwapPool() { selections++; return { pool }; },
      async quoteExactInputSingleRaw(_pool, tokenIn, rawAmountIn) {
        const amount = BigInt(rawAmountIn);
        const key = `${tokenIn}:${amount}`;
        quoteCounts.set(key, (quoteCounts.get(key) || 0) + 1);
        const rawAmountOut = amount * 999n / 1000n;
        return { rawAmountIn: String(amount), rawAmountOut: String(rawAmountOut),
          minRawAmountOut: String(rawAmountOut * 995n / 1000n),
          tokenIn: tokenIn === 0 ? pool.token0.address : pool.token1.address,
          tokenOut: tokenIn === 0 ? pool.token1.address : pool.token0.address };
      }
    };
    await buildRangeBalancedSwapPlan({ ...base, quoter, pinnedBlockTag, maxRefinements: 1,
      async previewSwap() { previews++; return { tick: 0, sqrtPriceX96: Q96 }; } });
    return { quoteCounts, selections, previews };
  };

  const pinned = await run('0x1234');
  const unpinned = await run(null);
  assert.equal(pinned.previews, 1);
  assert.equal(unpinned.previews, 2);
  assert.equal(pinned.selections, 1);
  assert.equal(unpinned.selections, 2);
  assert.ok([...pinned.quoteCounts.values()].every(count => count === 1));
  assert.ok([...unpinned.quoteCounts.values()].some(count => count > 1));
});

test('post-swap-price refinements cannot return a worse capacity mismatch than the initial plan', async () => {
  const input = {
    ...base,
    async previewSwap(plan) {
      const tick = plan.rawAmountIn > 100_000n ? 45 : 35;
      return { tick, sqrtPriceX96: getSqrtPriceAtTick(tick), marker: String(plan.rawAmountIn) };
    }
  };
  const initial = await buildRangeBalancedSwapPlan({ ...input, maxRefinements: 0 });
  const refined = await buildRangeBalancedSwapPlan(input);
  assert.ok(refined.capacityMismatchBps <= initial.capacityMismatchBps);
  assert.ok(refined.refinements <= 2);
});

test('balance calculations use projected price while quote impact remains anchored to original spot', async () => {
  let selectedSpot = null;
  const quoter = {
    async selectSamePairSwapPool(_pool, _tokenIn, _amount, _slippage, options) {
      selectedSpot = BigInt(options.spotSqrtPriceX96);
      return { pool };
    },
    async quoteExactInputSingleRaw(_pool, tokenIn, rawAmountIn) {
      const input = BigInt(rawAmountIn);
      const output = input * 99n / 100n;
      return {
        rawAmountIn: input.toString(), rawAmountOut: output.toString(),
        minRawAmountOut: output.toString(),
        tokenIn: tokenIn === 0 ? pool.token0.address : pool.token1.address,
        tokenOut: tokenIn === 0 ? pool.token1.address : pool.token0.address
      };
    }
  };
  const result = await buildExactBalancedSwapPlan({
    pool, quoter, rawAmount0: 1_000_000n, rawAmount1: 100_000n,
    sqrtPriceX96: Q96, balanceSqrtPriceX96: getSqrtPriceAtTick(50),
    tickLower: -100, tickUpper: 100, maxPriceImpactBps: 350
  });
  assert.equal(selectedSpot, Q96);
  assert.equal(result.priceImpactBps, Number(quotePriceImpactBps(
    result.rawAmountIn, result.quote.rawAmountOut, result.tokenIn, Q96
  )));
});

test('top-up can pin its existing LP range and a balanced no-swap path skips simulation', async () => {
  const target = { tickLower: -100, tickUpper: 100 };
  let previews = 0;
  const result = await buildRangeBalancedSwapPlan({
    ...base,
    rawAmount0: 10_000n,
    rawAmount1: 10_000n,
    state: { tick: 0, sqrtPriceX96: Q96 },
    target,
    chooseTarget: null,
    async previewSwap() { previews += 1; throw new Error('balanced inventory must not simulate a swap'); }
  });
  assert.equal(result.swapPlan.direction, 'none');
  assert.deepEqual(result.target, target);
  assert.equal(result.refinements, 0);
  assert.equal(previews, 0);
});

test('missing preview price and a preview outside a pinned range fail closed', async () => {
  await assert.rejects(buildRangeBalancedSwapPlan({
    ...base, maxRefinements: 0, async previewSwap() { return { tick: 0 }; }
  }), /sqrtPriceX96/);
  await assert.rejects(buildRangeBalancedSwapPlan({
    ...base, maxRefinements: 0,
    async previewSwap() { return { tick: 101, sqrtPriceX96: getSqrtPriceAtTick(101) }; }
  }), /outside the pinned target range/);
});

test('rejects more refinements than the bounded policy permits', async () => {
  await assert.rejects(buildRangeBalancedSwapPlan({
    ...base, maxRefinements: 3, async previewSwap() { return { tick: 0, sqrtPriceX96: Q96 }; }
  }), /maxRefinements/);
});
