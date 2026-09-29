// Read-only Universal Router V3 simulation. No .env, signing, or broadcasts.
import { JsonRpcProvider, parseUnits } from 'ethers';
import { DEFAULT_RPC_URL, CHAIN_ID } from '../constants.js';
import { MOO_TOKENS, MOO_V4_POOLS, mooV4PoolKey } from '../execution/moo-pool-catalog.js';
import { candidateSwapPools } from '../execution/swap-routes.js';
import { V4QuoterAdapter } from '../adapters/quoter.js';
import { UniversalRouterAdapter } from '../adapters/universal-router.js';
import { RebalanceExecutor } from '../adapters/executor.js';
import { simulateSequentialCalls } from '../execution/sequential-simulation.js';

const walletAddress = process.argv[2];
if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress || '')) {
  throw new Error('Pass a public wallet address as the only argument');
}
const provider = new JsonRpcProvider(DEFAULT_RPC_URL, CHAIN_ID, { staticNetwork: true });
const config = {
  walletAddress, chainId: CHAIN_ID, txDeadlineSec: 300,
  permit2ExpirationSec: 3600, externalSwapRoutesEnabled: true
};
const source = MOO_V4_POOLS[0];
const pool = {
  id: source.id, key: mooV4PoolKey(source),
  token0: { address: MOO_TOKENS.USDG, symbol: 'USDG', decimals: 6 },
  token1: { address: MOO_TOKENS.MOO, symbol: 'MOO', decimals: 18 }
};
const route = candidateSwapPools(pool).find((candidate) =>
  candidate.protocol === 'v3' && candidate.v3.fees[0] === 100);
const rawAmountIn = parseUnits('10', pool.token1.decimals);
const quote = await new V4QuoterAdapter(provider).quoteExactInputSingleRaw(route, 1, rawAmountIn, 50);
const request = new UniversalRouterAdapter(provider, config).buildV4ExactInputSingle({
  pool: route, quote, deadline: Math.floor(Date.now() / 1000) + 300
});
const executor = new RebalanceExecutor(provider, provider, config, null, null, null);
const approvals = await executor.buildTopUpApprovalRequests(pool,
  { direction: '1_to_0', tokenIn: 1, rawAmountIn },
  { amount0Max: 0n, amount1Max: 0n });
const calls = [
  ...approvals.map(({ tx }) => ({ to: tx.to, data: tx.data, value: 0n, gasLimit: 300_000 })),
  { to: request.router, data: request.data, value: 0n, gasLimit: 1_500_000 }
];
const receipts = await simulateSequentialCalls(provider, { walletAddress, chainId: CHAIN_ID, calls });
console.log(JSON.stringify({ ok: true, protocol: request.protocol, commands: request.commands,
  path: request.path, approvalCalls: approvals.length,
  simulatedCalls: receipts.length, minRawAmountOut: quote.minRawAmountOut }));
