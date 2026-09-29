import { Interface, concat, formatUnits, parseUnits, toBeHex } from 'ethers';
import { V4_QUOTER_ABI } from '../abi.js';
import { UNISWAP_V4_QUOTER, ZERO_ADDRESS } from '../constants.js';
import { buildV4PathKeys } from '../execution/investment-target.js';
import { poolKeyArgs } from './fables.js';
import { candidateSwapPools } from '../execution/swap-routes.js';
import { MOO_V3_FACTORY, MOO_V3_QUOTER, MOO_TOKENS } from '../execution/moo-pool-catalog.js';
import { quotePriceImpactBps } from '../execution/exact-rebalance.js';

const iface = new Interface(V4_QUOTER_ABI);
const v3Iface = new Interface([
  'function quoteExactInput(bytes path,uint256 amountIn) returns(uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)'
]);
const factoryIface = new Interface(['function getPool(address,address,uint24) view returns(address)']);
const MAX_UINT128 = (1n << 128n) - 1n;

export class V4QuoterAdapter {
  constructor(provider, address = UNISWAP_V4_QUOTER, externalRoutesEnabled = false,
    routeCostContext = {}, v3ValidatedPools = null) {
    this.provider = provider;
    this.address = address;
    this.externalRoutesEnabled = externalRoutesEnabled;
    this.routeCostContext = routeCostContext;
    this.v3ValidatedPools = v3ValidatedPools || new Map();
    this.v3PendingPools = new Map();
  }

  async quoteExactInputSingle(pool, tokenInIndex, amountIn, slippageBps = 50) {
    if (![0, 1].includes(tokenInIndex)) throw new Error('tokenInIndex must be 0 or 1');
    const tokenIn = tokenInIndex === 0 ? pool.token0 : pool.token1;
    if (tokenIn.decimals == null) throw new Error('Token decimals unavailable for quote');
    const rawAmountIn = parseUnits(decimalString(amountIn, tokenIn.decimals), tokenIn.decimals);
    return this.quoteExactInputSingleRaw(pool, tokenInIndex, rawAmountIn, slippageBps);
  }

  async selectSamePairSwapPool(pool, tokenInIndex, rawAmountIn, slippageBps = 50, options = {}) {
    const candidates = this.externalRoutesEnabled ? candidateSwapPools(pool) : [pool];
    const results = await Promise.allSettled(candidates.map((candidate) =>
      this.quoteExactInputSingleRaw(candidate, tokenInIndex, rawAmountIn, slippageBps)));
    const viable = [];
    for (let index = 0; index < candidates.length; index++) {
      const result = results[index];
      if (result.status !== 'fulfilled') continue;
      const quote = result.value;
      if (BigInt(quote.rawAmountOut) <= 0n || BigInt(quote.minRawAmountOut) <= 0n) continue;
      if (options.spotSqrtPriceX96 && Number.isFinite(Number(options.maxPriceImpactBps))) {
        const impact = quotePriceImpactBps(rawAmountIn, quote.rawAmountOut,
          tokenInIndex, options.spotSqrtPriceX96);
        if (impact > BigInt(options.maxPriceImpactBps)) continue;
      }
      viable.push({ pool: candidates[index], quote,
        netUsd: this.netOutputUsd(candidates[index], quote, tokenInIndex) });
    }
    if (!viable.length) {
      const primary = results[0];
      if (primary.status === 'rejected') throw primary.reason;
      throw new Error('No MOO/ORBIO swap route meets the quote and price-impact limits');
    }
    const baseline = viable.find((entry) => entry.pool === pool);
    const priced = viable.every((entry) => Number.isFinite(entry.netUsd));
    viable.sort((a, b) => priced
      ? b.netUsd - a.netUsd
      : compareRawOutput(b.quote.rawAmountOut, a.quote.rawAmountOut));
    let winner = viable[0];
    if (baseline && winner !== baseline) {
      const material = priced
        ? winner.netUsd >= baseline.netUsd + Math.max(0.01, Math.abs(baseline.netUsd) * 0.0005)
        : BigInt(winner.quote.rawAmountOut) * 10_000n
          >= BigInt(baseline.quote.rawAmountOut) * 10_020n;
      if (!material) winner = baseline;
    }
    return { pool: winner.pool, quote: winner.quote };
  }

