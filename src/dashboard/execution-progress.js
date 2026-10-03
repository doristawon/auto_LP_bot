import { sanitize } from '../logger.js';

const STEP_LABELS = ['預檢', '撤出 LP', '換幣', '存入 LP', '核對'];
const STEP_KEYS = ['preflight', 'withdraw', 'swap', 'deposit', 'verify'];
const OFFICIAL_REPOSITION_LABEL = '領取手續費＋官方一次再平衡';
const OFFICIAL_PHASES = new Set(['official_preflighted', 'official_sent', 'official_confirmed']);
const STAGES = {
  prepared: 0, approvals_ready: 0, withdraw_preflighted: 0,
  sequence_preflighted: 0, cross_pool_preflighted: 0,
  official_preflighted: 0, official_sent: 1, official_confirmed: 2,
  withdraw_sent: 1, withdraw_confirmed: 2, withdraw_not_required: 2,
  route_swap_sent: 2, route_swap_confirmed: 2, swap_preflighted: 2, swap_sent: 2,
  swap_confirmed: 3, swap_not_required: 3, deposit_preflighted: 3, deposit_sent: 3,
  deposit_confirmed: 4, atomic_preflighted: 2, atomic_sent: 2, atomic_retry: 2,
  atomic_confirmed: 4, completed: 4
};
const ATOMIC_PHASES = new Set(['atomic_preflighted', 'atomic_sent', 'atomic_retry', 'atomic_confirmed']);
const cleanText = (value, max = 180) => typeof value === 'string'
  ? sanitize(value).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '';
const hashValue = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) ? value : null;

