import test from 'node:test';
import assert from 'node:assert/strict';
import { RebalanceExecutor } from '../src/adapters/executor.js';

const WALLET = '0x00000000000000000000000000000000000000aa';

function makeExecutor({ rpcChainId = '0x2105', broadcast = async () => { throw new Error('timeout after node accepted request'); } } = {}) {
  const settings = new Map([['activeRebalanceExecution', { id: 'test-execution', phase: 'approvals_ready' }]]);
  const events = [];
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.config = { chainId: 8453, maxGasGwei: 100, walletAddress: WALLET, confirmations: 1 };
  executor.state = {
    getSetting(key, fallback) { return settings.has(key) ? settings.get(key) : fallback; },
    setSetting(key, value) { settings.set(key, value); }
  };
  executor.ledger = { append(type, data) { events.push({ type, data }); } };
  executor.readProvider = { async call() { return '0x'; } };
  executor.writeProvider = {
    async getFeeData() { return { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n }; },
    async getBlock() { return { baseFeePerGas: 900_000_000n }; },
    async send(method) {
      assert.equal(method, 'eth_chainId');
      return rpcChainId;
    },
    async broadcastTransaction(raw) { return broadcast(raw); }
  };
  executor.signer = {
    async estimateGas() { return 21_000n; },
    async populateTransaction(tx) { return { ...tx, nonce: 3 }; },
    async signTransaction() { return '0x1234'; }
  };
  executor.getUsdPrice = () => 0;
  return { executor, settings, events };
}

test('fee quote covers a changing base fee before the sequence is budgeted', async () => {
  const { executor } = makeExecutor();
  executor.writeProvider.getFeeData = async () => ({ gasPrice: 20_000_000n });
  executor.writeProvider.getBlock = async () => ({ baseFeePerGas: 21_000_000n });
  assert.deepEqual(await executor.getPinnedFeeOverrides(), { gasPrice: 42_000_000n });
  assert.deepEqual(await executor.getPinnedFeeOverrides({ gasPrice: 42_000_000n }), { gasPrice: 42_000_000n });
});

test('contract preflight excludes fees while the signed transaction retains the buffered fee', async () => {
  const { executor } = makeExecutor({ rpcChainId: '0x1' });
  let callRequest;
  let estimateRequest;
  let populatedRequest;
  executor.readProvider.call = async (request) => { callRequest = request; return '0x'; };
  executor.signer.estimateGas = async (request) => { estimateRequest = request; return 21_000n; };
  executor.signer.populateTransaction = async (request) => { populatedRequest = request; return { ...request, nonce: 3 }; };
  await assert.rejects(
    executor.sendVerifiedTx({ label: 'fee-preflight', to: WALLET, data: '0x1234' }),
    /Write RPC chainId mismatch/
  );
  assert.deepEqual(callRequest, { to: WALLET, data: '0x1234', value: 0n, from: WALLET });
  assert.deepEqual(estimateRequest, callRequest);
  assert.equal(populatedRequest.maxFeePerGas, 1_900_000_000n);
  assert.equal(populatedRequest.maxPriorityFeePerGas, 100_000_000n);
  assert.equal(populatedRequest.chainId, 8453);
});

test('ambiguous broadcast rejection locks the execution journal with the signed hash', async () => {
  const { executor, settings, events } = makeExecutor();
  let attemptedHash = null;

  await assert.rejects(
    executor.sendVerifiedTx({ label: 'approval-test', to: WALLET, data: '0x1234' }),
    (error) => {
      assert.equal(error.code, 'BROADCAST_OUTCOME_UNCERTAIN');
      attemptedHash = error.txHash;
      return true;
    }
  );

  const journal = settings.get('activeRebalanceExecution');
  assert.equal(journal.phase, 'recovery_required');
  assert.equal(journal.pendingTx.hash, attemptedHash);
  assert.equal(journal.pendingTx.outcome, 'uncertain');
  assert.ok(events.some((event) => event.type === 'tx.broadcast_pending' && event.data.hash === attemptedHash));
  assert.ok(events.some((event) => event.type === 'tx.broadcast_uncertain' && event.data.hash === attemptedHash));
});

test('raw eth_chainId mismatch blocks a signed transaction before broadcast', async () => {
  let broadcasts = 0;
  const { executor } = makeExecutor({
    rpcChainId: '0x1',
    broadcast: async () => { broadcasts++; return { hash: '0x' + '00'.repeat(32), async wait() { return { status: 1 }; } }; }
  });

  await assert.rejects(
    executor.sendVerifiedTx({ label: 'chain-mismatch', to: WALLET, data: '0x1234' }),
    /Write RPC chainId mismatch/
  );
  assert.equal(broadcasts, 0);
});
