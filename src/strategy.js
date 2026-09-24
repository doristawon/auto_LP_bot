import { buildCenteredRange, isOutsideRange } from './math/ticks.js';

export function outOfRangeExcursionPct(currentTick, tickLower, tickUpper) {
  if (currentTick <= tickLower) {
    return (Math.pow(1.0001, tickLower - currentTick) - 1) * 100;
  }
  if (currentTick >= tickUpper) {
    return (Math.pow(1.0001, currentTick - tickUpper) - 1) * 100;
  }
  return 0;
}

export function evaluatePosition({
  currentTick,
  tickSpacing,
  position,
  widthBps,
  edgeBufferTicks = 0,
  lastEvaluationAt = 0,
  outOfRangeSince = 0,
  deepConfirmationsSeen = 0,
  checkIntervalMs = 15 * 60 * 1000,
  shallowThresholdPct = 0.5,
  maxWaitMs = 90 * 60 * 1000,
  deepConfirmationsRequired = 2,
  cooldownUntil = 0,
  nowMs = Date.now()
}) {
  const outside = isOutsideRange(currentTick, position.tickLower, position.tickUpper, edgeBufferTicks);
  const excursionPct = outOfRangeExcursionPct(currentTick, position.tickLower, position.tickUpper);
  const target = buildCenteredRange(currentTick, tickSpacing, widthBps);
  const cooldownActive = nowMs < cooldownUntil;
  const evaluationDue = !lastEvaluationAt || nowMs - lastEvaluationAt >= checkIntervalMs;

  if (!evaluationDue) {
    const elapsedMs = outside && outOfRangeSince ? Math.max(0, nowMs - outOfRangeSince) : 0;
    return {
      outside,
      excursionPct,
      evaluationDue: false,
      evaluatedAt: lastEvaluationAt,
      nextEvaluationAt: lastEvaluationAt + checkIntervalMs,
      outOfRangeSince,
      outOfRangeElapsedMs: elapsedMs,
      deepConfirmations: deepConfirmationsSeen,
      cooldownActive,
      shouldRebalance: false,
      rebalanceReason: null,
      target
    };
  }

  if (!outside) {
    return {
      outside: false,
      excursionPct: 0,
      evaluationDue: true,
      evaluatedAt: nowMs,
      nextEvaluationAt: nowMs + checkIntervalMs,
      outOfRangeSince: 0,
      outOfRangeElapsedMs: 0,
      deepConfirmations: 0,
      cooldownActive,
      shouldRebalance: false,
      rebalanceReason: null,
      target
    };
  }

  const nextOutOfRangeSince = outOfRangeSince || nowMs;
  const outOfRangeElapsedMs = Math.max(0, nowMs - nextOutOfRangeSince);
  const deepConfirmations = excursionPct > shallowThresholdPct ? deepConfirmationsSeen + 1 : 0;
  const deepConfirmed = deepConfirmations >= deepConfirmationsRequired;
  const waitExpired = outOfRangeElapsedMs >= maxWaitMs;
  const shouldRebalance = !cooldownActive && (deepConfirmed || waitExpired);
  const rebalanceReason = shouldRebalance
    ? (waitExpired ? 'oor_max_wait_expired' : 'deep_oor_confirmed')
    : null;

  return {
    outside: true,
    excursionPct,
    evaluationDue: true,
    evaluatedAt: nowMs,
    nextEvaluationAt: nowMs + checkIntervalMs,
    outOfRangeSince: nextOutOfRangeSince,
    outOfRangeElapsedMs,
    deepConfirmations,
    cooldownActive,
    shouldRebalance,
    rebalanceReason,
    target
  };
}
