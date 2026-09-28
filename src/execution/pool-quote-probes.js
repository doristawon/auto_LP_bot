import { parseUnits } from 'ethers';
import { quotePriceImpactBps } from './exact-rebalance.js';
import { ZERO_ADDRESS } from '../constants.js';

// One small, explicitly sized quote per pool. This is a displayed estimate,
// never an execution quote or a claim that the fee is fixed for every trade.
export async function probePoolSwapCosts({ pools, quoter, usdPrices, usdgAddress, sampleUsd = 10, slippageBps = 50 }) {
  const results = {};
  for (const pool of pools || []) {
    const id = String(pool.id).toLowerCase();
    const tokens = [pool.token0, pool.token1];
    const preferred = tokens.findIndex((token) =>
      token.address.toLowerCase() === String(usdgAddress).toLowerCase());
    const candidates = preferred >= 0 ? [preferred] : [0, 1];
    const tokenInIndex = candidates.find((index) =>
      tokens[index].address.toLowerCase() !== ZERO_ADDRESS
      && Number(usdPrices.get(tokens[index].address.toLowerCase()) || 0) > 0);
    const observedAt = Date.now();
    if (pool.state?.paused !== false || BigInt(pool.state?.liquidity || 0) <= 0n || tokenInIndex == null) {
      results[id] = { status: 'unavailable', observedAt, reason: 'pool inactive or no priced ERC20 input' };
      continue;
    }
    const tokenIn = tokens[tokenInIndex];
    const usdPrice = Number(usdPrices.get(tokenIn.address.toLowerCase()));
    const amount = sampleUsd / usdPrice;
    const decimals = Number(tokenIn.decimals);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      results[id] = { status: 'unavailable', observedAt, reason: 'invalid token price or decimals' };
      continue;
    }
    const rawAmountIn = parseUnits(amount.toFixed(Math.min(decimals, 12)), decimals);
    if (rawAmountIn <= 0n) {
      results[id] = { status: 'unavailable', observedAt, reason: 'sample rounds to zero' };
      continue;
    }
    try {
      const quote = await quoter.quoteExactInputSingleRaw(pool, tokenInIndex, rawAmountIn, slippageBps);
      const impactBps = quotePriceImpactBps(rawAmountIn, BigInt(quote.rawAmountOut),
        tokenInIndex, pool.state.sqrtPriceX96);
      results[id] = {
        status: 'quoted', observedAt, sampleUsd, tokenIn: tokenIn.symbol,
        tokenOut: tokens[1 - tokenInIndex].symbol, rawAmountIn: rawAmountIn.toString(),
        impactBps: Number(impactBps), approximatelyThreePercent: impactBps >= 250n && impactBps <= 350n
      };
    } catch {
      // Provider errors can embed private RPC URLs; never persist them in
      // dashboard state or return them through the local API.
      results[id] = { status: 'unavailable', observedAt, reason: '報價暫時不可用' };
    }
  }
  return results;
}
