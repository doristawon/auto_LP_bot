import { formatUnits } from 'ethers';
import { rangeAmounts, spotToken1PerToken0 } from './liquidity.js';

const POOL_ID_RE = /^0x[0-9a-f]{64}$/;
const SCALE = 1_000_000_000n;

export function usdGAssetPriceFromPool(pool, usdgAddress) {
  const stable = String(usdgAddress || '').toLowerCase();
  const token0IsUsdG = String(pool?.token0?.address || '').toLowerCase() === stable;
  const token1IsUsdG = String(pool?.token1?.address || '').toLowerCase() === stable;
  if (token0IsUsdG === token1IsUsdG || !pool?.state?.sqrtPriceX96) {
    throw new Error('Pool is not a valid USDG pair with fresh state');
  }
  const price1Per0 = spotToken1PerToken0(pool.state.sqrtPriceX96,
    pool.token0.decimals, pool.token1.decimals);
  const assetPrice = token0IsUsdG ? 1 / price1Per0 : price1Per0;
  if (!(assetPrice > 0) || !Number.isFinite(assetPrice)) throw new Error('Fresh USDG pair spot price is unavailable');
  return { tokenAddress: (token0IsUsdG ? pool.token1 : pool.token0).address.toLowerCase(),
    priceUsdG: assetPrice };
}

export function valuePoolPositionsUsdG(pool, usdgAddress) {
  const { tokenAddress, priceUsdG } = usdGAssetPriceFromPool(pool, usdgAddress);
  const token0IsUsdG = String(pool.token0.address).toLowerCase() === String(usdgAddress).toLowerCase();
  const price0 = token0IsUsdG ? 1 : priceUsdG;
  const price1 = token0IsUsdG ? priceUsdG : 1;
  let total = 0;
  for (const position of pool.positions || []) {
    const amounts = rangeAmounts(position.shares, pool.state.sqrtPriceX96,
      position.tickLower, position.tickUpper, pool.token0.decimals, pool.token1.decimals);
    const amount0 = amounts.amount0 + Number(formatUnits(position.owed0 || 0n, pool.token0.decimals));
    const amount1 = amounts.amount1 + Number(formatUnits(position.owed1 || 0n, pool.token1.decimals));
    const value = amount0 * price0 + amount1 * price1;
    if (!Number.isFinite(value) || value < 0) throw new Error('Existing LP allocation value is unavailable');
    total += value;
  }
  if (!Number.isFinite(total)) throw new Error('Existing LP allocation value is unavailable');
  return { tokenAddress, priceUsdG, lpEquityUsdG: total };
}

export function normalizeInvestmentAllocation(input, pools, usdgAddress) {
  if (typeof input?.enabled !== 'boolean') throw new Error('資金分配 enabled 必須是布林值');
  const enabled = input.enabled;
  const source = Array.isArray(input?.allocations) ? input.allocations : [];
  if (!enabled) return { version: 1, enabled: false, allocations: [] };
  if (source.length < 1 || source.length > 2) {
    throw new Error('啟用資金分配時必須選擇 1 到 2 個池');
  }
  const poolMap = new Map((pools || []).map((pool) => [String(pool.id).toLowerCase(), pool]));
  const seen = new Set();
  const seenAssetTokens = new Set();
  const allocations = source.map((entry) => {
    const poolId = String(entry?.poolId || '').toLowerCase();
    const weightBps = Number(entry?.weightBps);
    if (!POOL_ID_RE.test(poolId) || seen.has(poolId)) throw new Error('資金分配池 ID 無效或重複');
    if (!Number.isInteger(weightBps) || weightBps < 1 || weightBps > 10_000) {
      throw new Error('每池配置比例必須是 1 到 10000 bps 的整數');
    }
    const pool = poolMap.get(poolId);
    if (!pool) throw new Error('資金分配池不在目前 Fables 登錄清單內');
    if (pool.state?.paused !== false || BigInt(pool.state?.liquidity || 0) <= 0n) {
      throw new Error('資金分配池必須未暫停且已有流動性');
    }
    const native = [pool.token0, pool.token1].some((token) =>
      String(token.address || '').toLowerCase() === '0x0000000000000000000000000000000000000000');
    if (native) throw new Error('資金分配目前只支援 ERC20 池');
    const usdg = String(usdgAddress || '').toLowerCase();
    if (![pool.token0, pool.token1].some((token) => String(token.address).toLowerCase() === usdg)) {
      throw new Error('資金分配池必須包含 USDG');
    }
    const otherToken = [pool.token0, pool.token1].find((token) =>
      String(token.address).toLowerCase() !== usdg);
    const otherAddress = String(otherToken?.address || '').toLowerCase();
    if (seenAssetTokens.has(otherAddress)) throw new Error('資金分配池不能共用 USDG 以外的 token');
    seenAssetTokens.add(otherAddress);
    seen.add(poolId);
    return { poolId, weightBps };
  });
  if (allocations.reduce((sum, entry) => sum + entry.weightBps, 0) !== 10_000) {
    throw new Error('資金分配比例總和必須為 10000 bps');
  }
  return { version: 1, enabled: true, allocations };
}

