import { valueSwapFeeInUsd } from './points-accounting.js';

export const PONS_POOL_ID = '0x486435a1f76cd58193f854c6e6213cd05fd58d637865d02065ff558b387fa6ea';
export const ADAPTIVE_REFRESH_MS = 60 * 60_000;
export const ADAPTIVE_MAX_AGE_MS = 75 * 60_000;
export const ADAPTIVE_MODEL = Object.freeze({ kCal: 2.9, lambda: 0.22, windowHours: 24,
  maxRebalancesPerDay: 6, minSpacings: 2, maxSpacings: 80, minHoldMs: 3600_000 });

export function normalizeAdaptiveRangeSettings(value = { enabled: false }) {
  if (typeof value?.enabled !== 'boolean') throw new Error('動態帶寬 enabled 必須為布林值。');
  if (value.poolId && String(value.poolId).toLowerCase() !== PONS_POOL_ID) throw new Error('動態帶寬只支援指定 PONS/USDG 池。');
  return { enabled: value.enabled, poolId: PONS_POOL_ID, model: 'net-yield-v2', ...ADAPTIVE_MODEL, version: 2 };
}

export function statsReady(stats, nowMs = Date.now()) {
  return stats?.status === 'ready' && Number.isFinite(stats.observedAt)
    && nowMs >= stats.observedAt - 30_000 && nowMs - stats.observedAt <= ADAPTIVE_MAX_AGE_MS
    && [stats.sigma, stats.drift, stats.feesPerDayUsd, stats.averageFee].every(Number.isFinite)
    && stats.sigma >= 0 && stats.feesPerDayUsd >= 0 && stats.averageFee >= 0 && stats.averageFee < 1;
}

export function adaptiveDecisionReady(decision, nowMs = Date.now()) {
  return decision?.model === 'net-yield-v2' && decision?.status === 'ready'
    && Number.isInteger(decision.widthTicks) && decision.widthTicks >= 120 && decision.widthTicks <= 4800
    && decision.widthTicks % 60 === 0 && Number.isFinite(decision.observedAt)
    && nowMs >= decision.observedAt - 30_000 && nowMs - decision.observedAt <= ADAPTIVE_MAX_AGE_MS;
}

// Actual raw-token tick and decimals; USDG is the $1 accounting unit.
export function liquidityForUsd({ sizeUsd, tick, tickLower, tickUpper, decimals0, decimals1, stableIndex }) {
  if (![sizeUsd,tick,tickLower,tickUpper,decimals0,decimals1].every(Number.isFinite)
    || sizeUsd <= 0 || tickLower >= tickUpper || ![0,1].includes(stableIndex)
    || ![decimals0,decimals1].every(d=>Number.isInteger(d)&&d>=0&&d<=36)) throw new Error('Invalid adaptive liquidity inputs');
  const sp=1.0001**(tick/2),sa=1.0001**(tickLower/2),sb=1.0001**(tickUpper/2);
  const x=sp<=sa?(sb-sa)/(sa*sb):sp>=sb?0:(sb-sp)/(sp*sb);
  const y=sp<=sa?0:sp>=sb?sb-sa:sp-sa;
  const humanRatio=1.0001**tick*10**(decimals0-decimals1);
  const value=x/10**decimals0*(stableIndex===0?1:humanRatio)
    +y/10**decimals1*(stableIndex===1?1:1/humanRatio);
  if (!(value>0) || !Number.isFinite(value)) throw new Error('Invalid adaptive liquidity valuation');
  return sizeUsd/value;
}

export function chooseOptimalWidth({ sigma,drift,feesPerDayUsd,averageFee,activeLiquidity,tick,sizeUsd,
  spacing=60,decimals0,decimals1,stableIndex,rangeForWidth }) {
  if (![sigma,drift,feesPerDayUsd,averageFee,activeLiquidity,tick,sizeUsd].every(Number.isFinite)
    || sigma<0 || feesPerDayUsd<0 || averageFee<0 || averageFee>=1 || activeLiquidity<0 || sizeUsd<=0
    || spacing!==60 || typeof rangeForWidth!=='function') throw new Error('Invalid adaptive optimizer inputs');
  let best=null, eligibleCandidates=0;
  for(let k=2;k<=80;k++) {
    const widthTicks=spacing*k,h=widthTicks/2;
    const reb=24*ADAPTIVE_MODEL.kCal*(sigma*sigma/(h*h)+Math.abs(drift)/h);
    if(reb>ADAPTIVE_MODEL.maxRebalancesPerDay)continue;
    const range=rangeForWidth(widthTicks);
    const myLiquidity=liquidityForUsd({sizeUsd,tick,...range,decimals0,decimals1,stableIndex});
    const share=myLiquidity/(activeLiquidity+myLiquidity);
    const grossPerDayUsd=feesPerDayUsd*share;
    const costPerDayUsd=reb*(0.5*averageFee+ADAPTIVE_MODEL.lambda*Math.expm1(h*Math.log(1.0001)))*sizeUsd;
    const netPerDayUsd=grossPerDayUsd-costPerDayUsd;
    if(!Number.isFinite(netPerDayUsd))throw new Error('Nonfinite adaptive candidate');
    eligibleCandidates++;
    if(!best||netPerDayUsd>best.netPerDayUsd)best={widthTicks,...range,myLiquidity,share,grossPerDayUsd,costPerDayUsd,
      netPerDayUsd,estimatedRebalancesPerDay:reb,estimatedSurvivalHours:reb>0?24/reb:null};
  }
  if(!best)return {status:'unavailable',model:'net-yield-v2',reason:'no-feasible-width',widthTicks:null,eligibleCandidates:0};
  return {status:'ready',model:'net-yield-v2',reason:'maximum-modeled-net',...best,eligibleCandidates,sizeUsd,tick,activeLiquidity};
}

