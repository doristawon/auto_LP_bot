import { createRequire } from 'node:module';
import {
  AbiCoder, Contract, Interface, ZeroAddress, getAddress, hexlify, keccak256, randomBytes
} from 'ethers';
import {
  EIP7702_GUARD_ABI, ERC20_ABI, HOOK_ABI
} from '../abi.js';
import { PERMIT2, USDG, ZERO_ADDRESS } from '../constants.js';
import { collectOfficialClaimRanges } from './official-fee-claims.js';
import { buildPairFundingScope } from './pair-funding.js';
import { quotePriceImpactBps } from './exact-rebalance.js';
import { simulateSequentialCalls } from './sequential-simulation.js';
import { getAmountsForLiquidity, getSqrtPriceAtTick } from '../math/v4-fixed.js';
import { isLpInRange, isLpOutOfRange } from '../math/ticks.js';

const require = createRequire(import.meta.url);
const FABLES_ZAP_ABI = require('./fables-zap-abi.json');

export const OFFICIAL_FABLES_ZAP = '0x89d862d7a189627B229aa3Ac28Ae565f6Fb89d1f';
export const OFFICIAL_FABLES_ZAP_CODE_HASH = '0x92ba1c510d3aa52ad14a29cc41a74374405d4c881b08b176cc11b0accfa2cbbb';
export const KYBER_ZAP_TARGET = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
export const KYBER_CALL_TARGET = '0x8F10B468b06c6FD214B65F87778827F7D113f996';
export const KYBER_SWAP_SELECTOR = '0xe21fd0e9';
export const OFFICIAL_CLAIM_LIMIT = 16;
export const OFFICIAL_MAX_SIMULATION_CALLS = 32;
export const OFFICIAL_GUARD_GAS_LIMIT = 10_000_000;

const Q192 = 1n << 192n;
const KYBER_ORIGIN = 'https://aggregator-api.kyberswap.com/robinhood/api/v1';
const PINNED_PERMIT2 = getAddress(PERMIT2);
const PINNED_ZAP = getAddress(OFFICIAL_FABLES_ZAP);
const PINNED_KYBER_TARGET = getAddress(KYBER_ZAP_TARGET);
const PINNED_KYBER_CALL_TARGET = getAddress(KYBER_CALL_TARGET);
const router = new Interface(FABLES_ZAP_ABI);
const guard = new Interface(EIP7702_GUARD_ABI);
const erc20 = new Interface(ERC20_ABI);
const hookClaims = new Interface(HOOK_ABI);
const hookApproval = new Interface([
  'function allowance(address owner,address spender,uint256 id) view returns(uint256)',
  'function approve(address spender,uint256 id,uint256 amount) returns(bool)',
  'function balanceOf(address owner,uint256 id) view returns(uint256)'
]);
const stateView = new Interface([
  'function getSlot0(bytes32) view returns(uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)'
]);
const kyber = new Interface([
  'function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable'
]);
const coder = AbiCoder.defaultAbiCoder();

const PERMIT2_TYPES = {
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' }
  ],
  PermitBatchTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions[]' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
};

/**
 * Compare a fully simulated official same-pool reposition with the existing
 * guarded withdraw+redeposit path. All failures happen before broadcast and
 * return null; this module never submits a transaction or changes live state.
 */
