import { isLpOutOfRange, isOutsideRange } from '../math/ticks.js';

export function assessAuditRange(currentTick, tickLower, tickUpper, edgeBufferTicks = 0) {
  const outside = isLpOutOfRange(currentTick, tickLower, tickUpper);
  const nearEdge = !outside && edgeBufferTicks > 0
    && isOutsideRange(currentTick, tickLower, tickUpper, edgeBufferTicks);
  return {
    outside,
    nearEdge,
    autoAction: outside
      ? 'WAIT_FOR_BOT_CONFIRMATION'
      : nearEdge ? 'HOLD_IN_RANGE_NEAR_EDGE' : 'HOLD_IN_RANGE'
  };
}
