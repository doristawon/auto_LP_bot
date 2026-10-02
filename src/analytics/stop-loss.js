export function normalizeStopLoss(value) {
  if (typeof value?.enabled !== 'boolean') throw new Error('請提供停損啟用狀態。');
  const lossPct = Number(value.lossPct);
  if (!Number.isFinite(lossPct) || lossPct < 0.1 || lossPct > 99) throw new Error('停損門檻須介於 0.1% 與 99%。');
  const basisMode = value.basisMode ?? 'armed-equity';
  if (!['armed-equity', 'lp-session'].includes(basisMode)) throw new Error('停損起算方式無效。');
  return { enabled: value.enabled, lossPct, basisMode, version: basisMode === 'lp-session' ? 2 : 1 };
}

// Capture once, after an LP is confirmed in a complete portfolio valuation.
// Range IDs change during rebalancing; they are evidence, not a reset trigger.
export function captureLpSessionReference(snapshot, walletAddress, { minimumAt = 0, now = Date.now() } = {}) {
  const at = Number(snapshot?.generatedAt || 0);
  const equityUsd = snapshot?.portfolio?.currentValueUsd;
  if (!Number.isFinite(at) || at <= 0 || at < minimumAt || now - at < -30_000 || now - at > 15 * 60_000
    || !Number.isFinite(equityUsd) || equityUsd <= 0
    || String(snapshot?.bot?.wallet || '').toLowerCase() !== String(walletAddress).toLowerCase()) return null;
  const positions = (snapshot.portfolio.positions || []).filter(position => {
    try { return BigInt(position.shares || 0) > 0n && Number.isFinite(position.principalUsd) && position.principalUsd > 0; }
    catch { return false; }
  });
  if (!positions.length) return null;
  return { basisMode: 'lp-session', equityUsd, at, asOfBlock: snapshot.blockNumber,
    netCashflowUsd: snapshot.portfolio.netCashflowUsd,
    flowAccountingComplete: snapshot.portfolio.accountingComplete === true,
    wallet: walletAddress.toLowerCase(), source: 'confirmed-lp-portfolio',
    initialPositions: positions.map(p => ({ poolId: p.poolId, rangeId: p.id, shares: String(p.shares) })) };
}

export function evaluateStopLoss(settings, reference, snapshot, now = Date.now()) {
  if (!settings?.enabled) return { status: 'disabled', triggered: false };
  if (settings.enabled !== true || !Number.isFinite(settings.lossPct) || settings.lossPct < 0.1 || settings.lossPct > 99) {
    return { status: 'unavailable', triggered: false, reason: '停損設定無效。' };
  }
  if (settings.basisMode === 'lp-session' && (!reference || reference.pending === true)) {
    const hasLp = (snapshot?.portfolio?.positions || []).some(position => {
      try { return BigInt(position.shares || 0) > 0n; } catch { return false; }
    });
    return { status: hasLp ? 'unavailable' : 'waiting-lp', triggered: false, basisMode: 'lp-session',
      thresholdPct: settings.lossPct, reason: '等待 LP 投入確認後的完整資產估值；再平衡不會重設基準。' };
  }
  if (settings.basisMode === 'lp-session' && reference.basisMode !== 'lp-session') {
    return { status: 'unavailable', triggered: false, reason: 'LP 起算基準尚未建立。' };
  }
  const equity = snapshot?.portfolio?.currentValueUsd;
  const principal = reference?.equityUsd;
  const age = now - Number(snapshot?.generatedAt || 0);
  if (!Number.isFinite(principal) || !(principal > 0) || !Number.isFinite(equity) || equity < 0
    || !Number.isFinite(age) || !(Number(snapshot?.generatedAt) > 0)
    || !(Number(reference?.at) > 0) || age < -30_000 || age > 15 * 60_000
    || (reference?.wallet && snapshot?.bot?.wallet && reference.wallet.toLowerCase() !== snapshot.bot.wallet.toLowerCase())) {
    return { status: 'unavailable', triggered: false, reason: '停損基準或最新估值尚未就緒。' };
  }
  // The user explicitly chooses equity at arming, not an unaudited historical cost.
  // Only fully reconciled cashflows can adjust the reference automatically.
  // Otherwise this is explicitly a fixed-equity drawdown, not historical P&L.
  const flowComplete = reference.flowAccountingComplete === true && snapshot.portfolio.accountingComplete === true
    && Number.isFinite(reference.netCashflowUsd) && Number.isFinite(snapshot.portfolio.netCashflowUsd);
  const flowDelta = flowComplete ? snapshot.portfolio.netCashflowUsd - reference.netCashflowUsd : 0;
  const adjustedPrincipal = principal + flowDelta;
  if (!(adjustedPrincipal > 0) || !Number.isFinite(adjustedPrincipal)) return { status: 'unavailable', triggered: false };
  const lossPct = Math.max(0, (adjustedPrincipal - equity) / adjustedPrincipal * 100);
  return { status: 'monitoring', triggered: lossPct >= settings.lossPct, basisMode: settings.basisMode || 'armed-equity',
    lossPct, thresholdPct: settings.lossPct, equityUsd: equity, principalUsd: adjustedPrincipal,
    triggerBelowUsd: adjustedPrincipal * (1 - settings.lossPct / 100),
    basisAt: reference.at, flowAccountingComplete: flowComplete,
    flowMode: flowComplete ? 'reconciled-flows' : 'fixed-equity',
    transferNotice: flowComplete ? null : '轉入／轉出後請重新設定基準；對帳未完整時採固定啟用估值。' };
}
