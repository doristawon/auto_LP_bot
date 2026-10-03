import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCenteredRange, buildFablesTightRange, isLpInRange, isLpOutOfRange, isOutsideRange, priceWidthBpsToTickDelta } from '../src/math/ticks.js';
import { evaluatePosition, outOfRangeExcursionPct } from '../src/strategy.js';

const MIN = 60_000;
const base = {
  currentTick: 1007,
  tickSpacing: 10,
  position: { tickLower: 900, tickUpper: 1000 },
  widthBps: 120,
  checkIntervalMs: 5 * MIN,
  confirmDelayMs: 15 * MIN,
  minExcursionPct: 0
};

test('five-minute OOR requires at least 0.25 percent excursion on the confirming read', () => {
  const t0 = 2_000_000;
  const policy = { ...base, minExcursionPct: 0.25, confirmDelayMs: 5 * MIN, outOfRangeSince: t0 };
  assert.equal(evaluatePosition({ ...policy, currentTick: 1050, nowMs: t0 + 4 * MIN }).shouldRebalance, false);
  assert.equal(evaluatePosition({ ...policy, currentTick: 1024, nowMs: t0 + 5 * MIN }).shouldRebalance, false);
  assert.equal(evaluatePosition({ ...policy, currentTick: 1025, nowMs: t0 + 5 * MIN }).shouldRebalance, true);
  assert.equal(evaluatePosition({ ...policy, currentTick: 875, nowMs: t0 + 5 * MIN }).shouldRebalance, true);
  assert.equal(evaluatePosition({ ...policy, currentTick: 950, nowMs: t0 + 5 * MIN }).outOfRangeSince, 0);
});

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

test('Fables Tight follows its nearest-tick one-percent preset', () => {
  assert.deepEqual(buildFablesTightRange(320278, 200), { tickLower: 320000, tickUpper: 320400, tickDelta: 200 });
  assert.deepEqual(buildFablesTightRange(320300, 200), { tickLower: 320200, tickUpper: 320600, tickDelta: 200 });
});

test('canonical LP range uses lower-inclusive upper-exclusive semantics', () => {
  assert.equal(isLpInRange(900, 900, 1000), true);
  assert.equal(isLpInRange(999, 900, 1000), true);
  assert.equal(isLpOutOfRange(899, 900, 1000), true);
  assert.equal(isLpOutOfRange(1000, 900, 1000), true);
});

test('edge buffer is monitoring-only and cannot authorize an in-range rebalance', () => {
  assert.equal(isOutsideRange(905, 900, 1000, 10), true);
  const result = evaluatePosition({ ...base, currentTick: 905, edgeBufferTicks: 10,
    outOfRangeSince: 1, nowMs: 20 * MIN });
  assert.equal(result.nearEdge, true);
  assert.equal(result.outOfRangeSince, 0);
  assert.equal(result.shouldRebalance, false);
});

test('50 ticks outside is about 0.5 percent', () => {
  const pct = outOfRangeExcursionPct(1050, 900, 1000);
  assert.ok(pct > 0.50 && pct < 0.51);
});

test('first observed OOR starts timer even between configured policy samples', () => {
  const t0 = 1_000_000;
  const first = evaluatePosition({ ...base, lastEvaluationAt: t0 - MIN, nowMs: t0 });
  assert.equal(first.evaluationDue, false);
  assert.equal(first.outOfRangeSince, t0);
  assert.equal(first.shouldRebalance, false);
});

test('15-minute on-chain confirmation applies equally to shallow and deep OOR', () => {
  const t0 = 2_000_000;
  for (const currentTick of [1007, 1051, 899]) {
    const before = evaluatePosition({ ...base, currentTick, outOfRangeSince: t0,
      lastEvaluationAt: t0 + 14 * MIN, nowMs: t0 + 15 * MIN - 1 });
    assert.equal(before.evaluationDue, false);
    assert.equal(before.shouldRebalance, false);
    const confirmed = evaluatePosition({ ...base, currentTick, outOfRangeSince: t0,
      lastEvaluationAt: t0 + 14 * MIN, nowMs: t0 + 15 * MIN });
    assert.equal(confirmed.evaluationDue, false);
    assert.equal(confirmed.shouldRebalance, true);
    assert.equal(confirmed.rebalanceReason, 'oor_delay_confirmed');
  }
});

test('re-entry at confirmation deadline clears timer; later breakout starts anew', () => {
  const t0 = 3_000_000;
  const back = evaluatePosition({ ...base, currentTick: 999, outOfRangeSince: t0,
    lastEvaluationAt: t0 + 14 * MIN, nowMs: t0 + 15 * MIN });
  assert.equal(back.outOfRangeSince, 0);
  assert.equal(back.shouldRebalance, false);
  const newEpisode = evaluatePosition({ ...base, currentTick: 1000,
    outOfRangeSince: back.outOfRangeSince, nowMs: t0 + 16 * MIN });
  assert.equal(newEpisode.outOfRangeSince, t0 + 16 * MIN);
  assert.equal(newEpisode.shouldRebalance, false);
});

test('cooldown blocks a confirmed OOR until cooldown ends', () => {
  const t0 = 4_000_000;
  const blocked = evaluatePosition({ ...base, outOfRangeSince: t0,
    cooldownUntil: t0 + 16 * MIN, nowMs: t0 + 15 * MIN });
  assert.equal(blocked.cooldownActive, true);
  assert.equal(blocked.shouldRebalance, false);
  const ready = evaluatePosition({ ...base, outOfRangeSince: t0,
    cooldownUntil: t0 + 16 * MIN, nowMs: t0 + 16 * MIN });
  assert.equal(ready.shouldRebalance, true);
});
