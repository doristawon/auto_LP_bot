import test from 'node:test';
import assert from 'node:assert/strict';
import { FablesAdapter } from '../src/adapters/fables.js';

test('wallet-active discovery queries all registered hooks in one address-filtered log scan', async () => {
  const calls = [];
  const hooks = [
    '0x0000000000000000000000000000000000000011',
    '0x0000000000000000000000000000000000000022'
  ];
  const pools = hooks.map((hook, index) => ({
    id: '0x' + String(index + 1).padStart(64, '0'),
    key: {
      currency0: '0x0000000000000000000000000000000000000031',
      currency1: '0x0000000000000000000000000000000000000032',
      fee: 3000,
      tickSpacing: 60,
      hooks: hook
    },
    token0: { address: '0x0000000000000000000000000000000000000031', symbol: 'A' },
    token1: { address: '0x0000000000000000000000000000000000000032', symbol: 'B' }
  }));
  const config = {
    registryAddress: '0x0000000000000000000000000000000000000033',
    walletAddress: '0x00000000000000000000000000000000000000aa',
    targetMode: 'wallet-active',
    targetPoolIds: [],
    targetSymbols: [],
    positionIds: [],
    logChunkBlocks: 5000,
    minLogChunkBlocks: 500
  };
  const adapter = new FablesAdapter({
    async getLogs(filter) { calls.push(filter); return []; }
  }, config);

  const result = await adapter.discoverWalletActivePools(pools, 100, 200);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].address, hooks);
  assert.equal(result.activePools.length, 0);
  assert.equal(result.knownRangeKeys.length, 0);
});
