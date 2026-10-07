import { buildTargetRange, snapTickDown, snapTickUp } from '../math/ticks.js';
import { MIN_TICK, MAX_TICK } from '../constants.js';
import { PONS_POOL_ID, adaptiveDecisionReady, statsReady, chooseOptimalWidth, ADAPTIVE_MODEL } from '../analytics/adaptive-range.js';
import { rangeAmounts, spotToken1PerToken0 } from '../analytics/liquidity.js';

export function buildFixedTickRange(currentTick, spacing, widthTicks) {
  if (!Number.isInteger(currentTick) || currentTick < MIN_TICK || currentTick >= MAX_TICK
    || !Number.isInteger(spacing) || spacing <= 0 || !Number.isInteger(widthTicks)
    || widthTicks < 2 * spacing || widthTicks % spacing !== 0) throw new Error('無效的總 tick 帶寬。');
  const min = snapTickUp(MIN_TICK, spacing), max = snapTickDown(MAX_TICK, spacing);
  // Odd spacing counts (Wide=47) cannot have a symmetric usable-tick center.
  let tickLower = Math.round((currentTick - widthTicks / 2) / spacing) * spacing;
  tickLower = Math.max(min, Math.min(max - widthTicks, tickLower));
  const tickUpper = tickLower + widthTicks;
  if (tickLower > currentTick || currentTick >= tickUpper || tickLower < min || tickUpper > max) throw new Error('動態區間無法包含目前價格。');
  return { tickLower, tickUpper, tickDelta: widthTicks / 2, widthTicks };
}

export function executionRangePolicy(executor) {
  return executor.config?.adaptiveRange ?? {
    settings: executor.state?.getSetting('adaptiveRangeSettings', { enabled: false }),
    stats: executor.state?.getSetting('adaptiveRangeStats', null),
    decision: executor.state?.getSetting('adaptiveRangeDecision', null)
  };
}

export function isAdaptivePool(executor, pool) {
  return Boolean(executionRangePolicy(executor)?.settings?.enabled && String(pool?.id).toLowerCase() === PONS_POOL_ID);
}

export function adaptiveHoldingSince(executor, pool, position, nowMs = Date.now()) {
  const key = `adaptiveHolding:${pool.id.toLowerCase()}:${position.id.toLowerCase()}`;
  const saved = Number(executor.state?.getSetting(key, 0));
  // Accounting baselines can survive full exit and later reuse of the same ticks.
  // Only the holding clock belongs to this episode; unknown age starts now.
  const start = Number.isFinite(saved) && saved > 0 && saved <= nowMs ? saved : nowMs;
  if (start !== saved) executor.state?.setSetting(key, start);
  return start;
}

export function syncAdaptiveHoldingTopology(state, pools, previousRanges, currentRanges, nowMs = Date.now()) {
  const pool = pools.find(p => String(p.id).toLowerCase() === PONS_POOL_ID);
  if (!pool) return;
  const prefix = `${String(pool.key?.hooks ?? pool.hook).toLowerCase()}|`;
  const before = new Set(previousRanges.map(x => String(x).toLowerCase()));
  const after = new Set(currentRanges.map(x => String(x).toLowerCase()));
  for (const range of new Set([...before, ...after])) {
    if (!range.startsWith(prefix) || before.has(range) === after.has(range)) continue;
    state.setSetting(`adaptiveHolding:${PONS_POOL_ID}:${range.slice(prefix.length)}`, after.has(range) ? nowMs : 0);
  }
}

