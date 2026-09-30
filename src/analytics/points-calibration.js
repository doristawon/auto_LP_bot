import {
  POINTS_DAY_MS,
  dailyPointBudget,
  latestCompletedPointsBoundaryMs,
  pointsCampaignDayKey,
  pointsCampaignDayStartMs
} from './points.js';

const MIN_CALIBRATION_DAYS = 2;

/**
 * Fit a fee-to-LP-points rate from completed official settlement intervals.
 * Referral points are deliberately ignored. Local fee.accrual rows are used
 * only for coverage diagnostics and historical replay, never as the official
 * fee denominator.
 */
export function buildOfficialPointsCalibration({
  official,
  settlementEvents = [],
  feeEvents = [],
  trackingStartedAt = 0,
  coverageBrokenAt = null,
  nowMs = Date.now()
} = {}) {
  const wallet = String(official?.wallet || '').toLowerCase();
  const officialAt = Number(official?.settledAt);
  const cutoff = Math.min(officialAt, latestCompletedPointsBoundaryMs(nowMs));
  const excluded = [];
  if (!wallet || !Number.isFinite(officialAt) || officialAt <= 0) {
    return emptyResult(wallet, 'missing-official-settlement');
  }

  const settlements = new Map();
  for (const event of settlementEvents) {
    if (event?.type !== 'points.official_settlement') continue;
    if (event.wallet && String(event.wallet).toLowerCase() !== wallet) continue;
    const settledAt = Number(event.settledAt);
    const lpPoints = Number(event.lpPoints);
    const settledFeesUsd = Number(event.settledFeesUsd);
    if (!Number.isFinite(settledAt) || settledAt <= 0
      || !Number.isSafeInteger(lpPoints) || lpPoints < 0
      || !Number.isFinite(settledFeesUsd) || settledFeesUsd < 0) continue;
    settlements.set(settledAt, { settledAt, lpPoints, settledFeesUsd });
  }
  const latest = {
    settledAt: officialAt,
    lpPoints: Number(official.lpPoints),
    settledFeesUsd: Number(official.settledFeesUsd)
  };
  if (Number.isSafeInteger(latest.lpPoints) && latest.lpPoints >= 0
    && Number.isFinite(latest.settledFeesUsd) && latest.settledFeesUsd >= 0) {
    settlements.set(officialAt, latest);
  }
  const orderedSettlements = [...settlements.values()].sort((a, b) => a.settledAt - b.settledAt);
  const bySettledAt = new Map(orderedSettlements.map((row) => [row.settledAt, row]));
  const history = Array.isArray(official.history) ? official.history : [];
  const historyByAt = new Map();
  for (const row of history) {
    const settledAt = Number(row?.settledAt);
    const lpPoints = Number(row?.lpPoints);
    if (Number.isFinite(settledAt) && Number.isSafeInteger(lpPoints) && lpPoints >= 0) {
      historyByAt.set(settledAt, { settledAt, lpPoints });
    }
  }

  const feeByDay = new Map();
  for (const event of feeEvents) {
    if (event?.type !== 'fee.accrual') continue;
    const ts = Number(event.ts);
    const feeUsd = Number(event.feeUsd);
    const dayKey = pointsCampaignDayKey(ts);
    if (!dayKey || !Number.isFinite(feeUsd) || feeUsd < 0) continue;
    const day = feeByDay.get(dayKey) || { feeUsd: 0, rows: 0 };
    day.feeUsd += feeUsd;
    day.rows += 1;
    feeByDay.set(dayKey, day);
  }

  const samples = [];
  const orderedHistory = [...historyByAt.values()].sort((a, b) => a.settledAt - b.settledAt);
  for (const daily of orderedHistory) {
    if (daily.settledAt > cutoff) {
      excluded.push(excludedDay(daily.settledAt, 'not-yet-settled'));
      continue;
    }
    const settlement = bySettledAt.get(daily.settledAt);
    if (!settlement) {
      excluded.push(excludedDay(daily.settledAt, 'cumulative-settlement-missing'));
      continue;
    }
    const previous = orderedSettlements.filter((row) => row.settledAt < settlement.settledAt).at(-1) || null;
    const pointDelta = settlement.lpPoints - (previous?.lpPoints || 0);
    const feeDeltaUsd = settlement.settledFeesUsd - (previous?.settledFeesUsd || 0);
    if (pointDelta < 0 || feeDeltaUsd <= 0) {
      excluded.push(excludedDay(daily.settledAt, 'negative-or-empty-official-delta'));
      continue;
    }
    if (pointDelta !== daily.lpPoints) {
      excluded.push(excludedDay(daily.settledAt, 'official-history-mismatch'));
      continue;
    }

    const dayStart = pointsCampaignDayStartMs(daily.settledAt - 1);
    const dayKey = pointsCampaignDayKey(daily.settledAt - 1);
    if (dayStart == null || !dayKey) {
      excluded.push(excludedDay(daily.settledAt, 'outside-campaign'));
      continue;
    }
    const trackedFrom = Number(trackingStartedAt || 0);
    const brokenAt = Number(coverageBrokenAt || 0);
    if (!(trackedFrom > 0) || trackedFrom > dayStart) {
      excluded.push(excludedDay(daily.settledAt, 'local-coverage-started-mid-period'));
      continue;
    }
    if (brokenAt >= dayStart && brokenAt < daily.settledAt) {
      excluded.push(excludedDay(daily.settledAt, 'local-coverage-gap'));
      continue;
    }

    const localFees = feeByDay.get(dayKey) || { feeUsd: 0, rows: 0 };
    samples.push({
      day: dayKey,
      dayStart,
      settledAt: daily.settledAt,
      lpPoints: daily.lpPoints,
      settledFeesUsd: feeDeltaUsd,
      localFeeUsd: localFees.feeUsd,
      localFeeRows: localFees.rows
    });
  }

  if (samples.length < MIN_CALIBRATION_DAYS) {
    return {
      ...emptyResult(wallet, 'insufficient-complete-days'),
      observedOfficialDays: orderedHistory.length,
      sampleDays: samples.length,
      excludedDays: excluded,
      samples: samples.map((sample) => ({ ...sample, excludedFromFit: true }))
    };
  }

  const referenceBudget = dailyPointBudget(samples.at(-1).dayStart);
  if (!(referenceBudget > 0)) return emptyResult(wallet, 'invalid-point-budget');
  const pointsAtReferenceBudget = (sample) => sample.lpPoints * referenceBudget
    / dailyPointBudget(sample.dayStart);
  const feeTotal = samples.reduce((sum, sample) => sum + sample.settledFeesUsd, 0);
  const normalizedPoints = samples.reduce((sum, sample) => sum + pointsAtReferenceBudget(sample), 0);
  if (!(feeTotal > 0) || !Number.isFinite(normalizedPoints)) {
    return emptyResult(wallet, 'invalid-official-deltas');
  }
  const pointsPerFeeUsd = normalizedPoints / feeTotal;
  const replay = samples.map((sample, index) => {
    const training = samples.filter((_, i) => i !== index);
    const trainingFees = training.reduce((sum, row) => sum + row.settledFeesUsd, 0);
    const trainingPoints = training.reduce((sum, row) => sum + pointsAtReferenceBudget(row), 0);
    const leaveOneOutRate = trainingFees > 0 ? trainingPoints / trainingFees : null;
    const dayBudget = dailyPointBudget(sample.dayStart);
    const predictedPoints = leaveOneOutRate == null ? null
      : sample.settledFeesUsd * leaveOneOutRate * dayBudget / referenceBudget;
    const errorPoints = predictedPoints == null ? null : predictedPoints - sample.lpPoints;
    const localPredictedPoints = sample.localFeeUsd * pointsPerFeeUsd * dayBudget / referenceBudget;
    return {
      day: sample.day,
      actualLpPoints: sample.lpPoints,
      officialFeeUsd: sample.settledFeesUsd,
      localFeeUsd: sample.localFeeUsd,
      localFeeRows: sample.localFeeRows,
      localToOfficialFeeRatio: sample.settledFeesUsd > 0
        ? sample.localFeeUsd / sample.settledFeesUsd : null,
      leaveOneOutPredictedPoints: predictedPoints,
      leaveOneOutErrorPoints: errorPoints,
      leaveOneOutErrorPct: sample.lpPoints > 0 && errorPoints != null
        ? errorPoints / sample.lpPoints * 100 : null,
      localAccrualReplayPredictedPoints: localPredictedPoints,
      localAccrualReplayErrorPct: sample.lpPoints > 0
        ? (localPredictedPoints - sample.lpPoints) / sample.lpPoints * 100 : null
    };
  });
  const replayRows = replay.filter((row) => row.leaveOneOutPredictedPoints != null);
  const actualTotal = replayRows.reduce((sum, row) => sum + row.actualLpPoints, 0);
  const predictedTotal = replayRows.reduce((sum, row) => sum + row.leaveOneOutPredictedPoints, 0);
  const meanAbsoluteErrorPoints = replayRows.length
    ? replayRows.reduce((sum, row) => sum + Math.abs(row.leaveOneOutErrorPoints), 0) / replayRows.length
    : null;
  const localReplayRows = replay.filter((row) => row.localAccrualReplayPredictedPoints != null);
  const localActualPoints = localReplayRows.reduce((sum, row) => sum + row.actualLpPoints, 0);
  const localPredictedPoints = localReplayRows.reduce((sum, row) => sum + row.localAccrualReplayPredictedPoints, 0);
  const localAccrualReplayMaePoints = localReplayRows.length
    ? localReplayRows.reduce((sum, row) => sum + Math.abs(
      row.localAccrualReplayPredictedPoints - row.actualLpPoints
    ), 0) / localReplayRows.length
    : null;

  return {
    version: 1,
    status: 'ready',
    source: 'official-multi-day-weighted',
    wallet,
    sampleDays: samples.length,
    observedOfficialDays: orderedHistory.length,
    excludedDays: excluded,
    pointsPerFeeUsd,
    referenceBudget,
    referenceDayEnd: samples.at(-1).settledAt,
    officialLpPoints: samples.reduce((sum, sample) => sum + sample.lpPoints, 0),
    officialFeeUsd: feeTotal,
    localFeeUsd: samples.reduce((sum, sample) => sum + sample.localFeeUsd, 0),
    localToOfficialFeeRatio: feeTotal > 0
      ? samples.reduce((sum, sample) => sum + sample.localFeeUsd, 0) / feeTotal : null,
    replay: {
      method: 'leave-one-day-out-official-fee-delta',
      interpretation: 'cross-validation, not forward backtest',
      days: replayRows.length,
      meanAbsoluteErrorPoints,
      weightedErrorPct: actualTotal > 0 ? (predictedTotal - actualTotal) / actualTotal * 100 : null,
      localAccrualMeanAbsoluteErrorPoints: localAccrualReplayMaePoints,
      localAccrualWeightedErrorPct: localActualPoints > 0
        ? (localPredictedPoints - localActualPoints) / localActualPoints * 100 : null,
      daysDetail: replay
    }
  };
}

function emptyResult(wallet, status) {
  return {
    version: 1, status, source: 'official-multi-day-weighted', wallet,
    sampleDays: 0, observedOfficialDays: 0, excludedDays: [], samples: [],
    pointsPerFeeUsd: null, referenceBudget: null, referenceDayEnd: null,
    officialLpPoints: 0, officialFeeUsd: 0, localFeeUsd: 0,
    localToOfficialFeeRatio: null,
    replay: { method: 'leave-one-day-out-official-fee-delta', days: 0,
      interpretation: 'cross-validation, not forward backtest',
      meanAbsoluteErrorPoints: null, weightedErrorPct: null,
      localAccrualMeanAbsoluteErrorPoints: null, localAccrualWeightedErrorPct: null,
      daysDetail: [] }
  };
}

function excludedDay(settledAt, reason) {
  return { day: pointsCampaignDayKey(Number(settledAt) - 1), settledAt, reason };
}
