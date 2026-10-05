import { Interface } from 'ethers';
import { EIP7702_GUARD_ABI } from '../abi.js';
import { UNISWAP_UNIVERSAL_ROUTER_212 } from '../constants.js';
import { assertUint128, getLiquidityForAmounts, getSqrtPriceAtTick } from '../math/v4-fixed.js';
import { buildTargetRange } from '../math/ticks.js';
import { sanitize } from '../logger.js';

const guard = new Interface(EIP7702_GUARD_ABI);
const rawStrings = b => ({ raw0: String(b.raw0), raw1: String(b.raw1) });
const RESIDUAL_BPS = 50; // at least 99.5% of each authorized post-swap token
const errorSummary = error => {
  const data = error.data || error.info?.error?.data;
  const selector = error.revertSelector || (typeof data === 'string' ? data.slice(0, 10) : null);
  let decoded;
  try { decoded = typeof data === 'string' ? guard.parseError(data)?.name : null; } catch {}
  return { error: sanitize(decoded === 'LiquidityBelowMinimum'
    ? '價格變動使可存入流動性低於最低限制；尚未送出存入交易。'
    : decoded || error.shortMessage || error.message).slice(0, 360), errorSelector: selector,
    guardError: decoded || null };
};

export function buildAtomicDepositRequest({ pool, walletAddress, target, balances, funding,
  swapPlan, routerRequest, minLiquidity, deadline }) {
  const swapping = swapPlan?.direction && swapPlan.direction !== 'none';
  if (swapping && (swapPlan.direction === 'not-quoted' || !routerRequest
    || String(routerRequest.router).toLowerCase() !== UNISWAP_UNIVERSAL_ROUTER_212.toLowerCase()
    || BigInt(routerRequest.value || 0) !== 0n)) throw new Error('Unsupported atomic swap route');
  const f0 = assertUint128(funding.raw0), f1 = assertUint128(funding.raw1);
  if (f0 > balances.raw0 || f1 > balances.raw1) throw new Error('Atomic funding exceeds authorized inventory');
  const plan = { key: pool.key, tickLower: target.tickLower, tickUpper: target.tickUpper,
    expectedBalance0: balances.raw0, expectedBalance1: balances.raw1,
    funding0: f0, funding1: f1, tokenIn: swapping ? swapPlan.tokenIn : 2,
    swapPoolId: swapping && routerRequest.protocol !== 'v3' ? (swapPlan.swapPool || pool).id : '0x' + '0'.repeat(64),
    amountIn: swapping ? assertUint128(swapPlan.rawAmountIn) : 0n,
    minOut: swapping ? assertUint128(swapPlan.quote.minRawAmountOut) : 0n,
    minLiquidity: assertUint128(minLiquidity), maxResidualBps: RESIDUAL_BPS,
    deadline, routerData: swapping ? routerRequest.data : '0x' };
  if (plan.minLiquidity <= 0n) throw new Error('Atomic minimum liquidity must be positive');
  return { to: walletAddress, value: 0n,
    data: guard.encodeFunctionData('atomicSwapAndDeposit', [plan]), plan };
}

export function findAtomicDepositEvent(receipt, walletAddress, poolId) {
  const matches = [];
  for (const item of receipt.logs || []) {
    if (String(item.address).toLowerCase() !== walletAddress.toLowerCase()) continue;
    try { const parsed = guard.parseLog(item);
      if (parsed?.name === 'AtomicDeposited'
        && String(parsed.args.poolId).toLowerCase() === poolId.toLowerCase()) matches.push(parsed.args);
    } catch {}
  }
  if (matches.length !== 1) throw new Error('Atomic receipt must contain exactly one matching AtomicDeposited event');
  return matches[0];
}