  netOutputUsd(pool, quote, tokenInIndex) {
    const tokenOut = tokenInIndex === 0 ? pool.token1 : pool.token0;
    const price = Number(this.routeCostContext.getUsdPrice?.(tokenOut.address));
    const ethUsd = Number(this.routeCostContext.getUsdPrice?.(ZERO_ADDRESS)
      || this.routeCostContext.getUsdPrice?.(MOO_TOKENS.WETH));
    const maxGasGwei = Number(this.routeCostContext.maxGasGwei);
    if (![price, ethUsd, maxGasGwei].every((value) => Number.isFinite(value) && value > 0)) return NaN;
    const outputUsd = Number(formatUnits(quote.rawAmountOut, tokenOut.decimals)) * price;
    const gasUsd = Number(quote.gasEstimate) * maxGasGwei * 1e-9 * ethUsd * 1.25;
    return outputUsd - gasUsd;
  }

  async validateV3Route(pool) {
    for (let hop = 0; hop < pool.v3.fees.length; hop++) {
      const tokenIn = pool.v3.tokens[hop];
      const tokenOut = pool.v3.tokens[hop + 1];
      const fee = pool.v3.fees[hop];
      const expected = pool.v3.poolAddresses[hop];
      const key = `${tokenIn}:${tokenOut}:${fee}`;
      if (this.v3ValidatedPools.get(key) === expected.toLowerCase()) continue;
      let pending = this.v3PendingPools.get(key);
      if (!pending) {
        pending = (async () => {
          const data = factoryIface.encodeFunctionData('getPool', [tokenIn, tokenOut, fee]);
          const result = await this.provider.call({ to: MOO_V3_FACTORY, data });
          const [actual] = factoryIface.decodeFunctionResult('getPool', result);
          if (actual.toLowerCase() !== expected.toLowerCase()) {
            throw new Error(`Pinned V3 pool contract mismatch: ${key}`);
          }
          this.v3ValidatedPools.set(key, expected.toLowerCase());
        })();
        this.v3PendingPools.set(key, pending);
      }
      try { await pending; } finally {
        if (this.v3PendingPools.get(key) === pending) this.v3PendingPools.delete(key);
      }
    }
  }

  async quoteV3ExactInputRaw(pool, tokenInIndex, rawAmountIn, slippageBps) {
    await this.validateV3Route(pool);
    const tokenIn = tokenInIndex === 0 ? pool.token0 : pool.token1;
    const tokenOut = tokenInIndex === 0 ? pool.token1 : pool.token0;
    const tokens = tokenInIndex === 0 ? pool.v3.tokens : [...pool.v3.tokens].reverse();
    const fees = tokenInIndex === 0 ? pool.v3.fees : [...pool.v3.fees].reverse();
    const path = concat(tokens.flatMap((address, index) =>
      index < fees.length ? [address, toBeHex(fees[index], 3)] : [address]));
    const data = v3Iface.encodeFunctionData('quoteExactInput', [path, rawAmountIn]);
    const response = await this.provider.call({ to: MOO_V3_QUOTER, data });
    const [rawAmountOut, , , gasEstimate] = v3Iface.decodeFunctionResult('quoteExactInput', response);
    const safeBps = Math.max(0, Math.min(10_000, Number(slippageBps)));
    const minRawAmountOut = BigInt(rawAmountOut) * BigInt(10_000 - safeBps) / 10_000n;
    return {
      quoter: MOO_V3_QUOTER, protocol: 'v3', routeId: pool.id, path,
      tokenIn: tokenIn.address, tokenOut: tokenOut.address,
      symbolIn: tokenIn.symbol, symbolOut: tokenOut.symbol,
      rawAmountIn: rawAmountIn.toString(), rawAmountOut: BigInt(rawAmountOut).toString(),
      minRawAmountOut: minRawAmountOut.toString(),
      amountIn: Number(formatUnits(rawAmountIn, tokenIn.decimals)),
      amountOut: Number(formatUnits(rawAmountOut, tokenOut.decimals)),
      minAmountOut: Number(formatUnits(minRawAmountOut, tokenOut.decimals)),
      slippageBps: safeBps, gasEstimate: BigInt(gasEstimate).toString(),
      zeroForOne: tokenInIndex === 0
    };
  }

