import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, id, keccak256, toBeHex, zeroPadValue } from 'ethers';
import { DEPOSITED_EVENT, EIP7702_GUARD_ABI } from '../src/abi.js';
import { UNISWAP_UNIVERSAL_ROUTER_212 } from '../src/constants.js';
import { buildAtomicDepositRequest, executeAtomicDeposit, findAtomicDepositEvent }
  from '../src/execution/atomic-deposit.js';
import { getSqrtPriceAtTick } from '../src/math/v4-fixed.js';

const WALLET = `0x${'99'.repeat(20)}`;
const TOKEN0 = `0x${'11'.repeat(20)}`;
const TOKEN1 = `0x${'22'.repeat(20)}`;
const HOOK = `0x${'33'.repeat(20)}`;
const POOL_KEY = { currency0: TOKEN0, currency1: TOKEN1, fee: 3000,
  tickSpacing: 10, hooks: HOOK };
const POOL_ID = keccak256('0x1234');
const pool = { id: POOL_ID, key: POOL_KEY,
  token0: { address: TOKEN0, symbol: 'T0', decimals: 0 },
  token1: { address: TOKEN1, symbol: 'T1', decimals: 0 } };
const RANGE_ID = 17n;
const NEW_RANGE_ID = 18n;
const BASELINE = { raw0: 1000n, raw1: 800n };
const FUNDING = { raw0: 100n, raw1: 80n };
const TARGET = { tickLower: -100, tickUpper: 100 };
const SHARES = 123n;
const guardInterface = new Interface(EIP7702_GUARD_ABI);
const depositInterface = new Interface(['event Deposited(address indexed owner,uint256 indexed id,uint128 liquidity)']);
const depositedTopic = id(DEPOSITED_EVENT).toLowerCase();
const posTopic = value => zeroPadValue(toBeHex(value), 32);
const txHash = n => `0x${n.toString(16).padStart(64, '0')}`;

function receiptFor({ hash, duplicateAtomic = false, omitAtomic = false, residual0 = 3n, residual1 = 2n,
  rangeId = NEW_RANGE_ID } = {}) {
  const atomic = guardInterface.encodeEventLog(guardInterface.getEvent('AtomicDeposited'),
    [POOL_ID, SHARES, FUNDING.raw0, FUNDING.raw1, residual0, residual1]);
  const deposited = depositInterface.encodeEventLog(depositInterface.getEvent('Deposited'),
    [WALLET, rangeId, SHARES]);
  const logs = [
    ...(!omitAtomic ? [{ address: WALLET, ...atomic }] : []),
    ...(duplicateAtomic ? [{ address: WALLET, ...atomic }] : []),
    { address: HOOK, ...deposited }
  ];
  return { hash, status: 1, blockNumber: 123, logs, residual0, residual1 };
}

