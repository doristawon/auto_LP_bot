import fs from 'node:fs';
import path from 'node:path';
import { Wallet, formatUnits } from 'ethers';
import { loadDotEnv } from '../src/env.js';
import { loadConfig } from '../src/config.js';
import { createProviders, verifyProviders } from '../src/rpc/providers.js';
import { FablesAdapter, samePoolKey } from '../src/adapters/fables.js';
import { RebalanceExecutor } from '../src/adapters/executor.js';
import { LedgerStore } from '../src/ledger.js';
import { StateStore } from '../src/state.js';
import { buildTargetRange } from '../src/math/ticks.js';
import { buildExactBalancedSwapPlan } from '../src/execution/exact-rebalance.js';
import { buildExactDepositPlan } from '../src/math/v4-fixed.js';
import { simulateSequentialCalls } from '../src/execution/sequential-simulation.js';
import { registerSensitiveValues } from '../src/logger.js';

const POOL_ID = '0x6b187fad6ca2dcb913f2451c5d5e24d3d77b9d09ce272c2c99f64dac672bc485';
const MAX_IMPACT_BPS = 500;
const DUST_BPS = 25n;
const execute = process.argv.includes('--execute');

loadDotEnv();
const config = loadConfig();
registerSensitiveValues([config.privateKey || '', ...config.rpcUrls]);
if (config.chainId !== 4663 || config.dryRun || !config.enableLiveWrites) {
  throw new Error('Live Robinhood Chain configuration is required');
}
if (!config.privateKey || new Wallet(config.privateKey).address.toLowerCase() !== config.walletAddress.toLowerCase()) {
  throw new Error('Wallet signer does not match');
}
const walletDir = path.join(config.dataDir, 'wallets', config.walletAddress.toLowerCase());
const statePath = path.join(walletDir, 'bot-state.json');
if (!fs.existsSync(statePath)) throw new Error('Active wallet state is missing');
const state = new StateStore(statePath);
if (String(state.getSetting('selectedExecutionTargetPoolId', '')).toLowerCase() !== POOL_ID
  || String(state.getSetting('investmentTargetPoolId', '')).toLowerCase() !== POOL_ID) {
  throw new Error('Saved execution and investment targets must both be USDG/MOO');
}
if (state.getSetting('activeRebalanceExecution', null)) {
  throw new Error('An unfinished execution journal requires review');
}
if (execute) {
  if (state.getSetting('executionPaused') !== true) throw new Error('Pause automatic execution first');
  try {
    const response = await fetch(`http://127.0.0.1:${config.dashboardPort}/api/health`, {
      signal: AbortSignal.timeout(3_000)
    });
    if (response) throw new Error('Stop the dashboard supervisor before exclusive wallet execution');
  } catch (error) {
    if (error.message === 'Stop the dashboard supervisor before exclusive wallet execution') throw error;
    if (error.cause?.code !== 'ECONNREFUSED') throw error;
  }
}

const checked = await verifyProviders(createProviders(config).rawProviders, config.chainId);
const healthyUrls = checked.filter((item) => item.ok).map((item) => config.rpcUrls[item.index]);
const runtimeConfig = { ...config, rpcUrls: healthyUrls };
const providers = createProviders(runtimeConfig);
const fables = new FablesAdapter(providers.readProvider, runtimeConfig);
const pool = (await fables.discoverAllPools()).find((item) => item.id === POOL_ID);
if (!pool || pool.token0.symbol !== 'USDG' || pool.token1.symbol !== 'MOO') {
  throw new Error('USDG/MOO pool identity changed');
}
const ledger = execute ? new LedgerStore(walletDir) : null;
const executor = new RebalanceExecutor(providers.readProvider, providers.writeProvider,
  runtimeConfig, fables, ledger, null, execute ? state : null);

async function assertNoMooPosition() {
  const block = await providers.readProvider.getBlockNumber();
  const found = await fables.discoverPositions(pool, runtimeConfig.walletPoolDiscoveryFromBlock, block);
  if (found.positions.some((position) => BigInt(position.shares || 0n) > 0n)) {
    throw new Error('Wallet already has an active USDG/MOO LP');
  }
}

