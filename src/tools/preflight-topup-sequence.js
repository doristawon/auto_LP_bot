// Read-only chain preflight for the single active wallet LP. No StateStore,
// ledger, signer, transaction broadcast, or persistent file mutation.
import fs from 'node:fs';
import path from 'node:path';
import { formatUnits } from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders } from '../rpc/providers.js';
import { FablesAdapter } from '../adapters/fables.js';
import { RebalanceExecutor } from '../adapters/executor.js';
import { buildExactBalancedSwapPlan } from '../execution/exact-rebalance.js';
import { buildPairFundingScope } from '../execution/pair-funding.js';
import { buildExactDepositPlan } from '../math/v4-fixed.js';

loadDotEnv();
const config = loadConfig();
const walletDir = path.join(config.dataDir, 'wallets', config.walletAddress.toLowerCase());
const snapshotFile = fs.existsSync(path.join(walletDir, 'latest-snapshot.json'))
  ? path.join(walletDir, 'latest-snapshot.json')
  : path.join(config.dataDir, 'latest-snapshot.json');
const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
const active = (snapshot.pools || []).flatMap((pool) => (pool.positions || [])
  .filter((position) => BigInt(position.shares || 0) > 0n)
  .map((position) => ({ poolId: pool.id, position })));
if (active.length !== 1) throw new Error('Preflight requires exactly one active LP range');

// Discard the key before constructing any adapter. This command is observation only.
config.privateKey = '';
config.dryRun = true;
config.enableLiveWrites = false;
const providers = createProviders(config);
const fables = new FablesAdapter(providers.readProvider, config);
const pool = (await fables.discoverAllPools()).find((candidate) => candidate.id === active[0].poolId);
if (!pool) throw new Error('Active LP pool is no longer registered');
if (!config.autoTopupSwapEnabled || pool.id !== config.autoTopupSwapPoolId) {
  throw new Error('The active pool is not approved for an automatic top-up swap');
}
const position = active[0].position;
const executor = new RebalanceExecutor(
  providers.readProvider, providers.writeProvider, config, fables,
  { append: () => {} }, () => 1, null
);
const validation = await executor.validateTopUpPosition(pool, position, 'read-only-preflight');
const walletBalances = await executor.readRawPairBalances(pool);
const { funding, dustRaw: dust, stableIndex } = buildPairFundingScope(
  pool, walletBalances, config.usdgAddress, config.autoTopupDustBps
);
const swapPlan = await buildExactBalancedSwapPlan({
  pool,
  quoter: executor.quoter,
  rawAmount0: funding.raw0,
  rawAmount1: funding.raw1,
  sqrtPriceX96: validation.state.sqrtPriceX96,
  tickLower: Number(position.tickLower),
  tickUpper: Number(position.tickUpper),
  slippageBps: config.swapSlippageBps,
  maxPriceImpactBps: config.autoTopupMaxSwapPriceImpactBps,
  preferRemainderTokenIndex: stableIndex,
  preferredRemainderBps: stableIndex === null ? 0 : Math.min(config.autoTopupDustBps, 50)
});
if (swapPlan.direction === 'none') {
  console.log(JSON.stringify({ ok: false, reason: swapPlan.blockedReason || 'already balanced', pair: `${pool.token0.symbol}/${pool.token1.symbol}` }));
  process.exit(1);
}
const projected = swapPlan.tokenIn === 0
  ? { raw0: funding.raw0 - swapPlan.rawAmountIn, raw1: funding.raw1 + BigInt(swapPlan.quote.minRawAmountOut) }
  : { raw0: funding.raw0 + BigInt(swapPlan.quote.minRawAmountOut), raw1: funding.raw1 - swapPlan.rawAmountIn };
const swapApprovals = await executor.buildTopUpApprovalRequests(
  pool, swapPlan, { amount0Max: 0n, amount1Max: 0n }
);
const swapPreview = await executor.simulateTopUpSwapPreview({
  pool, approvalRequests: swapApprovals, swapPlan
});
if (!(position.tickLower <= swapPreview.tick && swapPreview.tick < position.tickUpper)) {
  throw new Error('Simulated swap would move the original LP out of range');
}
if (projected.raw0 + dust.raw0 > swapPreview.balances.raw0
  || projected.raw1 + dust.raw1 > swapPreview.balances.raw1) {
  throw new Error('Simulated post-swap balances are below the conservative minOut inventory');
}
const depositPlan = buildExactDepositPlan({
  rawAmount0: projected.raw0,
  rawAmount1: projected.raw1,
  sqrtPriceX96: swapPreview.sqrtPriceX96,
  tickLower: Number(position.tickLower),
  tickUpper: Number(position.tickUpper),
  slippageBps: config.depositSlippageBps,
  liquidityReserveBps: config.depositLiquidityReserveBps
});
executor.assertValidDeposit(depositPlan, 'Preflight deposit plan is invalid');
const approvals = await executor.buildTopUpApprovalRequests(pool, swapPlan, depositPlan);
let simulation;
try {
  simulation = await executor.simulateTopUpSequence({
    pool, position, approvalRequests: approvals, swapPlan, depositPlan
  });
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    reason: error.message,
    pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
    currentTick: validation.state.tick,
    simulatedSwapTick: swapPreview.tick,
    range: [Number(position.tickLower), Number(position.tickUpper)],
    approvals: approvals.length,
    quotedPriceImpactBps: swapPlan.priceImpactBps
  }));
  process.exit(1);
}
const amount = (raw, token) => formatUnits(BigInt(raw), token.decimals);
let botDryRunStatus = null;
if (process.argv.includes('--exercise-bot-dryrun')) {
  const botDryRun = await executor.topUpPoolPosition({
    pool, position, dustBps: config.autoTopupDustBps
  });
  botDryRunStatus = botDryRun.plan?.swapSimulation?.status || null;
  if (botDryRun.status !== 'dry-run' || botDryRunStatus !== 'full-sequence-simulated') {
    throw new Error('The bot dry-run did not choose the fully simulated swap path');
  }
}
console.log(JSON.stringify({
  ok: true,
  pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
  poolId: pool.id,
  positionId: position.id,
  currentTick: validation.state.tick,
  simulatedSwapTick: swapPreview.tick,
  range: [Number(position.tickLower), Number(position.tickUpper)],
  maximumPriceImpactBps: config.autoTopupMaxSwapPriceImpactBps,
  quotedPriceImpactBps: swapPlan.priceImpactBps,
  swapInput: { token: swapPlan.tokenIn === 0 ? pool.token0.symbol : pool.token1.symbol,
    amount: amount(swapPlan.rawAmountIn, swapPlan.tokenIn === 0 ? pool.token0 : pool.token1) },
  depositCaps: { [pool.token0.symbol]: amount(depositPlan.amount0Max, pool.token0),
    [pool.token1.symbol]: amount(depositPlan.amount1Max, pool.token1) },
  simulatedCalls: simulation.callCount,
  simulatedMintLiquidity: simulation.depositEvent.liquidity.toString(),
  botDryRunStatus
}));