function makeHarness({ allocationScope = null, before = BASELINE, funding = FUNDING,
  sendBehavior = null, position = null, startingJournal = null } = {}) {
  const settings = new Map([['executionPaused', false]]);
  const journalHistory = [];
  const ledgerEvents = [];
  const calls = { sends: 0, fit: 0, allowance: 0, scopeChecks: 0, physicalReads: 0,
    latestNonceReads: 0, pendingNonceReads: 0, lpShareReads: 0 };
  let currentBalances = before;
  let lpShares = position ? 5n : 0n;
  let latestNonce = 9, pendingNonce = 9;
  let sendPlanData = null;
  const txJournal = startingJournal || { id: 'synthetic-atomic-job', kind: 'rebalance', phase: 'prepared',
    startedAt: 1000, poolId: POOL_ID, pair: 'T0/T1', tx: {} };
  const executor = {
    config: { walletAddress: WALLET, usdgAddress: TOKEN1, tightWidthBps: 120,
      rangePreset: 'custom-bps', depositSlippageBps: 50, txDeadlineSec: 300,
      topUpMinGasReserveWei: 1n },
    state: { getSetting: (key, fallback) => settings.has(key) ? settings.get(key) : fallback,
      setSetting: (key, value) => settings.set(key, value) },
    ledger: { append: (type, data) => ledgerEvents.push({ type, data }) },
    signer: { estimateGas: async () => 100_000n },
    readProvider: { call: async () => '0x' },
    writeProvider: { getTransactionCount: async (_address, blockTag) => {
      if (blockTag === 'latest') calls.latestNonceReads++;
      if (blockTag === 'pending') calls.pendingNonceReads++;
      return blockTag === 'latest' ? latestNonce : pendingNonce;
    } },
    router: { buildV4ExactInputSingle: () => ({ router: UNISWAP_UNIVERSAL_ROUTER_212,
      data: '0x12345678', value: 0n }) },
    fables: {
      readPoolState: async () => ({ tick: 0, sqrtPriceX96: getSqrtPriceAtTick(0), paused: false }),
      readRangeKey: async () => ({ exists: true, key: POOL_KEY,
        tickLower: TARGET.tickLower, tickUpper: TARGET.tickUpper })
    },
    assertAtomicGuardReady: async () => {},
    assertTopUpGasBudget: async () => {},
    getPinnedFeeOverrides: async () => ({ gasPrice: 1n }),
    deadline: () => 9_999_999_999,
    prepareRangeBalancedSwap: async () => {
      calls.fit++;
      return { target: TARGET, postState: { tick: 0, sqrtPriceX96: getSqrtPriceAtTick(0) },
        swapPlan: { direction: 'zeroForOne', tokenIn: 0, rawAmountIn: 10n,
          quote: { minRawAmountOut: 12n, rawAmountOut: 13n } } };
    },
    ensureSwapAllowances: async () => { calls.allowance++; },
    readRawPairBalances: async () => { calls.physicalReads++; return currentBalances; },
    readPositionShares: async (_pool, id) => {
      if (position && id === position.id) calls.lpShareReads++;
      return id === posTopic(NEW_RANGE_ID).toLowerCase() ? SHARES : lpShares;
    },
    findWalletDepositEvent: (_pool, receipt) => {
      const entry = receipt.logs.find(log => String(log.address).toLowerCase() === HOOK.toLowerCase()
        && String(log.topics?.[0]).toLowerCase() === depositedTopic
        && String(log.topics?.[1]).toLowerCase() === posTopic(BigInt(WALLET)).toLowerCase());
      return entry ? { rangeId: String(entry.topics[2]).toLowerCase(), liquidity: BigInt(entry.data) } : null;
    },
    validateTopUpPosition: async () => {},
    assertAllocationJobCurrent: () => { calls.scopeChecks++; },
    getAllocationWalletReceiptDeltas: (_receipt, _tokens) => ({
      raw0: currentBalances.raw0 - before.raw0, raw1: currentBalances.raw1 - before.raw1
    }),
    patchJournal: (journal, patch) => {
      const next = { ...journal, ...patch, updatedAt: Date.now() };
      settings.set('activeRebalanceExecution', next);
      journalHistory.push(next);
      return next;
    },
    saveJournal: journal => settings.set('activeRebalanceExecution', journal),
    clearJournal: () => settings.set('activeRebalanceExecution', null),
    sendVerifiedTx: async request => {
      calls.sends++;
      sendPlanData = request.data;
      const hash = txHash(calls.sends);
      request.onSent(hash);
      if (sendBehavior) return sendBehavior({ hash, request, calls,
        setBalances: value => { currentBalances = value; }, setLpShares: value => { lpShares = value; },
        setNonces: (latest, pending) => { latestNonce = latest; pendingNonce = pending; } });
      currentBalances = { raw0: before.raw0 - funding.raw0 + 3n,
        raw1: before.raw1 - funding.raw1 + 2n };
      return receiptFor({ hash, residual0: 3n, residual1: 2n });
    },
    inspectLastPlan: () => sendPlanData
  };
  return { executor, pool, before, funding, txJournal, allocationScope, calls,
    journalHistory, ledgerEvents, settings };
}

const swapFundingPlan = ({ pool, before = BASELINE, funding = FUNDING }) => ({
  pool, walletAddress: WALLET, target: TARGET, balances: before, funding,
  swapPlan: { direction: 'zeroForOne', tokenIn: 0, rawAmountIn: 10n,
    quote: { minRawAmountOut: 12n } },
  routerRequest: { router: UNISWAP_UNIVERSAL_ROUTER_212, data: '0x12345678', value: 0n },
  minLiquidity: 1n, deadline: 1234
});

test('semantic sequential preflight reverts are refitted before any capital broadcast', async () => {
  const h = makeHarness();
  const original = h.executor.prepareRangeBalancedSwap;
  let rounds = 0;
  h.executor.preparePinnedRangeBalancedSwap = async function (options) {
    if (++rounds === 1) throw Object.assign(new Error('stale preview'), { code: 'SEQUENTIAL_SIMULATION_REVERT' });
    return original.call(this, options);
  };
  const result = await executeAtomicDeposit.call(h.executor, {
    pool, target: TARGET, funding: FUNDING, balances: BASELINE, journal: h.txJournal
  });
  assert.equal(result.status, 'completed'); assert.equal(h.calls.sends, 1);
  assert.equal(rounds, 3); // one rejected round; refit before and after allowance reads
  assert.ok(h.journalHistory.some(j => j.atomicRetryReason === 'preflight-price-changed'));
});

