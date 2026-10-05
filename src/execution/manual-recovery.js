import { Interface, id } from 'ethers';
import { DEPOSITED_EVENT, WITHDRAWN_EVENT } from '../abi.js';
import { fetchOwnerLedger } from '../analytics/points-evidence.js';

const shareTransfer = new Interface(['event Transfer(address caller,address indexed from,address indexed to,uint256 indexed id,uint256 amount)']);
const depositedTopic = id(DEPOSITED_EVENT).toLowerCase();
const withdrawnTopic = id(WITHDRAWN_EVENT).toLowerCase();
const topicAddress = topic => `0x${String(topic).slice(-40)}`.toLowerCase();

// Only reconcile the narrow no-redeposit failure when a later manual LP
// replacement is proven by a receipt and live shares. Never submit capital.
export async function reconcileManualReplacement(executor, pool, {
  fetchLedger = fetchOwnerLedger, replacementPools = [pool]
} = {}) {
  const journal = executor.state.getSetting('activeRebalanceExecution', null);
  if (journal?.phase !== 'recovery_required' || !journal.oldPosition?.id
    || String(journal.poolId).toLowerCase() !== pool.id.toLowerCase()
    || !Number.isFinite(journal.startedAt) || journal.startedAt <= 0
    || journal.pendingTx || !journal.tx?.withdraw
    || Object.entries(journal.tx).some(([key, value]) => key !== 'withdraw' && value && (!Array.isArray(value) || value.length))) {
    throw new Error('待復原交易不符合手動 LP 替換核對條件。');
  }
  const wallet = executor.config.walletAddress.toLowerCase();
  const broadcasts = executor.ledger.all().filter(event => event.ts >= journal.startedAt);
  if (broadcasts.some(event => ['tx.broadcast_pending','tx.broadcast_uncertain'].includes(event.type)
    && !broadcasts.some(done => ['tx.confirmed','tx.reverted'].includes(done.type) && done.hash === event.hash))) {
    throw new Error('仍有尚未核對的交易，不可解除復原狀態。');
  }
  const [latest, pending, receipt, oldShares] = await Promise.all([
    executor.writeProvider.getTransactionCount(wallet, 'latest'),
    executor.writeProvider.getTransactionCount(wallet, 'pending'),
    executor.readProvider.getTransactionReceipt(journal.tx.withdraw),
    executor.readPositionShares(pool, journal.oldPosition.id)
  ]);
  if (latest !== pending || receipt?.status !== 1 || oldShares !== 0n
    || !(receipt.logs || []).some(log => String(log.address).toLowerCase() === pool.key.hooks.toLowerCase()
      && String(log.topics?.[0]).toLowerCase() === withdrawnTopic
      && topicAddress(log.topics[1]) === wallet && BigInt(log.topics[2]) === BigInt(journal.oldPosition.id))) {
    throw new Error('撤池收據、舊 LP 份額或交易 nonce 尚未一致。');
  }
  // The user may have replaced the withdrawn LP in another registered pool.
  // A selected pool name is not proof: verify its receipt, PoolKey and live shares.
  const poolById = new Map(replacementPools.map(item => [item.id.toLowerCase(), item]));
  poolById.set(pool.id.toLowerCase(), pool);
  const owner = await fetchLedger(wallet);
  const candidates = (owner.LiquidityEvent || []).filter(event => ['DEPOSIT','TRANSFER_IN'].includes(event.kind)
    && poolById.has(String(event.pool_id).toLowerCase())
    && BigInt(event.range_id) !== BigInt(journal.oldPosition.id) && Number(event.block) > receipt.blockNumber
    && /^0x[0-9a-f]{64}$/i.test(event.txHash)).reverse();
  for (const event of candidates.slice(0, 16)) {
    const replacementPool = poolById.get(String(event.pool_id).toLowerCase());
    const shares = await executor.readPositionShares(replacementPool, event.range_id);
    if (shares <= 0n) continue;
    const replacement = await executor.readProvider.getTransactionReceipt(event.txHash);
    if (replacement?.status !== 1 || replacement.blockNumber <= receipt.blockNumber) continue;
    if (String(replacement.hash).toLowerCase() !== event.txHash.toLowerCase()) continue;
    const key = await executor.fables.readRangeKey(replacementPool, event.range_id);
    if (!key.exists || !['currency0','currency1','fee','tickSpacing','hooks'].every(name =>
      String(key.key[name]).toLowerCase() === String(replacementPool.key[name]).toLowerCase())) continue;
    const matched = (replacement.logs || []).some(log => {
      if (String(log.address).toLowerCase() !== replacementPool.key.hooks.toLowerCase()) return false;
      if (String(log.topics?.[0]).toLowerCase() === depositedTopic) return topicAddress(log.topics[1]) === wallet
        && BigInt(log.topics[2]) === BigInt(event.range_id) && BigInt(log.data) > 0n;
      try { const transfer = shareTransfer.parseLog(log);
        return transfer?.args.to.toLowerCase() === wallet && transfer.args.id === BigInt(event.range_id) && transfer.args.amount > 0n;
      } catch { return false; }
    });
    if (!matched) continue;
    const [finalLatest, finalPending, finalShares] = await Promise.all([
      executor.writeProvider.getTransactionCount(wallet, 'latest'),
      executor.writeProvider.getTransactionCount(wallet, 'pending'),
      executor.readPositionShares(replacementPool, event.range_id)
    ]);
    const current = executor.state.getSetting('activeRebalanceExecution', null);
    if (current?.id !== journal.id || current.phase !== 'recovery_required' || current.pendingTx
      || finalLatest !== latest || finalPending !== latest || finalShares !== shares) {
      throw new Error('復原紀錄或鏈上資產已變更，請重新核對。');
    }
    const proof = { originalExecutionId: journal.id, withdrawHash: journal.tx.withdraw,
      replacementHash: event.txHash, replacementBlock: replacement.blockNumber,
      oldPoolId: pool.id, poolId: replacementPool.id,
      pair: replacementPool.token0 && replacementPool.token1
        ? `${replacementPool.token0.symbol}/${replacementPool.token1.symbol}` : null,
      positionId: event.range_id, shares: String(shares),
      tickLower: Number(key.tickLower), tickUpper: Number(key.tickUpper), nonce: latest };
    executor.ledger.append('rebalance.recovery_resolved', { ...proof, method: 'verified-manual-lp-replacement' });
    executor.patchJournal(journal, { phase: 'failed', failedAt: Date.now(),
      error: 'Original redeposit failed; later manual LP replacement verified', reconciliation: proof });
    executor.clearJournal();
    return { status: 'resolved', ...proof };
  }
  throw new Error('尚未找到已確認且仍持有份額的手動替換 LP；請先核對撤池後的資產與交易。');
}
