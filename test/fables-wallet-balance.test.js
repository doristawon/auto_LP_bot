import test from 'node:test';
import assert from 'node:assert/strict';
import { FablesAdapter } from '../src/adapters/fables.js';

test('wallet balance scan fails closed when a target token has unknown decimals', async () => {
  const fables = Object.create(FablesAdapter.prototype);
  fables.config = { walletAddress: '0x0000000000000000000000000000000000000001' };
  fables.provider = {};
  await assert.rejects(
    fables.readWalletBalances([{ address: '0x0000000000000000000000000000000000000002', decimals: null }]),
    /Token decimals unavailable/
  );
});
