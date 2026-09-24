import fs from 'node:fs';
import path from 'node:path';
import {
  AbiCoder,
  Contract,
  Interface,
  formatUnits,
  getAddress,
  id,
  keccak256,
  zeroPadValue
} from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';
import { FablesAdapter } from '../adapters/fables.js';
import { V4QuoterAdapter } from '../adapters/quoter.js';
import { buildUsdPriceMap } from '../analytics/prices.js';
import { rangeAmounts, spotToken1PerToken0 } from '../analytics/liquidity.js';
import { buildRebalanceInventoryPlan } from '../analytics/rebalance-plan.js';
import { buildCenteredRange, isOutsideRange } from '../math/ticks.js';
import {
  DEPOSITED_EVENT,
  ERC20_ABI,
  HOOK_ABI,
  POOL_MANAGER_ABI,
  WITHDRAWN_EVENT
} from '../abi.js';
import {
  POOLS_STORAGE_SLOT,
  ZERO_ADDRESS
} from '../constants.js';

loadDotEnv();
const config = loadConfig();
const { readProvider, rawProviders } = createProviders(config);
await verifyProviders(rawProviders, config.chainId);

const wallet = config.walletAddress.toLowerCase();
const fables = new FablesAdapter(readProvider, config);
const quoter = new V4QuoterAdapter(readProvider);
const hookIface = new Interface(HOOK_ABI);
const managerIface = new Interface(POOL_MANAGER_ABI);
const erc20Iface = new Interface(ERC20_ABI);
const abiCoder = AbiCoder.defaultAbiCoder();
const depositedTopic = id(DEPOSITED_EVENT);
const withdrawnTopic = id(WITHDRAWN_EVENT);
const transferTopic = id('Transfer(address,address,uint256)');
const approvalTopic = id('Approval(address,address,uint256)');
const walletTopic = zeroPadValue(config.walletAddress, 32).toLowerCase();
const claimSelector = hookIface.getFunction('claimFees').selector.toLowerCase();
const withdrawSelector = hookIface.getFunction('withdraw').selector.toLowerCase();
const blockCache = new Map();
const historicalStateCache = new Map();
const historicalPriceCache = new Map();

const latestBlock = await readProvider.getBlockNumber();
const allPools = await fables.hydratePoolStates(await fables.discoverAllPools());
const prices = buildUsdPriceMap(allPools, config.usdgAddress);
const targetPools = fables.targetPools(allPools).filter((p) => p.state);
if (!targetPools.length) throw new Error('No configured target Fables pool found');

const lifecycleLogs = [];
for (const pool of targetPools) {
  const logs = await fables.getLogsAdaptive(
    { address: pool.key.hooks, topics: [[depositedTopic, withdrawnTopic], walletTopic] },
    config.logFromBlock,
    latestBlock
  );
  for (const log of logs) lifecycleLogs.push({ ...log, poolId: pool.id, hook: pool.key.hooks });
}
lifecycleLogs.sort((a, b) => a.blockNumber - b.blockNumber || Number(a.index || 0) - Number(b.index || 0));
if (!lifecycleLogs.length) {
  const report = {
    generatedAt: new Date().toISOString(),
    wallet: config.walletAddress,
    latestBlock,
    status: 'no_fables_lifecycle_found',
    targetPools: targetPools.map((p) => ({ id: p.id, pair: pairName(p), hook: p.key.hooks }))
  };
  writeReports(report, '# Wallet audit\n\nNo matching Fables deposit/withdraw lifecycle events were found.');
  process.exit(0);
}

const firstFablesBlock = lifecycleLogs[0].blockNumber;
const tokenMap = new Map();
for (const pool of targetPools) {
  tokenMap.set(pool.token0.address.toLowerCase(), pool.token0);
  tokenMap.set(pool.token1.address.toLowerCase(), pool.token1);
}
const tokens = [...tokenMap.values()];
const tokenLogs = [];
for (const token of tokens) {
  if (token.address.toLowerCase() === ZERO_ADDRESS) continue;
  const fromLogs = await fables.getLogsAdaptive(
    { address: token.address, topics: [transferTopic, walletTopic] },
    firstFablesBlock,
    latestBlock
  );
  const toLogs = await fables.getLogsAdaptive(
    { address: token.address, topics: [transferTopic, null, walletTopic] },
    firstFablesBlock,
    latestBlock
  );
  const approvalFrom = Math.max(config.logFromBlock, firstFablesBlock - 500_000);
  const approvals = await fables.getLogsAdaptive(
    { address: token.address, topics: [approvalTopic, walletTopic] },
    approvalFrom,
    latestBlock
  );
  for (const log of [...fromLogs, ...toLogs]) tokenLogs.push({ ...log, token: token.address });
  for (const log of approvals) tokenLogs.push({ ...log, token: token.address, approval: true });
}
const uniqueTokenLogs = dedupeLogs(tokenLogs);

