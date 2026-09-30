import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dashboardPage } from '../src/dashboard/page.js';

const WALLET_W1 = '0x00000000000000000000000000000000000000aa';
const WALLET_W2 = '0x00000000000000000000000000000000000000bb';
const HTML = dashboardPage();

function sourceFunction(name) {
  const line = HTML.split(/\r?\n/).find((item) =>
    item.startsWith(`async function ${name}(`) || item.startsWith(`function ${name}(`));
  assert.ok(line, `dashboard source function ${name} exists`);
  return line;
}

function response(body) {
  return { ok: true, async text() { return JSON.stringify(body); } };
}

function harness({ holdFirstState = false } = {}) {
  let serverSelectedAddress = WALLET_W2;
  let stateCalls = 0;
  let releaseFirstState;
  let signalFirstStateStarted;
  const firstStateStarted = new Promise((resolve) => { signalFirstStateStarted = resolve; });
  const firstStateGate = new Promise((resolve) => { releaseFirstState = resolve; });
  const requests = [];
  const storage = new Map([['selectedWalletAddress', WALLET_W2]]);
  const makeWallet = (address, pair) => ({ address, pair, type: 'signer', signerConfigured: true,
    dryRun: true, executionPaused: false, running: true, walletStatus: 'ready' });
  const wallets = [makeWallet(WALLET_W1, 'CASHCAT/USDG'), makeWallet(WALLET_W2, 'USDG/MOO')];
  const elements = new Map();
  for (const id of ['activeWallet', 'walletStatus', 'rpcStatus', 'setWalletLive', 'walletList',
    'authPanel', 'investmentPoolSearch', 'investmentPool', 'rotationSource', 'allocationPoolSearch']) {
    elements.set(id, { textContent: '', innerHTML: '', value: '', disabled: false,
      className: '', style: {}, getAttribute() { return null; } });
  }

  const context = {
    busy: false,
    snapshot: null,
    control: null,
    selectedWalletAddress: WALLET_W2,
    walletFleet: [],
    rpcEndpoints: [],
    dashboardToken: '',
    draftInvestmentPoolId: 'old-pool',
    draftInvestmentMode: 'specific-pool',
    countdownClockOffset: 0,
    loadSequence: 0,
    allocationSnapshot: null,
    allocationDraft: [],
    allocationDraftDirty: false,
    allocationDraftWallet: '',
    allocationDraftByWallet: new Map(),
    notice: null,
    sessionStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, value); },
      removeItem(key) { storage.delete(key); }
    },
    document: { getElementById(id) { return elements.get(id); } },
    $: (id) => elements.get(id),
    esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]); },
    dt: String,
    short: String,
    translateError: String,
    rpcFaultText: String,
    renderRpcList() {},
    showNotice(message, isError = false) { context.notice = { message, isError }; },
    setBusy(value) { context.busy = value; if (value) context.loadSequence++; },
    async fetch(path, options = {}) {
      const headers = options.headers || {};
      requests.push({ path, method: options.method || 'GET', wallet: headers['X-Wallet-Address'] });
      if (path === '/api/wallet/select') {
        serverSelectedAddress = JSON.parse(options.body).address;
        return response({ ok: true });
      }
      if (path === '/api/auth/status') return response({ tokenRequired: false });
      if (path === '/api/wallets') return response({ wallets, defaultWalletAddress: WALLET_W2 });
      if (path === '/api/state') {
        stateCalls++;
        const state = { markets: [], portfolio: { positions: [] }, walletAddress: serverSelectedAddress };
        if (holdFirstState && stateCalls === 1) {
          signalFirstStateStarted();
          return firstStateGate;
        }
        return response(state);
      }
      if (path === '/api/control/status') return response({
        walletAddress: serverSelectedAddress, walletImportState: { status: 'ready' },
        signerConfigured: true, dryRun: true, generatedAt: Date.now(), rpc: { chainId: 4663 }
      });
      if (path === '/api/events?limit=250') return response({ events: [] });
      if (path === '/api/settings/rpc') return response({ endpoints: [] });
      if (path === '/api/investment/allocation') return response({ enabled: false, allocations: [], status: 'disabled' });
      throw new Error(`Unexpected UI API path: ${path}`);
    }
  };

  vm.createContext(context);
  for (const name of ['api', 'load', 'viewWallet', 'renderWallet', 'renderWalletFleet']) {
    vm.runInContext(sourceFunction(name), context, { filename: `dashboard:${name}` });
  }
  context.render = () => vm.runInContext('renderWallet()', context);
  return { context, elements, requests, storage, firstStateStarted, releaseFirstState };
}

