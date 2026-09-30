import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { RebalanceExecutor, buildCrossPoolWithdrawCall } from '../src/adapters/executor.js';
import { V4QuoterAdapter } from '../src/adapters/quoter.js';
import { assertCrossPoolWeightedQuoteCost } from '../src/execution/investment-target.js';
import { EIP7702_GUARD_ABI, HOOK_ABI, V4_QUOTER_ABI } from '../src/abi.js';

const USDG = { address: '0x0000000000000000000000000000000000000010', symbol: 'USDG' };
const EARN = { address: '0x0000000000000000000000000000000000000020', symbol: 'EARN' };
const ORBIO = { address: '0x0000000000000000000000000000000000000030', symbol: 'ORBIO' };
const source = { id: 'source', token0: USDG, token1: EARN };
const destination = { id: 'destination', token0: USDG, token1: ORBIO };

test('explicit manual rotation uses direct hook withdrawal while automatic OOR keeps the guard', () => {
  const walletAddress = '0x0000000000000000000000000000000000000001';
  const pool = { key: { currency0: USDG.address, currency1: EARN.address,
    fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000080' } };
  const position = { tickLower: -120, tickUpper: 120, shares: 1000n };
  const args = { pool, position, bounds: { amount0Min: 1n, amount1Min: 2n },
    deadline: 123, walletAddress, fablesWalk: 1000 };
  const manual = buildCrossPoolWithdrawCall({ ...args, manualImmediate: true });
  const automatic = buildCrossPoolWithdrawCall(args);
  assert.equal(manual.to, pool.key.hooks);
  assert.equal(new Interface(HOOK_ABI).parseTransaction({ data: manual.data }).name, 'withdrawAndClaim');
  assert.equal(automatic.to, walletAddress);
  assert.equal(new Interface(EIP7702_GUARD_ABI).parseTransaction({ data: automatic.data }).name,
    'guardedWithdrawAndClaim');
});

test('manual immediate entry bypasses OOR only for an explicit different-pool dashboard plan', async () => {
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.assertPlanStillOutOfRange = () => { throw new Error('OOR only'); };
  executor.executeCrossPoolUnlocked = async (_plan, pool) => ({ status: 'manual-path', poolId: pool.id });
  executor.config = { dryRun: false, enableLiveWrites: true };
  assert.deepEqual(await executor.execute({ pool: source, destinationPool: destination,
    manualImmediate: true, manualSource: 'dashboard' }),
  { status: 'manual-path', poolId: destination.id });
  await assert.rejects(() => executor.execute({ pool: source, destinationPool: destination,
    manualImmediate: true, manualSource: 'automatic' }), /explicit|different saved destination/i);
  await assert.rejects(() => executor.execute({ pool: source, destinationPool: destination }), /OOR only/);
});

test('manual in-range withdrawal refuses changed LP shares or a paused source pool', async () => {
  const executor = Object.create(RebalanceExecutor.prototype);
  const plan = { pool: { ...source }, position: { id: 'range', shares: 100n },
    manualImmediate: true, manualSource: 'dashboard' };
  executor.fables = { async readPoolState() { return { paused: false, tick: 0 }; } };
  executor.readPositionShares = async () => 99n;
  await assert.rejects(() => executor.assertManualRotationSource(plan, 'test'), /shares changed/);
  executor.readPositionShares = async () => 100n;
  assert.equal((await executor.assertManualRotationSource(plan, 'test')).tick, 0);
  executor.fables.readPoolState = async () => ({ paused: true, tick: 0 });
  await assert.rejects(() => executor.assertManualRotationSource(plan, 'test'), /paused/);
});

test('cross-pool route accepts a roughly three percent quote within its scoped ceiling', async () => {
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.config = { swapSlippageBps: 50 };
  executor.deadline = () => 123;
  executor.fables = { async readPoolState() { return {
    paused: false, liquidity: 1n, sqrtPriceX96: 2n ** 96n
  }; } };
  executor.quoter = Object.assign(new V4QuoterAdapter(null), { async quoteExactInputSingleRaw(_pool, index, raw) {
    assert.equal(index, 1);
    assert.equal(raw, 10000n);
    return { tokenIn: EARN.address, tokenOut: USDG.address,
      rawAmountIn: '10000', rawAmountOut: '9700', minRawAmountOut: '9651' };
  } });
  executor.router = { buildV4ExactInputSingle() { return { router: '0xrouter', data: '0x' }; } };
  const route = await executor.quoteCrossPoolRoute([source], EARN, 10000n, 350);
  assert.equal(route.impactBps, 300);
  assert.equal(route.request.router, '0xrouter');
});

test('cross-pool route rejects a two-pool quote above the total route ceiling', async () => {
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.config = { swapSlippageBps: 50 };
  executor.deadline = () => 123;
  executor.fables = { async readPoolState() { return {
    paused: false, liquidity: 1n, sqrtPriceX96: 2n ** 96n
  }; } };
  executor.quoter = { async quoteExactInputPathRaw() { return {
    tokenIn: EARN.address, tokenOut: ORBIO.address,
    rawAmountIn: '10000', rawAmountOut: '9400', minRawAmountOut: '9353'
  }; } };
  executor.router = { buildV4ExactInputPath() { throw new Error('must not build unsafe route'); } };
  await assert.rejects(() => executor.quoteCrossPoolRoute(
    [source, destination], EARN, 10000n, 350
  ), /route cost 600 bps exceeds 350 bps/);
});

test('cross-pool cost weighs each swap against complete wallet capital', () => {
  const legs = [{ inputUsd: 600, impactBps: 300 }, { inputUsd: 200, impactBps: 40 }];
  assert.equal(assertCrossPoolWeightedQuoteCost(legs, 1000, 350, 50), 228);
  assert.throws(() => assertCrossPoolWeightedQuoteCost([
    { inputUsd: 1000, impactBps: 300 }, { inputUsd: 200, impactBps: 40 }
  ], 1000, 350, 50), /weighted quoted swap cost 368.00 bps exceeds 350 bps/);
  assert.throws(() => assertCrossPoolWeightedQuoteCost([{ inputUsd: 1, impactBps: Number.NaN }], 1000, 350),
    /quote cost is incomplete/);
});

test('source-pool conversion quote uses simulated post-withdrawal state', async () => {
  const pool = { ...source,
    token0: { ...USDG, decimals: 6 }, token1: { ...EARN, decimals: 18 },
    key: { currency0: USDG.address, currency1: EARN.address,
      fee: 0x800000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000080' }
  };
  const iface = new Interface(V4_QUOTER_ABI);
  let simulated = 0;
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.config = { walletAddress: '0x0000000000000000000000000000000000000001',
    chainId: 4663, swapSlippageBps: 50 };
  executor.deadline = () => 123;
  executor.fables = { async readPoolState() { return {
    paused: false, liquidity: 1n, sqrtPriceX96: 2n ** 96n
  }; } };
  executor.quoter = { address: '0x0000000000000000000000000000000000000002' };
  executor.writeProvider = { async send(method, params) {
    if (method === 'eth_chainId') return '0x1237';
    assert.equal(method, 'eth_simulateV1');
    assert.equal(params[0].blockStateCalls[0].calls.length, 2);
    simulated++;
    return [{ calls: [
      { status: '0x1', returnData: '0x' },
      { status: '0x1', returnData: iface.encodeFunctionResult('quoteExactInputSingle', [9700n, 100000n]) }
    ] }];
  } };
  executor.router = { buildV4ExactInputSingle() { return { router: '0xrouter', data: '0x' }; } };
  const result = await executor.quoteCrossPoolRoute([pool], pool.token1, 10000n, 350,
    { to: executor.config.walletAddress, data: '0x1234', gasLimit: 1_500_000 });
  assert.equal(simulated, 1);
  assert.equal(result.impactBps, 300);
});
