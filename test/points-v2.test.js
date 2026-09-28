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
      amount0: -1_000_000_000n,
      amount1: 500_000_000_000_000_000_000n,
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
      amount0: -100_000_000_000_000_000_000n,
      amount1: 199_400_000n,
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
    swap: { amount0: -(10n ** 18n), amount1: 2n * 10n ** 18n, fee: 3000 }
  });
  assert.equal(value.priced, false);
  assert.equal(value.reason, 'pool-has-no-usdg-leg');
});

test('points v2 predicts from fee share when denominator and user coverage are complete', () => {
  const day = Date.parse('2026-09-25T02:00:00Z');
  const state = fakeState({
    actualPointsBaseline: 1000,
    actualPointsBaselineAt: new Date(day).toISOString(),
    pointsOfficial: { wallet: '', lpPoints: 1000, referralPoints: 0, settledAt: day },
    pointsUserTrackingStartedAtV2: day
  });
  const ledger = fakeLedger([
    event(day + 60_000, 'fee.accrual', { feeUsd: 10 }),
    event(day + 120_000, 'points.global_swap_fee', { feeUsd: 100, priced: true })
  ]);
  const tracker = new PointsTracker({ actualPointsBaseline: 0, actualPointsBaselineAt: '' }, ledger, state);
  const snap = tracker.snapshot({ atMs: day + 12 * 60 * 60 * 1000, force: true });
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
    pointsOfficial: { wallet: '', lpPoints: 1000, referralPoints: 0, settledAt: day },
    pointsUserTrackingStartedAtV2: day
  });
  const ledger = fakeLedger([
    event(day + 60_000, 'fee.accrual', { feeUsd: 10 }),
    event(day + 120_000, 'points.global_swap_fee', { feeUsd: 100, priced: true }),
    event(day + 180_000, 'points.global_swap_fee', { feeUsd: null, priced: false })
  ]);
  const tracker = new PointsTracker({ actualPointsBaseline: 0, actualPointsBaselineAt: '' }, ledger, state);
  const snap = tracker.snapshot({ atMs: day + 12 * 60 * 60 * 1000, force: true });
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
    pointsOfficial: { wallet: '', lpPoints: 50_000, referralPoints: 0, settledAt: day1 },
    pointsUserTrackingStartedAtV2: day1
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

test('manual baseline stays separate from official checkpoint and prediction start', () => {
  const day = Date.parse('2026-09-25T02:00:00Z');
  const state = fakeState({
    actualPointsBaseline: 900,
    actualPointsBaselineAt: new Date(day).toISOString(),
    pointsUserTrackingStartedAtV2: day
  });
  const ledger = fakeLedger([]);
  const tracker = new PointsTracker({ actualPointsBaseline: 0 }, ledger, state);
  const predictionStart = tracker.predictionStartMs(day + 18 * 60 * 60 * 1000);
  assert.equal(state.getSetting('actualPointsBaseline'), 0);
  assert.equal(state.getSetting('manualPointsBaseline'), 900);
  assert.equal(predictionStart, latestCompletedPointsBoundaryMs(day + 18 * 60 * 60 * 1000));

  tracker.setManualBaseline(1_250, new Date(day + 10 * 60 * 60 * 1000).toISOString());
  const beforeOfficialUpdate = tracker.snapshot({ atMs: day + 12 * 60 * 60 * 1000, force: true });
  assert.equal(beforeOfficialUpdate.actualBaseline, 0);
  assert.equal(beforeOfficialUpdate.manualBaseline, 1_250);
  assert.equal(beforeOfficialUpdate.predictionStartAt, new Date(predictionStart).toISOString());

  tracker.setActualBaseline(1_100, new Date(day + 24 * 60 * 60 * 1000).toISOString());
  const afterOfficialUpdate = tracker.snapshot({ atMs: day + 25 * 60 * 60 * 1000, force: true });
  assert.equal(afterOfficialUpdate.actualBaseline, 1_100);
  assert.equal(afterOfficialUpdate.manualBaseline, 1_250);
});

