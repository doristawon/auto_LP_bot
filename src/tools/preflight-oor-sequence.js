// Read-only probe of the active OOR range. Never constructs a signer or sends a
// transaction; all state transitions occur inside eth_simulateV1.
import fs from 'node:fs';
import path from 'node:path';
import { Interface } from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';
import { FablesAdapter } from '../adapters/fables.js';
import { RebalanceExecutor } from '../adapters/executor.js';
import { EIP7702_GUARD_ABI, ERC20_ABI } from '../abi.js';
import { buildExactWithdrawBounds } from '../math/v4-fixed.js';
import { buildExactDepositPlan } from '../math/v4-fixed.js';
import { buildTargetRange, isLpOutOfRange } from '../math/ticks.js';
import { simulateSequentialCalls } from '../execution/sequential-simulation.js';
import { buildExactBalancedSwapPlan } from '../execution/exact-rebalance.js';
import { buildPairFundingScope } from '../execution/pair-funding.js';

loadDotEnv();
const config = loadConfig();
const ceilingArg = process.argv.find((arg) => arg.startsWith('--diagnostic-max-bps='));
const diagnosticMaxBps = ceilingArg
  ? Number(ceilingArg.slice('--diagnostic-max-bps='.length))
  : null;
if (diagnosticMaxBps !== null
  && (!Number.isInteger(diagnosticMaxBps) || diagnosticMaxBps < 0 || diagnosticMaxBps > 1000)) {
  throw new Error('Diagnostic max price impact must be an integer from 0 through 1000 bps');
}
const walletDir = path.join(config.dataDir, 'wallets', config.walletAddress.toLowerCase());
const file = fs.existsSync(path.join(walletDir, 'latest-snapshot.json'))
  ? path.join(walletDir, 'latest-snapshot.json')
  : path.join(config.dataDir, 'latest-snapshot.json');
const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
const active = (snapshot.pools || []).flatMap((pool) => (pool.positions || [])
  .filter((position) => BigInt(position.shares || 0) > 0n)
  .map((position) => ({ poolId: pool.id, position })));
if (active.length !== 1) throw new Error('Preflight requires exactly one active LP range');
config.privateKey = '';
config.dryRun = true;
config.enableLiveWrites = false;
const initialProviders = createProviders(config);
const rpcHealth = await verifyProviders(initialProviders.rawProviders, config.chainId);
const healthyRpcUrls = rpcHealth.filter((entry) => entry.ok).map((entry) => config.rpcUrls[entry.index]);
const providers = createProviders({ ...config, rpcUrls: healthyRpcUrls });
const fables = new FablesAdapter(providers.readProvider, config);
const pool = (await fables.discoverAllPools()).find((candidate) => candidate.id === active[0].poolId);
if (!pool) throw new Error('Active LP pool is no longer registered');
const position = active[0].position;
const state = await fables.readPoolState(pool);
if (!isLpOutOfRange(state.tick, position.tickLower, position.tickUpper)) {
  throw new Error('Original LP range is not OOR');
}
const executor = new RebalanceExecutor(
  providers.readProvider, providers.writeProvider, config, fables,
  { append: () => {} }, () => 1, null
);
const appliedMaxBps = diagnosticMaxBps ?? executor.samePoolRebalanceMaxImpactBps(pool);
await executor.assertAtomicGuardReady();
const balances = await executor.readRawPairBalances(pool);
const bounds = buildExactWithdrawBounds({
  sqrtPriceX96: state.sqrtPriceX96,
  tickLower: position.tickLower,
  tickUpper: position.tickUpper,
  liquidity: BigInt(position.shares),
  slippageBps: config.withdrawSlippageBps
});
const deadline = Math.floor(Date.now() / 1000) + config.txDeadlineSec;
const guardData = new Interface(EIP7702_GUARD_ABI).encodeFunctionData('guardedWithdrawAndClaim', [[
  pool.key.currency0, pool.key.currency1, pool.key.fee, pool.key.tickSpacing, pool.key.hooks
], position.tickLower, position.tickUpper, BigInt(position.shares), config.walletAddress,
  bounds.amount0Min, bounds.amount1Min, BigInt(deadline), config.fablesWalk]);
