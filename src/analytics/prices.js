import { spotToken1PerToken0 } from './liquidity.js';

export function buildUsdPriceMap(pools, usdgAddress, options = {}) {
  const anchor = String(usdgAddress || '').toLowerCase();
  const records = new Map([[anchor, {
    priceUsd: 1,
    bottleneckTvlUsd: Number.POSITIVE_INFINITY,
    hops: 0,
    path: []
  }]]);
  const edges = [];
  const tokenAddresses = new Set([anchor]);

  for (const pool of pools || []) {
    if (!pool?.state || !pool.token0?.address || !pool.token1?.address) continue;
    if (pool.token0.decimals == null || pool.token1.decimals == null) continue;
    if (pool.state.paused === true) continue;
    const token0 = String(pool.token0.address).toLowerCase();
    const token1 = String(pool.token1.address).toLowerCase();
    if (token0 === token1) continue;
    const spot = spotToken1PerToken0(
      pool.state.sqrtPriceX96,
      pool.token0.decimals,
      pool.token1.decimals
    );
    if (!(spot > 0) || !Number.isFinite(spot)) continue;

    const poolId = String(pool.id || `${token0}/${token1}`).toLowerCase();
    const tvlUsd = poolTvlUsd(options.fablesStats, poolId);
    const pair = `${pool.token0.symbol || token0}/${pool.token1.symbol || token1}`;
    edges.push({
      poolId,
      pair,
      tvlUsd,
      token0,
      token1,
      token1PerToken0: spot
    });
    tokenAddresses.add(token0);
    tokenAddresses.add(token1);
  }
  edges.sort((a, b) => a.poolId.localeCompare(b.poolId)
    || a.token0.localeCompare(b.token0)
    || a.token1.localeCompare(b.token1));

  // Resolve one best priced route per token. The route with the highest
  // minimum pool TVL wins; hop count and pool IDs make ties deterministic.
  // Working from a frozen pass prevents registry order from affecting prices.
  for (let pass = 0; pass < tokenAddresses.size; pass += 1) {
    const next = new Map(records);
    let changed = false;
    for (const edge of edges) {
      const from0 = records.get(edge.token0);
      if (from0) {
        changed = consider(next, edge.token1, extend(from0, edge, edge.token0, edge.token1, 1 / edge.token1PerToken0)) || changed;
      }
      const from1 = records.get(edge.token1);
      if (from1) {
        changed = consider(next, edge.token0, extend(from1, edge, edge.token1, edge.token0, edge.token1PerToken0)) || changed;
      }
    }
    records.clear();
    for (const [address, record] of next) records.set(address, record);
    if (!changed) break;
  }

  const prices = new Map([...records].map(([address, record]) => [address, record.priceUsd]));
  const sources = new Map([...records].map(([address, record]) => {
    const last = record.path.at(-1) || null;
    return [address, {
      priceUsd: record.priceUsd,
      poolId: last?.poolId || null,
      pair: last?.pair || null,
      tvlUsd: last?.tvlUsd ?? null,
      bottleneckTvlUsd: Number.isFinite(record.bottleneckTvlUsd) ? record.bottleneckTvlUsd : null,
      hops: record.hops,
      pathPoolIds: record.path.map((item) => item.poolId),
      pathPairs: record.path.map((item) => item.pair)
    }];
  }));
  Object.defineProperty(prices, 'sources', { value: sources, enumerable: false });
  return prices;
}

export function usdValue(amount, tokenAddress, prices) {
  const price = prices.get(tokenAddress.toLowerCase());
  return Number.isFinite(price) ? amount * price : null;
}

function extend(record, edge, from, to, multiplier) {
  return {
    priceUsd: record.priceUsd * multiplier,
    bottleneckTvlUsd: Math.min(record.bottleneckTvlUsd, edge.tvlUsd),
    hops: record.hops + 1,
    path: [...record.path, {
      poolId: edge.poolId,
      pair: edge.pair,
      tvlUsd: edge.tvlUsd,
      from,
      to
    }]
  };
}

function consider(records, address, candidate) {
  if (!(candidate.priceUsd > 0) || !Number.isFinite(candidate.priceUsd)) return false;
  const existing = records.get(address);
  if (existing && !isBetter(candidate, existing)) return false;
  records.set(address, candidate);
  return true;
}

function isBetter(candidate, existing) {
  if (candidate.bottleneckTvlUsd !== existing.bottleneckTvlUsd) {
    return candidate.bottleneckTvlUsd > existing.bottleneckTvlUsd;
  }
  if (candidate.hops !== existing.hops) return candidate.hops < existing.hops;
  return candidate.path.map((item) => item.poolId).join('\u0000')
    < existing.path.map((item) => item.poolId).join('\u0000');
}

function poolTvlUsd(fablesStats, poolId) {
  const stats = fablesStats?.pools;
  const poolStats = stats instanceof Map
    ? (stats.get(poolId) || null)
    : (stats && typeof stats === 'object'
      ? (stats[poolId] || Object.entries(stats).find(([key]) => key.toLowerCase() === poolId)?.[1] || null)
      : null);
  const tvlUsd = Number(poolStats?.tvlUsd);
  return Number.isFinite(tvlUsd) && tvlUsd > 0 ? tvlUsd : 0;
}
