import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Interface, ZeroAddress } from 'ethers';
import { USDG } from '../src/constants.js';
import {
  KYBER_CALL_TARGET, KYBER_SWAP_SELECTOR, KYBER_ZAP_TARGET, OFFICIAL_FABLES_ZAP,
  buildKyberRoute, buildOfficialRouterData, calculateCostComparison,
  compareOfficialAndBaselineCost, previewOfficialReposition, validateKyberCallData,
  officialRepositionDeadline
} from '../src/execution/official-reposition.js';

const require = createRequire(import.meta.url);
const routerAbi = require('../src/execution/fables-zap-abi.json');
const router = new Interface(routerAbi);
const kyber = new Interface([
  'function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable'
]);
const wallet = '0x0000000000000000000000000000000000000011';
const token0 = '0x0000000000000000000000000000000000000022';
const token1 = USDG;

test('official deadline fits the pinned block cap even when config allows 20 minutes', () => {
  assert.equal(officialRepositionDeadline(2320, 1000, 1120), 1600n);
  assert.equal(officialRepositionDeadline(1400, 1000, 1120), 1400n);
  assert.throws(() => officialRepositionDeadline(2320, 1000, 1550), /stale/);
  assert.throws(() => officialRepositionDeadline(2320, null, 1120), /invalid/);
});

function kyberData({ amount = 1_000_000n, minOut = 999_000n, src = token0, dst = token1,
  receiver = OFFICIAL_FABLES_ZAP, callTarget = KYBER_CALL_TARGET,
  approveTarget = ZeroAddress, flags = 512n } = {}) {
  return kyber.encodeFunctionData('swap', [{
    callTarget, approveTarget, targetData: '0x',
    desc: { srcToken: src, dstToken: dst, srcReceivers: [callTarget], srcAmounts: [amount],
      feeReceivers: [], feeAmounts: [], dstReceiver: receiver, amount,
      minReturnAmount: minOut, flags, permit: '0x' },
    clientData: '0x'
  }]);
}

test('preview entry fails closed while disabled or for a non-USDG-token1 pool', async () => {
  let touched = false;
  const disabled = await previewOfficialReposition.call({
    config: { officialRepositionEnabled: false },
    readProvider: { getCode() { touched = true; throw new Error('unexpected RPC'); } }
  }, { plan: {}, preBalances: {}, baseline: {} });
  assert.equal(disabled, null);
  assert.equal(touched, false);

  const wrongStable = await previewOfficialReposition.call({ config: {
    officialRepositionEnabled: true, chainId: 4663, usdgAddress: USDG,
    walletAddress: wallet, eip7702GuardAddress: '0x' + '3'.repeat(40),
    officialEip7702GuardAddress: '0x' + '3'.repeat(40)
  } }, { plan: { pool: { token0: { address: token0 }, token1: { address: token0 } },
    position: {} }, preBalances: { raw0: 0n, raw1: 0n }, baseline: {
    status: 'full-sequence-simulated', projectedValueRaw1: '1', inputValueRaw1: '1',
    simulatedGasUsed: '1', valuationSqrtPriceX96: '1', finalTarget: { tickLower: -1, tickUpper: 1 }
  } });
  assert.equal(wrongStable, null);
});

test('Kyber calldata validation pins the exact target, asset flow, amount, and descriptor', () => {
  const valid = kyberData();
  const decoded = validateKyberCallData({ data: valid, amountIn: 1_000_000n,
    tokenIn: token0, tokenOut: token1 });
  assert.ok(decoded);
  assert.equal(valid.slice(0, 10), KYBER_SWAP_SELECTOR);
  for (const data of [
    kyberData({ receiver: token0 }),
    kyberData({ callTarget: token0 }),
    kyberData({ approveTarget: token0 }),
    kyberData({ src: token1 }),
    kyberData({ flags: 0n })
  ]) {
    assert.equal(validateKyberCallData({ data, amountIn: 1_000_000n,
      tokenIn: token0, tokenOut: token1 }), null);
  }
});

