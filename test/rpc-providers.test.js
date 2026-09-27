import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders } from '../src/rpc/providers.js';

test('RPC provider applies the configured request timeout without network access', () => {
  const providers = createProviders({
    chainId: 4663,
    rpcUrls: ['https://rpc.example.invalid'],
    rpcRequestTimeoutMs: 12_000
  });

  assert.equal(providers.rawProviders[0]._getConnection().timeout, 12_000);
  assert.equal(providers.writeProvider._getConnection().timeout, 300_000);
});