const txHashes = new Set(lifecycleLogs.map((x) => x.transactionHash.toLowerCase()));
for (const log of uniqueTokenLogs) txHashes.add(log.transactionHash.toLowerCase());
const txRows = await mapLimit([...txHashes], 5, async (hash) => loadTx(hash));
txRows.sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex);

const currentWalletBalances = await fables.readWalletBalances(tokens);
const netTransferByToken = new Map(tokens.map((t) => [t.address.toLowerCase(), 0]));
for (const log of uniqueTokenLogs) {
  if (log.approval || String(log.topics?.[0]).toLowerCase() !== transferTopic.toLowerCase()) continue;
  const token = tokenMap.get(log.address.toLowerCase());
  if (!token) continue;
  const delta = walletTransferDelta(log, token.decimals, wallet);
  netTransferByToken.set(token.address.toLowerCase(), (netTransferByToken.get(token.address.toLowerCase()) || 0) + delta);
}
const startBalances = {};
for (const token of tokens) {
  const key = token.address.toLowerCase();
  const current = Number(currentWalletBalances[key]?.amount || 0);
  startBalances[key] = current - Number(netTransferByToken.get(key) || 0);
}

const rangeInfo = new Map();
for (const event of lifecycleLogs) {
  const rangeId = String(event.topics?.[2] || '').toLowerCase();
  if (!rangeId || rangeInfo.has(rangeId)) continue;
  const pool = targetPools.find((p) => p.id === event.poolId);
  if (!pool) continue;
  const hook = new Contract(pool.key.hooks, HOOK_ABI, readProvider);
  try {
    const key = await hook.rangeKey(rangeId);
    if (!key.exists) continue;
    rangeInfo.set(rangeId, {
      rangeId,
      poolId: pool.id,
      hook: pool.key.hooks,
      tickLower: Number(key.tickLower),
      tickUpper: Number(key.tickUpper)
    });
  } catch {}
}

const lifecycleDetails = [];
for (const event of lifecycleLogs) {
  const rangeId = String(event.topics?.[2] || '').toLowerCase();
  const info = rangeInfo.get(rangeId);
  const pool = targetPools.find((p) => p.id === event.poolId);
  if (!pool || !info) continue;
  const liquidity = BigInt(event.data || 0);
  const kind = String(event.topics?.[0]).toLowerCase() === depositedTopic.toLowerCase() ? 'deposit' : 'withdraw';
  let amounts = null;
  let historicalState = null;
  try {
    historicalState = await readPoolStateAt(pool, event.blockNumber);
    amounts = rangeAmounts(
      liquidity,
      historicalState.sqrtPriceX96,
      info.tickLower,
      info.tickUpper,
      pool.token0.decimals,
      pool.token1.decimals
    );
  } catch (error) {
    amounts = null;
  }
  lifecycleDetails.push({
    kind,
    blockNumber: event.blockNumber,
    txHash: event.transactionHash.toLowerCase(),
    logIndex: Number(event.index || 0),
    poolId: pool.id,
    pair: pairName(pool),
    hook: pool.key.hooks,
    rangeId,
    liquidity,
    tickLower: info.tickLower,
    tickUpper: info.tickUpper,
    amounts
  });
}

