import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id } from 'ethers';

const signature = 'deposit((address,address,uint24,int24,address),int24,int24,uint128,uint128,uint128,uint256)';
const abi = [
  'function deposit((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,int24 tickLower,int24 tickUpper,uint128 liquidity,uint128 amount0Max,uint128 amount1Max,uint256 deadline)'
];
const iface = new Interface(abi);
const fixture = {
  key: {
    currency0: '0x0000000000000000000000000000000000000001',
    currency1: '0x0000000000000000000000000000000000000002',
    fee: 0x800000,
    tickSpacing: 60,
    hooks: '0x0000000000000000000000000000000000000003'
  },
  tickLower: -1200,
  tickUpper: -960,
  liquidity: 123456789012345678n,
  amount0Max: 987654321n,
  amount1Max: 123456789012345678901n,
  deadline: 2000000000
};

test('Fables deposit signature matches the expected selector', () => {
  assert.equal(id(signature).slice(0, 10), '0x36a9ca1a');
});

test('synthetic deposit calldata round-trips through the ABI', () => {
  const data = iface.encodeFunctionData('deposit', [
    fixture.key,
    fixture.tickLower,
    fixture.tickUpper,
    fixture.liquidity,
    fixture.amount0Max,
    fixture.amount1Max,
    fixture.deadline
  ]);
  assert.equal(data.slice(0, 10), '0x36a9ca1a');
  const decoded = iface.decodeFunctionData('deposit', data);
  assert.equal(String(decoded[0].currency0).toLowerCase(), fixture.key.currency0.toLowerCase());
  assert.equal(String(decoded[0].currency1).toLowerCase(), fixture.key.currency1.toLowerCase());
  assert.equal(Number(decoded[0].fee), fixture.key.fee);
  assert.equal(Number(decoded[0].tickSpacing), fixture.key.tickSpacing);
  assert.equal(String(decoded[0].hooks).toLowerCase(), fixture.key.hooks.toLowerCase());
  assert.equal(Number(decoded[1]), fixture.tickLower);
  assert.equal(Number(decoded[2]), fixture.tickUpper);
  assert.equal(BigInt(decoded[3]), fixture.liquidity);
  assert.equal(BigInt(decoded[4]), fixture.amount0Max);
  assert.equal(BigInt(decoded[5]), fixture.amount1Max);
  assert.equal(Number(decoded[6]), fixture.deadline);
});
