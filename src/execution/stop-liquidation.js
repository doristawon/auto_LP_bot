import { Contract } from 'ethers';
import { ERC20_ABI } from '../abi.js';
import { ZERO_ADDRESS } from '../constants.js';
import { buildExactWithdrawBounds } from '../math/v4-fixed.js';
import { findV4Route } from './investment-target.js';
import { sanitize } from '../logger.js';

export async function reconcileStopLiquidation(executor) {
  const journal = executor.state?.getSetting('activeRebalanceExecution', null);
  if (journal?.kind !== 'stop_liquidation' || ['completed', 'failed'].includes(journal.phase)) return false;
  const events = executor.ledger.all().filter(event => Number(event.ts) >= Number(journal.startedAt));
  const hashes = new Set([...Object.values(journal.tx || {}).flat(), journal.pendingTx?.hash,
    ...events.filter(event => ['tx.broadcast_pending', 'tx.broadcast_uncertain'].includes(event.type)).map(event => event.hash)].filter(Boolean));
  try {
    for (const hash of hashes) {
      const receipt = await executor.writeProvider.getTransactionReceipt(hash);
      if (!receipt || ![0, 1].includes(receipt.status) || !(receipt.blockNumber > 0)
        || String(receipt.hash).toLowerCase() !== String(hash).toLowerCase()) throw new Error('清倉交易尚未取得可確認的 receipt。');
    }
    const wallet = executor.config.walletAddress;
    const [latest, pending] = await Promise.all(['latest', 'pending'].map(tag => executor.writeProvider.getTransactionCount(wallet, tag)));
    if (latest !== pending) throw new Error('錢包仍有待確認交易。');
    executor.patchJournal(journal, { phase: 'failed', pendingTx: null, failedAt: Date.now(),
      error: '服務中斷；已確認既有清倉交易，可由使用者重試剩餘資產。',
      reconciliation: { hashes: [...hashes], receiptsConfirmed: true, nonce: latest } });
    executor.ledger.append('stop_loss.restart_reconciled', { id: journal.id, confirmedHashes: [...hashes] });
    return true;
  } catch (error) {
    executor.patchJournal(journal, { phase: 'recovery_required', error: sanitize(error.message), failedAt: Date.now() });
    return false;
  }
}

