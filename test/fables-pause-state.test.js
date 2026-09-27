import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { FablesAdapter } from '../src/adapters/fables.js';
import { HOOK_ABI } from '../src/abi.js';

const hookAddress = '0x00000000000000000000000000000000000000a1';
const managerAddress = '0x00000000000000000000000000000000000000b2';
const hookInterface = new Interface(HOOK_ABI);

test('readPoolState rejects when the pool pause status cannot be read', async () => {
  const provider = {
    async call(transaction) {
      const selector = String(transaction.data).slice(0, 10).toLowerCase();
      if (selector === hookInterface.getFunction('poolManager').selector.toLowerCase()) {
        return hookInterface.encodeFunctionResult('poolManager', [managerAddress]);
      }
      if (selector === hookInterface.getFunction('paused').selector.toLowerCase()) {
        throw new Error('pause status RPC unavailable');
      }
      throw new Error(`Unexpected test RPC call ${selector}`);
    }
  };
  const adapter = new FablesAdapter(provider, { registryAddress: managerAddress });
  const pool = {
    id: '0x' + '01'.repeat(32),
    key: { hooks: hookAddress }
  };

  await assert.rejects(adapter.readPoolState(pool), /pause status RPC unavailable/);
});
