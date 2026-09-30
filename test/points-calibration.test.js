import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOfficialPointsCalibration } from '../src/analytics/points-calibration.js';
import { POINTS_DAY_MS, dailyPointBudget } from '../src/analytics/points.js';
import { FABLES_POINTS_START_MS } from '../src/constants.js';

const wallet = '0x00000000000000000000000000000000000000aa';
const start = Date.parse('2026-09-27T02:00:00Z');

function fixture({ coverageStart = start, brokenAt = null, nowMs = start + 6 * POINTS_DAY_MS } = {}) {
  const rows = [
    { settledAt: start, lpPoints: 100, settledFeesUsd: 0.5, referralPoints: 9000 },
    { settledAt: start + POINTS_DAY_MS, lpPoints: 10100, settledFeesUsd: 80.5, referralPoints: 12000 },
    { settledAt: start + 2 * POINTS_DAY_MS, lpPoints: 25100, settledFeesUsd: 170.5, referralPoints: 15000 },
    { settledAt: start + 3 * POINTS_DAY_MS, lpPoints: 40100, settledFeesUsd: 270.5, referralPoints: 17000 }
  ];
  const official = { wallet, ...rows.at(-1), history: rows.map(({ settledAt, lpPoints, referralPoints }) => ({
    settledAt, lpPoints: settledAt === start ? 100 : lpPoints - rows[rows.findIndex((row) => row.settledAt === settledAt) - 1].lpPoints,
    referralPoints
  })) };
  const settlementEvents = rows.map((row) => ({ type: 'points.official_settlement', wallet, ...row }));
  const feeEvents = [
    { type: 'fee.accrual', ts: start + POINTS_DAY_MS - 1000, feeUsd: 80 },
    { type: 'fee.accrual', ts: start + 2 * POINTS_DAY_MS - 1000, feeUsd: 90 },
    { type: 'fee.accrual', ts: start + 3 * POINTS_DAY_MS - 1000, feeUsd: 100 },
    { type: 'fee.accrual', ts: start + 3 * POINTS_DAY_MS + 2000, feeUsd: -1 }
  ];
  const result = buildOfficialPointsCalibration({
    official, settlementEvents, feeEvents, trackingStartedAt: coverageStart,
    coverageBrokenAt: brokenAt, nowMs
  });
  return { result, official, settlementEvents, feeEvents };
}

test('weighted multi-day fit uses only complete LP settlement deltas and excludes referral points', () => {
  const { result } = fixture();
  assert.equal(result.status, 'ready');
  assert.equal(result.sampleDays, 3);
  assert.equal(result.officialLpPoints, 40000);
  assert.equal(result.officialFeeUsd, 270);
  assert.equal(result.source, 'official-multi-day-weighted');
  assert.equal(result.replay.method, 'leave-one-day-out-official-fee-delta');
  assert.equal(result.replay.days, 3);
  assert.ok(Number.isFinite(result.replay.meanAbsoluteErrorPoints));
  assert.ok(result.excludedDays.some((day) => day.reason === 'local-coverage-started-mid-period'));
  assert.equal(result.localFeeUsd, 270);
});

test('incomplete local coverage and an unsettled current day cannot enter the fit', () => {
  const { official, settlementEvents, feeEvents } = fixture({
    coverageStart: start + 2 * POINTS_DAY_MS + 5_000,
    brokenAt: start + 3 * POINTS_DAY_MS + 5_000,
    nowMs: start + 3 * POINTS_DAY_MS + 60_000
  });
  const result = buildOfficialPointsCalibration({
    official: { ...official, history: [...official.history,
      { settledAt: start + 4 * POINTS_DAY_MS, lpPoints: 700 }] },
    settlementEvents, feeEvents,
    trackingStartedAt: start + 2 * POINTS_DAY_MS + 5_000,
    coverageBrokenAt: start + 3 * POINTS_DAY_MS + 5_000,
    nowMs: start + 3 * POINTS_DAY_MS + 60_000
  });
  assert.equal(result.status, 'insufficient-complete-days');
  assert.equal(result.sampleDays, 0);
  assert.ok(result.excludedDays.some((day) => day.reason === 'local-coverage-started-mid-period'));
  assert.ok(result.excludedDays.some((day) => day.reason === 'not-yet-settled'));
});

test('negative cumulative official deltas are rejected instead of treated as zero-rate samples', () => {
  const base = fixture();
  const at = start + 2 * POINTS_DAY_MS;
  const events = base.settlementEvents.map((row) => row.settledAt === at
    ? { ...row, settledFeesUsd: 500, lpPoints: 10 }
    : row);
  const result = buildOfficialPointsCalibration({
    official: base.official, settlementEvents: events, feeEvents: base.feeEvents,
    trackingStartedAt: start, nowMs: start + 6 * POINTS_DAY_MS
  });
  assert.ok(result.excludedDays.some((day) => day.reason === 'negative-or-empty-official-delta'));
});

test('official checkpoints without at least two covered days produce no calibration', () => {
  const base = fixture({ coverageStart: start + 2 * POINTS_DAY_MS });
  assert.equal(base.result.status, 'insufficient-complete-days');
  assert.equal(base.result.pointsPerFeeUsd, null);
});

test('normalizes daily LP points when the sample crosses a weekly budget boundary', () => {
  const weeklyBoundary = FABLES_POINTS_START_MS + 7 * POINTS_DAY_MS;
  const firstDay = weeklyBoundary - POINTS_DAY_MS;
  const secondDay = weeklyBoundary;
  const points1 = Math.round(dailyPointBudget(firstDay) * 0.02);
  const points2 = Math.round(dailyPointBudget(secondDay) * 0.02);
  const settlements = [
    { settledAt: firstDay, lpPoints: 1000, settledFeesUsd: 50 },
    { settledAt: firstDay + POINTS_DAY_MS, lpPoints: 1000 + points1, settledFeesUsd: 150 },
    { settledAt: secondDay + POINTS_DAY_MS, lpPoints: 1000 + points1 + points2, settledFeesUsd: 250 }
  ];
  const result = buildOfficialPointsCalibration({
    official: {
      wallet,
      ...settlements.at(-1),
      history: settlements.slice(1).map((row, index) => ({
        settledAt: row.settledAt,
        lpPoints: index === 0 ? points1 : points2
      }))
    },
    settlementEvents: settlements.map((row) => ({
      type: 'points.official_settlement', wallet, ...row
    })),
    trackingStartedAt: firstDay,
    nowMs: secondDay + 3 * POINTS_DAY_MS
  });
  const expected = dailyPointBudget(secondDay) * 0.02 / 100;
  assert.equal(result.status, 'ready');
  assert.equal(result.sampleDays, 2);
  assert.ok(Math.abs(result.pointsPerFeeUsd - expected) < 0.01);
});