export async function previewOfficialReposition({ plan, preBalances, baseline }) {
  const safePoolId = String(plan?.pool?.id || '').toLowerCase();
  try {
    if (!eligible(this, plan, preBalances, baseline)) return null;
    const pool = plan.pool;
    const wallet = getAddress(this.config.walletAddress);
    const [latest, liveBalances, shareBalance] = await Promise.all([
      this.fables.readPoolState(pool),
      this.readRawPairBalances(pool),
      this.readPositionShares(pool, plan.position.id)
    ]);
    if (latest?.paused !== false || !isLpOutOfRange(latest.tick,
      plan.position.tickLower, plan.position.tickUpper)) return null;
    if (shareBalance !== BigInt(plan.position.shares)) return null;
    if (BigInt(liveBalances.raw0) !== BigInt(preBalances.raw0)
      || BigInt(liveBalances.raw1) !== BigInt(preBalances.raw1)) return null;

    const target = normalizeTarget(baseline.finalTarget, pool.key.tickSpacing, latest.tick);
    if (!target || !isLpInRange(latest.tick, target.tickLower, target.tickUpper)
      || (target.tickLower === Number(plan.position.tickLower)
        && target.tickUpper === Number(plan.position.tickUpper))) return null;
    if (BigInt(baseline.valuationSqrtPriceX96) <= 0n
      || BigInt(latest.sqrtPriceX96) <= 0n) return null;

    await assertPinnedRouter.call(this, pool);
    const collectedRanges = await collectOfficialClaimRanges({
      pool, walletAddress: wallet, provider: this.readProvider, currentPosition: plan.position,
      maxFeeBps: Number(this.config.maxFeeBps ?? 1000)
    });
    const claimSet = normalizeClaimRanges(collectedRanges, plan.position);
    const fundingScope = buildPairFundingScope(pool, liveBalances, this.config.usdgAddress || USDG,
      this.config.autoTopupDustBps ?? 0);
    const claimProbe = await simulateClaimAmounts.call(this, pool, wallet, claimSet, liveBalances);
    const add0 = fundingScope.funding.raw0 + claimProbe.claimedRaw.raw0;
    const add1 = fundingScope.funding.raw1 + claimProbe.claimedRaw.raw1;
    const comparisonBlock = await this.readProvider.getBlock(await this.readProvider.getBlockNumber());
    const deadline = officialRepositionDeadline(this.deadline(), comparisonBlock?.timestamp);
    const routerArgs = baseRepositionArgs(plan, pool, target, wallet, deadline, add0, add1);
    const emptyRouting = { legs: [], maxFeeBps: 5 };
    const expectedRangeId = rangeId(pool.id, target.tickLower, target.tickUpper);

    const maxImpact = Number(this.samePoolRebalanceMaxImpactBps(pool));
    if (!Number.isInteger(maxImpact) || maxImpact < 0 || maxImpact > 1000) return null;
    const routes = [{ name: 'fables-native', routing: emptyRouting }];
    let routeFit = null;
    try {
      routeFit = await fitKyberRoute.call(this, {
        pool, plan, target, routerArgs, deadline, feeBps: 5, sqrtPriceX96: BigInt(latest.sqrtPriceX96),
        valuationSqrtPriceX96: BigInt(baseline.valuationSqrtPriceX96), maxImpact
      });
      if (routeFit?.routing?.legs?.length) routes.push({ name: 'kyberswap', routing: routeFit.routing });
    } catch (error) {
      this.ledger?.append('rebalance.official_route_unavailable', {
        poolId: safePoolId, reason: sanitizeFailureReason(error)
      });
    }

    const scored = [];
    for (const route of routes) {
      try {
        const candidate = await buildScoredCandidate.call(this, {
          plan, pool, wallet, target, claimSet, liveBalances, fundingScope, routerArgs,
          route, routeFit: route.name === 'kyberswap' ? routeFit : null,
          deadline, baseline, claimProbe, expectedRangeId
        });
        if (candidate) scored.push(candidate);
      } catch (error) {
        this.ledger?.append('rebalance.official_candidate_unavailable', {
          poolId: safePoolId, route: route.name, reason: sanitizeFailureReason(error),
          revertSelector: safeRevertSelector(error),
          errorKind: ['TypeError', 'ReferenceError', 'RangeError'].includes(error?.name) ? error.name : 'Error',
          sourceLocations: String(error?.stack || '').match(/(?:official-reposition|sequential-simulation)\.js:\d+:\d+/g)?.slice(0, 3) || []
        });
      }
    }
    scored.sort((a, b) => BigInt(a.cost.officialNetRaw1) > BigInt(b.cost.officialNetRaw1) ? -1
      : BigInt(a.cost.officialNetRaw1) < BigInt(b.cost.officialNetRaw1) ? 1 : 0);
    const best = scored[0];
    if (!best) return null;
    const { finalSimulation, finalRouterData, minLiquidity, projectedValueRaw1, cost, route } = best;
    const summary = {
      method: 'official-reposition-and-claim',
      router: OFFICIAL_FABLES_ZAP,
      route: route.name,
      routeQuoteBlockNumber: best.routeFit?.quoteBlockNumber ?? null,
      comparison: 'pinned RPC simulation at one block; Kyber quote/build may be newer',
      routerFeeBps: 5,
      priceImpactBps: best.routeFit?.priceImpactBps?.toString() ?? '0',
      routeAmountIn: best.routeFit?.amountIn?.toString() ?? '0',
      routeQuotedOut: best.routeFit?.quotedOut?.toString() ?? '0',
      routeMinOut: best.routeFit?.minOut?.toString() ?? '0',
      baselineProjectedValueRaw1: String(baseline.projectedValueRaw1),
      officialProjectedValueRaw1: projectedValueRaw1.toString(),
      historicalClaimValueRaw1: cost.historicalClaimValueRaw1.toString(),
      baselineGasCostRaw1: cost.baselineGasCostRaw1.toString(),
      officialGasCostRaw1: cost.officialGasCostRaw1.toString(),
      baselineNetValueRaw1: cost.baselineNetRaw1.toString(),
      officialNetValueRaw1: cost.officialNetRaw1.toString(),
      improvementRaw1: cost.improvementRaw1.toString(),
      requiredImprovementRaw1: cost.requiredImprovementRaw1.toString(),
      simulatedGasUsed: BigInt(finalSimulation.gasUsed).toString(),
      claimRangeCount: claimSet.claimRanges.length
    };
    return {
      request: { to: wallet, data: guard.encodeFunctionData('guardedRepositionAndClaim', [{
        expectedBalance0: BigInt(liveBalances.raw0), expectedBalance1: BigInt(liveBalances.raw1),
        funding0: fundingScope.funding.raw0, funding1: fundingScope.funding.raw1,
        claimLower: claimSet.claimRanges.map(item => item.tickLower),
        claimUpper: claimSet.claimRanges.map(item => item.tickUpper),
        walk: Number(this.config.fablesWalk), maxResidualBps: 50, routerData: finalRouterData
      }]), value: 0n },
      summary,
      expected: {
        liquidity: String(finalSimulation.expected.liquidity),
        minLiquidity: minLiquidity.toString(),
        rangeId: expectedRangeId.toString(),
        claim0: String(finalSimulation.expected.claim0),
        claim1: String(finalSimulation.expected.claim1),
        residual0: String(finalSimulation.expected.residual0),
        residual1: String(finalSimulation.expected.residual1)
      },
      claimRanges: claimSet.claimRanges,
      target,
      projectedValueRaw1: projectedValueRaw1.toString(),
      gasUsed: BigInt(finalSimulation.gasUsed).toString(),
      protected: {
        raw0: fundingScope.dustRaw.raw0.toString(),
        raw1: fundingScope.dustRaw.raw1.toString()
      }
    };
  } catch (error) {
    // Never persist RPC revert data, typed data, signature bytes, or calldata.
    try {
      this.ledger?.append('rebalance.official_unavailable', {
        poolId: safePoolId,
        reason: sanitizeFailureReason(error)
      });
    } catch {}
    return null;
  }
}

