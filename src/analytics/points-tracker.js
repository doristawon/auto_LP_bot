import {
  POINTS_DAY_MS,
  estimateDailyPoints,
  latestCompletedPointsBoundaryMs,
  pointsBoundaryAtOrBefore,
  pointsCampaignDayKey,
  pointsCampaignDayStartMs
} from './points.js';
import {
  FABLES_POINTS_END_MS,
  FABLES_POINTS_START_MS
} from '../constants.js';

const USER_FEE_TYPES = new Set(['fee.accrual', 'points.user_fee_adjustment']);
const GLOBAL_FEE_TYPE = 'points.global_swap_fee';

export class PointsTracker {
  constructor(config, ledger, state) {
    this.config = config;
    this.ledger = ledger;
    this.state = state;

    if (this.state.getSetting('actualPointsBaseline', null) == null && config.actualPointsBaseline > 0) {
      const rawAt = config.actualPointsBaselineAt
        ? Date.parse(config.actualPointsBaselineAt)
        : latestCompletedPointsBoundaryMs(Date.now());
      const atMs = normalizedBoundary(rawAt);
      this.state.setSetting('actualPointsBaseline', config.actualPointsBaseline);
      this.state.setSetting('actualPointsBaselineAt', new Date(atMs).toISOString());
    }

    if (this.state.getSetting('pointsUserTrackingStartedAt', null) == null) {
      const earliest = this.ledger.all().find((event) =>
        USER_FEE_TYPES.has(event.type)
        && event.ts >= FABLES_POINTS_START_MS
        && event.ts < FABLES_POINTS_END_MS
      );
      if (earliest) this.state.setSetting('pointsUserTrackingStartedAt', earliest.ts);
    }
  }

  noteUserTrackingStarted(at = Date.now()) {
    const current = this.state.getSetting('pointsUserTrackingStartedAt', null);
    if (current == null) this.state.setSetting('pointsUserTrackingStartedAt', Number(at));
  }

  predictionStartMs(nowMs = Date.now()) {
    const baselineAtRaw = this.state.getSetting('actualPointsBaselineAt', null);
    const parsed = baselineAtRaw ? Date.parse(baselineAtRaw) : NaN;
    if (Number.isFinite(parsed)) return normalizedBoundary(parsed);
    // Without an official baseline, V2 intentionally starts at the latest
    // completed campaign boundary instead of pretending it can reconstruct the
    // whole campaign from an incomplete local ledger.
    return latestCompletedPointsBoundaryMs(nowMs);
  }

  setActualBaseline(points, at = null) {
    const value = Number(points) || 0;
    const requestedMs = at ? Date.parse(at) : Date.now();
    const atMs = normalizedBoundary(requestedMs);
    const previousPoints = Number(this.state.getSetting('actualPointsBaseline', 0) || 0);
    const previousAtRaw = this.state.getSetting('actualPointsBaselineAt', null);
    const previousAtMs = previousAtRaw ? Date.parse(previousAtRaw) : NaN;

    let reconciliation = null;
    if (previousPoints > 0 && Number.isFinite(previousAtMs) && atMs > previousAtMs && value >= previousPoints) {
      const before = this.snapshot(atMs);
      const rows = Object.values(before.buckets || {}).filter((bucket) =>
        bucket.timestampMs >= previousAtMs && bucket.endMs <= atMs
      );
      const coverageComplete = rows.length > 0 && rows.every((bucket) => bucket.complete);
      const predictedDelta = coverageComplete
        ? rows.reduce((sum, bucket) => sum + Number(bucket.estimatedPoints || 0), 0)
        : null;
      const actualDelta = value - previousPoints;
      reconciliation = {
        from: new Date(previousAtMs).toISOString(),
        to: new Date(atMs).toISOString(),
        previousPoints,
        actualPoints: value,
        actualDelta,
        predictedDelta,
        errorPoints: predictedDelta == null ? null : predictedDelta - actualDelta,
        errorPct: predictedDelta == null || actualDelta === 0
          ? null
          : (predictedDelta - actualDelta) / actualDelta * 100,
        coverageComplete
      };
      this.state.setSetting('pointsLastReconciliation', reconciliation);
      this.ledger.append('points.reconciliation', reconciliation, atMs);
    }

    const iso = new Date(atMs).toISOString();
    this.state.setSetting('actualPointsBaseline', value);
    this.state.setSetting('actualPointsBaselineAt', iso);
    this.ledger.append('points.actual_baseline', {
      points: value,
      at: iso,
      requestedAt: at ? String(at) : null,
      campaignBoundaryNormalized: true
    }, atMs);
    return { points: value, at: iso, reconciliation };
  }