/**
 * Create conservative per-pool raw token caps from one fresh wallet snapshot.
 * Each selected pool owns its non-USDG pair token; shared USDG is assigned only
 * to each pool's remaining target after its existing LP and own meme balance.
 */
export function computeAllocationFunding({
  allocation,
  pools,
  lpEquityUsdG = {},
  walletBalances = {},
  pricesUsdG = {},
  usdgAddress,
  priceObservedAt,
  asOfBlock = null,
  nowMs = Date.now(),
  maxPriceAgeMs = 5 * 60_000
}) {
  if (!allocation?.enabled) return { status: 'disabled', allocation, byPool: [], totalUsdG: null };
  if (!Number.isFinite(Number(priceObservedAt)) || Number(priceObservedAt) <= 0
    || nowMs < Number(priceObservedAt) || nowMs - Number(priceObservedAt) > maxPriceAgeMs) {
    return blockedFunding(allocation, 'market-price-stale');
  }
  const poolMap = new Map((pools || []).map((pool) => [String(pool.id).toLowerCase(), pool]));
  const usdg = String(usdgAddress || '').toLowerCase();
  const selected = allocation.allocations.map((entry) => {
    const pool = poolMap.get(entry.poolId);
    if (!pool || pool.state?.paused !== false || BigInt(pool.state?.liquidity || 0) <= 0n) {
      throw new Error('資金分配池目前不可用');
    }
    const tokens = [pool.token0, pool.token1];
    const token = tokens.find((item) => String(item.address).toLowerCase() !== usdg);
    const stable = tokens.find((item) => String(item.address).toLowerCase() === usdg);
    if (!token || !stable) throw new Error('資金分配池 token pair 不符合 USDG/ERC20 規則');
    const priceUsdG = readPrice(pricesUsdG, token.address);
    if (!(priceUsdG > 0) || !Number.isFinite(priceUsdG)) {
      return { entry, pool, token, stable, blocked: 'allocation-token-price-unavailable' };
    }
    const tokenBalance = readBalance(walletBalances, token);
    const stableBalance = readBalance(walletBalances, stable);
    const tokenValueUsdG = tokenBalance.amount * priceUsdG;
    const stableValueUsdG = stableBalance.amount;
    const lpUsd = Number(lpEquityUsdG[entry.poolId]);
    if (![tokenValueUsdG, stableValueUsdG, lpUsd].every((value) => Number.isFinite(value) && value >= 0)) {
      return { entry, pool, token, stable, blocked: 'allocation-value-invalid' };
    }
    return { entry, pool, token, stable, tokenBalance, stableBalance, tokenValueUsdG,
      stableValueUsdG, lpUsd, blocked: null };
  });
  if (selected.some((entry) => entry.blocked)) return blockedFunding(allocation, selected.find((e) => e.blocked).blocked);

  const totalUsdG = selected.reduce((sum, entry) => sum + entry.lpUsd + entry.tokenValueUsdG, 0)
    + [...new Set(selected.map((entry) => entry.stable.address.toLowerCase()))]
      .reduce((sum, address) => sum + readBalance(walletBalances, { address }).amount, 0);
  if (!Number.isFinite(totalUsdG) || totalUsdG < 0) return blockedFunding(allocation, 'allocation-denominator-invalid');

  const items = selected.map((entry) => {
    const targetUsdG = totalUsdG * entry.entry.weightBps / 10_000;
    const gapBeforeWallet = Math.max(0, targetUsdG - entry.lpUsd);
    const ownTokenValueUsdG = Math.min(gapBeforeWallet, entry.tokenValueUsdG);
    const remainingGapUsdG = Math.max(0, gapBeforeWallet - ownTokenValueUsdG);
    const tokenRawCap = capRawByValue(entry.tokenBalance.raw, ownTokenValueUsdG, entry.tokenValueUsdG);
    return { ...entry, targetUsdG, gapBeforeWallet, ownTokenValueUsdG, remainingGapUsdG,
      tokenRawCap, sharedUsdGRawCap: 0n, sharedUsdGValue: 0 };
  });
  const uniqueStable = new Map(selected.map((entry) => [entry.stable.address.toLowerCase(), entry.stable]));
  if (uniqueStable.size !== 1) return blockedFunding(allocation, 'allocation-stable-token-mismatch');
  const stable = [...uniqueStable.values()][0];
  const rawStableBalance = readBalance(walletBalances, stable).raw;
  const stableAmount = readBalance(walletBalances, stable).amount;
  const totalStableUsdG = stableAmount;
  const totalGap = items.reduce((sum, entry) => sum + entry.remainingGapUsdG, 0);
  const assignedStable = Math.min(totalStableUsdG, totalGap);
  for (const item of items) {
    const assignedValue = totalGap > 0 ? assignedStable * item.remainingGapUsdG / totalGap : 0;
    item.sharedUsdGValue = assignedValue;
    item.sharedUsdGRawCap = capRawByValue(rawStableBalance, assignedValue, totalStableUsdG);
  }
  // Floor rounding is conservative; repair any aggregate excess caused by an
  // extreme IEEE-754 edge by reducing the final pool's shared cap.
  const sumStableCaps = items.reduce((sum, entry) => sum + entry.sharedUsdGRawCap, 0n);
  if (sumStableCaps > rawStableBalance) {
    const excess = sumStableCaps - rawStableBalance;
    const last = items.at(-1);
    last.sharedUsdGRawCap = last.sharedUsdGRawCap > excess ? last.sharedUsdGRawCap - excess : 0n;
  }
  const byPool = items.map((item) => {
    const ownWalletUsdG = item.ownTokenValueUsdG + item.sharedUsdGValue;
    const availableUsdG = Math.min(item.gapBeforeWallet, ownWalletUsdG);
    return {
      poolId: item.entry.poolId,
      pair: `${item.pool.token0.symbol}/${item.pool.token1.symbol}`,
      weightBps: item.entry.weightBps,
      targetUsdG: item.targetUsdG,
      lpEquityUsdG: item.lpUsd,
      ownWalletUsdG,
      sharedUsdgAvailableUsdG: item.sharedUsdGValue,
      availableUsdG,
      driftUsdG: item.lpUsd - item.targetUsdG,
      tokenCaps: {
        [item.token.address.toLowerCase()]: item.tokenRawCap.toString(),
        [stable.address.toLowerCase()]: item.sharedUsdGRawCap.toString()
      }
    };
  });
  return { status: 'ready', allocation, totalUsdG, priceObservedAt: Number(priceObservedAt),
    asOfBlock: Number.isSafeInteger(Number(asOfBlock)) ? Number(asOfBlock) : null, byPool };
}

