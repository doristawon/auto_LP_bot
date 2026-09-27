import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { V4_QUOTER_ABI } from '../src/abi.js';
import { V4QuoterAdapter } from '../src/adapters/quoter.js';

const a = { address: '0x0000000000000000000000000000000000000010', symbol: 'USDG', decimals: 6 };
const b = { address: '0x0000000000000000000000000000000000000020', symbol: 'MOO', decimals: 18 };
const c = { address: '0x0000000000000000000000000000000000000030', symbol: 'UBIK', decimals: 18 };
const first = {
  id: 'first',
  key: { currency0: a.address, currency1: b.address, fee: 8388608, tickSpacing: 200, hooks: '0x00000000000000000000000000000000000000aa' },
  token0: a, token1: b
};
const second = {
  id: 'second',
  key: { currency0: a.address, currency1: c.address, fee: 8388608, tickSpacing: 200, hooks: '0x00000000000000000000000000000000000000bb' },
  token0: a, token1: c
};

test('multi-hop V4 quoter encodes the path and returns a slippage-bounded quote', async () => {
  const iface = new Interface(V4_QUOTER_ABI);
  let observedData = '';
  const provider = {
    async call({ data }) {
      observedData = data;
      return iface.encodeFunctionResult('quoteExactInput', [1_000_000n, 75_000n]);
    }
  };
  const quoter = new V4QuoterAdapter(provider);
  const quote = await quoter.quoteExactInputPathRaw([first, second], b, 500_000_000_000_000_000n, 50);
  assert.equal(observedData.slice(0, 10), iface.getFunction('quoteExactInput').selector);
  assert.equal(quote.tokenIn.toLowerCase(), b.address.toLowerCase());
  assert.equal(quote.tokenOut.toLowerCase(), c.address.toLowerCase());
  assert.equal(quote.rawAmountOut, '1000000');
  assert.equal(quote.minRawAmountOut, '995000');
  assert.deepEqual(quote.path, ['first', 'second']);
});