test('viewWallet updates selected storage and the rendered header/card after the API selection succeeds', async () => {
  const h = harness();
  await vm.runInContext(`viewWallet(${JSON.stringify(WALLET_W1)})`, h.context);

  assert.equal(h.context.selectedWalletAddress, WALLET_W1);
  assert.equal(h.storage.get('selectedWalletAddress'), WALLET_W1);
  assert.equal(h.elements.get('activeWallet').textContent, WALLET_W1);
  assert.match(h.elements.get('walletList').innerHTML, /wallet-card selected/);
  assert.match(h.elements.get('walletList').innerHTML, new RegExp(WALLET_W1));
  assert.match(h.elements.get('walletList').innerHTML, /aria-pressed="true">正在檢視/);
  assert.equal(h.context.control.walletAddress, WALLET_W1);
  assert.equal(h.context.busy, false);

  const selection = h.requests.find((item) => item.path === '/api/wallet/select');
  assert.equal(selection.wallet, WALLET_W2, 'selection request is scoped to the current wallet context');
  assert.ok(h.requests.some((item) => item.path === '/api/control/status' && item.wallet === WALLET_W1),
    'subsequent load reads control state under the newly selected wallet');
});

test('an older in-flight load cannot overwrite the wallet selected by viewWallet', async () => {
  const h = harness({ holdFirstState: true });
  const oldLoad = vm.runInContext('load()', h.context);
  await h.firstStateStarted;

  await vm.runInContext(`viewWallet(${JSON.stringify(WALLET_W1)})`, h.context);
  assert.equal(h.elements.get('activeWallet').textContent, WALLET_W1);
  assert.equal(h.context.control.walletAddress, WALLET_W1);

  h.releaseFirstState(response({ markets: [], portfolio: { positions: [] }, walletAddress: WALLET_W2 }));
  await oldLoad;

  assert.equal(h.context.selectedWalletAddress, WALLET_W1);
  assert.equal(h.elements.get('activeWallet').textContent, WALLET_W1);
  assert.equal(h.context.control.walletAddress, WALLET_W1);
  assert.ok(h.requests.some((item) => item.path === '/api/state' && item.wallet === WALLET_W2));
  assert.ok(h.requests.some((item) => item.path === '/api/state' && item.wallet === WALLET_W1));
});

test('wallet polling preserves unsaved allocation edits and keeps them scoped by wallet', async () => {
  const h = harness();
  const { context } = h;
  context.allocationDraftWallet = WALLET_W2;
  context.allocationDraftDirty = true;
  context.allocationDraft = [{ poolId: 'synthetic-cashcat', weightBps: 7000 }, { poolId: 'synthetic-moo', weightBps: 3000 }];
  await vm.runInContext('load()', context);
  assert.deepEqual(context.allocationDraft.map((x) => x.weightBps), [7000, 3000], 'same-wallet polling leaves the edited draft intact');
  await vm.runInContext(`viewWallet(${JSON.stringify(WALLET_W1)})`, context);
  assert.equal(context.allocationDraft.length, 0, 'a different wallet loads its own server configuration');
  assert.equal(context.allocationDraftByWallet.get(WALLET_W2.toLowerCase())[0].poolId, 'synthetic-cashcat',
    'the previous wallet draft remains isolated for return navigation');
});

test('allocation render initializes empty draft, reads top-level price status, and keeps blocked config editable', () => {
  const poolId = '0x' + '11'.repeat(32);
  const zeroAddress = '0x' + '00'.repeat(20);
  const excludedAddress = '0x' + 'ab'.repeat(20);
  const elements = new Map();
  const rowControls = [{ disabled: false }, { disabled: false }];
  elements.set('allocationRows', { innerHTML: '', querySelectorAll() { return rowControls; } });
  elements.set('allocationSummary', { textContent: '' });
  elements.set('allocationPoolSearch', { value: '' });
  elements.set('addAllocationRow', { disabled: false });
  elements.set('saveAllocation', { disabled: false });
  elements.set('disableAllocation', { disabled: false });
  const context = {
    allocationSnapshot: { enabled: true, status: 'blocked', allocations: [], priceStatus: { status: 'missing', missingPoolIds: [poolId] },
      capital: { totalUsdG: null, excludedAssets: [{ address: zeroAddress }, { address: excludedAddress, reason: 'outside-selected-pool-assets' }] } },
    allocationDraft: [], allocationDraftDirty: false, allocationDraftWallet: WALLET_W1,
    allocationDraftByWallet: new Map(), snapshot: { markets: [{ id: poolId, pair: 'USDG/CASHCAT', paused: false, nativeCurrency: false }] },
    busy: false, control: {},
    document: { activeElement: null },
    $: (id) => elements.get(id),
    esc: String, short: (value) => String(value).length > 14 ? String(value).slice(0, 6) + '…' + String(value).slice(-4) : String(value),
    usd: (value) => value == null ? '--' : String(value),
    allocationEnabled: null
  };
  vm.createContext(context);
  for (const name of ['allocationEnabled', 'ensureAllocationDraft', 'allocationWeightBps', 'allocationDraftValid', 'excludedAssetLabel', 'renderAllocation', 'saveAllocationDraft', 'handleAllocationWeightInput', 'handleAllocationRowsChange']) {
    vm.runInContext(sourceFunction(name), context, { filename: `dashboard:${name}` });
  }
  vm.runInContext('renderAllocation()', context);
  assert.equal(context.allocationDraft.length, 1, 'render creates a real default row instead of a temporary row');
  assert.match(elements.get('allocationSummary').textContent, /價格資料缺漏/);
  assert.match(elements.get('allocationSummary').textContent, /缺價池/);
  assert.match(elements.get('allocationSummary').textContent, /ETH/);
  assert.match(elements.get('allocationSummary').textContent, /0xabab/);
  assert.equal(rowControls.some((item) => item.disabled), false, 'blocked status does not lock pool and weight controls');

  const target = { value: poolId, closest(selector) { return selector === '[data-allocation-pool]' ? { value: poolId, dataset: { allocationPool: '0' } } : null; } };
  vm.runInContext('handleAllocationRowsChange(event)', Object.assign(context, { event: { target } }));
  assert.equal(context.allocationDraft[0].poolId, poolId, 'input events can repair a blocked allocation');
  assert.equal(elements.get('saveAllocation').disabled, false, 'valid config can be saved while old funding snapshot is blocked');
});