// Presentation only: derive progress from persisted phases. No timers, RPC,
// transaction submission, or guessed completion percentages.
export function describeExecutionProgress(journal) {
  if (!journal?.id || !journal.phase) return null;
  if (journal.kind === 'fee_claim') return describeFeeClaim(journal);
  const phase = String(journal.phase);
  const status = phase === 'completed' ? 'completed' : phase === 'failed' ? 'failed'
    : phase === 'recovery_required' ? 'recovery' : 'running';
  const observedPhase = ['failed', 'recovery_required', 'tx_broadcast_pending'].includes(phase)
    ? journal.pendingTx?.previousPhase || journal.lastKnownPhase || 'prepared' : phase;
  const officialFlow = OFFICIAL_PHASES.has(observedPhase)
    || Object.hasOwn(journal.tx || {}, 'officialReposition');
  const atomicFlow = ATOMIC_PHASES.has(observedPhase) || Object.hasOwn(journal.tx || {}, 'atomicSwapDeposit')
    || Array.isArray(journal.tx?.atomicReverts);
  const kind = journal.kind === 'stop_liquidation' ? 'stop'
    : journal.kind === 'liquidity_top_up' ? 'topup'
    : Object.hasOwn(journal, 'oldPosition') && !journal.oldPosition ? 'bootstrap'
    : journal.destinationPoolId ? 'rotation' : 'rebalance';
  const stopStage = String(journal.step || '').startsWith('withdraw:') ? 1
    : String(journal.step || '').startsWith('swap:') ? 2 : 0;
  const officialStepIndex = officialFlow
    ? status === 'completed' || observedPhase === 'official_confirmed' ? 2
      : observedPhase === 'official_preflighted' && !journal.tx?.officialReposition ? 0
        : journal.tx?.officialReposition || observedPhase === 'official_sent' ? 1 : 0
    : null;
  const atomicStepIndex = ['atomic_preflighted', 'atomic_sent', 'atomic_retry'].includes(observedPhase)
    ? journal.atomicSwapRequired === true ? 2 : 3
    : observedPhase === 'atomic_confirmed' ? 4 : null;
  const stepIndex = officialStepIndex ?? (kind === 'stop'
    ? status === 'completed' ? 4 : stopStage
    : atomicStepIndex ?? STAGES[observedPhase] ?? 0);
  const completed = status === 'completed';
  const skippedWithdraw = kind === 'topup' || kind === 'bootstrap'
    || observedPhase === 'withdraw_not_required';
  const skippedSwap = observedPhase === 'swap_not_required'
    || atomicFlow && journal.atomicSwapRequired !== true
    || !atomicFlow && (journal.swapPolicy === 'deposit-only'
      || (stepIndex >= 3 && !journal.tx?.swap && !(journal.tx?.routeSwaps?.length)));
  const stepStatus = (index, skipped = false) => {
    let state = skipped ? 'skipped' : completed || index < stepIndex ? 'completed'
      : index === stepIndex ? 'active' : 'pending';
    if (!skipped && index === stepIndex && status === 'failed') state = 'failed';
    if (!skipped && index === stepIndex && status === 'recovery') state = 'attention';
    return state;
  };
  const steps = officialFlow ? [
    { key: 'preflight', label: '預檢', status: stepStatus(0) },
    { key: 'officialReposition', label: OFFICIAL_REPOSITION_LABEL, status: stepStatus(1) },
    { key: 'verify', label: '核對', status: stepStatus(2) }
  ] : STEP_KEYS.map((key, index) => {
    const skipped = key === 'withdraw' && skippedWithdraw
      || key === 'swap' && skippedSwap || kind === 'stop' && key === 'deposit';
    return { key, label: STEP_LABELS[index], status: stepStatus(index, skipped) };
  });
  const transactions = [];
  const addTransaction = (step, label, hash, receiptState) => {
    hash = hashValue(hash);
    if (!hash) return;
    const existing = transactions.find(item => item.hash.toLowerCase() === hash.toLowerCase());
    if (existing) return;
    transactions.push({ step, label, hash, status: receiptState });
  };
  const receiptState = confirmed => confirmed ? 'confirmed'
    : status === 'recovery' || status === 'failed' ? 'unknown' : 'pending';
  if (officialFlow && kind !== 'stop') {
    addTransaction('officialReposition', OFFICIAL_REPOSITION_LABEL, journal.tx?.officialReposition,
      receiptState(completed || observedPhase === 'official_confirmed'));
  } else if (kind === 'stop') {
    const confirmedHashes = new Set((journal.completedSteps || []).map(item => String(item.hash).toLowerCase()));
    for (const [key, hash] of Object.entries(journal.tx || {})) {
      const step = key.startsWith('withdraw:') ? 'withdraw' : 'swap';
      addTransaction(step, step === 'withdraw' ? '撤出 LP' : '換回 USDG', hash,
        receiptState(confirmedHashes.has(String(hash).toLowerCase())));
    }
  } else {
    addTransaction('withdraw', '撤出 LP', journal.tx?.withdraw,
      receiptState(completed || stepIndex >= 2));
    const routes = Array.isArray(journal.tx?.routeSwaps) ? journal.tx.routeSwaps : [];
    routes.forEach((hash, index) => addTransaction('swap', '跨池換幣', hash,
      receiptState(completed || index < routes.length - 1 || observedPhase !== 'route_swap_sent' && stepIndex >= 2)));
    if (atomicFlow) {
      const atomicStep = journal.atomicSwapRequired === true ? 'swap' : 'deposit';
      const atomicLabel = journal.atomicSwapRequired === true ? '換幣＋一次存入 LP' : '一次存入 LP';
      for (const hash of Array.isArray(journal.tx?.atomicReverts) ? journal.tx.atomicReverts : []) {
        addTransaction(atomicStep, `${atomicLabel}（已回退）`, hash, 'reverted');
      }
      addTransaction(atomicStep, atomicLabel, journal.tx?.atomicSwapDeposit,
        receiptState(completed || observedPhase === 'atomic_confirmed' || stepIndex >= 4));
    } else {
      addTransaction('swap', '調整代幣比例', journal.tx?.swap,
        receiptState(completed || stepIndex >= 3));
      addTransaction('deposit', '存入 LP', journal.tx?.deposit,
        receiptState(completed || stepIndex >= 4));
    }
  }
  if (journal.lastApprovalTx) addTransaction('preflight', '代幣授權', journal.lastApprovalTx.hash,
    journal.lastApprovalTx.status === 'reverted' ? 'reverted'
      : journal.lastApprovalTx.status === 'confirmed' ? 'confirmed' : 'unknown');
  if (journal.pendingTx) {
    const pendingHash = hashValue(journal.pendingTx.hash);
    if (pendingHash) {
      const existing = transactions.find(item => item.hash.toLowerCase() === pendingHash.toLowerCase());
      const item = { step: officialFlow ? 'officialReposition' : STEP_KEYS[stepIndex],
        label: officialFlow ? OFFICIAL_REPOSITION_LABEL : cleanText(journal.pendingTx.label, 70) || '交易送出',
        hash: pendingHash, status: status === 'recovery' ? 'unknown' : 'pending' };
      if (existing) Object.assign(existing, item);
      else transactions.push(item);
    }
  }
  if (journal.reconciliation?.status === 0) {
    const revertedHash = hashValue(journal.reconciliation.hash);
    const reverted = transactions.find(item => item.hash.toLowerCase() === revertedHash?.toLowerCase());
    if (reverted) reverted.status = 'reverted';
  }
  const labels = { rebalance: '再平衡', rotation: '換倉', topup: '餘額加倉', bootstrap: '首次建倉', stop: '停止清倉' };
  const messages = {
    prepared: '正在核對資金與準備預檢。', approvals_ready: '授權已就緒，核對完整交易流程。',
    cross_pool_preflighted: '跨池換倉預檢通過，準備授權。',
    withdraw_preflighted: '撤池預檢通過，模擬整個再投入流程。',
    sequence_preflighted: '完整流程模擬通過，準備執行。',
    withdraw_sent: '撤池交易已送出，等待鏈上確認。',
    withdraw_confirmed: '撤池已確認，正在核對到帳與換幣比例。',
    withdraw_not_required: '直接使用錢包餘額，無需撤池。',
    route_swap_sent: '跨池換幣已送出，等待鏈上確認。',
    route_swap_confirmed: '跨池換幣已確認，核對到帳並準備下一步。',
    swap_preflighted: '換幣預檢通過，準備送出交易。',
    swap_sent: '換幣交易已送出，等待鏈上確認。',
    swap_confirmed: '換幣已確認，正在計算最終存入量。',
    swap_not_required: '現有代幣比例可直接存入，無需換幣。',
    deposit_preflighted: '存入預檢通過，準備送出交易。',
    deposit_sent: '存入交易已送出，等待鏈上確認。',
    deposit_confirmed: '存入已確認，正在核對 LP 份額與餘額。',
    atomic_preflighted: journal.atomicSwapRequired === true
      ? '原子換幣與存入 LP 預檢通過，準備送出單筆交易。' : '原子存入 LP 預檢通過，準備送出單筆交易。',
    atomic_sent: journal.atomicSwapRequired === true
      ? '換幣＋一次存入 LP 已在同一筆交易送出，等待確認。' : '一次存入 LP 已送出，等待確認。',
    atomic_retry: '上一筆原子交易已回退，正在重新預檢。',
    atomic_confirmed: '原子交易已確認，正在核對 LP 份額與餘額。'
    ,official_preflighted: '舊區間手續費與官方再平衡已預檢，準備送出單筆交易。'
    ,official_sent: '領取手續費與官方一次再平衡已在同一筆交易送出，等待確認。'
    ,official_confirmed: '官方再平衡交易已確認，正在核對新舊區間與手續費。'
  };
  const message = completed ? '鏈上交易與部位核對已完成。'
    : status === 'failed' ? '流程未完成，請查看失敗原因。'
    : status === 'recovery' ? '需要核對交易結果；此狀態不代表已成功完成。'
    : journal.pendingTx ? '交易已送出或正在廣播，等待確認結果。'
    : kind === 'stop' ? '正在撤池並將可兌換資產換回 USDG。'
    : messages[observedPhase] || '等待下一筆執行紀錄。';
  const pendingHash = hashValue(journal.pendingTx?.hash);
  const lastTransaction = pendingHash ? transactions.find(item => item.hash.toLowerCase() === pendingHash.toLowerCase())
    : transactions.filter(item => item.step !== 'preflight').at(-1) || transactions.at(-1) || null;
  return {
    id: cleanText(journal.id, 240), kind, label: labels[kind], phase, status,
    pair: cleanText(journal.pair || journal.destinationPair || journal.sourcePair, 80),
    startedAt: Number(journal.startedAt) || null,
    updatedAt: Number(journal.updatedAt || journal.startedAt) || null,
    finishedAt: Number(journal.completedAt || journal.failedAt) || null,
    stepIndex, currentStepLabel: completed ? '已完成' : officialFlow
      ? ['預檢', OFFICIAL_REPOSITION_LABEL, '核對'][stepIndex] : STEP_LABELS[stepIndex],
    message, error: cleanText(journal.error), steps, transactions,
    lastTransaction
  };
}