function normalizeClaimRanges(rows, currentPosition) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > OFFICIAL_CLAIM_LIMIT) {
    throw new Error('claim-range-count-invalid');
  }
  const currentId = BigInt(currentPosition.id);
  const normalized = rows.map((row) => {
    const rangeIdValue = BigInt(row.rangeId);
    const tickLower = Number(row.tickLower), tickUpper = Number(row.tickUpper);
    if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper) || tickLower >= tickUpper) {
      throw new Error('claim-range-ticks-invalid');
    }
    return { rangeId: `0x${rangeIdValue.toString(16).padStart(64, '0')}`, tickLower: String(tickLower),
      tickUpper: String(tickUpper), current: row.current === true };
  });
  const current = normalized.filter(row => row.current);
  if (current.length !== 1 || BigInt(current[0].rangeId) !== currentId
    || Number(current[0].tickLower) !== Number(currentPosition.tickLower)
    || Number(current[0].tickUpper) !== Number(currentPosition.tickUpper)) {
    throw new Error('claim-current-range-mismatch');
  }
  const seen = new Set();
  for (const item of normalized) {
    const key = `${item.rangeId}:${item.tickLower}:${item.tickUpper}`;
    if (seen.has(key)) throw new Error('claim-range-duplicate');
    seen.add(key);
  }
  return { claimRanges: [current[0], ...normalized.filter(row => !row.current)] };
}

export function validateKyberCallData({ data, amountIn, tokenIn, tokenOut, destination = OFFICIAL_FABLES_ZAP }) {
  try {
    if (typeof data !== 'string' || data.slice(0, 10).toLowerCase() !== KYBER_SWAP_SELECTOR) return null;
    const parsed = kyber.parseTransaction({ data });
    if (parsed?.name !== 'swap') return null;
    const execution = parsed.args.execution ?? parsed.args[0];
    const desc = execution.desc;
    const expectedAmount = BigInt(amountIn);
    const addressEq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    if (!addressEq(execution.callTarget, PINNED_KYBER_CALL_TARGET)
      || !addressEq(execution.approveTarget, ZeroAddress)
      || !addressEq(desc.srcToken, tokenIn) || !addressEq(desc.dstToken, tokenOut)
      || !addressEq(desc.dstReceiver, destination)
      || BigInt(desc.amount) !== expectedAmount
      || BigInt(desc.minReturnAmount) <= 0n
      || BigInt(desc.flags) !== 512n
      || String(desc.permit).toLowerCase() !== '0x'
      || !Array.isArray(desc.srcReceivers) || desc.srcReceivers.length !== 1
      || !addressEq(desc.srcReceivers[0], execution.callTarget)
      || !Array.isArray(desc.srcAmounts) || desc.srcAmounts.length !== 1
      || BigInt(desc.srcAmounts[0]) !== expectedAmount
      || !Array.isArray(desc.feeReceivers) || desc.feeReceivers.length !== 0
      || !Array.isArray(desc.feeAmounts) || desc.feeAmounts.length !== 0) return null;
    return { execution, desc };
  } catch {
    return null;
  }
}

export function compareOfficialAndBaselineCost({ baseline, projectedValueRaw1,
  historicalClaimValueRaw1, baselineGasCostRaw1, officialGasCostRaw1 }) {
  const baselineNetRaw1 = BigInt(baseline.projectedValueRaw1) - BigInt(baselineGasCostRaw1);
  const officialNetRaw1 = BigInt(projectedValueRaw1) - BigInt(historicalClaimValueRaw1)
    - BigInt(officialGasCostRaw1);
  const improvementRaw1 = officialNetRaw1 - baselineNetRaw1;
  const inputRaw1 = BigInt(baseline.inputValueRaw1);
  const oneBps = (inputRaw1 + 9_999n) / 10_000n;
  return {
    baselineNetRaw1,
    officialNetRaw1,
    improvementRaw1,
    requiredImprovementRaw1: oneBps > 1n ? oneBps : 1n
  };
}

function eligible(executor, plan, preBalances, baseline) {
  if (!plan?.pool || !plan?.position || executor.config?.officialRepositionEnabled !== true) return false;
  if (executor.config?.chainId !== 4663) return false;
  const stableAddress = String(executor.config.usdgAddress || USDG).toLowerCase();
  if (stableAddress !== USDG.toLowerCase()
    || String(plan.pool.token1?.address || '').toLowerCase() !== stableAddress) return false;
  if (String(plan.pool.token1?.address || '').toLowerCase() !== USDG.toLowerCase()) return false;
  if (String(plan.pool.key?.currency1 || '').toLowerCase() !== String(plan.pool.token1.address).toLowerCase()
    || String(plan.pool.key?.currency0 || '').toLowerCase() !== String(plan.pool.token0?.address || '').toLowerCase()) return false;
  if (String(plan.pool.token0.address).toLowerCase() === ZERO_ADDRESS.toLowerCase()
    || String(plan.pool.token1.address).toLowerCase() === ZERO_ADDRESS.toLowerCase()) return false;
  if (plan.allocationFundingScope || executor.isAllocationModeEnabled?.() === true) return false;
  if (!preBalances || preBalances.raw0 == null || preBalances.raw1 == null) return false;
  if (baseline?.status !== 'full-sequence-simulated' || baseline.projectedValueRaw1 == null
    || baseline.inputValueRaw1 == null || baseline.simulatedGasUsed == null
    || baseline.valuationSqrtPriceX96 == null || !baseline.finalTarget) return false;
  if (!executor.config.eip7702GuardAddress || !executor.config.officialEip7702GuardAddress
    || String(executor.config.eip7702GuardAddress).toLowerCase()
      !== String(executor.config.officialEip7702GuardAddress).toLowerCase()) return false;
  return true;
}

