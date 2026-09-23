import { buildCenteredRange, isOutsideRange } from '../math/ticks.js';

export function evaluatePosition({
  currentTick,
  tickSpacing,
  position,
  widthBps,
  edgeBufferTicks = 0,
  confirmationsSeen = 0,
  confirmationsRequired = 2,
  cooldownUntil = 0,
  nowMs = Date.now()
}) {
  const outside = isOutsideRange(
    currentTick,
    position.tickLower,
    position.tickUpper,
    edgeBufferTicks
  );

  const nextConfirmations = outside ? confirmationsSeen + 1 : 0;
  const target = buildCenteredRange(currentTick, tickSpacing, widthBps);
  const cooldownActive = nowMs < cooldownUntil;
  const shouldRebalance = outside && !cooldownActive && nextConfirmations >= confirmationsRequired;

  return {
    outside,
    nextConfirmations,
    cooldownActive,
    shouldRebalance,
    target
  };
}
