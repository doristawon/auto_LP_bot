import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id, zeroPadValue } from 'ethers';
import { AutoLpBot } from '../src/bot.js';
import { EIP7702_GUARD_ABI, HOOK_ABI } from '../src/abi.js';
import { buildExactWithdrawBounds, getSqrtPriceAtTick } from '../src/math/v4-fixed.js';

const WALLET = '0x00000000000000000000000000000000000000AA';
const MEME = '0x00000000000000000000000000000000000000B1';
const USDG = '0x00000000000000000000000000000000000000B2';
const HOOK = '0x00000000000000000000000000000000000000C1';
const FROM = '0x00000000000000000000000000000000000000D1';
const transferTopic = id('Transfer(address,address,uint256)');
const iface = new Interface(HOOK_ABI);

test('withdrawAndClaim reconciles only the fee earned since last owed snapshot', () => {
  const pool = {
    id: '0x' + '11'.repeat(32),
    key: { currency0: MEME, currency1: USDG, fee: 3000, tickSpacing: 1, hooks: HOOK },
    token0: { address: MEME, symbol: 'MEME', decimals: 6 },
    token1: { address: USDG, symbol: 'USDG', decimals: 6 }
  };
  const rangeId = '0x' + '22'.repeat(32);
  const tickLower = -100;
  const tickUpper = 100;
  const liquidity = 1_000_000_000_000n;
  const sqrtPriceX96 = getSqrtPriceAtTick(200);
  const principal = buildExactWithdrawBounds({
    sqrtPriceX96,
    tickLower,
    tickUpper,
    liquidity,
    slippageBps: 0
  });
  assert.equal(principal.expected0, 0n);
  assert.ok(principal.expected1 > 0n);

  const previousOwed1 = 6_000_000n;
  const totalClaim1 = 10_000_000n;
  const unseen1 = totalClaim1 - previousOwed1;
  const actual1 = principal.expected1 + totalClaim1;
  const txHash = '0x' + '33'.repeat(32);
  const blockNumber = 12345;
  const logIndex = 9;

  const stateMap = new Map([
    [`feeState:${pool.id.toLowerCase()}:${rangeId.toLowerCase()}`, {
      owed0: '0',
      owed1: previousOwed1.toString(),
      shares: liquidity.toString(),
      at: 1
    }]
  ]);
  const rows = [{
    type: 'points.global_swap_fee',
    poolId: pool.id,
    blockNumber: blockNumber - 1,
    logIndex: 1,
    sqrtPriceX96: sqrtPriceX96.toString()
  }];

  const bot = Object.create(AutoLpBot.prototype);
  bot.config = { walletAddress: WALLET, usdgAddress: USDG };
  bot.market = { prices: new Map([[USDG.toLowerCase(), 1]]) };
  bot.state = {
    getSetting(key, fallback = null) { return stateMap.has(key) ? stateMap.get(key) : fallback; },
    setSetting(key, value) { stateMap.set(key, value); }
  };
  bot.ledger = {
    seenKeys: new Set(),
    all() { return [...rows]; },
    appendUnique(eventKey, type, data, ts) {
      if (this.seenKeys.has(eventKey)) return null;
      this.seenKeys.add(eventKey);
      const row = { eventKey, type, ts, ...data };
      rows.push(row);
      return row;
    }
  };
  bot.priceOf = () => 0;

  const data = iface.encodeFunctionData('withdrawAndClaim', [
    [MEME, USDG, 3000, 1, HOOK],
    tickLower,
    tickUpper,
    liquidity,
    WALLET,
    0n,
    0n,
    9999999999n,
    1000
  ]);
  const receipt = {
    logs: [{
      address: USDG,
      topics: [
        transferTopic,
        zeroPadValue(FROM, 32),
        zeroPadValue(WALLET, 32)
      ],
      data: '0x' + actual1.toString(16).padStart(64, '0')
    }]
  };
  const entry = { blockNumber, index: logIndex, transactionHash: txHash };
  const result = bot.reconcileWithdrawalUserFees(
    pool,
    rangeId,
    entry,
    receipt,
    { to: HOOK, data, value: 0n },
    Date.parse('2026-09-26T12:00:00Z')
  );

  assert.equal(result.ok, true);
  assert.equal(result.unseen1, unseen1.toString());
  const adjustment = rows.find((row) => row.type === 'points.user_fee_adjustment');
  assert.ok(adjustment);
  assert.equal(adjustment.amount1, 4);
  assert.equal(adjustment.feeUsd, 4);

  const finalState = stateMap.get(`feeState:${pool.id.toLowerCase()}:${rangeId.toLowerCase()}`);
  assert.equal(finalState.owed1, '0');
  assert.equal(finalState.shares, '0');
});

test('withdraw reconciliation fails closed when pre-withdraw swap state is unavailable', () => {
  const bot = Object.create(AutoLpBot.prototype);
  bot.config = { walletAddress: WALLET, usdgAddress: USDG };
  bot.ledger = { all() { return []; } };
  const result = bot.reconcileWithdrawalUserFees(
    {
      id: '0x' + '44'.repeat(32),
      key: { currency0: MEME, currency1: USDG, fee: 3000, tickSpacing: 1, hooks: HOOK },
      token0: { address: MEME, symbol: 'MEME', decimals: 6 },
      token1: { address: USDG, symbol: 'USDG', decimals: 6 }
    },
    '0x' + '55'.repeat(32),
    { blockNumber: 100, index: 1 },
    { logs: [] },
    { to: HOOK, data: '0x1234', value: 0n },
    Date.now()
  );
  assert.equal(result.ok, false);
});

