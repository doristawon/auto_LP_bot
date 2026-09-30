export function normalizeStopLoss(value) {
  if (typeof value?.enabled !== 'boolean') throw new Error('請提供停損啟用狀態。');
  const lossPct = Number(value.lossPct);
  if (!Number.isFinite(lossPct) || lossPct < 0.1 || lossPct > 99) throw new Error('停損門檻須介於 0.1% 與 99%。');
  return { enabled: value.enabled, lossPct, basisMode: 'armed-equity', version: 1 };
}

export function evaluateStopLoss(settings, reference, snapshot, now = Date.now()) {
  if (!settings?.enabled) return { status: 'disabled', triggered: false };
  if (settings.enabled !== true || !Number.isFinite(settings.lossPct) || settings.lossPct < 0.1 || settings.lossPct > 99) {
    return { status: 'unavailable', triggered: false, reason: '停損設定無效。' };
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
  return { status: 'monitoring', triggered: lossPct >= settings.lossPct,
    lossPct, thresholdPct: settings.lossPct, equityUsd: equity, principalUsd: adjustedPrincipal,
    triggerBelowUsd: adjustedPrincipal * (1 - settings.lossPct / 100),
    basisAt: reference.at, flowAccountingComplete: flowComplete,
    flowMode: flowComplete ? 'reconciled-flows' : 'fixed-equity',
    transferNotice: flowComplete ? null : '轉入／轉出後請重新設定基準；對帳未完整時採固定啟用估值。' };
}
