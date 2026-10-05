import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DashboardServer } from '../src/dashboard/server.js';
import { dashboardPage } from '../src/dashboard/page.js';
import { normalizeRangePolicy } from '../src/config.js';

function makeHarness() {
  const calls = { scans: [], manual: [], rotation: [], pause: [], investmentTarget: [], allocation: [], manualBaselines: [], quoteRefreshes: 0, evidenceRefreshes: 0 };
  const config = {
    dashboardEnabled: true,
    dashboardHost: '127.0.0.1',
    dashboardPort: 0,
    dashboardToken: '',
    dashboardManualControlEnabled: false
  };
  const bot = {
    config: { walletAddress: '0x0000000000000000000000000000000000000001' },
    providers: { readProvider: {} },
    market: { pools: [], prices: new Map() },
    updatePointsSnapshot() {},
    snapshot: {
      generatedAt: 1,
      blockNumber: 100,
      bot: { dryRun: true, executionPaused: false },
      portfolio: { positions: [] }
    },
    async controlStatus() {
      return {
        dryRun: true,
        executionPaused: false,
        guard: { configured: false, verifiedFlag: false, runtimeReady: false },
        liveReady: false
      };
    },
    async runOnce(options) {
      calls.scans.push(options);
      return { blockNumber: 123, generatedAt: 456 };
    },
    async refreshPoolQuoteProbes() {
      calls.quoteRefreshes++;
      return { a: { status: 'quoted' }, b: { status: 'unavailable' } };
    },
    setExecutionPaused(value, source) {
      calls.pause.push({ value, source });
    },
    setInvestmentTarget(mode, poolId) {
      calls.investmentTarget.push({ mode, poolId });
      return { mode, poolId: poolId || null, pair: mode === 'specific-pool' ? 'USDG/MOO' : 'USDG/UBIK' };
    },
    async getInvestmentAllocationSnapshot() { return { version: 1, enabled: false, allocations: [], totalWeightBps: 0, capital: { denomination: 'USDG', totalUsdG: 12, byPool: [], priceStatus: { status: 'fresh' } }, status: 'disabled' }; },
    async setInvestmentAllocation(value) { calls.allocation.push(value); return { version: 1, ...value, status: value.enabled ? 'ready' : 'disabled' }; },
    async startExecution(source) {
      this.setExecutionPaused(false, source);
      return { ok: true, executionPaused: false, mode: 'dry-run' };
    },
    async manualRebalance(poolId, positionId, source) {
      calls.manual.push({ poolId, positionId, source });
      return { status: 'dry-run' };
    },
    async manualImmediateRotation(request) {
      calls.rotation.push(request);
      return request.previewOnly
        ? { status: 'ready', previewId: 'preview-1', destinationPair: 'USDG/MOO' }
        : { status: 'completed' };
    }
  };
  const ledger = {
    readSnapshot() { return bot.snapshot; },
    list() { return []; },
    append() {}
  };
  const pointsTracker = {
    setManualBaseline(points, at) { calls.manualBaselines.push({ points, at }); return { points, at, source: 'manual-fallback' }; },
    async refreshEvidence(args) { calls.evidenceRefreshes++; assert.equal(args.force, true); return { ok: true }; }
  };
  bot.points = pointsTracker;
  const server = new DashboardServer(config, bot, ledger, pointsTracker);
  return { server, config, bot, calls };
}

async function withServer(fn) {
  const h = makeHarness();
  await h.server.start();
  const address = h.server.server.address();
  const base = 'http://127.0.0.1:' + address.port;
  try {
    await fn(h, base);
  } finally {
    await h.server.stop();
  }
}

