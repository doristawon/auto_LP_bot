import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';

const POOL_KEY = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const REAL_SELECTOR = '0x289a2a15';
const UINTS = ['uint8','uint16','uint24','uint32','uint40','uint48','uint64','uint80','uint96','uint112','uint128','uint160','uint192','uint224','uint256'];
const REAL = '0x289a2a150000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d168000000000000000000000000d9db30bb0d2b8d2eae3826a1372117e058791e18000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000000c800000000000000000000000008e52564bad99e05a694b4809f397edca417a080000000000000000000000000000000000000000000000000000000000004d968000000000000000000000000000000000000000000000000000000000004dc880000000000000000000000000000000000000000000000000726750710c778630000000000000000000000006f196af3b69c521eed9436abc9130699df1c50bf000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000236a3a3932a1b83cf87c000000000000000000000000000000000000000000000000000000006ab496b400000000000000000000000000000000000000000000000000000000000003e8';

test('discover and decode real Fables withdraw ABI from selector', () => {
  const matches = [];
  for (const tickType of ['int24','int32','int64','int128','int256']) {
    for (const liquidityType of ['uint128','uint256']) {
      for (const min0Type of ['uint128','uint256']) {
        for (const min1Type of ['uint128','uint256']) {
          for (const deadlineType of ['uint48','uint64','uint128','uint256']) {
            for (const trailingType of UINTS) {
              const signature = `withdraw(${POOL_KEY} key,${tickType} tickLower,${tickType} tickUpper,${liquidityType} liquidity,address recipient,${min0Type} amount0Min,${min1Type} amount1Min,${deadlineType} deadline,${trailingType} trailing)`;
              const iface = new Interface([`function ${signature}`]);
              if (iface.getFunction('withdraw').selector === REAL_SELECTOR) {
                matches.push({ signature, tickType, liquidityType, min0Type, min1Type, deadlineType, trailingType, iface });
              }
            }
          }
        }
      }
    }
  }
  console.log(JSON.stringify(matches.map(({ iface, ...x }) => x), null, 2));
  assert.ok(matches.length > 0, 'no static width combination matches real selector');
  const { iface, ...match } = matches[0];
  const decoded = iface.decodeFunctionData('withdraw', REAL);
  console.log(JSON.stringify({
    match,
    tickLower: Number(decoded[1]),
    tickUpper: Number(decoded[2]),
    liquidity: decoded[3].toString(),
    recipient: decoded[4],
    amount0Min: decoded[5].toString(),
    amount1Min: decoded[6].toString(),
    deadline: decoded[7].toString(),
    trailing: decoded[8].toString()
  }, null, 2));
  assert.equal(Number(decoded[1]), 317800);
  assert.equal(Number(decoded[2]), 318600);
  assert.equal(String(decoded[4]).toLowerCase(), '0x6f196af3b69c521eed9436abc9130699df1c50bf');
  assert.equal(BigInt(decoded[5]), 0n);
  assert.ok(BigInt(decoded[6]) > 0n);
  assert.equal(BigInt(decoded[8]), 1000n);
});
