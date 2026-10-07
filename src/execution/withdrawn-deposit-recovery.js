import { buildExecutionTargetRange } from './pool-target-range.js';
import { id } from 'ethers';
import { WITHDRAWN_EVENT } from '../abi.js';
import { buildPairFundingScope } from './pair-funding.js';
import { executeAtomicDeposit } from './atomic-deposit.js';
import { evaluateStopLoss } from '../analytics/stop-loss.js';

// A confirmed withdrawal may be followed by a transport/planning failure.
// Keep the original journal and resume only the atomic deposit, never withdraw again.
export async function verifyWithdrawnInventory(executor, pool) {
  const journal = executor.state.getSetting('activeRebalanceExecution', null);
  if (journal?.phase !== 'recovery_required' || !journal.oldPosition?.id
    || String(journal.poolId).toLowerCase() !== pool.id.toLowerCase()
    || journal.destinationPoolId || journal.allocationJobId || journal.allocationFundingScope
    || !journal.postWithdrawBalancesRaw || journal.pendingTx || !journal.tx?.withdraw
    || Object.entries(journal.tx).some(([key, value]) => key !== 'withdraw' && value
      && (!Array.isArray(value) || value.length)) || executor.isAllocationModeEnabled()) {
    throw new Error('Recovery requires a single-pool confirmed withdrawal with no later capital transaction');
  }
  const wallet = executor.config.walletAddress.toLowerCase();
  const events = executor.ledger.all().filter(event => event.ts >= journal.startedAt);
  const broadcasts = events.filter(event => ['tx.broadcast_pending','tx.broadcast_uncertain'].includes(event.type));
  for (const event of broadcasts) {
    if (!events.some(done => ['tx.confirmed','tx.reverted'].includes(done.type) && done.hash === event.hash)) {
      throw new Error('An unreconciled broadcast prevents recovery');
    }
    if (event.hash !== journal.tx.withdraw && !/^(approve:|permit2:)/.test(event.label || '')) {
      throw new Error('Unexpected capital broadcast prevents recovery');
    }
  }
  const [latest, pending, receipt, shares, balances, range] = await Promise.all([
    executor.writeProvider.getTransactionCount(wallet, 'latest'),
    executor.writeProvider.getTransactionCount(wallet, 'pending'),
    executor.readProvider.getTransactionReceipt(journal.tx.withdraw),
    executor.readPositionShares(pool, journal.oldPosition.id), executor.readRawPairBalances(pool),
    executor.fables.readRangeKey(pool, journal.oldPosition.id)
  ]);
  const matches = (receipt?.logs || []).filter(log => String(log.address).toLowerCase() === pool.key.hooks.toLowerCase()
    && String(log.topics?.[0]).toLowerCase() === id(WITHDRAWN_EVENT).toLowerCase()
    && `0x${String(log.topics?.[1]).slice(-40)}`.toLowerCase() === wallet
    && BigInt(log.topics[2]) === BigInt(journal.oldPosition.id));
  const sameKey=range.exists && ['currency0','currency1','fee','tickSpacing','hooks'].every(key =>
    String(range.key[key]).toLowerCase() === String(pool.key[key]).toLowerCase());
  if (!sameKey || Number(range.tickLower) !== Number(journal.oldPosition.tickLower)
    || Number(range.tickUpper) !== Number(journal.oldPosition.tickUpper)
    || latest !== pending || receipt?.status !== 1 || String(receipt.hash).toLowerCase() !== journal.tx.withdraw.toLowerCase()
    || String(receipt.from).toLowerCase() !== wallet || matches.length !== 1 || shares !== 0n
    || balances.raw0 !== BigInt(journal.postWithdrawBalancesRaw.raw0)
    || balances.raw1 !== BigInt(journal.postWithdrawBalancesRaw.raw1)) {
    throw new Error('Withdrawal receipt, nonce, LP shares and recovered inventory must agree');
  }
  const current = executor.state.getSetting('activeRebalanceExecution', null);
  if (JSON.stringify(current) !== JSON.stringify(journal)) throw new Error('Recovery journal changed during verification');
  return { journal, balances, proof: { withdrawHash: receipt.hash, blockNumber: receipt.blockNumber,
    nonce: latest, oldShares: '0', balancesRaw: {raw0:String(balances.raw0),raw1:String(balances.raw1)} } };
}

export async function resumeWithdrawnDeposit(executor, pool) {
  if (!executor.signer || !executor.config.enableLiveWrites || executor.config.dryRun
    || executor.state.getSetting('executionPaused', true)) throw new Error('Explicit live execution is required to resume deposit');
  if (executor.signer.address.toLowerCase() !== executor.config.walletAddress.toLowerCase()) throw new Error('Recovery signer mismatch');
  if (!executor.config.atomicDepositEnabled) throw new Error('Atomic deposit must remain enabled during recovery');
  if (executor.state.getSetting('investmentTargetMode') !== 'specific-pool'
    || String(executor.state.getSetting('investmentTargetPoolId')).toLowerCase() !== pool.id.toLowerCase()) {
    throw new Error('Recovery pool differs from the saved investment target');
  }
  if (executor.state.getSetting('stopLossLatched', false)) throw new Error('Stop loss is latched');
  const protection=executor.state.getSetting('stopLossSettings', {enabled:false});
  if (protection.enabled) {
    const stopLoss=evaluateStopLoss(protection,executor.state.getSetting('stopLossReference',null),executor.ledger.readSnapshot());
    if (stopLoss.status !== 'monitoring' || stopLoss.triggered) throw new Error('Fresh stop-loss valuation must be below the loss threshold before recovery');
  }
  await executor.assertAtomicGuardReady();
  const verified = await verifyWithdrawnInventory(executor, pool);
  const state = await executor.fables.readPoolState(pool);
  if (state.paused !== false) throw new Error('Recovery pool is paused');
  const final = await verifyWithdrawnInventory(executor, pool);
  if (final.proof.nonce !== verified.proof.nonce) throw new Error('Wallet nonce changed during recovery');
  const scope = buildPairFundingScope(pool, final.balances, executor.config.usdgAddress, executor.config.autoTopupDustBps ?? 25);
  const journal = executor.patchJournal(final.journal, { phase:'withdraw_confirmed',
    recoveryProof:final.proof, recoveryStartedAt:Date.now() });
  executor.ledger.append('rebalance.deposit_recovery_verified', {poolId:pool.id,...final.proof});
  return executeAtomicDeposit.call(executor, { pool, balances:final.balances, funding:scope.funding,
    journal, oldPosition:journal.oldPosition, retarget:true,
    previousApprovalCaps:journal.preWithdrawApprovalCapsRaw,
    target:buildExecutionTargetRange(executor, pool, state.tick),
    maxPriceImpactBps:executor.samePoolRebalanceMaxImpactBps(pool),
    eventMetadata:{recovery:true,originalExecutionId:journal.id} });
}