test('range policy endpoint applies validated settings and rejects invalid values', async () => {
  await withServer(async ({ bot }, base) => {
    let saved = null;
    bot.setRangePolicy = values => { saved = normalizeRangePolicy(values); return saved; };
    const send = values => fetch(base + '/api/settings/range-policy', { method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(values) });
    const ok = await send({ confirmDelayMin: 5, minExcursionPct: 0.25 });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).policy, { confirmDelayMin: 5, minExcursionPct: 0.25 });
    assert.equal((await send({ confirmDelayMin: 0, minExcursionPct: 0.25 })).status, 400);
    assert.deepEqual(saved, { confirmDelayMin: 5, minExcursionPct: 0.25 });
  });
});

test('single-pool switch queues behind observation and releases the flag after persistence', async () => {
  await withServer(async ({ bot, calls }, base) => {
    bot.cycleActive = true;
    setTimeout(() => { bot.cycleActive = false; }, 40);
    const response = await fetch(base + '/api/investment/allocation', { method: 'PUT',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, allocations: [] }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).enabled, false);
    assert.deepEqual(calls.allocation, [{ enabled: false, allocations: [] }]);
    assert.equal(bot.allocationUpdatePending, false);
  });
});

test('mode switch reports pending capital writes instead of silently changing the mode', async () => {
  await withServer(async ({ bot, calls }, base) => {
    bot.cycleActive = true; bot.executor = { hasPendingWrite: true };
    const response = await fetch(base + '/api/investment/allocation', { method: 'PUT',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, allocations: [] }) });
    assert.equal(response.status, 409); assert.match((await response.json()).error, /錢包交易尚未完成/);
    assert.equal(calls.allocation.length, 0); assert.equal(bot.allocationUpdatePending, false);
  });
});

test('dashboard scan is observation-only and never requests execution', async () => {
  await withServer(async ({ calls }, base) => {
    const response = await fetch(base + '/api/control/scan', { method: 'POST', headers: { origin: base } });
    assert.equal(response.status, 200);
    assert.equal(calls.scans.length, 1);
    assert.equal(calls.scans[0].executeRebalances, false);
    assert.equal(calls.scans[0].source, 'dashboard-scan');
  });
});

test('pool quote refresh is a separate read-only action', async () => {
  await withServer(async ({ calls }, base) => {
    const response = await fetch(base + '/api/pools/quotes/refresh', {
      method: 'POST', headers: { origin: base }
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).quoted, 1);
    assert.equal(calls.quoteRefreshes, 1);
    assert.equal(calls.scans.length, 0);
    assert.equal(calls.manual.length, 0);
  });
});

test('points evidence refresh reads without triggering wallet scan or trade', async () => {
  await withServer(async ({ calls }, base) => {
    const response = await fetch(base + '/api/points/evidence/refresh', {
      method: 'POST', headers: { origin: base }
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(calls.evidenceRefreshes, 1);
    assert.equal(calls.scans.length, 0);
    assert.equal(calls.manual.length, 0);
  });
});

test('dashboard status exposes manual-control arming separately from bot readiness', async () => {
  await withServer(async (_h, base) => {
    const response = await fetch(base + '/api/control/status');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.manualControlEnabled, false);
    assert.equal(body.dryRun, true);
  });
});

test('dashboard transaction ledger excludes unrelated market swaps', async () => {
  await withServer(async ({ bot }, base) => {
    bot.ledger = {
      list({ excludeTypes }) {
        return [
          { type: 'points.global_swap_fee', hash: 'market-swap' },
          { type: 'tx.confirmed', hash: 'wallet-tx' }
        ].filter((event) => !excludeTypes.has(event.type));
      }
    };
    const response = await fetch(base + '/api/events?limit=250');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.events.map((event) => event.hash), ['wallet-tx']);
  });
});

test('dashboard names unavailable custom RPC without assuming a public fallback', () => {
  const html = dashboardPage();
  assert.match(html, /自訂 RPC 暫不可用，正使用其他可用 RPC/);
  assert.match(html, /全市場 Swap 僅供積分估算/);
});

test('dashboard accepts an explicit auto-APR or specified-pool reinvest target', async () => {
  await withServer(async ({ calls }, base) => {
    const response = await fetch(base + '/api/investment/target', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ mode: 'specific-pool', poolId: '0x' + '11'.repeat(32) })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.target.mode, 'specific-pool');
    assert.deepEqual(calls.investmentTarget, [{ mode: 'specific-pool', poolId: '0x' + '11'.repeat(32) }]);
  });
});

