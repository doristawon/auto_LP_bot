import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface } from 'ethers';
import { UNIVERSAL_ROUTER_ABI } from '../src/abi.js';
import { UniversalRouterAdapter } from '../src/adapters/universal-router.js';
import { UNISWAP_UNIVERSAL_ROUTER_212 } from '../src/constants.js';

const pool = {
  id: '0x4e2a7c0057cec67170ee71641d23d0e835afb6f1deb6b4c6a182b4c16ec8f594',
  key: {
    currency0: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    currency1: '0x7dbf38976f6D3b9c529e7D9484A71898B409eE6a',
    fee: 8388608,
    tickSpacing: 200,
    hooks: '0x08E52564Bad99E05a694b4809F397edcA417A080'
  },
  token0: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6 },
  token1: { address: '0x7dbf38976f6D3b9c529e7D9484A71898B409eE6a', symbol: 'ZZZ', decimals: 18 }
};

const quote = {
  tokenIn: pool.token0.address,
  tokenOut: pool.token1.address,
  rawAmountIn: '1000000',
  minRawAmountOut: '37824535896871557739',
  zeroForOne: true
};

test('minimal V4 Universal Router plan encodes verified command/action structure', () => {
  const adapter = new UniversalRouterAdapter(null, { walletAddress: '0x0000000000000000000000000000000000000001' });
  const plan = adapter.buildV4ExactInputSingle({ pool, quote, deadline: 1790249999 });
  assert.equal(plan.router.toLowerCase(), UNISWAP_UNIVERSAL_ROUTER_212.toLowerCase());
  assert.equal(plan.data.slice(0, 10), '0x3593564c');
  assert.equal(plan.commands, '0x10');
  assert.equal(plan.v4Actions, '0x060c0f');

  const router = new Interface(UNIVERSAL_ROUTER_ABI);
  const decoded = router.decodeFunctionData('execute', plan.data);
  assert.equal(decoded[0], '0x10');
  assert.equal(Number(decoded[2]), 1790249999);
  assert.equal(decoded[1].length, 1);

  const coder = AbiCoder.defaultAbiCoder();
  const [actions, params] = coder.decode(['bytes', 'bytes[]'], decoded[1][0]);
  assert.equal(actions, '0x060c0f');
  assert.equal(params.length, 3);

  const [swap] = coder.decode([
    'tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)'
  ], params[0]);
  assert.equal(String(swap[0][0]).toLowerCase(), pool.key.currency0.toLowerCase());
  assert.equal(String(swap[0][1]).toLowerCase(), pool.key.currency1.toLowerCase());
  assert.equal(Number(swap[0][2]), pool.key.fee);
  assert.equal(Number(swap[0][3]), pool.key.tickSpacing);
  assert.equal(String(swap[0][4]).toLowerCase(), pool.key.hooks.toLowerCase());
  assert.equal(swap[1], true);
  assert.equal(BigInt(swap[2]), 1000000n);
  assert.equal(BigInt(swap[3]), 37824535896871557739n);
  assert.equal(BigInt(swap[4]), 0n);
  assert.equal(swap[5], '0x');

  const [settleCurrency, settleMax] = coder.decode(['address', 'uint256'], params[1]);
  const [takeCurrency, takeMin] = coder.decode(['address', 'uint256'], params[2]);
  assert.equal(settleCurrency.toLowerCase(), pool.token0.address.toLowerCase());
  assert.equal(BigInt(settleMax), 1000000n);
  assert.equal(takeCurrency.toLowerCase(), pool.token1.address.toLowerCase());
  assert.equal(BigInt(takeMin), 37824535896871557739n);
});
