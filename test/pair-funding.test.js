import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPairFundingScope } from '../src/execution/pair-funding.js';

const pool = {
  token0: { address: '0x0000000000000000000000000000000000000001' },
  token1: { address: '0x0000000000000000000000000000000000000002' }
};
const balances = { raw0: 10_000n, raw1: 20_000n };

test('full pair inventory is available and USDG dust is reserved only in USDG', () => {
  const first = buildPairFundingScope(pool, balances, pool.token0.address, 25);
  assert.deepEqual(first.funding, { raw0: 9_975n, raw1: 20_000n });
  assert.deepEqual(first.dustRaw, { raw0: 25n, raw1: 0n });
  assert.equal(first.stableIndex, 0);
  const second = buildPairFundingScope(pool, balances, pool.token1.address, 25);
  assert.deepEqual(second.funding, { raw0: 10_000n, raw1: 19_950n });
  assert.deepEqual(second.dustRaw, { raw0: 0n, raw1: 50n });
  assert.equal(second.stableIndex, 1);
});

test('non-USDG pair keeps symmetric dust behavior', () => {
  const scope = buildPairFundingScope(pool, balances, '0x0000000000000000000000000000000000000003', 25);
  assert.deepEqual(scope.dustRaw, { raw0: 25n, raw1: 50n });
  assert.equal(scope.stableIndex, null);
});
