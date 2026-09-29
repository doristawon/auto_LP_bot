import { AbiCoder, keccak256 } from 'ethers';

// Pool IDs are Uniswap v4 PoolKey hashes, not ERC-20 pool contracts.  Keep the
// token addresses and full keys pinned so an unrelated ticker cannot route funds.
const ROUTES = new Map([
  ['0x6b187fad6ca2dcb913f2451c5d5e24d3d77b9d09ce272c2c99f64dac672bc485', {
    token0: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    token1: '0xd9db30bb0d2b8d2eae3826a1372117e058791e18',
    id: '0x85a3cd053eecbcf2a67fd2c391479a2267e237edcea3acf19609b329e3a482fa',
    fee: 20000,
    tickSpacing: 200
  }],
  ['0xc761f7de760d2b73cc3e3cc3d729916a4ed2f7fc6b0aa3872e2ced4258961e92', {
    token0: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    token1: '0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3',
    id: '0xea9f200e13055b82f175f44f592c4c13dd8c9d9320a66487d3c5cd90d68550ef',
    fee: 8000,
    tickSpacing: 80
  }]
]);
const NO_HOOK = '0x0000000000000000000000000000000000000000';
const coder = AbiCoder.defaultAbiCoder();

export function externalSwapPool(pool) {
  const route = ROUTES.get(String(pool?.id || '').toLowerCase());
  if (!route) return null;
  if (String(pool.token0?.address || '').toLowerCase() !== route.token0
    || String(pool.token1?.address || '').toLowerCase() !== route.token1) return null;
  const key = {
    currency0: pool.token0.address,
    currency1: pool.token1.address,
    fee: route.fee,
    tickSpacing: route.tickSpacing,
    hooks: NO_HOOK
  };
  const calculated = keccak256(coder.encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
  ));
  if (calculated.toLowerCase() !== route.id) throw new Error('External swap PoolKey hash mismatch');
  return { id: route.id, key, token0: pool.token0, token1: pool.token1, swapOnly: true };
}