const erc20 = new Interface(ERC20_ABI);
const calls = [
  { to: config.walletAddress, data: guardData, value: 0n, gasLimit: 1_500_000 },
  ...[pool.token0, pool.token1].map((token) => ({
    to: token.address,
    data: erc20.encodeFunctionData('balanceOf', [config.walletAddress]),
    value: 0n,
    gasLimit: 100_000
  }))
];
const simulated = await simulateSequentialCalls(providers.writeProvider, {
  walletAddress: config.walletAddress, chainId: config.chainId, calls
});
const after = {
  raw0: BigInt(erc20.decodeFunctionResult('balanceOf', simulated[1].returnData)[0]),
  raw1: BigInt(erc20.decodeFunctionResult('balanceOf', simulated[2].returnData)[0])
};
const withdrawn = {
  raw0: after.raw0 - balances.raw0,
  raw1: after.raw1 - balances.raw1
};
if (withdrawn.raw0 < 0n || withdrawn.raw1 < 0n || withdrawn.raw0 + withdrawn.raw1 === 0n) {
  throw new Error('Simulated guarded withdrawal did not return non-negative pair inventory');
}
const fundingScope = buildPairFundingScope(pool, after, config.usdgAddress, config.autoTopupDustBps);
const target = buildTargetRange(state.tick, pool.key.tickSpacing, config.tightWidthBps, config.rangePreset);
const swapPlan = await buildExactBalancedSwapPlan({
  pool, quoter: executor.quoter,
  rawAmount0: fundingScope.funding.raw0,
  rawAmount1: fundingScope.funding.raw1,
  sqrtPriceX96: state.sqrtPriceX96,
  tickLower: target.tickLower,
  tickUpper: target.tickUpper,
  slippageBps: config.swapSlippageBps,
  // An optional diagnostic ceiling never changes the live executor's cap.
  maxPriceImpactBps: appliedMaxBps,
  preferRemainderTokenIndex: fundingScope.stableIndex,
  preferredRemainderBps: fundingScope.stableIndex === null ? 0 : Math.min(config.autoTopupDustBps, 50)
});
if (swapPlan.direction === 'none') {
  throw new Error(`Simulated OOR inventory has no executable swap: ${swapPlan.blockedReason || 'already balanced'}`);
}
const swapRequest = executor.router.buildV4ExactInputSingle({
  pool, quote: swapPlan.quote, deadline
});
const approvalRequests = await executor.buildTopUpApprovalRequests(pool, swapPlan, {
  amount0Max: 0n, amount1Max: 0n
});
let simulatedSwap;
try {
  simulatedSwap = await simulateSequentialCalls(providers.writeProvider, {
  walletAddress: config.walletAddress, chainId: config.chainId,
  calls: [
    ...approvalRequests.map(({ tx }) => ({
      to: tx.to, data: tx.data, value: tx.value || 0n, gasLimit: 300_000
    })),
    ...calls.slice(0, 1),
    { to: swapRequest.router, data: swapRequest.data, value: swapRequest.value, gasLimit: 1_500_000 },
    ...calls.slice(1)
  ]
  });
} catch (error) {
  const statuses = (error.simulationResults || []).map((result, index) => ({
    label: approvalRequests[index]?.label || (index === approvalRequests.length ? 'guardedWithdrawAndClaim'
      : index === approvalRequests.length + 1 ? 'swap' : 'balanceOf'),
    ok: result?.status === '0x1',
    errorSelector: String(result?.error?.data || '').slice(0, 10) || null
  }));
  throw new Error(`OOR swap preview failed: ${error.message}; calls=${JSON.stringify(statuses)}`);
}
const swapReceipt = simulatedSwap[approvalRequests.length + 1];
const swapEvent = new Interface([
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)'
]);
let simulatedPrice = null;
for (const entry of swapReceipt.logs || []) {
  try {
    const parsed = swapEvent.parseLog(entry);
    if (String(parsed.args.id).toLowerCase() === pool.id.toLowerCase()) {
      simulatedPrice = { tick: Number(parsed.args.tick), sqrtPriceX96: BigInt(parsed.args.sqrtPriceX96) };
    }
  } catch {}
}
if (!simulatedPrice || simulatedPrice.sqrtPriceX96 <= 0n) {
  throw new Error('Simulated swap did not emit a valid pool price');
}
const projected = swapPlan.tokenIn === 0
  ? { raw0: fundingScope.funding.raw0 - swapPlan.rawAmountIn,
      raw1: fundingScope.funding.raw1 + BigInt(swapPlan.quote.minRawAmountOut) }
  : { raw0: fundingScope.funding.raw0 + BigInt(swapPlan.quote.minRawAmountOut),
      raw1: fundingScope.funding.raw1 - swapPlan.rawAmountIn };