async function preflight(amountRaw, expectedBalances = null) {
  const [poolState, balances] = await Promise.all([
    fables.readPoolState(pool), executor.readRawPairBalances(pool)
  ]);
  if (poolState.paused !== false || BigInt(poolState.liquidity || 0n) <= 0n) {
    throw new Error('USDG/MOO pool is paused or has no liquidity');
  }
  if (expectedBalances && (balances.raw0 !== expectedBalances.raw0 || balances.raw1 !== expectedBalances.raw1)) {
    throw new Error('Wallet balances changed during approvals; restart from a fresh quote');
  }
  if (balances.raw1 !== 0n) throw new Error('MOO wallet balance changed; replan before executing');
  if (amountRaw <= 0n || amountRaw > balances.raw0) throw new Error('USDG balance is insufficient');
  const dustRaw = balances.raw0 - amountRaw;
  const initialTarget = buildTargetRange(poolState.tick, pool.key.tickSpacing,
    runtimeConfig.tightWidthBps, runtimeConfig.rangePreset);
  const swap = await buildExactBalancedSwapPlan({
    pool, quoter: executor.quoter, rawAmount0: amountRaw, rawAmount1: balances.raw1,
    sqrtPriceX96: poolState.sqrtPriceX96, tickLower: initialTarget.tickLower,
    tickUpper: initialTarget.tickUpper, slippageBps: runtimeConfig.swapSlippageBps,
    maxPriceImpactBps: MAX_IMPACT_BPS, preferRemainderTokenIndex: 0,
    preferredRemainderBps: Number(DUST_BPS)
  });
  if (swap.direction !== '0_to_1' || !swap.quote || swap.blockedReason) {
    throw new Error('USDG-to-MOO balancing quote is unavailable within the 5% limit');
  }
  const swapApprovals = await executor.buildTopUpApprovalRequests(pool, swap,
    { amount0Max: 0n, amount1Max: 0n });
  const postSwap = await executor.simulateTopUpSwapPreview({ pool,
    approvalRequests: swapApprovals, swapPlan: swap });
  const target = buildTargetRange(postSwap.tick, pool.key.tickSpacing,
    runtimeConfig.tightWidthBps, runtimeConfig.rangePreset);
  const projected = { raw0: amountRaw - swap.rawAmountIn,
    raw1: balances.raw1 + BigInt(swap.quote.minRawAmountOut) };
  if (postSwap.balances.raw0 < projected.raw0 + dustRaw
    || postSwap.balances.raw1 < projected.raw1) {
    throw new Error('Simulated wallet balances are below the quoted minimum');
  }
  const deposit = buildExactDepositPlan({
    rawAmount0: projected.raw0, rawAmount1: projected.raw1,
    sqrtPriceX96: postSwap.sqrtPriceX96, tickLower: target.tickLower,
    tickUpper: target.tickUpper, slippageBps: runtimeConfig.depositSlippageBps,
    liquidityReserveBps: runtimeConfig.depositLiquidityReserveBps
  });
  executor.assertValidDeposit(deposit, 'USDG/MOO deposit plan is invalid');
  const approvals = await executor.buildTopUpApprovalRequests(pool, swap, deposit);
  const request = executor.router.buildV4ExactInputSingle({ pool, quote: swap.quote,
    deadline: executor.deadline() });
  const depositData = fables.encodeDeposit(pool, target, deposit.liquidity,
    deposit.amount0Max, deposit.amount1Max, executor.deadline());
  const results = await simulateSequentialCalls(providers.writeProvider, {
    walletAddress: runtimeConfig.walletAddress, chainId: runtimeConfig.chainId,
    calls: [
      ...approvals.map(({ tx }) => ({ to: tx.to, data: tx.data,
        value: tx.value || 0n, gasLimit: 300_000 })),
      { to: request.router, data: request.data, value: request.value, gasLimit: 1_500_000 },
      { to: pool.key.hooks, data: depositData, value: 0n, gasLimit: 1_200_000 }
    ]
  });
  const minted = executor.findWalletDepositEvent(pool, results.at(-1));
  if (!minted || minted.liquidity <= 0n) throw new Error('Full sequence did not mint a USDG/MOO LP');
  return { balances, dustRaw, swap, target, deposit, approvals, request,
    simulatedGasUsed: results.reduce((sum, item) => sum + BigInt(item.gasUsed || 0n), 0n) };
}

