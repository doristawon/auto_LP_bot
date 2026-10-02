import { Interface, id, toBeHex, zeroPadValue } from 'ethers';
import { DEPOSITED_EVENT, EIP7702_GUARD_ABI } from '../abi.js';

const guard = new Interface(EIP7702_GUARD_ABI);
export function findOfficialRepositionEvent(receipt, walletAddress, poolId) {
  const matches = [];
  for (const item of receipt.logs || []) {
    if (String(item.address).toLowerCase() !== walletAddress.toLowerCase()) continue;
    try {
      const parsed = guard.parseLog(item);
      if (parsed?.name === 'OfficialRepositioned'
        && String(parsed.args.poolId).toLowerCase() === poolId.toLowerCase()) matches.push(parsed.args);
    } catch {}
  }
  if (matches.length !== 1) throw new Error('Official receipt must contain one matching guarded reposition event');
  return matches[0];
}

// No alternate capital transaction is permitted after a hash is persisted.
// A failed RPC response can still mean the transaction was accepted.
export async function executeOfficialReposition({ plan, candidate, journal }) {
  let hash = null;
  let confirmed = false;
  const update = patch => { journal = this.patchJournal(journal, patch); };
  try {
    if (this.state?.getSetting('executionPaused', false)) throw new Error('Execution is paused');
    const [latestNonce, pendingNonce] = await Promise.all([
      this.writeProvider.getTransactionCount(this.config.walletAddress, 'latest'),
      this.writeProvider.getTransactionCount(this.config.walletAddress, 'pending')
    ]);
    if (latestNonce !== pendingNonce) throw new Error('Wallet has a pending transaction');
    await this.assertPlanStillOutOfRange(plan, 'official-before-send');
    const sharesBefore = await this.readPositionShares(plan.pool, candidate.expected.rangeId);
    const fees = await this.getPinnedFeeOverrides();
    await this.assertTopUpGasBudget({ reserveWei: this.config.topUpMinGasReserveWei,
      maxFeePerGas: fees.maxFeePerGas || fees.gasPrice,
      futureGasLimit: BigInt(candidate.gasUsed) * 3n / 2n + 25_000n,
      phase: 'official-reposition-before-send' });
    update({ phase: 'official_preflighted', officialReposition: candidate.summary,
      officialClaimRanges: candidate.claimRanges, target: candidate.target });
    const receipt = await this.sendVerifiedTx({ label: 'guardedRepositionAndClaim',
      to: candidate.request.to, data: candidate.request.data, value: 0n,
      onSent: sentHash => {
        hash = sentHash;
        update({ phase: 'official_sent', tx: { ...journal.tx, officialReposition: sentHash } });
      } });
    confirmed = true;
    hash = receipt.hash || hash;
    update({ phase: 'official_confirmed', tx: { ...journal.tx, officialReposition: hash } });
    const event = findOfficialRepositionEvent(receipt, this.config.walletAddress, plan.pool.id);
    const deposits = (receipt.logs || []).filter(log =>
      String(log.address).toLowerCase() === plan.pool.key.hooks.toLowerCase()
      && String(log.topics?.[0]).toLowerCase() === id(DEPOSITED_EVENT).toLowerCase());
    if (deposits.length !== 1 || BigInt(deposits[0].topics?.[2] || 0) !== BigInt(event.newRangeId)
      || BigInt(deposits[0].data || 0) !== event.liquidity) {
      throw new Error('Official receipt must contain exactly one new LP deposit');
    }
    if (BigInt(event.oldRangeId) !== BigInt(plan.position.id)
      || BigInt(event.newRangeId) !== BigInt(candidate.expected.rangeId)
      || event.liquidity < BigInt(candidate.expected.minLiquidity || candidate.expected.liquidity)
      || event.liquidity <= 0n) throw new Error('Official receipt range/liquidity mismatch');
    const [oldShares, newShares, balances] = await Promise.all([
      this.readPositionShares(plan.pool, plan.position.id),
      this.readPositionShares(plan.pool, candidate.expected.rangeId),
      this.readRawPairBalances(plan.pool)
    ]);
    if (oldShares !== 0n || newShares !== sharesBefore + event.liquidity) {
      throw new Error('Official receipt did not fully replace the old LP shares');
    }
    if (balances.raw0 < BigInt(candidate.protected.raw0) || balances.raw1 < BigInt(candidate.protected.raw1)) {
      throw new Error('Official receipt failed protected balance readback');
    }
    const rangeHex = zeroPadValue(toBeHex(event.newRangeId), 32).toLowerCase();
    const candidateKey = `positionCandidates:${plan.pool.id}`;
    if (this.state?.setSetting) {
      const known = this.state.getSetting(candidateKey, []) || [];
      this.state.setSetting(candidateKey, [...new Set([...known, rangeHex])].sort());
    }
    if (this.fables?.positionCandidates) {
      const known = this.fables.positionCandidates.get(plan.pool.id.toLowerCase()) || new Set();
      known.add(rangeHex);
      this.fables.positionCandidates.set(plan.pool.id.toLowerCase(), known);
    }
    update({ phase: 'completed', completedAt: Date.now(), newPosition: {
      rangeId: String(candidate.expected.rangeId), liquidity: String(event.liquidity),
      shares: String(newShares), ...candidate.target },
      officialClaimedRaw: { raw0: String(event.claimed0), raw1: String(event.claimed1) },
      residualRaw: { raw0: String(event.residual0), raw1: String(event.residual1) } });
    this.ledger.append('rebalance.completed', {
      poolId: plan.pool.id, pair: journal.pair, method: 'official-reposition-and-claim',
      oldPositionId: plan.position.id, newPositionId: String(candidate.expected.rangeId),
      officialRepositionHash: hash, withdrawHash: hash, swapHash: null, depositHash: hash,
      claimedRaw: { raw0: String(event.claimed0), raw1: String(event.claimed1) },
      claimRanges: candidate.claimRanges, target: candidate.target,
      comparison: candidate.summary, dustRetainedRaw: candidate.protected,
      residualRaw: { raw0: String(event.residual0), raw1: String(event.residual1) }
    });
    this.clearJournal();
    return { status: 'completed', method: 'official-reposition-and-claim',
      officialRepositionHash: hash, withdrawHash: hash, swapHash: null, depositHash: hash,
      newPositionId: String(candidate.expected.rangeId), target: candidate.target };
  } catch (error) {
    // Provider errors can contain calldata with one-time Permit2 signatures.
    // Persist a fixed diagnostic category rather than an RPC request dump.
    const safeError = `Official reposition failed (${['BROADCAST_OUTCOME_UNCERTAIN',
      'TRANSACTION_REVERTED'].includes(error.code) ? error.code : 'verification-or-preflight'}); review the recorded transaction hash`;
    const capitalMayHaveMoved = !!hash || confirmed || error.code === 'BROADCAST_OUTCOME_UNCERTAIN';
    // Only a proven confirmed revert with unchanged LP and pair balances is a no-op.
    let noOp = false;
    if (error.code === 'TRANSACTION_REVERTED' && error.receipt?.status === 0) {
      try {
        const [balances, oldShares] = await Promise.all([
          this.readRawPairBalances(plan.pool), this.readPositionShares(plan.pool, plan.position.id)
        ]);
        noOp = oldShares === BigInt(plan.position.shares)
          && balances.raw0 === BigInt(journal.preBalancesRaw.raw0)
          && balances.raw1 === BigInt(journal.preBalancesRaw.raw1);
      } catch {}
    }
    update({ phase: capitalMayHaveMoved && !noOp ? 'recovery_required' : 'failed',
      failedAt: Date.now(), error: safeError,
      tx: { ...journal.tx, ...(hash ? { officialReposition: hash } : {}) } });
    this.ledger.append('rebalance.official_failed', { poolId: plan.pool.id, hash,
      phase: journal.phase, error: safeError, confirmed, noOp });
    if (noOp) this.clearJournal();
    // Replace the provider error entirely: its stack/extra properties can
    // still retain the request even after changing its message.
    const safeFailure = new Error(safeError);
    safeFailure.officialHandled = true;
    if (['BROADCAST_OUTCOME_UNCERTAIN', 'TRANSACTION_REVERTED'].includes(error.code)) {
      safeFailure.code = error.code;
    }
    throw safeFailure;
  }
}