test('semantic preflight retries are bounded and never broadcast a failing plan', async () => {
  const h = makeHarness(); let rounds = 0;
  h.executor.preparePinnedRangeBalancedSwap = async () => {
    rounds++; throw Object.assign(new Error('always reverting'), { code: 'SEQUENTIAL_SIMULATION_REVERT' });
  };
  await assert.rejects(executeAtomicDeposit.call(h.executor, {
    pool, target: TARGET, funding: FUNDING, balances: BASELINE, journal: h.txJournal
  }), /always reverting/);
  assert.equal(rounds, 3); assert.equal(h.calls.sends, 0);
  assert.equal(h.settings.get('activeRebalanceExecution').phase, 'failed');
});

test('atomic request encodes a single swap-and-deposit call and enforces authorized funding', () => {
  const built = buildAtomicDepositRequest(swapFundingPlan({ pool }));
  const parsed = guardInterface.parseTransaction({ data: built.data });
  assert.equal(parsed.name, 'atomicSwapAndDeposit');
  assert.equal(parsed.args.plan.funding0, FUNDING.raw0);
  assert.equal(parsed.args.plan.funding1, FUNDING.raw1);
  assert.equal(parsed.args.plan.amountIn, 10n);
  assert.throws(() => buildAtomicDepositRequest(swapFundingPlan({ pool,
    funding: { raw0: BASELINE.raw0 + 1n, raw1: 0n } })), /exceeds authorized inventory/);
  assert.throws(() => buildAtomicDepositRequest({ ...swapFundingPlan({ pool }),
    routerRequest: { router: TOKEN0, data: '0x12345678', value: 0n } }), /Unsupported atomic swap route/);
});

