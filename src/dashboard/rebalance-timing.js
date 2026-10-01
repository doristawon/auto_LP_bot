// This is an estimate of the next policy check, never a promise that a transaction will be sent.
export function rebalanceTiming(status, snapshot, nowMs = Date.now()) {
  const base = { phase: 'unknown', pair: null, targetAt: null, policyReadyAt: null,
    backoffUntil: null, nextMonitorAt: status?.nextMonitorAt || null };
  if (status?.recoveryRequired) return { ...base, phase: 'recovery' };
  if (status?.executionBusy) return { ...base, phase: 'executing' };
  if (status?.executionPaused) return { ...base, phase: 'paused' };
  if (status?.cycleActive) return { ...base, phase: 'scanning' };

  const pollMs = Math.max(1000, Number(status?.strategy?.monitorPollIntervalMs) || 300_000);
  const snapshotAt = Number(snapshot?.generatedAt || 0);
  if (!snapshotAt || nowMs - snapshotAt > Math.max(15 * 60_000, 3 * pollMs)) {
    return { ...base, phase: 'stale' };
  }
  const active = (snapshot?.portfolio?.positions || []).filter((position) => {
    try { return BigInt(position.shares || 0) > 0n; } catch { return false; }
  });
  if (!active.length) return { ...base, phase: 'no-position' };
  const selectedId = String(status?.selectedExecutionTargetPoolId || '').toLowerCase();
  const position = active.find((item) => item.outside && String(item.poolId).toLowerCase() === selectedId)
    || active.find((item) => item.outside) || active[0];
  if (!position.outside) return { ...base, phase: 'in-range', pair: position.pair || null,
    targetAt: Number(status?.nextMonitorAt) > 0 ? Number(status.nextMonitorAt) : null };

  const outSince = Number(position.outOfRangeSince || 0);
  if (!(outSince > 0)) return { ...base, phase: 'awaiting-observation', pair: position.pair || null };
  const confirmMs = Math.max(0, Number(status?.strategy?.confirmDelayMin || 15) * 60_000);
  const policyReadyAt = outSince + confirmMs;
  const backoff = (status?.rebalanceBackoffs || []).find((item) =>
    String(item.poolId || '').toLowerCase() === String(position.poolId || '').toLowerCase()
    && String(item.positionId || '').toLowerCase() === String(position.id || '').toLowerCase());
  const backoffUntil = Math.max(0, Number(backoff?.nextRetryAt || 0));
  const nextMonitorAt = Number(status?.nextMonitorAt || 0);
  const common = { ...base, pair: position.pair || null, policyReadyAt,
    backoffUntil: backoffUntil > nowMs ? backoffUntil : null };
  if (!(nextMonitorAt > 0)) return { ...common, phase: 'awaiting-schedule' };

  const readyAt = Math.max(policyReadyAt, backoffUntil, nowMs);
  const cycles = Math.max(0, Math.ceil((readyAt - nextMonitorAt) / pollMs));
  const targetAt = Math.max(nowMs, nextMonitorAt + cycles * pollMs);
  const phase = backoffUntil > nowMs ? 'backoff'
    : !position.shouldRebalance ? 'confirming' : 'scheduled';
  return { ...common, phase, targetAt };
}