// Explicit emergency exit, independent of the normal OOR withdrawal guard.
// Each action is simulated, receipt-confirmed and re-read before the next action.
export async function executeStopLiquidation(executor, { pools, extraTokens = [], maxCostBps = 500 }) {
  return executor.runWalletWrite(async () => {
    executor.assertNoUnfinishedExecution();
    const cfg = executor.config, wallet = cfg.walletAddress;
    if (cfg.dryRun || !cfg.enableLiveWrites || !cfg.enableAutoRedeploy || !executor.signer
      || executor.signer.address.toLowerCase() !== wallet.toLowerCase()) throw new Error('停機清倉需要實盤簽署錢包。');
    if (!Number.isInteger(maxCostBps) || maxCostBps < 1 || maxCostBps > 500) throw new Error('清倉換幣成本上限須為 1 至 500 bps。');
    await executor.assertAtomicGuardReady();
    await executor.assertGasGuard();
    const id = `stop-liquidation:${Date.now()}`;
    let journal = { id, kind: 'stop_liquidation', phase: 'prepared', startedAt: Date.now(), tx: {}, completedSteps: [] };
    executor.saveJournal(journal);
    const patch = (data) => { journal = executor.patchJournal(executor.state.getSetting('activeRebalanceExecution', journal), data); };
    const send = async (step, request) => {
      patch({ phase: 'stop_preflight', step });
      const receipt = await executor.sendVerifiedTx({ ...request,
        onSent: hash => patch({ phase: 'stop_sent', tx: { ...journal.tx, [step]: hash } }) });
      patch({ phase: 'stop_confirmed', completedSteps: [...journal.completedSteps, { step, hash: receipt.hash }] });
      return receipt;
    };
    try {
      const tokens = new Map();
      for (const pool of pools) {
        for (const token of [pool.token0, pool.token1]) tokens.set(token.address.toLowerCase(), token);
        for (const original of pool.positions || []) {
          const shares = BigInt(await executor.readPositionShares(pool, original.id));
          if (shares === 0n) continue;
          const state = await executor.fables.readPoolState(pool);
          const key = await executor.fables.readRangeKey(pool, original.id);
          if (!key.exists || Number(key.tickLower) !== Number(original.tickLower)
            || Number(key.tickUpper) !== Number(original.tickUpper)
            || String(key.key.hooks).toLowerCase() !== pool.key.hooks.toLowerCase()
            || String(key.key.currency0).toLowerCase() !== pool.token0.address.toLowerCase()
            || String(key.key.currency1).toLowerCase() !== pool.token1.address.toLowerCase()
            || Number(key.key.fee) !== Number(pool.key.fee) || Number(key.key.tickSpacing) !== Number(pool.key.tickSpacing)) {
            throw new Error('停損部位與鏈上 range key 不符。');
          }
          const position = { ...original, shares };
          const bounds = buildExactWithdrawBounds({ sqrtPriceX96: state.sqrtPriceX96,
            tickLower: position.tickLower, tickUpper: position.tickUpper, liquidity: shares,
            slippageBps: cfg.withdrawSlippageBps });
          await send(`withdraw:${pool.id}:${position.id}`, { label: 'stopLossWithdrawAndClaim', to: pool.key.hooks,
            data: executor.fables.encodeWithdrawAndClaim(pool, position, bounds.amount0Min, bounds.amount1Min,
              executor.deadline(), cfg.fablesWalk), value: 0n });
          if (BigInt(await executor.readPositionShares(pool, position.id)) !== 0n) throw new Error('停損撤池後仍有 LP shares，已停止後續操作。');
        }
      }
      for (const token of extraTokens) tokens.set(token.address.toLowerCase(), token);
      const residual = [];
      const stable = cfg.usdgAddress.toLowerCase();
      const activePools = pools.filter(pool => ![pool.token0, pool.token1].some(t => t.address.toLowerCase() === ZERO_ADDRESS));
      for (const [address, token] of tokens) {
        if (address === stable || address === ZERO_ADDRESS) continue;
        const amount = BigInt(await executor.readRawTokenBalance(token));
        if (amount === 0n) continue;
        const route = findV4Route(activePools, address, stable);
        if (!route) { residual.push({ address, raw: amount.toString(), reason: '沒有可驗證的 USDG 路徑' }); continue; }
        try { await executor.quoteCrossPoolRoute(route, token, amount, maxCostBps); }
        catch (error) { residual.push({ address, raw: amount.toString(), reason: sanitize(error.message) }); continue; }
        await executor.ensureSwapAllowances(token, amount);
        let fresh;
        try { fresh = await executor.quoteCrossPoolRoute(route, token, amount, maxCostBps); }
        catch (error) { residual.push({ address, raw: amount.toString(), reason: sanitize(error.message) }); continue; }
        if (BigInt(await executor.readRawTokenBalance(token)) !== amount) throw new Error('清倉報價期間錢包餘額變動，停止使用舊報價。');
        const stableBefore = await new Contract(stable, ERC20_ABI, executor.writeProvider).balanceOf(wallet);
        await send(`swap:${address}`, { label: 'stopLossSwapToUSDG', to: fresh.request.router,
          data: fresh.request.data, value: fresh.request.value });
        if (BigInt(await executor.readRawTokenBalance(token)) !== 0n) throw new Error('清倉換幣後仍有輸入代幣餘額。');
        const stableAfter = await new Contract(stable, ERC20_ABI, executor.writeProvider).balanceOf(wallet);
        if (BigInt(stableAfter) - BigInt(stableBefore) < BigInt(fresh.quote.minRawAmountOut)) throw new Error('清倉 USDG 到帳低於報價下限。');
      }
      // Native ETH is last: retain gas for the final transaction and later recovery.
      const nativePool = pools.find(pool => [pool.token0, pool.token1].some(t => t.address.toLowerCase() === ZERO_ADDRESS)
        && [pool.token0, pool.token1].some(t => t.address.toLowerCase() === stable) && pool.state?.paused === false);
      const fees = await executor.getPinnedFeeOverrides();
      const reserve = BigInt(cfg.topUpMinGasReserveWei || 200_000_000_000_000n)
        + BigInt(fees.maxFeePerGas ?? fees.gasPrice ?? 0) * 3_000_000n;
      const nativeBalance = BigInt(await executor.writeProvider.getBalance(wallet));
      if (nativeBalance > reserve) {
        if (!nativePool) residual.push({ address: ZERO_ADDRESS, reason: '沒有 ETH／USDG 直接路徑，ETH 保留在錢包' });
        else {
          const amount = nativeBalance - reserve;
          const state = await executor.fables.readPoolState(nativePool);
          const index = nativePool.token0.address.toLowerCase() === ZERO_ADDRESS ? 0 : 1;
          const quote = await executor.quoter.quoteExactInputSingleRaw(nativePool, index, amount, cfg.swapSlippageBps);
          executor.assertQuotePriceImpact(nativePool, quote, amount, state, maxCostBps);
          const request = executor.router.buildV4ExactInputSingle({ pool: nativePool, quote, deadline: executor.deadline(), allowNative: true });
          const before = await new Contract(stable, ERC20_ABI, executor.writeProvider).balanceOf(wallet);
          await send('swap:native', { label: 'stopLossETHToUSDG', to: request.router, data: request.data, value: request.value });
          const after = await new Contract(stable, ERC20_ABI, executor.writeProvider).balanceOf(wallet);
          if (BigInt(after) - BigInt(before) < BigInt(quote.minRawAmountOut)) throw new Error('ETH 清倉 USDG 到帳低於下限。');
        }
      }
      const actualNative = BigInt(await executor.writeProvider.getBalance(wallet));
      if (nativePool && nativeBalance > reserve && actualNative > reserve) residual.push({ address: ZERO_ADDRESS,
        raw: (actualNative - reserve).toString(), reason: 'ETH 未全額消耗；已退回錢包，未宣稱全部換出' });
      patch({ phase: residual.length ? 'failed' : 'completed', completedAt: Date.now(), residual,
        retainedGasWei: reserve.toString(), actualNativeBalanceWei: actualNative.toString() });
      executor.ledger.append('stop_loss.liquidation_finished', { id, residual, completedSteps: journal.completedSteps });
      return { status: residual.length ? 'partial' : 'completed', residual, retainedGasWei: reserve.toString(),
        actualNativeBalanceWei: actualNative.toString(), tx: journal.tx };
    } catch (error) {
      const uncertain = error.code === 'BROADCAST_OUTCOME_UNCERTAIN' || journal.phase === 'stop_sent'
        || executor.state.getSetting('activeRebalanceExecution', null)?.pendingTx;
      patch({ phase: uncertain ? 'recovery_required' : 'failed', error: sanitize(error.message), failedAt: Date.now() });
      executor.ledger.append('stop_loss.liquidation_failed', { id, error: sanitize(error.message), recoveryRequired: Boolean(uncertain) });
      throw error;
    }
  });
}
