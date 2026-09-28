// Reserve wallet dust on the stablecoin side when the pair includes USDG.
// A non-USDG pair retains the existing symmetric dust behavior.
export function buildPairFundingScope(pool, balances, usdgAddress, dustBps = 0) {
  const bps = Number(dustBps);
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) {
    throw new Error('Pair funding dustBps must be an integer from 0 through 9999');
  }
  const raw0 = BigInt(balances.raw0);
  const raw1 = BigInt(balances.raw1);
  if (raw0 < 0n || raw1 < 0n) throw new Error('Pair funding balances must be non-negative');
  const stable = String(usdgAddress || '').toLowerCase();
  const stableIndex = stable && pool.token0.address.toLowerCase() === stable ? 0
    : stable && pool.token1.address.toLowerCase() === stable ? 1 : null;
  const reserve0 = stableIndex === 1 ? 0n : raw0 * BigInt(bps) / 10_000n;
  const reserve1 = stableIndex === 0 ? 0n : raw1 * BigInt(bps) / 10_000n;
  return {
    funding: { raw0: raw0 - reserve0, raw1: raw1 - reserve1 },
    dustRaw: { raw0: reserve0, raw1: reserve1 },
    stableIndex
  };
}
