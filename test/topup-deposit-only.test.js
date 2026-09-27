import test from 'node:test';
import assert from 'node:assert/strict';
import { RebalanceExecutor } from '../src/adapters/executor.js';
import { getSqrtPriceAtTick } from '../src/math/v4-fixed.js';

const pool = {
  id: 'fables-test-pool',
  key: {
    currency0: '0x0000000000000000000000000000000000000010',
    currency1: '0x0000000000000000000000000000000000000020',
    fee: 8388608,
    tickSpacing: 10,
    hooks: '0x0000000000000000000000000000000000000030'
  },
  token0: { address: '0x0000000000000000000000000000000000000010', symbol: 'EARN', decimals: 18 },
  token1: { address: '0x0000000000000000000000000000000000000020', symbol: 'USDG', decimals: 18 }
};
const position = {
  id: '0x' + '44'.repeat(32),
  tickLower: -200,
  tickUpper: 200,
  shares: 500n
};

test('top-up dry-run pairs existing wallet balances and does not depend on swap output for the deposit plan', async () => {
  const events = [];
  const executor = Object.create(RebalanceExecutor.prototype);
  executor.config = {
    dryRun: true,
    enableLiveWrites: false,
    walletAddress: '0x00000000000000000000000000000000000000aa',
    swapSlippageBps: 50,
    maxSwapPriceImpactBps: 200,
    depositSlippageBps: 50,
    depositLiquidityReserveBps: 10,
    txDeadlineSec: 1200
  };
  executor.state = null;
  executor.ledger = { append(type, data) { events.push({ type, data }); } };
  executor.fables = {
    encodeDeposit() { return '0x1234'; }
  };
  executor.readProvider = { async call() { return '0x'; } };
  executor.router = {
    buildV4ExactInputSingle({ quote, deadline }) {
      return { router: '0x0000000000000000000000000000000000000099', data: '0x1234', value: 0n, quote, deadline };
    },
    async simulateV4ExactInputSingle() { return '0x'; }
  };
  executor.quoter = {
    async quoteExactInputSingleRaw(_pool, tokenIn, rawAmountIn, slippageBps) {
      rawAmountIn = BigInt(rawAmountIn);
      return {
        rawAmountIn: rawAmountIn.toString(),
        rawAmountOut: rawAmountIn.toString(),
        minRawAmountOut: (rawAmountIn * BigInt(10_000 - slippageBps) / 10_000n).toString(),
        tokenIn: tokenIn === 0 ? pool.token0.address : pool.token1.address,
        tokenOut: tokenIn === 0 ? pool.token1.address : pool.token0.address,
        gasEstimate: '100000'
      };
    }
  };
  executor.getUsdPrice = () => 1;
  executor.validateTopUpPosition = async () => ({
    state: { tick: 0, sqrtPriceX96: getSqrtPriceAtTick(0), paused: false, liquidity: 1_000_000n },
    shares: position.shares
  });
  executor.readRawPairBalances = async () => ({ raw0: 200n * 10n ** 18n, raw1: 80n * 10n ** 18n });

  const result = await executor.topUpPoolPosition({ pool, position, dustBps: 25 });
  assert.equal(result.status, 'dry-run');
  assert.notEqual(result.plan.swapPlan.direction, 'none');
  assert.equal(result.plan.swapPolicy, 'deposit-only; optional swap is disabled');
  assert.deepEqual(result.plan.projectedInventoryRaw, result.plan.fundingRaw);
  assert.notDeepEqual(result.plan.optionalSwapProjection.inventoryRaw, result.plan.fundingRaw);
  assert.equal(result.plan.depositSimulation.status, 'deposit-only-simulated');
  assert.ok(events.some((event) => event.type === 'rebalance.top_up_dry_run'));
  assert.equal(events.some((event) => event.type === 'tx.sent'), false);
});
