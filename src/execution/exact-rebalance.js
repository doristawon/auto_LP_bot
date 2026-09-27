import {
  getLiquidityForAmount0,
  getLiquidityForAmount1,
  getSqrtPriceAtTick
} from '../math/v4-fixed.js';

const MAX_UINT128 = (1n << 128n) - 1n;

export async function buildExactBalancedSwapPlan({
  pool,
  quoter,
  rawAmount0,
  rawAmount1,
  sqrtPriceX96,
  tickLower,
  tickUpper,
  slippageBps = 50,
  iterations = 22,
  maxPriceImpactBps = 200
}) {
  rawAmount0 = BigInt(rawAmount0);
  rawAmount1 = BigInt(rawAmount1);
  const sqrtX = BigInt(sqrtPriceX96);
  if (rawAmount0 < 0n || rawAmount1 < 0n) throw new Error('Inventory amounts must be non-negative');
  if (!Number.isInteger(Number(maxPriceImpactBps)) || Number(maxPriceImpactBps) < 0 || Number(maxPriceImpactBps) >= 10_000) {
    throw new Error('maxPriceImpactBps must be an integer from 0 through 9999');
  }
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper) || tickLower >= tickUpper) {
    throw new Error('Target range ticks are invalid');
  }
  const sqrtA = getSqrtPriceAtTick(tickLower);
  const sqrtB = getSqrtPriceAtTick(tickUpper);
  if (!(sqrtA < sqrtX && sqrtX < sqrtB)) {
    throw new Error('Target range must contain the current price before balancing inventory');
  }

  const initial = capacities(rawAmount0, rawAmount1, sqrtX, sqrtA, sqrtB);
  if (balancedEnough(initial.l0, initial.l1)) {
    return { direction: 'none', tokenIn: null, tokenOut: null, rawAmountIn: 0n, quote: null };
  }

  const tokenIn = initial.l0 > initial.l1 ? 0 : 1;
  const tokenOut = tokenIn === 0 ? 1 : 0;
  const available = tokenIn === 0 ? rawAmount0 : rawAmount1;
  if (available <= 1n) return { direction: 'none', tokenIn: null, tokenOut: null, rawAmountIn: 0n, quote: null };

  let lo = 1n;
  let hi = available < MAX_UINT128 ? available : MAX_UINT128;
  let best = null;
  for (let i = 0; i < iterations && lo <= hi; i++) {
    const mid = (lo + hi) >> 1n;
    const quote = await quoter.quoteExactInputSingleRaw(pool, tokenIn, mid, slippageBps);
    if (BigInt(quote.rawAmountIn) !== mid) {
      throw new Error('Balancer quote input does not match the requested exact-input amount');
    }
    const out = BigInt(quote.rawAmountOut);
    const minOut = BigInt(quote.minRawAmountOut);
    if (out <= 0n || minOut <= 0n || minOut > out) {
      throw new Error('Balancer quote has an invalid output or minimum output');
    }
    const impactBps = quotePriceImpactBps(mid, out, tokenIn, sqrtX);
    if (impactBps > BigInt(maxPriceImpactBps)) {
      hi = mid - 1n;
      continue;
    }
    const post0 = tokenIn === 0 ? rawAmount0 - mid : rawAmount0 + out;
    const post1 = tokenIn === 1 ? rawAmount1 - mid : rawAmount1 + out;
    const cap = capacities(post0, post1, sqrtX, sqrtA, sqrtB);
    const score = abs(cap.l0 - cap.l1);
    if (!best || score < best.score) best = { score, mid, quote, post0, post1, cap, impactBps };

    if (tokenIn === 0) {
      if (cap.l0 > cap.l1) lo = mid + 1n;
      else hi = mid - 1n;
    } else {
      if (cap.l1 > cap.l0) lo = mid + 1n;
      else hi = mid - 1n;
    }
  }

  if (!best || best.mid <= 0n) {
    return {
      direction: 'none',
      tokenIn: null,
      tokenOut: null,
      rawAmountIn: 0n,
      quote: null,
      blockedReason: 'no-quote-within-price-impact-limit'
    };
  }
  return {
    direction: tokenIn === 0 ? '0_to_1' : '1_to_0',
    tokenIn,
    tokenOut,
    rawAmountIn: best.mid,
    quote: best.quote,
    priceImpactBps: Number(best.impactBps),
    projectedRaw0: best.post0,
    projectedRaw1: best.post1
  };
}

function capacities(amount0, amount1, sqrtX, sqrtA, sqrtB) {
  return {
    l0: getLiquidityForAmount0(sqrtX, sqrtB, amount0),
    l1: getLiquidityForAmount1(sqrtA, sqrtX, amount1)
  };
}
function balancedEnough(a, b) {
  const max = a > b ? a : b;
  if (max === 0n) return true;
  return abs(a - b) * 10000n <= max;
}
function abs(x) { return x < 0n ? -x : x; }

export function quotePriceImpactBps(rawAmountIn, rawAmountOut, tokenInIndex, sqrtPriceX96) {
  rawAmountIn = BigInt(rawAmountIn);
  rawAmountOut = BigInt(rawAmountOut);
  const sqrtX = BigInt(sqrtPriceX96);
  if (rawAmountIn <= 0n || rawAmountOut <= 0n || ![0, 1].includes(tokenInIndex) || sqrtX <= 0n) {
    throw new Error('Cannot calculate price impact from invalid swap values');
  }
  const q192 = 1n << 192n;
  const sqrtSquared = sqrtX * sqrtX;
  const expectedOut = tokenInIndex === 0
    ? rawAmountIn * sqrtSquared / q192
    : rawAmountIn * q192 / sqrtSquared;
  if (expectedOut <= 0n) throw new Error('Pool spot quote rounds to zero');
  if (rawAmountOut >= expectedOut) return 0n;
  return (expectedOut - rawAmountOut) * 10_000n / expectedOut;
}
