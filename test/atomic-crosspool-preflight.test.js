import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id, keccak256, toBeHex, zeroPadValue } from 'ethers';
import { DEPOSITED_EVENT, EIP7702_GUARD_ABI, ERC20_ABI } from '../src/abi.js';
import { RebalanceExecutor } from '../src/adapters/executor.js';
import { getSqrtPriceAtTick } from '../src/math/v4-fixed.js';

const WALLET = `0x${'99'.repeat(20)}`;
const TOKEN0 = `0x${'11'.repeat(20)}`;
const TOKEN1 = `0x${'22'.repeat(20)}`;
const SOURCE = `0x${'33'.repeat(20)}`;
const HOOK = `0x${'44'.repeat(20)}`;
const POOL_ID = keccak256('0x123456');
const RANGE_ID = 17n;
const LIQUIDITY = 987n;
const Q96 = getSqrtPriceAtTick(0);
const guard = new Interface(EIP7702_GUARD_ABI);
const erc20 = new Interface(ERC20_ABI);
const deposited = new Interface(['event Deposited(address indexed owner,uint256 indexed id,uint128 liquidity)']);
const pool = { id: POOL_ID,
  key: { currency0: TOKEN0, currency1: TOKEN1, fee: 3000, tickSpacing: 10, hooks: HOOK },
  token0: { address: TOKEN0, symbol: 'ASSET', decimals: 18 },
  token1: { address: TOKEN1, symbol: 'USDG', decimals: 18 } };
const routePool = { id: keccak256('0xabcd'), token0: { address: SOURCE }, token1: pool.token0 };
const prefixRoute = { route: [routePool], tokenIn: { address: SOURCE, symbol: 'SRC', decimals: 18 },
  rawAmountIn: 10n * 10n ** 18n, maxImpactBps: 350, impactBps: 10,
  request: { router: `0x${'55'.repeat(20)}`, data: '0x12345678', value: 0n },
  quote: { tokenOut: TOKEN0, minRawAmountOut: 9n * 10n ** 18n } };
const withdrawCall = { to: WALLET, data: '0xabcdef', value: 0n, gasLimit: 1_500_000 };

