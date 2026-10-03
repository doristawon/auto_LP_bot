import { Interface } from 'ethers';
import { EIP7702_GUARD_ABI } from '../abi.js';
import { UNISWAP_UNIVERSAL_ROUTER_212 } from '../constants.js';
import { assertUint128, getLiquidityForAmounts, getSqrtPriceAtTick } from '../math/v4-fixed.js';
import { buildTargetRange } from '../math/ticks.js';

const guard = new Interface(EIP7702_GUARD_ABI);
const rawStrings = b => ({ raw0: String(b.raw0), raw1: String(b.raw1) });
const RESIDUAL_BPS = 50; // at least 99.5% of each authorized post-swap token

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
  retarget = false, eventType = 'rebalance.completed', eventMetadata = {}, onJournal = () => {} }) {
  let capitalHash = null;
  let confirmed = false;
  const update = patch => { journal = this.patchJournal(journal, patch); onJournal(journal); };
  try {
    await this.assertAtomicGuardReady();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
      if (this.state?.getSetting('executionPaused', false)) throw new Error('Execution is paused');
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
      let fitted = await prepareFit.call(this, { pool, funding, state, target, stableIndex,
        maxPriceImpactBps, expectedOutput: true, ...(retarget ? { chooseTarget: tick => buildTargetRange(tick,
          pool.key.tickSpacing, this.config.tightWidthBps, this.config.rangePreset) } : {}) });
      const swapPlan = fitted.swapPlan;
      if (swapPlan.direction !== 'none') {
        const input = swapPlan.tokenIn === 0 ? pool.token0 : pool.token1;
        await this.ensureSwapAllowances(input, swapPlan.rawAmountIn);
        // Allowance transactions happen before final fitting, never between
        // the committed swap and deposit.
        const fresh = await this.fables.readPoolState(pool);
        fitted = await prepareFit.call(this, { pool, funding, state: fresh,
          target: fitted.target, stableIndex, maxPriceImpactBps, expectedOutput: true,
          ...(retarget ? { chooseTarget: tick => buildTargetRange(tick,
            pool.key.tickSpacing, this.config.tightWidthBps, this.config.rangePreset) } : {}) });
        if (fitted.swapPlan.direction !== 'none') {
          await this.ensureSwapAllowances(fitted.swapPlan.tokenIn === 0 ? pool.token0 : pool.token1,
            fitted.swapPlan.rawAmountIn);
        }
      }
      target = fitted.target;
      const executable = fitted.swapPlan;
      const deadline = this.deadline();
      const routerRequest = executable.direction === 'none' ? null : this.router.buildV4ExactInputSingle({
        pool: executable.swapPool || pool, quote: executable.quote, deadline });
      const projected = { ...funding };
      if (executable.direction !== 'none') {
        const amountOut = BigInt(executable.quote.minRawAmountOut);
        if (executable.tokenIn === 0) { projected.raw0 -= executable.rawAmountIn; projected.raw1 += amountOut; }
        else { projected.raw1 -= executable.rawAmountIn; projected.raw0 += amountOut; }
      }
      const liquidity = getLiquidityForAmounts(fitted.postState.sqrtPriceX96,
        getSqrtPriceAtTick(target.tickLower), getSqrtPriceAtTick(target.tickUpper), projected.raw0, projected.raw1);
      const minLiquidity = liquidity * BigInt(10_000 - this.config.depositSlippageBps) / 10_000n;
      const request = buildAtomicDepositRequest({ pool, walletAddress: this.config.walletAddress,
        target, balances, funding, swapPlan: executable, routerRequest, minLiquidity, deadline });
      // This simulates the entire atomic call, including the residual bound.
      await this.readProvider.call({ from: this.config.walletAddress, to: request.to,
        data: request.data, value: 0n });
      const fees = await this.getPinnedFeeOverrides();
      const gas = await this.signer.estimateGas({ from: this.config.walletAddress,
        to: request.to, data: request.data, value: 0n });
      await this.assertTopUpGasBudget({ reserveWei: this.config.topUpMinGasReserveWei,
        maxFeePerGas: fees.maxFeePerGas || fees.gasPrice,
        futureGasLimit: gas * 150n / 100n + 25_000n, phase: 'before-atomic-swap-deposit' });
      if (allocationScope) this.assertAllocationJobCurrent(pool, allocationScope);
      const sharesBefore = position ? await this.readPositionShares(pool, position.id) : 0n;
      update({ phase: 'atomic_preflighted', finalTarget: target, atomicAttempt: attempt + 1,
        atomicFundingRaw: rawStrings(funding), atomicBalancesBeforeRaw: rawStrings(balances),
        atomicSwapRequired: executable.direction !== 'none',
        atomicMinLiquidity: String(minLiquidity), atomicResidualBps: RESIDUAL_BPS });
      let receipt;
      try {
        receipt = await this.sendVerifiedTx({ label: 'atomicSwapAndDeposit', to: request.to,
          data: request.data, value: 0n, feeOverrides: fees, onSent: hash => {
            capitalHash = hash;
            update({ phase: 'atomic_sent', tx: { ...journal.tx, atomicSwapDeposit: hash } });
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
          atomicReverts: [...(journal.tx.atomicReverts || []), capitalHash] } });
        capitalHash = null;
        if (attempt === 2) throw error;
        continue;
      }
      confirmed = true;
      update({ phase: 'atomic_confirmed' });
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
        // A semantic preflight revert before signing has moved no capital in
        // this call. Refit a stale market plan without sending a failed swap.
        if (!capitalHash && !confirmed && ['CALL_EXCEPTION', 'SEQUENTIAL_SIMULATION_REVERT'].includes(error.code) && attempt < 2) {
          update({ phase: 'atomic_retry', atomicAttempt: attempt + 1, atomicRetryReason: 'preflight-price-changed' });
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
    update({ phase: moved ? 'recovery_required' : 'failed', failedAt: Date.now(), error: error.message });
    if (moved) this.ledger.append('rebalance.recovery_required', { ...journal, error: error.message });
    error.atomicHandled = true;
    throw error;
  }
}