test('investment allocation is wallet-scoped, read back, and accepts a synthetic 70/30 split', async () => {
  await withServer(async ({ calls }, base) => {
    const get = await fetch(base + '/api/investment/allocation');
    assert.equal(get.status, 200);
    assert.equal((await get.json()).enabled, false);
    const put = await fetch(base + '/api/investment/allocation', {
      method: 'PUT', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ enabled: true, allocations: [{ poolId: 'synthetic-pool-a', weightBps: 7000 }, { poolId: 'synthetic-pool-b', weightBps: 3000 }] })
    });
    assert.equal(put.status, 200);
    assert.deepEqual(calls.allocation, [{ enabled: true, allocations: [{ poolId: 'synthetic-pool-a', weightBps: 7000 }, { poolId: 'synthetic-pool-b', weightBps: 3000 }] }]);
  });
});

test('investment allocation rejects malformed shape without exposing backend details', async () => {
  await withServer(async (_h, base) => {
    const response = await fetch(base + '/api/investment/allocation', {
      method: 'PUT', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ enabled: true, allocations: [{ poolId: 'x' }, { poolId: 'y' }, { poolId: 'z' }] })
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: '請提供最多兩個池子及有效的啟用狀態。' });
  });
});

test('legacy single-pool and immediate-rotation APIs reject writes while two-pool mode is enabled', async () => {
  await withServer(async ({ bot, calls, config }, base) => {
    bot.getInvestmentAllocationSnapshot = async () => ({ enabled: true });
    const target = await fetch(base + '/api/investment/target', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ mode: 'specific-pool', poolId: 'synthetic-pool' })
    });
    assert.equal(target.status, 409);
    assert.equal(calls.investmentTarget.length, 0);
    config.dashboardManualControlEnabled = true;
    const rotation = await fetch(base + '/api/control/rotate/preview', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ poolId: 'source', destinationPoolId: 'destination' })
    });
    assert.equal(rotation.status, 409);
    assert.equal(calls.rotation.length, 0);
  });
});

test('dashboard provides a keyword-filtered specified-pool selector', () => {
  const html = dashboardPage();
  assert.match(html, /id="investmentPoolSearch" type="search"/);
  assert.match(html, /id="investmentPool"><\/select>/);
  assert.match(html, /investmentPoolSearch'\)\.addEventListener\('input'/);
  assert.match(html, /destinationPoolId=\$\('investmentPool'\)\.value\.toLowerCase\(\)/);
  assert.match(html, /錢包餘額（目前沒有 LP）/);
  assert.match(html, /id="allocationPanel"/);
  assert.match(html, /id="allocationPoolSearch" type="search"/);
  assert.match(html, /兩池各自依本池 OOR 政策重建/);
});

test('dashboard exposes separately saved OOR wait and excursion thresholds', () => {
  const html = dashboardPage();
  const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new Function(inlineScript));
  assert.match(html, /id="confirmDelayMin" type="number" min="1" max="1440" step="any" value="5"/);
  assert.match(html, /id="minExcursionPct" type="number" min="0" max="10" step="any" value="0\.25"/);
  assert.match(html, /confirmDelayMin<1\|\|confirmDelayMin>1440/);
  assert.match(html, /最小超出幅度須介於 0 至 10%/);
  assert.match(html, /區間外等待時間（分鐘）/);
  assert.match(html, /最小超出邊界幅度（%）/);
  assert.match(html, /一般區間掃描週期（秒）/);
  assert.match(html, /api\('\/api\/settings\/range-policy'/);
  assert.match(html, /JSON\.stringify\(\{confirmDelayMin,minExcursionPct\}\)/);
  assert.match(html, /等待超出邊界至少 /);
  assert.match(html, /timing\.phase==='below-threshold'/);
});

test('dashboard suppresses empty position errors and resolves verified manual LP recovery', () => {
  const html = dashboardPage();
  assert.match(html, /const reasonNote=x\.rebalanceReason\?/);
  assert.doesNotMatch(html, /translateError\(x\.rebalanceReason\|\|''\)/);
  assert.match(html, /progress\.reconciliationStatus==='verified-manual-lp-replacement'/);
  assert.match(html, /progress\.error==='Original redeposit failed; later manual LP replacement verified'/);
  assert.match(html, /已核對手動換倉/);
  assert.match(html, /已解除待復原/);
  assert.match(html, /Bot 換幣／存入未完成/);
  assert.match(html, /後續 LP 收據/);
});

test('dashboard manual rebalance is fail-closed until explicitly armed', async () => {
  await withServer(async ({ calls }, base) => {
    const response = await fetch(base + '/api/control/rebalance', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ poolId: '0x' + '11'.repeat(32), positionId: '0x' + '22'.repeat(32), confirm: 'REBALANCE' })
    });
    assert.equal(response.status, 403);
    assert.equal(calls.manual.length, 0);
  });
});

