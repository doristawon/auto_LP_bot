import test from 'node:test';
import assert from 'node:assert/strict';
import { PortfolioAnalytics } from '../src/analytics/portfolio.js';

const TOKEN0 = '0x0000000000000000000000000000000000000010';
const TOKEN1 = '0x0000000000000000000000000000000000000020';
const Q96 = 2 ** 96;

test('LP IL baseline incorporates added shares instead of resetting', () => {
  const settings = new Map();
  const state = {
    getSetting(key, fallback = null) { return settings.has(key) ? settings.get(key) : fallback; },
    setSetting(key, value) { settings.set(key, value); }
  };
  let portfolioBaseline = null;
  const ledger = {
    readBaseline() { return portfolioBaseline; },
    writeBaseline(value) { portfolioBaseline = value; },
    append() {},
    all() { return []; },
    sum() { return 0; }
  };
  const analytics = new PortfolioAnalytics({}, ledger, state);
  const position = {
    id: '0x0000000000000000000000000000000000000030',
    shares: 10n ** 18n,
    owed0: 0n,
    owed1: 0n,
    tickLower: -100,
    tickUpper: 100,
    outside: false
  };
  const pool = {
    id: '0x0000000000000000000000000000000000000040',
    key: { hooks: '0x0000000000000000000000000000000000000050' },
    token0: { address: TOKEN0, symbol: 'MOO', decimals: 18 },
    token1: { address: TOKEN1, symbol: 'USDG', decimals: 18 },
    state: { sqrtPriceX96: Q96, tick: 0 },
    positions: [position]
  };
  const prices = new Map([[TOKEN0, 1], [TOKEN1, 1]]);
  const build = () => analytics.build({ targetPools: [pool], walletBalances: {}, prices });

  const initial = build().positions[0];
  const baselineKey = `positionBaseline:${pool.id}:${position.id}`;
  const savedBaseline = state.getSetting(baselineKey);
  assert.equal(initial.ilBaselineAdjustments, 0);

  position.shares *= 2n;
  const afterAdd = build().positions[0];
  const adjustedBaseline = state.getSetting(baselineKey);
  assert.equal(adjustedBaseline.createdAt, savedBaseline.createdAt);
  assert.equal(adjustedBaseline.shares, position.shares.toString());
  assert.equal(adjustedBaseline.adjustmentCount, 1);
  assert.ok(Math.abs(afterAdd.ilUsd) < 1e-9);
  assert.equal(afterAdd.ilBaselineCreatedAt, savedBaseline.createdAt);

  position.shares /= 2n;
  const afterPartialWithdraw = build().positions[0];
  const withdrawnBaseline = state.getSetting(baselineKey);
  assert.equal(withdrawnBaseline.shares, position.shares.toString());
  assert.equal(withdrawnBaseline.adjustmentCount, 2);
  assert.ok(Math.abs(withdrawnBaseline.amount0 - savedBaseline.amount0) < 1e-9);
  assert.ok(Math.abs(withdrawnBaseline.amount1 - savedBaseline.amount1) < 1e-9);
  assert.ok(Math.abs(afterPartialWithdraw.ilUsd) < 1e-9);
});
