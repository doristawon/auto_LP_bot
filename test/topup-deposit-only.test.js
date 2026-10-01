import test from 'node:test';
import assert from 'node:assert/strict';
import { RebalanceExecutor } from '../src/adapters/executor.js';
import { getSqrtPriceAtTick } from '../src/math/v4-fixed.js';

const pool = {
  id: 'fables-test-pool',
  key: {
    currency0: '0x0000000000000000000000000000000000000010',
    currency1: '0x0000000000000000000000000000000000000020',
    fee: 8388608,
    tickSpacing: 10,
    hooks: '0x0000000000000000000000000000000000000030'
  },
  token0: { address: '0x0000000000000000000000000000000000000010', symbol: 'EARN', decimals: 18 },
  token1: { address: '0x0000000000000000000000000000000000000020', symbol: 'USDG', decimals: 18 }
};
const position = {
  id: '0x' + '44'.repeat(32),
  tickLower: -200,
  tickUpper: 200,
  shares: 500n
};

test('top-up dry-run pairs existing wallet balances and does not depend on swap output for the deposit plan', async () => {
  const events = [];
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.config = {
    dryRun: true,
    enableLiveWrites: false,
    walletAddress: '0x00000000000000000000000000000000000000aa',
    swapSlippageBps: 50,
    maxSwapPriceImpactBps: 200,
    depositSlippageBps: 50,
    depositLiquidityReserveBps: 10,
    txDeadlineSec: 1200
  };
  executor.state = null;
  executor.ledger = { append(type, data) { events.push({ type, data }); } };
  executor.fables = {
    encodeDeposit() { return '0x1234'; }
  };
  executor.readProvider = { async call() { return '0x'; } };
  executor.router = {
    buildV4ExactInputSingle({ quote, deadline }) {
      return { router: '0x0000000000000000000000000000000000000099', data: '0x1234', value: 0n, quote, deadline };
    },
    async simulateV4ExactInputSingle() { return '0x'; }
  };
  executor.quoter = {
    async quoteExactInputSingleRaw(_pool, tokenIn, rawAmountIn, slippageBps) {
      rawAmountIn = BigInt(rawAmountIn);
      return {
        rawAmountIn: rawAmountIn.toString(),
        rawAmountOut: rawAmountIn.toString(),
        minRawAmountOut: (rawAmountIn * BigInt(10_000 - slippageBps) / 10_000n).toString(),
        tokenIn: tokenIn === 0 ? pool.token0.address : pool.token1.address,
        tokenOut: tokenIn === 0 ? pool.token1.address : pool.token0.address,
        gasEstimate: '100000'
      };
    }
  };
  executor.getUsdPrice = () => 1;
  executor.validateTopUpPosition = async () => ({
    state: { tick: 0, sqrtPriceX96: getSqrtPriceAtTick(0), paused: false, liquidity: 1_000_000n },
    shares: position.shares
  });
  executor.readRawPairBalances = async () => ({ raw0: 200n * 10n ** 18n, raw1: 80n * 10n ** 18n });

  const result = await executor.topUpPoolPosition({ pool, position, dustBps: 25 });
  assert.equal(result.status, 'dry-run');
  assert.notEqual(result.plan.swapPlan.direction, 'none');
  assert.equal(result.plan.swapPolicy, 'deposit-only; optional swap is disabled');
  assert.deepEqual(result.plan.projectedInventoryRaw, result.plan.fundingRaw);
  assert.notDeepEqual(result.plan.optionalSwapProjection.inventoryRaw, result.plan.fundingRaw);
  assert.equal(result.plan.depositSimulation.status, 'deposit-only-simulated');
  assert.ok(events.some((event) => event.type === 'rebalance.top_up_dry_run'));
  assert.equal(events.some((event) => event.type === 'tx.sent'), false);
});