test('armed dashboard still requires explicit REBALANCE confirmation', async () => {
  await withServer(async ({ config, calls }, base) => {
    config.dashboardManualControlEnabled = true;
    const bad = await fetch(base + '/api/control/rebalance', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ poolId: '0x' + '11'.repeat(32), positionId: '0x' + '22'.repeat(32), confirm: 'NO' })
    });
    assert.equal(bad.status, 400);
    assert.equal(calls.manual.length, 0);

    const good = await fetch(base + '/api/control/rebalance', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ poolId: '0x' + '11'.repeat(32), positionId: '0x' + '22'.repeat(32), confirm: 'REBALANCE' })
    });
    assert.equal(good.status, 200);
    assert.equal(calls.manual.length, 1);
    assert.equal(calls.manual[0].source, 'dashboard');
  });
});

test('immediate rotation requires manual arming, a preview and exact destination confirmation', async () => {
  await withServer(async ({ config, calls }, base) => {
    const body = { poolId: '0x' + '11'.repeat(32), positionId: '0x' + '22'.repeat(32),
      destinationPoolId: '0x' + '33'.repeat(32), maxCostBps: 350 };
    const post = (path, data) => fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify(data)
    });
    assert.equal((await post('/api/control/rotate/preview', body)).status, 403);
    config.dashboardManualControlEnabled = true;
    const preview = await post('/api/control/rotate/preview', body);
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).preview.previewId, 'preview-1');
    assert.equal((await post('/api/control/rotate/execute', {
      ...body, previewId: 'preview-1', confirm: 'ROTATE_TO:wrong'
    })).status, 400);
    assert.equal(calls.rotation.length, 1);
    const executed = await post('/api/control/rotate/execute', {
      ...body, previewId: 'preview-1', confirm: 'ROTATE_TO:' + body.destinationPoolId + ':350'
    });
    assert.equal(executed.status, 200);
    assert.equal(calls.rotation.length, 2);
    assert.equal(calls.rotation[1].previewOnly, false);
    const direct = await post('/api/control/rotate/execute', {
      ...body, direct: true, confirm: 'ROTATE_TO:' + body.destinationPoolId + ':350'
    });
    assert.equal(direct.status, 200);
    assert.equal(calls.rotation[2].directExecute, true);
  });
});


test('dashboard resume returns conflict when bot recovery lock refuses resume', async () => {
  await withServer(async ({ bot }, base) => {
    bot.setExecutionPaused = (value) => {
      if (value === false) throw new Error('Cannot resume while rebalance execution requires review: recovery_required');
    };
    bot.startExecution = async () => {
      throw new Error('Cannot resume while rebalance execution requires review: recovery_required');
    };
    const response = await fetch(base + '/api/control/resume', { method: 'POST', headers: { origin: base } });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /Cannot resume while rebalance execution requires review/);
  });
});


