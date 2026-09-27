import { Wallet, formatUnits, parseUnits } from 'ethers';
import { loadDotEnv } from '../src/env.js';
import { loadConfig } from '../src/config.js';
import { AutoLpBot } from '../src/bot.js';
import { buildTargetRange } from '../src/math/ticks.js';
import { buildExactBalancedSwapPlan } from '../src/execution/exact-rebalance.js';
import { buildExactDepositPlan } from '../src/math/v4-fixed.js';
import { samePoolKey } from '../src/adapters/fables.js';
import { log } from '../src/logger.js';

const MOO_USDG_POOL_ID = '0x6b187fad6ca2dcb913f2451c5d5e24d3d77b9d09ce272c2c99f64dac672bc485';
const amountArg = process.argv.find((arg) => arg.startsWith('--amount-usdg='));
const amountText = amountArg?.slice('--amount-usdg='.length) || '';
const execute = process.argv.includes('--execute');
if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amountText) || Number(amountText) <= 0) {
  throw new Error('Provide --amount-usdg=<positive amount, at most six decimal places>');
}

loadDotEnv();
const config = loadConfig();
const bot = new AutoLpBot(config);
const provider = bot.providers.readProvider;
const executor = bot.executor;
const wallet = new Wallet(config.privateKey || '0x' + '0'.repeat(64));
if (wallet.address.toLowerCase() !== config.walletAddress.toLowerCase()) throw new Error('Signer mismatch');
if (config.chainId !== 4663) throw new Error('Wrong chain');
if (bot.getSelectedExecutionTargetPoolId() !== MOO_USDG_POOL_ID) throw new Error('MOO/USDG is not the selected execution target');
if (!bot.executionPaused || bot.state.getSetting('executionPaused') !== true) throw new Error('Pause the dashboard before bootstrap');
executor.assertNoUnfinishedExecution();

const entries = await bot.fables.discoverAllPools();
const pool = entries.find((entry) => entry.id === MOO_USDG_POOL_ID);
if (!pool || ![pool.token0.symbol, pool.token1.symbol].includes('USDG') || ![pool.token0.symbol, pool.token1.symbol].includes('MOO')) {
  throw new Error('MOO/USDG pool identity changed');
}
if (pool.token0.symbol !== 'USDG') throw new Error('Expected USDG as token0');
pool.state = await bot.fables.readPoolState(pool);
if (pool.state.paused) throw new Error('Fables pool is paused');
const currentBlock = await provider.getBlockNumber();
const known = await bot.fables.discoverPositions(pool, config.walletPoolDiscoveryFromBlock, currentBlock);
if (known.positions.length) throw new Error('Wallet already holds MOO/USDG LP; bootstrap must not duplicate it');
const pre = await executor.readRawPairBalances(pool);
const amountRaw = parseUnits(amountText, pool.token0.decimals);
if (amountRaw > pre.raw0) throw new Error('Insufficient USDG balance');
const gasBalance = await provider.getBalance(config.walletAddress);
if (gasBalance < parseUnits('0.0002', 18)) throw new Error('Insufficient ETH reserve for bootstrap transactions');
const range = buildTargetRange(pool.state.tick, pool.key.tickSpacing, config.tightWidthBps, config.rangePreset);
const estimate = await buildExactBalancedSwapPlan({
  pool,
  quoter: executor.quoter,
  rawAmount0: amountRaw,
  rawAmount1: 0n,
  sqrtPriceX96: pool.state.sqrtPriceX96,
  tickLower: range.tickLower,
  tickUpper: range.tickUpper,
  slippageBps: config.swapSlippageBps
});
if (estimate.direction !== '0_to_1' || !estimate.quote) throw new Error('USDG-to-MOO balancing quote unavailable');
const projectedDeposit = buildExactDepositPlan({
  rawAmount0: amountRaw - estimate.rawAmountIn,
  rawAmount1: BigInt(estimate.quote.minRawAmountOut),
  sqrtPriceX96: pool.state.sqrtPriceX96,
  tickLower: range.tickLower,
  tickUpper: range.tickUpper,
  slippageBps: config.depositSlippageBps,
  liquidityReserveBps: config.depositLiquidityReserveBps
});
const preview = {
  poolId: pool.id,
  wallet: config.walletAddress,
  amountUSDG: amountText,
  block: currentBlock,
  tick: pool.state.tick,
  range: [range.tickLower, range.tickUpper],
  swapUSDG: formatUnits(estimate.rawAmountIn, pool.token0.decimals),
  minimumMOO: formatUnits(BigInt(estimate.quote.minRawAmountOut), pool.token1.decimals),
  projectedLiquidity: projectedDeposit.liquidity.toString(),
  execute
};
console.log(JSON.stringify(preview));
if (!execute) process.exit(0);

