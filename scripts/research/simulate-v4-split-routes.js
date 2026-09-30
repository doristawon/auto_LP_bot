// Read-only MOO/ORBIO split-route research on Robinhood Chain.
// Does not load .env, create a signer, use a wallet, approve tokens, or send transactions.
import {
  FetchRequest, Interface, JsonRpcProvider, concat, formatUnits, parseUnits, toBeHex
} from 'ethers';
import { REGISTRY_ABI, V4_QUOTER_ABI } from '../../src/abi.js';
import {
  CHAIN_ID, DEFAULT_RPC_URL, FABLES_REGISTRY, UNISWAP_V4_QUOTER
} from '../../src/constants.js';
import { FablesAdapter, poolKeyArgs } from '../../src/adapters/fables.js';
import { candidateSwapPools } from '../../src/execution/swap-routes.js';
import {
  MOO_TOKENS, MOO_V3_FACTORY, MOO_V3_QUOTER,
} from '../../src/execution/moo-pool-catalog.js';

const USDG = MOO_TOKENS.USDG;
const MOO = MOO_TOKENS.MOO;
const ORBIO = '0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3';
const MOO_SOURCE = '0x6b187fad6ca2dcb913f2451c5d5e24d3d77b9d09ce272c2c99f64dac672bc485';
const ORBIO_SOURCE = '0xc761f7de760d2b73cc3e3cc3d729916a4ed2f7fc6b0aa3872e2ced4258961e92';
const SIMULATED_CALLER = '0x0000000000000000000000000000000000000001';
const SLIPPAGE_BPS = 50;
const SIZES_USD = [1000, 2000];
const V4_IFACE = new Interface(V4_QUOTER_ABI);
const V3_IFACE = new Interface([
  'function quoteExactInput(bytes path,uint256 amountIn) returns(uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)'
]);
const FACTORY_IFACE = new Interface([
  'function getPool(address,address,uint24) view returns(address)'
]);
const rpc = new FetchRequest(DEFAULT_RPC_URL);
rpc.timeout = 8_000;
rpc.retryFunc = async () => false;
const provider = new JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
// Keep this optional research run from bursting requests against the public RPC.
const send = provider.send.bind(provider);
let requestQueue = Promise.resolve();
let nextRequestAt = 0;
provider.send = (method, params) => {
  const task = requestQueue.then(async () => {
    const wait = nextRequestAt - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    nextRequestAt = Date.now() + 1250;
    return send(method, params);
  });
  requestQueue = task.catch(() => {});
  return task;
};

