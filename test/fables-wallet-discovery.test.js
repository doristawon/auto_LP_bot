import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id, zeroPadValue } from 'ethers';
import { HOOK_ABI } from '../src/abi.js';
import { FablesAdapter } from '../src/adapters/fables.js';

const transferTopic = id('Transfer(address,address,address,uint256,uint256)');

test('wallet-active discovery scans lifecycle and wallet ERC6909 transfers on registered hooks', async () => {
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

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].address, hooks);
  assert.deepEqual(calls[0].topics, [
    [id('Deposited(address,uint256,uint128)'), id('Withdrawn(address,uint256,uint128)')],
    zeroPadValue(config.walletAddress, 32).toLowerCase()
  ]);
  assert.deepEqual(calls[1].topics, [transferTopic,
    zeroPadValue(config.walletAddress, 32).toLowerCase()]);
  assert.deepEqual(calls[2].topics, [transferTopic, null,
    zeroPadValue(config.walletAddress, 32).toLowerCase()]);
  for (const call of calls) {
    assert.equal(call.fromBlock, 100);
    assert.equal(call.toBlock, 200);
  }
  assert.equal(result.activePools.length, 0);
  assert.equal(result.knownRangeKeys.length, 0);
});

test('position discovery seeds transferred-in ERC6909 range IDs and checks outgoing IDs too', async () => {
  const wallet = '0x00000000000000000000000000000000000000aa';
  const hook = '0x0000000000000000000000000000000000000011';
  const router = '0x0000000000000000000000000000000000000099';
  const currency0 = '0x0000000000000000000000000000000000000031';
  const currency1 = '0x0000000000000000000000000000000000000032';
  const oldRange = '0x' + '11'.repeat(32);
  const newRange = '0x' + '22'.repeat(32);
  const walletTopic = zeroPadValue(wallet, 32).toLowerCase();
  const transfer = new Interface([
    'event Transfer(address caller,address indexed sender,address indexed receiver,uint256 indexed id,uint256 amount)'
  ]);
  const transferLog = (sender, receiver, rangeId, index) => ({
    address: hook,
    ...transfer.encodeEventLog(transfer.getEvent('Transfer'), [router, sender, receiver, BigInt(rangeId), 100n]),
    blockNumber: 110,
    transactionHash: `0x${String(index).repeat(64)}`,
    index
  });
  const outgoingLog = transferLog(wallet, router, BigInt(oldRange), 1);
  const incomingLog = transferLog(router, wallet, BigInt(newRange), 2);
  const hookInterface = new Interface(HOOK_ABI);
  const calls = [];
  const provider = {
    async getLogs(filter) {
      calls.push(filter);
      if (filter.topics[0] !== transferTopic) return [];
      if (filter.topics[1] === walletTopic) return [outgoingLog];
      if (filter.topics[2] === walletTopic) return [incomingLog];
      return [];
    },
    async call(tx) {
      const parsed = hookInterface.parseTransaction({ data: tx.data });
      if (parsed.name === 'balanceOf') {
        return hookInterface.encodeFunctionResult('balanceOf', [parsed.args[1] === BigInt(newRange) ? 250n : 0n]);
      }
      if (parsed.name === 'rangeKey') {
        return hookInterface.encodeFunctionResult('rangeKey', [[
          currency0, currency1, 3000, 60, hook
        ], -120, -60, true]);
      }
      throw new Error(`Unexpected hook call ${parsed.name}`);
    }
  };
  const config = {
    registryAddress: '0x0000000000000000000000000000000000000033',
    walletAddress: wallet,
    targetMode: 'wallet-active',
    targetPoolIds: [],
    targetSymbols: [],
    positionIds: [],
    logChunkBlocks: 100,
    minLogChunkBlocks: 10
  };
  const adapter = new FablesAdapter(provider, config);
  const pool = {
    id: '0x' + '33'.repeat(32),
    key: { currency0, currency1, fee: 3000, tickSpacing: 60, hooks: hook }
  };

  const walletPools = await adapter.discoverWalletActivePools([pool], 100, 120);
  assert.deepEqual(walletPools.activePoolIds, [pool.id]);
  assert.ok(walletPools.knownRangeKeys.includes(`${hook}|${oldRange}`));
  assert.ok(walletPools.knownRangeKeys.includes(`${hook}|${newRange}`));
  assert.deepEqual(walletPools.activeRangeKeys, [`${hook}|${newRange}`]);

  const result = await adapter.discoverPositions(pool, 100, 120);

  assert.deepEqual(result.positions.map((position) => position.id), [newRange]);
  assert.equal(result.positions[0].shares, 250n);
  assert.deepEqual(result.lifecycleLogs, []);
  assert.ok(calls.some((filter) => filter.topics[0] === transferTopic
    && filter.topics[1] === walletTopic));
  assert.ok(calls.some((filter) => filter.topics[0] === transferTopic
    && filter.topics[2] === walletTopic));
  for (const call of calls) {
    assert.equal(call.fromBlock, 100);
    assert.equal(call.toBlock, 120);
  }
});
