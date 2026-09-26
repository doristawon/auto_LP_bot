import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id, zeroPadValue } from 'ethers';
import { AutoLpBot } from '../src/bot.js';
import { HOOK_ABI } from '../src/abi.js';
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
    { data, value: 0n },
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
      token0: { address: MEME, symbol: 'MEME', decimals: 6 },
      token1: { address: USDG, symbol: 'USDG', decimals: 6 }
    },
    '0x' + '55'.repeat(32),
    { blockNumber: 100, index: 1 },
    { logs: [] },
    { data: '0x1234', value: 0n },
    Date.now()
  );
  assert.equal(result.ok, false);
});
