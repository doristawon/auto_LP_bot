const Q96 = 2 ** 96;

export function targetAmountsPerLiquidity({ sqrtPriceX96, tickLower, tickUpper, decimals0, decimals1 }) {
  const sp = Number(sqrtPriceX96) / Q96;
  const sa = Math.pow(1.0001, tickLower / 2);
  const sb = Math.pow(1.0001, tickUpper / 2);
  if (!(sp > 0) || !(sb > sa)) throw new Error('Invalid target range/price');
  let raw0 = 0;
  let raw1 = 0;
  if (sp <= sa) raw0 = (sb - sa) / (sa * sb);
  else if (sp >= sb) raw1 = sb - sa;
  else {
    raw0 = (sb - sp) / (sp * sb);
    raw1 = sp - sa;
  }
  return {
    amount0PerL: raw0 / Math.pow(10, decimals0),
    amount1PerL: raw1 / Math.pow(10, decimals1)
  };
}

export function buildRebalanceInventoryPlan({
  amount0,
  amount1,
  price0Usd,
  price1Usd,
  sqrtPriceX96,
  tickLower,
  tickUpper,
  decimals0,
  decimals1
}) {
  const unit = targetAmountsPerLiquidity({ sqrtPriceX96, tickLower, tickUpper, decimals0, decimals1 });
  const unitValueUsd = unit.amount0PerL * price0Usd + unit.amount1PerL * price1Usd;
  const totalValueUsd = amount0 * price0Usd + amount1 * price1Usd;
  if (!(unitValueUsd > 0) || !(totalValueUsd >= 0)) throw new Error('Unable to value rebalance inventory');
  const scale = totalValueUsd / unitValueUsd;
  const target0 = unit.amount0PerL * scale;
  const target1 = unit.amount1PerL * scale;
  const delta0 = target0 - amount0;
  const delta1 = target1 - amount1;
  const toleranceUsd = Math.max(0.01, totalValueUsd * 0.0001);
  let direction = 'none';
  let amountIn = 0;
  let tokenIn = null;
  let tokenOut = null;
  if (delta0 > 0 && -delta1 * price1Usd > toleranceUsd) {
    direction = '1_to_0';
    amountIn = Math.min(amount1, Math.max(0, -delta1));
    tokenIn = 1;
    tokenOut = 0;
  } else if (delta1 > 0 && -delta0 * price0Usd > toleranceUsd) {
    direction = '0_to_1';
    amountIn = Math.min(amount0, Math.max(0, -delta0));
    tokenIn = 0;
    tokenOut = 1;
  }
  return { totalValueUsd, target0, target1, delta0, delta1, direction, amountIn, tokenIn, tokenOut };
}
