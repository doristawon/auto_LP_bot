import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { WalletFleet } from '../src/wallet-fleet.js';
import { WalletVault } from '../src/wallet-vault.js';

const PRIMARY_KEY = `0x${'11'.repeat(32)}`;
const SECONDARY_KEY = `0x${'22'.repeat(32)}`;
const PRIMARY = new Wallet(PRIMARY_KEY).address;
const SECONDARY = new Wallet(SECONDARY_KEY).address;

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lpbot-wallet-fleet-')); }

class FakeBot {
  constructor(config) {
    this.config = { ...config, rpcUrls: [...config.rpcUrls] };
    this.stateValues = new Map();
    this.state = { getSetting: (key, fallback) => this.stateValues.has(key) ? this.stateValues.get(key) : fallback,
      setSetting: (key, value) => this.stateValues.set(key, value) };
    this.ledger = { events: [], append: (type, value) => this.ledger.events.push({ type, value }) };
    this.market = { pools: [], prices: new Map() };
    this.snapshot = null;
    this.walletImportState = { status: 'ready', address: config.walletAddress };
    this.providers = { rawProviders: [{}], readProvider: {} };
    this.rpcHealth = [{ index: 0, ok: true, reachable: true, chainValid: true,
      chainId: 4663, blockNumber: 1, errorType: null }];
    this.executionPaused = true;
    this.cycleActive = false;
    this.running = false;
    this.starts = 0;
    this.rpcManagementActive = false;
    this.executor = { assertAtomicGuardReady: async () => {} };
    this.target = null;
  }
  createExecutor() { return { owner: this.config.walletAddress, assertAtomicGuardReady: async () => {} }; }
  getInvestmentTargetSnapshot() { return this.target; }
  setExecutionPaused(value) { this.executionPaused = value; }
  async start() { this.running = true; this.starts++; }
  stop() { this.running = false; }
  async waitForCycleIdle() {}
  async applyRpcUrls(urls, health, { persist = false } = {}) {
    assert.equal(persist, false);
    this.config.rpcUrls = [...urls];
    this.rpcHealth = health.map(item => ({ ...item }));
    this.providers = { rawProviders: health.filter(x => x.ok), readProvider: {} };
  }
}

function config(dataDir) {
  return { rpcUrls: ['https://rpc-a.invalid'], rpcHealth: [], chainId: 4663,
    walletAddress: PRIMARY, privateKey: PRIMARY_KEY, dataDir,
    stateFile: path.join(dataDir, 'bot-state.json'), persistRuntimeCredentials: true,
    eip7702GuardAddress: '0x00000000000000000000000000000000000000aa',
    dryRun: true, enableLiveWrites: false, enableAutoRedeploy: false };
}