const activePositions = [];
const positionEpochs = buildPositionEpochs(lifecycleDetails);
for (const [rangeId, info] of rangeInfo) {
  const pool = targetPools.find((p) => p.id === info.poolId);
  if (!pool) continue;
  const hook = new Contract(pool.key.hooks, HOOK_ABI, readProvider);
  const [shares, user] = await Promise.all([
    hook.balanceOf(config.walletAddress, rangeId),
    hook.userPosition(rangeId, config.walletAddress).catch(() => null)
  ]);
  if (shares === 0n) continue;
  const currentAmounts = rangeAmounts(
    shares,
    pool.state.sqrtPriceX96,
    info.tickLower,
    info.tickUpper,
    pool.token0.decimals,
    pool.token1.decimals
  );
  const owed0 = user ? Number(formatUnits(user.owed0, pool.token0.decimals)) : 0;
  const owed1 = user ? Number(formatUnits(user.owed1, pool.token1.decimals)) : 0;
  const price0 = priceOf(pool.token0.address);
  const price1 = priceOf(pool.token1.address);
  const principalUsd = currentAmounts.amount0 * price0 + currentAmounts.amount1 * price1;
  const owedUsd = owed0 * price0 + owed1 * price1;
  const epoch = positionEpochs.get(rangeId);
  const hodl0 = epoch?.hodl0 ?? null;
  const hodl1 = epoch?.hodl1 ?? null;
  const hodlUsd = hodl0 == null || hodl1 == null ? null : hodl0 * price0 + hodl1 * price1;
  const ilUsd = hodlUsd == null ? null : principalUsd - hodlUsd;
  const ilPct = hodlUsd && Number.isFinite(ilUsd) ? ilUsd / hodlUsd * 100 : null;
  const outside = isOutsideRange(pool.state.tick, info.tickLower, info.tickUpper, config.edgeBufferTicks);
  const target = buildCenteredRange(pool.state.tick, pool.key.tickSpacing, config.tightWidthBps);
  let inventoryPlan = null;
  let quote = null;
  let quoteError = null;
  if (outside) {
    try {
      inventoryPlan = buildRebalanceInventoryPlan({
        amount0: currentAmounts.amount0 + owed0,
        amount1: currentAmounts.amount1 + owed1,
        price0Usd: price0,
        price1Usd: price1,
        sqrtPriceX96: pool.state.sqrtPriceX96,
        tickLower: target.tickLower,
        tickUpper: target.tickUpper,
        decimals0: pool.token0.decimals,
        decimals1: pool.token1.decimals
      });
      if (inventoryPlan.direction !== 'none' && inventoryPlan.amountIn > 0) {
        quote = await quoter.quoteExactInputSingle(pool, inventoryPlan.tokenIn, inventoryPlan.amountIn, config.swapSlippageBps);
      }
    } catch (error) {
      quoteError = error.message;
    }
  }
  activePositions.push({
    rangeId,
    poolId: pool.id,
    pair: pairName(pool),
    tick: pool.state.tick,
    tickLower: info.tickLower,
    tickUpper: info.tickUpper,
    shares: shares.toString(),
    amount0: currentAmounts.amount0,
    amount1: currentAmounts.amount1,
    symbol0: pool.token0.symbol,
    symbol1: pool.token1.symbol,
    owed0,
    owed1,
    principalUsd,
    owedUsd,
    hodl0,
    hodl1,
    hodlUsd,
    ilUsd,
    ilPct,
    outside,
    target,
    inventoryPlan,
    quote,
    quoteError
  });
}

const txLedger = [];
const strategyHooks = new Set(targetPools.map((p) => p.key.hooks.toLowerCase()));
for (const row of txRows) {
  const deltas = tokenDeltasForReceipt(row.receipt);
  const lifecycle = lifecycleDetails.filter((e) => e.txHash === row.hash);
  const selector = String(row.tx?.data || '').slice(0, 10).toLowerCase();
  const to = String(row.tx?.to || '').toLowerCase();
  const initiatedByWallet = String(row.tx?.from || '').toLowerCase() === wallet;
  let classification = 'token_activity';
  if (lifecycle.some((x) => x.kind === 'deposit') && lifecycle.some((x) => x.kind === 'withdraw')) classification = 'manual_rebalance';
  else if (lifecycle.some((x) => x.kind === 'deposit')) classification = 'lp_deposit';
  else if (lifecycle.some((x) => x.kind === 'withdraw')) classification = 'lp_withdraw';
  else if (strategyHooks.has(to) && selector === claimSelector) classification = 'claim_fees';
  else if (strategyHooks.has(to) && selector === withdrawSelector) classification = 'lp_withdraw_call';
  else if (hasApprovalLog(row.receipt)) classification = 'approval';
  else if (isTwoSidedSwap(deltas)) classification = 'swap';
  else if (initiatedByWallet) classification = 'wallet_transfer_or_contract_call';
  else classification = 'external_inbound_or_protocol';

  const gasWei = initiatedByWallet && row.receipt
    ? BigInt(row.receipt.gasUsed || 0) * BigInt(row.receipt.gasPrice || row.tx?.gasPrice || 0)
    : 0n;
  const gasEth = Number(formatUnits(gasWei, 18));
  const gasUsdCurrent = gasEth * priceOf(ZERO_ADDRESS);
  txLedger.push({
    hash: row.hash,
    blockNumber: row.blockNumber,
    timestampMs: await blockTimestamp(row.blockNumber),
    classification,
    from: row.tx?.from || null,
    to: row.tx?.to || null,
    selector,
    delta0: deltas[primaryPool().token0.address.toLowerCase()] || 0,
    delta1: deltas[primaryPool().token1.address.toLowerCase()] || 0,
    symbol0: primaryPool().token0.symbol,
    symbol1: primaryPool().token1.symbol,
    gasEth,
    gasUsdCurrent,
    lifecycle: lifecycle.map((x) => ({ kind: x.kind, rangeId: x.rangeId, liquidity: x.liquidity.toString() }))
  });
}