// sigma: ticks/sqrt(hour), drift: ticks/hour. Reject short-window extrapolation.
export function analyzeAdaptiveRange({ swaps,startTimestampSeconds,endTimestampSeconds,asOfTimestampSeconds,
  windowStartTimestampSeconds,pool,usdgAddress },{nowMs=Date.now()}={}) {
  const unavailable=reason=>({status:'unavailable',reason,observedAt:nowMs});
  const times=[startTimestampSeconds,endTimestampSeconds,asOfTimestampSeconds,windowStartTimestampSeconds];
  if(!times.every(x=>Number.isSafeInteger(x)&&x>0))return unavailable('invalid-time');
  if(asOfTimestampSeconds*1000>nowMs+30000||nowMs-asOfTimestampSeconds*1000>300000)return unavailable('stale-chain');
  const elapsedSeconds=endTimestampSeconds-startTimestampSeconds;
  const windowSeconds=asOfTimestampSeconds-windowStartTimestampSeconds;
  if(windowSeconds<24*3600-300||windowSeconds>24*3600+300||elapsedSeconds<23*3600
    || startTimestampSeconds<windowStartTimestampSeconds||endTimestampSeconds>asOfTimestampSeconds
    || asOfTimestampSeconds-endTimestampSeconds>3600)return unavailable('insufficient-window');
  if(!Array.isArray(swaps)||swaps.length>10000||!pool)return unavailable('invalid-samples');
  const seen=new Map();
  for(const swap of swaps){
    if(![swap?.blockNumber,swap?.logIndex,swap?.tick].every(Number.isSafeInteger)
      ||swap.blockNumber<0||swap.logIndex<0||Math.abs(swap.tick)>887272)return unavailable('invalid-samples');
    const key=swap.blockNumber+':'+swap.logIndex,prev=seen.get(key);
    if(prev&&JSON.stringify(prev)!==JSON.stringify(swap))return unavailable('conflicting-events');
    seen.set(key,swap);
  }
  const ordered=[...seen.values()].sort((a,b)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex);
  if(ordered.length<20)return unavailable('insufficient-samples');
  let sum=0,fees=0,volume=0,dustEvents=0;
  for(let i=0;i<ordered.length;i++) {
    if(i)sum+=(ordered[i].tick-ordered[i-1].tick)**2;
    try {
      const swap=ordered[i],value=valueSwapFeeInUsd({pool,swap,usdgAddress});
      // One raw unit can be consumed entirely by integer fee rounding. Keep its
      // tick in volatility, but exclude the unpriceable sub-cent fee/volume pair.
      if (!value.priced && value.reason === 'usdg-is-not-positive-output-for-non-usdg-input'
        && BigInt(value.rawInput || 0) === 1n && value.inputToken
        && (String(pool.token0.address).toLowerCase() === String(value.inputToken).toLowerCase()
          ? BigInt(swap.amount1) === 0n : BigInt(swap.amount0) === 0n)) { dustEvents++; continue; }
      if(!value.priced||!Number.isFinite(value.feeUsd)||value.feeUsd<0)return unavailable('unpriced-swap');
      const inputUsd=value.valuation==='usdg-input'?value.inputAmount:value.outputUsd+value.feeUsd;
      if(!Number.isFinite(inputUsd)||inputUsd<=0)return unavailable('unpriced-swap');
      fees+=value.feeUsd;volume+=inputUsd;
    } catch {return unavailable('invalid-swap-fee');}
  }
  if(!(volume>0))return unavailable('empty-volume');
  return {status:'ready',sigma:Math.sqrt(sum/elapsedSeconds*3600),drift:(ordered.at(-1).tick-ordered[0].tick)/(elapsedSeconds/3600),
    feesPerDayUsd:fees*86400/windowSeconds,averageFee:fees/volume,volumeUsd:volume,totalFeesUsd:fees,
    observedAt:asOfTimestampSeconds*1000,sampleCount:ordered.length,dustEvents,elapsedSeconds,windowSeconds,
    firstSwapAt:startTimestampSeconds*1000,lastSwapAt:endTimestampSeconds*1000};
}