test('guarded EIP-7702 withdrawal decodes with exact pool and wallet recipient', () => {
  const bot = Object.create(AutoLpBot.prototype);
  bot.config = { walletAddress: WALLET };
  const pool = { key: { currency0: MEME, currency1: USDG,
    fee: 3000, tickSpacing: 1, hooks: HOOK } };
  const data = new Interface(EIP7702_GUARD_ABI).encodeFunctionData('guardedWithdrawAndClaim', [
    [MEME, USDG, 3000, 1, HOOK], -100, 100, 1000n, WALLET,
    0n, 0n, 9999999999n, 1000
  ]);
  const decoded = bot.decodeWithdrawalCall(pool, { to: WALLET, data, value: 0n });
  assert.equal(decoded.ok, true);
  assert.equal(decoded.guarded, true);
  const wrongPool = { key: { ...pool.key, currency1: MEME } };
  assert.equal(bot.decodeWithdrawalCall(wrongPool, { to: WALLET, data, value: 0n }).ok, false);
});

test('guarded withdrawal backfill requires a matching historical owed decrease', async () => {
  const at = Date.parse('2026-09-28T04:00:00Z');
  const hash = '0x' + '44'.repeat(32);
  const poolId = '0x' + '11'.repeat(32);
  const positionId = '0x' + '22'.repeat(32);
  const rows = [
    { type: 'points.withdraw_fee_unresolved', ts: at, poolId, positionId,
      hash, blockNumber: 123, logIndex: 4, reason: 'unsupported-withdrawal-call:unknown' },
    { type: 'fee.owed_decrease', ts: at + 60_000, poolId, positionId,
      previousOwed0: '123', previousOwed1: '456' }
  ];
  const settings = new Map([['pointsUserCoverageBrokenV2', { at, reason: 'withdraw-fee-unresolved' }]]);
  const seenKeys = new Set();
  const bot = Object.create(AutoLpBot.prototype);
  bot.points = { predictionStartMs() { return at - 1; }, invalidate() {} };
  bot.market = { pools: [{ id: poolId }] };
  bot.providers = { readProvider: {
    async getTransactionReceipt() { return {}; }, async getTransaction() { return {}; }
  } };
  bot.state = {
    getSetting(key, fallback = null) { return settings.has(key) ? settings.get(key) : fallback; },
    setSetting(key, value) { settings.set(key, value); }
  };
  bot.ledger = {
    seenKeys, all() { return [...rows]; },
    appendUnique(key, type, data, ts) { seenKeys.add(key); rows.push({ type, ts, ...data }); },
    append(type, data) { rows.push({ type, ...data }); }
  };
  bot.reconcileWithdrawalUserFees = (_pool, _id, _entry, _receipt, _tx, _at, options) => {
    assert.deepEqual(options.previousOwed, { owed0: '123', owed1: '456' });
    assert.equal(options.historical, true);
    return { ok: true, unseen0: '0', unseen1: '0', feeUsd: 0 };
  };
  await bot.backfillGuardedWithdrawFees();
  assert.ok(seenKeys.has(`points-withdraw-fee:${hash}:4`));
  assert.equal(settings.get('pointsUserCoverageBrokenV2'), null);
});

test('guarded withdrawal backfill accepts only a recent same-position pre-withdraw snapshot', async () => {
  const at = Date.parse('2026-09-28T04:00:00Z');
  const hash = '0x' + '55'.repeat(32);
  const poolId = '0x' + '11'.repeat(32);
  const positionId = '0x' + '22'.repeat(32);
  const key = `feeState:${poolId}:${positionId}`;
  for (const snapshotAt of [at + 1, at - 6 * 60_000, at - 72_000]) {
    const rows = [{ type: 'points.withdraw_fee_unresolved', ts: at, poolId, positionId,
      hash, blockNumber: 123, logIndex: 4, reason: 'unsupported-withdrawal-call:unknown' }];
    const seenKeys = new Set();
    const bot = Object.create(AutoLpBot.prototype);
    bot.points = { predictionStartMs() { return at - 1; }, invalidate() {} };
    bot.market = { pools: [{ id: poolId }] };
    bot.providers = { readProvider: {
      async getTransactionReceipt() { return {}; }, async getTransaction() { return {}; }
    } };
    bot.state = {
      getSetting(settingKey) { return settingKey === key
        ? { owed0: '123', owed1: '456', shares: '1000', at: snapshotAt } : null; },
      setSetting() {}
    };
    bot.ledger = {
      seenKeys, all() { return [...rows]; },
      appendUnique(eventKey, type, data, ts) {
        if (seenKeys.has(eventKey)) return;
        seenKeys.add(eventKey); rows.push({ type, ts, ...data });
      }
    };
    bot.reconcileWithdrawalUserFees = (_pool, _id, _entry, _receipt, _tx, _at, options) => {
      assert.deepEqual(options.previousOwed, { owed0: '123', owed1: '456' });
      return { ok: true, feeUsd: 0 };
    };
    await bot.backfillGuardedWithdrawFees();
    assert.equal(seenKeys.has(`points-withdraw-fee:${hash}:4`), snapshotAt === at - 72_000);
  }
});
