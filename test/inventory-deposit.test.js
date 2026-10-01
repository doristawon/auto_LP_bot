import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInventoryDepositPlan } from '../src/execution/inventory-deposit.js';
import { buildExactDepositPlan, getSqrtPriceAtTick, getAmountsForLiquidity } from '../src/math/v4-fixed.js';
import { RebalanceExecutor } from '../src/adapters/executor.js';

const args = { rawAmount0: 1000n * 10n ** 18n, rawAmount1: 1000n * 10n ** 18n,
  sqrtPriceX96: getSqrtPriceAtTick(0), tickLower: -120, tickUpper: 120,
  slippageBps: 50, liquidityReserveBps: 10, tickToleranceTicks: -1 };

test('single-pool deposit retains full inventory caps without a repeated liquidity haircut', () => {
  const old = buildExactDepositPlan(args), plan = buildInventoryDepositPlan(args);
  assert.equal(plan.amount0Max, args.rawAmount0);
  assert.equal(plan.amount1Max, args.rawAmount1);
  assert.ok(plan.liquidity > old.liquidity);
  const again = buildInventoryDepositPlan({ ...args,
    rawAmount0: plan.amount0Max, rawAmount1: plan.amount1Max });
  assert.equal(again.liquidity, plan.liquidity);
  assert.ok(plan.required0 * 10000n / args.rawAmount0 > 9800n);
  assert.ok(plan.required0 <= plan.amount0Max && plan.required1 <= plan.amount1Max);
});

test('full caps never exceed the scoped inventory and still fund the one-tick guard band', () => {
  for (const tick of [-60, -1, 0, 60]) {
    const plan = buildInventoryDepositPlan({ ...args, sqrtPriceX96: getSqrtPriceAtTick(tick) });
    for (const shifted of [tick - 1, tick, tick + 2]) {
      const required = getAmountsForLiquidity(getSqrtPriceAtTick(shifted),
        getSqrtPriceAtTick(-120), getSqrtPriceAtTick(120), plan.liquidity, true);
      assert.ok(required.amount0 <= args.rawAmount0 && required.amount1 <= args.rawAmount1);
    }
  }
});

test('explicit tick tolerance is preserved instead of being silently tightened', () => {
  const plan = buildInventoryDepositPlan({ ...args, tickToleranceTicks: 20 });
  const conservative = buildExactDepositPlan({ ...args, tickToleranceTicks: 20 });
  assert.equal(plan.liquidity, conservative.liquidity);
});

test('allocation deposits retain the prior capped calculation', () => {
  const executor = Object.create(RebalanceExecutor.prototype);
  assert.deepEqual(executor.buildReinvestmentDepositPlan(args, { poolId: 'scoped' }),
    buildExactDepositPlan(args));
});
