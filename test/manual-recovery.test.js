import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { reconcileManualReplacement } from '../src/execution/manual-recovery.js';
import { AutoLpBot } from '../src/bot.js';

const address = n => '0x' + n.toString(16).padStart(40, '0');
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const wallet = address(1), hook = address(2);
const pool = { id: hash(3), key: { currency0: address(4), currency1: address(5), fee: 3000, tickSpacing: 60, hooks: hook } };
const events = new Interface([
  'event Withdrawn(address indexed owner,uint256 indexed id,uint128 liquidity)',
  'event Deposited(address indexed owner,uint256 indexed id,uint128 liquidity)',
  'event Transfer(address caller,address indexed from,address indexed to,uint256 indexed id,uint256 amount)'
]);
function harness({ recipient = wallet, transfer = false, oldShares = 0n, pending = 7, broadcast = false } = {}) {
  let journal = { id: 'job', startedAt: 1000, phase: 'recovery_required',
    poolId: pool.id, oldPosition: { id: hash(10) }, tx: { withdraw: hash(11) } };
  const records = broadcast ? [{ ts: 1001, type: 'tx.broadcast_uncertain', hash: hash(99) }] : [];
  const withdraw = { status: 1, blockNumber: 100,
    logs: [{ address: hook, ...events.encodeEventLog(events.getEvent('Withdrawn'), [wallet, 10n, 20n]) }] };
  const deposit = { hash: hash(13), status: 1, blockNumber: 110,
    logs: [{ address: hook, ...(transfer
      ? events.encodeEventLog(events.getEvent('Transfer'), [address(9), address(9), recipient, 12n, 30n])
      : events.encodeEventLog(events.getEvent('Deposited'), [recipient, 12n, 30n])) }] };
  const executor = { config: { walletAddress: wallet },
    state: { getSetting: () => journal },
    ledger: { all: () => records, append: (type, proof) => records.push({ type, ...proof }) },
    writeProvider: { getTransactionCount: async (_, tag) => tag === 'pending' ? pending : 7 },
    readProvider: { getTransactionReceipt: async tx => tx === hash(11) ? withdraw : deposit },
    readPositionShares: async (_, id) => id === hash(10) ? oldShares : 30n,
    fables: { readRangeKey: async () => ({ exists: true, key: pool.key, tickLower: -120, tickUpper: 120 }) },
    patchJournal: (_, patch) => { journal = { ...journal, ...patch }; },
    clearJournal: () => { journal = null; } };
  const options = { fetchLedger: async () => ({ LiquidityEvent: [{ kind: transfer ? 'TRANSFER_IN' : 'DEPOSIT',
    pool_id: pool.id, range_id: hash(12), block: 110, txHash: hash(13) }] }) };
  return { executor, options, records, withdraw, deposit, getJournal: () => journal };
}

for (const transfer of [false, true]) test(`manual replacement verified from ${transfer ? 'official share transfer' : 'deposit'}`, async () => {
  const h = harness({ transfer });
  const result = await reconcileManualReplacement(h.executor, pool, h.options);
  assert.equal(result.status, 'resolved'); assert.equal(result.positionId, hash(12));
  assert.equal(result.withdrawHash, hash(11)); assert.equal(result.replacementHash, hash(13));
  assert.equal(h.getJournal(), null);
  assert.equal(h.records.filter(r => r.type === 'rebalance.recovery_resolved').length, 1);
});

for (const options of [{ pending: 8 }, { oldShares: 1n }, { broadcast: true },
  { recipient: address(8) }, { recipient: address(8), transfer: true }]) {
  test(`recovery refuses unresolved evidence ${JSON.stringify(options, (_, v) => typeof v === 'bigint' ? String(v) : v)}`, async () => {
    const h = harness(options);
    await assert.rejects(reconcileManualReplacement(h.executor, pool, h.options));
    assert.equal(h.getJournal().phase, 'recovery_required');
    assert.equal(h.records.some(r => r.type === 'rebalance.recovery_resolved'), false);
  });
}

