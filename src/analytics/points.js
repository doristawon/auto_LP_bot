import {
  FABLES_LP_POINTS_TOTAL,
  FABLES_POINTS_END_MS,
  FABLES_POINTS_START_MS,
  FABLES_WEEKLY_POINT_WEIGHTS
} from '../constants.js';

export const POINTS_DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * POINTS_DAY_MS;

export function pointsWeekIndex(timestampMs) {
  if (timestampMs < FABLES_POINTS_START_MS || timestampMs >= FABLES_POINTS_END_MS) return -1;
  return Math.min(5, Math.floor((timestampMs - FABLES_POINTS_START_MS) / WEEK_MS));
}

export function pointsCampaignDayIndex(timestampMs) {
  if (timestampMs < FABLES_POINTS_START_MS || timestampMs >= FABLES_POINTS_END_MS) return -1;
  return Math.floor((timestampMs - FABLES_POINTS_START_MS) / POINTS_DAY_MS);
}

export function pointsCampaignDayStartMs(timestampMs) {
  const index = pointsCampaignDayIndex(timestampMs);
  return index < 0 ? null : FABLES_POINTS_START_MS + index * POINTS_DAY_MS;
}

export function pointsCampaignDayKey(timestampMs) {
  const start = pointsCampaignDayStartMs(timestampMs);
  return start == null ? null : new Date(start).toISOString();
}

export function pointsBoundaryAtOrBefore(timestampMs) {
  if (timestampMs <= FABLES_POINTS_START_MS) return FABLES_POINTS_START_MS;
  if (timestampMs >= FABLES_POINTS_END_MS) return FABLES_POINTS_END_MS;
  const elapsed = timestampMs - FABLES_POINTS_START_MS;
  return FABLES_POINTS_START_MS + Math.floor(elapsed / POINTS_DAY_MS) * POINTS_DAY_MS;
}

export function latestCompletedPointsBoundaryMs(nowMs = Date.now()) {
  return pointsBoundaryAtOrBefore(nowMs);
}

export function dailyPointBudget(timestampMs) {
  const week = pointsWeekIndex(timestampMs);
  if (week < 0) return 0;
  return FABLES_LP_POINTS_TOTAL * FABLES_WEEKLY_POINT_WEIGHTS[week] / 7;
}

export function estimateDailyPoints(timestampMs, userFeeUsd, totalFablesFeeUsd) {
  if (!(userFeeUsd > 0) || !(totalFablesFeeUsd > 0)) return 0;
  return dailyPointBudget(timestampMs) * userFeeUsd / totalFablesFeeUsd;
}

export function estimatePointsFromDailyBuckets(buckets, { requireComplete = false } = {}) {
  let total = 0;
  for (const bucket of Object.values(buckets || {})) {
    if (requireComplete && bucket.complete === false) continue;
    total += estimateDailyPoints(
      bucket.timestampMs,
      bucket.userFeeUsd || 0,
      bucket.totalFeeUsd || 0
    );
  }
  return total;
}

export function impliedDailyFeeShare(points, timestampMs) {
  const budget = dailyPointBudget(timestampMs);
  return budget > 0 && points >= 0 ? Number(points) / budget : null;
}

// Backward-compatible alias. Points Accounting V2 must use the campaign epoch
// anchored at 02:00 UTC rather than civil UTC midnight.
export function utcDayKey(timestampMs) {
  return pointsCampaignDayKey(timestampMs);
}
