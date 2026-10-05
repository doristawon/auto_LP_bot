import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dashboardPage } from '../src/dashboard/page.js';

const HTML = dashboardPage();
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(SCRIPT);

function sourceFunction(name) {
  const match = SCRIPT.match(new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`));
  assert.ok(match, `dashboard source function ${name} exists`);
  const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
  const source = SCRIPT.slice(start);
  const firstLine = source.split(/\r?\n/, 1)[0];
  if (firstLine.trimEnd().endsWith('}')) return firstLine;
  const close = source.indexOf('\n}');
  assert.ok(close >= 0, `dashboard source function ${name} closes`);
  return source.slice(0, close + 2);
}

function sourceBlock(pattern, label) {
  const match = SCRIPT.match(pattern);
  assert.ok(match, `dashboard source block ${label} exists`);
  return match[0];
}

function harness() {
  const ids = ['rebalanceClock', 'rebalanceClockLabel', 'rebalanceClockValue', 'rebalanceClockHint',
    'executionProgress', 'executionProgressTitle', 'executionProgressMeta', 'executionCurrentStep',
    'executionProgressStatus', 'executionProgressMessage', 'executionSteps', 'executionTransactions',
    'executionProgressUpdated', 'executionProgressElapsed', 'startExecution', 'pauseExecution', 'scan',
    'manualRecoveryHint', 'verifyManualLpRecovery', 'executionTargetStatus', 'investmentTargetHint',
    'startReadiness'];
  const elements = new Map(ids.map((id) => [id, { hidden: false, textContent: '', innerHTML: '',
    className: '', disabled: false, title: '' }]));
  const ctx = {
    selectedWalletAddress: '0x00000000000000000000000000000000000000aa',
    executionStatus: null, executionStatusWallet: '', executionStatusUpdatedAt: 0,
    executionStatusPollFailed: false, executionPollInFlight: false,
    countdownClockOffset: 0, busy: false, control: null,
    $: (id) => elements.get(id),
    esc(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]); },
    short(value) { return value ? value.slice(0, 8) + '…' + value.slice(-6) : ''; },
    dt(value) { return `time:${value}`; },
    clockDuration(ms) { return `duration:${Math.ceil(ms / 1000)}`; },
    renderRebalanceCountdown() {}, renderExecutionProgress() {}, renderManualRecoveryAction() {},
    async load() {}, showNotice() {},
    async api() { throw new Error('api not configured'); }
  };
  vm.createContext(ctx);
  ctx.setBusy = (value) => { ctx.busy = value; };
  vm.runInContext(sourceBlock(/const errorNames=\{[\s\S]*?\n\};/, 'errorNames'), ctx);
  vm.runInContext(sourceBlock(/const startBlockerNames=\{[\s\S]*?\};/, 'startBlockerNames'), ctx);
  for (const name of ['safeEventText', 'safeErrorText', 'translateError', 'investmentTargetLabel',
    'investmentTargetSavedNotice', 'appendPendingInvestmentTargetHint', 'renderManualRecoveryAction', 'renderExecutionTargetStatus',
    'renderStartReadiness', 'reconcileManualLpRecovery', 'renderRebalanceCountdown', 'renderExecutionProgress', 'mergeExecutionFields',
    'applyExecutionStatus', 'pollExecutionStatus']) {
    vm.runInContext(sourceFunction(name), ctx, { filename: `dashboard:${name}` });
  }
  return { ctx, elements };
}

function loadHarness({ controlStatus, priorStatus, priorAt }) {
  const wallet = '0x00000000000000000000000000000000000000aa';
  const elements = new Map([['authPanel', { style: {} }]]);
  const ctx = {
    selectedWalletAddress: wallet, walletFleet: [], dashboardToken: 'token',
    snapshot: null, control: null, rpcEndpoints: [], allocationSnapshot: null,
    allocationDraft: [], allocationDraftDirty: false, allocationDraftWallet: '',
    allocationDraftByWallet: new Map(), loadSequence: 0, countdownClockOffset: 0,
    executionStatus: priorStatus, executionStatusWallet: wallet,
    executionStatusUpdatedAt: priorAt, executionPollInFlight: false,
    executionStatusPollFailed: false,
    $: (id) => elements.get(id), render() {},
    mergeExecutionFields(target, status) {
      return { ...target, executionPaused: status.executionPaused, cycleActive: status.cycleActive,
        executionBusy: status.executionBusy, recoveryRequired: status.recoveryRequired,
        staleExecution: status.staleExecution, nextMonitorAt: status.nextMonitorAt,
        rebalanceTiming: status.rebalanceTiming, executionProgress: status.executionProgress };
    },
    sessionStorage: { removeItem() {}, setItem() {}, getItem() { return null; } },
    async api(path) {
      if (path === '/api/auth/status') return { tokenRequired: false };
      if (path === '/api/wallets') return { wallets: [{ address: wallet }], defaultWalletAddress: wallet };
      if (path === '/api/state') return { walletAddress: wallet, markets: [], portfolio: { positions: [] } };
      if (path === '/api/control/status') return controlStatus;
      if (path === '/api/events?limit=250') return { events: [] };
      if (path === '/api/settings/rpc') return { endpoints: [] };
      if (path === '/api/investment/allocation') return { enabled: false, allocations: [], status: 'disabled' };
      throw new Error(`Unexpected API request: ${path}`);
    }
  };
  vm.createContext(ctx);
  for (const name of ['load']) vm.runInContext(sourceFunction(name), ctx, { filename: `dashboard:${name}` });
  return { ctx, elements };
}

test('countdown distinguishes routine in-range scan from OOR recheck and never promises a transaction', () => {
  const { ctx, elements } = harness();
  ctx.control = { rebalanceTiming: { phase: 'in-range', targetAt: Date.now() + 30_000 } };
  vm.runInContext('renderRebalanceCountdown()', ctx);
  assert.equal(elements.get('rebalanceClockLabel').textContent, '下次區間檢查');
  assert.match(elements.get('rebalanceClockHint').textContent, /不代表一定會送出交易/);
  ctx.control.rebalanceTiming = { phase: 'scheduled', targetAt: Date.now() + 60_000 };
  vm.runInContext('renderRebalanceCountdown()', ctx);
  assert.equal(elements.get('rebalanceClockLabel').textContent, '再平衡複查倒數');
  assert.match(elements.get('rebalanceClockHint').textContent, /仍會重新確認並預檢/);
});

test('progress renders backend steps, elapsed time and localized pending transaction hash', () => {
  const { ctx, elements } = harness();
  const wallet = ctx.selectedWalletAddress;
  ctx.executionStatusWallet = wallet;
  ctx.executionStatus = { walletAddress: wallet, generatedAt: 5000, executionProgress: {
    label: '自動再平衡', kind: 'oor-rebalance', status: 'running', pair: 'USDG/MOO',
    startedAt: Date.now() - 12_000, updatedAt: 9000, currentStepLabel: '換幣',
    message: '正在換幣', steps: [
      { key: 'preflight', label: '預檢', status: 'completed' },
      { key: 'swap', label: '換幣', status: 'active' },
      { key: 'deposit', label: '存入 LP', status: 'pending' }
    ], transactions: [{ step: 'swap', label: '換幣', hash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', status: 'pending' }]
  } };
  vm.runInContext('renderExecutionProgress()', ctx);
  assert.equal(elements.get('executionProgress').hidden, false);
  assert.equal(elements.get('executionProgressTitle').textContent, '自動再平衡');
  assert.equal(elements.get('executionProgressStatus').textContent, '執行中');
  assert.equal(elements.get('executionCurrentStep').textContent, '目前步驟：換幣');
  assert.match(elements.get('executionProgressElapsed').textContent, /已經 duration:/);
  assert.match(elements.get('executionTransactions').innerHTML, /待確認/);
  assert.match(elements.get('executionTransactions').innerHTML, /0x123456…abcdef/);
  assert.doesNotMatch(elements.get('executionProgressMeta').textContent, /oor-rebalance/);
});

test('official reposition progress renders its combined step and a single pending transaction', () => {
  const { ctx, elements } = harness();
  const officialHash = '0x' + '7'.repeat(64);
  ctx.executionStatusWallet = ctx.selectedWalletAddress.toLowerCase();
  ctx.executionStatus = { walletAddress: ctx.selectedWalletAddress, generatedAt: 6000,
    executionProgress: { label: '再平衡', kind: 'rebalance', status: 'running',
      currentStepLabel: '領取手續費＋官方一次再平衡', message: '交易已送出，等待確認。',
      steps: [{ key: 'preflight', label: '預檢', status: 'completed' },
        { key: 'officialReposition', label: '領取手續費＋官方一次再平衡', status: 'active' },
        { key: 'verify', label: '核對', status: 'pending' }],
      transactions: [{ step: 'officialReposition', label: '領取手續費＋官方一次再平衡',
        hash: officialHash, status: 'pending' }] } };
  vm.runInContext('renderExecutionProgress()', ctx);
  assert.equal(elements.get('executionProgressTitle').textContent, '再平衡');
  assert.equal(elements.get('executionCurrentStep').textContent,
    '目前步驟：領取手續費＋官方一次再平衡');
  assert.match(elements.get('executionSteps').innerHTML, /領取手續費＋官方一次再平衡/);
  assert.equal((elements.get('executionTransactions').innerHTML.match(/execution-tx/g) || []).length, 1);
  assert.match(elements.get('executionTransactions').innerHTML, /等待確認/);
});

test('manual LP reconciliation renders verified manual receipts and does not imply bot swap or deposit', () => {
  const { ctx, elements } = harness();
  const wallet = ctx.selectedWalletAddress;
  ctx.executionStatusWallet = wallet;
  ctx.executionStatus = { walletAddress: wallet, generatedAt: 6000, executionPaused: true,
    recoveryRequired: false, executionProgress: { label: '已核對手動換倉', kind: 'rotation',
      status: 'completed', reconciliationStatus: 'verified-manual-lp-replacement', pair: 'PONS/USDG',
      reconciliationProof: { pair: 'PONS/USDG', oldPoolId: 'old-pool-address-1234567890',
        poolId: 'new-pool-address-9876543210', positionId: '987654321' },
      currentStepLabel: '手動 LP 已核對', message: '原 Bot 換幣與存入未完成；已核對撤池收據、後續 LP 收據與目前份額。',
      steps: [{ key: 'preflight', label: '撤池與後續 LP 預檢', status: 'completed' },
        { key: 'withdraw', label: '原 LP 撤池收據', status: 'completed' },
        { key: 'verify', label: '後續 LP 收據與份額核對', status: 'completed' }],
      transactions: [{ step: 'withdraw', label: '原 LP 撤池收據', hash: '0x' + '1'.repeat(64), status: 'confirmed' },
        { step: 'verify', label: '後續手動 LP 收據', hash: '0x' + '4'.repeat(64), status: 'confirmed' }] } };
  vm.runInContext('renderExecutionProgress()', ctx);
  assert.equal(elements.get('executionProgressTitle').textContent, '已核對手動換倉');
  assert.equal(elements.get('executionProgressStatus').textContent, '已解除待復原');
  assert.match(elements.get('executionProgressMeta').textContent, /PONS\/USDG.*原池.*後續池/);
  assert.match(elements.get('executionCurrentStep').textContent, /Bot 換幣／存入未完成/);
  assert.match(elements.get('executionProgressMessage').textContent, /old-pool-address.*new-pool-address.*987654321/);
  assert.doesNotMatch(elements.get('executionSteps').innerHTML, /換幣|存入 LP/);
  assert.match(elements.get('executionTransactions').innerHTML, /原 LP 撤池收據/);
  assert.match(elements.get('executionTransactions').innerHTML, /後續手動 LP 收據/);
  assert.equal((elements.get('executionTransactions').innerHTML.match(/execution-tx/g) || []).length, 2);
});

test('queued investment target distinguishes the effective target from a pending PONS target', () => {
  const { ctx, elements } = harness();
  const markets = [{ id: 'pool-moo', pair: 'MOO/USDG' }, { id: 'pool-pons', pair: 'PONS/USDG' }];
  ctx.control = { selectedExecutionTargetPoolId: 'pool-moo', targetMode: 'wallet-active',
    walletImportState: { status: 'ready' }, dryRun: false, executionPaused: false, liveReady: true,
    investmentTarget: { mode: 'specific-pool', pair: 'MOO/USDG', poolId: 'pool-moo',
      pending: { mode: 'specific-pool', pair: 'PONS/USDG', poolId: 'pool-pons' } } };
  vm.runInContext('renderExecutionTargetStatus(markets)', Object.assign(ctx, { markets }));
  assert.match(elements.get('executionTargetStatus').textContent, /再投入（目前生效）：指定 MOO\/USDG/);
  assert.match(elements.get('executionTargetStatus').textContent, /已排程：本輪完成後套用 PONS\/USDG/);
  assert.equal(vm.runInContext(`investmentTargetSavedNotice('specific-pool', { queued: true,
    pending: { mode: 'specific-pool', pair: 'PONS/USDG', poolId: 'pool-pons' } }, markets)`, ctx),
  '已排程：本輪完成後套用 PONS/USDG。');
  ctx.control.investmentTarget.pending.error = 'BalanceChanged';
  vm.runInContext('renderExecutionTargetStatus(markets)', ctx);
  assert.match(elements.get('executionTargetStatus').textContent, /尚未套用：錢包餘額或鏈上狀態已變動/);
  assert.doesNotMatch(elements.get('executionTargetStatus').textContent, /本輪完成後套用 PONS/);
});

test('paused manual recovery review remains available during a read-only scan', () => {
  const { ctx, elements } = harness();
  ctx.control = { recoveryRequired: true, executionPaused: true, cycleActive: true,
    rpcManagementActive: false };
  vm.runInContext('renderManualRecoveryAction(control)', ctx);
  assert.equal(elements.get('verifyManualLpRecovery').hidden, false);
  assert.equal(elements.get('verifyManualLpRecovery').disabled, false);
  assert.match(elements.get('manualRecoveryHint').textContent, /暫停中的鏈上掃描可繼續/);
  ctx.control.rpcManagementActive = true;
  vm.runInContext('renderManualRecoveryAction(control)', ctx);
  assert.equal(elements.get('verifyManualLpRecovery').disabled, true);
});

test('manual LP review calls the read-only reconciliation API while a paused scan continues', async () => {
  const { ctx } = harness();
  const calls = [], notices = [];
  ctx.control = { recoveryRequired: true, executionPaused: true, cycleActive: true,
    rpcManagementActive: false };
  ctx.api = async (path, options) => { calls.push({ path, options }); return { recovery: { status: 'resolved' } }; };
  ctx.showNotice = (message, isError) => notices.push({ message, isError });
  await ctx.reconcileManualLpRecovery();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/control/reconcile-manual-lp');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(notices, [{ message: '已核對手動換倉；待復原狀態已解除，沒有送出交易。', isError: undefined }]);
  assert.equal(ctx.busy, false);
});

test('pending target hint keeps a revalidation failure distinct from a successful queue', () => {
  const { ctx, elements } = harness();
  const hint = elements.get('investmentTargetHint');
  hint.textContent = '目前生效：MOO/USDG';
  ctx.snapshot = { markets: [{ id: 'pool-pons', pair: 'PONS/USDG' }] };
  ctx.control = { investmentTarget: { pending: { mode: 'specific-pool', poolId: 'pool-pons',
    pair: 'PONS/USDG', error: 'BalanceChanged' } } };
  vm.runInContext('appendPendingInvestmentTargetHint()', ctx);
  assert.match(hint.textContent, /目前生效：MOO\/USDG · 尚未套用：錢包餘額或鏈上狀態已變動/);
  assert.doesNotMatch(hint.textContent, /本輪完成後套用/);
});

test('manual recovery start blocker and atomic guard errors have readable Traditional Chinese causes', () => {
  const { ctx, elements } = harness();
  ctx.control = { executionPaused: true, recoveryRequired: true,
    startReadiness: { ready: false, blockers: ['recovery-review-active'] } };
  ctx.snapshot = {};
  vm.runInContext('renderStartReadiness()', ctx);
  assert.match(elements.get('startReadiness').textContent, /正在核對手動換倉，完成後再啟動/);
  assert.match(ctx.translateError('Atomic planning exceeded five minutes; stopped without another approval'),
    /原子換幣／存入計畫逾時.*未送出此筆原子交易/);
  assert.match(ctx.translateError('LiquidityBelowMinimum'), /LP 流動性低於最低門檻/);
  assert.match(ctx.translateError('BalanceChanged'), /餘額或鏈上狀態已變動/);
});

test('unknown error details stay readable while full quoted and unquoted seed phrases are hidden', () => {
  const { ctx } = harness();
  const result = ctx.translateError('RPC timeout; mnemonic="alpha beta gamma delta"; seed phrase=one two three four; cause: balance drift');
  assert.doesNotMatch(result, /alpha|beta|gamma|delta|one two three four/);
  assert.equal((result.match(/\[已隱去憑證\]/g) || []).length, 2);
  assert.match(result, /cause: balance drift/);
});

test('a fresh scan does not present the previous completed execution as currently running', () => {
  const { ctx, elements } = harness();
  const wallet = ctx.selectedWalletAddress;
  ctx.executionStatusWallet = wallet;
  ctx.executionStatus = { walletAddress: wallet, cycleActive: true, executionProgress: {
    status: 'completed', label: '上次再平衡', steps: [{ label: '存入 LP', status: 'completed' }]
  } };
  vm.runInContext('renderExecutionProgress()', ctx);
  assert.equal(elements.get('executionProgressTitle').textContent, '鏈上掃描／預檢中');
  assert.equal(elements.get('executionSteps').innerHTML, '');
});

test('execution status rejects stale and other-wallet responses and merges only light fields', () => {
  const { ctx } = harness();
  const wallet = ctx.selectedWalletAddress;
  ctx.control = { walletAddress: wallet, generatedAt: 1000, startReadiness: { ready: true }, dryRun: true };
  const fresh = { walletAddress: wallet, generatedAt: 2000, executionPaused: true,
    cycleActive: false, executionBusy: false, recoveryRequired: false, staleExecution: false,
    rebalanceTiming: { phase: 'paused' }, executionProgress: null };
  assert.equal(vm.runInContext(`applyExecutionStatus(${JSON.stringify(fresh)}, ${JSON.stringify(wallet)})`, ctx), true);
  assert.equal(ctx.control.executionPaused, true);
  const old = { ...fresh, generatedAt: 1500, executionPaused: false };
  assert.equal(vm.runInContext(`applyExecutionStatus(${JSON.stringify(old)}, ${JSON.stringify(wallet)})`, ctx), false);
  const other = { ...fresh, walletAddress: '0x00000000000000000000000000000000000000bb', generatedAt: 3000 };
  assert.equal(vm.runInContext(`applyExecutionStatus(${JSON.stringify(other)}, ${JSON.stringify(wallet)})`, ctx), false);
  assert.equal(ctx.control.executionPaused, true);
});

test('newer full control status replaces progress from the older two-second feed', async () => {
  const wallet = '0x00000000000000000000000000000000000000aa';
  const controlProgress = { status: 'running', label: '較新 full control', currentStepLabel: '核對' };
  const { ctx } = loadHarness({
    priorAt: 100,
    priorStatus: { walletAddress: wallet, generatedAt: 100, executionProgress: {
      status: 'running', label: '舊 poll feed', currentStepLabel: '撤 LP'
    } },
    controlStatus: { walletAddress: wallet, generatedAt: 200, executionPaused: false,
      cycleActive: true, executionBusy: true, recoveryRequired: false, staleExecution: false,
      rebalanceTiming: { phase: 'executing' }, executionProgress: controlProgress,
      startReadiness: { ready: true } }
  });
  await vm.runInContext('load()', ctx);
  assert.equal(ctx.executionStatusUpdatedAt, 200);
  assert.equal(ctx.executionStatus.executionProgress.label, '較新 full control');
  assert.equal(ctx.control.executionProgress.currentStepLabel, '核對');
});

test('pause remains enabled during an active execution journal', () => {
  const { ctx, elements } = harness();
  const wallet = ctx.selectedWalletAddress;
  ctx.control = { walletAddress: wallet, startReadiness: { ready: true } };
  const status = { walletAddress: wallet, generatedAt: 2000, executionPaused: false,
    cycleActive: true, executionBusy: true, recoveryRequired: false, staleExecution: false,
    rebalanceTiming: { phase: 'executing' }, executionProgress: { status: 'running' } };
  assert.equal(vm.runInContext(`applyExecutionStatus(${JSON.stringify(status)}, ${JSON.stringify(wallet)})`, ctx), true);
  assert.equal(elements.get('pauseExecution').disabled, false);
  assert.equal(elements.get('startExecution').disabled, true);
});

test('status polling remains available while busy and never overlaps requests', async () => {
  const { ctx } = harness();
  ctx.busy = true;
  let resolveRequest;
  let calls = 0;
  ctx.api = () => { calls += 1; return new Promise((resolve) => { resolveRequest = resolve; }); };
  const first = vm.runInContext('pollExecutionStatus()', ctx);
  await Promise.resolve();
  const second = vm.runInContext('pollExecutionStatus()', ctx);
  await second;
  assert.equal(calls, 1);
  resolveRequest({ walletAddress: ctx.selectedWalletAddress, generatedAt: 10,
    executionProgress: { status: 'running', steps: [] } });
  await first;
  assert.equal(ctx.executionStatusPollFailed, false);
});

test('poll failures are visible, and an in-flight response cannot cross a wallet switch', async () => {
  const { ctx, elements } = harness();
  ctx.api = async () => { throw new Error('offline'); };
  await vm.runInContext('pollExecutionStatus()', ctx);
  assert.equal(elements.get('executionProgress').hidden, false);
  assert.equal(elements.get('executionProgressStatus').textContent, '更新失敗');
  assert.match(elements.get('executionProgressMessage').textContent, /最後成功讀取的資料/);

  ctx.executionStatusPollFailed = false;
  let resolveRequest;
  ctx.api = () => new Promise((resolve) => { resolveRequest = resolve; });
  const oldWallet = ctx.selectedWalletAddress;
  const pending = vm.runInContext('pollExecutionStatus()', ctx);
  await Promise.resolve();
  ctx.selectedWalletAddress = '0x00000000000000000000000000000000000000bb';
  resolveRequest({ walletAddress: oldWallet, generatedAt: 9999,
    executionProgress: { status: 'running', label: '舊錢包流程' } });
  await pending;
  assert.equal(ctx.executionStatus, null);
});

test('poll interval stays independent from busy and backs off while the tab is hidden', () => {
  assert.match(SCRIPT, /const interval=document\.hidden\?15000:2000/);
  assert.match(SCRIPT, /pollExecutionStatus\(\)/);
  assert.match(SCRIPT, /document\.addEventListener\('visibilitychange'/);
  assert.match(SCRIPT, /renderExecutionProgress,1000/);
});