  async quoteExactInputSingleRaw(pool, tokenInIndex, rawAmountIn, slippageBps = 50) {
    if (![0, 1].includes(tokenInIndex)) throw new Error('tokenInIndex must be 0 or 1');
    const tokenIn = tokenInIndex === 0 ? pool.token0 : pool.token1;
    const tokenOut = tokenInIndex === 0 ? pool.token1 : pool.token0;
    if (tokenIn.decimals == null || tokenOut.decimals == null) throw new Error('Token decimals unavailable for quote');
    rawAmountIn = BigInt(rawAmountIn);
    if (rawAmountIn <= 0n || rawAmountIn > MAX_UINT128) throw new Error('Quote amount must fit uint128');
    if (pool.protocol === 'v3') {
      return this.quoteV3ExactInputRaw(pool, tokenInIndex, rawAmountIn, slippageBps);
    }
    const params = [poolKeyArgs(pool), tokenInIndex === 0, rawAmountIn, '0x'];
    const data = iface.encodeFunctionData('quoteExactInputSingle', [params]);
    const raw = await this.provider.call({ to: this.address, data });
    const [rawAmountOut, gasEstimate] = iface.decodeFunctionResult('quoteExactInputSingle', raw);
    const safeBps = Math.max(0, Math.min(10_000, Number(slippageBps)));
    const minRawAmountOut = BigInt(rawAmountOut) * BigInt(10_000 - safeBps) / 10_000n;
    return {
      quoter: this.address,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      symbolIn: tokenIn.symbol,
      symbolOut: tokenOut.symbol,
      rawAmountIn: rawAmountIn.toString(),
      rawAmountOut: BigInt(rawAmountOut).toString(),
      minRawAmountOut: minRawAmountOut.toString(),
      amountIn: Number(formatUnits(rawAmountIn, tokenIn.decimals)),
      amountOut: Number(formatUnits(rawAmountOut, tokenOut.decimals)),
      minAmountOut: Number(formatUnits(minRawAmountOut, tokenOut.decimals)),
      slippageBps: safeBps,
      gasEstimate: BigInt(gasEstimate).toString(),
      zeroForOne: tokenInIndex === 0
    };
  }

  async quoteExactInputPathRaw(route, tokenIn, rawAmountIn, slippageBps = 50) {
    if (!Array.isArray(route) || route.length === 0) throw new Error('A non-empty Fables route is required');
    rawAmountIn = BigInt(rawAmountIn);
    if (rawAmountIn <= 0n || rawAmountIn > MAX_UINT128) throw new Error('Quote amount must fit uint128');
    const firstPool = route[0];
    const lastPool = route[route.length - 1];
    const inputAddress = String(tokenIn?.address || '').toLowerCase();
    const outputAddress = nextTokenAddress(firstPool, inputAddress);
    if (!outputAddress) throw new Error('Route input token does not belong to the first pool');
    let cursor = outputAddress;
    for (let index = 1; index < route.length; index++) {
      const next = nextTokenAddress(route[index], cursor);
      if (!next) throw new Error('Fables route token order is discontinuous');
      cursor = next;
    }
    const outputToken = [lastPool.token0, lastPool.token1]
      .find((token) => String(token.address).toLowerCase() === cursor);
    if (!outputToken || tokenIn.decimals == null || outputToken.decimals == null) {
      throw new Error('Route token metadata is unavailable');
    }
    const path = buildV4PathKeys(route, inputAddress);
    const data = iface.encodeFunctionData('quoteExactInput', [[tokenIn.address, path, rawAmountIn]]);
    const raw = await this.provider.call({ to: this.address, data });
    const [rawAmountOut, gasEstimate] = iface.decodeFunctionResult('quoteExactInput', raw);
    const safeBps = Math.max(0, Math.min(10_000, Number(slippageBps)));
    const minRawAmountOut = BigInt(rawAmountOut) * BigInt(10_000 - safeBps) / 10_000n;
    return {
      quoter: this.address,
      tokenIn: tokenIn.address,
      tokenOut: outputToken.address,
      symbolIn: tokenIn.symbol,
      symbolOut: outputToken.symbol,
      rawAmountIn: rawAmountIn.toString(),
      rawAmountOut: BigInt(rawAmountOut).toString(),
      minRawAmountOut: minRawAmountOut.toString(),
      amountIn: Number(formatUnits(rawAmountIn, tokenIn.decimals)),
      amountOut: Number(formatUnits(rawAmountOut, outputToken.decimals)),
      minAmountOut: Number(formatUnits(minRawAmountOut, outputToken.decimals)),
      slippageBps: safeBps,
      gasEstimate: BigInt(gasEstimate).toString(),
      path: route.map((pool) => String(pool.id))
    };
  }
}

function nextTokenAddress(pool, currencyIn) {
  const token0 = String(pool?.token0?.address || '').toLowerCase();
  const token1 = String(pool?.token1?.address || '').toLowerCase();
  if (currencyIn === token0) return token1;
  if (currencyIn === token1) return token0;
  return '';
}

function decimalString(value, decimals) {
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid quote amount');
  return value.toFixed(Math.min(decimals, 18)).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function compareRawOutput(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a > b ? 1 : a < b ? -1 : 0;
}
