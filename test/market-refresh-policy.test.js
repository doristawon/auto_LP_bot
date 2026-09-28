import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoLpBot } from '../src/bot.js';

const pool = {
  id: '0x' + '11'.repeat(32),
  token0: { address: '0x0000000000000000000000000000000000000010', symbol: 'USDG', decimals: 18 },
  token1: { address: '0x0000000000000000000000000000000000000020', symbol: 'MOO', decimals: 18 },
  state: { paused: false, liquidity: 1n, sqrtPriceX96: 2n ** 96n, tick: 1 }
};
const position = { id: '0x' + '22'.repeat(32), outside: true, shouldRebalance: true, target: {} };

test('routine pool refresh reads chain state and TVL without requesting Fables APR', async () => {
  const previousFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return { ok: true, async json() { return { pools: { [pool.id]: { tvlUsd: 100_000 } } }; } };
  };
  try {
    const bot = {
      market: { refreshedAt: 0, stateRefreshedAt: 0, pools: [], fablesStats: null },
      config: { marketRefreshMs: 300_000, marketStateRefreshMs: 300_000,
        usdgAddress: pool.token0.address, pointsGlobalSwapScanEnabled: false, targetMode: 'wallet-active' },
      providers: { readProvider: { async getBlockNumber() { return 123; } } },
      fables: { async discoverAllPools() { return [pool]; }, async hydratePoolStates(pools) { return pools; } },
      async scanGlobalPoolFees() {}
    };
    await AutoLpBot.prototype.refreshMarket.call(bot, true);
    assert.equal(fetched.length, 1);
    assert.match(fetched[0], /PoolTvl/);
    assert.equal(bot.market.pools.length, 1);
    assert.equal(bot.market.fablesStats.pools.get(pool.id).tvlUsd, 100_000);
    assert.equal(bot.market.fablesStats.pools.get(pool.id).aprPct, null);
  } finally { globalThis.fetch = previousFetch; }
});

test('APR is requested only after an OOR position passes execution gates', async () => {
  const calls = [];
  const bot = {
    ledger: { append() {} },
    state: { getSetting() { return 0; }, recentRebalances() { return []; }, setSetting() {},
      setPosition() {}, recordRebalance() {} },
    config: { minRebalanceIntervalSec: 0, maxRebalancesPerHour: 3 },
    executionPaused: false,
    market: { pools: [pool], fablesStats: null },
    async assertStillOutOfRangeBeforeRebalance() { calls.push('chain-check'); return true; },
    async refreshAprForRebalance() { calls.push('apr'); },
    resolveInvestmentTarget() { calls.push('target'); return pool; },
    getInvestmentTargetSettings() { return { mode: 'specific-pool' }; },
    executor: { async execute() { calls.push('execute'); return { status: 'dry-run' }; } }
  };
  const inRange = await AutoLpBot.prototype.maybeRebalance.call(bot, pool, { ...position, outside: false });
  assert.equal(inRange.reason, 'position-not-oor-eligible');
  assert.deepEqual(calls, []);
  bot.executionPaused = true;
  const paused = await AutoLpBot.prototype.maybeRebalance.call(bot, pool, position);
  assert.equal(paused.reason, 'execution-paused');
  assert.deepEqual(calls, ['chain-check']);
  bot.executionPaused = false;
  const result = await AutoLpBot.prototype.maybeRebalance.call(bot, pool, position);
  assert.equal(result.status, 'dry-run');
  assert.deepEqual(calls, ['chain-check', 'chain-check', 'apr', 'target', 'execute']);
});
