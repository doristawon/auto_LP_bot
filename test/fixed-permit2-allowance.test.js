import test from 'node:test';
import assert from 'node:assert/strict';
import { MaxUint256 } from 'ethers';
import { RebalanceExecutor } from '../src/adapters/executor.js';

const wallet = '0x0000000000000000000000000000000000000005';
const token = { address: '0xa3b6aee90017b72c0812dc1e013de70eb2917ba3' };

function executorWithCall(call) {
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.config = { walletAddress: wallet };
  executor.readProvider = { call };
  return executor;
}

test('normal Permit2 allowances never enter the fixed-infinity exception', async () => {
  const executor = executorWithCall(() => { throw new Error('unexpected probe'); });
  assert.equal(await executor.hasFixedInfinitePermit2Allowance(token, 123n), false);
});

test('only the Solady fixed-infinity error permits skipping ERC20 approve', async () => {
  const executor = executorWithCall(async (request) => {
    assert.equal(request.from, wallet);
    assert.equal(request.to, token.address);
    throw { data: '0x3f68539a' };
  });
  assert.equal(await executor.hasFixedInfinitePermit2Allowance(token, MaxUint256), true);
});

test('mutable or unexpectedly failing infinite allowance retains exact-approval path', async () => {
  const mutable = executorWithCall(async () => '0x');
  assert.equal(await mutable.hasFixedInfinitePermit2Allowance(token, MaxUint256), false);
  const unexpected = executorWithCall(async () => { throw { data: '0xdeadbeef' }; });
  await assert.rejects(
    unexpected.hasFixedInfinitePermit2Allowance(token, MaxUint256),
    (error) => error.data === '0xdeadbeef'
  );
});

test('OOR swap ceiling applies only to its configured pool', () => {
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.config = {
    maxSwapPriceImpactBps: 200,
    oorRebalanceSwapPoolId: '0x' + 'ab'.repeat(32),
    oorRebalanceMaxSwapPriceImpactBps: 350
  };
  assert.equal(executor.samePoolRebalanceMaxImpactBps({ id: '0x' + 'ab'.repeat(32) }), 350);
  assert.equal(executor.samePoolRebalanceMaxImpactBps({ id: '0x' + 'cd'.repeat(32) }), 200);
});

test('saved single pool OOR cap follows the existing authorized top-up cap without widening other pools', () => {
  const executor = Object.create(RebalanceExecutor.prototype);
  const poolId = '0x' + 'cd'.repeat(32);
  const settings = new Map([['investmentTargetMode', 'specific-pool'], ['investmentTargetPoolId', poolId]]);
  executor.state = { getSetting: (key, fallback) => settings.has(key) ? settings.get(key) : fallback };
  executor.config = { maxSwapPriceImpactBps: 200, autoTopupMaxSwapPriceImpactBps: 350,
    crossPoolMaxSwapPriceImpactBps: 350 };
  assert.equal(executor.samePoolRebalanceMaxImpactBps({ id: poolId }), 350);
  assert.equal(executor.samePoolRebalanceMaxImpactBps({ id: '0x' + 'ef'.repeat(32) }), 200);
  executor.config.autoTopupMaxSwapPriceImpactBps = 250;
  assert.equal(executor.samePoolRebalanceMaxImpactBps({ id: poolId }), 250);
  executor.config.autoTopupMaxSwapPriceImpactBps = 500;
  executor.config.crossPoolMaxSwapPriceImpactBps = 500;
  assert.equal(executor.samePoolRebalanceMaxImpactBps({ id: poolId }), 350);
  settings.set('investmentTargetMode', 'apr-highest');
  assert.equal(executor.samePoolRebalanceMaxImpactBps({ id: poolId }), 200);
});