try {
const chainId = BigInt(await provider.send('eth_chainId', []));
if (chainId !== BigInt(CHAIN_ID)) throw new Error(`Expected chain ${CHAIN_ID}, got ${chainId}`);
const block = await provider.getBlockNumber();
const blockTag = `0x${block.toString(16)}`;
const atBlock = { call: (request) => provider.call({ ...request, blockTag }) };
const registry = new Interface(REGISTRY_ABI);
const registryData = registry.encodeFunctionData('activePools');
const registryRaw = await atBlock.call({ to: FABLES_REGISTRY, data: registryData });
const [registryRows] = registry.decodeFunctionResult('activePools', registryRaw);
const targets = new Map([[MOO_SOURCE, 'MOO'], [ORBIO_SOURCE, 'ORBIO']]);
const adapter = new FablesAdapter(atBlock, { registryAddress: FABLES_REGISTRY });
const sourcePools = new Map();
for (const entry of registryRows) {
  const id = String(entry.id).toLowerCase();
  const symbol = targets.get(id);
  if (!symbol || !entry.active) continue;
  const pool = {
    id,
    key: {
      currency0: entry.key.currency0, currency1: entry.key.currency1,
      fee: Number(entry.key.fee), tickSpacing: Number(entry.key.tickSpacing), hooks: entry.key.hooks
    }
  };
  [pool.token0, pool.token1] = await Promise.all([
    adapter.getToken(pool.key.currency0), adapter.getToken(pool.key.currency1)
  ]);
  if (pool.token0.address.toLowerCase() !== USDG.toLowerCase()
    || pool.token1.address.toLowerCase() !== (symbol === 'MOO' ? MOO : ORBIO).toLowerCase()) {
    throw new Error(`${symbol} source PoolKey token order/address changed`);
  }
  pool.state = await adapter.readPoolState(pool);
  if (pool.state.paused || pool.state.sqrtPriceX96 <= 0n) throw new Error(`${symbol} source pool is unavailable`);
  sourcePools.set(symbol, pool);
}
if (sourcePools.size !== 2) throw new Error('Both pinned Fables source pools must be active in the registry');

const candidatesBySymbol = new Map();
for (const [symbol, source] of sourcePools) {
  const routes = candidateSwapPools(source).filter((route) => route === source
    || route.protocol === 'v4' || route.protocol === 'v3');
  const unique = new Map(routes.map((route) => [route.id.toLowerCase(), route]));
  candidatesBySymbol.set(symbol, [...unique.values()].map((route, i) => ({
    ...route,
    label: route === source ? 'Fables source' : route.protocol === 'v4'
      ? `Uniswap V4 fee=${route.key.fee}`
      : `Uniswap V3 fee=${route.v3.fees.map((fee) => `${(fee / 10000).toFixed(2)}%`).join(' + ')}`,
    routeIndex: i
  })));
}

// Pin each V3 hop to the expected Factory pool at the same block. A failed
// candidate is recorded and skipped; other route candidates continue.
const validation = [];
for (const routes of candidatesBySymbol.values()) {
  for (const route of routes.filter((item) => item.protocol === 'v3')) {
    try {
      for (let hop = 0; hop < route.v3.fees.length; hop++) {
        const [actual] = FACTORY_IFACE.decodeFunctionResult('getPool', await atBlock.call({
          to: MOO_V3_FACTORY,
          data: FACTORY_IFACE.encodeFunctionData('getPool', [
            route.v3.tokens[hop], route.v3.tokens[hop + 1], route.v3.fees[hop]
          ])
        }));
        if (actual.toLowerCase() !== route.v3.poolAddresses[hop].toLowerCase()) {
          throw new Error(`factory returned ${actual} for hop ${hop + 1}`);
        }
      }
      route.validated = true;
      validation.push({ routeId: route.id, status: 'validated' });
    } catch (error) {
      route.validated = false;
      route.validationError = String(error.message).slice(0, 180);
      validation.push({ routeId: route.id, status: 'unavailable', error: route.validationError });
    }
  }
}

const quoteRequests = [];
const outputRows = [];
for (const [symbol, source] of sourcePools) {
  const routes = candidatesBySymbol.get(symbol);
  const usdPerTarget = spotUsdPerToken(source);
  for (const direction of ['buy', 'sell']) {
    const tokenInIndex = direction === 'buy' ? 0 : 1;
    const tokenIn = tokenInIndex === 0 ? source.token0 : source.token1;
    for (const sizeUsd of SIZES_USD) {
      const totalRaw = direction === 'buy'
        ? parseUnits(sizeUsd.toFixed(6), tokenIn.decimals)
        : parseUnits((sizeUsd / usdPerTarget).toFixed(Math.min(tokenIn.decimals, 12)), tokenIn.decimals);
      for (const splitCount of [1, 2, 3]) {
        const rawAmountIn = totalRaw / BigInt(splitCount);
        for (const route of routes.filter((item) => item.validated !== false)) {
          const quote = buildQuoteRequest(route, tokenInIndex, rawAmountIn);
          quoteRequests.push({
            symbol, direction, sizeUsd, splitCount, route, rawAmountIn,
            tokenIn, tokenOut: tokenInIndex === 0 ? source.token1 : source.token0,
            data: quote.data, iface: quote.iface, functionName: quote.functionName,
            routeId: route.id, protocol: route.protocol || 'v4', label: route.label
          });
        }
      }
    }
  }
}

// A small V3 WETH->USDG quote supplies a same-chain ETH/USDG conversion for gas context.
const wethUsdPath = concat([
  MOO_TOKENS.WETH, toBeHex(100, 3), USDG
]);
quoteRequests.push({
  symbol: 'GAS', direction: 'eth-to-usdg', sizeUsd: null, splitCount: 1,
  route: null, rawAmountIn: parseUnits('0.1', 18), tokenIn: { symbol: 'WETH', decimals: 18 },
  tokenOut: { symbol: 'USDG', decimals: 6 }, data: V3_IFACE.encodeFunctionData(
    'quoteExactInput', [wethUsdPath, parseUnits('0.1', 18)]
  ), iface: V3_IFACE, functionName: 'quoteExactInput', routeId: 'v3:usdg-weth-100',
  protocol: 'v3', label: 'WETH/USDG gas conversion'
});

const responses = await simulateQuoteCalls(quoteRequests, blockTag);
for (let i = 0; i < quoteRequests.length; i++) {
  const request = quoteRequests[i];
  const result = responses[i];
  if (result?.status !== '0x1') {
    outputRows.push({ ...request, status: 'unavailable', error: safeError(result) });
    continue;
  }
  try {
    const decoded = request.iface.decodeFunctionResult(request.functionName, result.returnData);
    const rawOut = BigInt(decoded[0]);
    const gasEstimate = BigInt(decoded[request.protocol === 'v3' ? 3 : 1]);
    outputRows.push({
      symbol: request.symbol, direction: request.direction, sizeUsd: request.sizeUsd,
      splitCount: request.splitCount, routeId: request.routeId, protocol: request.protocol,
      label: request.label, rawAmountIn: request.rawAmountIn.toString(),
      amountIn: formatUnits(request.rawAmountIn, request.tokenIn.decimals),
      tokenIn: request.tokenIn.symbol, rawAmountOut: rawOut.toString(),
      amountOut: formatUnits(rawOut, request.tokenOut.decimals), tokenOut: request.tokenOut.symbol,
      minRawAmountOut: (rawOut * BigInt(10_000 - SLIPPAGE_BPS) / 10_000n).toString(),
      minOut: formatUnits(rawOut * BigInt(10_000 - SLIPPAGE_BPS) / 10_000n, request.tokenOut.decimals),
      slippageBps: SLIPPAGE_BPS, gasEstimate: gasEstimate.toString(), status: 'quoted'
    });
  } catch (error) {
    outputRows.push({ ...request, status: 'unavailable', error: String(error.message).slice(0, 180) });
  }
}

const gasReference = outputRows.find((row) => row.symbol === 'GAS' && row.status === 'quoted');
const gasPriceWei = BigInt(await provider.send('eth_gasPrice', []));
const ethPriceUsd = gasReference
  ? Number(gasReference.amountOut) / 0.1
  : null;
const summary = [];
for (const symbol of ['MOO', 'ORBIO']) {
  for (const direction of ['buy', 'sell']) {
    for (const sizeUsd of SIZES_USD) {
      const candidates = candidatesBySymbol.get(symbol);
      const rowsFor = (splitCount) => outputRows.filter((row) => row.symbol === symbol
        && row.direction === direction && row.sizeUsd === sizeUsd
        && row.splitCount === splitCount && row.status === 'quoted');
      const tokenPriceUsd = spotUsdPerToken(sourcePools.get(symbol));
      const outputDecimals = direction === 'sell' ? 6 : sourcePools.get(symbol).token1.decimals;
      const inputToken = direction === 'buy' ? sourcePools.get(symbol).token0 : sourcePools.get(symbol).token1;
      const totalRawInput = direction === 'buy'
        ? parseUnits(sizeUsd.toFixed(6), inputToken.decimals)
        : parseUnits((sizeUsd / tokenPriceUsd).toFixed(Math.min(inputToken.decimals, 12)), inputToken.decimals);
      const outputValueUsd = (row) => Number(formatUnits(BigInt(row.rawAmountOut), outputDecimals))
        * (direction === 'sell' ? 1 : tokenPriceUsd);
      const quoteGasUsd = (gas) => ethPriceUsd == null || !Number.isFinite(ethPriceUsd)
        ? null : Number(BigInt(gas)) * Number(gasPriceWei) / 1e18 * ethPriceUsd;
      const singles = rowsFor(1).sort((a, b) => {
        const gasA = quoteGasUsd(a.gasEstimate);
        const gasB = quoteGasUsd(b.gasEstimate);
        const netA = outputValueUsd(a) - (gasA ?? 0);
        const netB = outputValueUsd(b) - (gasB ?? 0);
        return netB - netA;
      });
      const bestSingle = singles[0] || null;
      const splits = [];
      for (const splitCount of [2, 3]) {
        const byRoute = new Map(rowsFor(splitCount).map((row) => [row.routeId.toLowerCase(), row]));
        const groups = combinations(candidates, splitCount);
        for (const group of groups) {
          if (!poolDisjoint(group)) continue;
          const legs = group.map((route) => byRoute.get(route.id.toLowerCase()));
          if (legs.some((leg) => !leg)) continue;
          const rawOutput = legs.reduce((sum, leg) => sum + BigInt(leg.rawAmountOut), 0n);
          const outToken = legs[0].tokenOut;
          const quoterGas = legs.reduce((sum, leg) => sum + BigInt(leg.gasEstimate), 0n);
          const bestSingleGas = BigInt(bestSingle?.gasEstimate || 0);
          const outputUsd = Number(formatUnits(rawOutput, outputDecimals))
            * (direction === 'sell' ? 1 : tokenPriceUsd);
          const bestSingleOutputUsd = bestSingle ? outputValueUsd(bestSingle) : null;
          const extraQuoterGasUsd = ethPriceUsd == null ? null
            : Number(quoterGas - bestSingleGas) * Number(gasPriceWei) / 1e18 * ethPriceUsd;
          const separateTxIntrinsicGasUsd = ethPriceUsd == null ? null
            : 21_000 * (splitCount - 1) * Number(gasPriceWei) / 1e18 * ethPriceUsd;
          splits.push({
            splitCount, routes: group.map((route) => route.label),
            perLegAmountIn: legs[0].amountIn,
            totalRequestedAmountIn: formatUnits(totalRawInput, inputToken.decimals),
            unallocatedInputRemainderRawUnits: String(totalRawInput % BigInt(splitCount)),
            grossOutput: formatUnits(rawOutput, outputDecimals), outputToken: outToken,
            vsBestSingleOutput: bestSingle
              ? formatUnits(rawOutput - BigInt(bestSingle.rawAmountOut), outputDecimals) : null,
            quoterGasEstimateSum: quoterGas.toString(),
            quoterGasOnlyOutputValueUsd: outputUsd,
            bestSingleOutputValueUsd: bestSingleOutputUsd,
            estimatedExtraQuoterGasUsdVsBestSingle: extraQuoterGasUsd,
            estimatedNetGainUsdVsBestSingleQuoterGasOnly: extraQuoterGasUsd == null || bestSingleOutputUsd == null
              ? null : outputUsd - bestSingleOutputUsd - extraQuoterGasUsd,
            separateTxIntrinsicGasLowerBound: String(21_000 * (splitCount - 1)),
            estimatedAdditionalSeparateTxIntrinsicGasUsd: separateTxIntrinsicGasUsd,
            estimatedNetGainUsdIfSeparateTransactions: extraQuoterGasUsd == null
              || separateTxIntrinsicGasUsd == null || bestSingleOutputUsd == null
              ? null : outputUsd - bestSingleOutputUsd - extraQuoterGasUsd - separateTxIntrinsicGasUsd,
            atomicRouterExtraGas: 'not simulated; Quoter gas is only a route-level estimate',
            legs: legs.map((leg) => ({ route: leg.label, amountIn: leg.amountIn,
              amountOut: leg.amountOut, minOut: leg.minOut, quoterGasEstimate: leg.gasEstimate }))
          });
        }
        splits.sort((a, b) => {
          const netA = a.estimatedNetGainUsdIfSeparateTransactions;
          const netB = b.estimatedNetGainUsdIfSeparateTransactions;
          if (Number.isFinite(netA) && Number.isFinite(netB) && netA !== netB) return netB - netA;
          const rawA = outputRawOf(a, outputDecimals);
          const rawB = outputRawOf(b, outputDecimals);
          return rawA > rawB ? -1 : rawA < rawB ? 1 : 0;
        });
      }
      summary.push({
        symbol, direction, sizeUsd, block, sourceSpotUsdPerToken: spotUsdPerToken(sourcePools.get(symbol)),
        bestSingle: bestSingle ? {
          route: bestSingle.label, amountIn: bestSingle.amountIn, tokenIn: bestSingle.tokenIn,
          amountOut: bestSingle.amountOut, minOut: bestSingle.minOut, tokenOut: bestSingle.tokenOut,
          outputValueUsd: outputValueUsd(bestSingle),
          quoterGasEstimate: bestSingle.gasEstimate,
          estimatedGasUsd: quoteGasUsd(bestSingle.gasEstimate),
          estimatedNetOutputValueUsd: quoteGasUsd(bestSingle.gasEstimate) == null
            ? null : outputValueUsd(bestSingle) - quoteGasUsd(bestSingle.gasEstimate)
        } : null,
        bestIndependentTwoPoolSplit: splits.filter((x) => x.splitCount === 2)[0] || null,
        bestIndependentThreePoolSplit: splits.filter((x) => x.splitCount === 3)[0] || null,
        independentSplitAlternatives: splits
      });
    }
  }
}

console.log(JSON.stringify({
  research: 'MOO/ORBIO exact-input quotes and equal independent-pool route splits',
  chainId: CHAIN_ID, block, blockTag, rpc: 'Robinhood public RPC',
  noWallet: true, noEnvLoaded: true, noTransactionsSent: true,
  slippageBps: SLIPPAGE_BPS,
  sourcePools: [...sourcePools.values()].map((pool) => ({
    id: pool.id, token0: pool.token0.address, token1: pool.token1.address,
    hook: pool.key.hooks, feeField: pool.key.fee, tickSpacing: pool.key.tickSpacing,
    currentTick: pool.state.tick, sqrtPriceX96: pool.state.sqrtPriceX96.toString(),
    usdPerToken1: spotUsdPerToken(pool)
  })),
  currentGasPriceWei: gasPriceWei.toString(), ethPriceUsdFromChainQuote: ethPriceUsd,
  gasConversionQuote: gasReference ? {
    amountIn: gasReference.amountIn, tokenIn: gasReference.tokenIn,
    amountOut: gasReference.amountOut, tokenOut: gasReference.tokenOut,
    gasEstimate: gasReference.gasEstimate
  } : null,
  directCandidateRoutes: Object.fromEntries([...candidatesBySymbol].map(([symbol, routes]) =>
    [symbol, routes.map((route) => ({ id: route.id, protocol: route.protocol || 'v4', label: route.label,
      validationStatus: route.protocol === 'v3'
        ? route.validated ? 'validated' : 'unavailable'
        : 'not-applicable', validationError: route.validationError,
      poolIds: route.protocol === 'v3' ? route.v3.poolAddresses : [route.id],
      sharedHops: route.protocol === 'v3' ? route.v3.tokens.length - 1 : 1 }))])),
  v3FactoryValidation: validation,
  results: summary,
  rawQuotes: outputRows.filter((row) => row.symbol !== 'GAS').map((row) => ({
    symbol: row.symbol, direction: row.direction, sizeUsd: row.sizeUsd,
    splitCount: row.splitCount, route: row.label, protocol: row.protocol,
    amountIn: row.amountIn, tokenIn: row.tokenIn, amountOut: row.amountOut,
    minOut: row.minOut, tokenOut: row.tokenOut, gasEstimate: row.gasEstimate,
    status: row.status, error: row.error
  }))
}, null, 2));
} finally {
  provider.destroy();
}