await executor.assertAtomicGuardReady();
await executor.assertGasGuard();
let phase = 'preparing';
let journal = { id: `bootstrap:${Date.now()}`, phase, poolId: pool.id, amountUSDG: amountText, tx: {} };
const save = (patch) => {
  journal = { ...journal, ...patch, updatedAt: Date.now() };
  bot.state.setSetting('activeRebalanceExecution', journal);
};
save({});
try {
  await executor.ensureSwapAllowances(pool.token0, amountRaw);
  await executor.ensureHookAllowance(pool.token0, pool.key.hooks, amountRaw);
  pool.state = await bot.fables.readPoolState(pool);
  if (pool.state.paused) throw new Error('Fables pool paused during preflight');
  const freshRange = buildTargetRange(pool.state.tick, pool.key.tickSpacing, config.tightWidthBps, config.rangePreset);
  const swap = await buildExactBalancedSwapPlan({
    pool,
    quoter: executor.quoter,
    rawAmount0: amountRaw,
    rawAmount1: 0n,
    sqrtPriceX96: pool.state.sqrtPriceX96,
    tickLower: freshRange.tickLower,
    tickUpper: freshRange.tickUpper,
    slippageBps: config.swapSlippageBps
  });
  if (swap.direction !== '0_to_1' || !swap.quote) throw new Error('Fresh USDG-to-MOO balancing quote unavailable');
  const swapDeadline = executor.deadline();
  const request = executor.router.buildV4ExactInputSingle({ pool, quote: swap.quote, deadline: swapDeadline });
  await executor.router.simulateV4ExactInputSingle({ pool, quote: swap.quote, deadline: swapDeadline, from: config.walletAddress });
  save({ phase: 'swap_preflighted', tick: pool.state.tick, range: freshRange });
  const swapReceipt = await executor.sendVerifiedTx({
    label: 'bootstrapV4Swap', to: request.router, data: request.data, value: request.value,
    onSent: (hash) => { phase = 'swap_sent'; save({ phase, tx: { ...journal.tx, swap: hash } }); }
  });
  phase = 'swap_confirmed';
  const afterSwap = await executor.readRawPairBalances(pool);
  executor.assertSwapReceiptBalances(pool, swap, pre, afterSwap);
  save({ phase, tx: { ...journal.tx, swap: swapReceipt.hash }, balances: { usdg: afterSwap.raw0.toString(), moo: afterSwap.raw1.toString() } });
  const inventory0 = amountRaw - swap.rawAmountIn;
  const inventory1 = afterSwap.raw1 - pre.raw1;
  if (inventory0 <= 0n || inventory1 <= 0n) throw new Error('Insufficient inventory after swap');
  pool.state = await bot.fables.readPoolState(pool);
  let target = buildTargetRange(pool.state.tick, pool.key.tickSpacing, config.tightWidthBps, config.rangePreset);
  let deposit = buildExactDepositPlan({ rawAmount0: inventory0, rawAmount1: inventory1,
    sqrtPriceX96: pool.state.sqrtPriceX96, tickLower: target.tickLower, tickUpper: target.tickUpper,
    slippageBps: config.depositSlippageBps, liquidityReserveBps: config.depositLiquidityReserveBps });
  await executor.ensureHookAllowance(pool.token1, pool.key.hooks, deposit.amount1Max);
  pool.state = await bot.fables.readPoolState(pool);
  if (pool.state.paused) throw new Error('Fables pool paused before deposit');
  target = buildTargetRange(pool.state.tick, pool.key.tickSpacing, config.tightWidthBps, config.rangePreset);
  deposit = buildExactDepositPlan({ rawAmount0: inventory0, rawAmount1: inventory1,
    sqrtPriceX96: pool.state.sqrtPriceX96, tickLower: target.tickLower, tickUpper: target.tickUpper,
    slippageBps: config.depositSlippageBps, liquidityReserveBps: config.depositLiquidityReserveBps });
  const depositData = bot.fables.encodeDeposit(pool, target, deposit.liquidity, deposit.amount0Max, deposit.amount1Max, executor.deadline());
  save({ phase: 'deposit_preflighted', target });
  const receipt = await executor.sendVerifiedTx({
    label: 'bootstrapFablesDeposit', to: pool.key.hooks, data: depositData, value: 0n,
    onSent: (hash) => { phase = 'deposit_sent'; save({ phase, tx: { ...journal.tx, deposit: hash } }); }
  });
  phase = 'deposit_confirmed';
  save({ phase, tx: { ...journal.tx, deposit: receipt.hash } });
  const event = executor.findWalletDepositEvent(pool, receipt);
  if (!event) throw new Error('Deposit receipt missing wallet event');
  const minted = await bot.fables.readRangeKey(pool, event.rangeId);
  if (!minted.exists || !samePoolKey(minted.key, pool.key) || Number(minted.tickLower) !== target.tickLower || Number(minted.tickUpper) !== target.tickUpper) {
    throw new Error('Unexpected minted pool or tick range');
  }
  const shares = await executor.readPositionShares(pool, event.rangeId);
  if (shares <= 0n) throw new Error('Deposit confirmed without LP shares');
  bot.ledger.append('bootstrap.completed', { poolId: pool.id, pair: 'USDG/MOO', amountUSDG: amountText,
    swapHash: swapReceipt.hash, depositHash: receipt.hash, rangeId: event.rangeId, shares: shares.toString(), target });
  bot.state.setSetting('activeRebalanceExecution', null);
  console.log(JSON.stringify({ ok: true, swapHash: swapReceipt.hash, depositHash: receipt.hash, rangeId: event.rangeId, shares: shares.toString(), range: target }));
} catch (error) {
  if (['swap_sent', 'swap_confirmed', 'deposit_sent', 'deposit_confirmed'].includes(phase)) {
    save({ phase: 'recovery_required', reason: String(error.message || error) });
    bot.ledger.append('bootstrap.recovery_required', journal);
  } else {
    bot.state.setSetting('activeRebalanceExecution', null);
  }
  log('error', 'bootstrap.failed', { phase, error: String(error.message || error) });
  process.exitCode = 1;
}
