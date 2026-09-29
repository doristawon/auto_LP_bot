import { AbiCoder, keccak256 } from 'ethers';
import { MOO_TOKENS, MOO_V3_POOLS, MOO_V4_POOLS } from './moo-pool-catalog.js';

// Exact token and source-pool pins prevent a ticker collision from routing funds.
// V3 entries are paths through pool contracts. V4 entries are PoolKey hashes.
const USDG = MOO_TOKENS.USDG.toLowerCase();
const MOO = MOO_TOKENS.MOO.toLowerCase();
const WETH = MOO_TOKENS.WETH.toLowerCase();
const ORBIO = '0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3';
const NO_HOOK = '0x0000000000000000000000000000000000000000';
const coder = AbiCoder.defaultAbiCoder();
const MOO_SOURCE = '0x6b187fad6ca2dcb913f2451c5d5e24d3d77b9d09ce272c2c99f64dac672bc485';
const ORBIO_SOURCE = '0xc761f7de760d2b73cc3e3cc3d729916a4ed2f7fc6b0aa3872e2ced4258961e92';

const ORBIO_V4 = [
  { id: '0xea9f200e13055b82f175f44f592c4c13dd8c9d9320a66487d3c5cd90d68550ef', fee: 8000, tickSpacing: 80 },
  { id: '0x0cec58aab07f067b5b334a2c63884abf418991957b46a54e3b89c1656836513e', fee: 28000, tickSpacing: 100 },
  { id: '0x4b83b47e62e9a5986a7badf9d2369911034a01c079532ede3c2819f332ac830a', fee: 50000, tickSpacing: 500 }
];

const v3Address = (pair, fee) => {
  const entry = MOO_V3_POOLS.find((pool) => pool.pair === pair && pool.fee === fee);
  if (!entry) throw new Error(`Pinned MOO V3 pool missing: ${pair} ${fee}`);
  return entry.address;
};
const V3_BRIDGES = [100, 500, 3000, 10000].map((fee) => ({
  fee, address: v3Address('USDG/WETH', fee)
}));

const ROUTES = new Map([
  [MOO_SOURCE, {
    token0: USDG, token1: MOO,
    v4: MOO_V4_POOLS.filter((p) => p.pair === 'USDG/MOO' && p.id !== MOO_SOURCE),
    // Direct V3 MOO/USDG and WETH/MOO 0.3% reverted in the same-block
    // inventory scan; do not spend RPC quota trying them at every swap.
    v3: V3_BRIDGES.map((bridge) => ({
      tokens: [USDG, WETH, MOO], fees: [bridge.fee, 10000],
      poolAddresses: [bridge.address, v3Address('MOO/WETH', 10000)]
    }))
  }],
  [ORBIO_SOURCE, {
    token0: USDG, token1: ORBIO,
    v4: ORBIO_V4,
    v3: [
      { tokens: [USDG, ORBIO], fees: [10000],
        poolAddresses: ['0x75Ee717303F5212CC1bE3C52ea21f7128954902e'] },
      ...V3_BRIDGES.filter(({ fee }) => [100, 500].includes(fee)).map((bridge) => ({
        tokens: [USDG, WETH, ORBIO], fees: [bridge.fee, 3000],
        poolAddresses: [bridge.address, '0x34f73F488309208b8Cb6012EB47FfEb086ca1c2D']
      }))
    ]
  }]
]);

function routeConfig(pool) {
  const config = ROUTES.get(String(pool?.id || '').toLowerCase());
  if (!config) return null;
  if (String(pool.token0?.address || '').toLowerCase() !== config.token0
    || String(pool.token1?.address || '').toLowerCase() !== config.token1) return null;
  return config;
}

function v4Pool(pool, entry) {
  const key = {
    currency0: pool.token0.address, currency1: pool.token1.address,
    fee: entry.fee, tickSpacing: entry.tickSpacing, hooks: entry.hooks || NO_HOOK
  };
  const id = keccak256(coder.encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
  ));
  if (id.toLowerCase() !== entry.id.toLowerCase()) throw new Error('External swap PoolKey hash mismatch');
  return { id: entry.id, key, token0: pool.token0, token1: pool.token1,
    protocol: 'v4', swapOnly: true };
}

function v3Pool(pool, entry) {
  if (entry.tokens[0] !== String(pool.token0.address).toLowerCase()
    || entry.tokens.at(-1) !== String(pool.token1.address).toLowerCase()
    || entry.poolAddresses.length !== entry.fees.length
    || entry.tokens.length !== entry.fees.length + 1) {
    throw new Error('Pinned V3 route does not match the Fables pair');
  }
  return {
    id: `v3:${entry.poolAddresses.map((address) => address.toLowerCase()).join(':')}`,
    token0: pool.token0, token1: pool.token1, protocol: 'v3',
    v3: entry, swapOnly: true
  };
}

export function candidateSwapPools(pool) {
  const config = routeConfig(pool);
  if (!config) return [pool];
  return [pool, ...config.v4.map((entry) => v4Pool(pool, entry)),
    ...config.v3.map((entry) => v3Pool(pool, entry))];
}

// Retained for callers that only need the original alternate V4 pool.
export function externalSwapPool(pool) {
  return candidateSwapPools(pool).find((candidate) => candidate !== pool && candidate.protocol === 'v4') || null;
}