function describeFeeClaim(journal) {
  const phase = String(journal.phase);
  const status = phase === 'completed' ? 'completed' : phase === 'failed' ? 'failed'
    : phase === 'recovery_required' ? 'recovery' : 'running';
  const observed = ['failed', 'recovery_required'].includes(phase) ? journal.lastKnownPhase : phase;
  const index = status === 'completed' || observed === 'claim_confirmed' ? 2
    : journal.tx?.claim ? 1 : 0;
  const labels = ['預檢', '領取舊區間手續費', '核對'];
  const keys = ['preflight', 'claim', 'verify'];
  const hash = hashValue(journal.tx?.claim);
  const transactions = hash ? [{ step: 'claim', label: labels[1], hash,
    status: status === 'completed' || observed === 'claim_confirmed' ? 'confirmed'
      : status === 'recovery' || status === 'failed' ? 'unknown' : 'pending' }] : [];
  return { id: cleanText(journal.id, 240), kind: 'claim', label: '自動領取手續費',
    phase, status, pair: cleanText(journal.pair, 80), startedAt: Number(journal.startedAt) || null,
    updatedAt: Number(journal.updatedAt) || null, finishedAt: Number(journal.completedAt || journal.failedAt) || null,
    stepIndex: index, currentStepLabel: status === 'completed' ? '已完成' : labels[index],
    message: status === 'recovery' ? '領取結果需要核對，已停止重送。'
      : status === 'completed' ? '舊區間手續費已領回錢包。' : labels[index],
    error: cleanText(journal.error), transactions, lastTransaction: transactions.at(-1) || null,
    steps: keys.map((key, i) => ({ key, label: labels[i], status: status === 'completed' || i < index
      ? 'completed' : i > index ? 'pending' : status === 'recovery' ? 'attention'
        : status === 'failed' ? 'failed' : 'active' })) };
}