async function assertPinnedRouter(pool) {
  const code = await this.readProvider.getCode(PINNED_ZAP);
  if (!code || code === '0x' || keccak256(code).toLowerCase() !== OFFICIAL_FABLES_ZAP_CODE_HASH.toLowerCase()) {
    throw new Error('router-codehash-mismatch');
  }
  const official = new Contract(PINNED_ZAP, FABLES_ZAP_ABI, this.readProvider);
  const [[feeBps, recipient], isHook] = await Promise.all([
    official.fees(), official.isFablesHook(pool.key.hooks)
  ]);
  if (BigInt(feeBps) > 5n || getAddress(recipient) === ZeroAddress) throw new Error('router-fee-cap-invalid');
  if (isHook !== true) throw new Error('router-hook-not-supported');
}

async function simulateClaimAmounts(pool, wallet, claimSet, before) {
  const hook = pool.key.hooks;
  const rangeCalls = claimSet.claimRanges.map(item => ({
    to: hook,
    data: hookClaims.encodeFunctionData('claimFees', [pool.key, Number(item.tickLower),
      Number(item.tickUpper), wallet, Number(this.config.fablesWalk)]),
    value: 0n,
    gasLimit: 1_400_000
  }));
  if (!Number.isInteger(Number(this.config.fablesWalk)) || Number(this.config.fablesWalk) <= 0
    || Number(this.config.fablesWalk) > 65_535) throw new Error('claim-walk-invalid');
  const oldRangeCount = 1;
  const balanceCalls = pairBalanceCalls(pool, wallet, 100_000);
  const calls = [rangeCalls[0], ...balanceCalls, ...rangeCalls.slice(oldRangeCount), ...balanceCalls];
  if (calls.length > OFFICIAL_MAX_SIMULATION_CALLS) throw new Error('claim-probe-call-bound-exceeded');
  const results = await simulateSequentialCalls(this.writeProvider, {
    walletAddress: wallet, chainId: this.config.chainId, calls
  });
  const oldAfter = decodeBalancePair(results, 1);
  const totalAfter = decodeBalancePair(results, results.length - 2);
  if (oldAfter.raw0 < BigInt(before.raw0) || oldAfter.raw1 < BigInt(before.raw1)
    || totalAfter.raw0 < oldAfter.raw0 || totalAfter.raw1 < oldAfter.raw1) {
    throw new Error('claim-probe-negative-delta');
  }
  return {
    oldClaimRaw: { raw0: oldAfter.raw0 - BigInt(before.raw0), raw1: oldAfter.raw1 - BigInt(before.raw1) },
    historicalClaimRaw: { raw0: totalAfter.raw0 - oldAfter.raw0, raw1: totalAfter.raw1 - oldAfter.raw1 },
    claimedRaw: { raw0: totalAfter.raw0 - BigInt(before.raw0), raw1: totalAfter.raw1 - BigInt(before.raw1) }
  };
}

export async function buildOfficialRouterData(pool, args, routing, deadline) {
  const innerData = router.encodeFunctionData('reposition', [args, routing]);
  return wrapPermit2IfNeeded.call(this, pool, args.add0, args.add1, deadline, innerData);
}

