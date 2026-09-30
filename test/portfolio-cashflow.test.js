import test from 'node:test';
import assert from 'node:assert/strict';
import { PortfolioAnalytics } from '../src/analytics/portfolio.js';
import { ZERO_ADDRESS } from '../src/constants.js';
import { fetchEthUsdCloseAt, fetchNativeBalanceAt, fetchWalletCashflowCandidates } from '../src/adapters/wallet-cashflows.js';
import { dashboardPage } from '../src/dashboard/page.js';

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WALLET = '0x0000000000000000000000000000000000000006';

test('reverted transaction gas is included once without counting cumulative snapshots', () => {
  const events = [{ type: 'tx.reverted', hash: 'synthetic-failure', gasUsd: 0.02 },
    { type: 'tx.reverted', hash: 'synthetic-failure', gasUsd: 0.02 },
    { type: 'portfolio.snapshot', gasUsd: 1 }];
  const analytics = new PortfolioAnalytics({ usdgAddress: USDG }, {
    readBaseline: () => ({ createdAt: 1, inventory: { [USDG]: 100, [ZERO_ADDRESS]: 0 }, initialValueUsd: 100 }),
    all: () => events, sum: () => 0
  }, { getSetting: () => ({ complete: true }) });
  const result = analytics.build({ targetPools: [], trackedTokens: [{ address: USDG }],
    walletBalances: { [USDG]: { amount: 100 } }, prices: new Map([[USDG, 1]]) });
  assert.equal(result.gasUsd, 0.02);
});

test('external USDG deposit changes invested capital, while reward remains income', () => {
  const baseline = {
    createdAt: 1, inventory: { [USDG]: 100, [ZERO_ADDRESS]: 0.001 },
    initialValueUsd: 100
  };
  const events = [
    { type: 'cashflow.external_transfer', token: USDG, amount: 250, usd: 250 },
    { type: 'reward.claimed', token: USDG, amount: 1.25, usd: 1.25 }
  ];
  const state = { getSetting(key) { return key === 'cashflowCoverage' ? { complete: true } : null; } };
  const ledger = {
    readBaseline: () => baseline,
    all: () => events,
    sum: (field, type) => type === 'fee.accrual' ? 2.5 : 0
  };
  const analytics = new PortfolioAnalytics({ usdgAddress: USDG }, ledger, state);
  const result = analytics.build({
    targetPools: [],
    trackedTokens: [{ address: USDG, symbol: 'USDG' }, { address: ZERO_ADDRESS, symbol: 'ETH' }],
    walletBalances: { [USDG]: { amount: 360 }, [ZERO_ADDRESS]: { amount: 0.002 } },
    prices: new Map([[USDG, 1], [ZERO_ADDRESS, 2645]])
  });
  const expected = 360 + 0.002 * 2645 - 100 - 250;
  assert.ok(Math.abs(result.netPnlUsd - expected) < 1e-9);
  assert.equal(result.netInvestedUsd, 100 + 250);
  assert.equal(result.rewardUsd, 1.25);
  assert.equal(result.accountingComplete, true);
  assert.ok(Math.abs(result.netPnlUsd - (
    result.holdPnlUsd + result.trackedFeeUsd + result.rewardUsd + result.lpAndTradingPnlUsd
  )) < 1e-9);
});

test('legacy baseline without ETH cost cannot publish a net PnL', () => {
  const baseline = { createdAt: 1, inventory: { [USDG]: 300 }, initialValueUsd: 300 };
  const analytics = new PortfolioAnalytics({ usdgAddress: USDG }, {
    readBaseline: () => baseline, all: () => [], sum: () => 0
  }, { getSetting: () => ({ complete: true }) });
  const result = analytics.build({ targetPools: [],
    trackedTokens: [{ address: USDG }, { address: ZERO_ADDRESS }],
    walletBalances: { [USDG]: { amount: 300 }, [ZERO_ADDRESS]: { amount: 0.001 } },
    prices: new Map([[USDG, 1], [ZERO_ADDRESS, 2600]]) });
  assert.equal(result.netPnlUsd, null);
  assert.equal(result.accountingIssue, 'native-baseline-missing');
});

test('cashflow explorer paginates and never skips a transfer at the baseline time', async () => {
  const calls = [];
  const fetchPage = async (path, query) => {
    calls.push([path, query]);
    if (path.endsWith('token-transfers') && query.filter === 'to' && !query.items_count) {
      return { items: [{ timestamp: '2026-09-28T08:01:00Z', transaction_hash: 'a' }],
        next_page_params: { items_count: 1 } };
    }
    if (path.endsWith('token-transfers') && query.filter === 'to') {
      return { items: [{ timestamp: '2026-09-28T08:00:00Z', transaction_hash: 'b' }], next_page_params: null };
    }
    return { items: [], next_page_params: null };
  };
  const rows = await fetchWalletCashflowCandidates({ wallet: WALLET, usdgAddress: USDG,
    sinceMs: Date.parse('2026-09-28T08:00:00Z'), fetchPage });
  assert.equal(rows.length, 2);
  assert.equal(calls.length, 5);
});

test('native balance uses the last recorded amount before baseline', async () => {
  const balance = await fetchNativeBalanceAt({ wallet: WALLET,
    atMs: Date.parse('2026-09-28T08:00:00Z'),
    fetchPage: async () => ({ items: [
      { block_timestamp: '2026-09-28T08:01:00Z', value: '2000000000000000', block_number: 2 },
      { block_timestamp: '2026-09-28T07:59:00Z', value: '1000000000000000', block_number: 1 }
    ], next_page_params: null }) });
  assert.equal(balance.amount, 0.001);
  assert.equal(balance.blockNumber, 1);
});

test('ETH transfer basis uses its historical minute candle', async () => {
  const at = Date.parse('2026-09-26T20:57:20Z');
  const price = await fetchEthUsdCloseAt(at, async () => ({
    ok: true, json: async () => [[Math.floor(at / 60_000) * 60, 2675.3, 2676.58, 2676.58, 2676.5, 21.93]]
  }));
  assert.equal(price, 2676.5);
});

test('dashboard shows corrected capital breakdown and labels legacy snapshots', () => {
  const page = dashboardPage();
  assert.match(page, /淨損益（扣除轉入本金）/);
  assert.match(page, /持幣價格損益/);
  assert.match(page, /外部淨轉入/);
  assert.match(page, /舊版快照：未自動扣除外部轉入/);
});
