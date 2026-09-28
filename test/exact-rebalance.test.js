import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExactBalancedSwapPlan } from '../src/execution/exact-rebalance.js';
import { getSqrtPriceAtTick } from '../src/math/v4-fixed.js';

const pool = {
  token0: { address: '0x0000000000000000000000000000000000000001', decimals: 18 },
  token1: { address: '0x0000000000000000000000000000000000000002', decimals: 18 }
};

function symmetricQuoter() {
  return {
    async quoteExactInputSingleRaw(_pool, tokenIn, rawAmountIn, slippageBps) {
      rawAmountIn = BigInt(rawAmountIn);
      return {
        rawAmountIn: rawAmountIn.toString(),
        rawAmountOut: rawAmountIn.toString(),
        minRawAmountOut: (rawAmountIn * BigInt(10000 - slippageBps) / 10000n).toString(),
        tokenIn: tokenIn === 0 ? pool.token0.address : pool.token1.address,
        tokenOut: tokenIn === 0 ? pool.token1.address : pool.token0.address,
        zeroForOne: tokenIn === 0
      };
    }
  };
}

test('exact receipt inventory balancer selects token0 -> token1 when token0 liquidity capacity dominates', async () => {
  const plan = await buildExactBalancedSwapPlan({
    pool,
    quoter: symmetricQuoter(),
    rawAmount0: 1_000_000_000_000_000_000_000n,
    rawAmount1: 100_000_000_000_000_000_000n,
    sqrtPriceX96: getSqrtPriceAtTick(0),
    tickLower: -200,
    tickUpper: 200,
    slippageBps: 50,
    iterations: 24
  });
  assert.equal(plan.direction, '0_to_1');
  assert.ok(plan.rawAmountIn > 0n);
  assert.ok(plan.quote);
});

test('exact receipt inventory balancer selects token1 -> token0 when token1 liquidity capacity dominates', async () => {
  const plan = await buildExactBalancedSwapPlan({
    pool,
    quoter: symmetricQuoter(),
    rawAmount0: 100_000_000_000_000_000_000n,
    rawAmount1: 1_000_000_000_000_000_000_000n,
    sqrtPriceX96: getSqrtPriceAtTick(0),
    tickLower: -200,
    tickUpper: 200,
    slippageBps: 50,
    iterations: 24
  });
  assert.equal(plan.direction, '1_to_0');
  assert.ok(plan.rawAmountIn > 0n);
  assert.ok(plan.quote);
});

test('exact balancer refuses swap quotes above configured spot price-impact limit', async () => {
  const expensiveQuoter = {
    async quoteExactInputSingleRaw(_pool, tokenIn, rawAmountIn, slippageBps) {
      rawAmountIn = BigInt(rawAmountIn);
      const rawAmountOut = rawAmountIn * 95n / 100n;
      return {
        rawAmountIn: rawAmountIn.toString(),
        rawAmountOut: rawAmountOut.toString(),
        minRawAmountOut: (rawAmountOut * BigInt(10000 - slippageBps) / 10000n).toString(),
        tokenIn: tokenIn === 0 ? pool.token0.address : pool.token1.address,
        tokenOut: tokenIn === 0 ? pool.token1.address : pool.token0.address
      };
    }
  };
  const plan = await buildExactBalancedSwapPlan({
    pool,
    quoter: expensiveQuoter,
    rawAmount0: 1_000_000_000_000_000_000_000n,
    rawAmount1: 100_000_000_000_000_000_000n,
    sqrtPriceX96: getSqrtPriceAtTick(0),
    tickLower: -200,
    tickUpper: 200,
    maxPriceImpactBps: 200
  });
  assert.equal(plan.direction, 'none');
  assert.equal(plan.blockedReason, 'no-quote-within-price-impact-limit');
});

test('USDG remainder preference leaves more capacity on the chosen stablecoin side', async () => {
  const base = {
    pool, quoter: symmetricQuoter(),
    rawAmount0: 1_000_000_000_000_000_000_000n,
    rawAmount1: 100_000_000_000_000_000_000n,
    sqrtPriceX96: getSqrtPriceAtTick(0),
    tickLower: -200, tickUpper: 200,
    slippageBps: 50, iterations: 32
  };
  const neutral = await buildExactBalancedSwapPlan(base);
  const preferToken1 = await buildExactBalancedSwapPlan({
    ...base, preferRemainderTokenIndex: 1, preferredRemainderBps: 25
  });
  assert.equal(preferToken1.direction, '0_to_1');
  assert.ok(preferToken1.rawAmountIn > neutral.rawAmountIn);

  const reverse = { ...base, rawAmount0: base.rawAmount1, rawAmount1: base.rawAmount0 };
  const neutralReverse = await buildExactBalancedSwapPlan(reverse);
  const preferToken1Reverse = await buildExactBalancedSwapPlan({
    ...reverse, preferRemainderTokenIndex: 1, preferredRemainderBps: 25
  });
  assert.equal(preferToken1Reverse.direction, '1_to_0');
  assert.ok(preferToken1Reverse.rawAmountIn < neutralReverse.rawAmountIn);
});
