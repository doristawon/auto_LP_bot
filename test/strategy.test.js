import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCenteredRange,
  isOutsideRange,
  priceWidthBpsToTickDelta,
  snapTickDown,
  snapTickUp
} from '../src/math/ticks.js';
import { evaluatePosition } from '../src/strategy/tight-range.js';

test('120 bps maps to about 120 ticks', () => {
  const delta = priceWidthBpsToTickDelta(120);
  assert.ok(delta >= 119 && delta <= 121);
});

test('tick snapping expands range to spacing boundaries', () => {
  assert.equal(snapTickDown(101, 10), 100);
  assert.equal(snapTickUp(101, 10), 110);
  assert.equal(snapTickDown(-101, 10), -110);
  assert.equal(snapTickUp(-101, 10), -100);
});

test('centered range contains current tick', () => {
  const range = buildCenteredRange(12345, 10, 120);
  assert.ok(range.tickLower < 12345);
  assert.ok(range.tickUpper > 12345);
  assert.equal(range.tickLower % 10, 0);
  assert.equal(range.tickUpper % 10, 0);
});

test('boundaries count as out of range', () => {
  assert.equal(isOutsideRange(100, 100, 200), true);
  assert.equal(isOutsideRange(200, 100, 200), true);
  assert.equal(isOutsideRange(150, 100, 200), false);
});

test('rebalance requires consecutive confirmations', () => {
  const position = { tickLower: 100, tickUpper: 200 };
  const first = evaluatePosition({
    currentTick: 210,
    tickSpacing: 10,
    position,
    widthBps: 120,
    confirmationsSeen: 0,
    confirmationsRequired: 2,
    cooldownUntil: 0,
    nowMs: 10_000
  });
  assert.equal(first.shouldRebalance, false);
  assert.equal(first.nextConfirmations, 1);

  const second = evaluatePosition({
    currentTick: 211,
    tickSpacing: 10,
    position,
    widthBps: 120,
    confirmationsSeen: first.nextConfirmations,
    confirmationsRequired: 2,
    cooldownUntil: 0,
    nowMs: 11_000
  });
  assert.equal(second.shouldRebalance, true);
  assert.equal(second.nextConfirmations, 2);
});

test('cooldown suppresses rebalance', () => {
  const result = evaluatePosition({
    currentTick: 210,
    tickSpacing: 10,
    position: { tickLower: 100, tickUpper: 200 },
    widthBps: 120,
    confirmationsSeen: 4,
    confirmationsRequired: 2,
    cooldownUntil: 20_000,
    nowMs: 10_000
  });
  assert.equal(result.shouldRebalance, false);
  assert.equal(result.cooldownActive, true);
});