test('unblurred allocation input survives polling with focus and typed text intact', async () => {
  const h = harness();
  const { context, elements } = h;
  const poolId = 'synthetic-cashcat';
  const first = { dataset: { allocationWeight: '0' }, selectionStart: 2, selectionEnd: 2,
    focus() { context.document.activeElement = this; }, setSelectionRange(start, end) { this.restoredSelection = [start, end]; } };
  const replacement = { dataset: { allocationWeight: '0' }, focus() { this.focused = true; context.document.activeElement = this; },
    setSelectionRange(start, end) { this.restoredSelection = [start, end]; } };
  const rows = { innerHTML: '', querySelector() { return replacement; }, querySelectorAll() { return []; } };
  for (const [id, value] of Object.entries({
    allocationRows: rows, allocationSummary: { textContent: '' }, allocationPoolSearch: { value: '' },
    addAllocationRow: { disabled: false }, saveAllocation: { disabled: true }, disableAllocation: { disabled: false },
    investmentMode: { disabled: false }, investmentPoolSearch: { disabled: false }, investmentPool: { disabled: false },
    saveInvestmentTarget: { disabled: false }
  })) elements.set(id, value);
  context.document = { getElementById(id) { return elements.get(id); }, activeElement: first };
  context.usd = (value) => value == null ? '--' : String(value);
  context.snapshot = { markets: [{ id: poolId, pair: 'USDG/CASHCAT', paused: false, nativeCurrency: false }] };
  context.allocationSnapshot = { enabled: true, status: 'ready', allocations: [{ poolId, weightBps: 7000 }],
    capital: { totalUsdG: 100, byPool: [] } };
  context.allocationDraftWallet = WALLET_W2;
  context.allocationDraftDirty = false;
  context.allocationDraft = [{ poolId, weightBps: 7000 }];
  let renderCalls = 0;
  context.render = () => { renderCalls++; context.document.activeElement = first; return vm.runInContext('renderAllocation()', context); };
  for (const name of ['allocationEnabled', 'ensureAllocationDraft', 'allocationWeightBps', 'allocationDraftValid', 'excludedAssetLabel', 'renderAllocation', 'saveAllocationDraft', 'handleAllocationWeightInput']) {
    vm.runInContext(sourceFunction(name), context, { filename: `dashboard:${name}` });
  }
  const input = { value: '70.25', dataset: { allocationWeight: '0' }, closest(selector) {
    return selector === '[data-allocation-weight]' ? this : null;
  } };
  vm.runInContext('handleAllocationWeightInput(event)', Object.assign(context, { event: { target: input } }));
  assert.equal(context.allocationDraft[0].weightText, '70.25', 'input event immediately stores the unblurred text');
  assert.equal(context.allocationDraft[0].weightBps, 7025);
  assert.equal(context.allocationDraftDirty, true);
  assert.equal(elements.get('saveAllocation').disabled, true, 'a strict 100% sum is still required to save');
  assert.equal(vm.runInContext("allocationWeightBps('0.01')", context), 1);
  assert.equal(vm.runInContext("allocationWeightBps('100')", context), 10000);
  assert.equal(vm.runInContext("allocationWeightBps('70.001')", context), null);
  assert.equal(vm.runInContext("allocationWeightBps('')", context), null);
  input.value = '70.';
  vm.runInContext('handleAllocationWeightInput(event)', Object.assign(context, { event: { target: input } }));
  assert.equal(context.allocationDraft[0].weightText, '70.', 'unfinished decimal text remains in the wallet draft');
  assert.equal(context.allocationDraft[0].weightBps, 0, 'unfinished decimals cannot be saved as an integer weight');
  input.value = '70.25';
  vm.runInContext('handleAllocationWeightInput(event)', Object.assign(context, { event: { target: input } }));
  assert.equal(vm.runInContext('document.activeElement.dataset.allocationWeight', context), '0');

  await vm.runInContext('load()', context);
  assert.ok(renderCalls > 0, 'poll calls the real allocation renderer');
  assert.equal(context.allocationDraft[0].weightText, '70.25', 'poll does not replace the draft with server values');
  assert.equal(replacement.focused, true, 'poll rendering restores focus to the same percentage field');
  assert.deepEqual(replacement.restoredSelection, [2, 2], 'poll rendering restores the current caret position');
});