test('async official cost comparison awaits pinned fee and price providers and subtracts historic fees', async () => {
  const cost = await calculateCostComparison.call({
    async getPinnedFeeOverrides() { return { maxFeePerGas: 1_000_000_000n }; },
    async getUsdPrice(address) { return address === ZeroAddress ? 3000 : 1; }
  }, {
    baseline: { projectedValueRaw1: '100000000000000000000000',
      inputValueRaw1: '100000000000000000000000',
      withdrawnRaw: { raw0: '0', raw1: '100' } },
    projectedValueRaw1: 100_000_000_000_000_000_000_000n,
    claimedRaw: { raw0: 10_000n, raw1: 20_000_000_000_000_000n },
    claimProbe: { oldClaimRaw: { raw0: 0n, raw1: 0n },
      historicalClaimRaw: { raw0: 10_000n, raw1: 20_000_000_000_000_000n } },
    plan: {}, pool: { token1: { address: token1, decimals: 18 } },
    valuationSqrtPriceX96: 1n << 96n, baselineGasUsed: 100_000n, officialGasUsed: 50_000n
  });
  assert.ok(cost);
  assert.equal(cost.historicalClaimValueRaw1, 20_000_000_000_010_000n);
  assert.equal(cost.baselineGasCostRaw1, 300_000_000_000_000_000n);
  assert.equal(cost.officialGasCostRaw1, 150_000_000_000_000_000n);
});

test('cost gate requires at least one raw unit and one basis point of input value', () => {
  const cost = compareOfficialAndBaselineCost({
    baseline: { projectedValueRaw1: '1000', inputValueRaw1: '100000' },
    projectedValueRaw1: '1012', historicalClaimValueRaw1: '0',
    baselineGasCostRaw1: '0', officialGasCostRaw1: '0'
  });
  assert.equal(cost.improvementRaw1, 12n);
  assert.equal(cost.requiredImprovementRaw1, 10n);
  const insufficient = compareOfficialAndBaselineCost({
    baseline: { projectedValueRaw1: '1000', inputValueRaw1: '100000' },
    projectedValueRaw1: '1009', historicalClaimValueRaw1: '0',
    baselineGasCostRaw1: '0', officialGasCostRaw1: '0'
  });
  assert.ok(insufficient.improvementRaw1 < insufficient.requiredImprovementRaw1);
});

test('final router builder omits Permit2 with no add and creates fresh nonce for each add signature', async () => {
  const pool = { token0: { address: token0 }, token1: { address: token1 }, key: {
    currency0: token0, currency1: token1, fee: 1250, tickSpacing: 10,
    hooks: '0x0000000000000000000000000000000000000033'
  } };
  const args = { key: pool.key, oldLower: -100, oldUpper: -50, shares: 100n,
    newLower: -80, newUpper: -30, minLiquidity: 1n, deadline: 2_000_000_000n,
    recipient: wallet, add0: 0n, add1: 0n };
  const routing = { legs: [], maxFeeBps: 5 };
  const direct = await buildOfficialRouterData.call({ config: { chainId: 4663 } },
    pool, args, routing, args.deadline);
  assert.equal(router.parseTransaction({ data: direct }).name, 'reposition');

  const signedMessages = [];
  const context = { config: { chainId: 4663, walletAddress: wallet }, signer: {
    address: wallet,
    async signTypedData(domain, types, message) {
      signedMessages.push({ domain, types, message });
      return '0x1234';
    }
  } };
  const fundedArgs = { ...args, add1: 23n };
  const first = await buildOfficialRouterData.call(context, pool, fundedArgs, routing, args.deadline);
  const second = await buildOfficialRouterData.call(context, pool, fundedArgs, routing, args.deadline);
  const firstCall = router.parseTransaction({ data: first });
  const secondCall = router.parseTransaction({ data: second });
  assert.equal(firstCall.name, 'withPermit2');
  assert.equal(firstCall.args.permit.permitted.length, 1);
  assert.equal(firstCall.args.permit.permitted[0].amount, 23n);
  assert.notEqual(firstCall.args.permit.nonce, secondCall.args.permit.nonce);
  assert.equal(signedMessages.length, 2);
  assert.equal(signedMessages[0].message.spender, OFFICIAL_FABLES_ZAP);
});

test('Kyber route builder rejects an API build with a weaker minimum than configured slippage', async () => {
  const previousFetch = globalThis.fetch;
  const amount = 1_000_000n;
  let calls = 0;
  globalThis.fetch = async (_url, options = {}) => {
    calls += 1;
    if (options.method === 'POST') {
      return new Response(JSON.stringify({ data: { routerAddress: KYBER_ZAP_TARGET,
        data: kyberData({ amount, minOut: 1n }), amountOut: '1000000' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { routeSummary: {
      amountOut: '1000000', blockNumber: 123
    } } }), { status: 200 });
  };
  try {
    await assert.rejects(buildKyberRoute.call({ config: { swapSlippageBps: 50 } }, {
      tokenIn: token0, tokenOut: token1, amountIn: amount, deadline: 2_000_000_000
    }), /kyber-route-output-invalid/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