async function buildScoredCandidate({ plan, pool, wallet, target, claimSet, liveBalances,
  fundingScope, routerArgs, route, routeFit, deadline, baseline, claimProbe, expectedRangeId }) {
  const slippageBps = Number(this.config.depositSlippageBps ?? 50);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) return null;
  const initialArgs = { ...routerArgs, minLiquidity: 1n };
  const initialRouterData = await buildOfficialRouterData.call(this, pool, initialArgs,
    route.routing, deadline);
  const initialSimulation = await simulateGuardCandidate.call(this, {
    plan, pool, wallet, target, claimSet, liveBalances, fundingScope,
    routerArgs: initialArgs, routerData: initialRouterData
  });
  const simulatedLiquidity = BigInt(initialSimulation.expected.liquidity);
  const minLiquidity = simulatedLiquidity * BigInt(10_000 - slippageBps) / 10_000n;
  if (minLiquidity <= 0n) return null;
  const finalArgs = { ...routerArgs, minLiquidity };
  const finalRouterData = await buildOfficialRouterData.call(this, pool, finalArgs,
    route.routing, deadline);
  const finalSimulation = await simulateGuardCandidate.call(this, {
    plan, pool, wallet, target, claimSet, liveBalances, fundingScope,
    routerArgs: finalArgs, routerData: finalRouterData
  });
  if (BigInt(finalSimulation.expected.liquidity) < minLiquidity) return null;

  const valuationSqrt = BigInt(baseline.valuationSqrtPriceX96);
  const lpAmounts = getAmountsForLiquidity(finalSimulation.afterSqrtPriceX96,
    getSqrtPriceAtTick(target.tickLower), getSqrtPriceAtTick(target.tickUpper),
    BigInt(finalSimulation.expected.liquidity), false);
  const projectedValueRaw1 = pairValueAtSqrt(
    lpAmounts.amount0 + finalSimulation.balances.raw0,
    lpAmounts.amount1 + finalSimulation.balances.raw1,
    valuationSqrt
  );
  const cost = await calculateCostComparison.call(this, {
    baseline, projectedValueRaw1,
    claimedRaw: { raw0: BigInt(finalSimulation.expected.claim0), raw1: BigInt(finalSimulation.expected.claim1) },
    claimProbe, plan, pool, valuationSqrtPriceX96: valuationSqrt,
    baselineGasUsed: BigInt(baseline.simulatedGasUsed),
    officialGasUsed: BigInt(finalSimulation.gasUsed)
  });
  if (!cost) return null;
  try {
    this.ledger?.append('rebalance.official_compared', {
      poolId: String(pool.id).toLowerCase(), route: route.name,
      baselineNetRaw1: cost.baselineNetRaw1.toString(),
      officialNetRaw1: cost.officialNetRaw1.toString(),
      improvementRaw1: cost.improvementRaw1.toString(),
      requiredImprovementRaw1: cost.requiredImprovementRaw1.toString(),
      gasUsed: BigInt(finalSimulation.gasUsed).toString(),
      claimRangeCount: claimSet.claimRanges.length
    });
  } catch {}
  if (cost.improvementRaw1 < cost.requiredImprovementRaw1) return null;
  return { route, routeFit, finalSimulation, finalRouterData, minLiquidity,
    projectedValueRaw1, cost, expectedRangeId };
}

function pairBalanceCalls(pool, wallet, gasLimit) {
  return [pool.token0, pool.token1].map(token => ({
    to: token.address,
    data: erc20.encodeFunctionData('balanceOf', [wallet]),
    value: 0n,
    gasLimit
  }));
}

function decodeBalancePair(results, firstIndex) {
  const raw0 = erc20.decodeFunctionResult('balanceOf', results[firstIndex].returnData)[0];
  const raw1 = erc20.decodeFunctionResult('balanceOf', results[firstIndex + 1].returnData)[0];
  return { raw0: BigInt(raw0), raw1: BigInt(raw1) };
}

function baseRepositionArgs(plan, pool, target, wallet, deadline, add0, add1) {
  return {
    key: pool.key,
    oldLower: Number(plan.position.tickLower),
    oldUpper: Number(plan.position.tickUpper),
    shares: BigInt(plan.position.shares),
    newLower: target.tickLower,
    newUpper: target.tickUpper,
    minLiquidity: 1n,
    deadline,
    recipient: wallet,
    add0,
    add1
  };
}

async function wrapPermit2IfNeeded(pool, add0, add1, deadline, innerData) {
  const permitted = [];
  if (BigInt(add0) > 0n) permitted.push({ token: getAddress(pool.token0.address), amount: BigInt(add0) });
  if (BigInt(add1) > 0n) permitted.push({ token: getAddress(pool.token1.address), amount: BigInt(add1) });
  if (!permitted.length) return innerData;
  if (!this.signer || String(this.signer.address).toLowerCase() !== String(this.config.walletAddress).toLowerCase()) {
    throw new Error('permit2-signer-wallet-mismatch');
  }
  const permit = {
    permitted,
    nonce: BigInt(hexlify(randomBytes(32))),
    deadline: BigInt(deadline)
  };
  const domain = { name: 'Permit2', chainId: this.config.chainId, verifyingContract: PINNED_PERMIT2 };
  const message = { permitted: permit.permitted, spender: PINNED_ZAP,
    nonce: permit.nonce, deadline: permit.deadline };
  const signature = await this.signer.signTypedData(domain, PERMIT2_TYPES, message);
  return router.encodeFunctionData('withPermit2', [permit, signature, innerData]);
}

async function fitKyberRoute({ pool, plan, target, routerArgs, deadline,
  feeBps, sqrtPriceX96, valuationSqrtPriceX96, maxImpact }) {
  const imbalance = calcInventoryImbalance(plan, target, routerArgs, sqrtPriceX96);
  if (imbalance.direction == null || imbalance.initialInput <= 0n) return null;
  const tokenInIndex = imbalance.direction;
  let amount = imbalance.initialInput * 10_000n / BigInt(10_000 + feeBps);
  const tokenIn = tokenInIndex === 0 ? pool.token0.address : pool.token1.address;
  const tokenOut = tokenInIndex === 0 ? pool.token1.address : pool.token0.address;
  let last = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const route = await buildKyberRoute.call(this, { tokenIn, tokenOut, amountIn: amount,
      deadline: Number(deadline) });
    const validated = validateKyberCallData({ data: route.data, amountIn: amount,
      tokenIn, tokenOut, destination: PINNED_ZAP });
    if (!validated) throw new Error('kyber-route-calldata-invalid');
    const impact = quotePriceImpactBps(amount, route.quotedOut, tokenInIndex, valuationSqrtPriceX96);
    if (impact > BigInt(maxImpact)) throw new Error('kyber-price-impact-over-limit');
    const leg = {
      route: [], target: PINNED_KYBER_TARGET,
      zeroForOne: tokenInIndex === 0,
      amountIn: amount, shareBps: 0, data: route.data
    };
    const routing = { legs: [leg], maxFeeBps: feeBps };
    last = { routing,
      amountIn: amount, quotedOut: route.quotedOut, minOut: BigInt(validated.desc.minReturnAmount),
      priceImpactBps: impact, quoteBlockNumber: route.quoteBlockNumber };
    const next = requiredSwapInput(imbalance, amount, route.quotedOut, feeBps);
    if (next <= 0n) throw new Error('kyber-fit-nonpositive');
    if (abs(next - amount) <= maxBigInt(2n, amount / 10_000n)) return last;
    amount = next;
  }
  return last;
}

