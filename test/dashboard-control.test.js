import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardServer } from '../src/dashboard/server.js';

function makeHarness() {
  const calls = { scans: [], manual: [], pause: [] };
  const config = {
    dashboardEnabled: true,
    dashboardHost: '127.0.0.1',
    dashboardPort: 0,
    dashboardToken: '',
    dashboardManualControlEnabled: false
  };
  const bot = {
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
    setExecutionPaused(value, source) {
      calls.pause.push({ value, source });
    },
    async manualRebalance(poolId, positionId, source) {
      calls.manual.push({ poolId, positionId, source });
      return { status: 'dry-run' };
    }
  };
  const ledger = {
    readSnapshot() { return bot.snapshot; },
    list() { return []; },
    append() {}
  };
  const pointsTracker = { setActualBaseline() {} };
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

test('dashboard scan is observation-only and never requests execution', async () => {
  await withServer(async ({ calls }, base) => {
    const response = await fetch(base + '/api/control/scan', { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal(calls.scans.length, 1);
    assert.equal(calls.scans[0].executeRebalances, false);
    assert.equal(calls.scans[0].source, 'dashboard-scan');
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

test('dashboard manual rebalance is fail-closed until explicitly armed', async () => {
  await withServer(async ({ calls }, base) => {
    const response = await fetch(base + '/api/control/rebalance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ poolId: '0x' + '11'.repeat(32), positionId: '0x' + '22'.repeat(32), confirm: 'NO' })
    });
    assert.equal(bad.status, 400);
    assert.equal(calls.manual.length, 0);

    const good = await fetch(base + '/api/control/rebalance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ poolId: '0x' + '11'.repeat(32), positionId: '0x' + '22'.repeat(32), confirm: 'REBALANCE' })
    });
    assert.equal(good.status, 200);
    assert.equal(calls.manual.length, 1);
    assert.equal(calls.manual[0].source, 'dashboard');
  });
});