test('dashboard scan returns conflict instead of stale success while bot cycle is busy', async () => {
  await withServer(async ({ bot, calls }, base) => {
    bot.cycleActive = true;
    const response = await fetch(base + '/api/control/scan', { method: 'POST', headers: { origin: base } });
    assert.equal(response.status, 409);
    assert.equal(calls.scans.length, 0);
  });
});


test('loopback dashboard does not require a token for live or manual controls', async () => {
  const h = makeHarness();
  h.config.dashboardManualControlEnabled = true;
  h.config.enableLiveWrites = true;
  h.config.dashboardToken = 'stale-local-token';
  await h.server.start();
  try {
    const address = h.server.server.address();
    const base = 'http://127.0.0.1:' + address.port;
    const access = await fetch(base + '/api/auth/status');
    assert.deepEqual(await access.json(), { tokenRequired: false });
    const response = await fetch(base + '/api/control/status');
    assert.equal(response.status, 200);
  } finally {
    await h.server.stop();
  }
});

test('dashboard still requires a token when bound outside loopback', async () => {
  const h = makeHarness();
  h.config.dashboardHost = '0.0.0.0';
  await assert.rejects(h.server.start(), /DASHBOARD_TOKEN is required when dashboard binds outside loopback/);

  h.config.dashboardToken = 'remote-test-token';
  assert.equal(h.server.authorized({ headers: {} }), false);
  assert.equal(h.server.authorized({ headers: { 'x-dashboard-token': 'remote-test-token' } }), true);
});

test('loopback dashboard rejects DNS-rebinding Host headers before serving private state', async () => {
  await withServer(async (_h, base) => {
    const attacker = await requestWithHost(base + '/api/state', 'attacker.example');
    assert.equal(attacker.status, 403);
    assert.deepEqual(attacker.body, { error: 'invalid host' });

    const local = await requestWithHost(base + '/api/state', 'localhost:' + new URL(base).port);
    assert.equal(local.status, 200);
  });
});

function requestWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'GET', headers: { host } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let body = {};
        try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
        resolve({ status: response.statusCode, body });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

test('manual points baseline endpoint writes only the fallback baseline', async () => {
  await withServer(async ({ calls }, base) => {
    const response = await fetch(base + '/api/points/baseline', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ points: 1234 })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.manualBaselines, [{ points: 1234, at: null }]);
    assert.equal((await response.json()).source, 'manual-fallback');
  });
});

test('dashboard labels source freshness limits and rebalance attention fields', () => {
  const html = dashboardPage();
  assert.match(html, /本機取得時間/);
  assert.match(html, /Fables 回應未提供統計資料的更新時間/);
  assert.match(html, /下次符合 OOR 再平衡條件時更新/);
  assert.match(html, /rebalanceBackoffNotice/);
  assert.match(html, /journal 長時間未更新/);
  assert.match(html, /手動備援分數只供顯示/);
});

test('dashboard event rows distinguish blocks, confirmed transactions, and failures', () => {
  const html = dashboardPage();
  assert.match(html, /function eventStatus\(e\)/);
  assert.match(html, /安全條件阻擋/);
  assert.match(html, /type==='tx\.confirmed'/);
  assert.match(html, /label:'鏈上交易已確認'/);
  assert.match(html, /label:'執行失敗'/);
  assert.match(html, /top-up preflight simulation failed/);
  assert.match(html, /rebalance\.top_up_completed/);
  assert.match(html, /rebalance\.top_up_dry_run_blocked/);
  assert.match(html, /lp\.topup_failed/);
  assert.match(html, /加倉流程異常；請核對 journal 與鏈上 receipt/);
});

test('dashboard shows available points reconciliation metrics with accurate coverage label', () => {
  const html = dashboardPage();
  assert.match(html, /unsettledFeeUsd/);
  assert.match(html, /calibratedPointsPerFeeUsd/);
  assert.match(html, /calibrationSource/);
  assert.match(html, /全市場交易筆數覆蓋率/);
});