async function simulateQuoteCalls(requests, pinnedBlockTag) {
  const outputs = [];
  for (let offset = 0; offset < requests.length; offset += 8) {
    const chunk = requests.slice(offset, offset + 8);
    const calls = chunk.map((request) => ({
      from: SIMULATED_CALLER,
      to: request.protocol === 'v3' ? MOO_V3_QUOTER : UNISWAP_V4_QUOTER,
      data: request.data,
      gas: '0x1e8480', value: '0x0'
    }));
    const blocks = await provider.send('eth_simulateV1', [
      { blockStateCalls: [{ calls }], validation: false }, pinnedBlockTag
    ]);
    const results = blocks?.[0]?.calls;
    if (!Array.isArray(results) || results.length !== chunk.length) {
      throw new Error('eth_simulateV1 returned incomplete quote results');
    }
    outputs.push(...results);
  }
  return outputs;
}

function buildQuoteRequest(route, tokenInIndex, rawAmountIn) {
  if (route.protocol === 'v3') {
    const tokens = tokenInIndex === 0 ? route.v3.tokens : [...route.v3.tokens].reverse();
    const fees = tokenInIndex === 0 ? route.v3.fees : [...route.v3.fees].reverse();
    const path = concat(tokens.flatMap((address, index) =>
      index < fees.length ? [address, toBeHex(fees[index], 3)] : [address]));
    return { data: V3_IFACE.encodeFunctionData('quoteExactInput', [path, rawAmountIn]),
      iface: V3_IFACE, functionName: 'quoteExactInput' };
  }
  return {
    data: V4_IFACE.encodeFunctionData('quoteExactInputSingle', [[
      poolKeyArgs(route), tokenInIndex === 0, rawAmountIn, '0x'
    ]]),
    iface: V4_IFACE, functionName: 'quoteExactInputSingle'
  };
}

