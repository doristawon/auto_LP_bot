import fs from 'node:fs';
import path from 'node:path';
import { Wallet, formatEther, formatUnits } from 'ethers';
import { loadDotEnv } from '../src/env.js';
import { loadConfig } from '../src/config.js';
import { createProviders, verifyProviders } from '../src/rpc/providers.js';
import { FablesAdapter, samePoolKey } from '../src/adapters/fables.js';
import { RebalanceExecutor } from '../src/adapters/executor.js';
import { V4QuoterAdapter } from '../src/adapters/quoter.js';
import { LedgerStore } from '../src/ledger.js';
import { StateStore } from '../src/state.js';
import { rangeAmounts, spotToken1PerToken0 } from '../src/analytics/liquidity.js';
import { buildExactBalancedSwapPlan } from '../src/execution/exact-rebalance.js';
import { buildExactDepositPlan } from '../src/math/v4-fixed.js';
import { ZERO_ADDRESS } from '../src/constants.js';
import { log, registerSensitiveValues } from '../src/logger.js';

const POOL_ID = '0x6b187fad6ca2dcb913f2451c5d5e24d3d77b9d09ce272c2c99f64dac672bc485';
const TARGET_USD = 300;
const MAX_SWAP_DISCOUNT_PCT = 2;
const execute = process.argv.includes('--execute');