test('recovery refuses moved capital after withdrawal and wrong receipt range', async () => {
  const h = harness(); h.getJournal().tx.swap = hash(20);
  await assert.rejects(reconcileManualReplacement(h.executor, pool, h.options), /核對條件/);
  delete h.getJournal().tx.swap;
  h.withdraw.logs[0] = { address: hook, ...events.encodeEventLog(events.getEvent('Withdrawn'), [wallet, 99n, 20n]) };
  await assert.rejects(reconcileManualReplacement(h.executor, pool, h.options), /nonce/);
  assert.equal(h.getJournal().phase, 'recovery_required');
});

test('cross-pool manual replacement needs a registered PoolKey, receipt and live shares', async () => {
  const h = harness();
  const destination = { ...pool, id: hash(31), key: { ...pool.key, currency0: address(32), hooks: address(33) } };
  h.options.replacementPools = [pool, destination];
  const ledger = await h.options.fetchLedger();
  ledger.LiquidityEvent[0].pool_id = destination.id;
  h.options.fetchLedger = async () => ledger;
  h.executor.fables.readRangeKey = async p => ({ exists: true, key: p.key, tickLower: -240, tickUpper: 0 });
  h.deposit.logs[0].address = destination.key.hooks;
  const result = await reconcileManualReplacement(h.executor, pool, h.options);
  assert.equal(result.oldPoolId, pool.id);
  assert.equal(result.poolId, destination.id);
  assert.equal(h.getJournal(), null);
});

test('unknown replacement pool, foreign PoolKey and wrong receipt hash keep the lock', async () => {
  for (const reason of ['unknown-pool', 'foreign-key', 'wrong-receipt']) {
    const h = harness();
    if (reason === 'unknown-pool') {
      const data = await h.options.fetchLedger(); data.LiquidityEvent[0].pool_id = hash(30);
      h.options.fetchLedger = async () => data;
    } else if (reason === 'foreign-key') {
      h.executor.fables.readRangeKey = async () => ({ exists: true, key: { ...pool.key, fee: 10000 } });
    } else h.deposit.hash = hash(99);
    await assert.rejects(reconcileManualReplacement(h.executor, pool, h.options));
    assert.equal(h.getJournal().phase, 'recovery_required');
  }
});

test('nonce or shares changing during reconciliation do not clear recovery', async () => {
  for (const race of ['nonce', 'shares']) {
    const h = harness();
    if (race === 'nonce') {
      let calls = 0;
      h.executor.writeProvider.getTransactionCount = async () => ++calls <= 2 ? 7 : 8;
    } else {
      let reads = 0;
      h.executor.readPositionShares = async (_, position) => position === hash(10) ? 0n : ++reads === 1 ? 30n : 0n;
    }
    await assert.rejects(reconcileManualReplacement(h.executor, pool, h.options), /已變更/);
    assert.equal(h.getJournal().phase, 'recovery_required');
  }
});

test('paused read-only scan can reconcile while resume stays blocked and cycle ownership is preserved', async () => {
  const h = harness();
  // Keep this test offline while exercising the real controller and proof helper.
  const bot = { executionPaused: true, cycleActive: true, rpcManagementActive: false,
    state: h.executor.state, market: { pools: [pool] }, executor: h.executor };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: {
    ...(await h.options.fetchLedger()), Position: [], FeeClaim: []
  } }) });
  const readKey = h.executor.fables.readRangeKey;
  h.executor.fables.readRangeKey = async (...args) => {
    assert.equal(bot.rpcManagementActive, true);
    assert.throws(() => AutoLpBot.prototype.setExecutionPaused.call(bot, false), /核對交易/);
    return readKey(...args);
  };
  try {
    const result = await AutoLpBot.prototype.resolveManualRecovery.call(bot);
    assert.equal(result.status, 'resolved');
    assert.equal(bot.cycleActive, true);
    assert.equal(bot.rpcManagementActive, false);
    assert.equal(bot.executionPaused, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('recovery cannot run while execution is unpaused or a write/control mutation is active', async () => {
  for (const overrides of [{ executionPaused: false }, { rpcManagementActive: true }, { initializing: true }]) {
    const h = harness();
    const bot = { executionPaused: true, state: h.executor.state, market: { pools: [pool] }, executor: h.executor, ...overrides };
    await assert.rejects(AutoLpBot.prototype.resolveManualRecovery.call(bot), /請先暫停/);
    assert.equal(h.getJournal().phase, 'recovery_required');
  }
});
