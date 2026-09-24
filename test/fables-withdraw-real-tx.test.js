import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';

const POOL_KEY = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const REAL_SELECTOR = '0x289a2a15';
const TYPES = ['uint8','uint16','uint24','uint32','uint40','uint48','uint64','uint80','uint96','uint112','uint128','uint160','uint192','uint224','uint256'];

test('discover real Fables withdraw trailing argument type from selector', () => {
  const candidates = TYPES.map((type) => {
    const abi = [
      `function withdraw(${POOL_KEY} key,int24 tickLower,int24 tickUpper,uint128 liquidity,address recipient,uint128 amount0Min,uint128 amount1Min,uint256 deadline,${type} trailing)`
    ];
    const iface = new Interface(abi);
    return { type, selector: iface.getFunction('withdraw').selector };
  });
  console.log(JSON.stringify(candidates));
  const match = candidates.find((x) => x.selector === REAL_SELECTOR);
  assert.ok(match, 'no single trailing uint type matches real selector');
});