const feeResult = await estimateUserFees(txLedger, rangeInfo, targetPools, activePositions);
const currentTotals = currentPortfolioTotals(activePositions, currentWalletBalances);
const initialPrice = await pricePairAtBlock(primaryPool(), Math.max(0, firstFablesBlock - 1)).catch(() => null);
const initial0 = Number(startBalances[primaryPool().token0.address.toLowerCase()] || 0);
const initial1 = Number(startBalances[primaryPool().token1.address.toLowerCase()] || 0);
const initialValueUsd = initialPrice ? initial0 * initialPrice.price0 + initial1 * initialPrice.price1 : null;

const externalCashflows = [];
for (const tx of txLedger) {
  if (!['external_inbound_or_protocol', 'wallet_transfer_or_contract_call'].includes(tx.classification)) continue;
  if (!tx.delta0 && !tx.delta1) continue;
  const pricesAt = await pricePairAtBlock(primaryPool(), tx.blockNumber).catch(() => null);
  const usd = pricesAt ? tx.delta0 * pricesAt.price0 + tx.delta1 * pricesAt.price1 : null;
  externalCashflows.push({ hash: tx.hash, blockNumber: tx.blockNumber, delta0: tx.delta0, delta1: tx.delta1, usd });
}
const externalUsd = externalCashflows.reduce((sum, x) => sum + (Number.isFinite(x.usd) ? x.usd : 0), 0);
const external0 = externalCashflows.reduce((sum, x) => sum + x.delta0, 0);
const external1 = externalCashflows.reduce((sum, x) => sum + x.delta1, 0);
const currentPrice0 = priceOf(primaryPool().token0.address);
const currentPrice1 = priceOf(primaryPool().token1.address);
const hodlUnits0 = initial0 + external0;
const hodlUnits1 = initial1 + external1;
const hodlCurrentUsd = hodlUnits0 * currentPrice0 + hodlUnits1 * currentPrice1;
const totalGasEth = txLedger.reduce((sum, x) => sum + x.gasEth, 0);
const totalGasUsdCurrent = txLedger.reduce((sum, x) => sum + x.gasUsdCurrent, 0);
const pnlUsd = initialValueUsd == null ? null : currentTotals.totalUsd - initialValueUsd - externalUsd - totalGasUsdCurrent;
const excessVsHodlUsd = currentTotals.totalUsd - hodlCurrentUsd - totalGasUsdCurrent;