function result({ returnData = '0x', logs = [], gasUsed = 100_000n, status = '0x1', error } = {}) {
  return { status, returnData, logs, gasUsed: `0x${gasUsed.toString(16)}`, ...(error ? { error } : {}) };
}
function pairBalanceResult(value) {
  return result({ returnData: erc20.encodeFunctionResult('balanceOf', [value]) });
}
function atomicEvents() {
  const atomic = guard.encodeEventLog(guard.getEvent('AtomicDeposited'),
    [POOL_ID, LIQUIDITY, 70n * 10n ** 18n, 50n * 10n ** 18n, 0n, 0n]);
  const ownerTopic = zeroPadValue(WALLET, 32);
  const rangeTopic = zeroPadValue(toBeHex(RANGE_ID), 32);
  const dep = deposited.encodeEventLog(deposited.getEvent('Deposited'), [WALLET, RANGE_ID, LIQUIDITY]);
  return [{ address: WALLET, ...atomic }, { address: HOOK, ...dep,
    topics: [id(DEPOSITED_EVENT), ownerTopic, rangeTopic] }];
}
function makeHarness({ failAtomic = false, allocation = false } = {}) {
  const seen = [];
  const preparedInputs = [];
  const simulations = [];
  const rpcMethods = [];
  const cap0 = 70n * 10n ** 18n;
  const cap1 = 50n * 10n ** 18n;
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.config = { walletAddress: WALLET, chainId: 4663, usdgAddress: TOKEN1,
    tightWidthBps: 120, rangePreset: 'custom-bps', swapSlippageBps: 50,
    depositSlippageBps: 50, autoTopupDustBps: 25 };
  executor.writeProvider = { async send(method, params) {
    rpcMethods.push(method);
    if (method === 'eth_chainId') return '0x1237';
    assert.equal(method, 'eth_simulateV1');
    const calls = params[0].blockStateCalls[0].calls;
    simulations.push(calls);
    const finalCall = calls.at(-1);
    const parsed = finalCall.to.toLowerCase() === WALLET.toLowerCase()
      ? guard.parseTransaction({ data: finalCall.data }) : null;
    const isAtomic = parsed?.name === 'atomicSwapAndDeposit';
    seen.push(isAtomic ? 'atomic-sequence-simulation' : 'prefix-simulation');
    const callsResult = calls.map(() => result());
    if (calls.length >= 2 && calls.at(-2).to.toLowerCase() === TOKEN0.toLowerCase()
      && calls.at(-1).to.toLowerCase() === TOKEN1.toLowerCase()) {
      callsResult[calls.length - 2] = pairBalanceResult(100n * 10n ** 18n);
      callsResult[calls.length - 1] = pairBalanceResult(60n * 10n ** 18n);
    }
    if (isAtomic) {
      if (failAtomic) callsResult[calls.length - 1] = result({ status: '0x0',
        error: { message: 'synthetic atomic guard revert', data: '0xdeadbeef' } });
      else callsResult[calls.length - 1] = result({ logs: atomicEvents() });
    }
    return [{ calls: callsResult }];
  } };
  executor.buildTopUpApprovalRequests = async () => [];
  executor.getUsdPrice = () => 1;
  executor.quoter = { address: `0x${'66'.repeat(20)}`, routeCostContext: {}, v3ValidatedPools: [] };
  executor.router = { buildV4ExactInputSingle: () => ({ router: `0x${'77'.repeat(20)}`,
    data: '0x11223344', value: 0n }) };
  executor.deadline = () => 1234;
  executor.fables = { readPoolState: async () => ({ tick: 0, sqrtPriceX96: Q96, paused: false }) };
  executor.prepareRangeBalancedSwap = async input => {
    preparedInputs.push(input);
    return { target: { tickLower: -100, tickUpper: 100 },
      postState: { tick: 0, sqrtPriceX96: Q96 },
      swapPlan: { direction: 'none', tokenIn: null, rawAmountIn: 0n, priceImpactBps: 0 } };
  };
  executor.findWalletDepositEvent = RebalanceExecutor.prototype.findWalletDepositEvent.bind(executor);
  executor.config.atomicDepositEnabled = true;
  const funding = [
    { address: TOKEN0, token: pool.token0, dustRaw: 7n * 10n ** 18n,
      maxSpendRaw: allocation ? cap0 : 93n * 10n ** 18n },
    { address: TOKEN1, token: pool.token1, dustRaw: 5n * 10n ** 18n,
      maxSpendRaw: allocation ? cap1 : 55n * 10n ** 18n }
  ];
  return { executor, seen, preparedInputs, simulations, rpcMethods, funding,
    plan: { allocationBootstrap: allocation },
    prepared: { funding, routeSwaps: [prefixRoute], withdrawCall,
      destinationState: { tick: 0, sqrtPriceX96: Q96, liquidity: 1000n },
      deadline: 1234, maxImpactBps: 350 } };
}

test('atomic cross-pool preflight uses converted balances and proves one atomic call with matching mint events', async () => {
  const h = makeHarness();
  const preflight = await h.executor.preflightAtomicCrossPoolDeposit(h.plan, pool, h.prepared);
  assert.equal(h.seen.length, 2);
  assert.deepEqual(h.rpcMethods, ['eth_chainId', 'eth_simulateV1', 'eth_chainId', 'eth_simulateV1']);
  assert.deepEqual(h.seen, ['prefix-simulation', 'atomic-sequence-simulation']);
  assert.deepEqual(h.preparedInputs[0].funding, { raw0: 93n * 10n ** 18n, raw1: 55n * 10n ** 18n });
  assert.deepEqual(h.preparedInputs[0].state, { tick: 0, sqrtPriceX96: Q96, liquidity: 1000n });
  assert.equal(h.preparedInputs[0].prefixCalls.length, 2);
  assert.equal(h.preparedInputs[0].prefixCalls[0], withdrawCall);
  assert.equal(h.preparedInputs[0].prefixCalls[1].to, prefixRoute.request.router);
  const finalCalls = h.simulations.at(-1);
  const final = finalCalls.at(-1);
  assert.equal(final.to.toLowerCase(), WALLET.toLowerCase());
  assert.equal(guard.parseTransaction({ data: final.data }).name, 'atomicSwapAndDeposit');
  assert.equal(finalCalls.some(call => call.to.toLowerCase() === HOOK.toLowerCase()), false,
    'the proof must not substitute a standalone hook deposit');
  assert.equal(preflight.status, 'full-sequence-simulated');
  assert.equal(preflight.atomic, true);
  assert.equal(preflight.mintedLiquidity, LIQUIDITY.toString());
  assert.equal(preflight.pendingApprovalCount, 0);
});