await assertNoMooPosition();
const initialBalances = await executor.readRawPairBalances(pool);
const amountRaw = initialBalances.raw0 - initialBalances.raw0 * DUST_BPS / 10_000n;
const initial = await preflight(amountRaw, initialBalances);
console.log(JSON.stringify({ mode: execute ? 'execute' : 'preview',
  usdgBalance: formatUnits(initialBalances.raw0, pool.token0.decimals),
  spendUsdg: formatUnits(amountRaw, pool.token0.decimals),
  reservedUsdg: formatUnits(initial.dustRaw, pool.token0.decimals),
  swapUsdg: formatUnits(initial.swap.rawAmountIn, pool.token0.decimals),
  minimumMoo: formatUnits(initial.swap.quote.minRawAmountOut, pool.token1.decimals),
  swapImpactPct: initial.swap.priceImpactBps / 100,
  tightRange: [initial.target.tickLower, initial.target.tickUpper],
  simulatedLiquidity: initial.deposit.liquidity.toString(),
  simulatedGasUsed: initial.simulatedGasUsed.toString(),
  approvalCalls: initial.approvals.length }));
if (!execute) process.exit(0);

executor.assertNoUnfinishedExecution();
await executor.assertGasGuard();
const feeOverrides = await executor.getPinnedFeeOverrides();
const feeCap = BigInt(feeOverrides.maxFeePerGas || feeOverrides.gasPrice || 0n);
await executor.assertTopUpGasBudget({
  reserveWei: runtimeConfig.topUpMinGasReserveWei, maxFeePerGas: feeCap,
  futureGasLimit: BigInt(initial.approvals.length) * 300_000n + 2_700_000n,
  phase: 'idle-moo-full-sequence'
});
let phase = 'prepared';
let journal = { id: `idle-moo:${Date.now()}`, kind: 'wallet_idle_deposit', phase,
  startedAt: Date.now(), poolId: POOL_ID, amountRaw: amountRaw.toString(), tx: { approvals: [] } };
