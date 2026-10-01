const normalizeId = (value) => String(value || '').trim().toLowerCase();

/** Resolve top-up swap permission and price impact from persisted target policy. */
export function resolveTopUpSwapPolicy({
  poolId,
  autoTopupSwapEnabled = false,
  autoTopupSwapPoolId = '',
  autoTopupMaxSwapPriceImpactBps,
  maxSwapPriceImpactBps,
  crossPoolMaxSwapPriceImpactBps,
  allocationEnabled = false,
  investmentTargetMode = 'apr-highest',
  investmentTargetPoolId = '',
  verifiedExistingInRangePosition = false
} = {}) {
  const selectedPoolId = normalizeId(poolId);
  const configuredPoolId = normalizeId(autoTopupSwapPoolId);
  const targetPoolId = normalizeId(investmentTargetPoolId);
  const usesConfiguredSwapLimit = Boolean(selectedPoolId && configuredPoolId === selectedPoolId);
  const isSavedSpecificTarget = investmentTargetMode === 'specific-pool'
    && Boolean(selectedPoolId && targetPoolId === selectedPoolId);
  const savedSpecificTargetMismatch = allocationEnabled !== true
    && investmentTargetMode === 'specific-pool'
    && Boolean(targetPoolId && selectedPoolId && targetPoolId !== selectedPoolId);
  const isVerifiedAutoAprPosition = investmentTargetMode === 'apr-highest'
    && verifiedExistingInRangePosition === true;
  const swapEnabledForPool = autoTopupSwapEnabled === true
    && !savedSpecificTargetMismatch
    && (allocationEnabled === true || usesConfiguredSwapLimit
      || isSavedSpecificTarget || isVerifiedAutoAprPosition);

  let maxPriceImpactBps = usesConfiguredSwapLimit
    ? autoTopupMaxSwapPriceImpactBps ?? maxSwapPriceImpactBps ?? 200
    : maxSwapPriceImpactBps ?? 200;
  if (!usesConfiguredSwapLimit && (isSavedSpecificTarget || isVerifiedAutoAprPosition)) {
    // A saved target can use the already-authorized top-up/cross-pool cap,
    // while never widening this path beyond 3.5%.
    const configuredTargetCaps = [autoTopupMaxSwapPriceImpactBps, crossPoolMaxSwapPriceImpactBps]
      .filter((limit) => limit != null).map(Number);
    const existingCap = configuredTargetCaps.length
      ? Math.min(...configuredTargetCaps)
      : Number(maxSwapPriceImpactBps ?? 200);
    const authorizedTargetCap = Math.min(350, existingCap);
    maxPriceImpactBps = authorizedTargetCap;
  }
  const numericLimit = Number(maxPriceImpactBps);
  if (!Number.isFinite(numericLimit) || numericLimit < 0) {
    throw new Error('Top-up swap price impact limit must be a non-negative number');
  }

  return {
    swapEnabledForPool,
    usesConfiguredSwapLimit,
    isSavedSpecificTarget,
    savedSpecificTargetMismatch,
    isVerifiedAutoAprPosition,
    maxPriceImpactBps: Math.floor(numericLimit)
  };
}