const latest = await blockTimestamp(latestBlock);
const report = {
  generatedAt: new Date().toISOString(),
  chainId: config.chainId,
  wallet: config.walletAddress,
  latestBlock,
  latestBlockTime: new Date(latest).toISOString(),
  target: {
    pools: targetPools.map((p) => ({ id: p.id, pair: pairName(p), hook: p.key.hooks, tick: p.state.tick })),
    firstFablesBlock,
    firstFablesTime: new Date(await blockTimestamp(firstFablesBlock)).toISOString()
  },
  prices: {
    current: Object.fromEntries(tokens.map((t) => [t.symbol, priceOf(t.address)])),
    initialPairPrice: initialPrice
  },
  startingWalletBalances: {
    [primaryPool().token0.symbol]: initial0,
    [primaryPool().token1.symbol]: initial1
  },
  current: currentTotals,
  pnl: {
    initialValueUsd,
    externalCashflowUsd: externalUsd,
    totalGasEth,
    totalGasUsdAtCurrentEth: totalGasUsdCurrent,
    netPnlUsd: pnlUsd,
    hodlUnits0,
    hodlUnits1,
    hodlCurrentUsd,
    excessVsHodlUsd
  },
  fees: feeResult,
  activePositions,
  transactions: txLedger,
  externalCashflows,
  lifecycle: lifecycleDetails.map((x) => ({ ...x, liquidity: x.liquidity.toString() })),
  caveats: [
    'Gas USD uses current ETH/USD price; gas ETH is exact from receipts.',
    'Net PnL uses the wallet target-token balances immediately before the first observed Fables lifecycle event as the starting portfolio.',
    'External cashflow classification is heuristic for one-sided token activity outside recognized Fables lifecycle/claim/swap transactions.',
    'Active-position IL excludes fees and compares current LP principal to the remaining HODL token mix reconstructed from that range epoch.',
    'If an RPC does not serve historical eth_call state, event-time amount/price fields can be incomplete; current on-chain state remains exact.'
  ]
};
const markdown = renderMarkdown(report, primaryPool());
writeReports(report, markdown);
console.log(JSON.stringify({
  ok: true,
  wallet: report.wallet,
  firstFablesBlock,
  currentValueUsd: report.current.totalUsd,
  netPnlUsd: report.pnl.netPnlUsd,
  excessVsHodlUsd: report.pnl.excessVsHodlUsd,
  totalGasEth: report.pnl.totalGasEth,
  totalFeeUsdCurrent: report.fees.totalFeeUsdCurrent,
  activePositions: report.activePositions.length,
  outOfRange: report.activePositions.filter((x) => x.outside).length,
  reportJson: path.join(config.dataDir, 'audits', 'latest.json'),
  reportMarkdown: path.join(config.dataDir, 'audits', 'latest.md')
}, null, 2));

function primaryPool() {
  const direct = targetPools.find((p) =>
    [p.token0.symbol.toUpperCase(), p.token1.symbol.toUpperCase()].includes('USDG')
  );
  return direct || targetPools[0];
}

function pairName(pool) { return `${pool.token0.symbol}/${pool.token1.symbol}`; }
function priceOf(address) { return Number(prices.get(String(address).toLowerCase()) || 0); }

async function readPoolStateAt(pool, blockNumber) {
  const cacheKey = `${pool.id}:${blockNumber}`;
  if (historicalStateCache.has(cacheKey)) return historicalStateCache.get(cacheKey);
  const hook = new Contract(pool.key.hooks, HOOK_ABI, readProvider);
  const managerAddress = await hook.poolManager();
  const slot = keccak256(abiCoder.encode(['bytes32', 'uint256'], [pool.id, POOLS_STORAGE_SLOT]));
  const data = managerIface.encodeFunctionData('extsload', [slot, 4]);
  const raw = await readProvider.send('eth_call', [{ to: managerAddress, data }, blockTag(blockNumber)]);
  const [words] = managerIface.decodeFunctionResult('extsload', raw);
  const packed = BigInt(words[0]);
  const sqrtPriceX96 = packed & ((1n << 160n) - 1n);
  let tick = Number((packed >> 160n) & 0xffffffn);
  if (tick >= 2 ** 23) tick -= 2 ** 24;
  const result = { sqrtPriceX96, tick, liquidity: BigInt(words[3]), poolManager: getAddress(managerAddress) };
  historicalStateCache.set(cacheKey, result);
  return result;
}

async function pricePairAtBlock(pool, blockNumber) {
  const key = `${pool.id}:${blockNumber}`;
  if (historicalPriceCache.has(key)) return historicalPriceCache.get(key);
  const state = await readPoolStateAt(pool, blockNumber);
  const spot = spotToken1PerToken0(state.sqrtPriceX96, pool.token0.decimals, pool.token1.decimals);
  let price0 = null;
  let price1 = null;
  if (pool.token1.address.toLowerCase() === config.usdgAddress.toLowerCase()) {
    price0 = spot;
    price1 = 1;
  } else if (pool.token0.address.toLowerCase() === config.usdgAddress.toLowerCase()) {
    price0 = 1;
    price1 = 1 / spot;
  } else {
    price0 = priceOf(pool.token0.address);
    price1 = priceOf(pool.token1.address);
  }
  const result = { blockNumber, price0, price1, tick: state.tick };
  historicalPriceCache.set(key, result);
  return result;
}

