// Read-only same-block quotes. No .env, wallet, approvals, or transactions.
import { Contract, JsonRpcProvider, formatUnits, parseUnits } from 'ethers';
import { REGISTRY_ABI } from '../abi.js';
import { CHAIN_ID, DEFAULT_RPC_URL, FABLES_REGISTRY } from '../constants.js';
import { FablesAdapter } from '../adapters/fables.js';
import { V4QuoterAdapter } from '../adapters/quoter.js';
import { candidateSwapPools } from '../execution/swap-routes.js';

const provider = new JsonRpcProvider(DEFAULT_RPC_URL, CHAIN_ID, { staticNetwork: true });
const block = await provider.getBlockNumber();
const atBlock = { call: (request) => provider.call({ ...request, blockTag: block }) };
const fables = new FablesAdapter(provider, { registryAddress: FABLES_REGISTRY });
const entries = await new Contract(FABLES_REGISTRY, REGISTRY_ABI, provider).activePools({ blockTag: block });
const targets = new Set([
  '0x6b187fad6ca2dcb913f2451c5d5e24d3d77b9d09ce272c2c99f64dac672bc485',
  '0xc761f7de760d2b73cc3e3cc3d729916a4ed2f7fc6b0aa3872e2ced4258961e92'
]);
for (const entry of entries.filter((item) => item.active && targets.has(String(item.id).toLowerCase()))) {
  const pool = {
    id: String(entry.id).toLowerCase(),
    key: {
      currency0: entry.key.currency0, currency1: entry.key.currency1,
      fee: Number(entry.key.fee), tickSpacing: Number(entry.key.tickSpacing),
      hooks: entry.key.hooks
    }
  };
  [pool.token0, pool.token1] = await Promise.all([
    fables.getToken(pool.key.currency0), fables.getToken(pool.key.currency1)
  ]);
  const state = await fables.readPoolState(pool);
  const quoter = new V4QuoterAdapter(atBlock, undefined, true);
  for (const [direction, amount] of [[0, '100'], [0, '1000'], [1, '10000']]) {
    const tokenIn = direction === 0 ? pool.token0 : pool.token1;
    const tokenOut = direction === 0 ? pool.token1 : pool.token0;
    const rawAmountIn = parseUnits(amount, tokenIn.decimals);
    const quotes = await Promise.allSettled(candidateSwapPools(pool).map(async (candidate) => ({
      route: candidate.id,
      protocol: candidate.protocol || 'v4-fables',
      quote: await quoter.quoteExactInputSingleRaw(candidate, direction, rawAmountIn, 50)
    })));
    const rows = quotes.map((result, index) => result.status === 'fulfilled'
      ? {
          route: result.value.route, protocol: result.value.protocol,
          out: Number(formatUnits(result.value.quote.rawAmountOut, tokenOut.decimals)),
          gas: result.value.quote.gasEstimate
        }
      : { route: candidateSwapPools(pool)[index].id, error: String(result.reason?.message || result.reason).slice(0, 120) });
    console.log(JSON.stringify({ block, pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      direction: `${tokenIn.symbol}->${tokenOut.symbol}`, amount,
      tick: state.tick, rows }));
  }
}
