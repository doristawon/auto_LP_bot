import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dailyPointBudget,
  latestCompletedPointsBoundaryMs,
  pointsCampaignDayKey,
  pointsCampaignDayStartMs
} from '../src/analytics/points.js';
import { valueSwapFeeInUsd } from '../src/analytics/points-accounting.js';
import { PointsTracker } from '../src/analytics/points-tracker.js';

const USDG = '0x0000000000000000000000000000000000000001';
const MEME = '0x0000000000000000000000000000000000000002';

test('campaign day is anchored at 02:00 UTC instead of civil midnight', () => {
  const before = Date.parse('2026-09-26T01:59:59Z');
  const at = Date.parse('2026-09-26T02:00:00Z');
  assert.equal(pointsCampaignDayStartMs(before), Date.parse('2026-09-25T02:00:00Z'));
  assert.equal(pointsCampaignDayKey(at), '2026-09-26T02:00:00.000Z');
  assert.equal(
    latestCompletedPointsBoundaryMs(Date.parse('2026-09-26T17:59:00Z')),
    Date.parse('2026-09-26T02:00:00Z')
  );
});

test('swap fee valuation is exact when USDG is the input', () => {
  const pool = {
    token0: { address: USDG, decimals: 6 },
    token1: { address: MEME, decimals: 18 }
  };
  const value = valueSwapFeeInUsd({
    pool,
    usdgAddress: USDG,
    swap: {
      amount0: 1_000_000_000n,
      amount1: -500_000_000_000_000_000_000n,
      fee: 3000
    }
  });
  assert.equal(value.priced, true);
  assert.equal(value.valuation, 'usdg-input');
  assert.equal(value.inputAmount, 1000);
  assert.equal(value.feeUsd, 3);
});

test('non-USDG input fee is valued from realized USDG output, not a later spot price', () => {
  const pool = {
    token0: { address: MEME, decimals: 18 },
    token1: { address: USDG, decimals: 6 }
  };
  const value = valueSwapFeeInUsd({
    pool,
    usdgAddress: USDG,
    swap: {
      amount0: 100_000_000_000_000_000_000n,
      amount1: -199_400_000n,
      fee: 3000
    }
  });
  assert.equal(value.priced, true);
  assert.equal(value.valuation, 'realized-usdg-output');
  assert.equal(value.feeAmount, 0.3);
  assert.ok(Math.abs(value.feeUsd - 0.6) < 1e-12);
});

test('non-USDG pools fail closed instead of fabricating denominator USD', () => {
  const pool = {
    token0: { address: MEME, decimals: 18 },
    token1: { address: '0x0000000000000000000000000000000000000003', decimals: 18 }
  };
  const value = valueSwapFeeInUsd({
    pool,
    usdgAddress: USDG,
    swap: { amount0: 10n ** 18n, amount1: -(2n * 10n ** 18n), fee: 3000 }
  });
  assert.equal(value.priced, false);
  assert.equal(value.reason, 'pool-has-no-usdg-leg');
});

test('points v2 predicts from fee share when denominator and user coverage are complete', () => {
  const day = Date.parse('2026-09-25T02:00:00Z');
  const state = fakeState({
    actualPointsBaseline: 1000,
    actualPointsBaselineAt: new Date(day).toISOString(),
    pointsUserTrackingStartedAt: day
  });
  const ledger = fakeLedger([
    event(day + 60_000, 'fee.accrual', { feeUsd: 10 }),
    event(day + 120_000, 'points.global_swap_fee', { feeUsd: 100, priced: true })
  ]);
  const tracker = new PointsTracker({ actualPointsBaseline: 0, actualPointsBaselineAt: '' }, ledger, state);
  const snap = tracker.snapshot(day + 12 * 60 * 60 * 1000);
  const expected = dailyPointBudget(day) * 0.1;
  assert.equal(snap.status, 'ready');
  assert.ok(Math.abs(snap.projectedCurrentDay - expected) < 1e-9);
  assert.ok(Math.abs(snap.estimatedTotal - (1000 + expected)) < 1e-9);
  assert.equal(snap.denominatorCoveragePct, 100);
});

test('points v2 refuses exact prediction if any global swap is unpriced', () => {
  const day = Date.parse('2026-09-25T02:00:00Z');
  const state = fakeState({
    actualPointsBaseline: 1000,
    actualPointsBaselineAt: new Date(day).toISOString(),
    pointsUserTrackingStartedAt: day
  });
  const ledger = fakeLedger([
    event(day + 60_000, 'fee.accrual', { feeUsd: 10 }),
    event(day + 120_000, 'points.global_swap_fee', { feeUsd: 100, priced: true }),
    event(day + 180_000, 'points.global_swap_fee', { feeUsd: null, priced: false })
  ]);
  const tracker = new PointsTracker({ actualPointsBaseline: 0, actualPointsBaselineAt: '' }, ledger, state);
  const snap = tracker.snapshot(day + 12 * 60 * 60 * 1000);
  assert.equal(snap.status, 'incomplete-denominator');
  assert.equal(snap.estimatedTotal, null);
  assert.ok(snap.provisionalEstimatedTotal > 1000);
});

test('official checkpoint reconciles the previous completed campaign day', () => {
  const day1 = Date.parse('2026-09-24T02:00:00Z');
  const day2 = day1 + 24 * 60 * 60 * 1000;
  const state = fakeState({
    actualPointsBaseline: 50_000,
    actualPointsBaselineAt: new Date(day1).toISOString(),
    pointsUserTrackingStartedAt: day1
  });
  const ledger = fakeLedger([
    event(day1 + 60_000, 'fee.accrual', { feeUsd: 1 }),
    event(day1 + 120_000, 'points.global_swap_fee', { feeUsd: 100, priced: true })
  ]);
  const tracker = new PointsTracker({ actualPointsBaseline: 0, actualPointsBaselineAt: '' }, ledger, state);
  const predicted = dailyPointBudget(day1) * 0.01;
  const result = tracker.setActualBaseline(50_000 + predicted + 25, new Date(day2).toISOString());
  assert.equal(result.at, new Date(day2).toISOString());
  assert.equal(result.reconciliation.coverageComplete, true);
  assert.ok(Math.abs(result.reconciliation.predictedDelta - predicted) < 1e-9);
  assert.ok(Math.abs(result.reconciliation.errorPoints + 25) < 1e-9);
});

function event(ts, type, extra = {}) {
  return { ts, type, ...extra };
}

function fakeLedger(initial) {
  const rows = [...initial];
  return {
    all() { return [...rows]; },
    append(type, data, ts) {
      const row = { ts: ts ?? Date.now(), type, ...data };
      rows.push(row);
      return row;
    }
  };
}

function fakeState(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getSetting(key, fallback = null) { return map.has(key) ? map.get(key) : fallback; },
    setSetting(key, value) { map.set(key, value); }
  };
}