function liveDepositFixture() {
  const settings = new Map();
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.config = { dryRun: false, enableLiveWrites: true, enableAutoRedeploy: true,
    autoTopupEnabled: true, autoTopupSwapEnabled: false,
    walletAddress: '0x00000000000000000000000000000000000000aa',
    usdgAddress: pool.token1.address, depositSlippageBps: 50,
    depositLiquidityReserveBps: 10, txDeadlineSec: 1200, topUpMinGasReserveWei: 1n };
  executor.state = { getSetting: (key, fallback) => settings.get(key) ?? fallback,
    setSetting: (key, value) => settings.set(key, value) };
  executor.ledger = { append() {} };
  executor.signer = { address: executor.config.walletAddress, async estimateGas() { return 100_000n; } };
  executor.getUsdPrice = () => 1;
  executor.assertGasGuard = async () => {};
  executor.assertTopUpGasBudget = async () => {};
  executor.getPinnedFeeOverrides = async () => ({ gasPrice: 1n });
  let validations = 0;
  executor.validateTopUpPosition = async () => ({ shares: 500n,
    state: { tick: validations++ === 0 ? 0 : 50,
      sqrtPriceX96: getSqrtPriceAtTick(validations === 1 ? 0 : 50), paused: false, liquidity: 1_000_000n } });
  const initial = { raw0: 200n * 10n ** 18n, raw1: 80n * 10n ** 18n };
  let balances = { ...initial };
  let approvedPlan;
  const calls = [];
  executor.readRawPairBalances = async () => ({ ...balances });
  executor.buildTopUpApprovalRequests = async (_pool, _swapPlan, plan) => {
    approvedPlan = plan;
    return [{ label: 'exact-approval', tx: { to: pool.token0.address, data: '0x1234' } }];
  };
  executor.assertExactHookAllowance = async (token, _hook, amount) => {
    assert.equal(amount, token.address === pool.token0.address ? approvedPlan.amount0Max : approvedPlan.amount1Max);
  };
  executor.simulateTopUpSequence = async ({ depositPlan, approvalRequests, swapPlan }) => {
    assert.strictEqual(depositPlan, approvedPlan, 'simulation must preserve the exact approved deposit plan');
    assert.equal(swapPlan.direction, 'none');
    calls.push(approvalRequests.length ? 'pre-approval-simulation' : 'mined-approval-simulation');
    return { callCount: approvalRequests.length + 1 };
  };
  executor.readProvider = { async call() { return '0x'; } };
  executor.fables = {
    encodeDeposit(_pool, _range, liquidity, amount0, amount1) {
      if (executor.isAllocationModeEnabled()) {
        assert.equal(liquidity, approvedPlan.liquidity, 'allocation keeps its scoped approved plan');
        assert.equal(amount0, approvedPlan.amount0Max);
        assert.equal(amount1, approvedPlan.amount1Max);
        return '0x5678';
      }
      const refreshedPlan = executor.buildReinvestmentDepositPlan({
        sqrtPriceX96: getSqrtPriceAtTick(50), tickLower: -200, tickUpper: 200,
        rawAmount0: approvedPlan.amount0Max, rawAmount1: approvedPlan.amount1Max,
        slippageBps: 50, liquidityReserveBps: 10
      });
      assert.equal(liquidity, refreshedPlan.liquidity, 'liquidity uses the final in-range price');
      assert.ok(liquidity > 0n && liquidity < approvedPlan.liquidity);
      assert.equal(amount0, approvedPlan.amount0Max);
      assert.equal(amount1, approvedPlan.amount1Max);
      return '0x5678';
    },
    async readRangeKey() { return { exists: true, key: pool.key, tickLower: -200, tickUpper: 200 }; }
  };
  executor.sendVerifiedTx = async ({ label, onSent }) => {
    calls.push(label);
    if (onSent) {
      onSent('0xdeposit');
      balances = { raw0: initial.raw0 - approvedPlan.amount0Max, raw1: initial.raw1 - approvedPlan.amount1Max };
    }
    return { hash: '0xdeposit' };
  };
  executor.findWalletDepositEvent = () => ({ rangeId: position.id, liquidity: 100n });
  executor.readPositionShares = async () => 600n;
  return { executor, calls };
}

test('deposit-only live top-up pins approved caps and refits liquidity after an in-range price change', async () => {
  const { executor, calls } = liveDepositFixture();
  const result = await executor.topUpPoolPosition({ pool, position, dustBps: 25 });
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['pre-approval-simulation', 'exact-approval',
    'mined-approval-simulation', 'fablesTopUpDeposit']);
});

test('failed deposit-only sequence simulation stops before any approval or capital write', async () => {
  const { executor, calls } = liveDepositFixture();
  executor.simulateTopUpSequence = async () => { throw new Error('deposit sequence failed'); };
  await assert.rejects(executor.topUpPoolPosition({ pool, position }), /deposit sequence failed/);
  assert.deepEqual(calls, []);
});

