import { Contract, Interface, formatUnits } from 'ethers';
import { HOOK_ABI } from '../abi.js';
import { collectOfficialClaimRanges } from './official-fee-claims.js';
import { ZERO_ADDRESS } from '../constants.js';

const hookAbi = new Interface(HOOK_ABI);
const transferAbi = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const terminal = new Set(['completed', 'failed']);

// A claim only moves already earned fees. Never withdraw, swap, approve, or
// change an active range. Use the wallet write queue and normal receipt journal.
export async function claimRetiredRangeFees({ pool, range }) {
  return this.runWalletWrite(async () => {
    const active = this.state?.getSetting('activeRebalanceExecution', null);
    if (active?.phase && !terminal.has(active.phase)) return { status: 'blocked', reason: 'execution-busy' };
    if (this.config.dryRun || !this.config.enableLiveWrites
      || this.state?.getSetting('executionPaused', false)
      || this.state?.getSetting('stopLossLatched', false)) return { status: 'blocked', reason: 'execution-paused' };
    if (!this.state) throw new Error('Fee claim requires a persistent execution journal');
    await this.assertLiveReady({ pool });
    const [latest, pending] = await Promise.all([
      this.writeProvider.getTransactionCount(this.config.walletAddress, 'latest'),
      this.writeProvider.getTransactionCount(this.config.walletAddress, 'pending')
    ]);
    if (latest !== pending) return { status: 'blocked', reason: 'pending-transaction' };
    // Revalidate the exact pool/range and eligibility immediately before send;
    // owner indexer entries and previous-cycle fee amounts are not authority.
    const rows = await collectOfficialClaimRanges({ pool, walletAddress: this.config.walletAddress,
      provider: this.readProvider, retiredOnly: true, ownerLedger: { Position: [] },
      knownRangeIds: [range.rangeId], maxFeeBps: Math.min(1000, this.config.fablesWalk ?? 1000) });
    const verified = rows.find(item => item.rangeId.toLowerCase() === range.rangeId.toLowerCase());
    if (!verified) return { status: 'skipped', reason: 'no-eligible-retired-fees' };
    if ([pool.key.currency0, pool.key.currency1].some(token => token.toLowerCase() === ZERO_ADDRESS)) {
      throw new Error('Native token fee claims are not enabled');
    }
    const data = hookAbi.encodeFunctionData('claimFees', [pool.key, verified.tickLower,
      verified.tickUpper, this.config.walletAddress, this.config.fablesWalk ?? 1000]);
    const fees = await this.getPinnedFeeOverrides();
    const gas = await this.signer.estimateGas({ to: pool.key.hooks, data, value: 0n, from: this.config.walletAddress });
    const gasLimit = gas * 150n / 100n + 25_000n;
    await this.assertTopUpGasBudget({ reserveWei: this.config.topUpMinGasReserveWei,
      maxFeePerGas: fees.maxFeePerGas || fees.gasPrice, futureGasLimit: gasLimit, phase: 'retired-fee-claim' });
    const amountUsd = Number(formatUnits(verified.claimable0, pool.token0.decimals)) * this.getUsdPrice(pool.token0.address)
      + Number(formatUnits(verified.claimable1, pool.token1.decimals)) * this.getUsdPrice(pool.token1.address);
    const gasUsd = Number(formatUnits(gasLimit * (fees.maxFeePerGas || fees.gasPrice), 18)) * this.getUsdPrice(ZERO_ADDRESS);
    if (!(amountUsd > 0) || !(gasUsd > 0) || amountUsd < Math.max(0.1, gasUsd * 1.2)) {
      return { status: 'deferred', reason: 'fees-below-gas-cost' };
    }
    if (this.state.getSetting('executionPaused', false) || this.state.getSetting('stopLossLatched', false)) {
      return { status: 'blocked', reason: 'execution-paused' };
    }
    let journal = { id: `fee-claim:${Date.now()}:${pool.id}:${range.rangeId}`, kind: 'fee_claim',
      phase: 'claim_preflighted', startedAt: Date.now(), updatedAt: Date.now(), poolId: pool.id,
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`, rangeId: verified.rangeId,
      tickLower: verified.tickLower, tickUpper: verified.tickUpper, tx: {} };
    const update = patch => { journal = this.patchJournal(journal, patch); };
    this.saveJournal(journal);
    try {
      const receipt = await this.sendVerifiedTx({ label: 'claimRetiredFees', to: pool.key.hooks, data,
        feeOverrides: fees, onSent: hash => update({ phase: 'claim_sent', tx: { claim: hash } }) });
      update({ phase: 'claim_confirmed' });
      const amounts = [0n, 0n];
      for (const item of receipt.logs || []) {
        const index = [pool.token0.address, pool.token1.address].findIndex(token =>
          token.toLowerCase() === String(item.address).toLowerCase());
        if (index < 0) continue;
        try {
          const event = transferAbi.parseLog(item);
          if (event?.name === 'Transfer') {
            // Fables pays through its fee vault, not necessarily the hook.
            // Attribute net wallet transfers from this direct, verified claim.
            if (event.args.to.toLowerCase() === this.config.walletAddress.toLowerCase()) amounts[index] += event.args.value;
            if (event.args.from.toLowerCase() === this.config.walletAddress.toLowerCase()) amounts[index] -= event.args.value;
          }
        } catch {}
      }
      const hook = new Contract(pool.key.hooks, HOOK_ABI, this.readProvider);
      const user = await hook.userPosition(verified.rangeId, this.config.walletAddress);
      const shares = await hook.balanceOf(this.config.walletAddress, verified.rangeId);
      if (shares !== 0n || user.owed0 !== 0n || user.owed1 !== 0n || amounts.some(value => value < 0n)
        || amounts.every(value => value === 0n)) {
        throw new Error('Retired fee claim receipt/readback mismatch');
      }
      const event = { poolId: pool.id, pair: journal.pair, positionId: verified.rangeId,
        hash: receipt.hash, blockNumber: receipt.blockNumber,
        amount0: Number(formatUnits(amounts[0], pool.token0.decimals)),
        amount1: Number(formatUnits(amounts[1], pool.token1.decimals)),
        raw0: String(amounts[0]), raw1: String(amounts[1]), symbol0: pool.token0.symbol, symbol1: pool.token1.symbol };
      this.ledger.append('fee.claimed', event);
      // Already counted fee accrual must not be added again as a reward/cashflow.
      this.state.setSetting(`feeState:${pool.id.toLowerCase()}:${verified.rangeId.toLowerCase()}`,
        { owed0: '0', owed1: '0', shares: '0', at: Date.now(), claimHash: receipt.hash });
      update({ phase: 'completed', completedAt: Date.now() });
      this.clearJournal();
      return { status: 'completed', ...event };
    } catch (error) {
      const uncertain = !!journal.tx.claim && error.code !== 'TRANSACTION_REVERTED';
      update({ phase: uncertain ? 'recovery_required' : 'failed', failedAt: Date.now(),
        error: uncertain ? 'Fee claim requires receipt reconciliation' : 'Fee claim simulation or confirmed transaction failed' });
      this.ledger.append('fee.claim_failed', { poolId: pool.id, positionId: verified.rangeId,
        hash: journal.tx.claim || null, recoveryRequired: uncertain });
      if (!uncertain) this.clearJournal();
      throw new Error(journal.error);
    }
  });
}

export async function sweepRetiredFees(pools, { force = false } = {}) {
  if (this.config.autoClaimRetiredFees === false || this.config.dryRun || !this.config.enableLiveWrites
    || this.executionPaused || this.state.getSetting('stopLossLatched', false)) return;
  const active = this.state.getSetting('activeRebalanceExecution', null);
  if (active?.phase && !terminal.has(active.phase)) return;
  if (!force && Date.now() < Number(this.state.getSetting('retiredFeeScanAfter', 0))) return;
  this.state.setSetting('retiredFeeScanAfter', Date.now() + Math.max(300_000, this.config.rangeCheckIntervalMs || 300_000));
  try {
    const { fetchOwnerLedger } = await import('../analytics/points-evidence.js');
    const owner = await fetchOwnerLedger(this.config.walletAddress);
    let claims = 0;
    for (const pool of pools) {
      const rows = await collectOfficialClaimRanges({ pool, walletAddress: this.config.walletAddress,
        provider: this.providers.readProvider, retiredOnly: true, ownerLedger: owner,
        knownRangeIds: this.state.getSetting(`positionCandidates:${pool.id}`, []) });
      for (const row of rows) {
        const result = await claimRetiredRangeFees.call(this.executor, { pool, range: row });
        if (result.status === 'completed') {
          this.capitalReadbackPending = true;
          if (++claims >= 4) return;
        }
        if (result.status === 'blocked') return;
      }
    }
  } catch (error) {
    this.ledger.append('fee.claim_scan_failed', { reason: 'Historical fee scan or claim failed; retry on next scheduled scan' });
    if (this.state.getSetting('activeRebalanceExecution', null)?.phase === 'recovery_required') {
      this.setExecutionPaused(true, 'fee-claim-recovery-required');
    }
  }
}