function calcInventoryImbalance(plan, target, p, sqrtPriceX96) {
  const old = getAmountsForLiquidity(sqrtPriceX96,
    getSqrtPriceAtTick(Number(plan.position.tickLower)),
    getSqrtPriceAtTick(Number(plan.position.tickUpper)), BigInt(plan.position.shares), false);
  const base0 = old.amount0 + BigInt(p.add0);
  const base1 = old.amount1 + BigInt(p.add1);
  const weights = getAmountsForLiquidity(sqrtPriceX96,
    getSqrtPriceAtTick(target.tickLower), getSqrtPriceAtTick(target.tickUpper), 10n ** 18n, false);
  if (weights.amount0 <= 0n || weights.amount1 <= 0n) throw new Error('target-composition-invalid');
  const difference = base0 * weights.amount1 - base1 * weights.amount0;
  if (difference === 0n) return { base0, base1, weight0: weights.amount0,
    weight1: weights.amount1, direction: null, initialInput: 0n };
  const sqrt = BigInt(sqrtPriceX96);
  const sqrtSquared = sqrt * sqrt;
  const direction = difference > 0n ? 0 : 1;
  const initialInput = direction === 0
    ? difference * Q192 / (weights.amount1 * Q192 + weights.amount0 * sqrtSquared)
    : -difference * sqrtSquared / (weights.amount0 * sqrtSquared + weights.amount1 * Q192);
  return { base0, base1, weight0: weights.amount0, weight1: weights.amount1,
    direction, initialInput };
}

function requiredSwapInput(imbalance, amountIn, amountOut, feeBps) {
  const out = BigInt(amountOut);
  amountIn = BigInt(amountIn);
  if (imbalance.direction === 0) {
    const numerator = imbalance.base0 * imbalance.weight1 - imbalance.base1 * imbalance.weight0;
    if (numerator <= 0n) return 0n;
    const denominator = imbalance.weight1 * amountIn * BigInt(10_000 + feeBps)
      + imbalance.weight0 * out * 10_000n;
    if (denominator <= 0n) return 0n;
    return numerator * amountIn * 10_000n / denominator;
  }
  const numerator = imbalance.base1 * imbalance.weight0 - imbalance.base0 * imbalance.weight1;
  if (numerator <= 0n) return 0n;
  const denominator = imbalance.weight0 * amountIn * BigInt(10_000 + feeBps)
    + imbalance.weight1 * out * 10_000n;
  if (denominator <= 0n) return 0n;
  return numerator * amountIn * 10_000n / denominator;
}