export async function prepareAdaptiveExecution(executor, plan, pool) {
  if (!isAdaptivePool(executor, pool)) return;
  const policy = executor.adaptiveRangeContext ?? executionRangePolicy(executor);
  // Freeze one decision for withdrawal, official reposition, swap and atomic deposit.
  if (executor.adaptiveRangeContext?.prepared) return;
  if (!statsReady(policy.stats)) throw new Error('PONS 24 小時 Swap 資料不足或過舊，暫緩重新投入。');
  const state = await executor.fables.readPoolState(pool);
  const stableIndex = [pool.token0,pool.token1].findIndex(t=>t.address.toLowerCase()===executor.config.usdgAddress.toLowerCase());
  if (stableIndex < 0 || pool.key.tickSpacing !== 60) throw new Error('PONS pair configuration mismatch');
  let balances = await executor.readRawPairBalances(pool);
  if (plan.allocationFundingScope) balances = executor.clipPairToAllocation(pool, balances, plan.allocationFundingScope);
  const ratio = spotToken1PerToken0(state.sqrtPriceX96,pool.token0.decimals,pool.token1.decimals);
  const price0=stableIndex===0?1:ratio, price1=stableIndex===1?1:1/ratio;
  let sizeUsd=Number(balances.raw0)/10**pool.token0.decimals*price0+Number(balances.raw1)/10**pool.token1.decimals*price1;
  let activeLiquidity=Number(state.liquidity);
  if (plan.position && BigInt(plan.position.shares||0)>0n) {
    const source=plan.pool;
    const same=source.id.toLowerCase()===pool.id.toLowerCase();
    const sourceState=same?state:await executor.fables.readPoolState(source);
    const shares=await executor.readPositionShares(source,plan.position.id);
    const amounts=rangeAmounts(shares,sourceState.sqrtPriceX96,plan.position.tickLower,plan.position.tickUpper,source.token0.decimals,source.token1.decimals);
    if(same) {
      sizeUsd+=(amounts.amount0+Number(plan.position.owed0||0)/10**pool.token0.decimals)*price0
        +(amounts.amount1+Number(plan.position.owed1||0)/10**pool.token1.decimals)*price1;
      if(sourceState.tick>=plan.position.tickLower&&sourceState.tick<plan.position.tickUpper)activeLiquidity-=Number(shares);
    } else {
      const a=executor.getUsdPrice(source.token0.address),b=executor.getUsdPrice(source.token1.address);
      if(!(a>0&&b>0))throw new Error('Adaptive source valuation unavailable');
      sizeUsd+=amounts.amount0*a+amounts.amount1*b;
    }
  }
  const result=chooseOptimalWidth({...policy.stats,activeLiquidity:Math.max(0,activeLiquidity),tick:state.tick,sizeUsd,
    spacing:pool.key.tickSpacing,decimals0:pool.token0.decimals,decimals1:pool.token1.decimals,stableIndex,
    rangeForWidth:width=>buildFixedTickRange(state.tick,pool.key.tickSpacing,width)});
  const decision={...result,observedAt:policy.stats.observedAt,chosenAt:Date.now()};
  executor.state?.setSetting('adaptiveRangeDecision',decision);
  if (executor.config.adaptiveRange) executor.config.adaptiveRange.decision=decision;
  executor.ledger?.append('execution.adaptive_range_selected',decision);
  if(result.status!=='ready')throw new Error('PONS 所有區間皆超過每日 6 次模型再平衡上限，暫不撤池。');
  if(executor.adaptiveRangeContext)Object.assign(executor.adaptiveRangeContext,{decision,prepared:true});
  pool.state=state;
}

export function assertAdaptiveMinimumHold(executor, pool, position) {
  if(isAdaptivePool(executor,pool)&&Date.now()-adaptiveHoldingSince(executor,pool,position)<ADAPTIVE_MODEL.minHoldMs)
    throw new Error('PONS 自適應部位尚未持有滿 1 小時，暫不再平衡。');
}

export function assertAdaptiveRangeReady(executor, pool) {
  const policy = executor.adaptiveRangeContext ?? executionRangePolicy(executor);
  if (policy?.settings?.enabled && String(pool.id).toLowerCase() === PONS_POOL_ID) {
    if (pool.key.tickSpacing !== 60 || !adaptiveDecisionReady(policy.decision, policy.asOf ?? Date.now())) {
      throw new Error('PONS 動態帶寬資料不足或過舊；保留部位，等待下一次有效觀測。');
    }
    return policy.decision.widthTicks;
  }
  return null;
}

export function buildExecutionTargetRange(executor, pool, currentTick) {
  const width = assertAdaptiveRangeReady(executor, pool);
  if (width) return buildFixedTickRange(currentTick, pool.key.tickSpacing, width);
  return buildTargetRange(currentTick, pool.key.tickSpacing, executor.config.tightWidthBps, executor.config.rangePreset);
}
