import { estimatePointsFromDailyBuckets, utcDayKey } from './points.js';

export class PointsTracker {
  constructor(config, ledger, state) {
    this.config = config;
    this.ledger = ledger;
    this.state = state;
    if (this.state.getSetting('actualPointsBaseline', null) == null && config.actualPointsBaseline > 0) {
      this.state.setSetting('actualPointsBaseline', config.actualPointsBaseline);
      this.state.setSetting('actualPointsBaselineAt', config.actualPointsBaselineAt || new Date().toISOString());
    }
  }

  setActualBaseline(points, at = new Date().toISOString()) {
    this.state.setSetting('actualPointsBaseline', Number(points) || 0);
    this.state.setSetting('actualPointsBaselineAt', at);
    this.ledger.append('points.actual_baseline', { points: Number(points) || 0, at });
  }

  snapshot() {
    const actualBaseline = Number(this.state.getSetting('actualPointsBaseline', 0) || 0);
    const baselineAtRaw = this.state.getSetting('actualPointsBaselineAt', null);
    const baselineAtMs = baselineAtRaw ? Date.parse(baselineAtRaw) : 0;
    const buckets = {};
    for (const event of this.ledger.all()) {
      if (baselineAtMs && event.ts < baselineAtMs) continue;
      if (event.type !== 'fee.accrual' && event.type !== 'pool.fee') continue;
      const key = utcDayKey(event.ts);
      if (!buckets[key]) buckets[key] = { timestampMs: event.ts, userFeeUsd: 0, totalFeeUsd: 0 };
      if (event.type === 'fee.accrual') buckets[key].userFeeUsd += Number(event.feeUsd || 0);
      if (event.type === 'pool.fee') buckets[key].totalFeeUsd += Number(event.feeUsd || 0);
    }
    const estimatedDelta = estimatePointsFromDailyBuckets(buckets);
    return {
      actualBaseline,
      actualBaselineAt: baselineAtRaw,
      estimatedDelta,
      estimatedTotal: actualBaseline + estimatedDelta,
      buckets
    };
  }
}
