import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { AutoLpBot } from '../src/bot.js';
import { createProviders } from '../src/rpc/providers.js';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lpbot-rpc-management-')); }
function createBot(rpcUrls, runtimeCredentialsFile, { persist = true, timeoutMs = 1500 } = {}) {
  const bot = Object.create(AutoLpBot.prototype);
  bot.config = { chainId: 4663, rpcUrls: [...rpcUrls], rpcRequestTimeoutMs: timeoutMs,
    persistRuntimeCredentials: persist, runtimeCredentialsFile,
    walletAddress: '0x00000000000000000000000000000000000000aa', privateKey: '', blockscoutApiKey: '',
    registryAddress: '0x00000000000000000000000000000000000000bb' };
  bot.rpcEndpointIdByUrl = new Map(rpcUrls.map(endpoint => [endpoint, `opaque-${Math.random()}`]));
  bot.rpcDiagnostics = new Map();
  bot.activeRpcUrls = [...rpcUrls];
  bot.rpcHealth = rpcUrls.map((_, index) => ({ index, ok: true, reachable: true, chainValid: true,
    chainId: 4663, blockNumber: 1, latencyMs: 1, errorType: null, checkedAt: Date.now() }));
  bot.rpcManagementActive = false;
  bot.initializing = false;
  bot.cycleActive = false;
  bot.walletProfiles = new Map();
  bot.state = { getSetting: (_key, fallback) => fallback };
  bot.ledger = { append() {} };
  bot.market = { prices: new Map(), refreshedAt: 0, stateRefreshedAt: 0 };
  bot.providers = { readProvider: {}, writeProvider: {}, rawProviders: [] };
  bot.fables = {};
  bot.quoter = {};
  bot.executor = {};
  return bot;
}
async function withRpcServer(handler, fn) {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    await handler(payload, res);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}/rpc-key`); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
function jsonRpc(handler) {
  return (request, res) => {
    const result = request.method === 'eth_chainId' ? handler.chainId ?? '0x1237' : handler.block ?? '0x2a';
    res.writeHead(handler.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(handler.body || { jsonrpc: '2.0', id: request.id, result }));
  };
}
function holdBackgroundScan(bot) {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const tracked = pending.finally(() => {
    if (bot.globalPointScanPromise === tracked) bot.globalPointScanPromise = null;
  });
  bot.globalPointScanPromise = tracked;
  return { resolve, tracked };
}

test('RPC add/remove persists ordered custom endpoints and never re-adds the default RPC', async () => {
  const dir = tempDir();
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'OTHER_SETTING=keep\nRPC_URLS=https://old.invalid/key\n', 'utf8');
  const envKeys = ['RPC_URLS', 'WALLET_ADDRESS', 'PRIVATE_KEY', 'EIP7702_GUARD_VERIFIED', 'EIP7702_GUARD_VERIFIED_FOR'];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  try {
    await withRpcServer(jsonRpc({}), async newUrl => {
      await withRpcServer(jsonRpc({}), async oldUrl => {
        const bot = createBot([oldUrl], envFile);
        bot.rpcEndpointIdByUrl = new Map([[oldUrl, 'old-id']]);
        const originalEnv = fs.readFileSync(envFile, 'utf8');
        const scan = holdBackgroundScan(bot);
        await assert.rejects(bot.addRpcEndpoint(newUrl), /busy/);
        await assert.rejects(bot.removeRpcEndpoint('old-id'), /busy/);
        assert.deepEqual(bot.config.rpcUrls, [oldUrl]);
        assert.equal(fs.readFileSync(envFile, 'utf8'), originalEnv);
        scan.resolve();
        await scan.tracked;
        await bot.addRpcEndpoint(newUrl);
        assert.deepEqual(bot.config.rpcUrls, [newUrl, oldUrl]);
        let saved = fs.readFileSync(envFile, 'utf8');
        assert.ok(saved.includes(`RPC_URLS=${newUrl},${oldUrl}`));
        assert.ok(saved.includes('OTHER_SETTING=keep'));
        const id = bot.getRpcSettings().endpoints[0].id;
        const removeScan = holdBackgroundScan(bot);
        await assert.rejects(bot.removeRpcEndpoint(id), /busy/);
        assert.deepEqual(bot.config.rpcUrls, [newUrl, oldUrl]);
        removeScan.resolve();
        await removeScan.tracked;
        await bot.removeRpcEndpoint(id);
        assert.deepEqual(bot.config.rpcUrls, [oldUrl]);
        saved = fs.readFileSync(envFile, 'utf8');
        assert.ok(saved.includes(`RPC_URLS=${oldUrl}`));
        assert.ok(!saved.includes('rpc.mainnet.chain.robinhood.com'));
        const restarted = createBot(saved.match(/^RPC_URLS=(.*)$/m)[1].split(','), envFile);
        assert.deepEqual(restarted.config.rpcUrls, [oldUrl]);
        assert.equal(restarted.getRpcSettings().endpoints.length, 1);
        assert.ok(!JSON.stringify(restarted.getRpcSettings()).includes('/rpc-key'));
      });
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) value == null ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RPC rejects wrong chain, malformed block, and a removal that leaves no healthy endpoint', async () => {
  await withRpcServer(jsonRpc({ chainId: '0x1' }), async wrongUrl => {
    const bot = createBot([], '', { persist: false });
    await assert.rejects(bot.addRpcEndpoint(wrongUrl), /wrong_chain/);
    assert.deepEqual(bot.config.rpcUrls, []);
    assert.equal(bot.getRpcSettings().endpoints.length, 0);
  });
  await withRpcServer(jsonRpc({ block: 'not-a-block' }), async malformedUrl => {
    const bot = createBot([], '', { persist: false });
    await assert.rejects(bot.addRpcEndpoint(malformedUrl), /invalid_response/);
    assert.deepEqual(bot.config.rpcUrls, []);
  });
  const only = 'https://only.invalid/path';
  const bot = createBot([only], '', { persist: false });
  await assert.rejects(bot.removeRpcEndpoint(bot.getRpcSettings().endpoints[0].id), /last_healthy/);
  assert.deepEqual(bot.config.rpcUrls, [only]);
});

test('RPC probe timeout locks manual and dashboard scan paths until completion, without logging URL', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'RPC_URLS=https://existing.invalid/path\n', 'utf8');
    const bot = createBot(['https://existing.invalid/path'], file, { timeoutMs: 1000 });
    await withRpcServer(() => new Promise(() => {}), async hangingUrl => {
      const add = bot.addRpcEndpoint(hangingUrl);
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(bot.rpcManagementActive, true);
      await assert.rejects(bot.runOnce({ source: 'dashboard-scan' }), /busy/);
      await assert.rejects(bot.manualRebalance('0x' + '11'.repeat(32), '0x' + '22'.repeat(32)), /busy/);
      await assert.rejects(add, /timeout/);
      assert.equal(bot.rpcManagementActive, false);
      assert.deepEqual(bot.config.rpcUrls, ['https://existing.invalid/path']);
      assert.ok(!fs.readFileSync(file, 'utf8').includes(hangingUrl));
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('retry initialize probes every configured URL after an earlier healthy-provider reduction', async () => {
  const dir = tempDir();
  try {
    let customRequests = 0;
    let publicRequests = 0;
    await withRpcServer((_request, res) => {
      customRequests++;
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate limit' }));
    }, async customUrl => {
      const respondPublic = jsonRpc({});
      await withRpcServer((request, res) => {
        publicRequests++;
        respondPublic(request, res);
      }, async publicUrl => {
        const bot = createBot([customUrl, publicUrl], '', { persist: false });
        // Simulate a previous startup having reduced runtime providers to the
        // healthy public endpoint while config still retains both URLs.
        bot.providers = createProviders({ ...bot.config, rpcUrls: [publicUrl] });
        bot.createExecutor = () => ({ async reconcileStartupJournal() {} });
        bot.refreshMarket = async () => {};
        await bot.initialize();
        assert.equal(bot.rpcHealth.length, 2);
        assert.equal(bot.rpcHealth[0].errorType, 'rate_limited');
        assert.equal(bot.rpcHealth[1].ok, true);
        assert.deepEqual(bot.activeRpcUrls, [publicUrl]);
        assert.equal(customRequests, 1);
        assert.equal(publicRequests, 2, 'first initialize probes chainId and blockNumber');

        await bot.initialize();
        assert.equal(bot.rpcHealth.length, 2);
        assert.equal(customRequests, 2);
        assert.equal(publicRequests, 4, 'second initialize re-probes chainId and blockNumber');
        assert.deepEqual(bot.activeRpcUrls, [publicUrl]);
      });
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed initialize retains fresh per-endpoint health instead of a stale healthy snapshot', async () => {
  const dir = tempDir();
  try {
    await withRpcServer((_request, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate limit' }));
    }, async firstUrl => {
      await withRpcServer((_request, res) => {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'credits exhausted' }));
      }, async secondUrl => {
        const bot = createBot([firstUrl, secondUrl], '', { persist: false });
        bot.rpcHealth = [{ ok: true, chainId: 4663 }];
        await assert.rejects(bot.initialize(), /No configured RPC endpoint is healthy/);
        assert.deepEqual(bot.rpcHealth.map(x => x.errorType), ['rate_limited', 'quota_exhausted']);
        assert.equal(bot.getRpcSettings().healthyEndpointCount, 0);
        assert.equal(bot.getRpcSettings().hasHealthyEndpoint, false);
        assert.deepEqual(bot.activeRpcUrls, []);
      });
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('successful single-endpoint probe remains healthy in the RPC settings list', async () => {
  await withRpcServer(jsonRpc({}), async url => {
    const bot = createBot([url], '', { persist: false });
    bot.rpcEndpointIdByUrl = new Map([[url, 'healthy-id']]);
    const result = await bot.probeRpcById('healthy-id');
    assert.equal(result.result.errorType, null);
    assert.equal(bot.getRpcSettings().healthyEndpointCount, 1);
    assert.equal(bot.getRpcSettings().hasHealthyEndpoint, true);
  });
});