const save = (patch) => {
  journal = { ...journal, ...patch, updatedAt: Date.now() };
  state.setSetting('activeRebalanceExecution', journal);
};
save({});
try {
  let approved = initial;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const request of approved.approvals) {
      const receipt = await executor.sendVerifiedTx({ label: request.label,
        to: request.tx.to, data: request.tx.data, value: request.tx.value || 0n,
        feeOverrides });
      save({ phase: 'approvals_ready', tx: { ...journal.tx,
        approvals: [...journal.tx.approvals, receipt.hash] } });
    }
    approved = await preflight(amountRaw, initialBalances);
    if (!approved.approvals.length) break;
    if (attempt === 2) throw new Error('Approvals kept changing before the swap');
  }
  await assertNoMooPosition();
  await executor.assertGasGuard(feeOverrides);
  const fresh = await preflight(amountRaw, initialBalances);
  if (fresh.approvals.length) throw new Error('Fresh preflight requires new approvals');
  await executor.assertTopUpGasBudget({
    reserveWei: runtimeConfig.topUpMinGasReserveWei, maxFeePerGas: feeCap,
    futureGasLimit: 2_700_000n, phase: 'idle-moo-before-swap'
  });
  save({ phase: 'swap_preflighted', target: fresh.target,
    swapAmountRaw: fresh.swap.rawAmountIn.toString() });
  const swapReceipt = await executor.sendVerifiedTx({ label: 'idleMooBalanceSwap',
    to: fresh.request.router, data: fresh.request.data, value: fresh.request.value,
    feeOverrides, onSent: (hash) => { phase = 'swap_sent'; save({ phase,
      tx: { ...journal.tx, swap: hash } }); } });
  phase = 'swap_confirmed';
  save({ phase, tx: { ...journal.tx, swap: swapReceipt.hash } });
  const afterSwap = await executor.readRawPairBalances(pool);
  executor.assertSwapReceiptBalances(pool, fresh.swap, initialBalances, afterSwap);
  if (afterSwap.raw0 < initial.dustRaw || afterSwap.raw1 <= 0n) {
    throw new Error('Post-swap balances cannot fund the USDG/MOO deposit');
  }
  let latest = await fables.readPoolState(pool);
  if (latest.paused !== false) throw new Error('USDG/MOO pool paused after swap');
  let target = buildTargetRange(latest.tick, pool.key.tickSpacing,
    runtimeConfig.tightWidthBps, runtimeConfig.rangePreset);
  let deposit = buildExactDepositPlan({ rawAmount0: afterSwap.raw0 - initial.dustRaw,
    rawAmount1: afterSwap.raw1, sqrtPriceX96: latest.sqrtPriceX96,
    tickLower: target.tickLower, tickUpper: target.tickUpper,
    slippageBps: runtimeConfig.depositSlippageBps,
    liquidityReserveBps: runtimeConfig.depositLiquidityReserveBps });
  await executor.ensureHookAllowance(pool.token0, pool.key.hooks, deposit.amount0Max);
  await executor.ensureHookAllowance(pool.token1, pool.key.hooks, deposit.amount1Max);
  latest = await fables.readPoolState(pool);
  if (latest.paused !== false) throw new Error('USDG/MOO pool paused before deposit');
  target = buildTargetRange(latest.tick, pool.key.tickSpacing,
    runtimeConfig.tightWidthBps, runtimeConfig.rangePreset);
  deposit = buildExactDepositPlan({ rawAmount0: afterSwap.raw0 - initial.dustRaw,
    rawAmount1: afterSwap.raw1, sqrtPriceX96: latest.sqrtPriceX96,
    tickLower: target.tickLower, tickUpper: target.tickUpper,
    slippageBps: runtimeConfig.depositSlippageBps,
    liquidityReserveBps: runtimeConfig.depositLiquidityReserveBps });
  const depositData = fables.encodeDeposit(pool, target, deposit.liquidity,
    deposit.amount0Max, deposit.amount1Max, executor.deadline());
  await providers.readProvider.call({ from: runtimeConfig.walletAddress,
    to: pool.key.hooks, data: depositData, value: 0n });
  save({ phase: 'deposit_preflighted', target });
  const depositReceipt = await executor.sendVerifiedTx({ label: 'idleMooTightDeposit',
    to: pool.key.hooks, data: depositData, value: 0n, feeOverrides,
    onSent: (hash) => { phase = 'deposit_sent'; save({ phase,
      tx: { ...journal.tx, deposit: hash } }); } });
  phase = 'deposit_confirmed';
  save({ phase, tx: { ...journal.tx, deposit: depositReceipt.hash } });
  const event = executor.findWalletDepositEvent(pool, depositReceipt);
  if (!event || event.liquidity <= 0n) throw new Error('Deposit receipt has no wallet LP event');
  const minted = await fables.readRangeKey(pool, event.rangeId);
  if (!minted.exists || !samePoolKey(minted.key, pool.key)
    || Number(minted.tickLower) !== target.tickLower
    || Number(minted.tickUpper) !== target.tickUpper) {
    throw new Error('Minted LP is not the requested USDG/MOO Tight range');
  }
  const shares = await executor.readPositionShares(pool, event.rangeId);
  if (shares <= 0n) throw new Error('Deposit confirmed without positive LP shares');
  ledger.append('lp.idle_moo_deployed', { poolId: POOL_ID, pair: 'USDG/MOO',
    positionId: event.rangeId, tickLower: target.tickLower, tickUpper: target.tickUpper,
    swapHash: swapReceipt.hash, depositHash: depositReceipt.hash,
    shares: shares.toString(), spentUsdg: formatUnits(amountRaw, pool.token0.decimals) });
  state.setSetting('activeRebalanceExecution', null);
  console.log(JSON.stringify({ ok: true, pool: 'USDG/MOO', range: target,
    positionId: event.rangeId, shares: shares.toString(),
    swapHash: swapReceipt.hash, depositHash: depositReceipt.hash,
    usdgRemaining: formatUnits((await executor.readRawPairBalances(pool)).raw0, pool.token0.decimals) }));
} catch (error) {
  if (['swap_sent', 'swap_confirmed', 'deposit_sent', 'deposit_confirmed'].includes(phase)) {
    save({ phase: 'recovery_required', reason: String(error.message || error) });
    ledger.append('lp.idle_moo_recovery_required', journal);
  } else {
    state.setSetting('activeRebalanceExecution', null);
  }
  throw error;
}
