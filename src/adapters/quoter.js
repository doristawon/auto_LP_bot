import { Interface, formatUnits, parseUnits } from 'ethers';
import { V4_QUOTER_ABI } from '../abi.js';
import { UNISWAP_V4_QUOTER } from '../constants.js';
import { buildV4PathKeys } from '../execution/investment-target.js';
import { poolKeyArgs } from './fables.js';

const iface = new Interface(V4_QUOTER_ABI);
const MAX_UINT128 = (1n << 128n) - 1n;

export class V4QuoterAdapter {
  constructor(provider, address = UNISWAP_V4_QUOTER) {
    this.provider = provider;
    this.address = address;
  }

  async quoteExactInputSingle(pool, tokenInIndex, amountIn, slippageBps = 50) {
    if (![0, 1].includes(tokenInIndex)) throw new Error('tokenInIndex must be 0 or 1');
    const tokenIn = tokenInIndex === 0 ? pool.token0 : pool.token1;
    if (tokenIn.decimals == null) throw new Error('Token decimals unavailable for quote');
    const rawAmountIn = parseUnits(decimalString(amountIn, tokenIn.decimals), tokenIn.decimals);
    return this.quoteExactInputSingleRaw(pool, tokenInIndex, rawAmountIn, slippageBps);
  }

  async quoteExactInputSingleRaw(pool, tokenInIndex, rawAmountIn, slippageBps = 50) {
    if (![0, 1].includes(tokenInIndex)) throw new Error('tokenInIndex must be 0 or 1');
    const tokenIn = tokenInIndex === 0 ? pool.token0 : pool.token1;
    const tokenOut = tokenInIndex === 0 ? pool.token1 : pool.token0;
    if (tokenIn.decimals == null || tokenOut.decimals == null) throw new Error('Token decimals unavailable for quote');
    rawAmountIn = BigInt(rawAmountIn);
    if (rawAmountIn <= 0n || rawAmountIn > MAX_UINT128) throw new Error('Quote amount must fit uint128');
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