export async function buildKyberRoute({ tokenIn, tokenOut, amountIn, deadline }) {
  const params = new URLSearchParams({ tokenIn, tokenOut, amountIn: amountIn.toString(),
    excludedSources: 'uniswap-v4-fables' });
  const headers = { 'x-client-id': 'auto-lp-bot', 'content-type': 'application/json' };
  let body = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${KYBER_ORIGIN}/routes?${params}`, {
      headers, signal: AbortSignal.timeout(8_000)
    });
    body = await response.json().catch(() => null);
    if (response.ok && ![429, 503].includes(response.status) && body?.code !== 50301) break;
    if (attempt === 1) throw new Error('kyber-quote-unavailable');
  }
  const routeSummary = body?.data?.routeSummary;
  if (!routeSummary) throw new Error('kyber-route-not-found');
  const response = await fetch(`${KYBER_ORIGIN}/route/build`, {
    method: 'POST', headers,
    body: JSON.stringify({ routeSummary, sender: PINNED_ZAP, recipient: PINNED_ZAP,
      slippageTolerance: Number(this.config.swapSlippageBps ?? 50),
      deadline: Number(deadline), skipSimulateTx: true }),
    signal: AbortSignal.timeout(12_000)
  });
  const built = response.ok ? await response.json().catch(() => null) : null;
  const data = built?.data;
  if (String(data?.routerAddress || '').toLowerCase() !== PINNED_KYBER_TARGET.toLowerCase()
    || typeof data?.data !== 'string' || data.data.slice(0, 10).toLowerCase() !== KYBER_SWAP_SELECTOR) {
    throw new Error('kyber-route-build-invalid');
  }
  const decoded = validateKyberCallData({ data: data.data, amountIn, tokenIn,
    tokenOut, destination: PINNED_ZAP });
  const quotedOut = BigInt(data.amountOut ?? routeSummary.amountOut ?? 0);
  const slippageBps = Number(this.config.swapSlippageBps ?? 50);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error('kyber-slippage-invalid');
  }
  const minimumAllowedOut = quotedOut * BigInt(10_000 - slippageBps) / 10_000n;
  if (!decoded || quotedOut <= 0n || BigInt(decoded.desc.minReturnAmount) < minimumAllowedOut
    || BigInt(decoded.desc.minReturnAmount) > quotedOut) {
    throw new Error('kyber-route-output-invalid');
  }
  return { data: data.data, quotedOut, quoteBlockNumber: routeSummary.blockNumber ?? null };
}

async function simulateGuardCandidate({ plan, pool, wallet, target, claimSet,
  liveBalances, fundingScope, routerArgs, routerData }) {
  const guardPlan = {
    expectedBalance0: BigInt(liveBalances.raw0),
    expectedBalance1: BigInt(liveBalances.raw1),
    funding0: fundingScope.funding.raw0,
    funding1: fundingScope.funding.raw1,
    claimLower: claimSet.claimRanges.map(item => Number(item.tickLower)),
    claimUpper: claimSet.claimRanges.map(item => Number(item.tickUpper)),
    walk: Number(this.config.fablesWalk),
    maxResidualBps: 50,
    routerData
  };
  const newId = rangeId(pool.id, target.tickLower, target.tickUpper);
  const oldId = BigInt(plan.position.id);
  const hookShareCall = (idValue) => ({ to: pool.key.hooks,
    data: hookApproval.encodeFunctionData('balanceOf', [wallet, idValue]), value: 0n, gasLimit: 100_000 });
  const calls = [
    { to: wallet, data: guard.encodeFunctionData('guardedRepositionAndClaim', [guardPlan]),
      value: 0n, gasLimit: OFFICIAL_GUARD_GAS_LIMIT },
    ...pairBalanceCalls(pool, wallet, 100_000),
    hookShareCall(oldId), hookShareCall(newId),
    { to: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
      data: stateView.encodeFunctionData('getSlot0', [pool.id]), value: 0n, gasLimit: 100_000 }
  ];
  const results = await simulateSequentialCalls(this.writeProvider, {
    walletAddress: wallet, chainId: this.config.chainId, calls
  });
  const eventMatches = [];
  for (const item of results[0].logs || []) {
    if (String(item.address).toLowerCase() !== wallet.toLowerCase()) continue;
    try {
      const parsed = guard.parseLog(item);
      if (parsed?.name === 'OfficialRepositioned'
        && String(parsed.args.poolId).toLowerCase() === String(pool.id).toLowerCase()) {
        eventMatches.push(parsed.args);
      }
    } catch {}
  }
  if (eventMatches.length !== 1) throw new Error('guard-event-missing-or-ambiguous');
  const event = eventMatches[0];
  const newSharesBefore = BigInt(await new Contract(pool.key.hooks, HOOK_ABI, this.readProvider)
    .balanceOf(wallet, newId));
  const newSharesAfter = BigInt(hookApproval.decodeFunctionResult('balanceOf', results[4].returnData)[0]);
  const oldSharesAfter = BigInt(hookApproval.decodeFunctionResult('balanceOf', results[3].returnData)[0]);
  const balances = decodeBalancePair(results, 1);
  const [afterSqrt, afterTick] = stateView.decodeFunctionResult('getSlot0', results[5].returnData);
  if (BigInt(event.oldRangeId) !== oldId || BigInt(event.newRangeId) !== newId
    || BigInt(event.liquidity) <= 0n || oldSharesAfter !== 0n
    || newSharesAfter !== newSharesBefore + BigInt(event.liquidity)
    || balances.raw0 < BigInt(liveBalances.raw0) - fundingScope.funding.raw0
    || balances.raw1 < BigInt(liveBalances.raw1) - fundingScope.funding.raw1
    || Number(afterTick) < target.tickLower || Number(afterTick) >= target.tickUpper) {
    throw new Error('guard-simulation-readback-mismatch');
  }
  return {
    expected: {
      liquidity: BigInt(event.liquidity).toString(),
      rangeId: newId.toString(),
      claim0: BigInt(event.claimed0).toString(), claim1: BigInt(event.claimed1).toString(),
      residual0: BigInt(event.residual0).toString(), residual1: BigInt(event.residual1).toString()
    },
    balances,
    gasUsed: BigInt(results[0].gasUsed || 0),
    afterSqrtPriceX96: BigInt(afterSqrt)
  };
}

export async function calculateCostComparison({ baseline, projectedValueRaw1, claimedRaw,
  claimProbe, plan, pool, target, valuationSqrtPriceX96, baselineGasUsed, officialGasUsed }) {
  const baselineWithdrawn = baseline.withdrawnRaw;
  if (baselineWithdrawn?.raw0 == null || baselineWithdrawn.raw1 == null) return null;
  const baselineOldFee0 = BigInt(claimProbe.oldClaimRaw.raw0);
  const baselineOldFee1 = BigInt(claimProbe.oldClaimRaw.raw1);
  const probeHistoryValue = pairValueAtSqrt(claimProbe.historicalClaimRaw.raw0,
    claimProbe.historicalClaimRaw.raw1, valuationSqrtPriceX96);
  const finalBeyondBaselineOld = pairValueAtSqrt(
    maxBigInt(0n, claimedRaw.raw0 - baselineOldFee0),
    maxBigInt(0n, claimedRaw.raw1 - baselineOldFee1), valuationSqrtPriceX96);
  const historicalClaimValueRaw1 = probeHistoryValue > finalBeyondBaselineOld
    ? probeHistoryValue : finalBeyondBaselineOld;
  const [feeOverrides, ethPrice, stablePrice] = await Promise.all([
    this.getPinnedFeeOverrides(), this.getUsdPrice(ZERO_ADDRESS),
    this.getUsdPrice(pool.token1.address)
  ]);
  const maxFee = BigInt(feeOverrides.maxFeePerGas || feeOverrides.gasPrice || 0);
  if (maxFee <= 0n) return null;
  const ethUsd = Number(ethPrice), stableUsd = Number(stablePrice);
  if (!(ethUsd > 0) || !(stableUsd > 0)) return null;
  const baselineGasCostRaw1 = usdGasCostRaw(ethUsd, stableUsd, baselineGasUsed * maxFee,
    pool.token1.decimals);
  const officialGasCostRaw1 = usdGasCostRaw(ethUsd, stableUsd, officialGasUsed * maxFee,
    pool.token1.decimals);
  const compared = compareOfficialAndBaselineCost({ baseline,
    projectedValueRaw1, historicalClaimValueRaw1,
    baselineGasCostRaw1, officialGasCostRaw1 });
  return { ...compared, historicalClaimValueRaw1, baselineGasCostRaw1, officialGasCostRaw1 };
}

function normalizeTarget(target, spacing, currentTick) {
  const tickLower = Number(target?.tickLower);
  const tickUpper = Number(target?.tickUpper);
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper)
    || !Number.isInteger(Number(spacing)) || Number(spacing) <= 0
    || tickLower >= tickUpper || tickLower % Number(spacing) !== 0
    || tickUpper % Number(spacing) !== 0 || currentTick < tickLower || currentTick >= tickUpper) return null;
  return { tickLower, tickUpper };
}

function samePoolKey(left, right) {
  return String(left?.currency0).toLowerCase() === String(right.currency0).toLowerCase()
    && String(left?.currency1).toLowerCase() === String(right.currency1).toLowerCase()
    && Number(left?.fee) === Number(right.fee)
    && Number(left?.tickSpacing) === Number(right.tickSpacing)
    && String(left?.hooks).toLowerCase() === String(right.hooks).toLowerCase();
}

function rangeId(poolId, lower, upper) {
  return BigInt(keccak256(coder.encode(['bytes32', 'int24', 'int24'], [poolId, lower, upper])));
}

function pairValueAtSqrt(raw0, raw1, sqrtPriceX96) {
  const sqrt = BigInt(sqrtPriceX96);
  return BigInt(raw0) * sqrt * sqrt / Q192 + BigInt(raw1);
}

function usdGasCostRaw(ethUsd, stableUsd, gasCostWei, stableDecimals) {
  const eth = decimalFraction(ethUsd);
  const stable = decimalFraction(stableUsd);
  if (stableDecimals < 0 || stableDecimals > 36) throw new Error('stable-decimals-invalid');
  const numerator = BigInt(gasCostWei) * eth.numerator * stable.denominator * 10n ** BigInt(stableDecimals);
  const denominator = 10n ** 18n * eth.denominator * stable.numerator;
  if (denominator <= 0n) throw new Error('gas-price-value-unavailable');
  return divRoundUp(numerator, denominator);
}

function decimalFraction(value) {
  const text = String(value).trim().toLowerCase();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/.test(text)) throw new Error('invalid-decimal-price');
  const [coefficient, exponentText] = text.split('e');
  const exponent = Number(exponentText || 0);
  const negative = coefficient.startsWith('-');
  const unsigned = coefficient.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  let numerator = BigInt(`${whole || '0'}${fraction}` || '0');
  let denominator = 10n ** BigInt(fraction.length);
  if (exponent > 0) numerator *= 10n ** BigInt(exponent);
  else if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
  return { numerator: negative ? -numerator : numerator, denominator };
}

function parseRangeId(value) {
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch { return null; }
}

function toBytes32(value) {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

function divRoundUp(numerator, denominator) {
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

function maxBigInt(a, b) { return BigInt(a) > BigInt(b) ? BigInt(a) : BigInt(b); }
function abs(value) { return value < 0n ? -value : value; }

function sanitizeFailureReason(error) {
  const message = String(error?.message || 'preflight-failed').toLowerCase();
  const safeCodes = [
    'router-codehash', 'router-fee', 'router-hook', 'owner-', 'lens-', 'old-range',
    'claim-', 'official-claim-', 'native-probe', 'kyber-', 'guard-', 'permit2-', 'target-',
    'stable-', 'baseline-'
  ];
  const code = safeCodes.find(prefix => message.includes(prefix));
  return code ? `official-preview-${code.replace(/-$/, '')}-failed` : 'official-preview-simulation-failed';
}

// Only retain the custom-error selector, never a provider request or signature.
function safeRevertSelector(error) {
  const failed = error?.simulationResults?.find(row => row?.status !== '0x1');
  for (const value of [failed?.returnData, failed?.error?.data]) {
    const data = String(value || '');
    if (/^0x[0-9a-f]{8}/i.test(data)) return data.slice(0, 10).toLowerCase();
  }
  return null;
}

export function officialRepositionDeadline(configuredDeadline, blockTimestamp, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(Number(blockTimestamp)) || Number(blockTimestamp) <= 0) {
    throw new Error('guard-comparison-block-time-invalid');
  }
  // TX_DEADLINE_SEC may be 1200. Anchoring that to wall time would exceed
  // the guard's 1200-second cap when simulating an earlier pinned block.
  const deadline = Math.min(Number(configuredDeadline), Number(blockTimestamp) + 600);
  if (!Number.isSafeInteger(deadline) || deadline <= nowSeconds + 60) {
    throw new Error('guard-comparison-deadline-stale');
  }
  return BigInt(deadline);
}
