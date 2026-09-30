import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id } from 'ethers';
import { FablesAdapter } from '../src/adapters/fables.js';

const SIGNATURE = 'withdrawAndClaim((address,address,uint24,int24,address),int24,int24,uint128,address,uint128,uint128,uint256,uint16)';
const ABI = [
  'function withdrawAndClaim((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,int24 tickLower,int24 tickUpper,uint128 liquidity,address recipient,uint128 amount0Min,uint128 amount1Min,uint256 deadline,uint16 walk)'
];
const wallet = '0x0000000000000000000000000000000000000004';

test('Fables withdrawAndClaim signature matches the expected selector', () => {
  assert.equal(id(SIGNATURE).slice(0, 10), '0x289a2a15');
});

test('adapter encodes deterministic synthetic withdraw calldata', () => {
  const adapter = Object.create(FablesAdapter.prototype);
  adapter.config = { walletAddress: wallet };
  const pool = {
    key: {
      currency0: '0x0000000000000000000000000000000000000001',
      currency1: '0x0000000000000000000000000000000000000002',
      fee: 0x800000,
      tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000003'
    }
  };
  const position = { tickLower: -1200, tickUpper: -960, shares: 123456789012345678n };
  const amounts = [987654321n, 123456789n];
  const deadline = 2000000000;
  const walk = 1000;
  const encoded = adapter.encodeWithdrawAndClaim(pool, position, ...amounts, deadline, walk);
  assert.equal(encoded.slice(0, 10), '0x289a2a15');

  const decoded = new Interface(ABI).decodeFunctionData('withdrawAndClaim', encoded);
  assert.equal(String(decoded[0].currency0).toLowerCase(), pool.key.currency0.toLowerCase());
  assert.equal(String(decoded[0].currency1).toLowerCase(), pool.key.currency1.toLowerCase());
  assert.equal(Number(decoded[0].fee), pool.key.fee);
  assert.equal(Number(decoded[0].tickSpacing), pool.key.tickSpacing);
  assert.equal(String(decoded[0].hooks).toLowerCase(), pool.key.hooks.toLowerCase());
  assert.equal(Number(decoded[1]), position.tickLower);
  assert.equal(Number(decoded[2]), position.tickUpper);
  assert.equal(BigInt(decoded[3]), position.shares);
  assert.equal(String(decoded[4]).toLowerCase(), wallet.toLowerCase());
  assert.equal(BigInt(decoded[5]), amounts[0]);
  assert.equal(BigInt(decoded[6]), amounts[1]);
  assert.equal(Number(decoded[7]), deadline);
  assert.equal(Number(decoded[8]), walk);
});