  snapshot(nowMs = Date.now()) {
    const actualBaseline = Number(this.state.getSetting('actualPointsBaseline', 0) || 0);
    const baselineAtRaw = this.state.getSetting('actualPointsBaselineAt', null);
    const baselineAtMs = baselineAtRaw ? Date.parse(baselineAtRaw) : 0;
    const predictionStartMs = this.predictionStartMs(nowMs);
    const trackingStartedAt = Number(this.state.getSetting('pointsUserTrackingStartedAt', 0) || 0);
    const buckets = this.buildBuckets(predictionStartMs);
    const horizonMs = Math.min(Math.max(nowMs, predictionStartMs), FABLES_POINTS_END_MS);
    for (let dayStart = predictionStartMs; dayStart < horizonMs; dayStart += POINTS_DAY_MS) {
      const key = pointsCampaignDayKey(dayStart);
      if (!key || buckets[key]) continue;
      buckets[key] = emptyBucket(dayStart);
    }

    const currentBoundary = latestCompletedPointsBoundaryMs(nowMs);
    const currentDayStart = pointsCampaignDayStartMs(nowMs);
    let settledEstimatedDelta = 0;
    let provisionalSettledDelta = 0;
    let projectedCurrentDay = null;
    let provisionalCurrentDay = 0;
    let hasIncomplete = false;
    let totalGlobalSwaps = 0;
    let totalUnpricedSwaps = 0;

    for (const bucket of Object.values(buckets)) {
      bucket.endMs = Math.min(bucket.timestampMs + POINTS_DAY_MS, FABLES_POINTS_END_MS);
      bucket.denominatorComplete = bucket.globalSwapCount > 0 && bucket.unpricedGlobalSwapCount === 0;
      bucket.userCoverageComplete = trackingStartedAt > 0 && trackingStartedAt <= bucket.timestampMs;
      bucket.complete = bucket.denominatorComplete && bucket.userCoverageComplete;
      bucket.estimatedPoints = estimateDailyPoints(
        bucket.timestampMs,
        bucket.userFeeUsd,
        bucket.totalFeeUsd
      );
      bucket.completed = bucket.endMs <= currentBoundary;
      totalGlobalSwaps += bucket.globalSwapCount;
      totalUnpricedSwaps += bucket.unpricedGlobalSwapCount;
      if (!bucket.complete) hasIncomplete = true;

      if (bucket.completed) {
        provisionalSettledDelta += bucket.estimatedPoints;
        if (bucket.complete) settledEstimatedDelta += bucket.estimatedPoints;
      } else if (currentDayStart != null && bucket.timestampMs === currentDayStart) {
        provisionalCurrentDay = bucket.estimatedPoints;
        if (bucket.complete) projectedCurrentDay = bucket.estimatedPoints;
      }
    }

    const provisionalEstimatedDelta = provisionalSettledDelta + provisionalCurrentDay;
    const exactEstimatedDelta = hasIncomplete
      ? null
      : settledEstimatedDelta + (projectedCurrentDay || 0);

    let status = 'ready';
    if (!(actualBaseline > 0) || !(baselineAtMs > 0)) status = 'needs-official-baseline';
    else if (totalGlobalSwaps === 0) status = 'waiting-for-global-swaps';
    else if (totalUnpricedSwaps > 0) status = 'incomplete-denominator';
    else if (trackingStartedAt <= 0 || trackingStartedAt > predictionStartMs) status = 'incomplete-user-coverage';
    else if (hasIncomplete) status = 'incomplete-coverage';

    const estimatedTotal = actualBaseline > 0 && exactEstimatedDelta != null
      ? actualBaseline + exactEstimatedDelta
      : null;
    const provisionalEstimatedTotal = actualBaseline + provisionalEstimatedDelta;
    const nextDistributionAt = currentDayStart == null
      ? null
      : new Date(Math.min(currentDayStart + POINTS_DAY_MS, FABLES_POINTS_END_MS)).toISOString();

    return {
      version: 2,
      status,
      actualBaseline,
      actualBaselineAt: baselineAtRaw,
      predictionStartAt: new Date(predictionStartMs).toISOString(),
      userTrackingStartedAt: trackingStartedAt > 0 ? new Date(trackingStartedAt).toISOString() : null,
      settledEstimatedDelta,
      projectedCurrentDay,
      estimatedDelta: exactEstimatedDelta,
      estimatedTotal,
      provisionalEstimatedDelta,
      provisionalEstimatedTotal,
      nextDistributionAt,
      globalSwapCount: totalGlobalSwaps,
      unpricedGlobalSwapCount: totalUnpricedSwaps,
      denominatorCoveragePct: totalGlobalSwaps > 0
        ? (totalGlobalSwaps - totalUnpricedSwaps) / totalGlobalSwaps * 100
        : 0,
      lastReconciliation: this.state.getSetting('pointsLastReconciliation', null),
      buckets
    };
  }

  buildBuckets(startMs) {
    const buckets = {};
    for (const event of this.ledger.all()) {
      if (event.ts < startMs || event.ts < FABLES_POINTS_START_MS || event.ts >= FABLES_POINTS_END_MS) continue;
      if (!USER_FEE_TYPES.has(event.type) && event.type !== GLOBAL_FEE_TYPE) continue;
      const key = pointsCampaignDayKey(event.ts);
      if (!key) continue;
      const dayStart = pointsCampaignDayStartMs(event.ts);
      if (!buckets[key]) {
        buckets[key] = emptyBucket(dayStart);
      }
      if (USER_FEE_TYPES.has(event.type)) {
        buckets[key].userFeeUsd += finiteNumber(event.feeUsd);
      }
      if (event.type === GLOBAL_FEE_TYPE) {
        buckets[key].globalSwapCount += 1;
        if (event.priced === false || !Number.isFinite(Number(event.feeUsd))) {
          buckets[key].unpricedGlobalSwapCount += 1;
        } else {
          buckets[key].totalFeeUsd += Number(event.feeUsd);
        }
      }
    }
    return buckets;
  }
}

function emptyBucket(dayStart) {
  return {
    timestampMs: dayStart,
    endMs: Math.min(dayStart + POINTS_DAY_MS, FABLES_POINTS_END_MS),
    userFeeUsd: 0,
    totalFeeUsd: 0,
    globalSwapCount: 0,
    unpricedGlobalSwapCount: 0
  };
}

function normalizedBoundary(timestampMs) {
  const value = Number.isFinite(Number(timestampMs)) ? Number(timestampMs) : Date.now();
  return pointsBoundaryAtOrBefore(value);
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
