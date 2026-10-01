import { buildExactDepositPlan, assertUint128 } from '../math/v4-fixed.js';

// Keep the authorized inventory as the spend caps. Token allowance maxima are
// not a new inventory: using them as funding applies a second liquidity haircut.
export function buildInventoryDepositPlan(options) {
  const raw0 = BigInt(options.rawAmount0), raw1 = BigInt(options.rawAmount1);
  const tolerance = options.tickToleranceTicks ?? -1;
  const plan = buildExactDepositPlan({ ...options,
    tickToleranceTicks: tolerance === -1 ? 1 : tolerance });
  return { ...plan, amount0Max: assertUint128(raw0, 'inventory amount0Max'),
    amount1Max: assertUint128(raw1, 'inventory amount1Max'),
    basis: 'single inventory sizing with fixed authorized token caps' };
}
