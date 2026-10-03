import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinnedPlanningContext } from '../src/execution/pinned-planning.js';
import { pinnedSimulationProvider } from '../src/execution/pinned-simulation.js';

test('isolated planning pins adapter reads and nested comparisons without a signer', async () => {
  const requests = [];
  const provider = { send: async (method, args) => {
    requests.push({ method, args }); return method === 'eth_blockNumber' ? '0x123' : '0x';
  }, getRpcTransaction: v => v };
  const adapter = { provider, async read() { return this.provider.call({ to: 'a' }); } };
  const executor = { readProvider: provider, writeProvider: provider, signer: {},
    fables: adapter, router: adapter, quoter: { ...adapter, v3PendingPools: new Map([['original', 1]]) } };
  const context = await createPinnedPlanningContext(executor);
  await context.fables.read(); await context.quoter.read(); await context.router.read();
  assert.equal(context.signer, null);
  assert.equal(executor.signer !== null, true);
  assert.equal(executor.fables.provider, provider);
  assert.equal(executor.quoter.v3PendingPools.size, 1);
  assert.equal(context.quoter.v3PendingPools.size, 0);
  assert.ok(requests.filter(r => r.method === 'eth_call').every(r => r.args[1] === '0x123'));
  for (const method of ['sendVerifiedTx','ensureSwapAllowances','runWalletWrite']) {
    assert.throws(() => context[method](), /cannot submit/);
  }
  await assert.rejects(context.writeProvider.send('eth_sendRawTransaction', ['0x']), /cannot broadcast/);
  const comparison = { ...executor,
    readProvider: pinnedSimulationProvider(provider, '0x100'),
    writeProvider: pinnedSimulationProvider(provider, '0x100') };
  const nested = await createPinnedPlanningContext(comparison);
  assert.equal(nested.planningBlockTag, '0x100');
  assert.equal(await nested.readProvider.getBlockNumber(), 256);
});
