import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { FablesAdapter } from '../src/adapters/fables.js';
import { HOOK_ABI, POOL_MANAGER_ABI } from '../src/abi.js';
import { isRpcRateLimitError, isRpcTimeoutError } from '../src/rpc/errors.js';

const hook = '0x00000000000000000000000000000000000000a1';
const manager = '0x00000000000000000000000000000000000000b2';
const hookAbi = new Interface(HOOK_ABI);
const managerAbi = new Interface(POOL_MANAGER_ABI);

test('market hydration reuses shared hook reads while direct safety reads remain fresh', async () => {
  const calls = { manager: 0, paused: 0, storage: 0 };
  const provider = {
    async call(transaction) {
      const selector = transaction.data.slice(0, 10).toLowerCase();
      if (selector === hookAbi.getFunction('poolManager').selector.toLowerCase()) {
        calls.manager++;
        return hookAbi.encodeFunctionResult('poolManager', [manager]);
      }
      if (selector === hookAbi.getFunction('paused').selector.toLowerCase()) {
        calls.paused++;
        return hookAbi.encodeFunctionResult('paused', [false]);
      }
      if (selector === managerAbi.getFunction('extsload').selector.toLowerCase()) {
        calls.storage++;
        return managerAbi.encodeFunctionResult('extsload', [[
          '0x' + '01'.padStart(64, '0'), '0x' + '00'.repeat(32),
          '0x' + '00'.repeat(32), '0x' + '02'.padStart(64, '0')
        ]]);
      }
      throw new Error('Unexpected provider call');
    }
  };
  const adapter = new FablesAdapter(provider, { registryAddress: manager });
  const pools = [1, 2].map((n) => ({ id: '0x' + n.toString(16).padStart(64, '0'), key: { hooks: hook } }));
  const hydrated = await adapter.hydratePoolStates(pools);
  assert.equal(hydrated.length, 2);
  assert.deepEqual(calls, { manager: 1, paused: 1, storage: 2 });
  await adapter.readPoolState(pools[0]);
  assert.deepEqual(calls, { manager: 2, paused: 2, storage: 3 });
});

test('rate limited log query fails immediately instead of repeatedly shrinking the block span', async () => {
  let calls = 0;
  const adapter = new FablesAdapter({
    async getLogs() { calls++; throw new Error('HTTP 429 quota exceeded'); }
  }, { registryAddress: manager, logChunkBlocks: 5000, minLogChunkBlocks: 500 });
  await assert.rejects(adapter.getLogsAdaptive({ address: hook }, 1, 5000), /429/);
  assert.equal(calls, 1);
  assert.equal(isRpcRateLimitError(new Error('HTTP 429 quota exceeded')), true);
  assert.equal(isRpcRateLimitError(new Error('temporary network timeout')), false);
  assert.equal(isRpcTimeoutError(new Error('temporary network timeout')), true);
});