test('allocation-scoped top-up stays eligible despite a stale saved specific target', async () => {
  const { executor } = liveDepositFixture();
  executor.config.autoTopupSwapEnabled = true;
  executor.config.autoTopupSwapPoolId = 'a-different-legacy-pool';
  executor.config.maxSwapPriceImpactBps = 200;
  executor.config.swapSlippageBps = 50;
  executor.isAllocationModeEnabled = () => true;
  executor.state.setSetting('investmentTargetMode', 'specific-pool');
  executor.state.setSetting('investmentTargetPoolId', 'stale-saved-target');
  executor.assertAllocationFundingScope = () => {};
  executor.assertAllocationJobCurrent = () => {};
  executor.clipPairToAllocation = (_pool, balances) => balances;
  let quotes = 0;
  executor.quoter = { async quoteExactInputSingleRaw() { quotes++; throw new Error('quote temporarily unavailable'); } };
  executor.verifyAllocationDepositReceipt = async () => ({ remaining: {} });
  const result = await executor.topUpPoolPosition({ pool, position, allocationFundingScope: {
    allocationUpdatedAt: 123, poolId: pool.id
  } });
  assert.equal(result.status, 'completed');
  assert.ok(quotes > 0, 'the configured allocation pool must be eligible for a balancing swap quote');
});

test('saved single-pool target quotes a swap even when legacy swap pool names another pool', async () => {
  const { executor } = liveDepositFixture();
  executor.config.dryRun = true;
  executor.config.enableLiveWrites = false;
  executor.config.autoTopupSwapEnabled = true;
  executor.config.autoTopupSwapPoolId = 'legacy-moo-pool';
  executor.config.autoTopupMaxSwapPriceImpactBps = 350;
  executor.config.crossPoolMaxSwapPriceImpactBps = 350;
  executor.config.maxSwapPriceImpactBps = 200;
  executor.config.swapSlippageBps = 50;
  executor.state.setSetting('investmentTargetMode', 'specific-pool');
  executor.state.setSetting('investmentTargetPoolId', pool.id);
  executor.fables.encodeDeposit = () => '0x5678';
  let quotes = 0;
  executor.quoter = {
    async quoteExactInputSingleRaw() {
      quotes++;
      throw new Error('synthetic quote unavailable; keep deposit-only fallback');
    }
  };
  const result = await executor.topUpPoolPosition({ pool, position, dustBps: 25 });
  assert.equal(result.status, 'dry-run');
  assert.ok(quotes > 0, 'the saved single-pool target must be eligible for a swap quote');
  assert.equal(result.plan.swapPolicy,
    'swap only after sequential approve + swap + deposit simulation');
  assert.equal(result.plan.maxPriceImpactBps, 350);
});

test('top-up rejects a pool that mismatches the saved specific target before validation or writes', async () => {
  const { executor, calls } = liveDepositFixture();
  executor.state.setSetting('investmentTargetMode', 'specific-pool');
  executor.state.setSetting('investmentTargetPoolId', 'another-pool');
  executor.validateTopUpPosition = async () => { throw new Error('must not validate mismatched pool'); };
  await assert.rejects(executor.topUpPoolPosition({ pool, position }), /does not match the saved specific/);
  assert.deepEqual(calls, []);
});

test('deposit-only sequential simulator submits approvals and deposit without a router call', async () => {
  const { executor } = liveDepositFixture();
  delete executor.simulateTopUpSequence;
  executor.config.chainId = 4663;
  executor.router = { buildV4ExactInputSingle() { throw new Error('unexpected router call'); } };
  executor.fables.encodeDeposit = () => '0x5678';
  let submitted;
  executor.writeProvider = { async send(method, params) {
    if (method === 'eth_chainId') return '0x1237';
    assert.equal(method, 'eth_simulateV1');
    submitted = params[0].blockStateCalls[0].calls;
    return [{ calls: submitted.map(() => ({ status: '0x1', logs: [] })) }];
  } };
  const result = await executor.simulateTopUpSequence({ pool, position,
    approvalRequests: [{ tx: { to: pool.token0.address, data: '0x1234' } }],
    swapPlan: { direction: 'none' },
    depositPlan: { liquidity: 100n, amount0Max: 10n, amount1Max: 20n }
  });
  assert.equal(result.swapRequest, null);
  assert.equal(result.callCount, 2);
  assert.deepEqual(submitted.map((call) => call.to), [pool.token0.address, pool.key.hooks]);
});
