import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoLpBot } from '../src/bot.js';
import {
  rankAprPools,
  findV4Route,
  chooseInvestmentAnchor,
  buildV4PathKeys,
  buildCrossPoolFundingScope
} from '../src/execution/investment-target.js';

const USDG = '0x0000000000000000000000000000000000000010';
const MOO = '0x0000000000000000000000000000000000000020';
const UBIK = '0x0000000000000000000000000000000000000030';
const ZZZ = '0x0000000000000000000000000000000000000040';
const pool = (id, token0, token1, { paused = false, liquidity = 1n } = {}) => ({
  id,
  key: { currency0: token0.address, currency1: token1.address, fee: 8388608, tickSpacing: 200, hooks: '0x00000000000000000000000000000000000000aa' },
  token0,
  token1,
  state: { paused, liquidity }
});
const token = (address, symbol) => ({ address, symbol, decimals: 18 });

test('APR ranking excludes stale, paused, empty, and undersized pools', () => {
  const nowMs = 1_000_000;
  const high = pool('high', token(USDG, 'USDG'), token(UBIK, 'UBIK'));
  const low = pool('low', token(USDG, 'USDG'), token(MOO, 'MOO'));
  const paused = pool('paused', token(USDG, 'USDG'), token(ZZZ, 'ZZZ'), { paused: true });
  const pools = [low, paused, high];
  const stats = {
    observedAt: nowMs - 1_000,
    pools: new Map([
      ['high', { aprPct: 800, tvlUsd: 100_000, fees24hUsd: 200 }],
      ['low', { aprPct: 400, tvlUsd: 30_000, fees24hUsd: 100 }],
      ['paused', { aprPct: 9_000, tvlUsd: 1_000_000, fees24hUsd: 10 }]
    ])
  };
  assert.deepEqual(rankAprPools({ pools, stats, nowMs, minTvlUsd: 30_000 }).map((item) => item.pool.id), ['high', 'low']);
  assert.deepEqual(rankAprPools({ pools, stats: { ...stats, observedAt: nowMs - 600_000 }, nowMs }).map((item) => item.pool.id), []);
});

test('live APR mode keeps the existing LP pool while cross-pool execution cannot be simulated', () => {
  const nowMs = Date.now();
  const source = pool('source', token(USDG, 'USDG'), token(MOO, 'MOO'));
  const higher = pool('higher', token(USDG, 'USDG'), token(UBIK, 'UBIK'));
  const bot = {
    config: { enableLiveWrites: true, dryRun: false, marketRefreshMs: 300_000, aprPoolMinTvlUsd: 30_000 },
    market: {
      pools: [source, higher],
      fablesStats: {
        observedAt: nowMs, aprObservedAt: nowMs,
        pools: new Map([
          ['source', { aprPct: 100, tvlUsd: 100_000, fees24hUsd: 10 }],
          ['higher', { aprPct: 200, tvlUsd: 100_000, fees24hUsd: 20 }]
        ])
      }
    },
    snapshot: { portfolio: { positions: [{ poolId: 'source', shares: '1' }] } },
    getInvestmentTargetSettings() { return { mode: 'apr-highest', poolId: '' }; }
  };
  assert.equal(AutoLpBot.prototype.resolveInvestmentTarget.call(bot, source).id, 'source');
  const target = AutoLpBot.prototype.getInvestmentTargetSnapshot.call(bot);
  assert.equal(target.poolId, 'source');
  assert.match(target.executionConstraint, /cross-pool-live-unavailable/);

  bot.config.dryRun = true;
  assert.equal(AutoLpBot.prototype.resolveInvestmentTarget.call(bot, source).id, 'higher');
});

test('Fables route search returns the shortest connected route and ordered path keys', () => {
  const usdMoo = pool('a-usd-moo', token(USDG, 'USDG'), token(MOO, 'MOO'));
  const usdUbik = pool('b-usd-ubik', token(USDG, 'USDG'), token(UBIK, 'UBIK'));
  const mooZzz = pool('y-moo-zzz', token(MOO, 'MOO'), token(ZZZ, 'ZZZ'));
  const zzzUbik = pool('z-zzz-ubik', token(ZZZ, 'ZZZ'), token(UBIK, 'UBIK'));
  const route = findV4Route([mooZzz, zzzUbik, usdMoo, usdUbik], MOO, UBIK);
  assert.deepEqual(route.map((item) => item.id), ['a-usd-moo', 'b-usd-ubik']);
  assert.deepEqual(buildV4PathKeys(route, MOO), [
    [USDG, 8388608, 200, usdMoo.key.hooks, '0x'],
    [UBIK, 8388608, 200, usdUbik.key.hooks, '0x']
  ]);
});

test('investment anchor picks the destination token with a connected route for every asset', () => {
  const source = pool('source', token(USDG, 'USDG'), token(MOO, 'MOO'));
  const destination = pool('destination', token(USDG, 'USDG'), token(UBIK, 'UBIK'));
  const choice = chooseInvestmentAnchor(
    [source.token0, source.token1, destination.token0, destination.token1],
    destination,
    [source, destination]
  );
  assert.equal(choice.anchor.address.toLowerCase(), USDG);
  assert.equal(choice.routes.get(MOO).length, 1);
});

test('cross-pool funding is limited to source and destination pair tokens with withdrawal delta and dust', () => {
  const source = pool('source', token(USDG, 'USDG'), token(MOO, 'MEME'));
  const destination = pool('destination', token(USDG, 'USDG'), token(UBIK, 'EARN'));
  const unrelated = '0x0000000000000000000000000000000000000050';
  const scope = buildCrossPoolFundingScope({
    sourcePool: source,
    destinationPool: destination,
    walletBalances: new Map([
      [USDG, 100n],
      [MOO, 20n],
      [UBIK, 30n],
      [unrelated, 9_999n]
    ]),
    expectedWithdraw: { raw0: 5n, raw1: 2n },
    dustRawByAddress: { [USDG]: 1n, [MOO]: 3n, [UBIK]: 4n }
  });

  assert.deepEqual(scope.map((entry) => entry.address).sort(), [USDG, MOO, UBIK].sort());
  assert.equal(scope.find((entry) => entry.address === USDG).maxSpendRaw, 104n);
  assert.equal(scope.find((entry) => entry.address === MOO).maxSpendRaw, 19n);
  assert.equal(scope.find((entry) => entry.address === UBIK).maxSpendRaw, 26n);
  assert.equal(scope.find((entry) => entry.address === USDG).walletSource, 'source-and-destination-pair-wallet-balance');
});