// Called with the executor as `this`. Never falls back to a separate live swap
// followed by a deposit. Every retry is a new plan after a proven no-op.
export async function executeAtomicDeposit({ pool, target, funding, balances, journal,
  position = null, oldPosition = null, allocationScope = null, maxPriceImpactBps,
  previousApprovalCaps = null, retarget = false, eventType = 'rebalance.completed',
  eventMetadata = {}, onJournal = () => {} }) {
  let capitalHash = null;
  let confirmed = false;
  let stage = 'validation';
  const approvalCaps = { raw0: BigInt(funding.raw0), raw1: BigInt(funding.raw1) };
  const reusableApprovalCaps = previousApprovalCaps === null ? null : {
    raw0: assertUint128(previousApprovalCaps.raw0),
    raw1: assertUint128(previousApprovalCaps.raw1)
  };
  const approvedInputs = new Set();
  const planningStartedAt = Date.now();
  let excludedApprovalMs = 0;
  let approvalPauseStartedAt = null;
  const planningElapsedMs = () => {
    const now = Date.now();
    return now - planningStartedAt - excludedApprovalMs
      - (approvalPauseStartedAt === null ? 0 : now - approvalPauseStartedAt);
  };
  const pausePlanningForApproval = () => {
    if (approvalPauseStartedAt !== null) throw new Error('Atomic approval wait is already active');
    approvalPauseStartedAt = Date.now();
  };
  const resumePlanningAfterApproval = () => {
    if (approvalPauseStartedAt === null) return;
    excludedApprovalMs += Date.now() - approvalPauseStartedAt;
    approvalPauseStartedAt = null;
  };
  const assertActive = () => {
    if (this.state?.getSetting('executionPaused', false)) throw new Error('Execution is paused');
    if (planningElapsedMs() > 300_000) throw new Error('Atomic planning exceeded five minutes; stopped without another approval');
    if (allocationScope) this.assertAllocationJobCurrent(pool, allocationScope);
  };
  const fitBeforeDeadline = async (prepareFit, options) => {
    assertActive();
    let timer;
    try {
      // Planning contexts cannot sign. If the RPC stalls, detach this read-only
      // fit and lock recovery rather than waiting indefinitely before a send.
      return await Promise.race([prepareFit.call(this, options), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Atomic planning exceeded five minutes; stopped without another approval')),
          Math.max(1, 300_000 - planningElapsedMs()));
      })]);
    } finally { clearTimeout(timer); }
  };
  const update = patch => {
    // Allowance sends persist pendingTx/lastApprovalTx directly. Always patch
    // the latest copy so an atomic-stage update cannot erase that evidence.
    const active = this.state?.getSetting('activeRebalanceExecution', null);
    const base = active?.id === journal.id ? active : journal;
    journal = this.patchJournal(base, patch);
    onJournal(journal);
  };
  try {
    for (const key of ['raw0', 'raw1']) {
      assertUint128(approvalCaps[key]);
      if (approvalCaps[key] > balances[key]) throw new Error('Atomic funding exceeds authorized inventory');
    }
    await this.assertAtomicGuardReady();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
      stage = 'validation';
      assertActive();
      if (allocationScope) this.assertAllocationJobCurrent(pool, allocationScope);
      const physical = await this.readRawPairBalances(pool);
      if (physical.raw0 !== balances.raw0 || physical.raw1 !== balances.raw1) {
        throw new Error('Atomic pair balances changed; refusing stale funding scope');
      }
      if (position) await this.validateTopUpPosition(pool, position, 'atomic-deposit');
      const state = await this.fables.readPoolState(pool);
      if (state.paused !== false) throw new Error('Atomic deposit pool is paused');
      if (retarget) target = buildTargetRange(state.tick, pool.key.tickSpacing,
        this.config.tightWidthBps, this.config.rangePreset);
      const stableIndex = pool.token0.address.toLowerCase() === this.config.usdgAddress.toLowerCase() ? 0
        : pool.token1.address.toLowerCase() === this.config.usdgAddress.toLowerCase() ? 1 : null;
      const prepareFit = this.preparePinnedRangeBalancedSwap || this.prepareRangeBalancedSwap;
      stage = 'planning';
      let fitted = await fitBeforeDeadline(prepareFit, { pool, funding, state, target, stableIndex,
        maxPriceImpactBps, expectedOutput: true, swapAllowanceCaps: approvalCaps,
        ...(retarget ? { chooseTarget: tick => buildTargetRange(tick,
          pool.key.tickSpacing, this.config.tightWidthBps, this.config.rangePreset) } : {}) });
      const swapPlan = fitted.swapPlan;
      assertActive();
      if (swapPlan.direction !== 'none' && !approvedInputs.has(swapPlan.tokenIn)) {
        stage = 'approval';
        const input = swapPlan.tokenIn === 0 ? pool.token0 : pool.token1;
        pausePlanningForApproval();
        let approvalResult;
        try {
          approvalResult = await this.ensureSwapAllowances(input, swapPlan.rawAmountIn, {
            allowanceCap: swapPlan.tokenIn === 0 ? approvalCaps.raw0 : approvalCaps.raw1,
            reuseAllowanceCap: reusableApprovalCaps?.[`raw${swapPlan.tokenIn}`] ?? null,
            beforeBroadcast: assertActive
          });
        } finally {
          resumePlanningAfterApproval();
        }
        approvedInputs.add(swapPlan.tokenIn);
        stage = 'planning';
        // A reused pre-withdrawal cap makes no chain change, so keep the fit.
        // A real approval broadcast can span blocks; only then refit from a
        // fresh pool state before constructing the atomic call.
        if (approvalResult?.broadcasted !== false) {
          const fresh = await this.fables.readPoolState(pool);
          fitted = await fitBeforeDeadline(prepareFit, { pool, funding, state: fresh,
            target: fitted.target, stableIndex, maxPriceImpactBps, expectedOutput: true,
            swapAllowanceCaps: approvalCaps,
            ...(retarget ? { chooseTarget: tick => buildTargetRange(tick,
              pool.key.tickSpacing, this.config.tightWidthBps, this.config.rangePreset) } : {}) });
          if (fitted.swapPlan.direction !== 'none' && !approvedInputs.has(fitted.swapPlan.tokenIn)) {
            // A changed input token needs its own bounded approval and a new
            // plan after that approval, never a late approval on a fitted plan.
            update({ phase: 'atomic_retry', atomicAttempt: attempt + 1, atomicRetryReason: 'swap-input-changed' });
            if (attempt === 2) throw new Error('Atomic swap input kept changing');
            continue;
          }
        }
      }
      target = fitted.target;
      const executable = fitted.swapPlan;
      assertActive();
      const deadline = this.deadline();
      const routerRequest = executable.direction === 'none' ? null : this.router.buildV4ExactInputSingle({
        pool: executable.swapPool || pool, quote: executable.quote, deadline });
      const projected = { ...funding };
      if (executable.direction !== 'none') {
        const amountOut = BigInt(executable.quote.minRawAmountOut);
        if (executable.tokenIn === 0) { projected.raw0 -= executable.rawAmountIn; projected.raw1 += amountOut; }
        else { projected.raw1 -= executable.rawAmountIn; projected.raw0 += amountOut; }
      }
      // Use the selected fit's simulated post-swap price and the router's
      // guaranteed minOut inventory. The pool spot may move before broadcast;
      // the full atomic preflight below must still pass this fixed threshold.
      const liquidity = getLiquidityForAmounts(fitted.postState.sqrtPriceX96,
        getSqrtPriceAtTick(target.tickLower), getSqrtPriceAtTick(target.tickUpper), projected.raw0, projected.raw1);
      const minLiquidity = liquidity * BigInt(10_000 - this.config.depositSlippageBps) / 10_000n;
      const request = buildAtomicDepositRequest({ pool, walletAddress: this.config.walletAddress,
        target, balances, funding, swapPlan: executable, routerRequest, minLiquidity, deadline });
      // This simulates the entire atomic call, including the residual bound.
      stage = 'preflight';
      const sharesBefore = position ? await this.readPositionShares(pool, position.id) : 0n;
      const fees = await this.getPinnedFeeOverrides();
      const preflight = this.preflightVerifiedTx
        ? await this.preflightVerifiedTx({ ...request, feeOverrides: fees }) : null;
      if (!preflight) await this.readProvider.call({ from: this.config.walletAddress,
        to: request.to, data: request.data, value: 0n });
      const gas = preflight?.gasEstimate ?? await this.signer.estimateGas({
        from: this.config.walletAddress, to: request.to, data: request.data, value: 0n });
      await this.assertTopUpGasBudget({ reserveWei: this.config.topUpMinGasReserveWei,
        maxFeePerGas: fees.maxFeePerGas || fees.gasPrice,
        futureGasLimit: gas * 150n / 100n + 25_000n, phase: 'before-atomic-swap-deposit' });
      if (allocationScope) this.assertAllocationJobCurrent(pool, allocationScope);
      update({ phase: 'atomic_preflighted', finalTarget: target, atomicAttempt: attempt + 1,
        atomicFundingRaw: rawStrings(funding), atomicBalancesBeforeRaw: rawStrings(balances),
        atomicSwapRequired: executable.direction !== 'none',
        atomicMinLiquidity: String(minLiquidity), atomicResidualBps: RESIDUAL_BPS });
      let receipt;
      try {
        stage = 'broadcast';
        receipt = await this.sendVerifiedTx({ label: 'atomicSwapAndDeposit', to: request.to,
          data: request.data, value: 0n, feeOverrides: fees, preflight, beforeBroadcast: assertActive, onSent: hash => {
            capitalHash = hash;
            update({ phase: 'atomic_sent', tx: { ...journal.tx, atomicSwapDeposit: hash },
              pendingTx: { label: 'atomicSwapAndDeposit', hash, to: request.to,
                previousPhase: 'atomic_preflighted' } });
          } });
      } catch (error) {
        if (error.code !== 'TRANSACTION_REVERTED' || error.receipt?.status !== 0
          || String(error.receipt.hash).toLowerCase() !== capitalHash?.toLowerCase()) throw error;
        const [after, latest, pending] = await Promise.all([this.readRawPairBalances(pool),
          this.writeProvider.getTransactionCount(this.config.walletAddress, 'latest'),
          this.writeProvider.getTransactionCount(this.config.walletAddress, 'pending')]);
        const sharesAfter = position ? await this.readPositionShares(pool, position.id) : 0n;
        if (after.raw0 !== balances.raw0 || after.raw1 !== balances.raw1 || latest !== pending
          || sharesAfter !== sharesBefore) throw error;
        this.ledger.append('rebalance.atomic_revert_replanned', { hash: capitalHash,
          poolId: pool.id, attempt: attempt + 1, blockNumber: error.receipt.blockNumber });
        update({ phase: 'atomic_retry', tx: { ...journal.tx, atomicSwapDeposit: null,
          atomicReverts: [...(journal.tx.atomicReverts || []), capitalHash] }, pendingTx: null });
        capitalHash = null;
        if (attempt === 2) throw error;
        continue;
      }
      confirmed = true;
      stage = 'verify';
      update({ phase: 'atomic_confirmed', pendingTx: null });
      const atomic = findAtomicDepositEvent(receipt, this.config.walletAddress, pool.id);
      const deposit = this.findWalletDepositEvent(pool, receipt);
      if (!deposit || deposit.liquidity !== atomic.liquidity
        || (position && deposit.rangeId.toLowerCase() !== position.id.toLowerCase())) {
        throw new Error('Atomic deposit receipt did not mint the intended liquidity/range');
      }
      const range = await this.fables.readRangeKey(pool, deposit.rangeId);
      const sameKey = ['currency0','currency1','fee','tickSpacing','hooks'].every(key =>
        String(range.key[key]).toLowerCase() === String(pool.key[key]).toLowerCase());
      if (!range.exists || !sameKey || Number(range.tickLower) !== target.tickLower
        || Number(range.tickUpper) !== target.tickUpper) throw new Error('Atomic deposit minted an unexpected PoolKey/range');
      const shares = await this.readPositionShares(pool, deposit.rangeId);
      if (shares <= sharesBefore) throw new Error('Atomic deposit shares did not increase');
      if (oldPosition && oldPosition.id.toLowerCase() !== deposit.rangeId.toLowerCase()
        && await this.readPositionShares(pool, oldPosition.id) !== 0n) throw new Error('Old LP shares reappeared');
      const after = await this.readRawPairBalances(pool);
      const expected0 = balances.raw0 - funding.raw0 + atomic.residual0;
      const expected1 = balances.raw1 - funding.raw1 + atomic.residual1;
      if (after.raw0 !== expected0 || after.raw1 !== expected1) throw new Error('Atomic receipt does not reconcile wallet reserves');
      const delta = this.getAllocationWalletReceiptDeltas(receipt, [pool.token0, pool.token1]);
      if (delta.raw0 !== after.raw0 - balances.raw0 || delta.raw1 !== after.raw1 - balances.raw1) {
        throw new Error('Atomic wallet balances differ from receipt transfers');
      }
      const remaining = allocationScope ? {
        [pool.token0.address.toLowerCase()]: String(atomic.residual0),
        [pool.token1.address.toLowerCase()]: String(atomic.residual1) } : null;
      update({ phase: 'completed', completedAt: Date.now(),
        tx: { ...journal.tx, atomicSwapDeposit: receipt.hash }, balancesAfterRaw: rawStrings(after),
        allocationRemainingRaw: remaining, atomicResidualRaw: { raw0: String(atomic.residual0), raw1: String(atomic.residual1) },
        newPosition: { rangeId: deposit.rangeId, shares: String(shares), liquidity: String(deposit.liquidity),
          tickLower: target.tickLower, tickUpper: target.tickUpper } });
      this.clearJournal();
      const result = { ...eventMetadata, status: 'completed', atomic: true, poolId: pool.id,
        pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
        oldPositionId: oldPosition?.id || position?.id || eventMetadata.oldPositionId || null,
        newPositionId: deposit.rangeId, positionId: deposit.rangeId,
        withdrawHash: journal.tx.withdraw || null, routeSwapHashes: journal.tx.routeSwaps || [],
        balanceSwapHash: executable.direction === 'none' ? null : receipt.hash,
        balanceSwapPoolId: executable.direction === 'none' ? null : (executable.swapPool || pool).id,
        swapHash: executable.direction === 'none' ? null : receipt.hash, depositHash: receipt.hash,
        atomicSwapDepositHash: receipt.hash, sharesBefore: String(sharesBefore), sharesAfter: String(shares),
        liquidityAdded: String(deposit.liquidity), balancesAfterRaw: rawStrings(after),
        dustRetainedRaw: rawStrings({ raw0: balances.raw0 - funding.raw0, raw1: balances.raw1 - funding.raw1 }),
        allocationJobId: journal.allocationJobId || null,
        allocationFundingScope: journal.allocationFundingScope || null,
        allocationPhysicalBaselineRaw: journal.allocationPhysicalBaselineRaw || null,
        allocationRemainingRaw: remaining, target, atomicResidualBps: RESIDUAL_BPS };
      this.ledger.append(eventType, result);
      return result;
      } catch (error) {
        // A semantic preflight revert before broadcasting has moved no capital in
        // this call. Refit a stale market plan without sending a failed swap.
        if (!capitalHash && !confirmed && (['planning', 'preflight'].includes(stage)
          || (stage === 'broadcast' && error.preBroadcastFailure === true))
          && ['CALL_EXCEPTION', 'SEQUENTIAL_SIMULATION_REVERT', 'PREFLIGHT_EXPIRED'].includes(error.code) && attempt < 2) {
          const retryError = errorSummary(error);
          update({ phase: 'atomic_retry', atomicAttempt: attempt + 1, atomicRetryReason: 'preflight-price-changed',
            atomicRetryStage: stage, atomicRetryError: retryError.error,
            atomicRetrySelector: retryError.errorSelector,
            atomicRetryGuardError: retryError.guardError });
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    // Earlier withdrawal/cross-pool conversion still requires recovery even
    // when this atomic call has not broadcast. Never clear moved capital.
    const moved = confirmed || capitalHash || journal.tx?.withdraw || journal.tx?.routeSwaps?.length
      || error.code === 'BROADCAST_OUTCOME_UNCERTAIN';
    const details = errorSummary(error);
    const active = this.state?.getSetting('activeRebalanceExecution', null);
    const pending = active?.id === journal.id ? active.pendingTx : journal.pendingTx;
    const uncertainPending = error.code === 'BROADCAST_OUTCOME_UNCERTAIN' && capitalHash
      ? { pendingTx: { ...(pending || {}), label: 'atomicSwapAndDeposit', hash: capitalHash,
        to: this.config.walletAddress, outcome: 'uncertain' } }
      : {};
    update({ phase: moved ? 'recovery_required' : 'failed', failedAt: Date.now(), ...details,
      errorStage: stage, preBroadcastFailure: error.preBroadcastFailure === true, ...uncertainPending });
    if (moved) this.ledger.append('rebalance.recovery_required', { ...journal, ...details });
    error.atomicHandled = true;
    throw error;
  }
}
