import {
  POINTS_DAY_MS,
  dailyPointBudget,
  estimateDailyPoints,
  latestCompletedPointsBoundaryMs,
  pointsBoundaryAtOrBefore,
  pointsCampaignDayKey,
  pointsCampaignDayStartMs
} from './points.js';
import { fetchOfficialPoints, fetchWalletFeeEvidence } from './points-evidence.js';
import {
  FABLES_POINTS_END_MS,
  FABLES_POINTS_START_MS
} from '../constants.js';

const USER_FEE_TYPES = new Set(['fee.accrual', 'points.user_fee_adjustment']);
const GLOBAL_FEE_TYPE = 'points.global_swap_fee';
const EVIDENCE_REFRESH_MS = 60_000;

export class PointsTracker {
  constructor(config, ledger, state) {
    this.config = config;
    this.ledger = ledger;
    this.state = state;
    this.lastEvidenceAttemptAt = 0;
    this.evidencePromise = null;
    this.walletEvidence = null;
    this.evidenceError = null;
    this.cachedSnapshot = null;
    this.lastSimulationAt = 0;

    this.migratePointBaselines(config);

  }

  migratePointBaselines(config) {
    const storedOfficial = this.state.getSetting('pointsOfficial', null);
    const officialWallet = String(storedOfficial?.wallet || '').toLowerCase();
    const configuredWallet = String(config.walletAddress || '').toLowerCase();
    const walletMatches = !officialWallet || !configuredWallet || officialWallet === configuredWallet;
    const officialPoints = Number(storedOfficial?.lpPoints || 0) + Number(storedOfficial?.referralPoints || 0);
    const officialAtMs = timestampMs(storedOfficial?.settledAt);
    const hasOfficialBaseline = walletMatches
      && Number.isFinite(officialPoints)
      && officialPoints >= 0
      && Number.isFinite(officialAtMs)
      && officialAtMs > 0;
    const storedBaselineRaw = this.state.getSetting('actualPointsBaseline', 0);
    const storedBaseline = Number(storedBaselineRaw || 0);
    const storedAtRaw = this.state.getSetting('actualPointsBaselineAt', null);
    let manualBaseline = this.state.getSetting('manualPointsBaseline', null);
    let manualAt = this.state.getSetting('manualPointsBaselineAt', null);

    if (manualBaseline == null) {
      if (hasOfficialBaseline && storedBaselineRaw != null && storedBaseline !== officialPoints
        && (storedBaseline > 0 || storedAtRaw != null)) {
        manualBaseline = storedBaseline;
        manualAt = storedAtRaw || null;
      } else if (storedBaseline > 0 && !hasOfficialBaseline) {
        manualBaseline = storedBaseline;
        manualAt = storedAtRaw || null;
      } else if (Number(config.actualPointsBaseline) > 0) {
        manualBaseline = Number(config.actualPointsBaseline);
        manualAt = config.actualPointsBaselineAt || null;
      }
      if (manualBaseline != null) {
        this.state.setSetting('manualPointsBaseline', manualBaseline);
        this.state.setSetting('manualPointsBaselineAt', manualAt || new Date().toISOString());
      }
    }

    if (hasOfficialBaseline) {
      const normalizedAt = new Date(normalizedBoundary(officialAtMs)).toISOString();
      if (storedBaseline !== officialPoints || storedAtRaw !== normalizedAt) {
        this.state.setSetting('actualPointsBaseline', officialPoints);
        this.state.setSetting('actualPointsBaselineAt', normalizedAt);
        this.state.setSetting('pointsLastReconciliation', null);
        this.ledger.append('points.official_baseline_restored', {
          points: officialPoints,
          at: normalizedAt,
          reason: 'restore authoritative official settlement after local baseline override'
        });
      }
      return;
    }

    if (storedBaseline !== 0 || storedAtRaw != null) {
      this.state.setSetting('actualPointsBaseline', 0);
      this.state.setSetting('actualPointsBaselineAt', null);
      this.state.setSetting('pointsLastReconciliation', null);
      this.ledger.append('points.legacy_baseline_moved_to_manual', {
        points: storedBaseline,
        previousAt: storedAtRaw,
        reason: 'legacy local baseline is display fallback only; it is not an official checkpoint'
      });
    }
  }

  noteUserTrackingStarted(at = Date.now()) {
    const current = this.state.getSetting('pointsUserTrackingStartedAtV2', null);
    if (current == null) this.state.setSetting('pointsUserTrackingStartedAtV2', Number(at));
    this.invalidate();
  }