function spotUsdPerToken(pool) {
  const sqrt = Number(pool.state.sqrtPriceX96) / Number(1n << 96n);
  const rawToken1PerRawToken0 = sqrt * sqrt;
  const token1PerUsdG = rawToken1PerRawToken0 * (10 ** (pool.token0.decimals - pool.token1.decimals));
  return 1 / token1PerUsdG;
}

function combinations(values, size, start = 0, prefix = [], result = []) {
  if (prefix.length === size) { result.push(prefix); return result; }
  for (let i = start; i <= values.length - (size - prefix.length); i++) {
    combinations(values, size, i + 1, [...prefix, values[i]], result);
  }
  return result;
}

function poolDisjoint(routes) {
  const seen = new Set();
  for (const route of routes) {
    const ids = route.protocol === 'v3'
      ? route.v3.poolAddresses.map((address) => address.toLowerCase())
      : [route.id.toLowerCase()];
    for (const id of ids) {
      if (seen.has(id)) return false;
      seen.add(id);
    }
  }
  return true;
}

function safeError(result) {
  const data = String(result?.returnData || result?.error?.data || '');
  return String(result?.error?.message || (data ? `reverted ${data.slice(0, 10)}` : 'quote failed')).slice(0, 180);
}

function outputRawOf(split, decimals) {
  return parseUnits(split.grossOutput, decimals);
}
