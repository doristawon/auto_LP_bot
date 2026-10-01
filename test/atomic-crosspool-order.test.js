import test from 'node:test';
import assert from 'node:assert/strict';
import { RebalanceExecutor } from '../src/adapters/executor.js';

const address = byte => `0x${byte.repeat(40)}`;
const hash = byte => `0x${byte.repeat(64)}`;
const source0 = { address: address('1'), symbol: 'SRC', decimals: 0 };
const destination0 = { address: address('2'), symbol: 'DST', decimals: 0 };
const destination1 = { address: address('3'), symbol: 'USDG', decimals: 0 };
const sourcePool = { id: hash('a'), token0: source0,
  token1: { address: address('4'), symbol: 'SRC2', decimals: 0 } };
const destinationPool = { id: hash('b'), token0: destination0, token1: destination1,
  key: { hooks: address('5'), tickSpacing: 10 } };
const oldPosition = { id: hash('c'), tickLower: -100, tickUpper: 100, shares: 9n };

function makeExecutionHarness({ failRoute = false } = {}) {
  const events = [];
  const ledger = [];
  const active = { current: null };
  const balances = new Map([[source0.address.toLowerCase(), 100n],
    [destination0.address.toLowerCase(), 5n], [destination1.address.toLowerCase(), 20n]]);
  const swap = { baseRoute: [{}], route: [{}], tokenIn: source0, rawAmountIn: 10n,
    maxImpactBps: 350, quote: { tokenOut: destination0.address, minRawAmountOut: 7n } };
  const preflight = {
    routeSwaps: [swap], balanceSwap: null, funding: [
      { address: destination0.address, dustRaw: 0n },
      { address: destination1.address, dustRaw: 0n }
    ], depositPlan: { amount0Max: 1n, amount1Max: 1n },
    before: new Map([[source0.address.toLowerCase(), 100n]]),
    withdrawCall: { to: address('6'), data: '0x1234' },
    pendingApprovalCount: 0, simulatedCallCount: 3, simulatedGasUsed: '300000',
    routeImpactBps: [20], balanceImpactBps: null, finalTarget: { tickLower: -100, tickUpper: 100 },
    mintedLiquidity: '10'
  };
  const executor = Object.create(RebalanceExecutor.prototype);
  Object.assign(executor, {
    config: { atomicDepositEnabled: true, dryRun: false, enableLiveWrites: true,
      walletAddress: address('9'), tightWidthBps: 120, rangePreset: 'custom-bps',
      crossPoolMaxSwapPriceImpactBps: 350, topUpMinGasReserveWei: 1n },
    state: { getSetting: (_key, fallback) => fallback, setSetting() {} },
    ledger: { append: (type, data) => ledger.push({ type, data }) },
    readProvider: { call: async () => { events.push('route-preflight'); return '0x'; } },
    fables: { readPoolState: async () => ({ tick: 0, sqrtPriceX96: 1n, paused: false }) },
    isAllocationModeEnabled: () => false,
    assertLiveReady: async () => {}, assertNoUnfinishedExecution: () => {},
    saveJournal: journal => { active.current = journal; },
    patchJournal: (journal, patch) => {
      const next = { ...journal, ...patch };
      active.current = next;
      return next;
    },
    preflightCrossPoolSequence: async () => preflight,
    ensureSwapAllowances: async () => { events.push('route-allowance-ready'); },
    ensureHookAllowance: async () => { throw new Error('atomic must not require hook allowance'); },
    getPinnedFeeOverrides: async () => ({ gasPrice: 1n }),
    assertTopUpGasBudget: async () => {},
    assertPlanStillOutOfRange: async () => {},
    readPositionShares: async () => 0n,
    readRawTokenBalances: async () => preflight.before,
    quoteCrossPoolRoute: async () => ({ route: [{ id: hash('d') }],
      request: { router: address('7'), data: '0xabcd', value: 0n },
      quote: { tokenOut: destination0.address, minRawAmountOut: 7n } }),
    readRawTokenBalance: async token => balances.get(token.address.toLowerCase()) || 0n,
    readRawPairBalances: async () => ({ raw0: balances.get(destination0.address.toLowerCase()) || 0n,
      raw1: balances.get(destination1.address.toLowerCase()) || 0n }),
    sendVerifiedTx: async request => {
      const isRoute = request.label.startsWith('crossPoolRoute:');
      const label = isRoute ? 'route' : 'withdraw';
      events.push(`${label}-send`);
      request.onSent(hash(isRoute ? 'e' : 'f'));
      if (isRoute && failRoute) throw new Error('synthetic route failure');
      if (isRoute) {
        balances.set(source0.address.toLowerCase(), 90n);
        balances.set(destination0.address.toLowerCase(), 12n);
        events.push('route-confirmed');
      } else events.push('withdraw-confirmed');
      return { hash: hash(isRoute ? 'e' : 'f') };
    },
    assertAtomicGuardReady: async () => {
      events.push('atomic-helper-entered');
      throw new Error('synthetic atomic helper boundary');
    },
    clearJournal: () => { active.current = null; }
  });
  const plan = { pool: sourcePool, position: oldPosition, manualIdle: false,
    destinationStats: { aprPct: 1 } };
  return { executor, plan, events, ledger, active };
}

test('cross-pool execution withdraws and confirms each route before atomic helper entry', async () => {
  const h = makeExecutionHarness();
  await assert.rejects(h.executor.executeCrossPoolUnlocked(h.plan, destinationPool),
    /synthetic atomic helper boundary/);
  assert.deepEqual(h.events, [
    'route-allowance-ready', 'withdraw-send', 'withdraw-confirmed',
    'route-preflight', 'route-send', 'route-confirmed', 'atomic-helper-entered'
  ]);
  assert.equal(h.active.current.phase, 'recovery_required');
  assert.deepEqual(h.active.current.tx.routeSwaps, [hash('e')]);
});

test('failed cross-pool route enters recovery and never reaches atomic helper', async () => {
  const h = makeExecutionHarness({ failRoute: true });
  await assert.rejects(h.executor.executeCrossPoolUnlocked(h.plan, destinationPool),
    /synthetic route failure/);
  assert.deepEqual(h.events, [
    'route-allowance-ready', 'withdraw-send', 'withdraw-confirmed',
    'route-preflight', 'route-send'
  ]);
  assert.equal(h.active.current.phase, 'recovery_required');
  assert.deepEqual(h.active.current.tx.routeSwaps, [hash('e')]);
});
