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

test('live APR mode reports the highest route-compatible candidate for full preflight', () => {
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
  assert.equal(AutoLpBot.prototype.resolveInvestmentTarget.call(bot, source).id, 'higher');
  const target = AutoLpBot.prototype.getInvestmentTargetSnapshot.call(bot);
  assert.equal(target.poolId, 'higher');
  assert.match(target.executionConstraint, /complete live sequence preflight/);

  bot.config.dryRun = true;
  assert.equal(AutoLpBot.prototype.resolveInvestmentTarget.call(bot, source).id, 'higher');
});

test('APR execution skips candidates whose complete preflight fails', async () => {
  const nowMs = Date.now();
  const source = pool('source', token(USDG, 'USDG'), token(MOO, 'MOO'));
  const high = pool('high', token(USDG, 'USDG'), token(UBIK, 'UBIK'));
  const middle = pool('middle', token(USDG, 'USDG'), token(ZZZ, 'ZZZ'));
  const checked = [];
  const events = [];
  const bot = {
    config: { marketRefreshMs: 300_000, aprPoolMinTvlUsd: 30_000 },
    market: {
      pools: [source, high, middle],
      fablesStats: { observedAt: nowMs, pools: new Map([
        ['high', { aprPct: 300, tvlUsd: 100_000, fees24hUsd: 30 }],
        ['middle', { aprPct: 200, tvlUsd: 100_000, fees24hUsd: 20 }],
        ['source', { aprPct: 100, tvlUsd: 100_000, fees24hUsd: 10 }]
      ]) }
    },
    executor: { async preflightCrossPoolSequence(_plan, destination) {
      checked.push(destination.id);
      if (destination.id === 'high') throw new Error('price impact exceeds limit');
    } },
    ledger: { append(type, data) { events.push({ type, data }); } }
  };
  const selected = await AutoLpBot.prototype.resolveExecutableInvestmentTarget.call(bot, source,
    { id: 'position' });
  assert.equal(selected.id, 'middle');
  assert.deepEqual(checked, ['high', 'middle']);
  assert.ok(events.some((entry) => entry.type === 'investment.cross_pool_candidate_ready'));
});

test('APR execution skips native ETH pools before expensive preflight', async () => {
  const nowMs = Date.now();
  const source = pool('source', token(USDG, 'USDG'), token(MOO, 'MOO'));
  const native = pool('native', token('0x0000000000000000000000000000000000000000', 'ETH'), token(USDG, 'USDG'));
  const erc20 = pool('erc20', token(USDG, 'USDG'), token(UBIK, 'UBIK'));
  const checked = [];
  const bot = {
    config: { marketRefreshMs: 300_000, aprPoolMinTvlUsd: 30_000 },
    market: { pools: [source, native, erc20], fablesStats: {
      observedAt: nowMs, pools: new Map([
        ['native', { aprPct: 500, tvlUsd: 100_000, fees24hUsd: 50 }],
        ['erc20', { aprPct: 300, tvlUsd: 100_000, fees24hUsd: 30 }]
      ])
    } },
    executor: { async preflightCrossPoolSequence(_plan, destination) { checked.push(destination.id); } },
    ledger: { append() {} }
  };
  const selected = await AutoLpBot.prototype.resolveExecutableInvestmentTarget.call(bot, source,
    { id: 'position' });
  assert.equal(selected.id, 'erc20');
  assert.deepEqual(checked, ['erc20']);
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

function targetSettingsHarness() {
  const oldId = '0x' + '11'.repeat(32), newId = '0x' + '22'.repeat(32);
  const oldPool = pool(oldId, token(MOO, 'MOO'), token(USDG, 'USDG'));
  const pons = pool(newId, token(UBIK, 'PONS'), token(USDG, 'USDG'));
  const saved = { investmentTargetMode: 'specific-pool', investmentTargetPoolId: oldId };
  const events = [];
  const bot = {
    cycleActive: true, executionPaused: false,
    config: { marketRefreshMs: 300000, aprPoolMinTvlUsd: 30000 },
    state: { getSetting: (key, fallback) => saved[key] ?? fallback, setSetting: (key, value) => { saved[key] = value; } },
    ledger: { append: (type, data) => events.push({ type, ...data }) },
    market: { pools: [oldPool, pons] },
    getInvestmentAllocationConfig: () => ({ enabled: false }),
    getInvestmentTargetSettings: () => ({ mode: saved.investmentTargetMode, poolId: saved.investmentTargetPoolId }),
    applyStoredExecutionTarget: () => {},
  };
  for (const method of ['setInvestmentTarget', 'persistInvestmentTarget', 'getInvestmentTargetSnapshot', 'applyPendingInvestmentTarget']) {
    bot[method] = AutoLpBot.prototype[method].bind(bot);
  }
  return { bot, saved, events, oldId, newId };
}

test('saving PONS during an active execution cycle queues the next target without changing this cycle', () => {
  const h = targetSettingsHarness();
  const result = h.bot.setInvestmentTarget('specific-pool', h.newId);
  assert.equal(result.queued, true);
  assert.equal(result.pending.pair, 'PONS/USDG');
  assert.equal(h.saved.investmentTargetPoolId, h.oldId);
  assert.equal(h.bot.getInvestmentTargetSnapshot().pending.poolId, h.newId);
  h.bot.cycleActive = false;
  h.bot.applyPendingInvestmentTarget();
  assert.equal(h.saved.investmentTargetPoolId, h.newId);
  assert.equal(h.saved.selectedExecutionTargetPoolId, h.newId);
  assert.equal(h.saved.pendingInvestmentTarget, null);
});

test('a paused read-only monitor cycle can save PONS immediately without clearing recovery', () => {
  const h = targetSettingsHarness(); h.bot.executionPaused = true;
  h.saved.activeRebalanceExecution = { id: 'recovery', phase: 'recovery_required' };
  const result = h.bot.setInvestmentTarget('specific-pool', h.newId);
  assert.equal(result.poolId, h.newId);
  assert.equal(h.saved.pendingInvestmentTarget, null);
  assert.equal(h.saved.activeRebalanceExecution.phase, 'recovery_required');
});

test('latest queued selection survives restart and is revalidated before applying', () => {
  const h = targetSettingsHarness();
  h.bot.setInvestmentTarget('specific-pool', h.newId);
  h.bot.setInvestmentTarget('specific-pool', h.oldId);
  assert.equal(h.saved.pendingInvestmentTarget.poolId, h.oldId);
  h.bot.cycleActive = false;
  h.bot.applyPendingInvestmentTarget();
  assert.equal(h.saved.pendingInvestmentTarget, null);
  h.bot.cycleActive = true;
  h.bot.setInvestmentTarget('specific-pool', h.newId);
  h.bot.market.pools[1].state.paused = true;
  h.bot.cycleActive = false;
  h.bot.applyPendingInvestmentTarget();
  assert.equal(h.saved.investmentTargetPoolId, h.oldId);
  assert.equal(h.events.at(-1).type, 'investment.target_apply_failed');
  assert.match(h.saved.pendingInvestmentTarget.error, /已暫停/);
  const failures = h.events.filter(event => event.type === 'investment.target_apply_failed').length;
  h.bot.applyPendingInvestmentTarget();
  assert.equal(h.events.filter(event => event.type === 'investment.target_apply_failed').length, failures);
});