async function blockTimestamp(blockNumber) {
  if (blockCache.has(blockNumber)) return blockCache.get(blockNumber);
  const block = await readProvider.getBlock(blockNumber);
  const value = block ? Number(block.timestamp) * 1000 : Date.now();
  blockCache.set(blockNumber, value);
  return value;
}

async function loadTx(hash) {
  const [tx, receipt] = await Promise.all([
    readProvider.getTransaction(hash),
    readProvider.getTransactionReceipt(hash)
  ]);
  return {
    hash: hash.toLowerCase(),
    tx,
    receipt,
    blockNumber: Number(receipt?.blockNumber || tx?.blockNumber || 0),
    transactionIndex: Number(receipt?.index || tx?.index || 0)
  };
}

function dedupeLogs(logs) {
  const map = new Map();
  for (const log of logs) {
    const key = `${String(log.transactionHash).toLowerCase()}:${Number(log.index || 0)}:${String(log.address).toLowerCase()}:${String(log.topics?.[0]).toLowerCase()}`;
    if (!map.has(key)) map.set(key, log);
  }
  return [...map.values()];
}

function walletTransferDelta(log, decimals, walletAddress) {
  if (!log.topics || log.topics.length < 3) return 0;
  const from = topicAddress(log.topics[1]);
  const to = topicAddress(log.topics[2]);
  const amount = Number(formatUnits(BigInt(log.data || 0), decimals));
  let delta = 0;
  if (from === walletAddress) delta -= amount;
  if (to === walletAddress) delta += amount;
  return delta;
}

function tokenDeltasForReceipt(receipt) {
  const result = {};
  for (const log of receipt?.logs || []) {
    if (String(log.topics?.[0]).toLowerCase() !== transferTopic.toLowerCase()) continue;
    const token = tokenMap.get(String(log.address).toLowerCase());
    if (!token) continue;
    const key = token.address.toLowerCase();
    result[key] = (result[key] || 0) + walletTransferDelta(log, token.decimals, wallet);
  }
  return result;
}

function hasApprovalLog(receipt) {
  return (receipt?.logs || []).some((log) =>
    String(log.topics?.[0]).toLowerCase() === approvalTopic.toLowerCase() &&
    topicAddress(log.topics?.[1]) === wallet
  );
}

function isTwoSidedSwap(deltas) {
  const values = tokens.map((token) => Number(deltas[token.address.toLowerCase()] || 0)).filter((x) => x !== 0);
  return values.some((x) => x > 0) && values.some((x) => x < 0);
}

function topicAddress(value) {
  const x = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(x)) return null;
  return '0x' + x.slice(-40);
}

