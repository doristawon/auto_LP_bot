import test from 'node:test';
import assert from 'node:assert/strict';
import { pinnedSimulationProvider } from '../src/execution/pinned-simulation.js';

test('comparison pins simulations, calls and code reads to one block', async () => {
  const requests = [];
  const provider = {
    send: async (method, args) => { requests.push({ method, args }); return '0x'; },
    getRpcTransaction: value => value,
    getCode: async (address, tag) => { requests.push({ method: 'code', args: [address, tag] }); return '0x'; },
    getFeeData: async function () { assert.equal(this, provider); return { gasPrice: 1n }; }
  };
  const pinned = pinnedSimulationProvider(provider, '0x123');
  await pinned.send('eth_simulateV1', [{ validation: false }, 'latest']);
  await pinned.send('eth_call', [{ to: 'a' }, 'latest', { a: { code: '0x' } }]);
  await pinned.call({ to: 'b' }); await pinned.getCode('c');
  assert.ok(requests.every(r => r.args[1] === '0x123'));
  assert.deepEqual(requests[1].args[2], { a: { code: '0x' } });
  assert.equal(await pinned.getBlockNumber(), 0x123);
  assert.equal((await pinned.getFeeData()).gasPrice, 1n);
});

test('comparison rejects broadcasts and invalid block tags', async () => {
  assert.throws(() => pinnedSimulationProvider({}, 'latest'));
  assert.throws(() => pinnedSimulationProvider({}, '0x10000000000000000'));
  const pinned = pinnedSimulationProvider({ send: () => { throw Error('unexpected'); } }, '0x1');
  await assert.rejects(pinned.send('eth_sendRawTransaction', ['0x']), /cannot broadcast/);
  await assert.rejects(pinned.send('eth_sendTransaction', [{}]), /cannot broadcast/);
  await assert.rejects(pinned.broadcastTransaction('0x'), /cannot broadcast/);
});