test('wallet workers keep independent runtime, state, ledger, pause, and target', async () => {
  const dir = tempDir();
  try {
    const vault = new WalletVault(path.join(dir, '.env.wallets.json'), false);
    vault.read = () => [{ address: SECONDARY, privateKey: SECONDARY_KEY, type: 'private-key', live: false }];
    const fleet = new WalletFleet(config(dir), { Bot: FakeBot, vault, startupStaggerMs: 1 });
    const primary = fleet.getBot(PRIMARY);
    const secondary = fleet.getBot(SECONDARY);
    assert.notEqual(primary, secondary);
    assert.notEqual(primary.state, secondary.state);
    assert.notEqual(primary.ledger, secondary.ledger);
    primary.setExecutionPaused(false);
    primary.target = { poolId: 'pool-a' };
    primary.ledger.append('primary.event', {});
    assert.equal(secondary.executionPaused, true);
    assert.equal(secondary.target, null);
    assert.deepEqual(secondary.ledger.events, []);
    await fleet.start();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(primary.starts, 1);
    assert.equal(secondary.starts, 1);
    fleet.stop();
    assert.equal(primary.running, false);
    assert.equal(secondary.running, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wallet live mode and signer survive fleet reconstruction through the local vault', async () => {
  const dir = tempDir();
  try {
    const vault = new WalletVault(path.join(dir, '.env.wallets.json'), true);
    const fleet = new WalletFleet(config(dir), { Bot: FakeBot, vault });
    await fleet.mountWallet(SECONDARY, SECONDARY_KEY, 'private-key');
    await fleet.setLive(SECONDARY, true);
    fleet.stop();

    const restarted = new WalletFleet(config(dir), { Bot: FakeBot, vault });
    const worker = restarted.getBot(SECONDARY);
    assert.equal(worker.config.privateKey, SECONDARY_KEY);
    assert.equal(worker.config.dryRun, false);
    assert.equal(worker.config.enableLiveWrites, true);
    assert.equal(worker.config.enableAutoRedeploy, true);
    assert.equal(worker.executionPaused, true);
    assert.equal(worker.config.eip7702GuardVerifiedFor, SECONDARY);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('RPC mutation refuses while any wallet worker owns a cycle lock', async () => {
  const dir = tempDir();
  try {
    const vault = new WalletVault(path.join(dir, '.env.wallets.json'), false);
    vault.read = () => [{ address: SECONDARY, privateKey: SECONDARY_KEY, type: 'private-key', live: false }];
    const fleet = new WalletFleet(config(dir), { Bot: FakeBot, vault });
    let mutations = 0;
    fleet.primary.addRpcEndpoint = async () => { mutations++; };
    fleet.getBot(SECONDARY).cycleActive = true;
    await assert.rejects(fleet.rpcMutation('add', 'https://rpc-b.invalid'), /busy/);
    assert.equal(mutations, 0);
    assert.equal(fleet.primary.config.rpcUrls.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fleet RPC mutation waits for a child global points scan to settle', async () => {
  const dir = tempDir();
  try {
    const vault = new WalletVault(path.join(dir, '.env.wallets.json'), false);
    vault.read = () => [{ address: SECONDARY, privateKey: SECONDARY_KEY, type: 'private-key', live: false }];
    const fleet = new WalletFleet(config(dir), { Bot: FakeBot, vault });
    const child = fleet.getBot(SECONDARY);
    let mutations = 0;
    const next = 'https://rpc-b.invalid';
    fleet.primary.addRpcEndpoint = async () => {
      mutations++;
      fleet.primary.config.rpcUrls = [next, ...fleet.primary.config.rpcUrls];
      fleet.primary.rpcHealth = fleet.primary.config.rpcUrls.map((_, index) => ({ index, ok: true,
        reachable: true, chainValid: true, chainId: 4663, blockNumber: 2, errorType: null }));
      return { ok: true };
    };
    fleet.primary.removeRpcEndpoint = async () => {
      mutations++;
      fleet.primary.config.rpcUrls = [next];
      fleet.primary.rpcHealth = [{ index: 0, ok: true, reachable: true, chainValid: true,
        chainId: 4663, blockNumber: 2, errorType: null }];
      return { ok: true };
    };

    let resolveScan;
    const scan = new Promise(resolve => { resolveScan = resolve; });
    child.globalPointScanPromise = scan;
    await assert.rejects(fleet.rpcMutation('add', next), /busy/);
    await assert.rejects(fleet.rpcMutation('remove', 'some-id'), /busy/);
    assert.equal(mutations, 0);
    assert.deepEqual(fleet.primary.config.rpcUrls, ['https://rpc-a.invalid']);
    assert.deepEqual(child.config.rpcUrls, ['https://rpc-a.invalid']);

    resolveScan();
    await scan;
    child.globalPointScanPromise = null;
    await fleet.rpcMutation('add', next);
    assert.equal(mutations, 1);
    assert.deepEqual(fleet.primary.config.rpcUrls, [next, 'https://rpc-a.invalid']);
    assert.deepEqual(child.config.rpcUrls, [next, 'https://rpc-a.invalid']);

    let resolveRemoveScan;
    const removeScan = new Promise(resolve => { resolveRemoveScan = resolve; });
    child.globalPointScanPromise = removeScan;
    await assert.rejects(fleet.rpcMutation('remove', 'opaque-id'), /busy/);
    assert.equal(mutations, 1);
    assert.deepEqual(fleet.primary.config.rpcUrls, [next, 'https://rpc-a.invalid']);
    resolveRemoveScan();
    await removeScan;
    child.globalPointScanPromise = null;
    await fleet.rpcMutation('remove', 'opaque-id');
    assert.equal(mutations, 2);
    assert.deepEqual(fleet.primary.config.rpcUrls, [next]);
    assert.deepEqual(child.config.rpcUrls, [next]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wallet launch waits for an active RPC mutation and rate/quota failures back off with wallet jitter', async () => {
  const dir = tempDir();
  try {
    const vault = new WalletVault(path.join(dir, '.env.wallets.json'), false);
    vault.read = () => [{ address: SECONDARY, privateKey: SECONDARY_KEY, type: 'private-key', live: false }];
    const fleet = new WalletFleet(config(dir), { Bot: FakeBot, vault,
      startupRetryJitterMs: 30_000, managementRetryMs: 5 });
    const primary = fleet.primary;
    const secondary = fleet.getBot(SECONDARY);

    fleet.running = true;
    primary.rpcManagementActive = true;
    fleet.launch(primary);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(primary.starts, 0, 'launch must remain deferred while RPC mutation is active');
    primary.rpcManagementActive = false;
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(primary.starts, 1, 'launch should proceed after the mutation settles');

    primary.rpcHealth = [{ errorType: 'rate_limited' }];
    secondary.rpcHealth = [{ errorType: 'quota_exhausted' }];
    assert.equal(fleet.initializationRetryDelay(primary, new Error('init failed')), 300_000);
    assert.equal(fleet.initializationRetryDelay(secondary, new Error('init failed')), 330_000);
    fleet.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
