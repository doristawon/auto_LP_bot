import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, keccak256 } from 'ethers';
import { AutoLpBot } from '../src/bot.js';
import { FablesAdapter } from '../src/adapters/fables.js';
import { candidateSwapPools } from '../src/execution/swap-routes.js';
import { chooseInvestmentAnchor } from '../src/execution/investment-target.js';
import { buildPairFundingScope } from '../src/execution/pair-funding.js';
import { buildFablesTightRange, isLpInRange } from '../src/math/ticks.js';
import { MOO_TOKENS } from '../src/execution/moo-pool-catalog.js';

const CASHCAT_POOL_ID = '0x31608601d541e868706aa557558a4d4f99c57e6dd13bd3362edcf05d00a16212';
const CASHCAT = { address: '0x020bfC650A365f8BB26819deAAbF3E21291018b4', symbol: 'CASHCAT', decimals: 18 };
const USDG = { address: MOO_TOKENS.USDG, symbol: 'USDG', decimals: 6 };
const MOO = { address: MOO_TOKENS.MOO, symbol: 'MOO', decimals: 18 };

const pool = (id, token0, token1) => ({
  id,
  key: {
    currency0: token0.address,
    currency1: token1.address,
    fee: 8388608,
    tickSpacing: 60,
    hooks: '0x08E52564Bad99E05a694b4809F397edcA417A080'
  },
  token0,
  token1,
  state: { paused: false, liquidity: 1n }
});

test('CASHCAT/USDG PoolId is accepted by ID and by the CASHCAT/USDG symbol target', () => {
  const cashcatPool = pool(CASHCAT_POOL_ID, CASHCAT, USDG);
  const allowlisted = {
    config: { targetMode: 'allowlist', targetPoolIds: [CASHCAT_POOL_ID], targetSymbols: [] }
  };
  const symbolTarget = {
    config: { targetMode: 'symbols', targetPoolIds: [], targetSymbols: ['CASHCAT', 'USDG'] }
  };

  assert.equal(FablesAdapter.prototype.matchesTarget.call(allowlisted, cashcatPool), true);
  assert.equal(FablesAdapter.prototype.matchesTarget.call(symbolTarget, cashcatPool), true);
  const bot = { cycleActive: false, state: { setSetting() {} }, market: { pools: [cashcatPool] },
    persistInvestmentTarget: (mode, selected) => ({ mode, poolId: selected.id }) };
  assert.deepEqual(AutoLpBot.prototype.setInvestmentTarget.call(bot, 'specific-pool', CASHCAT_POOL_ID),
    { mode: 'specific-pool', poolId: CASHCAT_POOL_ID });
  assert.equal(keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [CASHCAT.address, USDG.address, cashcatPool.key.fee, 60, cashcatPool.key.hooks]
  )), CASHCAT_POOL_ID);
});

test('CASHCAT/USDG tick spacing 60 produces a 240-tick Fables Tight range containing the scanned current tick', () => {
  const currentTick = -293888;
  const tight = buildFablesTightRange(currentTick, 60);

  assert.deepEqual(tight, { tickLower: -294000, tickUpper: -293760, tickDelta: 120 });
  assert.equal(tight.tickUpper - tight.tickLower, 240);
  assert.equal(isLpInRange(currentTick, -293940, -293700), true);
  assert.equal(isLpInRange(currentTick, tight.tickLower, tight.tickUpper), true);
});

test('USDG remains the anchor and token1 stablecoin dust/funding use index 1', () => {
  const source = pool('source-usdg-moo', USDG, MOO);
  const destination = pool(CASHCAT_POOL_ID, CASHCAT, USDG);
  const anchor = chooseInvestmentAnchor(
    [source.token0, source.token1], destination, [source, destination]
  );

  assert.equal(anchor.anchor.address.toLowerCase(), USDG.address.toLowerCase());
  assert.deepEqual(anchor.routes.get(MOO.address.toLowerCase()).map((item) => item.id), [source.id]);

  const scope = buildPairFundingScope(destination,
    { raw0: 70_000n, raw1: 10_000n }, USDG.address, 50);
  assert.equal(scope.stableIndex, 1);
  assert.deepEqual(scope.dustRaw, { raw0: 0n, raw1: 50n });
  assert.deepEqual(scope.funding, { raw0: 70_000n, raw1: 9_950n });
});

test('CASHCAT candidate swap routing stays on the Fables source pool without configured external routes', () => {
  const cashcatPool = pool(CASHCAT_POOL_ID, CASHCAT, USDG);
  assert.deepEqual(candidateSwapPools(cashcatPool), [cashcatPool]);
});
