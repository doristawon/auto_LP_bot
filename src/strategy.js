import { buildTargetRange, isLpOutOfRange, isOutsideRange } from './math/ticks.js';

export function outOfRangeExcursionPct(currentTick, tickLower, tickUpper) {
  if (currentTick <= tickLower) return (Math.pow(1.0001, tickLower - currentTick) - 1) * 100;
  if (currentTick >= tickUpper) return (Math.pow(1.0001, currentTick - tickUpper) - 1) * 100;
  return 0;
}

export function evaluatePosition({
  currentTick,
  tickSpacing,
  position,
  widthBps,
  rangePreset = 'custom-bps',
  edgeBufferTicks = 0,
  lastEvaluationAt = 0,
  outOfRangeSince = 0,
  checkIntervalMs = 5 * 60 * 1000,
  confirmDelayMs = 15 * 60 * 1000,
  cooldownUntil = 0,
  nowMs = Date.now()
}) {
  // Withdrawal eligibility uses the real LP boundaries; the edge buffer is display-only.
  const outside = isLpOutOfRange(currentTick, position.tickLower, position.tickUpper);
  const nearEdge = !outside && edgeBufferTicks > 0
    && isOutsideRange(currentTick, position.tickLower, position.tickUpper, edgeBufferTicks);
  const excursionPct = outOfRangeExcursionPct(currentTick, position.tickLower, position.tickUpper);
  const target = buildTargetRange(currentTick, tickSpacing, widthBps, rangePreset);
  const cooldownActive = nowMs < cooldownUntil;
  const evaluationDue = !lastEvaluationAt || nowMs - lastEvaluationAt >= checkIntervalMs;
  const evaluatedAt = evaluationDue ? nowMs : lastEvaluationAt;

  // A live monitor sample starts or clears the episode. The first successful
  // on-chain read at/after the deadline confirms whether it is still outside.
  const nextOutOfRangeSince = outside ? (outOfRangeSince || nowMs) : 0;
  const outOfRangeElapsedMs = outside ? Math.max(0, nowMs - nextOutOfRangeSince) : 0;
  const shouldRebalance = outside && outOfRangeSince > 0
    && outOfRangeElapsedMs >= confirmDelayMs && !cooldownActive;

  return {
    outside,
    nearEdge,
    excursionPct: outside ? excursionPct : 0,
    evaluationDue,
    evaluatedAt,
    nextEvaluationAt: evaluatedAt + checkIntervalMs,
    outOfRangeSince: nextOutOfRangeSince,
    outOfRangeElapsedMs,
    cooldownActive,
    shouldRebalance,
    rebalanceReason: shouldRebalance ? 'oor_delay_confirmed' : null,
    target
  };
}
