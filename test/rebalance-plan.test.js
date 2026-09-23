import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRebalanceInventoryPlan, targetAmountsPerLiquidity } from '../src/analytics/rebalance-plan.js';

test('target ratio is two-sided inside range', () => {
  const unit = targetAmountsPerLiquidity({ sqrtPriceX96: 2n ** 96n, tickLower: -120, tickUpper: 120, decimals0: 6, decimals1: 6 });
  assert.ok(unit.amount0PerL > 0);
  assert.ok(unit.amount1PerL > 0);
});

test('balanced value returns finite target', () => {
  const plan = buildRebalanceInventoryPlan({ amount0: 100, amount1: 100, price0Usd: 1, price1Usd: 1, sqrtPriceX96: 2n ** 96n, tickLower: -120, tickUpper: 120, decimals0: 6, decimals1: 6 });
  assert.ok(Number.isFinite(plan.target0));
  assert.ok(Number.isFinite(plan.target1));
  assert.ok(Math.abs(plan.target0 + plan.target1 - 200) < 1e-6);
});

test('one-sided token0 inventory plans 0_to_1 swap', () => {
  const plan = buildRebalanceInventoryPlan({ amount0: 200, amount1: 0, price0Usd: 1, price1Usd: 1, sqrtPriceX96: 2n ** 96n, tickLower: -120, tickUpper: 120, decimals0: 6, decimals1: 6 });
  assert.equal(plan.direction, '0_to_1');
  assert.ok(plan.amountIn > 0);
});
