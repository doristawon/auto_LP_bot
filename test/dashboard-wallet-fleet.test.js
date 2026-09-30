import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardServer } from '../src/dashboard/server.js';
import { registerSensitiveValues } from '../src/logger.js';

const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeBot(address, calls) {
  return {
    config: { walletAddress: address },
    snapshot: { generatedAt: Date.now(), marker: address },
    walletImportState: { status: 'ready' },
    market: { pools: [], prices: new Map() },
    providers: { readProvider: {} },
    async controlStatus() {
      calls.status.push(address);
      if (address === A && calls.waitForA) {
        calls.enteredA.resolve();
        await calls.waitForA.promise;
      }
      return { walletAddress: address, dryRun: true, executionPaused: calls.paused.has(address), startReadiness: { ready: false } };
    },
    setExecutionPaused(value) { calls.paused.set(address, value); calls.pause.push(address); },
    setExecutionTargetPool(poolId) { calls.targets.push({ address, poolId }); return { poolId }; },
    addRpcEndpoint(url) { calls.rpc.push({ action: 'add', url }); return { ok: true }; },
    removeRpcEndpoint(id) { calls.rpc.push({ action: 'remove', id }); return { ok: true }; },
    probeRpcById(id) { calls.rpc.push({ action: 'probe', id }); return { ok: true, result: { id } }; },
    getRpcSettings() { return { ok: true, endpoints: [] }; }
  };
}

async function withFleetServer(run) {
  const calls = { status: [], pause: [], targets: [], rpc: [], paused: new Map([[A, false], [B, false]]) };
  calls.enteredA = deferred();
  const bots = new Map([[A, makeBot(A, calls)], [B, makeBot(B, calls)]]);
  const fleet = {
    defaultWalletAddress: A,
    primary: bots.get(A),
    list(activeAddress = A) {
      return [A, B].map((address) => ({ address, type: 'watch-only', signerConfigured: false,
        executionPaused: calls.paused.get(address), dryRun: true, cycleActive: false, running: false,
        poolId: null, pair: null, walletStatus: 'ready', active: address === activeAddress }));
    },
    getBot(address = '') {
      const bot = bots.get(String(address || A));
      if (!bot) throw new Error('Unknown wallet');
      return bot;
    },
    async rpcMutation(action, value) { calls.rpc.push({ action, value, via: 'fleet' }); return { ok: true }; }
  };
  const config = { dashboardEnabled: true, dashboardHost: '127.0.0.1', dashboardPort: 0,
    dashboardToken: '', dashboardManualControlEnabled: false, persistRuntimeCredentials: false };
  const ledgers = new Map([[A, { list: () => [{ wallet: A }] }], [B, { list: () => [{ wallet: B }] }]]);
  bots.get(A).ledger = ledgers.get(A);
  bots.get(B).ledger = ledgers.get(B);
  const server = new DashboardServer(config, bots.get(A), ledgers.get(A), {}, fleet);
  await server.start();
  const base = 'http://127.0.0.1:' + server.server.address().port;
  const request = (path, { method = 'GET', wallet, body } = {}) => fetch(base + path, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { origin: base, 'content-type': 'application/json' }),
      ...(wallet ? { 'X-Wallet-Address': wallet } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  try { await run({ base, request, calls, fleet, bots }); }
  finally { await server.stop(); }
}

test('wallet identity is captured per request while another wallet request awaits', async () => {
  await withFleetServer(async ({ request, calls }) => {
    const waitForA = deferred();
    calls.waitForA = waitForA;
    const enteredA = request('/api/control/status', { wallet: A });
    await calls.enteredA.promise;

    const select = await request('/api/wallet/select', { method: 'POST', wallet: A, body: { address: B } });
    assert.equal(select.status, 200);
    assert.deepEqual(calls.pause, []);

    const pauseB = await request('/api/control/pause', { method: 'POST', wallet: B });
    assert.equal(pauseB.status, 200);
    const targetB = await request('/api/pools/target', { method: 'POST', wallet: B, body: { poolId: 'pool-b' } });
    assert.equal(targetB.status, 200);

    waitForA.resolve();
    const responseA = await enteredA;
    assert.equal(responseA.status, 200);
    assert.equal((await responseA.json()).walletAddress, A);
    assert.deepEqual(calls.pause, [B]);
    assert.deepEqual(calls.targets, [{ address: B, poolId: 'pool-b' }]);

    const eventsA = await request('/api/events', { wallet: A });
    const eventsB = await request('/api/events', { wallet: B });
    assert.deepEqual((await eventsA.json()).events, [{ wallet: A }]);
    assert.deepEqual((await eventsB.json()).events, [{ wallet: B }]);
  });
});

test('missing wallet header uses primary; unknown wallet returns 404 without mutation', async () => {
  await withFleetServer(async ({ request, calls }) => {
    const primary = await request('/api/control/status');
    assert.equal((await primary.json()).walletAddress, A);

    const unknown = await request('/api/control/pause', { method: 'POST', wallet: '0x0000000000000000000000000000000000000099' });
    assert.equal(unknown.status, 404);
    assert.deepEqual(calls.pause, []);
    assert.deepEqual(calls.targets, []);
  });
});

test('wallet errors retain all worker secret redactions', async () => {
  await withFleetServer(async ({ request, bots }) => {
    const first = 'fixture-first-wallet-secret';
    const second = 'fixture-second-wallet-secret';
    registerSensitiveValues([first]);
    registerSensitiveValues([second]);
    bots.get(A).startExecution = async () => { throw new Error(`${first} ${second}`); };
    const response = await request('/api/control/resume', { method: 'POST', wallet: A });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, '[REDACTED] [REDACTED]');
  });
});

test('wallet selection validates view only and RPC mutations use fleet primary', async () => {
  await withFleetServer(async ({ request, calls }) => {
    const select = await request('/api/wallet/select', { method: 'POST', wallet: A, body: { address: B } });
    assert.equal(select.status, 200);
    assert.deepEqual(calls.pause, []);

    const add = await request('/api/settings/rpc', { method: 'POST', wallet: B, body: { action: 'add', url: 'https://rpc.invalid' } });
    assert.equal(add.status, 200);
    const remove = await request('/api/settings/rpc', { method: 'POST', wallet: B, body: { action: 'remove', id: 'rpc-id' } });
    assert.equal(remove.status, 200);
    assert.deepEqual(calls.rpc, [
      { action: 'add', value: 'https://rpc.invalid', via: 'fleet' },
      { action: 'remove', value: 'rpc-id', via: 'fleet' }
    ]);
  });
});
