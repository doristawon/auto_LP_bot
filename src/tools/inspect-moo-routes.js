// Read-only Robinhood mainnet route inventory. No wallet, .env, or signing.
import { Contract, JsonRpcProvider, concat, formatUnits, parseUnits, toBeHex } from 'ethers';
import { CHAIN_ID, DEFAULT_RPC_URL, UNISWAP_V4_QUOTER } from '../constants.js';
import { V4QuoterAdapter } from '../adapters/quoter.js';
import {
  MOO_TOKENS, MOO_V3_FACTORY, MOO_V3_POOLS, MOO_V3_QUOTER,
  MOO_V4_POOLS, MOO_V4_STATE_VIEW, mooV4PoolKey
} from '../execution/moo-pool-catalog.js';

const provider = new JsonRpcProvider(DEFAULT_RPC_URL, CHAIN_ID, { staticNetwork: true });
const block = await provider.getBlockNumber();
const atBlock = { call: (request) => provider.call({ ...request, blockTag: block }) };
const factory = new Contract(MOO_V3_FACTORY, [
  'function getPool(address,address,uint24) view returns(address)'
], provider);
const quoterV3 = new Contract(MOO_V3_QUOTER, [
  'function quoteExactInput(bytes path,uint256 amountIn) returns(uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)'
], provider);
const stateView = new Contract(MOO_V4_STATE_VIEW, [
  'function getLiquidity(bytes32) view returns(uint128)',
  'function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)'
], provider);
const quoterV4 = new V4QuoterAdapter(atBlock, UNISWAP_V4_QUOTER);
const token = {
  USDG: { address: MOO_TOKENS.USDG, symbol: 'USDG', decimals: 6 },
  MOO: { address: MOO_TOKENS.MOO, symbol: 'MOO', decimals: 18 }
};

const factoryPools = new Map();
for (const pair of ['MOO/WETH', 'MOO/USDG', 'USDG/WETH']) {
  const [a, b] = pair.split('/');
  for (const fee of [100, 500, 3000, 10000]) {
    const address = await factory.getPool(MOO_TOKENS[a], MOO_TOKENS[b], fee, { blockTag: block });
    if (/^0x0{40}$/i.test(address)) continue;
    const known = MOO_V3_POOLS.find((pool) => pool.pair === pair && pool.fee === fee);
    if (!known || known.address.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`Uncatalogued V3 pool: ${pair} ${fee} ${address}`);
    }
    factoryPools.set(`${pair}:${fee}`, address);
  }
}

const v3Pools = [];
for (const entry of MOO_V3_POOLS) {
  const [a, b] = entry.pair.split('/');
  const actual = factoryPools.get(`${entry.pair}:${entry.fee}`);
  if (!actual) throw new Error(`Catalogued V3 pool disappeared: ${entry.address}`);
  if (actual.toLowerCase() !== entry.address.toLowerCase()) {
    throw new Error(`V3 factory mismatch for ${entry.pair} ${entry.fee}: ${actual}`);
  }
  const pool = new Contract(entry.address, [
    'function token0() view returns(address)',
    'function token1() view returns(address)',
    'function fee() view returns(uint24)',
    'function liquidity() view returns(uint128)'
  ], provider);
  const [token0, token1, fee, liquidity] = await Promise.all([
    pool.token0({ blockTag: block }), pool.token1({ blockTag: block }),
    pool.fee({ blockTag: block }), pool.liquidity({ blockTag: block })
  ]);
  const expected = [MOO_TOKENS[a].toLowerCase(), MOO_TOKENS[b].toLowerCase()].sort();
  if (token0.toLowerCase() !== expected[0] || token1.toLowerCase() !== expected[1]
    || Number(fee) !== entry.fee) throw new Error(`V3 pool token/fee mismatch: ${entry.address}`);
  v3Pools.push({ ...entry, liquidity: liquidity.toString(), active: liquidity > 0n });
}

const v4Pools = [];
for (const entry of MOO_V4_POOLS) {
  const key = mooV4PoolKey(entry);
  const [liquidity, slot] = await Promise.all([
    stateView.getLiquidity(entry.id, { blockTag: block }),
    stateView.getSlot0(entry.id, { blockTag: block })
  ]);
  v4Pools.push({
    ...entry, currency0: key.currency0, currency1: key.currency1,
    liquidity: liquidity.toString(), active: liquidity > 0n,
    tick: Number(slot[1]), liveLpFee: Number(slot[3])
  });
}

function v3Path(direction, bridgeFee) {
  const addresses = direction === 'buy'
    ? [MOO_TOKENS.USDG, MOO_TOKENS.WETH, MOO_TOKENS.MOO]
    : [MOO_TOKENS.MOO, MOO_TOKENS.WETH, MOO_TOKENS.USDG];
  const fees = direction === 'buy' ? [bridgeFee, 10000] : [10000, bridgeFee];
  return concat([addresses[0], toBeHex(fees[0], 3), addresses[1], toBeHex(fees[1], 3), addresses[2]]);
}

const quotes = [];
for (const [direction, amounts] of [
  ['buy', ['1', '1000', '2000']],
  ['sell', ['100', '80000', '160000']]
]) {
  const input = direction === 'buy' ? 'USDG' : 'MOO';
  const output = direction === 'buy' ? 'MOO' : 'USDG';
  const index = direction === 'buy' ? 0 : 1;
  for (const amount of amounts) {
    const raw = parseUnits(amount, token[input].decimals);
    for (const entry of v4Pools.filter((pool) => pool.pair === 'USDG/MOO' && pool.active)) {
      try {
        const quote = await quoterV4.quoteExactInputSingleRaw({
          ...entry,
          token0: token.USDG, token1: token.MOO,
          key: mooV4PoolKey(entry)
        }, index, raw, 0);
        quotes.push({ direction, amount, input, output, route: entry.label,
          poolId: entry.id, outputAmount: quote.amountOut, gasEstimate: quote.gasEstimate });
      } catch (error) {
        quotes.push({ direction, amount, route: entry.label,
          poolId: entry.id, error: error.shortMessage || error.message });
      }
    }
    for (const bridge of v3Pools.filter((pool) => pool.pair === 'USDG/WETH' && pool.active)) {
      if (!v3Pools.some((pool) => pool.pair === 'MOO/WETH' && pool.fee === 10000 && pool.active)) break;
      try {
        const result = await quoterV3.quoteExactInput.staticCall(
          v3Path(direction, bridge.fee), raw, { blockTag: block }
        );
        quotes.push({ direction, amount, input, output,
          route: `V3 USDG/WETH ${bridge.fee / 10000}% + WETH/MOO 1%`,
          poolAddresses: [bridge.address, MOO_V3_POOLS.find((pool) => pool.pair === 'MOO/WETH' && pool.fee === 10000).address],
          outputAmount: Number(formatUnits(result.amountOut, token[output].decimals)),
          gasEstimate: result.gasEstimate.toString(),
          ticksCrossed: result.initializedTicksCrossedList.map(Number) });
      } catch (error) {
        quotes.push({ direction, amount, route: `V3 ${bridge.fee}+10000`,
          error: error.shortMessage || error.message });
      }
    }
  }
}

console.log(JSON.stringify({ chainId: CHAIN_ID, block, readOnly: true, tokens: MOO_TOKENS,
  v3Pools, v4Pools, quotes }, null, 2));
