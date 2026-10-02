import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, keccak256 } from 'ethers';
import { LENS_ABI, LENS_ADDRESS } from '../src/analytics/points-evidence.js';
import { USDG } from '../src/constants.js';
import { collectOfficialClaimRanges } from '../src/execution/official-fee-claims.js';

const coder = AbiCoder.defaultAbiCoder();
const poolKeyAbi = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const token0 = '0x020bfC650A365f8BB26819deAAbF3E21291018b4';
const hook = '0x0000000000000000000000000000000000000011';
const wallet = '0x00000000000000000000000000000000000000aa';
const otherToken = '0x0000000000000000000000000000000000000099';
const key = { currency0: token0, currency1: USDG, fee: 8388608, tickSpacing: 60, hooks: hook };
const poolId = keccak256(coder.encode([poolKeyAbi], [[
  key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks
]]));
const lensInterface = new Interface(LENS_ABI);

function range(lower, upper, claimable0 = 0n, claimable1 = 0n, overrides = {}) {
  const id = keccak256(coder.encode(['bytes32', 'int24', 'int24'], [poolId, lower, upper]));
  return { id, lower, upper, claimable0, claimable1, overrides };
}

function makeFixture(ranges, ownerPositionIds = ranges.map((item) => item.id)) {
  const rowsById = new Map(ranges.map((item) => [BigInt(item.id).toString(), item]));
  const ownerCalls = [];
  const lensCalls = [];
  const fetchFn = async (url, init) => {
    ownerCalls.push({ url, init });
    return {
      ok: true,
      async json() {
        return { data: {
          Position: ownerPositionIds.map((id) => ({ pool_id: poolId, range_id: BigInt(id).toString() })),
          LiquidityEvent: [], FeeClaim: [], chain_metadata: []
        } };
      }
    };
  };
  const provider = {
    async call(tx) {
      assert.equal(String(tx.to).toLowerCase(), LENS_ADDRESS.toLowerCase());
      const parsed = lensInterface.parseTransaction({ data: tx.data });
      assert.equal(parsed.name, 'userRanges');
      assert.equal(String(parsed.args[0]).toLowerCase(), key.hooks.toLowerCase());
      assert.equal(String(parsed.args[1]).toLowerCase(), wallet.toLowerCase());
      const ids = [...parsed.args[2]].map(BigInt);
      assert.ok(ids.length <= 200);
      lensCalls.push(ids.map((id) => id.toString()));
      const encodedRows = ids.map((id) => encodeLensRow(id, rowsById.get(id.toString())));
      return lensInterface.encodeFunctionResult('userRanges', [encodedRows, [1n, 2n, 3n, true]]);
    }
  };
  return { pool: { id: poolId, key }, provider, fetchFn, ownerCalls, lensCalls };
}

function encodeLensRow(id, record) {
  const row = record || {};
  const lower = row.overrides?.tickLower ?? row.lower ?? -120;
  const upper = row.overrides?.tickUpper ?? row.upper ?? -60;
  const rowId = row.overrides?.rangeId ?? id;
  const rowKey = row.overrides?.key || key;
  const values = [
    BigInt(rowId),
    row.overrides?.keyVerified ?? true,
    [rowKey.currency0, rowKey.currency1, rowKey.fee, rowKey.tickSpacing, rowKey.hooks],
    lower,
    upper,
    row.overrides?.shares ?? 123n,
    123n,
    row.claimable0 ?? 0n,
    row.claimable1 ?? 0n,
    123n,
    123n,
    row.overrides?.effectiveClaimFeeBps ?? 1000,
    row.overrides?.claimPaused ?? false,
    row.overrides?.settling ?? false,
    1n,
    0,
    true,
    0,
    0,
    1n,
    1n,
    0n,
    0n
  ];
  return values;
}

function currentArgs(currentRange) {
  return {
    walletAddress: wallet,
    currentPosition: { id: BigInt(currentRange.id), tickLower: currentRange.lower, tickUpper: currentRange.upper }
  };
}