test('one send produces one hash/receipt for swap plus deposit and preserves allocation reserves', async () => {
  const before = { raw0: 1000n, raw1: 800n };
  const funding = { raw0: 100n, raw1: 80n };
  const allocationScope = { allocationUpdatedAt: 1, poolId: POOL_ID,
    tokenCaps: { [TOKEN0]: '100', [TOKEN1]: '80' } };
  const h = makeHarness({ before, funding, allocationScope });
  const eventMetadata = { manualIdle: false, sourcePoolId: `0x${'44'.repeat(32)}`,
    destinationPoolId: POOL_ID, sourcePair: 'SRC/USDG', destinationPair: 'T0/T1',
    oldPositionId: posTopic(RANGE_ID).toLowerCase(),
    routeSwapPoolIds: [[`0x${'55'.repeat(32)}`]], aprPct: 12.5 };
  const result = await executeAtomicDeposit.call(h.executor, {
    pool: h.pool, target: TARGET, funding, balances: before, journal: h.txJournal,
    allocationScope, eventMetadata, onJournal: () => {}
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.atomic, true);
  assert.equal(h.calls.sends, 1);
  assert.ok(h.calls.scopeChecks >= 2);
  const parsed = guardInterface.parseTransaction({ data: h.executor.inspectLastPlan() });
  assert.equal(parsed.name, 'atomicSwapAndDeposit');
  assert.equal(parsed.args.plan.expectedBalance0, before.raw0);
  assert.equal(parsed.args.plan.expectedBalance1, before.raw1);
  assert.equal(parsed.args.plan.funding0, funding.raw0);
  assert.equal(parsed.args.plan.funding1, funding.raw1);
  assert.deepEqual(result.balancesAfterRaw, { raw0: '903', raw1: '722' });
  assert.equal(result.swapHash, result.depositHash);
  assert.equal(result.atomicSwapDepositHash, result.depositHash);
  const completed = h.ledgerEvents.filter(event => event.type === 'rebalance.completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].data.pair, 'T0/T1');
  assert.equal(completed[0].data.destinationPoolId, POOL_ID);
  assert.deepEqual(completed[0].data.routeSwapPoolIds, eventMetadata.routeSwapPoolIds);
  assert.equal(completed[0].data.balanceSwapHash, completed[0].data.depositHash);
  assert.equal(completed[0].data.balanceSwapPoolId, POOL_ID);
  assert.equal(completed[0].data.oldPositionId, eventMetadata.oldPositionId);
  assert.deepEqual(completed[0].data.allocationFundingScope, null);
});

test('cross-pool atomic branch follows withdrawal and route swaps, before legacy balance swap', () => {
  const source = readFileSync(new URL('../src/adapters/executor.js', import.meta.url), 'utf8');
  const methodStart = source.indexOf('  async executeCrossPoolUnlocked(');
  const methodEnd = source.indexOf('\n  async reconcileConfirmedNoOp(', methodStart);
  assert.ok(methodStart >= 0 && methodEnd > methodStart);
  const method = source.slice(methodStart, methodEnd);
  const withdrawal = method.indexOf("label: plan.manualImmediate === true ? 'manualImmediateWithdrawAndClaim'");
  const routeLoop = method.indexOf('for (const swap of preflight.routeSwaps) {', withdrawal);
  const atomicCall = method.indexOf('executeAtomicDeposit.call(this, { pool: destinationPool', routeLoop);
  const legacyBalanceSwap = method.indexOf('if (preflight.balanceSwap) {', atomicCall);
  assert.ok(withdrawal >= 0 && routeLoop > withdrawal);
  assert.ok(atomicCall > routeLoop);
  assert.ok(legacyBalanceSwap > atomicCall);
  assert.match(source, /pendingApprovalCount:\s*routeApprovals\.length/);
  assert.match(method, /eventMetadata:\s*\{[\s\S]*routeSwapPoolIds:\s*executedRouteIds/);
});

test('allocation funding excludes reserves beyond the pool-specific caps', async () => {
  const before = { raw0: 1000n, raw1: 800n };
  const funding = { raw0: 100n, raw1: 80n };
  const h = makeHarness({ before, funding,
    allocationScope: { allocationUpdatedAt: 1, poolId: POOL_ID,
      tokenCaps: { [TOKEN0]: '100', [TOKEN1]: '80' } } });
  await executeAtomicDeposit.call(h.executor, { pool: h.pool, target: TARGET, funding,
    balances: before, journal: h.txJournal, allocationScope: h.allocationScope });
  const parsed = guardInterface.parseTransaction({ data: h.executor.inspectLastPlan() });
  assert.equal(parsed.args.plan.expectedBalance0, 1000n);
  assert.equal(parsed.args.plan.expectedBalance1, 800n);
  assert.equal(parsed.args.plan.funding0, 100n);
  assert.equal(parsed.args.plan.funding1, 80n);
});

test('atomic event parser rejects missing or duplicate matching events', () => {
  const hash = txHash(10);
  assert.throws(() => findAtomicDepositEvent(receiptFor({ hash, omitAtomic: true }), WALLET, POOL_ID),
    /exactly one matching AtomicDeposited event/);
  assert.throws(() => findAtomicDepositEvent(receiptFor({ hash, duplicateAtomic: true }), WALLET, POOL_ID),
    /exactly one matching AtomicDeposited event/);
});

test('confirmed no-op revert is refitted and retried at most three total sends', async () => {
  const position = { id: posTopic(RANGE_ID).toLowerCase(), tickLower: -100, tickUpper: 100 };
  const h = makeHarness({ sendBehavior: async ({ hash, calls, setBalances, setLpShares }) => {
    if (calls.sends < 3) {
      const error = new Error('mock confirmed atomic revert');
      error.code = 'TRANSACTION_REVERTED';
      error.receipt = { hash, status: 0, blockNumber: 100 + calls.sends };
      throw error;
    }
    setBalances({ raw0: BASELINE.raw0 - FUNDING.raw0 + 3n,
      raw1: BASELINE.raw1 - FUNDING.raw1 + 2n });
    setLpShares(SHARES);
    return receiptFor({ hash, residual0: 3n, residual1: 2n, rangeId: RANGE_ID });
  }, position });
  const result = await executeAtomicDeposit.call(h.executor, { pool: h.pool, target: TARGET,
    funding: FUNDING, balances: BASELINE, journal: h.txJournal, position });
  assert.equal(result.status, 'completed');
  assert.equal(h.calls.sends, 3);
  assert.equal(h.calls.fit, 4);
  assert.equal(h.calls.allowance, 1);
  assert.equal(h.calls.physicalReads, 6);
  assert.equal(h.calls.latestNonceReads, 2);
  assert.equal(h.calls.pendingNonceReads, 2);
  assert.equal(h.calls.lpShareReads, 6);
  assert.equal(h.journalHistory.filter(journal => journal.phase === 'atomic_retry').length, 2);
  const sentJournal = h.journalHistory.filter(journal => journal.phase === 'atomic_sent').at(-1);
  assert.equal(sentJournal.tx.atomicSwapDeposit, txHash(3));
});

test('confirmed revert with changed LP shares is not retried and leaves recovery locked', async () => {
  const position = { id: posTopic(RANGE_ID).toLowerCase(), tickLower: -100, tickUpper: 100 };
  const h = makeHarness({ position, sendBehavior: async ({ hash, setLpShares }) => {
    setLpShares(6n);
    const error = new Error('mock confirmed atomic revert');
    error.code = 'TRANSACTION_REVERTED';
    error.receipt = { hash, status: 0, blockNumber: 200 };
    throw error;
  } });
  await assert.rejects(executeAtomicDeposit.call(h.executor, { pool: h.pool, position,
    target: TARGET, funding: FUNDING, balances: BASELINE, journal: h.txJournal }),
  /mock confirmed atomic revert/);
  assert.equal(h.calls.sends, 1);
  assert.equal(h.settings.get('activeRebalanceExecution').phase, 'recovery_required');
});

test('confirmed revert with changed physical balance or nonce is not retried', async t => {
  const cases = [
    ['balance changed', async ({ hash, setBalances }) => {
      setBalances({ raw0: BASELINE.raw0 + 1n, raw1: BASELINE.raw1 });
      const error = new Error('mock confirmed atomic revert');
      error.code = 'TRANSACTION_REVERTED'; error.receipt = { hash, status: 0, blockNumber: 201 };
      throw error;
    }],
    ['nonce changed', async ({ hash, setNonces }) => {
      setNonces(10, 9);
      const error = new Error('mock confirmed atomic revert');
      error.code = 'TRANSACTION_REVERTED'; error.receipt = { hash, status: 0, blockNumber: 202 };
      throw error;
    }]
  ];
  for (const [name, sendBehavior] of cases) await t.test(name, async () => {
    const h = makeHarness({ sendBehavior });
    await assert.rejects(executeAtomicDeposit.call(h.executor, { pool: h.pool, target: TARGET,
      funding: FUNDING, balances: BASELINE, journal: h.txJournal }), /mock confirmed atomic revert/);
    assert.equal(h.calls.sends, 1);
    assert.equal(h.settings.get('activeRebalanceExecution').phase, 'recovery_required');
    assert.equal(h.journalHistory.some(journal => journal.phase === 'atomic_retry'), false);
  });
});

test('uncertain atomic broadcast locks recovery and is never retried', async () => {
  const h = makeHarness({ sendBehavior: async ({ hash }) => {
    const error = new Error('broadcast outcome uncertain');
    error.code = 'BROADCAST_OUTCOME_UNCERTAIN'; error.txHash = hash;
    throw error;
  } });
  await assert.rejects(executeAtomicDeposit.call(h.executor, { pool: h.pool, target: TARGET,
    funding: FUNDING, balances: BASELINE, journal: h.txJournal }), /broadcast outcome uncertain/);
  assert.equal(h.calls.sends, 1);
  assert.equal(h.settings.get('activeRebalanceExecution').phase, 'recovery_required');
  assert.equal(h.settings.get('activeRebalanceExecution').tx.atomicSwapDeposit, txHash(1));
});

test('confirmed atomic transaction followed by receipt verification failure requires recovery', async () => {
  const h = makeHarness({ sendBehavior: async ({ hash, setBalances }) => {
    setBalances({ raw0: BASELINE.raw0 - FUNDING.raw0 + 3n,
      raw1: BASELINE.raw1 - FUNDING.raw1 + 2n });
    return receiptFor({ hash, omitAtomic: true });
  } });
  await assert.rejects(executeAtomicDeposit.call(h.executor, { pool: h.pool, target: TARGET,
    funding: FUNDING, balances: BASELINE, journal: h.txJournal }), /exactly one matching AtomicDeposited event/);
  const journal = h.settings.get('activeRebalanceExecution');
  assert.equal(h.calls.sends, 1);
  assert.equal(journal.phase, 'recovery_required');
  assert.equal(journal.tx.atomicSwapDeposit, txHash(1));
});

test('preflight failure after a withdrawal journaled cannot be cleared as safe failure', async () => {
  const h = makeHarness({ startingJournal: { id: 'synthetic-atomic-job', kind: 'rebalance',
    phase: 'prepared', startedAt: 1000, poolId: POOL_ID, pair: 'T0/T1', tx: { withdraw: txHash(40) } } });
  h.executor.assertAtomicGuardReady = async () => { throw new Error('guard readiness failed'); };
  await assert.rejects(executeAtomicDeposit.call(h.executor, { pool: h.pool, target: TARGET,
    funding: FUNDING, balances: BASELINE, journal: h.txJournal }), /guard readiness failed/);
  assert.equal(h.calls.sends, 0);
  assert.equal(h.settings.get('activeRebalanceExecution').phase, 'recovery_required');
  assert.equal(h.settings.get('activeRebalanceExecution').tx.withdraw, txHash(40));
});