test('snapshot reuses cached simulation unless force is explicitly requested', () => {
  const day = Date.parse('2026-09-25T02:00:00Z');
  const state = fakeState({
    actualPointsBaseline: 1000,
    actualPointsBaselineAt: new Date(day).toISOString(),
    pointsOfficial: { wallet: '', lpPoints: 1000, referralPoints: 0, settledAt: day },
    pointsUserTrackingStartedAtV2: day
  });
  const ledger = fakeLedger([]);
  const originalAll = ledger.all;
  let allCalls = 0;
  ledger.all = () => { allCalls += 1; return originalAll(); };
  const tracker = new PointsTracker({ pointsSimulationIntervalMs: 60_000 }, ledger, state);
  tracker.snapshot({ atMs: day + 12 * 60 * 60 * 1000, force: true });
  const callsAfterFirstSimulation = allCalls;
  tracker.snapshot();
  assert.equal(allCalls, callsAfterFirstSimulation);
  tracker.snapshot({ force: true });
  assert.ok(allCalls > callsAfterFirstSimulation);
});

test('official calibration recovers the latest daily delta from wallet settlement history', () => {
  const wallet = '0x0000000000000000000000000000000000000001';
  const firstAt = Date.parse('2026-09-27T02:00:00Z');
  const latestAt = firstAt + 24 * 60 * 60 * 1000;
  const latest = { wallet, settledAt: latestAt, lpPoints: 17331,
    referralPoints: 0, settledFeesUsd: 114.03, history: [] };
  const state = fakeState({
    actualPointsBaseline: 17331, actualPointsBaselineAt: new Date(latestAt).toISOString(),
    pointsOfficial: latest,
    pointsCalibration: { wallet, pointsPerFeeUsd: 241.66, source: 'first-wallet-lp-day' }
  });
  const ledger = fakeLedger([
    event(firstAt, 'points.official_settlement', {
      settledAt: firstAt, lpPoints: 116, settledFeesUsd: 0.48
    }),
    event(latestAt, 'points.official_settlement', {
      settledAt: latestAt, lpPoints: 17331, settledFeesUsd: 114.03
    })
  ]);
  const tracker = new PointsTracker({ walletAddress: wallet }, ledger, state);
  tracker.applyOfficialSettlement(latest, null);
  const calibration = state.getSetting('pointsCalibration');
  assert.equal(calibration.source, 'consecutive-official-settlements');
  assert.equal(calibration.points, 17215);
  assert.ok(Math.abs(calibration.pointsPerFeeUsd - 17215 / 113.55) < 1e-9);
});

test('calibrated live estimate remains available when market fee denominator is incomplete', () => {
  const wallet = '0x0000000000000000000000000000000000000001';
  const boundary = Date.parse('2026-09-28T02:00:00Z');
  const state = fakeState({
    actualPointsBaseline: 17331,
    actualPointsBaselineAt: new Date(boundary).toISOString(),
    pointsUserTrackingStartedAtV2: boundary - 60_000,
    pointsOfficial: { wallet, lpPoints: 17331, referralPoints: 0,
      settledAt: boundary, settledFeesUsd: 114.03, history: [] },
    pointsCalibration: { wallet, pointsPerFeeUsd: 17215 / 113.55,
      programmeDayEnd: boundary, source: 'consecutive-official-settlements' }
  });
  const tracker = new PointsTracker({ walletAddress: wallet }, fakeLedger([
    event(boundary + 60_000, 'fee.accrual', { feeUsd: 2 }),
    event(boundary + 60_000, 'points.global_swap_fee', { priced: false, feeUsd: null })
  ]), state);
  const snapshot = tracker.snapshot({ atMs: boundary + 2 * 60_000, force: true });
  const rate = (17215 / 113.55) * dailyPointBudget(boundary) / dailyPointBudget(boundary - 1);
  assert.equal(snapshot.estimatedTotal, null);
  assert.ok(Math.abs(snapshot.calibratedEstimatedTotal - (17331 + 2 * rate)) < 1e-9);
  assert.ok(snapshot.buckets[new Date(boundary).toISOString()].calibratedPoints > 0);
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