  markUserCoverageBroken(at = Date.now(), reason = 'unknown', detail = {}) {
    const brokenAt = Number(at);
    const current = this.state.getSetting('pointsUserCoverageBrokenV2', null);
    // One unresolved gap is enough to invalidate the interval until the next
    // official checkpoint. Preserve the earliest gap and avoid log spam while a
    // recoverable reconciliation is retried.
    if (current?.at != null && Number(current.at) <= brokenAt) return current;
    const item = { at: brokenAt, reason, ...detail };
    this.state.setSetting('pointsUserCoverageBrokenV2', item);
    this.ledger.append('points.user_coverage_broken', item, brokenAt);
    this.invalidate();
    return item;
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

  setManualBaseline(points, at = null) {
    const value = Number(points);
    if (!Number.isFinite(value) || value < 0) throw new Error('Manual points baseline must be a non-negative number');
    const requestedMs = at == null ? Date.now() : timestampMs(at);
    if (!Number.isFinite(requestedMs) || requestedMs <= 0) throw new Error('Manual points baseline timestamp is invalid');
    const iso = new Date(requestedMs).toISOString();
    this.state.setSetting('manualPointsBaseline', value);
    this.state.setSetting('manualPointsBaselineAt', iso);
    this.ledger.append('points.manual_baseline', {
      points: value,
      at: iso,
      requestedAt: at == null ? null : String(at),
      affectsPredictionStart: false
    }, requestedMs);
    this.invalidate();
    return { points: value, at: iso, source: 'manual-fallback' };
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
      const before = this.snapshot({ atMs, force: true });
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
    const broken = this.state.getSetting('pointsUserCoverageBrokenV2', null);
    if (broken?.at != null && Number(broken.at) <= atMs) {
      this.state.setSetting('pointsUserCoverageBrokenV2', null);
    }
    this.ledger.append('points.actual_baseline', {
      points: value,
      at: iso,
      requestedAt: at ? String(at) : null,
      campaignBoundaryNormalized: true
    }, atMs);
    this.invalidate();
    return { points: value, at: iso, reconciliation };
  }

  invalidate() {
    this.cachedSnapshot = null;
  }

  async refreshEvidence({ address, provider, pools, prices, force = false }) {
    if (!address || !provider || !pools?.length || !prices?.size) return;
    if (this.evidencePromise) return this.evidencePromise;
    if (!force && Date.now() - this.lastEvidenceAttemptAt < EVIDENCE_REFRESH_MS) return;
    this.lastEvidenceAttemptAt = Date.now();
    this.evidencePromise = this.fetchAndApplyEvidence({ address, provider, pools, prices });
    try { return await this.evidencePromise; }
    finally { this.evidencePromise = null; }
  }

  async fetchAndApplyEvidence(context) {
    const [officialResult, walletResult] = await Promise.allSettled([
      fetchOfficialPoints(context.address),
      fetchWalletFeeEvidence(context)
    ]);
    if (walletResult.status === 'fulfilled') {
      const evidence = walletResult.value;
      const localHashes = new Set(this.ledger.all()
        .filter((event) => ['lp.deposit', 'lp.withdraw', 'tx.confirmed'].includes(event.type))
        .map((event) => String(event.hash || '').toLowerCase()));
      evidence.localTxCount = evidence.transactionHashes.length;
      evidence.localTxMatched = evidence.transactionHashes.filter((hash) => localHashes.has(hash)).length;
      delete evidence.transactionHashes;
      this.walletEvidence = evidence;
    }
    if (officialResult.status === 'fulfilled') {
      this.applyOfficialSettlement(officialResult.value, walletResult.status === 'fulfilled' ? walletResult.value : null);
    }
    this.evidenceError = [officialResult, walletResult]
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason?.message || 'points evidence unavailable').join('; ') || null;
    this.invalidate();
    return this.evidenceError ? { ok: false, error: this.evidenceError } : { ok: true };
  }

