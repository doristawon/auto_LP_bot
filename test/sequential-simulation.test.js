import assert from 'node:assert/strict';
import test from 'node:test';
import { simulateSequentialCalls } from '../src/execution/sequential-simulation.js';

const args = {
  walletAddress: '0x0000000000000000000000000000000000000001',
  chainId: 4663,
  calls: [
    { to: '0x0000000000000000000000000000000000000002', data: '0x1234', gasLimit: 300000 },
    { to: '0x0000000000000000000000000000000000000003', data: '0x5678', gasLimit: 1200000 }
  ]
};

test('sequential simulation checks the chain and every call status', async () => {
  const methods = [];
  const provider = { send: async (method, params) => {
    methods.push(method);
    if (method === 'eth_chainId') return '0x1237';
    assert.equal(params[0].blockStateCalls[0].calls.length, 2);
    assert.equal(params[0].blockStateCalls[0].calls[0].from, args.walletAddress);
    return [{ calls: [{ status: '0x1', logs: [] }, { status: '0x1', logs: [] }] }];
  } };
  assert.equal((await simulateSequentialCalls(provider, args)).length, 2);
  assert.deepEqual(methods, ['eth_chainId', 'eth_simulateV1']);
});

test('sequential simulation fails closed for a reverted deposit', async () => {
  const provider = { send: async (method) => method === 'eth_chainId'
    ? '0x1237'
    : [{ calls: [{ status: '0x1' }, { status: '0x0', error: { message: 'deposit rejected' } }] }] };
  await assert.rejects(simulateSequentialCalls(provider, args), /call 2 failed: deposit rejected/);
});
