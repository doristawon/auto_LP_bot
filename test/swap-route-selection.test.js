import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, parseUnits } from 'ethers';
import { candidateSwapPools } from '../src/execution/swap-routes.js';
import { MOO_TOKENS, MOO_V4_POOLS, mooV4PoolKey,
  MOO_V3_FACTORY, MOO_V3_QUOTER } from '../src/execution/moo-pool-catalog.js';
import { V4QuoterAdapter } from '../src/adapters/quoter.js';
import { UniversalRouterAdapter } from '../src/adapters/universal-router.js';
import { UNIVERSAL_ROUTER_ABI } from '../src/abi.js';
import { ZERO_ADDRESS } from '../src/constants.js';

const pool = {
  id: MOO_V4_POOLS[0].id, key: mooV4PoolKey(MOO_V4_POOLS[0]),
  token0: { address: MOO_TOKENS.USDG, symbol: 'USDG', decimals: 6 },
  token1: { address: MOO_TOKENS.MOO, symbol: 'MOO', decimals: 18 }
};
const routes = candidateSwapPools(pool);
const v3 = routes.find((route) => route.protocol === 'v3');
const external = routes.find((route) => route.protocol === 'v4');

test('external paths require both the pinned source PoolId and exact token contracts', () => {
  const impostor = { ...pool, token1: { ...pool.token1,
    address: '0x0000000000000000000000000000000000000001' } };
  assert.deepEqual(candidateSwapPools(impostor), [impostor]);
  const otherPool = { ...pool, id: '0x' + '99'.repeat(32) };
  assert.deepEqual(candidateSwapPools(otherPool), [otherPool]);
});

test('route selection prices extra gas and requires a material net advantage', async () => {
  const adapter = new V4QuoterAdapter(null, undefined, true, {
    getUsdPrice: (address) => address === ZERO_ADDRESS ? 3000 : 1,
    maxGasGwei: 1
  });
  let alternateOutput = '100.4';
  adapter.quoteExactInputSingleRaw = async (candidate) => {
    if (candidate.id !== pool.id && candidate.id !== v3.id) throw new Error('unavailable');
    const baseline = candidate.id === pool.id;
    const output = parseUnits(baseline ? '100' : alternateOutput, 18).toString();
    return { rawAmountOut: output, minRawAmountOut: output,
      gasEstimate: baseline ? '50000' : '300000' };
  };
  assert.equal((await adapter.selectSamePairSwapPool(pool, 0, 100_000_000n)).pool.id, pool.id);
  alternateOutput = '102';
  assert.equal((await adapter.selectSamePairSwapPool(pool, 0, 100_000_000n)).pool.id, v3.id);
});

test('failed and excessive-impact routes cannot prevent selection of a valid alternate', async () => {
  const adapter = new V4QuoterAdapter(null, undefined, true);
  adapter.quoteExactInputSingleRaw = async (candidate, direction, raw) => {
    assert.equal(direction, 1);
    assert.equal(raw, 10_000n);
    if (candidate.id !== pool.id && candidate.id !== external.id) throw new Error('unavailable');
    const output = candidate.id === pool.id ? '9700' : '9900';
    return { rawAmountOut: output, minRawAmountOut: output };
  };
  const selected = await adapter.selectSamePairSwapPool(pool, 1, 10_000n, 50,
    { spotSqrtPriceX96: 2n ** 96n, maxPriceImpactBps: 150 });
  assert.equal(selected.pool.id, external.id);
  await assert.rejects(() => adapter.selectSamePairSwapPool(pool, 1, 10_000n, 50,
    { spotSqrtPriceX96: 2n ** 96n, maxPriceImpactBps: 50 }), /No MOO\/ORBIO swap route/);
});

test('V3 forward and reverse quotes preserve pinned hops, recipient and exact minimum output', async () => {
  const factory = new Interface(['function getPool(address,address,uint24) view returns(address)']);
  const quoteAbi = new Interface([
    'function quoteExactInput(bytes,uint256) returns(uint256,uint160[],uint32[],uint256)'
  ]);
  const expectedForward = MOO_TOKENS.USDG.toLowerCase() + '000064'
    + MOO_TOKENS.WETH.slice(2).toLowerCase() + '002710' + MOO_TOKENS.MOO.slice(2).toLowerCase();
  const expectedReverse = MOO_TOKENS.MOO.toLowerCase() + '002710'
    + MOO_TOKENS.WETH.slice(2).toLowerCase() + '000064' + MOO_TOKENS.USDG.slice(2).toLowerCase();
  let factoryCalls = 0;
  const quotedPaths = [];
  const adapter = new V4QuoterAdapter({ async call({ to, data }) {
    if (to === MOO_V3_FACTORY) {
      factoryCalls++;
      const args = factory.decodeFunctionData('getPool', data);
      const hop = Number(args[2]) === 100 ? 0 : 1;
      return factory.encodeFunctionResult('getPool', [v3.v3.poolAddresses[hop]]);
    }
    assert.equal(to, MOO_V3_QUOTER);
    quotedPaths.push(quoteAbi.decodeFunctionData('quoteExactInput', data)[0]);
    return quoteAbi.encodeFunctionResult('quoteExactInput', [10_000n, [], [], 150_000n]);
  } });
  const walletAddress = '0x0000000000000000000000000000000000000001';
  const router = new UniversalRouterAdapter(null, { walletAddress });
  for (const direction of [0, 1]) {
    const quote = await adapter.quoteExactInputSingleRaw(v3, direction, 1_000n, 50);
    const request = router.buildV4ExactInputSingle({ pool: v3, quote, deadline: 12345 });
    const decoded = new Interface(UNIVERSAL_ROUTER_ABI).decodeFunctionData('execute', request.data);
    assert.equal(decoded[0], '0x00');
    const args = AbiCoder.defaultAbiCoder().decode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool', 'uint256[]'], decoded[1][0]);
    assert.equal(args[0], walletAddress);
    assert.equal(args[1], 1_000n);
    assert.equal(args[2], 9_950n);
    assert.equal(args[3], direction === 0 ? expectedForward : expectedReverse);
    assert.equal(args[4], true);
    assert.equal(args[5].length, 0);
    assert.throws(() => router.buildV4ExactInputSingle({ pool: v3,
      quote: { ...quote, path: '0xdead' }, deadline: 12345 }), /path does not match/);
  }
  assert.equal(factoryCalls, 2);
  assert.deepEqual(quotedPaths, [expectedForward, expectedReverse]);
});