function buildPositionEpochs(events) {
  const result = new Map();
  const sorted = [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  for (const event of sorted) {
    let state = result.get(event.rangeId) || { liquidity: 0n, hodl0: 0, hodl1: 0, complete: true, epochStartBlock: event.blockNumber };
    if (event.kind === 'deposit') {
      if (state.liquidity === 0n) {
        state = { liquidity: 0n, hodl0: 0, hodl1: 0, complete: true, epochStartBlock: event.blockNumber };
      }
      state.liquidity += event.liquidity;
      if (event.amounts) {
        state.hodl0 += event.amounts.amount0;
        state.hodl1 += event.amounts.amount1;
      } else {
        state.complete = false;
      }
    } else {
      const before = state.liquidity;
      if (before > 0n) {
        const ratio = Math.min(1, Number(event.liquidity) / Number(before));
        state.hodl0 *= 1 - ratio;
        state.hodl1 *= 1 - ratio;
        state.liquidity = event.liquidity >= before ? 0n : before - event.liquidity;
      }
      if (state.liquidity === 0n) {
        state.hodl0 = 0;
        state.hodl1 = 0;
      }
    }
    result.set(event.rangeId, state);
  }
  return result;
}

async function estimateUserFees(txs, ranges, pools, active) {
  const rangeIds = [...ranges.keys()];
  const paid = new Map(pools.map((p) => [p.id, { amount0: 0, amount1: 0 }]));
  for (const tx of txs) {
    if (!['claim_fees', 'lp_withdraw', 'manual_rebalance', 'lp_withdraw_call'].includes(tx.classification)) continue;
    const pool = pools.find((p) => String(tx.to || '').toLowerCase() === p.key.hooks.toLowerCase()) ||
      pools.find((p) => tx.lifecycle.some((e) => ranges.get(e.rangeId)?.poolId === p.id));
    if (!pool || tx.blockNumber <= 0) continue;
    for (const rangeId of rangeIds) {
      const info = ranges.get(rangeId);
      if (!info || info.poolId !== pool.id) continue;
      try {
        const [before, after] = await Promise.all([
          readUserPositionAt(pool.key.hooks, rangeId, Math.max(0, tx.blockNumber - 1)),
          readUserPositionAt(pool.key.hooks, rangeId, tx.blockNumber)
        ]);
        const delta0 = before.owed0 > after.owed0 ? before.owed0 - after.owed0 : 0n;
        const delta1 = before.owed1 > after.owed1 ? before.owed1 - after.owed1 : 0n;
        paid.get(pool.id).amount0 += Number(formatUnits(delta0, pool.token0.decimals));
        paid.get(pool.id).amount1 += Number(formatUnits(delta1, pool.token1.decimals));
      } catch {}
    }
  }
  let realized0 = 0, realized1 = 0, unclaimed0 = 0, unclaimed1 = 0;
  const primary = primaryPool();
  const paidPrimary = paid.get(primary.id) || { amount0: 0, amount1: 0 };
  realized0 += paidPrimary.amount0;
  realized1 += paidPrimary.amount1;
  for (const position of active.filter((x) => x.poolId === primary.id)) {
    unclaimed0 += position.owed0;
    unclaimed1 += position.owed1;
  }
  const price0 = priceOf(primary.token0.address);
  const price1 = priceOf(primary.token1.address);
  return {
    method: 'historical userPosition owed-decrease + current owed',
    realized0,
    realized1,
    unclaimed0,
    unclaimed1,
    symbol0: primary.token0.symbol,
    symbol1: primary.token1.symbol,
    total0: realized0 + unclaimed0,
    total1: realized1 + unclaimed1,
    realizedFeeUsdCurrent: realized0 * price0 + realized1 * price1,
    unclaimedFeeUsdCurrent: unclaimed0 * price0 + unclaimed1 * price1,
    totalFeeUsdCurrent: (realized0 + unclaimed0) * price0 + (realized1 + unclaimed1) * price1
  };
}

async function readUserPositionAt(hookAddress, rangeId, blockNumber) {
  const data = hookIface.encodeFunctionData('userPosition', [rangeId, config.walletAddress]);
  const raw = await readProvider.send('eth_call', [{ to: hookAddress, data }, blockTag(blockNumber)]);
  const [position] = hookIface.decodeFunctionResult('userPosition', raw);
  return { owed0: BigInt(position.owed0), owed1: BigInt(position.owed1) };
}

function currentPortfolioTotals(active, walletBalances) {
  const primary = primaryPool();
  const key0 = primary.token0.address.toLowerCase();
  const key1 = primary.token1.address.toLowerCase();
  const wallet0 = Number(walletBalances[key0]?.amount || 0);
  const wallet1 = Number(walletBalances[key1]?.amount || 0);
  const lp0 = active.filter((x) => x.poolId === primary.id).reduce((s, x) => s + x.amount0, 0);
  const lp1 = active.filter((x) => x.poolId === primary.id).reduce((s, x) => s + x.amount1, 0);
  const owed0 = active.filter((x) => x.poolId === primary.id).reduce((s, x) => s + x.owed0, 0);
  const owed1 = active.filter((x) => x.poolId === primary.id).reduce((s, x) => s + x.owed1, 0);
  const total0 = wallet0 + lp0 + owed0;
  const total1 = wallet1 + lp1 + owed1;
  return {
    wallet0, wallet1, lp0, lp1, owed0, owed1, total0, total1,
    symbol0: primary.token0.symbol,
    symbol1: primary.token1.symbol,
    price0Usd: priceOf(primary.token0.address),
    price1Usd: priceOf(primary.token1.address),
    totalUsd: total0 * priceOf(primary.token0.address) + total1 * priceOf(primary.token1.address)
  };
}

function blockTag(blockNumber) { return '0x' + Number(blockNumber).toString(16); }

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function writeReports(report, markdown) {
  const dir = path.join(config.dataDir, 'audits');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(report, jsonReplacer, 2));
  fs.writeFileSync(path.join(dir, 'latest.md'), markdown);
}