test('allocation atomic preflight never funds beyond per-pool caps', async () => {
  const h = makeHarness({ allocation: true });
  const preflight = await h.executor.preflightAtomicCrossPoolDeposit(h.plan, pool, h.prepared);
  assert.deepEqual(h.preparedInputs[0].funding, { raw0: 70n * 10n ** 18n, raw1: 50n * 10n ** 18n });
  const atomicCall = h.simulations.at(-1).at(-1);
  const parsed = guard.parseTransaction({ data: atomicCall.data });
  assert.equal(parsed.args.plan.funding0, 70n * 10n ** 18n);
  assert.equal(parsed.args.plan.funding1, 50n * 10n ** 18n);
  assert.equal(preflight.atomic, true);
});

test('atomic preflight revert rejects before cross-pool withdrawal can be sent', async () => {
  const h = makeHarness({ failAtomic: true });
  await assert.rejects(h.executor.preflightAtomicCrossPoolDeposit(h.plan, pool, h.prepared),
    /synthetic atomic guard revert/);
  assert.deepEqual(h.seen, ['prefix-simulation', 'atomic-sequence-simulation']);
  assert.equal(h.simulations.at(-1).at(-1).to.toLowerCase(), WALLET.toLowerCase());
  assert.equal(h.simulations.some(calls => calls.some(call => call.data === withdrawCall.data)), true,
    'withdraw appears only as an eth_simulateV1 prefix, never a live send');
});

test('execution orchestration never broadcasts withdrawal when atomic preflight fails', async () => {
  const h = makeHarness({ failAtomic: true });
  let preflightCalls = 0;
  let liveSends = 0;
  let journal = null;
  const routePreflight = { ...h.prepared, before: new Map([[SOURCE, 20n * 10n ** 18n]]),
    postWithdraw: new Map([[SOURCE, 10n * 10n ** 18n]]),
    withdrawnRaw: { raw0: '1', raw1: '1' }, scopedBefore: null,
    pendingApprovalCount: 0, routeImpactBps: [10], balanceImpactBps: null,
    finalTarget: { tickLower: -100, tickUpper: 100 }, mintedLiquidity: LIQUIDITY.toString(),
    simulatedCallCount: 4, simulatedGasUsed: '400000' };
  Object.assign(h.executor, {
    config: { ...h.executor.config, dryRun: false, enableLiveWrites: true },
    isAllocationModeEnabled: () => false,
    assertLiveReady: async () => {}, assertNoUnfinishedExecution: () => {},
    saveJournal: value => { journal = value; },
    patchJournal: (value, patch) => { journal = { ...value, ...patch }; return journal; },
    preflightCrossPoolSequence: async (plan, targetPool) => {
      preflightCalls++;
      if (preflightCalls === 1) return routePreflight;
      return h.executor.preflightAtomicCrossPoolDeposit(plan, targetPool, h.prepared);
    },
    ensureSwapAllowances: async () => {},
    ensureHookAllowance: async () => { throw new Error('atomic must skip standalone hook approvals'); },
    getPinnedFeeOverrides: async () => ({ gasPrice: 1n }),
    assertTopUpGasBudget: async () => {},
    assertPlanStillOutOfRange: async () => {},
    sendVerifiedTx: async () => { liveSends++; return { hash: `0x${'aa'.repeat(32)}` }; },
    ledger: { append() {} }
  });
  const source = { id: `0x${'88'.repeat(32)}`, token0: { ...pool.token0, address: SOURCE, symbol: 'SRC' },
    token1: { ...pool.token1, address: `0x${'77'.repeat(20)}`, symbol: 'SRC2' } };
  h.plan = { pool: source, position: { id: `0x${'66'.repeat(32)}`,
    tickLower: -100, tickUpper: 100, shares: 1n }, manualIdle: false };
  await assert.rejects(h.executor.executeCrossPoolUnlocked(h.plan, pool), /synthetic atomic guard revert/);
  assert.equal(preflightCalls, 2);
  assert.equal(liveSends, 0, 'no withdrawal or route may be broadcast before atomic proof passes');
  assert.equal(journal.phase, 'failed');
});
