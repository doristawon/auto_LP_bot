import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUsdPriceMap } from '../src/analytics/prices.js';

const USDG = '0x0000000000000000000000000000000000000001';
const UBIK = '0x0000000000000000000000000000000000000002';
const MOO = '0x0000000000000000000000000000000000000003';
const Q96 = 2 ** 96;
const token = (address, symbol) => ({ address, symbol, decimals: 18 });
const pool = (id, token0, token1, token1PerToken0 = 1) => ({
  id,
  token0,
  token1,
  state: { sqrtPriceX96: Q96 * Math.sqrt(token1PerToken0), paused: false }
});

test('USD price selection prefers the route with the strongest Fables TVL independent of pool order', () => {
  const usdUbik = pool('usd-ubik', token(USDG, 'USDG'), token(UBIK, 'UBIK'));
  const ubikMoo = pool('ubik-moo', token(UBIK, 'UBIK'), token(MOO, 'MOO'), 2);
  const shallowUsdMoo = pool('shallow-usd-moo', token(USDG, 'USDG'), token(MOO, 'MOO'), 4);
  const pools = [usdUbik, ubikMoo, shallowUsdMoo];
  const fablesStats = { pools: new Map([
    ['usd-ubik', { tvlUsd: 100_000 }],
    ['ubik-moo', { tvlUsd: 80_000 }],
    ['shallow-usd-moo', { tvlUsd: 10_000 }]
  ]) };

  const forward = buildUsdPriceMap(pools, USDG, { fablesStats });
  const reversed = buildUsdPriceMap([...pools].reverse(), USDG, { fablesStats });
  assert.ok(Math.abs(forward.get(MOO) - 0.5) < 1e-12);
  assert.equal(reversed.get(MOO), forward.get(MOO));
  assert.deepEqual(forward.sources.get(MOO).pathPoolIds, ['usd-ubik', 'ubik-moo']);
  assert.equal(forward.sources.get(MOO).bottleneckTvlUsd, 80_000);
});

test('USD price map remains usable without optional Fables stats', () => {
  const direct = pool('direct', token(USDG, 'USDG'), token(MOO, 'MOO'), 2);
  const prices = buildUsdPriceMap([direct], USDG);
  assert.equal(prices.get(USDG), 1);
  assert.ok(Math.abs(prices.get(MOO) - 0.5) < 1e-12);
  assert.deepEqual(prices.sources.get(MOO).pathPairs, ['USDG/MOO']);
});