function jsonReplacer(_key, value) { return typeof value === 'bigint' ? value.toString() : value; }

function renderMarkdown(report, pool) {
  const f = (x, d = 2) => Number.isFinite(Number(x)) ? Number(x).toLocaleString('en-US', { maximumFractionDigits: d }) : 'N/A';
  const usd = (x) => Number.isFinite(Number(x)) ? '$' + Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'N/A';
  const pct = (x) => Number.isFinite(Number(x)) ? Number(x).toFixed(2) + '%' : 'N/A';
  const lines = [];
  lines.push('# Fables Wallet Audit');
  lines.push('');
  lines.push(`- Wallet: \`${report.wallet}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Pair: ${pairName(pool)}`);
  lines.push(`- First observed Fables operation: block ${report.target.firstFablesBlock} · ${report.target.firstFablesTime}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Result |');
  lines.push('|---|---:|');
  lines.push(`| Current tracked value | ${usd(report.current.totalUsd)} |`);
  lines.push(`| Initial portfolio value | ${usd(report.pnl.initialValueUsd)} |`);
  lines.push(`| Net PnL after external cashflow + gas | ${usd(report.pnl.netPnlUsd)} |`);
  lines.push(`| Current HODL benchmark | ${usd(report.pnl.hodlCurrentUsd)} |`);
  lines.push(`| Excess vs HODL after gas | ${usd(report.pnl.excessVsHodlUsd)} |`);
  lines.push(`| Gas | ${f(report.pnl.totalGasEth, 8)} ETH (~${usd(report.pnl.totalGasUsdAtCurrentEth)} @ current ETH) |`);
  lines.push(`| LP fees earned | ${f(report.fees.total0, 6)} ${report.fees.symbol0} + ${f(report.fees.total1, 6)} ${report.fees.symbol1} (~${usd(report.fees.totalFeeUsdCurrent)}) |`);
  lines.push('');
  lines.push('## Active LP positions');
  lines.push('');
  lines.push('| Pair | Range | Tick | Status | Principal | Fees owed | IL | Next rebalance |');
  lines.push('|---|---|---:|---|---:|---:|---:|---|');
  for (const p of report.activePositions) {
    const swap = !p.outside ? 'No action' :
      p.quote ? `${p.quote.symbolIn}→${p.quote.symbolOut} ${f(p.quote.amountIn, 6)} → ${f(p.quote.amountOut, 6)} (min ${f(p.quote.minAmountOut, 6)})` :
      p.inventoryPlan?.direction === 'none' ? 'No balancing swap' :
      p.quoteError ? `Quote failed: ${p.quoteError}` : 'Quote unavailable';
    lines.push(`| ${p.pair} | ${p.tickLower}…${p.tickUpper} | ${p.tick} | ${p.outside ? 'OUT' : 'IN'} | ${usd(p.principalUsd)} | ${usd(p.owedUsd)} | ${usd(p.ilUsd)} / ${pct(p.ilPct)} | ${swap} |`);
  }
  lines.push('');
  lines.push('## Relevant transactions');
  lines.push('');
  lines.push(`Total: ${report.transactions.length}`);
  lines.push('');
  lines.push('| Time | Type | Tx | Δ' + report.current.symbol0 + ' | Δ' + report.current.symbol1 + ' | Gas ETH |');
  lines.push('|---|---|---|---:|---:|---:|');
  for (const tx of report.transactions) {
    lines.push(`| ${new Date(tx.timestampMs).toISOString()} | ${tx.classification} | \`${tx.hash.slice(0, 10)}…${tx.hash.slice(-6)}\` | ${f(tx.delta0, 6)} | ${f(tx.delta1, 6)} | ${f(tx.gasEth, 8)} |`);
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  for (const caveat of report.caveats) lines.push('- ' + caveat);
  return lines.join('\n');
}