  applyOfficialSettlement(official, walletEvidence) {
    const prior = this.state.getSetting('pointsOfficial', null);
    const priorForWallet = prior?.wallet === official.wallet ? prior : null;
    if (priorForWallet && Number(priorForWallet.settledAt) > official.settledAt) return;

    const totalPoints = Number(official.lpPoints || 0) + Number(official.referralPoints || 0);
    const settlementChanged = !priorForWallet
      || Number(priorForWallet.settledAt) !== Number(official.settledAt)
      || Number(priorForWallet.lpPoints || 0) !== Number(official.lpPoints || 0)
      || Number(priorForWallet.referralPoints || 0) !== Number(official.referralPoints || 0);
    if (settlementChanged) {
      if (prior && prior.wallet !== official.wallet) {
        this.state.setSetting('actualPointsBaseline', 0);
        this.state.setSetting('actualPointsBaselineAt', null);
        this.state.setSetting('pointsLastReconciliation', null);
      }
      this.setActualBaseline(totalPoints, new Date(official.settledAt).toISOString());
    }

    if (priorForWallet && Number(priorForWallet.settledAt) < official.settledAt) {
      const addedPoints = Number(official.lpPoints || 0) - Number(priorForWallet.lpPoints || 0);
      const addedFees = Number(official.settledFeesUsd || 0) - Number(priorForWallet.settledFeesUsd || 0);
      if (addedPoints >= 0 && addedFees > 0.005) {
        this.state.setSetting('pointsCalibration', {
          wallet: official.wallet,
          pointsPerFeeUsd: addedPoints / addedFees,
          feeUsd: addedFees,
          points: addedPoints,
          programmeDayEnd: official.settledAt,
          source: 'consecutive-official-settlements'
        });
      }
    } else if (!priorForWallet && walletEvidence?.firstDepositAt != null
      && walletEvidence.firstDepositAt >= official.settledAt - POINTS_DAY_MS
      && walletEvidence.firstDepositAt < official.settledAt
      && Number(official.lpPoints) > 0 && Number(official.settledFeesUsd) > 0.005) {
      this.state.setSetting('pointsCalibration', {
        wallet: official.wallet,
        pointsPerFeeUsd: Number(official.lpPoints) / Number(official.settledFeesUsd),
        feeUsd: Number(official.settledFeesUsd),
        points: Number(official.lpPoints),
        programmeDayEnd: official.settledAt,
        source: 'first-wallet-lp-day'
      });
    }

    if (settlementChanged || !priorForWallet || priorForWallet.settledFeesUsd !== official.settledFeesUsd) {
      this.ledger.appendUnique(
        `points-settled:${official.wallet}:${official.settledAt}`,
        'points.official_settlement',
        {
          settledAt: official.settledAt,
          lpPoints: official.lpPoints,
          referralPoints: official.referralPoints,
          settledFeesUsd: official.settledFeesUsd,
          source: 'Fables points API'
        }
      );
      this.state.setSetting('pointsOfficial', official);
    }
  }

  snapshot(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('snapshot expects an options object');
    }
    const atMs = Number.isFinite(Number(options.atMs)) ? Number(options.atMs) : Date.now();
    const force = options.force === true;
    const simulationIntervalMs = Math.max(5_000, Number(this.config.pointsSimulationIntervalMs) || 15_000);
    if (!force && this.cachedSnapshot && Date.now() - this.lastSimulationAt < simulationIntervalMs) {
      return this.withEvidence(this.cachedSnapshot, atMs);
    }
    const nowMs = atMs;
    const actualBaseline = Number(this.state.getSetting('actualPointsBaseline', 0) || 0);
    const baselineAtRaw = this.state.getSetting('actualPointsBaselineAt', null);
    const baselineAtMs = baselineAtRaw ? Date.parse(baselineAtRaw) : 0;
    const predictionStartMs = this.predictionStartMs(nowMs);
    const globalScanProgress = this.state.getSetting('pointsGlobalScanProgress', null);
    const globalBackfillComplete = this.config.pointsGlobalSwapScanEnabled !== true
      || globalScanProgress?.complete === true;
    const trackingStartedAt = Number(this.state.getSetting('pointsUserTrackingStartedAtV2', 0) || 0);
    const coverageBroken = this.state.getSetting('pointsUserCoverageBrokenV2', null);
    const coverageBrokenAt = Number(coverageBroken?.at || 0);
    const userCoverageGloballyComplete = trackingStartedAt > 0
      && trackingStartedAt <= predictionStartMs
      && !(coverageBrokenAt >= predictionStartMs);
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
      bucket.userCoverageComplete = userCoverageGloballyComplete;
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
    const exactEstimatedDelta = hasIncomplete || !globalBackfillComplete
      ? null
      : settledEstimatedDelta + (projectedCurrentDay || 0);

    let status = 'ready';
    if (!(actualBaseline > 0) || !(baselineAtMs > 0)) status = 'needs-official-baseline';
    else if (totalGlobalSwaps === 0) status = 'waiting-for-global-swaps';
    else if (!globalBackfillComplete) status = 'backfilling-global-swaps';
    else if (totalUnpricedSwaps > 0) status = 'incomplete-denominator';
    else if (!userCoverageGloballyComplete) status = 'incomplete-user-coverage';
    else if (hasIncomplete) status = 'incomplete-coverage';

