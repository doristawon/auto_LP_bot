import { MAX_TICK, MIN_TICK } from '../constants.js';

const LOG_1_0001 = Math.log(1.0001);

export function priceWidthBpsToTickDelta(widthBps) {
  if (!Number.isFinite(widthBps) || widthBps <= 0) {
    throw new Error('widthBps must be > 0');
  }
  return Math.max(1, Math.ceil(Math.log1p(widthBps / 10_000) / LOG_1_0001));
}

export function snapTickDown(tick, spacing) {
  validateSpacing(spacing);
  return Math.floor(tick / spacing) * spacing;
}

export function snapTickUp(tick, spacing) {
  validateSpacing(spacing);
  return Math.ceil(tick / spacing) * spacing;
}

export function clampUsableTick(tick, spacing, direction) {
  const snapped = direction === 'up' ? snapTickUp(tick, spacing) : snapTickDown(tick, spacing);
  const min = snapTickUp(MIN_TICK, spacing);
  const max = snapTickDown(MAX_TICK, spacing);
  return Math.min(max, Math.max(min, snapped));
}

export function buildCenteredRange(currentTick, tickSpacing, widthBps) {
  const delta = priceWidthBpsToTickDelta(widthBps);
  let tickLower = clampUsableTick(currentTick - delta, tickSpacing, 'down');
  let tickUpper = clampUsableTick(currentTick + delta, tickSpacing, 'up');

  if (tickLower >= currentTick) tickLower = clampUsableTick(currentTick - tickSpacing, tickSpacing, 'down');
  if (tickUpper <= currentTick) tickUpper = clampUsableTick(currentTick + tickSpacing, tickSpacing, 'up');
  if (tickLower >= tickUpper) throw new Error('Unable to build a valid tick range');

  return { tickLower, tickUpper, tickDelta: delta };
}

export function isOutsideRange(currentTick, tickLower, tickUpper, edgeBufferTicks = 0) {
  return currentTick <= tickLower + edgeBufferTicks || currentTick >= tickUpper - edgeBufferTicks;
}

export function tickToRawPrice(tick) {
  return Math.pow(1.0001, tick);
}

function validateSpacing(spacing) {
  if (!Number.isInteger(spacing) || spacing <= 0) throw new Error('tickSpacing must be a positive integer');
}
