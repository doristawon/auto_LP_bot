import test from 'node:test';
import assert from 'node:assert/strict';
import { probePoolSwapCosts } from '../src/execution/pool-quote-probes.js';

const USDG = '0x0000000000000000000000000000000000000010';
const MEME = '0x0000000000000000000000000000000000000020';

test('pool quote probe marks an observed three percent cost with its trade direction', async () => {
  const pool = {
    id: '0xpool',
    token0: { address: USDG, symbol: 'USDG', decimals: 6 },
    token1: { address: MEME, symbol: 'MEME', decimals: 6 },
    state: { paused: false, liquidity: 1n, sqrtPriceX96: 2n ** 96n }
  };
  const results = await probePoolSwapCosts({
    pools: [pool], usdgAddress: USDG,
    usdPrices: new Map([[USDG, 1], [MEME, 1]]),
    quoter: { async quoteExactInputSingleRaw(_pool, index, raw) {
      assert.equal(index, 0);
      assert.equal(raw, 10_000_000n);
      return { rawAmountOut: '7000000' };
    } }
  });
  assert.equal(results['0xpool'].impactBps, 3000);
  assert.equal(results['0xpool'].approximatelyThreePercent, false);
  assert.equal(results['0xpool'].tokenIn, 'USDG');
  assert.equal(results['0xpool'].sampleUsd, 10);
});

test('pool quote probe identifies a three percent quote and keeps failures unavailable', async () => {
  const pool = {
    id: '0xpool',
    token0: { address: USDG, symbol: 'USDG', decimals: 6 },
    token1: { address: MEME, symbol: 'MEME', decimals: 6 },
    state: { paused: false, liquidity: 1n, sqrtPriceX96: 2n ** 96n }
  };
  const result = await probePoolSwapCosts({
    pools: [pool], usdgAddress: USDG,
    usdPrices: new Map([[USDG, 1]]),
    quoter: { async quoteExactInputSingleRaw() { return { rawAmountOut: '70000' }; } },
    sampleUsd: 0.072
  });
  assert.equal(result['0xpool'].approximatelyThreePercent, true);
  assert.equal(result['0xpool'].impactBps, 277);
  const failed = await probePoolSwapCosts({
    pools: [pool], usdgAddress: USDG,
    usdPrices: new Map([[USDG, 1]]),
    quoter: { async quoteExactInputSingleRaw() { throw new Error('rate limited'); } }
  });
  assert.equal(failed['0xpool'].status, 'unavailable');
});