async function main() {
  loadDotEnv();
  const config = loadConfig();
  registerSensitiveValues([config.privateKey || '', ...config.rpcUrls]);
  if (config.chainId !== 4663 || config.dryRun || !config.enableLiveWrites) throw new Error('Live Robinhood Chain configuration required');
  if (!config.privateKey || new Wallet(config.privateKey).address.toLowerCase() !== config.walletAddress.toLowerCase()) {
    throw new Error('Signer mismatch');
  }
  const walletDir = path.join(config.dataDir, 'wallets', config.walletAddress.toLowerCase());
  if (!fs.existsSync(path.join(walletDir, 'bot-state.json'))) throw new Error('Active wallet state directory missing');
  const state = new StateStore(path.join(walletDir, 'bot-state.json'));
  if (String(state.getSetting('selectedExecutionTargetPoolId', '')).toLowerCase() !== POOL_ID) {
    throw new Error('MOO/USDG is not the selected execution target');
  }
  const active = state.getSetting('activeRebalanceExecution', null);
  if (active?.phase && !['completed', 'failed'].includes(active.phase)) throw new Error('Unfinished execution requires recovery');

  const providers = createProviders(config);
  await verifyProviders(providers.rawProviders, config.chainId);
  const fables = new FablesAdapter(providers.readProvider, config);
  const pools = await fables.discoverAllPools();
  const pool = pools.find((entry) => entry.id === POOL_ID);
  if (!pool || pool.token0.symbol !== 'USDG' || pool.token1.symbol !== 'MOO') throw new Error('MOO/USDG pool identity changed');
  pool.state = await fables.readPoolState(pool);
  if (pool.state.paused) throw new Error('Fables pool is paused');
  const currentBlock = await providers.readProvider.getBlockNumber();
  const known = await fables.discoverPositions(pool, config.walletPoolDiscoveryFromBlock, currentBlock);
  if (known.positions.length !== 1) throw new Error(`Expected exactly one active MOO/USDG position, found ${known.positions.length}`);
  const position = known.positions[0];
  if (!(position.tickLower < pool.state.tick && pool.state.tick < position.tickUpper)) {
    throw new Error('Existing LP is not strictly in range; top-up aborted');
  }
  const range = { tickLower: position.tickLower, tickUpper: position.tickUpper };
  const readExecutor = new RebalanceExecutor(providers.readProvider, providers.writeProvider, config, fables, null, null);
  const balances = await readExecutor.readRawPairBalances(pool);
  const gasBalance = await providers.readProvider.getBalance(config.walletAddress);
  if (gasBalance < 200_000_000_000_000n) throw new Error('Less than 0.0002 ETH remains for gas');
  if (balances.raw0 <= 0n && balances.raw1 <= 0n) throw new Error('No wallet inventory available for top-up');

  const spot1Per0 = spotToken1PerToken0(pool.state.sqrtPriceX96, pool.token0.decimals, pool.token1.decimals);
  if (!(spot1Per0 > 0)) throw new Error('Invalid pool spot price');
  const currentAmounts = rangeAmounts(position.shares, pool.state.sqrtPriceX96,
    range.tickLower, range.tickUpper, pool.token0.decimals, pool.token1.decimals);
  const walletUSDG = Number(formatUnits(balances.raw0, pool.token0.decimals));
  const walletMOO = Number(formatUnits(balances.raw1, pool.token1.decimals));
  const existingLpUsd = currentAmounts.amount0 + currentAmounts.amount1 / spot1Per0;
  const totalBeforeUsd = existingLpUsd + walletUSDG + walletMOO / spot1Per0;
  if (totalBeforeUsd > TARGET_USD + 0.5) {
    throw new Error(`Existing LP plus wallet inventory exceeds ${TARGET_USD} USD target; refusing to sweep all funds`);
  }
  const quoter = new V4QuoterAdapter(providers.readProvider);
  const previewSwap = await buildExactBalancedSwapPlan({ pool, quoter,
    rawAmount0: balances.raw0, rawAmount1: balances.raw1,
    sqrtPriceX96: pool.state.sqrtPriceX96, ...range, slippageBps: config.swapSlippageBps });
  if (!previewSwap.quote) throw new Error('Balance quote unavailable');
  const quoteOut = BigInt(previewSwap.quote.rawAmountOut);
  const spotOut = previewSwap.tokenIn === 0
    ? Number(formatUnits(previewSwap.rawAmountIn, pool.token0.decimals)) * spot1Per0
    : Number(formatUnits(previewSwap.rawAmountIn, pool.token1.decimals)) / spot1Per0;
  const priceImpactPct = spotOut > 0 ? (spotOut - previewSwap.quote.amountOut) / spotOut * 100 : Infinity;
  const previewDeposit = buildExactDepositPlan({
    rawAmount0: previewSwap.tokenIn === 0 ? balances.raw0 - previewSwap.rawAmountIn : balances.raw0 + BigInt(previewSwap.quote.minRawAmountOut),
    rawAmount1: previewSwap.tokenIn === 1 ? balances.raw1 - previewSwap.rawAmountIn : balances.raw1 + BigInt(previewSwap.quote.minRawAmountOut),
    sqrtPriceX96: pool.state.sqrtPriceX96, ...range,
    slippageBps: config.depositSlippageBps, liquidityReserveBps: config.depositLiquidityReserveBps });
  const preview = {
    targetUsd: TARGET_USD, estimatedTotalBeforeUsd: totalBeforeUsd, existingLpUsd,
    walletUSDG, walletMOO, gasEth: Number(formatEther(gasBalance)),
    block: currentBlock, tick: pool.state.tick, range: [range.tickLower, range.tickUpper],
    existingPositionId: position.id, existingShares: position.shares.toString(),
    swapDirection: previewSwap.direction, swapAmountIn: previewSwap.quote.amountIn,
    swapSymbolIn: previewSwap.quote.symbolIn, quoteAmountOut: previewSwap.quote.amountOut,
    quoteSymbolOut: previewSwap.quote.symbolOut, minAmountOut: previewSwap.quote.minAmountOut,
    priceImpactPct, projectedAddedShares: previewDeposit.liquidity.toString(), execute
  };
  console.log(JSON.stringify(preview));
  if (priceImpactPct > MAX_SWAP_DISCOUNT_PCT) throw new Error(`Swap quote is ${priceImpactPct.toFixed(2)}% below pool spot; top-up aborted`);
  if (!execute) return;

  // State files are read-modify-write JSON. Keep the supervisor offline during
  // execution so another bot process cannot overwrite the recovery journal.
  if (state.getSetting('executionPaused') !== true) throw new Error('Pause automatic execution before top-up');
  try {
    const response = await fetch(`http://127.0.0.1:${config.dashboardPort}/api/health`, {
      headers: { 'x-dashboard-token': config.dashboardToken }, signal: AbortSignal.timeout(3000)
    });
    if (response.ok) throw new Error('Stop dashboard supervisor before exclusive top-up');
  } catch (error) {
    if (error.message === 'Stop dashboard supervisor before exclusive top-up') throw error;
  }
  const ledger = new LedgerStore(walletDir);
  const lastSnapshot = ledger.readSnapshot();
  const executor = new RebalanceExecutor(providers.readProvider, providers.writeProvider,
    config, fables, ledger, (address) => Number(lastSnapshot?.prices?.[String(address).toLowerCase()] || 0), state);
  executor.assertNoUnfinishedExecution();
  await executor.assertAtomicGuardReady();
  await executor.assertGasGuard();
  let phase = 'prepared';
  let journal = { id: `topup:${Date.now()}:${position.id}`, phase, startedAt: Date.now(),
    poolId: POOL_ID, positionId: position.id, targetUsd: TARGET_USD,
    initialBalances: { usdg: balances.raw0.toString(), moo: balances.raw1.toString() }, tx: {} };
  const save = (patch) => {
    journal = { ...journal, ...patch, updatedAt: Date.now() };
    state.setSetting('activeRebalanceExecution', journal);
  };
  save({});
  try {
    await executor.ensureSwapAllowances(pool.token0, balances.raw0);
    await executor.ensureSwapAllowances(pool.token1, balances.raw1);
    await executor.ensureHookAllowance(pool.token0, pool.key.hooks, balances.raw0 + (previewSwap.tokenOut === 0 ? quoteOut : 0n));
    await executor.ensureHookAllowance(pool.token1, pool.key.hooks, balances.raw1 + (previewSwap.tokenOut === 1 ? quoteOut : 0n));
    save({ phase: 'approvals_ready' });

    const before = await executor.readRawPairBalances(pool);
    if (before.raw0 !== balances.raw0 || before.raw1 !== balances.raw1) throw new Error('Wallet inventory changed during approvals');
    if (await executor.readPositionShares(pool, position.id) !== position.shares) throw new Error('LP shares changed during approvals');
    pool.state = await fables.readPoolState(pool);
    if (pool.state.paused || !(range.tickLower < pool.state.tick && pool.state.tick < range.tickUpper)) {
      throw new Error('LP left its original range before swap');
    }
    const swap = await buildExactBalancedSwapPlan({ pool, quoter: executor.quoter,
      rawAmount0: before.raw0, rawAmount1: before.raw1,
      sqrtPriceX96: pool.state.sqrtPriceX96, ...range, slippageBps: config.swapSlippageBps });
    if (!swap.quote) throw new Error('Fresh balance quote unavailable');
    const freshSpot = spotToken1PerToken0(pool.state.sqrtPriceX96, pool.token0.decimals, pool.token1.decimals);
    const freshSpotOut = swap.tokenIn === 0
      ? Number(formatUnits(swap.rawAmountIn, pool.token0.decimals)) * freshSpot
      : Number(formatUnits(swap.rawAmountIn, pool.token1.decimals)) / freshSpot;
    const freshImpactPct = (freshSpotOut - swap.quote.amountOut) / freshSpotOut * 100;
    if (freshImpactPct > MAX_SWAP_DISCOUNT_PCT) throw new Error(`Fresh swap quote is ${freshImpactPct.toFixed(2)}% below pool spot`);
    const deadline = executor.deadline();
    const request = executor.router.buildV4ExactInputSingle({ pool, quote: swap.quote, deadline });
    await executor.router.simulateV4ExactInputSingle({ pool, quote: swap.quote, deadline, from: config.walletAddress });
    save({ phase: 'swap_preflighted', tick: pool.state.tick,
      swapDirection: swap.direction, swapAmountIn: swap.rawAmountIn.toString() });
    const swapReceipt = await executor.sendVerifiedTx({ label: 'topupV4Swap',
      to: request.router, data: request.data, value: request.value,
      onSent: (hash) => { phase = 'swap_sent'; save({ phase, tx: { ...journal.tx, swap: hash } }); } });
    phase = 'swap_confirmed';
    const afterSwap = await executor.readRawPairBalances(pool);
    executor.assertSwapReceiptBalances(pool, swap, before, afterSwap);
    save({ phase, tx: { ...journal.tx, swap: swapReceipt.hash },
      postSwapBalances: { usdg: afterSwap.raw0.toString(), moo: afterSwap.raw1.toString() } });

    pool.state = await fables.readPoolState(pool);
    if (pool.state.paused || !(range.tickLower < pool.state.tick && pool.state.tick < range.tickUpper)) {
      throw new Error('LP left its original range before deposit');
    }
    let deposit = buildExactDepositPlan({ rawAmount0: afterSwap.raw0,
      rawAmount1: afterSwap.raw1, sqrtPriceX96: pool.state.sqrtPriceX96, ...range,
      slippageBps: config.depositSlippageBps, liquidityReserveBps: config.depositLiquidityReserveBps });
    await executor.ensureHookAllowance(pool.token0, pool.key.hooks, deposit.amount0Max);
    await executor.ensureHookAllowance(pool.token1, pool.key.hooks, deposit.amount1Max);
    pool.state = await fables.readPoolState(pool);
    if (pool.state.paused || !(range.tickLower < pool.state.tick && pool.state.tick < range.tickUpper)) {
      throw new Error('LP left its original range during deposit preflight');
    }
    deposit = buildExactDepositPlan({ rawAmount0: afterSwap.raw0,
      rawAmount1: afterSwap.raw1, sqrtPriceX96: pool.state.sqrtPriceX96, ...range,
      slippageBps: config.depositSlippageBps, liquidityReserveBps: config.depositLiquidityReserveBps });
    const depositData = fables.encodeDeposit(pool, range, deposit.liquidity,
      deposit.amount0Max, deposit.amount1Max, executor.deadline());
    await providers.readProvider.call({ from: config.walletAddress, to: pool.key.hooks, data: depositData, value: 0n });
    save({ phase: 'deposit_preflighted', tick: pool.state.tick,
      addedShares: deposit.liquidity.toString() });
    const receipt = await executor.sendVerifiedTx({ label: 'topupFablesDeposit',
      to: pool.key.hooks, data: depositData, value: 0n,
      onSent: (hash) => { phase = 'deposit_sent'; save({ phase, tx: { ...journal.tx, deposit: hash } }); } });
    phase = 'deposit_confirmed';
    save({ phase, tx: { ...journal.tx, deposit: receipt.hash } });
    const event = executor.findWalletDepositEvent(pool, receipt);
    if (!event || event.rangeId.toLowerCase() !== position.id.toLowerCase()) throw new Error('Deposit did not increase the existing range ID');
    const rangeKey = await fables.readRangeKey(pool, event.rangeId);
    if (!rangeKey.exists || !samePoolKey(rangeKey.key, pool.key)
        || Number(rangeKey.tickLower) !== range.tickLower || Number(rangeKey.tickUpper) !== range.tickUpper) {
      throw new Error('Deposit receipt points to unexpected pool/range');
    }
    const sharesAfter = await executor.readPositionShares(pool, position.id);
    if (sharesAfter <= position.shares) throw new Error('Deposit confirmed without increased LP shares');
    const finalBalances = await executor.readRawPairBalances(pool);
    ledger.append('lp.topup', { poolId: POOL_ID, pair: 'USDG/MOO', positionId: position.id,
      tickLower: range.tickLower, tickUpper: range.tickUpper, targetUsd: TARGET_USD,
      swapHash: swapReceipt.hash, depositHash: receipt.hash,
      sharesBefore: position.shares.toString(), sharesAfter: sharesAfter.toString(),
      usdgBefore: formatUnits(before.raw0, pool.token0.decimals),
      usdgRemaining: formatUnits(finalBalances.raw0, pool.token0.decimals),
      mooBefore: formatUnits(before.raw1, pool.token1.decimals),
      mooRemaining: formatUnits(finalBalances.raw1, pool.token1.decimals) });
    state.setSetting('activeRebalanceExecution', null);
    console.log(JSON.stringify({ ok: true, positionId: position.id,
      swapHash: swapReceipt.hash, depositHash: receipt.hash,
      sharesBefore: position.shares.toString(), sharesAfter: sharesAfter.toString(),
      usdgRemaining: formatUnits(finalBalances.raw0, pool.token0.decimals),
      mooRemaining: formatUnits(finalBalances.raw1, pool.token1.decimals) }));
  } catch (error) {
    if (['swap_sent', 'swap_confirmed', 'deposit_sent', 'deposit_confirmed'].includes(phase)) {
      save({ phase: 'recovery_required', reason: String(error.message || error) });
      ledger.append('lp.topup_recovery_required', journal);
    } else {
      state.setSetting('activeRebalanceExecution', null);
    }
    throw error;
  }
}

main().catch((error) => {
  log('error', 'lp.topup_failed', { error: String(error.message || error) });
  process.exitCode = 1;
});
