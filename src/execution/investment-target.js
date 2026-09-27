export function rankAprPools({
  pools,
  stats,
  nowMs = Date.now(),
  maxStatsAgeMs = 5 * 60 * 1000,
  minTvlUsd = 30_000
}) {
  const observedAt = Number(stats?.observedAt || 0);
  if (!observedAt || nowMs - observedAt > maxStatsAgeMs || observedAt > nowMs + 30_000) return [];
  const eligible = [];
  for (const pool of pools || []) {
    const poolStats = stats?.pools?.get(String(pool.id).toLowerCase());
    const tvlUsd = Number(poolStats?.tvlUsd);
    const fees24hUsd = Number(poolStats?.fees24hUsd);
    const aprPct = Number(poolStats?.aprPct);
    if (pool.state?.paused !== false || BigInt(pool.state?.liquidity || 0) <= 0n) continue;
    if (![tvlUsd, fees24hUsd, aprPct].every(Number.isFinite)) continue;
    if (tvlUsd < minTvlUsd || fees24hUsd <= 0 || aprPct <= 0) continue;
    eligible.push({ pool, tvlUsd, fees24hUsd, aprPct, statsObservedAt: observedAt });
  }
  return eligible.sort((a, b) =>
    b.aprPct - a.aprPct || b.tvlUsd - a.tvlUsd || String(a.pool.id).localeCompare(String(b.pool.id))
  );
}

export function findV4Route(pools, tokenInAddress, tokenOutAddress, maxHops = 3) {
  const tokenIn = String(tokenInAddress || '').toLowerCase();
  const tokenOut = String(tokenOutAddress || '').toLowerCase();
  if (!tokenIn || !tokenOut) return null;
  if (tokenIn === tokenOut) return [];

  const queue = [{ token: tokenIn, path: [], usedPools: new Set([ ]), seenTokens: new Set([tokenIn]) }];
  while (queue.length) {
    const current = queue.shift();
    if (current.path.length >= maxHops) continue;
    const edges = (pools || [])
      .filter((pool) => pool.state?.paused === false && BigInt(pool.state?.liquidity || 0) > 0n)
      .filter((pool) => {
        const a = String(pool.token0?.address || '').toLowerCase();
        const b = String(pool.token1?.address || '').toLowerCase();
        return a === current.token || b === current.token;
      })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const pool of edges) {
      const poolId = String(pool.id).toLowerCase();
      if (current.usedPools.has(poolId)) continue;
      const token0 = String(pool.token0.address).toLowerCase();
      const token1 = String(pool.token1.address).toLowerCase();
      const nextToken = token0 === current.token ? token1 : token0;
      if (current.seenTokens.has(nextToken)) continue;
      const path = [...current.path, pool];
      if (nextToken === tokenOut) return path;
      queue.push({
        token: nextToken,
        path,
        usedPools: new Set([...current.usedPools, poolId]),
        seenTokens: new Set([...current.seenTokens, nextToken])
      });
    }
  }
  return null;
}

export function chooseInvestmentAnchor(sourceTokens, destinationPool, pools, maxHops = 3) {
  const anchors = [destinationPool?.token0, destinationPool?.token1].filter(Boolean);
  const uniqueTokens = new Map((sourceTokens || []).map((token) => [String(token.address).toLowerCase(), token]));
  const candidates = anchors.map((anchor) => {
    const address = String(anchor.address).toLowerCase();
    const routes = new Map();
    let score = 0;
    for (const [tokenAddress, token] of uniqueTokens) {
      if (tokenAddress === address) {
        routes.set(tokenAddress, []);
        continue;
      }
      const route = findV4Route(pools, tokenAddress, address, maxHops);
      if (!route) return null;
      routes.set(tokenAddress, route);
      score += route.length;
    }
    return { anchor, routes, score };
  }).filter(Boolean);
  candidates.sort((a, b) => a.score - b.score
    || String(a.anchor.address).toLowerCase().localeCompare(String(b.anchor.address).toLowerCase()));
  if (!candidates.length) throw new Error('目前錢包資產沒有可驗證的 Fables 路徑，保留原 LP 不撤出');
  return candidates[0];
}

export function buildV4PathKeys(route, tokenInAddress) {
  let currencyIn = String(tokenInAddress).toLowerCase();
  return (route || []).map((pool) => {
    const token0 = String(pool.token0.address).toLowerCase();
    const token1 = String(pool.token1.address).toLowerCase();
    if (currencyIn !== token0 && currencyIn !== token1) {
      throw new Error('兌換路徑的 token 順序不連續');
    }
    const intermediateCurrency = currencyIn === token0 ? pool.token1.address : pool.token0.address;
    currencyIn = String(intermediateCurrency).toLowerCase();
    return [
      intermediateCurrency,
      Number(pool.key.fee),
      Number(pool.key.tickSpacing),
      pool.key.hooks,
      '0x'
    ];
  });
}