    const estimatedTotal = actualBaseline > 0 && exactEstimatedDelta != null
      ? actualBaseline + exactEstimatedDelta
      : null;
    const provisionalEstimatedTotal = actualBaseline + provisionalEstimatedDelta;
    const nextDistributionAt = currentDayStart == null
      ? null
      : new Date(Math.min(currentDayStart + POINTS_DAY_MS, FABLES_POINTS_END_MS)).toISOString();

    const snapshot = {
      version: 2,
      status,
      actualBaseline,
      actualBaselineAt: baselineAtRaw,
      manualBaseline: this.state.getSetting('manualPointsBaseline', null),
      manualBaselineAt: this.state.getSetting('manualPointsBaselineAt', null),
      predictionStartAt: new Date(predictionStartMs).toISOString(),
      userTrackingStartedAt: trackingStartedAt > 0 ? new Date(trackingStartedAt).toISOString() : null,
      userCoverageBrokenAt: coverageBrokenAt > 0 ? new Date(coverageBrokenAt).toISOString() : null,
      userCoverageBrokenReason: coverageBroken?.reason || null,
      settledEstimatedDelta,
      projectedCurrentDay,
      estimatedDelta: exactEstimatedDelta,
      estimatedTotal,
      provisionalEstimatedDelta,
      provisionalEstimatedTotal,
      nextDistributionAt,
      globalSwapCount: totalGlobalSwaps,
      globalScanProgress,
      unpricedGlobalSwapCount: totalUnpricedSwaps,
      denominatorCoveragePct: totalGlobalSwaps > 0
        ? (totalGlobalSwaps - totalUnpricedSwaps) / totalGlobalSwaps * 100
        : 0,
      lastReconciliation: this.state.getSetting('pointsLastReconciliation', null),
      buckets
    };
    this.lastSimulationAt = Date.now();
    this.cachedSnapshot = snapshot;
    return this.withEvidence(snapshot, nowMs);
  }

  withEvidence(snapshot, nowMs) {
    const official = this.state.getSetting('pointsOfficial', null);
    const calibration = this.state.getSetting('pointsCalibration', null);
    const matchingEvidence = official && this.walletEvidence?.wallet === official.wallet ? this.walletEvidence : null;
    const matchingCalibration = official && calibration?.wallet === official.wallet ? calibration : null;
    const unsettled = matchingEvidence && official
      ? Number(matchingEvidence.lifetimeFeeUsd) - Number(official.settledFeesUsd || 0)
      : null;
    const unsettledFeeUsd = unsettled != null && unsettled >= -0.05 ? Math.max(0, unsettled) : null;
    const currentBudget = dailyPointBudget(Math.min(nowMs, FABLES_POINTS_END_MS - 1));
    const settledBudget = matchingCalibration
      ? dailyPointBudget(Number(matchingCalibration.programmeDayEnd) - 1)
      : 0;
    const calibratedPointsPerFeeUsd = matchingCalibration && settledBudget > 0
      ? Number(matchingCalibration.pointsPerFeeUsd) * currentBudget / settledBudget
      : null;
    const buckets = { ...snapshot.buckets };
    for (const bucket of Object.values(buckets)) bucket.source = 'estimate';
    for (const day of official?.history || []) {
      const key = pointsCampaignDayKey(Number(day.settledAt) - 1);
      if (!key) continue;
      buckets[key] = {
        ...(buckets[key] || {}),
        source: 'official',
        timestampMs: Number(day.settledAt) - 1,
        actualPoints: Number(day.lpPoints || 0) + Number(day.referralPoints || 0)
      };
    }
    return {
      ...snapshot,
      buckets,
      actualPointsFromFables: Boolean(official),
      settledLpPoints: official?.lpPoints ?? null,
      settledReferralPoints: official?.referralPoints ?? null,
      settledFeeUsd: official?.settledFeesUsd ?? null,
      officialSettledAt: official?.settledAt ?? null,
      walletFeeEvidence: matchingEvidence,
      unsettledFeeUsd,
      calibratedPointsPerFeeUsd,
      calibrationSource: matchingCalibration?.source || null,
      evidenceError: this.evidenceError,
      simulatedAt: this.lastSimulationAt,
      simulationIntervalMs: Math.max(5_000, Number(this.config.pointsSimulationIntervalMs) || 15_000),
      nextSimulationAt: this.lastSimulationAt + Math.max(5_000, Number(this.config.pointsSimulationIntervalMs) || 15_000)
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

function timestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
