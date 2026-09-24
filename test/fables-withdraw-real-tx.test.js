import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';

const POOL_KEY = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const CANDIDATE = [
  `function withdraw(${POOL_KEY} key,int24 tickLower,int24 tickUpper,uint128 liquidity,address recipient,uint128 amount0Min,uint128 amount1Min,uint256 deadline,uint16 walk)`
];

const REAL = '0x289a2a150000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d168000000000000000000000000d9db30bb0d2b8d2eae3826a1372117e058791e18000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000000c800000000000000000000000008e52564bad99e05a694b4809f397edca417a080000000000000000000000000000000000000000000000000000000000004d968000000000000000000000000000000000000000000000000000000000004dc880000000000000000000000000000000000000000000000000726750710c778630000000000000000000000006f196af3b69c521eed9436abc9130699df1c50bf000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000236a3a3932a1b83cf87c000000000000000000000000000000000000000000000000000000006ab496b400000000000000000000000000000000000000000000000000000000000003e8';

test('real Fables withdraw selector and calldata include final uint16 walk', () => {
  const iface = new Interface(CANDIDATE);
  assert.equal(iface.getFunction('withdraw').selector, '0x289a2a15');
  const decoded = iface.decodeFunctionData('withdraw', REAL);
  const key = decoded[0];
  assert.equal(String(key.currency0).toLowerCase(), '0x5fc5360d0400a0fd4f2af552add042d716f1d168');
  assert.equal(String(key.currency1).toLowerCase(), '0xd9db30bb0d2b8d2eae3826a1372117e058791e18');
  assert.equal(Number(key.tickSpacing), 200);
  assert.equal(Number(decoded[1]), 317800);
  assert.equal(Number(decoded[2]), 318600);
  assert.equal(String(decoded[4]).toLowerCase(), '0x6f196af3b69c521eed9436abc9130699df1c50bf');
  assert.equal(BigInt(decoded[5]), 0n);
  assert.ok(BigInt(decoded[6]) > 0n);
  assert.equal(BigInt(decoded[8]), 1000n);
});
