import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCenteredRange, isOutsideRange, priceWidthBpsToTickDelta } from '../src/math/ticks.js';
import { evaluatePosition } from '../src/strategy.js';

test('Tight 120 bps is about 120 ticks before spacing snap', () => {
  const delta = priceWidthBpsToTickDelta(120);
  assert.ok(delta >= 119 && delta <= 121);
});

test('centered range expands to tick spacing and contains spot', () => {
  const r = buildCenteredRange(12345, 10, 120);
  assert.ok(r.tickLower < 12345 && r.tickUpper > 12345);
  assert.equal(r.tickLower % 10, 0);
  assert.equal(r.tickUpper % 10, 0);
});

test('range boundary counts as out-of-range', () => {
  assert.equal(isOutsideRange(100, 100, 200), true);
  assert.equal(isOutsideRange(150, 100, 200), false);
  assert.equal(isOutsideRange(200, 100, 200), true);
});

test('rebalance needs confirmations', () => {
  const base = { currentTick: 220, tickSpacing: 10, position: { tickLower: 100, tickUpper: 200 }, widthBps: 120, confirmationsRequired: 2, cooldownUntil: 0 };
  const first = evaluatePosition({ ...base, confirmationsSeen: 0, nowMs: 1000 });
  assert.equal(first.shouldRebalance, false);
  const second = evaluatePosition({ ...base, confirmationsSeen: first.nextConfirmations, nowMs: 2000 });
  assert.equal(second.shouldRebalance, true);
});

test('cooldown blocks churn', () => {
  const x = evaluatePosition({ currentTick: 220, tickSpacing: 10, position: { tickLower: 100, tickUpper: 200 }, widthBps: 120, confirmationsSeen: 3, confirmationsRequired: 2, cooldownUntil: 10000, nowMs: 5000 });
  assert.equal(x.cooldownActive, true);
  assert.equal(x.shouldRebalance, false);
});