const simulatedPostSwap = {
  raw0: BigInt(erc20.decodeFunctionResult('balanceOf', simulatedSwap.at(-2).returnData)[0]),
  raw1: BigInt(erc20.decodeFunctionResult('balanceOf', simulatedSwap.at(-1).returnData)[0])
};
if (simulatedPostSwap.raw0 - fundingScope.dustRaw.raw0 < projected.raw0
  || simulatedPostSwap.raw1 - fundingScope.dustRaw.raw1 < projected.raw1) {
  throw new Error('Simulated post-swap wallet balances are below conservative minOut inventory');
}
const depositTarget = buildTargetRange(
  simulatedPrice.tick, pool.key.tickSpacing, config.tightWidthBps, config.rangePreset
);
const depositPlan = buildExactDepositPlan({
  rawAmount0: projected.raw0,
  rawAmount1: projected.raw1,
  sqrtPriceX96: simulatedPrice.sqrtPriceX96,
  tickLower: depositTarget.tickLower,
  tickUpper: depositTarget.tickUpper,
  slippageBps: config.depositSlippageBps,
  liquidityReserveBps: config.depositLiquidityReserveBps
});
executor.assertValidDeposit(depositPlan, 'Simulated OOR redeposit plan is invalid');
const fullApprovals = await executor.buildTopUpApprovalRequests(pool, swapPlan, depositPlan);
const depositData = fables.encodeDeposit(pool, depositTarget, depositPlan.liquidity,
  depositPlan.amount0Max, depositPlan.amount1Max, deadline);
const fullSequence = await simulateSequentialCalls(providers.writeProvider, {
  walletAddress: config.walletAddress, chainId: config.chainId,
  calls: [
    ...fullApprovals.map(({ tx }) => ({
      to: tx.to, data: tx.data, value: tx.value || 0n, gasLimit: 300_000
    })),
    ...calls.slice(0, 1),
    { to: swapRequest.router, data: swapRequest.data, value: swapRequest.value, gasLimit: 1_500_000 },
    { to: pool.key.hooks, data: depositData, value: 0n, gasLimit: 1_200_000 }
  ]
});
const depositEvent = executor.findWalletDepositEvent(pool, fullSequence.at(-1));
if (!depositEvent || depositEvent.liquidity <= 0n) {
  throw new Error('Full OOR sequence did not emit a wallet LP deposit');
}
const livePathPreflight = await executor.preflightSamePoolSequence({
  pool, position, guardedData: guardData, preBalances: balances,
  poolState: state, deadline, maxPriceImpactBps: appliedMaxBps
});
if (livePathPreflight.status !== 'full-sequence-simulated') {
  throw new Error('Executor did not select a fully simulated OOR sequence');
}
const feeOverrides = await executor.getPinnedFeeOverrides();
await executor.assertTopUpGasBudget({
  reserveWei: config.topUpMinGasReserveWei,
  maxFeePerGas: feeOverrides.maxFeePerGas || feeOverrides.gasPrice,
  futureGasLimit: BigInt(livePathPreflight.simulatedGasUsed) * 3n / 2n,
  phase: 'read-only-oor-preflight'
});
console.log(JSON.stringify({
  ok: true,
  pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
  tick: state.tick,
  range: [position.tickLower, position.tickUpper],
  simulatedCalls: fullSequence.length,
  quotedPriceImpactBps: swapPlan.priceImpactBps,
  diagnosticPriceImpactCeilingBps: appliedMaxBps,
  livePriceImpactCeilingBps: executor.samePoolRebalanceMaxImpactBps(pool),
  simulatedSwapTick: simulatedPrice.tick,
  newRange: [depositTarget.tickLower, depositTarget.tickUpper],
  mintedLiquidity: depositEvent.liquidity.toString(),
  livePathPreflight,
  gasBudgetOk: true,
  withdrawnRaw: {
    token0: withdrawn.raw0.toString(),
    token1: withdrawn.raw1.toString()
  }
}));