export function assertAllocationSpend(scope, poolId, actualSpendUsdG) {
  if (!scope || scope.status !== 'ready') throw new Error('Allocation funding scope is unavailable');
  const pool = scope.byPool.find((entry) => entry.poolId === String(poolId).toLowerCase());
  if (!pool) throw new Error('Pool is outside the saved allocation');
  if (!Number.isFinite(Number(actualSpendUsdG)) || Number(actualSpendUsdG) < 0
    || Number(actualSpendUsdG) > pool.availableUsdG + 1e-8) {
    throw new Error('Executor spend exceeds this pool allocation cap');
  }
  return pool;
}

function blockedFunding(allocation, reason) {
  return { status: 'blocked', reason, allocation, byPool: [], totalUsdG: null };
}

function readBalance(balances, token) {
  const entry = balances instanceof Map
    ? balances.get(String(token.address).toLowerCase())
    : balances?.[String(token.address).toLowerCase()];
  const raw = BigInt(entry?.raw ?? 0n);
  const amount = Number(entry?.amount ?? 0);
  if (raw < 0n || !Number.isFinite(amount) || amount < 0) throw new Error('Wallet balance is invalid');
  return { raw, amount };
}

function readPrice(prices, address) {
  return Number(prices instanceof Map ? prices.get(String(address).toLowerCase())
    : prices?.[String(address).toLowerCase()]);
}

function capRawByValue(raw, capValue, totalValue) {
  const balance = BigInt(raw || 0n);
  if (balance <= 0n || !(capValue > 0) || !(totalValue > 0)) return 0n;
  if (capValue >= totalValue) return balance;
  const ratio = BigInt(Math.floor(Math.max(0, Math.min(1, capValue / totalValue)) * Number(SCALE)));
  return balance * ratio / SCALE;
}
