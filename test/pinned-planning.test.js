import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinnedPlanningContext } from '../src/execution/pinned-planning.js';
import { pinnedSimulationProvider } from '../src/execution/pinned-simulation.js';
import { RebalanceExecutor } from '../src/adapters/executor.js';

test('complete atomic cross-pool rehearsal pins withdrawal inventory and final simulation together', async () => {
  const requests = [];
  const provider = { send: async (method, args) => {
    requests.push({ method, args });
    if (method === 'eth_blockNumber') return '0x123';
    return '0x';
  }, getRpcTransaction: value => value };
  const pool = { id: 'pool', token0: { address: 'a' }, token1: { address: 'b' },
    key: {}, state: { tick: 1 } };
  const executor = Object.assign(Object.create(RebalanceExecutor.prototype), {
    config: { atomicDepositEnabled: true }, readProvider: provider, writeProvider: provider,
    signer: {}, fables: { provider }, quoter: { provider }, router: { provider },
    async preflightCrossPoolSequence(plan, destination) {
      if (!this.planningBlockTag) return RebalanceExecutor.prototype.preflightCrossPoolSequence.call(this, plan, destination);
      assert.equal(this.signer, null);
      plan.pool.state = { tick: 2 };
      await this.readProvider.call({ to: 'withdraw-inventory' });
      await this.writeProvider.send('eth_simulateV1', [{ sequence: 'withdraw-swap-deposit' }, 'latest']);
      assert.throws(() => this.sendVerifiedTx(), /cannot submit/);
      return { status: 'full-sequence-simulated' };
    }
  });
  const result = await executor.preflightCrossPoolSequence({ pool }, pool);
  assert.equal(result.planningBlockTag, '0x123');
  assert.equal(pool.state.tick, 1, 'rehearsal cannot overwrite live source state');
  assert.ok(requests.filter(r => ['eth_call', 'eth_simulateV1'].includes(r.method)).every(r => r.args[1] === '0x123'));
  await executor.writeProvider.send('eth_simulateV1', [{ sequence: 'fresh-broadcast-check' }, 'latest']);
  assert.equal(requests.at(-1).args[1], 'latest', 'live executor remains unpinned');
});

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
