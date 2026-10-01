import { buildExactBalancedSwapPlan } from './exact-rebalance.js';
import { getLiquidityForAmount0, getLiquidityForAmount1, getSqrtPriceAtTick } from '../math/v4-fixed.js';

const MAX_REFINEMENTS = 2;

/**
 * Balance a pair for a pinned range, using simulated post-swap prices to refine
 * the input amount while keeping quote impact measured at the original spot.
 */
export async function buildRangeBalancedSwapPlan({
  pool,
  quoter,
  rawAmount0,
  rawAmount1,
  state,
  target,
  chooseTarget = null,
  previewSwap,
  slippageBps = 50,
  maxPriceImpactBps = 200,
  preferRemainderTokenIndex = null,
  preferredRemainderBps = 0,
  maxRefinements = MAX_REFINEMENTS,
  expectedOutput = false
} = {}) {
  rawAmount0 = BigInt(rawAmount0);
  rawAmount1 = BigInt(rawAmount1);
  if (rawAmount0 < 0n || rawAmount1 < 0n) throw new Error('Inventory amounts must be non-negative');
  if (!state || !Number.isInteger(Number(state.tick)) || BigInt(state.sqrtPriceX96 || 0) <= 0n) {
    throw new Error('Initial pool state must include a valid tick and sqrtPriceX96');
  }
  if (chooseTarget !== null && typeof chooseTarget !== 'function') {
    throw new TypeError('chooseTarget must be null or a function');
  }
  if (typeof previewSwap !== 'function') throw new TypeError('previewSwap must be a function');
  const refinementLimit = expectedOutput ? 4 : MAX_REFINEMENTS;
  if (!Number.isInteger(maxRefinements) || maxRefinements < 0 || maxRefinements > refinementLimit) {
    throw new RangeError(`maxRefinements must be an integer from 0 through ${refinementLimit}`);
  }

  const spotSqrtPriceX96 = BigInt(state.sqrtPriceX96);
  let pinnedTarget = validateTarget(target, state);
  const makePlan = (balanceSqrtPriceX96) => buildExactBalancedSwapPlan({
    pool,
    quoter,
    rawAmount0,
    rawAmount1,
    sqrtPriceX96: spotSqrtPriceX96,
    balanceSqrtPriceX96,
    tickLower: pinnedTarget.tickLower,
    tickUpper: pinnedTarget.tickUpper,
    slippageBps,
    maxPriceImpactBps,
    preferRemainderTokenIndex,
    preferredRemainderBps,
    atomicRoutesOnly: expectedOutput
  });

  let initialPlan = await makePlan(spotSqrtPriceX96);
  if (initialPlan.blockedReason) throw new Error(`Range-balanced swap is blocked: ${initialPlan.blockedReason}`);
  if (initialPlan.direction === 'none') {
    return {
      swapPlan: initialPlan,
      target: pinnedTarget,
      postState: { ...state, tick: Number(state.tick), sqrtPriceX96: spotSqrtPriceX96 },
      refinements: 0,
      capacityMismatchBps: mismatchBps(rawAmount0, rawAmount1, spotSqrtPriceX96, pinnedTarget)
    };
  }

  let postState = validatePreview(await previewSwap(initialPlan), state, null);
  if (chooseTarget) {
    pinnedTarget = validateTarget(await chooseTarget(postState.tick), postState);
  } else {
    validateTarget(pinnedTarget, postState);
  }

  let best = evaluate(initialPlan, pinnedTarget, postState, rawAmount0, rawAmount1, expectedOutput);
  let balancePrice = postState.sqrtPriceX96;
  let refinements = 0;

  for (let index = 0; index < maxRefinements; index += 1) {
    const refined = await makePlan(balancePrice);
    refinements += 1;
    if (refined.blockedReason) break;
    if (refined.direction === 'none') {
      const unchangedState = { ...state, tick: Number(state.tick), sqrtPriceX96: spotSqrtPriceX96 };
      try {
        validateTarget(pinnedTarget, unchangedState);
        const candidate = evaluate(refined, pinnedTarget, unchangedState, rawAmount0, rawAmount1, expectedOutput);
        if (candidate.capacityMismatchBps < best.capacityMismatchBps) best = candidate;
      } catch {}
      break;
    }
    const refinedState = validatePreview(await previewSwap(refined), state, pinnedTarget);
    const candidate = evaluate(refined, pinnedTarget, refinedState, rawAmount0, rawAmount1, expectedOutput);
    if (candidate.capacityMismatchBps < best.capacityMismatchBps) best = candidate;
    if (expectedOutput && best.capacityMismatchBps <= 10) break;
    balancePrice = refinedState.sqrtPriceX96;
  }

  return {
    swapPlan: best.swapPlan,
    target: best.target,
    postState: best.postState,
    refinements,
    capacityMismatchBps: best.capacityMismatchBps
  };
}