test('owner ranges are deduped, current is kept, and fee-bearing USDG ranges are ranked first', async () => {
  const high = range(-600, -540, 0n, 90n);
  const low = range(-480, -420, 0n, 3n);
  const empty = range(-360, -300, 0n, 0n);
  const current = range(-240, -180, 0n, 0n);
  const f = makeFixture([high, low, empty, current], [high.id, low.id, empty.id, high.id]);
  const fetchCalls = [];
  const fetchFn = async (...args) => { fetchCalls.push(args); return f.fetchFn(...args); };

  const result = await collectOfficialClaimRanges({
    pool: f.pool,
    provider: f.provider,
    currentPosition: currentArgs(current).currentPosition,
    walletAddress: wallet,
    fetchFn
  });

  assert.deepEqual(result, [
    { rangeId: current.id, tickLower: current.lower, tickUpper: current.upper, current: true },
    { rangeId: high.id, tickLower: high.lower, tickUpper: high.upper, current: false },
    { rangeId: low.id, tickLower: low.lower, tickUpper: low.upper, current: false }
  ]);
  assert.equal(fetchCalls.length, 1);
  assert.equal(JSON.parse(fetchCalls[0][1].body).address, wallet.toLowerCase());
  assert.equal(f.lensCalls.flat().length, 4);
  assert.ok(result.every((row) => Object.keys(row).join(',') === 'rangeId,tickLower,tickUpper,current'));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)));
});

test('always retains current range and caps output at current plus 15 largest USDG fee ranges', async () => {
  const old = Array.from({ length: 20 }, (_unused, index) =>
    range(-6000 + index * 120, -5940 + index * 120, 0n, BigInt(index + 1)));
  const current = range(6000, 6060, 0n, 0n);
  const f = makeFixture([...old, current], [...old].reverse().map((item) => item.id));

  const result = await collectOfficialClaimRanges({
    ...f,
    ...currentArgs(current)
  });

  assert.equal(result.length, 16);
  assert.deepEqual(result[0], {
    rangeId: current.id, tickLower: current.lower, tickUpper: current.upper, current: true
  });
  assert.deepEqual(result.slice(1).map((row) => row.rangeId), old.slice(-15).reverse().map((item) => item.id));
});

test('lens read is bounded at 200 unique ranges and rejects a larger owner set', async () => {
  const ranges = Array.from({ length: 200 }, (_unused, index) =>
    range(-12_000 + index * 60, -11_940 + index * 60, 0n, 0n));
  const current = ranges[199];
  const f = makeFixture(ranges);

  const result = await collectOfficialClaimRanges({
    ...f,
    ...currentArgs(current)
  });

  assert.deepEqual(f.lensCalls.map((batch) => batch.length), [200]);
  assert.deepEqual(result, [{
    rangeId: current.id, tickLower: current.lower, tickUpper: current.upper, current: true
  }]);

  const tooMany = Array.from({ length: 201 }, (_unused, index) =>
    range(-12_000 + index * 60, -11_940 + index * 60, 0n, 0n));
  const excludedCurrent = tooMany[200];
  const overBound = makeFixture(tooMany, tooMany.slice(0, 200).map((item) => item.id));
  await assert.rejects(collectOfficialClaimRanges({
    ...overBound,
    ...currentArgs(excludedCurrent)
  }), /owner-range-bound-exceeded/);
  assert.deepEqual(overBound.lensCalls, []);
});

test('rejects unverified rows, invalid pool keys, misderived ranges, paused/settling claims, and fee caps', async (t) => {
  const cases = [
    ['unverified lens row', { keyVerified: false }, /range-unverified/],
    ['other pool key', { key: { ...key, currency0: otherToken } }, /pool-mismatch/],
    ['invalid tick spacing', { tickLower: -121 }, /ticks-invalid/],
    ['wrong returned range id', { rangeId: 999n }, /range-id-mismatch|range-unverified/],
    ['paused current range', { claimPaused: true }, /not-eligible/],
    ['settling current range', { settling: true }, /not-eligible/],
    ['current fee above cap', { effectiveClaimFeeBps: 1001 }, /not-eligible/]
  ];
  for (const [name, overrides, pattern] of cases) {
    await t.test(name, async () => {
      const current = range(-120, -60, 0n, 0n, overrides);
      const f = makeFixture([current]);
      await assert.rejects(collectOfficialClaimRanges({
        ...f, ...currentArgs(current), maxFeeBps: 1000
      }), pattern);
    });
  }
});

test('skips fee-bearing historical ranges that are paused, settling, or above the fee cap', async (t) => {
  for (const overrides of [{ claimPaused: true }, { settling: true }, { effectiveClaimFeeBps: 1001 }]) {
    await t.test(JSON.stringify(overrides), async () => {
      const old = range(-240, -180, 0n, 5n, overrides);
      const current = range(-120, -60, 0n, 0n);
      const f = makeFixture([old, current], [old.id]);
      const result = await collectOfficialClaimRanges({
        ...f, ...currentArgs(current), maxFeeBps: 1000
      });
      assert.deepEqual(result, [{
        rangeId: current.id, tickLower: current.lower, tickUpper: current.upper, current: true
      }]);
    });
  }
});