function validateTarget(target, state) {
  const tickLower = Number(target?.tickLower);
  const tickUpper = Number(target?.tickUpper);
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper) || tickLower >= tickUpper) {
    throw new Error('Pinned target range is invalid');
  }
  if (!Number.isInteger(Number(state?.tick)) || Number(state.tick) < tickLower || Number(state.tick) >= tickUpper) {
    throw new Error('Pool price is outside the pinned target range');
  }
  const sqrt = BigInt(state.sqrtPriceX96);
  if (!(getSqrtPriceAtTick(tickLower) < sqrt && sqrt < getSqrtPriceAtTick(tickUpper))) {
    throw new Error('Pool sqrt price is outside the pinned target range');
  }
  return { ...target, tickLower, tickUpper };
}

function validatePreview(preview, previousState, pinnedTarget) {
  const tick = Number(preview?.tick);
  let sqrtPriceX96;
  try { sqrtPriceX96 = BigInt(preview?.sqrtPriceX96); }
  catch { throw new Error('Swap preview omitted a valid sqrtPriceX96'); }
  if (!Number.isInteger(tick) || sqrtPriceX96 <= 0n) {
    throw new Error('Swap preview omitted a valid tick or sqrtPriceX96');
  }
  const result = { ...previousState, ...preview, tick, sqrtPriceX96 };
  if (pinnedTarget) validateTarget(pinnedTarget, result);
  return result;
}

function evaluate(swapPlan, target, postState, rawAmount0, rawAmount1, expectedOutput) {
  const inventory = projectedInventory(swapPlan, rawAmount0, rawAmount1, expectedOutput);
  return {
    swapPlan,
    target,
    postState,
    capacityMismatchBps: mismatchBps(
      inventory.raw0, inventory.raw1, postState.sqrtPriceX96, target
    )
  };
}

function projectedInventory(plan, rawAmount0, rawAmount1, expectedOutput) {
  if (!plan || plan.direction === 'none') return { raw0: rawAmount0, raw1: rawAmount1 };
  const amountIn = BigInt(plan.rawAmountIn);
  const amountOut = BigInt((expectedOutput ? plan.quote?.rawAmountOut : plan.quote?.minRawAmountOut) ?? 0);
  if (amountIn <= 0n || amountOut <= 0n) throw new Error('Swap plan is missing conservative input/output amounts');
  if (plan.tokenIn === 0) {
    if (amountIn > rawAmount0) throw new Error('Swap input exceeds available token0 inventory');
    return { raw0: rawAmount0 - amountIn, raw1: rawAmount1 + amountOut };
  }
  if (plan.tokenIn === 1) {
    if (amountIn > rawAmount1) throw new Error('Swap input exceeds available token1 inventory');
    return { raw0: rawAmount0 + amountOut, raw1: rawAmount1 - amountIn };
  }
  throw new Error('Swap plan has an invalid token input index');
}

function mismatchBps(rawAmount0, rawAmount1, sqrtPriceX96, target) {
  const sqrt = BigInt(sqrtPriceX96);
  const sqrtA = getSqrtPriceAtTick(target.tickLower);
  const sqrtB = getSqrtPriceAtTick(target.tickUpper);
  if (!(sqrtA < sqrt && sqrt < sqrtB)) throw new Error('Cannot measure capacity outside pinned range');
  const capacity0 = getLiquidityForAmount0(sqrt, sqrtB, BigInt(rawAmount0));
  const capacity1 = getLiquidityForAmount1(sqrtA, sqrt, BigInt(rawAmount1));
  const max = capacity0 > capacity1 ? capacity0 : capacity1;
  if (max === 0n) return 0;
  const delta = capacity0 > capacity1 ? capacity0 - capacity1 : capacity1 - capacity0;
  return Number(delta * 10_000n / max);
}
