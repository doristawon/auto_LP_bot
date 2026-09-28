import {
  Contract,
  Interface,
  MaxUint256,
  Wallet,
  formatUnits,
  id,
  keccak256,
  zeroPadValue
} from 'ethers';
import {
  DEPOSITED_EVENT,
  EIP7702_GUARD_ABI,
  ERC20_ABI,
  HOOK_ABI,
  PERMIT2_ABI
} from '../abi.js';
import {
  PERMIT2,
  UNISWAP_UNIVERSAL_ROUTER_212,
  ZERO_ADDRESS
} from '../constants.js';
import { UniversalRouterAdapter } from './universal-router.js';
import { V4QuoterAdapter } from './quoter.js';
import { buildExactBalancedSwapPlan, quotePriceImpactBps } from '../execution/exact-rebalance.js';
import { buildPairFundingScope } from '../execution/pair-funding.js';
import { simulateSequentialCalls } from '../execution/sequential-simulation.js';
import {
  MAX_UINT128,
  buildExactDepositPlan,
  buildExactWithdrawBounds
} from '../math/v4-fixed.js';
import { buildTargetRange, isLpInRange, isLpOutOfRange } from '../math/ticks.js';
import {
  buildCrossPoolFundingScope,
  buildV4PathKeys,
  chooseInvestmentAnchor,
  assertCrossPoolWeightedQuoteCost
} from '../execution/investment-target.js';
import { log } from '../logger.js';

const erc20Interface = new Interface(ERC20_ABI);
const permit2Interface = new Interface(PERMIT2_ABI);
const guardInterface = new Interface(EIP7702_GUARD_ABI);
const swapEventInterface = new Interface([
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)'
]);
const depositedTopic = id(DEPOSITED_EVENT).toLowerCase();
const TOP_UP_DEPOSIT_GAS_LIMIT = 1_200_000n;
const TOP_UP_APPROVAL_GAS_RESERVE = 300_000n;
const TOP_UP_SWAP_GAS_LIMIT = 1_500_000n;

export class RebalanceExecutor {
  constructor(readProvider, writeProvider, config, fables, ledger, getUsdPrice, state = null) {
    this.readProvider = readProvider;
    this.writeProvider = writeProvider;
    this.config = config;
    this.fables = fables;
    this.ledger = ledger;
    this.getUsdPrice = getUsdPrice;
    this.state = state;
    this.signer = config.privateKey ? new Wallet(config.privateKey, writeProvider) : null;
    this.quoter = new V4QuoterAdapter(readProvider);
    this.router = new UniversalRouterAdapter(readProvider, config);
  }

  async execute(plan) {
    await this.assertPlanStillOutOfRange(plan, 'executor-entry');

    const destinationPool = plan.destinationPool || plan.pool;
    if (String(destinationPool.id).toLowerCase() !== String(plan.pool.id).toLowerCase()) {
      return this.executeCrossPool(plan, destinationPool);
    }

    if (this.config.dryRun || !this.config.enableLiveWrites) {
      const payload = serializablePlan(plan);
      this.ledger.append('rebalance.dry_run', payload);
      log('info', 'rebalance.dry_run', payload);
      return { status: 'dry-run' };
    }

    await this.assertLiveReady(plan);
    this.assertNoUnfinishedExecution();
    const rebalanceMaxImpactBps = this.samePoolRebalanceMaxImpactBps(plan.pool);
    let phase = 'prepared';
    let journal = {
      id: `${Date.now()}:${plan.pool.id}:${plan.position.id}`,
      phase,
      startedAt: Date.now(),
      poolId: plan.pool.id,
      pair: `${plan.pool.token0.symbol}/${plan.pool.token1.symbol}`,
      oldPosition: {
        id: plan.position.id,
        tickLower: plan.position.tickLower,
        tickUpper: plan.position.tickUpper,
        shares: plan.position.shares.toString()
      },
      tx: {}
    };
    this.saveJournal(journal);

    try {
      const preBalances = await this.readRawPairBalances(plan.pool);
      journal = this.patchJournal(journal, {
        preBalancesRaw: stringifyRawBalances(preBalances)
      });
      const approvalState = await this.fables.readPoolState(plan.pool);
      const approvalBounds = buildExactWithdrawBounds({
        sqrtPriceX96: approvalState.sqrtPriceX96,
        tickLower: plan.position.tickLower,
        tickUpper: plan.position.tickUpper,
        liquidity: plan.position.shares,
        slippageBps: this.config.withdrawSlippageBps
      });

      // Prepare every approval path before principal is withdrawn. If a meme token
      // rejects approve/Permit2, fail while the LP is still intact.
      const approval0 = approvalBounds.expected0 + BigInt(plan.position.owed0 || 0n) + preBalances.raw0;
      const approval1 = approvalBounds.expected1 + BigInt(plan.position.owed1 || 0n) + preBalances.raw1;
      await this.ensureSwapAllowances(plan.pool.token0, approval0);
      await this.ensureSwapAllowances(plan.pool.token1, approval1);
      await this.ensureHookAllowance(plan.pool.token0, plan.pool.key.hooks, approval0);
      await this.ensureHookAllowance(plan.pool.token1, plan.pool.key.hooks, approval1);
      journal = this.patchJournal(journal, { phase: 'approvals_ready' });

      // Approvals can consume blocks; re-check OOR only after all non-capital-moving
      // setup transactions are complete.
      const latest = await this.assertPlanStillOutOfRange(plan, 'pre-atomic-withdraw');
      const withdrawBounds = buildExactWithdrawBounds({
        sqrtPriceX96: latest.sqrtPriceX96,
        tickLower: plan.position.tickLower,
        tickUpper: plan.position.tickUpper,
        liquidity: plan.position.shares,
        slippageBps: this.config.withdrawSlippageBps
      });
      if (!this.config.allowZeroMinOut && withdrawBounds.expected0 > 0n && withdrawBounds.amount0Min === 0n) {
        throw new Error('withdraw amount0Min resolved to zero for non-zero expected principal');
      }
      if (!this.config.allowZeroMinOut && withdrawBounds.expected1 > 0n && withdrawBounds.amount1Min === 0n) {
        throw new Error('withdraw amount1Min resolved to zero for non-zero expected principal');
      }

      const withdrawDeadline = this.deadline();
      const guardedData = guardInterface.encodeFunctionData('guardedWithdrawAndClaim', [
        [
          plan.pool.key.currency0,
          plan.pool.key.currency1,
          plan.pool.key.fee,
          plan.pool.key.tickSpacing,
          plan.pool.key.hooks
        ],
        plan.position.tickLower,
        plan.position.tickUpper,
        BigInt(plan.position.shares),
        this.config.walletAddress,
        withdrawBounds.amount0Min,
        withdrawBounds.amount1Min,
        BigInt(withdrawDeadline),
        this.config.fablesWalk
      ]);

      journal = this.patchJournal(journal, {
        phase: 'withdraw_preflighted',
        withdraw: {
          expected0: withdrawBounds.expected0.toString(),
          expected1: withdrawBounds.expected1.toString(),
          amount0Min: withdrawBounds.amount0Min.toString(),
          amount1Min: withdrawBounds.amount1Min.toString(),
          deadline: withdrawDeadline,
          walk: this.config.fablesWalk
        }
      });

      // Prove the post-withdraw route and new tight-range deposit in one
      // temporary RPC state before any principal is moved on-chain.
      const sequencePreflight = await this.preflightSamePoolSequence({
        pool: plan.pool,
        position: plan.position,
        guardedData,
        preBalances,
        poolState: latest,
        deadline: withdrawDeadline,
        maxPriceImpactBps: rebalanceMaxImpactBps
      });
      const feeOverrides = await this.getPinnedFeeOverrides();
      await this.assertTopUpGasBudget({
        reserveWei: this.config.topUpMinGasReserveWei,
        maxFeePerGas: feeOverrides.maxFeePerGas || feeOverrides.gasPrice,
        futureGasLimit: BigInt(sequencePreflight.simulatedGasUsed) * 3n / 2n,
        phase: 'same-pool-rebalance-before-withdrawal'
      });
      journal = this.patchJournal(journal, {
        phase: 'sequence_preflighted',
        sequencePreflight
      });
      await this.assertPlanStillOutOfRange(plan, 'after-sequence-preflight');

      const withdrawReceipt = await this.sendVerifiedTx({
        label: 'guardedWithdrawAndClaim',
        to: this.config.walletAddress,
        data: guardedData,
        value: 0n,
        onSent: (hash) => {
          phase = 'withdraw_sent';
          journal = this.patchJournal(journal, { phase, tx: { ...journal.tx, withdraw: hash } });
        }
      });
      phase = 'withdraw_confirmed';
      journal = this.patchJournal(journal, {
        phase,
        tx: { ...journal.tx, withdraw: withdrawReceipt.hash || journal.tx.withdraw }
      });

      const oldShares = await this.readPositionShares(plan.pool, plan.position.id);
      if (oldShares !== 0n) throw new Error(`Old LP shares remain after full withdraw: ${oldShares}`);

      const postWithdrawBalances = await this.readRawPairBalances(plan.pool);
      const withdrawn = positiveOperationDelta(preBalances, postWithdrawBalances);
      if (withdrawn.raw0 === 0n && withdrawn.raw1 === 0n) {
        throw new Error('Withdraw confirmed but no token principal/fees reached the wallet');
      }
      const fundingScope = buildPairFundingScope(
        plan.pool, postWithdrawBalances, this.config.usdgAddress, this.config.autoTopupDustBps ?? 25
      );
      journal = this.patchJournal(journal, {
        postWithdrawBalancesRaw: stringifyRawBalances(postWithdrawBalances),
        withdrawnRaw: stringifyRawBalances(withdrawn),
        initialWalletFundingRaw: stringifyRawBalances(preBalances),
        dustRetainedRaw: stringifyRawBalances(fundingScope.dustRaw),
        combinedFundingRaw: stringifyRawBalances(fundingScope.funding)
      });

      const postWithdrawState = await this.fables.readPoolState(plan.pool);
      const targetAfterWithdraw = buildTargetRange(
        postWithdrawState.tick,
        plan.pool.key.tickSpacing,
        this.config.tightWidthBps,
        this.config.rangePreset
      );
      const swapPlan = await buildExactBalancedSwapPlan({
        pool: plan.pool,
        quoter: this.quoter,
        rawAmount0: fundingScope.funding.raw0,
        rawAmount1: fundingScope.funding.raw1,
        sqrtPriceX96: postWithdrawState.sqrtPriceX96,
        tickLower: targetAfterWithdraw.tickLower,
        tickUpper: targetAfterWithdraw.tickUpper,
        slippageBps: this.config.swapSlippageBps,
        maxPriceImpactBps: rebalanceMaxImpactBps,
        preferRemainderTokenIndex: fundingScope.stableIndex,
        preferredRemainderBps: fundingScope.stableIndex === null ? 0 : Math.min(this.config.autoTopupDustBps ?? 25, 50)
      });
      journal = this.patchJournal(journal, {
        targetAfterWithdraw,
        swapPlan: serializeSwapPlan(swapPlan)
      });

      let postSwapBalances = postWithdrawBalances;
      if (swapPlan.direction !== 'none') {
        const inputToken = swapPlan.tokenIn === 0 ? plan.pool.token0 : plan.pool.token1;
        await this.ensureSwapAllowances(inputToken, swapPlan.rawAmountIn);
        const executableSwapPlan = await this.refreshSingleSwapQuote(
          plan.pool, swapPlan, 'immediately-before-swap', rebalanceMaxImpactBps
        );

        const swapDeadline = this.deadline();
        const request = this.router.buildV4ExactInputSingle({
          pool: plan.pool,
          quote: executableSwapPlan.quote,
          deadline: swapDeadline
        });
        await this.router.simulateV4ExactInputSingle({
          pool: plan.pool,
          quote: executableSwapPlan.quote,
          deadline: swapDeadline,
          from: this.config.walletAddress
        });
        const beforeSwap = postWithdrawBalances;
        const swapReceipt = await this.sendVerifiedTx({
          label: 'v4SwapExactInputSingle',
          to: request.router,
          data: request.data,
          value: request.value,
          onSent: (hash) => {
            phase = 'swap_sent';
            journal = this.patchJournal(journal, { phase, tx: { ...journal.tx, swap: hash } });
          }
        });
        phase = 'swap_confirmed';
        postSwapBalances = await this.readRawPairBalances(plan.pool);
        this.assertSwapReceiptBalances(plan.pool, executableSwapPlan, beforeSwap, postSwapBalances);
        journal = this.patchJournal(journal, {
          phase,
          tx: { ...journal.tx, swap: swapReceipt.hash || journal.tx.swap },
          swapPlan: serializeSwapPlan(executableSwapPlan),
          postSwapBalancesRaw: stringifyRawBalances(postSwapBalances)
        });
      } else {
        phase = 'swap_not_required';
        journal = this.patchJournal(journal, { phase });
      }

      const strategyInventory = operationDelta(fundingScope.dustRaw, postSwapBalances);
      if (strategyInventory.raw0 < 0n || strategyInventory.raw1 < 0n) {
        throw new Error('Post-swap strategy inventory crossed below the retained wallet dust');
      }
      if (strategyInventory.raw0 === 0n && strategyInventory.raw1 === 0n) {
        throw new Error('No strategy inventory remains for redeposit');
      }

      let postSwapState = await this.fables.readPoolState(plan.pool);
      let finalTarget = buildTargetRange(
        postSwapState.tick,
        plan.pool.key.tickSpacing,
        this.config.tightWidthBps,
        this.config.rangePreset
      );
      let exactDeposit = buildExactDepositPlan({
        rawAmount0: strategyInventory.raw0,
        rawAmount1: strategyInventory.raw1,
        sqrtPriceX96: postSwapState.sqrtPriceX96,
        tickLower: finalTarget.tickLower,
        tickUpper: finalTarget.tickUpper,
        slippageBps: this.config.depositSlippageBps,
        liquidityReserveBps: this.config.depositLiquidityReserveBps
      });
      if (exactDeposit.liquidity <= 0n || exactDeposit.liquidity > MAX_UINT128) {
        throw new Error('Exact deposit liquidity is invalid');
      }
      await this.ensureHookAllowance(plan.pool.token0, plan.pool.key.hooks, exactDeposit.amount0Max);
      await this.ensureHookAllowance(plan.pool.token1, plan.pool.key.hooks, exactDeposit.amount1Max);

      // Any allowance transaction, mempool delay, or swap can move the market.
      // Re-read slot0 immediately before deposit and rebuild range/liquidity/caps.
      postSwapState = await this.fables.readPoolState(plan.pool);
      finalTarget = buildTargetRange(
        postSwapState.tick,
        plan.pool.key.tickSpacing,
        this.config.tightWidthBps,
        this.config.rangePreset
      );
      exactDeposit = buildExactDepositPlan({
        rawAmount0: strategyInventory.raw0,
        rawAmount1: strategyInventory.raw1,
        sqrtPriceX96: postSwapState.sqrtPriceX96,
        tickLower: finalTarget.tickLower,
        tickUpper: finalTarget.tickUpper,
        slippageBps: this.config.depositSlippageBps,
        liquidityReserveBps: this.config.depositLiquidityReserveBps
      });
      if (exactDeposit.liquidity <= 0n || exactDeposit.liquidity > MAX_UINT128) {
        throw new Error('Recomputed exact deposit liquidity is invalid');
      }

      const depositDeadline = this.deadline();
      const depositData = this.fables.encodeDeposit(
        plan.pool,
        finalTarget,
        exactDeposit.liquidity,
        exactDeposit.amount0Max,
        exactDeposit.amount1Max,
        depositDeadline
      );
      journal = this.patchJournal(journal, {
        phase: 'deposit_preflighted',
        finalTarget,
        exactDeposit: serializeDepositPlan(exactDeposit),
        strategyInventoryRaw: {
          raw0: strategyInventory.raw0.toString(),
          raw1: strategyInventory.raw1.toString()
        }
      });

      const depositReceipt = await this.sendVerifiedTx({
        label: 'fablesDeposit',
        to: plan.pool.key.hooks,
        data: depositData,
        value: 0n,
        onSent: (hash) => {
          phase = 'deposit_sent';
          journal = this.patchJournal(journal, { phase, tx: { ...journal.tx, deposit: hash } });
        }
      });
      phase = 'deposit_confirmed';
      const depositEvent = this.findWalletDepositEvent(plan.pool, depositReceipt);
      if (!depositEvent) throw new Error('Deposit receipt is missing the wallet Deposited event');

      // Shared hooks can manage multiple PoolKeys. Prove that the minted range is
      // exactly the pool + ticks this execution intended, not merely "some range"
      // emitted by the same hook.
      const mintedRange = await this.fables.readRangeKey(plan.pool, depositEvent.rangeId);
      if (
        !mintedRange.exists ||
        !samePoolKeyLocal(mintedRange.key, plan.pool.key) ||
        Number(mintedRange.tickLower) !== finalTarget.tickLower ||
        Number(mintedRange.tickUpper) !== finalTarget.tickUpper
      ) {
        throw new Error('Deposit receipt minted an unexpected PoolKey/range');
      }

      const newShares = await this.readPositionShares(plan.pool, depositEvent.rangeId);
      if (newShares <= 0n) throw new Error('Deposit confirmed but no new ERC-6909 LP shares were minted');
      const oldSharesAfter = await this.readPositionShares(plan.pool, plan.position.id);
      if (oldSharesAfter !== 0n && depositEvent.rangeId.toLowerCase() !== plan.position.id.toLowerCase()) {
        throw new Error('Old LP shares reappeared after new-range deposit');
      }

      journal = this.patchJournal(journal, {
        phase: 'completed',
        completedAt: Date.now(),
        tx: { ...journal.tx, deposit: depositReceipt.hash || journal.tx.deposit },
        newPosition: {
          rangeId: depositEvent.rangeId,
          liquidity: depositEvent.liquidity.toString(),
          shares: newShares.toString(),
          tickLower: finalTarget.tickLower,
          tickUpper: finalTarget.tickUpper
        }
      });
      this.clearJournal();

      this.ledger.append('rebalance.completed', {
        poolId: plan.pool.id,
        pair: journal.pair,
        oldPositionId: plan.position.id,
        newPositionId: depositEvent.rangeId,
        withdrawHash: journal.tx.withdraw,
        swapHash: journal.tx.swap || null,
        depositHash: journal.tx.deposit,
        initialWalletFundingRaw: journal.initialWalletFundingRaw,
        combinedFundingRaw: journal.combinedFundingRaw,
        dustRetainedRaw: journal.dustRetainedRaw,
        target: finalTarget
      });
      return {
        status: 'completed',
        withdrawHash: journal.tx.withdraw,
        swapHash: journal.tx.swap || null,
        depositHash: journal.tx.deposit,
        newPositionId: depositEvent.rangeId,
        target: finalTarget
      };
    } catch (error) {
      const afterCapitalMoved = error.code === 'BROADCAST_OUTCOME_UNCERTAIN' || [
        'withdraw_sent',
        'withdraw_confirmed',
        'swap_sent',
        'swap_confirmed',
        'swap_not_required',
        'deposit_preflighted',
        'deposit_sent',
        'deposit_confirmed'
      ].includes(phase);
      if (afterCapitalMoved) {
        let balances = null;
        try { balances = await this.readRawPairBalances(plan.pool); } catch {}
        journal = this.patchJournal(journal, {
          phase: 'recovery_required',
          failedAt: Date.now(),
          error: error.message,
          currentBalancesRaw: balances ? stringifyRawBalances(balances) : null
        });
        this.ledger.append('rebalance.recovery_required', jsonSafe(journal));
      } else {
        this.patchJournal(journal, { phase: 'failed', failedAt: Date.now(), error: error.message });
      }
      throw error;
    }
  }

  async topUpPoolPosition({
    pool,
    position,
    dustBps = 0,
    minGasReserveWei = this.config.topUpMinGasReserveWei
  }) {
    const liveWrites = this.config.enableLiveWrites && !this.config.dryRun;
    const swapEnabledForPool = this.config.autoTopupSwapEnabled === true
      && String(pool?.id || '').toLowerCase() === String(this.config.autoTopupSwapPoolId || '').toLowerCase();
    const topUpMaxPriceImpactBps = swapEnabledForPool
      ? this.config.autoTopupMaxSwapPriceImpactBps
      : this.config.maxSwapPriceImpactBps ?? 200;
    if (!Number.isInteger(Number(dustBps)) || Number(dustBps) < 0 || Number(dustBps) >= 10_000) {
      throw new Error('Top-up dustBps must be an integer from 0 through 9999');
    }
    if (!pool?.token0 || !pool?.token1 || !position?.id) {
      throw new Error('Top-up requires a pool and one identified LP position');
    }
    if (
      pool.token0.address.toLowerCase() === ZERO_ADDRESS
      || pool.token1.address.toLowerCase() === ZERO_ADDRESS
    ) {
      throw new Error('Native-token top-up is not enabled');
    }
    this.assertNoUnfinishedExecution();

    let validation = await this.validateTopUpPosition(pool, position, 'top-up-entry');
    this.assertTokenPrices(pool);
    const initialBalances = await this.readRawPairBalances(pool);
    const { dustRaw, funding, stableIndex } = buildPairFundingScope(
      pool, initialBalances, this.config.usdgAddress, dustBps
    );
    if (funding.raw0 < 0n || funding.raw1 < 0n) throw new Error('Top-up dust exceeds wallet pair balances');
    if (funding.raw0 === 0n && funding.raw1 === 0n) {
      return { status: 'skipped', reason: 'no pair-token balance remains after dust reserve', poolId: pool.id, positionId: position.id };
    }

    let swapPlan = { direction: 'not-quoted', tokenIn: null, tokenOut: null, rawAmountIn: 0n, quote: null };
    let swapQuoteError = null;
    if (!liveWrites || swapEnabledForPool) {
      try {
        swapPlan = await buildExactBalancedSwapPlan({
          pool,
          quoter: this.quoter,
          rawAmount0: funding.raw0,
          rawAmount1: funding.raw1,
          sqrtPriceX96: validation.state.sqrtPriceX96,
          tickLower: Number(position.tickLower),
          tickUpper: Number(position.tickUpper),
          slippageBps: this.config.swapSlippageBps,
          maxPriceImpactBps: topUpMaxPriceImpactBps,
          preferRemainderTokenIndex: stableIndex,
          preferredRemainderBps: stableIndex === null ? 0 : Math.min(Number(dustBps), 50)
        });
      } catch (error) { swapQuoteError = error.message; }
    }
    // Build the live-safe fallback from the inventory that already exists in
    // the wallet. The optional swap projection is informational only: no swap
    // may be broadcast until the projected post-swap deposit can be simulated
    // with an RPC state override and then re-simulated against actual balances.
    let swapProjectedInventory = { ...funding };
    if (swapPlan.direction !== 'none' && swapPlan.direction !== 'not-quoted') {
      const amountOut = BigInt(swapPlan.quote.minRawAmountOut);
      if (swapPlan.tokenIn === 0) {
        swapProjectedInventory = { raw0: funding.raw0 - swapPlan.rawAmountIn, raw1: funding.raw1 + amountOut };
      } else {
        swapProjectedInventory = { raw0: funding.raw0 + amountOut, raw1: funding.raw1 - swapPlan.rawAmountIn };
      }
    }
    let optionalSwapDepositPlan = null;
    let optionalSwapDepositPlanError = null;
    let optionalSwapPreview = null;
    try {
      if (swapPlan.direction === 'none' || swapPlan.direction === 'not-quoted') throw new Error('No optional swap projection available');
      const swapApprovals = await this.buildTopUpApprovalRequests(
        pool, swapPlan, { amount0Max: 0n, amount1Max: 0n }
      );
      optionalSwapPreview = await this.simulateTopUpSwapPreview({
        pool, approvalRequests: swapApprovals, swapPlan
      });
      if (!isLpInRange(optionalSwapPreview.tick, Number(position.tickLower), Number(position.tickUpper))) {
        throw new Error('Simulated swap moves the original LP out of range');
      }
      if (optionalSwapPreview.balances.raw0 < swapProjectedInventory.raw0 + dustRaw.raw0
        || optionalSwapPreview.balances.raw1 < swapProjectedInventory.raw1 + dustRaw.raw1) {
        throw new Error('Simulated swap balances are below the conservative minOut inventory');
      }
      optionalSwapDepositPlan = buildExactDepositPlan({
        rawAmount0: swapProjectedInventory.raw0,
        rawAmount1: swapProjectedInventory.raw1,
        sqrtPriceX96: optionalSwapPreview.sqrtPriceX96,
        tickLower: Number(position.tickLower),
        tickUpper: Number(position.tickUpper),
        slippageBps: this.config.depositSlippageBps,
        liquidityReserveBps: this.config.depositLiquidityReserveBps
      });
      this.assertValidDeposit(optionalSwapDepositPlan, 'Projected top-up deposit liquidity is invalid');
    } catch (error) {
      optionalSwapDepositPlanError = error.message;
    }
    let depositPlan;
    let depositOnlyError = null;
    try {
      depositPlan = buildExactDepositPlan({
        rawAmount0: funding.raw0,
        rawAmount1: funding.raw1,
        sqrtPriceX96: validation.state.sqrtPriceX96,
        tickLower: Number(position.tickLower),
        tickUpper: Number(position.tickUpper),
        slippageBps: this.config.depositSlippageBps,
        liquidityReserveBps: this.config.depositLiquidityReserveBps
      });
    } catch (error) {
      depositOnlyError = error.message;
    }
    if (depositPlan) this.assertValidDeposit(depositPlan, 'Top-up deposit-only liquidity is invalid');
    if (!depositPlan && !optionalSwapDepositPlan) {
      return {
        status: 'skipped',
        reason: `Current pair balances cannot form a positive deposit: ${depositOnlyError || optionalSwapDepositPlanError}`,
        poolId: pool.id,
        positionId: position.id
      };
    }
    const expectedInventory = { ...funding };
    const initialUsd = this.valuePairBalances(pool, funding);
    const preview = {
      poolId: pool.id,
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      positionId: position.id,
      range: { tickLower: Number(position.tickLower), tickUpper: Number(position.tickUpper) },
      currentTick: validation.state.tick,
      walletBalancesRaw: stringifyRawBalances(initialBalances),
      dustRaw: stringifyRawBalances(dustRaw),
      fundingRaw: stringifyRawBalances(funding),
      fundingUsd: initialUsd,
      swapPolicy: swapEnabledForPool
        ? 'swap only after sequential approve + swap + deposit simulation'
        : 'deposit-only; optional swap is disabled',
      swapPlan: serializeSwapPlan(swapPlan),
      swapQuoteError,
      projectedInventoryRaw: stringifyRawBalances(expectedInventory),
      depositPlan: depositPlan ? serializeDepositPlan(depositPlan) : null,
      depositOnlyError,
      optionalSwapProjection: {
        inventoryRaw: stringifyRawBalances(swapProjectedInventory),
        simulatedTick: optionalSwapPreview?.tick ?? null,
        depositPlan: optionalSwapDepositPlan ? serializeDepositPlan(optionalSwapDepositPlan) : null,
        depositPlanError: optionalSwapDepositPlanError
      }
    };

    if (!liveWrites) {
      let fullSwapSimulation = false;
      if (swapEnabledForPool
        && swapPlan.direction !== 'none' && swapPlan.direction !== 'not-quoted'
        && optionalSwapDepositPlan) {
        try {
          const approvals = await this.buildTopUpApprovalRequests(pool, swapPlan, optionalSwapDepositPlan);
          const simulation = await this.simulateTopUpSequence({
            pool, position, approvalRequests: approvals,
            swapPlan, depositPlan: optionalSwapDepositPlan
          });
          preview.swapSimulation = {
            status: 'full-sequence-simulated',
            calls: simulation.callCount,
            priceImpactBps: swapPlan.priceImpactBps
          };
          preview.depositSimulation = {
            status: 'post-swap-deposit-simulated',
            liquidity: simulation.depositEvent.liquidity.toString()
          };
          fullSwapSimulation = true;
        } catch (error) {
          preview.swapSimulation = { status: 'blocked', reason: error.message };
        }
      }
      try {
        if (!fullSwapSimulation) {
          if (!depositPlan) throw new Error('Deposit-only fallback is unavailable for this wallet inventory');
          if (!preview.swapSimulation) {
            preview.swapSimulation = {
              status: swapQuoteError ? 'quote-unavailable' : swapEnabledForPool ? 'not-required' : 'disabled'
            };
          }
          const previewDepositData = this.fables.encodeDeposit(
            pool,
            { tickLower: Number(position.tickLower), tickUpper: Number(position.tickUpper) },
            depositPlan.liquidity,
            depositPlan.amount0Max,
            depositPlan.amount1Max,
            this.deadline()
          );
          await this.readProvider.call({
            from: this.config.walletAddress,
            to: pool.key.hooks,
            data: previewDepositData,
            value: 0n
          });
          preview.depositSimulation = { status: 'deposit-only-simulated', liquidity: depositPlan.liquidity.toString() };
        }
      } catch (error) {
        const blocked = { ...preview, status: 'blocked', reason: `Top-up preflight simulation failed: ${error.message}` };
        this.ledger.append('rebalance.top_up_dry_run_blocked', blocked);
        return { status: 'blocked', reason: blocked.reason, plan: blocked };
      }
      const dryRun = { ...preview, status: 'dry-run' };
      this.ledger.append('rebalance.top_up_dry_run', dryRun);
      log('info', 'rebalance.top_up_dry_run', {
        poolId: pool.id,
        positionId: position.id,
        swapStatus: dryRun.swapSimulation?.status || null,
        depositStatus: dryRun.depositSimulation?.status || null
      });
      return { status: 'dry-run', plan: dryRun };
    }

    if (this.config.autoTopupEnabled !== true) throw new Error('AUTO_TOPUP_ENABLED is not enabled');
    if (!this.config.enableAutoRedeploy) throw new Error('ENABLE_AUTO_REDEPLOY is not enabled');
    if (!this.signer) throw new Error('PRIVATE_KEY is missing');
    if (this.signer.address.toLowerCase() !== this.config.walletAddress.toLowerCase()) {
      throw new Error('PRIVATE_KEY does not match WALLET_ADDRESS');
    }
    if (this.state?.getSetting('executionPaused', false)) throw new Error('Execution is paused');
    await this.assertGasGuard();
    const reserveWei = BigInt(minGasReserveWei || 0n);
    if (reserveWei <= 0n) throw new Error('A positive top-up native gas reserve is required');

    let executableSwapPlan = null;
    if (swapEnabledForPool
      && swapPlan.direction !== 'none' && swapPlan.direction !== 'not-quoted'
      && optionalSwapDepositPlan) {
      try {
        const proposedApprovals = await this.buildTopUpApprovalRequests(pool, swapPlan, optionalSwapDepositPlan);
        await this.simulateTopUpSequence({
          pool, position, approvalRequests: proposedApprovals,
          swapPlan, depositPlan: optionalSwapDepositPlan
        });
        executableSwapPlan = swapPlan;
        depositPlan = optionalSwapDepositPlan;
        preview.swapSimulation = { status: 'full-sequence-preflighted', priceImpactBps: swapPlan.priceImpactBps };
      } catch (error) {
        preview.swapSimulation = { status: 'blocked; deposit-only fallback', reason: error.message };
      }
    }
    if (!depositPlan) throw new Error('Full swap simulation failed and deposit-only fallback is unavailable');
    preview.depositPlan = serializeDepositPlan(depositPlan);

    let phase = 'prepared';
    let journal = {
      id: `top-up:${Date.now()}:${pool.id}:${position.id}`,
      kind: 'liquidity_top_up',
      phase,
      startedAt: Date.now(),
      poolId: pool.id,
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      position: {
        id: position.id,
        tickLower: Number(position.tickLower),
        tickUpper: Number(position.tickUpper),
        sharesBefore: validation.shares.toString()
      },
      capitalScope: {
        source: 'wallet pair balances only',
        walletBalancesRaw: stringifyRawBalances(initialBalances),
        dustBps: Number(dustBps),
        dustRaw: stringifyRawBalances(dustRaw),
        maxSpendRaw: stringifyRawBalances(funding),
        maxSpendUsd: initialUsd
      },
      swapPolicy: executableSwapPlan ? 'sequentially-simulated-swap' : 'deposit-only',
      tx: { swap: null, deposit: null }
    };
    this.saveJournal(journal);

    try {
      const approvalRequests = await this.buildTopUpApprovalRequests(
        pool,
        executableSwapPlan || { direction: 'none' },
        depositPlan
      );
      const feeOverrides = await this.getPinnedFeeOverrides();
      const maxFeePerGas = feeCap(feeOverrides);
      if (maxFeePerGas <= 0n) throw new Error('Cannot determine a native gas fee for top-up preflight');
      // Some ERC-20s require allowance=0 before a new nonzero approve. Estimating
      // the later approval against today's state would revert before the reset
      // transaction has mined, so reserve conservatively and estimate each
      // transaction only when its turn arrives.
      const approvalGasLimit = TOP_UP_APPROVAL_GAS_RESERVE * BigInt(approvalRequests.length);
      const routerGasLimit = executableSwapPlan ? TOP_UP_SWAP_GAS_LIMIT : 0n;
      const depositGasLimit = TOP_UP_DEPOSIT_GAS_LIMIT;
      await this.assertTopUpGasBudget({
        reserveWei,
        maxFeePerGas,
        futureGasLimit: approvalGasLimit + routerGasLimit + depositGasLimit,
        phase: 'approval-and-execution-preflight'
      });

      for (const request of approvalRequests) {
        await this.sendVerifiedTx({
          label: request.label,
          to: request.tx.to,
          data: request.tx.data,
          value: request.tx.value || 0n,
          feeOverrides
        });
      }
      phase = 'approvals_ready';
      journal = this.patchJournal(journal, {
        phase,
        approvals: approvalRequests.map(({ label }) => ({ label }))
      });
      await this.assertGasGuard(feeOverrides);

      validation = await this.validateTopUpPosition(pool, position, 'top-up-pre-swap');
      const afterApprovals = await this.readRawPairBalances(pool);
      if (afterApprovals.raw0 !== initialBalances.raw0 || afterApprovals.raw1 !== initialBalances.raw1) {
        throw new Error('Pair-token wallet balances changed during top-up approvals; refusing stale plan');
      }
      let postExecutionBalances = afterApprovals;
      if (executableSwapPlan) {
        await this.assertExactHookAllowance(pool.token0, pool.key.hooks, depositPlan.amount0Max);
        await this.assertExactHookAllowance(pool.token1, pool.key.hooks, depositPlan.amount1Max);
        const latestSwapPlan = await this.refreshSingleSwapQuote(
          pool, executableSwapPlan, 'top-up-immediately-before-swap', topUpMaxPriceImpactBps
        );
        if (BigInt(latestSwapPlan.quote.rawAmountIn) !== executableSwapPlan.rawAmountIn
          || BigInt(latestSwapPlan.quote.minRawAmountOut) < BigInt(executableSwapPlan.quote.minRawAmountOut)
          || String(latestSwapPlan.quote.tokenIn).toLowerCase() !== String(executableSwapPlan.quote.tokenIn).toLowerCase()
          || String(latestSwapPlan.quote.tokenOut).toLowerCase() !== String(executableSwapPlan.quote.tokenOut).toLowerCase()) {
          throw new Error('Top-up swap quote worsened or changed route during approvals');
        }
        // This second simulation uses the mined allowances and latest pool
        // state. A failed deposit stops the swap before any pair funds move.
        const sequence = await this.simulateTopUpSequence({
          pool, position, approvalRequests: [], swapPlan: latestSwapPlan, depositPlan
        });
        await this.assertTopUpGasBudget({
          reserveWei,
          maxFeePerGas,
          futureGasLimit: TOP_UP_SWAP_GAS_LIMIT + TOP_UP_DEPOSIT_GAS_LIMIT,
          phase: 'before-swap'
        });
        phase = 'swap_preflighted';
        journal = this.patchJournal(journal, {
          phase,
          swapPlan: serializeSwapPlan(latestSwapPlan),
          sequentialSimulationCalls: sequence.callCount
        });
        const swapReceipt = await this.sendVerifiedTx({
          label: 'v4TopUpSwapExactInputSingle',
          to: sequence.swapRequest.router,
          data: sequence.swapRequest.data,
          value: sequence.swapRequest.value,
          feeOverrides,
          onSent: (hash) => {
            phase = 'swap_sent';
            journal = this.patchJournal(journal, { phase, tx: { ...journal.tx, swap: hash } });
          }
        });
        phase = 'swap_confirmed';
        postExecutionBalances = await this.readRawPairBalances(pool);
        this.assertSwapReceiptBalances(pool, latestSwapPlan, afterApprovals, postExecutionBalances);
        journal = this.patchJournal(journal, {
          phase,
          tx: { ...journal.tx, swap: swapReceipt.hash || journal.tx.swap },
          postSwapBalancesRaw: stringifyRawBalances(postExecutionBalances)
        });
      } else {
        const refreshedDepositPlan = buildExactDepositPlan({
          rawAmount0: funding.raw0,
          rawAmount1: funding.raw1,
          sqrtPriceX96: validation.state.sqrtPriceX96,
          tickLower: Number(position.tickLower),
          tickUpper: Number(position.tickUpper),
          slippageBps: this.config.depositSlippageBps,
          liquidityReserveBps: this.config.depositLiquidityReserveBps
        });
        this.assertValidDeposit(refreshedDepositPlan, 'Refreshed top-up deposit-only liquidity is invalid');
        await this.assertExactHookAllowance(pool.token0, pool.key.hooks, refreshedDepositPlan.amount0Max);
        await this.assertExactHookAllowance(pool.token1, pool.key.hooks, refreshedDepositPlan.amount1Max);
        depositPlan = refreshedDepositPlan;
      }

      validation = await this.validateTopUpPosition(pool, position, 'top-up-pre-deposit');
      const postApprovalBalances = await this.readRawPairBalances(pool);
      if (postApprovalBalances.raw0 !== postExecutionBalances.raw0
        || postApprovalBalances.raw1 !== postExecutionBalances.raw1) {
        throw new Error('Pair-token wallet balances changed before top-up deposit; refusing to spend unplanned funds');
      }
      const actualInventory = {
        raw0: postApprovalBalances.raw0 - dustRaw.raw0,
        raw1: postApprovalBalances.raw1 - dustRaw.raw1
      };
      if (actualInventory.raw0 < 0n || actualInventory.raw1 < 0n) {
        throw new Error('Top-up pair balance fell below the retained dust reserve');
      }
      if (executableSwapPlan) {
        if (BigInt(depositPlan.amount0Max) > actualInventory.raw0
          || BigInt(depositPlan.amount1Max) > actualInventory.raw1) {
          throw new Error('Post-swap inventory is below the sequentially simulated deposit caps');
        }
      } else {
        depositPlan = buildExactDepositPlan({
          rawAmount0: actualInventory.raw0,
          rawAmount1: actualInventory.raw1,
          sqrtPriceX96: validation.state.sqrtPriceX96,
          tickLower: Number(position.tickLower),
          tickUpper: Number(position.tickUpper),
          slippageBps: this.config.depositSlippageBps,
          liquidityReserveBps: this.config.depositLiquidityReserveBps
        });
      }
      this.assertValidDeposit(depositPlan, 'Recomputed top-up deposit liquidity is invalid');
      await this.assertExactHookAllowance(pool.token0, pool.key.hooks, depositPlan.amount0Max);
      await this.assertExactHookAllowance(pool.token1, pool.key.hooks, depositPlan.amount1Max);
      const depositDeadline = this.deadline();
      const depositData = this.fables.encodeDeposit(
        pool,
        { tickLower: Number(position.tickLower), tickUpper: Number(position.tickUpper) },
        depositPlan.liquidity,
        depositPlan.amount0Max,
        depositPlan.amount1Max,
        depositDeadline
      );
      await this.readProvider.call({
        from: this.config.walletAddress,
        to: pool.key.hooks,
        data: depositData,
        value: 0n
      });
      const depositGas = BigInt(await this.signer.estimateGas({
        to: pool.key.hooks,
        data: depositData,
        value: 0n,
        from: this.config.walletAddress,
        ...feeOverrides
      }));
      await this.assertTopUpGasBudget({
        reserveWei,
        maxFeePerGas,
        futureGasLimit: depositGas * 120n / 100n,
        phase: 'before-deposit'
      });
      phase = 'deposit_preflighted';
      journal = this.patchJournal(journal, {
        phase,
        depositPlan: serializeDepositPlan(depositPlan),
        inventoryRaw: stringifyRawBalances(actualInventory),
        finalTarget: { tickLower: Number(position.tickLower), tickUpper: Number(position.tickUpper) }
      });
      const depositReceipt = await this.sendVerifiedTx({
        label: 'fablesTopUpDeposit',
        to: pool.key.hooks,
        data: depositData,
        value: 0n,
        feeOverrides,
        onSent: (hash) => {
          phase = 'deposit_sent';
          journal = this.patchJournal(journal, { phase, tx: { ...journal.tx, deposit: hash } });
        }
      });
      phase = 'deposit_confirmed';
      const depositEvent = this.findWalletDepositEvent(pool, depositReceipt);
      if (!depositEvent || depositEvent.rangeId.toLowerCase() !== position.id.toLowerCase()) {
        throw new Error('Top-up receipt did not increase the identified original range');
      }
      const mintedRange = await this.fables.readRangeKey(pool, depositEvent.rangeId);
      if (
        !mintedRange.exists
        || !samePoolKeyLocal(mintedRange.key, pool.key)
        || Number(mintedRange.tickLower) !== Number(position.tickLower)
        || Number(mintedRange.tickUpper) !== Number(position.tickUpper)
      ) {
        throw new Error('Top-up receipt range does not match the original PoolKey and ticks');
      }
      const sharesAfter = await this.readPositionShares(pool, position.id);
      if (sharesAfter <= validation.shares) throw new Error('Top-up confirmed but original LP shares did not increase');
      const balancesAfterDeposit = await this.readRawPairBalances(pool);
      if (balancesAfterDeposit.raw0 < dustRaw.raw0 || balancesAfterDeposit.raw1 < dustRaw.raw1) {
        throw new Error('Top-up consumed the configured retained dust reserve');
      }
      journal = this.patchJournal(journal, {
        phase: 'completed',
        completedAt: Date.now(),
        tx: { ...journal.tx, deposit: depositReceipt.hash || journal.tx.deposit },
        sharesAfter: sharesAfter.toString(),
        liquidityAdded: depositEvent.liquidity.toString(),
        balancesAfterRaw: stringifyRawBalances(balancesAfterDeposit)
      });
      this.clearJournal();
      const result = {
        status: 'completed',
        poolId: pool.id,
        positionId: position.id,
        swapHash: journal.tx.swap,
        depositHash: journal.tx.deposit,
        sharesBefore: validation.shares.toString(),
        sharesAfter: sharesAfter.toString(),
        liquidityAdded: depositEvent.liquidity.toString(),
        dustRetainedRaw: stringifyRawBalances(dustRaw),
        balancesAfterRaw: stringifyRawBalances(balancesAfterDeposit)
      };
      this.ledger.append('rebalance.top_up_completed', result);
      return result;
    } catch (error) {
      const capitalMayHaveMoved = error.code === 'BROADCAST_OUTCOME_UNCERTAIN' || [
        'swap_sent', 'swap_confirmed', 'deposit_sent', 'deposit_confirmed'
      ].includes(phase);
      if (capitalMayHaveMoved) {
        let balances = null;
        try { balances = stringifyRawBalances(await this.readRawPairBalances(pool)); } catch {}
        journal = this.patchJournal(journal, {
          phase: 'recovery_required',
          failedAt: Date.now(),
          error: error.message,
          currentBalancesRaw: balances
        });
        this.ledger.append('rebalance.recovery_required', jsonSafe(journal));
      } else {
        this.patchJournal(journal, { phase: 'failed', failedAt: Date.now(), error: error.message });
      }
      throw error;
    }
  }

  async validateTopUpPosition(pool, position, phase) {
    if (!Number.isInteger(Number(position.tickLower)) || !Number.isInteger(Number(position.tickUpper))) {
      throw new Error('Top-up position ticks are invalid');
    }
    const state = await this.fables.readPoolState(pool);
    if (state.paused !== false || BigInt(state.liquidity || 0) <= 0n) {
      throw new Error(`Top-up blocked: pool is paused or liquidity is unavailable at ${phase}`);
    }
    if (!isLpInRange(state.tick, Number(position.tickLower), Number(position.tickUpper))) {
      throw new Error(`Top-up blocked: original range is out of range at tick ${state.tick}`);
    }
    const range = await this.fables.readRangeKey(pool, position.id);
    if (
      !range.exists
      || !samePoolKeyLocal(range.key, pool.key)
      || Number(range.tickLower) !== Number(position.tickLower)
      || Number(range.tickUpper) !== Number(position.tickUpper)
    ) {
      throw new Error('Top-up position id does not identify the requested original PoolKey and ticks');
    }
    const shares = await this.readPositionShares(pool, position.id);
    if (shares <= 0n || shares !== BigInt(position.shares)) {
      throw new Error('Top-up position shares are missing or stale');
    }
    return { state, shares };
  }

  assertTokenPrices(pool) {
    for (const token of [pool.token0, pool.token1]) {
      if (!Number.isInteger(Number(token.decimals)) || Number(token.decimals) < 0 || Number(token.decimals) > 36) {
        throw new Error(`Reliable ${token.symbol} decimals are unavailable`);
      }
      const price = Number(this.getUsdPrice?.(token.address));
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Reliable USD price for ${token.symbol} is unavailable`);
      }
    }
  }

  valuePairBalances(pool, balances) {
    const amount0 = Number(formatUnits(BigInt(balances.raw0), Number(pool.token0.decimals)));
    const amount1 = Number(formatUnits(BigInt(balances.raw1), Number(pool.token1.decimals)));
    const value = amount0 * Number(this.getUsdPrice(pool.token0.address))
      + amount1 * Number(this.getUsdPrice(pool.token1.address));
    if (!Number.isFinite(value) || value < 0) throw new Error('Top-up wallet pair USD value is invalid');
    return value;
  }

  assertValidDeposit(plan, message) {
    if (
      !plan
      || BigInt(plan.liquidity) <= 0n
      || BigInt(plan.liquidity) > MAX_UINT128
      || BigInt(plan.amount0Max) > MAX_UINT128
      || BigInt(plan.amount1Max) > MAX_UINT128
    ) throw new Error(message);
  }

  async simulateTopUpSwapPreview({ pool, approvalRequests, swapPlan }) {
    if (!swapPlan?.quote || swapPlan.direction === 'none') {
      throw new Error('A priced swap is required for the post-swap pool preview');
    }
    const swapRequest = this.router.buildV4ExactInputSingle({
      pool, quote: swapPlan.quote, deadline: this.deadline()
    });
    const calls = [
      ...approvalRequests.map(({ tx }) => ({
        to: tx.to, data: tx.data, value: tx.value || 0n,
        gasLimit: Number(TOP_UP_APPROVAL_GAS_RESERVE)
      })),
      {
        to: swapRequest.router, data: swapRequest.data, value: swapRequest.value,
        gasLimit: Number(TOP_UP_SWAP_GAS_LIMIT)
      },
      ...[pool.token0, pool.token1].map((token) => ({
        to: token.address,
        data: erc20Interface.encodeFunctionData('balanceOf', [this.config.walletAddress]),
        value: 0n,
        gasLimit: 100_000
      }))
    ];
    const results = await simulateSequentialCalls(this.writeProvider, {
      walletAddress: this.config.walletAddress,
      chainId: this.config.chainId,
      calls
    });
    const swapResult = results[approvalRequests.length];
    let postSwapState = null;
    for (const entry of swapResult.logs || []) {
      try {
        const parsed = swapEventInterface.parseLog(entry);
        if (String(parsed.args.id).toLowerCase() === pool.id.toLowerCase()) {
          postSwapState = {
            tick: Number(parsed.args.tick),
            sqrtPriceX96: BigInt(parsed.args.sqrtPriceX96)
          };
        }
      } catch {}
    }
    if (!postSwapState || postSwapState.sqrtPriceX96 <= 0n) {
      throw new Error('Simulated V4 swap did not emit the destination pool price');
    }
    const raw0 = BigInt(erc20Interface.decodeFunctionResult('balanceOf', results.at(-2).returnData)[0]);
    const raw1 = BigInt(erc20Interface.decodeFunctionResult('balanceOf', results.at(-1).returnData)[0]);
    return { ...postSwapState, balances: { raw0, raw1 }, callCount: results.length };
  }

  async simulateTopUpSequence({ pool, position, approvalRequests, swapPlan, depositPlan }) {
    if (!swapPlan || swapPlan.direction === 'none' || !swapPlan.quote) {
      throw new Error('A priced swap is required for sequential top-up simulation');
    }
    const deadline = this.deadline();
    const swapRequest = this.router.buildV4ExactInputSingle({
      pool, quote: swapPlan.quote, deadline
    });
    const depositData = this.fables.encodeDeposit(
      pool,
      { tickLower: Number(position.tickLower), tickUpper: Number(position.tickUpper) },
      depositPlan.liquidity,
      depositPlan.amount0Max,
      depositPlan.amount1Max,
      deadline
    );
    const calls = [
      ...approvalRequests.map(({ tx }) => ({
        to: tx.to, data: tx.data, value: tx.value || 0n,
        gasLimit: Number(TOP_UP_APPROVAL_GAS_RESERVE)
      })),
      {
        to: swapRequest.router, data: swapRequest.data, value: swapRequest.value,
        gasLimit: Number(TOP_UP_SWAP_GAS_LIMIT)
      },
      {
        to: pool.key.hooks, data: depositData, value: 0n,
        gasLimit: Number(TOP_UP_DEPOSIT_GAS_LIMIT)
      }
    ];
    const results = await simulateSequentialCalls(this.writeProvider, {
      walletAddress: this.config.walletAddress,
      chainId: this.config.chainId,
      calls
    });
    const depositEvent = this.findWalletDepositEvent(pool, results.at(-1));
    if (!depositEvent || depositEvent.rangeId.toLowerCase() !== position.id.toLowerCase()
      || depositEvent.liquidity <= 0n) {
      throw new Error('Sequential simulation did not mint the identified original LP range');
    }
    return { swapRequest, depositData, depositEvent, callCount: results.length };
  }

  async preflightSamePoolSequence({
    pool, position, guardedData, preBalances, poolState, deadline,
    maxPriceImpactBps
  }) {
    const balanceCalls = [pool.token0, pool.token1].map((token) => ({
      to: token.address,
      data: erc20Interface.encodeFunctionData('balanceOf', [this.config.walletAddress]),
      value: 0n,
      gasLimit: 100_000
    }));
    const withdrawCall = {
      to: this.config.walletAddress, data: guardedData, value: 0n,
      gasLimit: 1_500_000
    };
    const simulationArgs = {
      walletAddress: this.config.walletAddress,
      chainId: this.config.chainId
    };
    const withdrawnSimulation = await simulateSequentialCalls(this.writeProvider, {
      ...simulationArgs, calls: [withdrawCall, ...balanceCalls]
    });
    const postWithdraw = {
      raw0: BigInt(erc20Interface.decodeFunctionResult('balanceOf', withdrawnSimulation[1].returnData)[0]),
      raw1: BigInt(erc20Interface.decodeFunctionResult('balanceOf', withdrawnSimulation[2].returnData)[0])
    };
    const withdrawn = operationDelta(preBalances, postWithdraw);
    if (withdrawn.raw0 < 0n || withdrawn.raw1 < 0n
      || withdrawn.raw0 + withdrawn.raw1 === 0n) {
      throw new Error('Sequential preflight did not return non-negative withdrawn inventory');
    }
    const fundingScope = buildPairFundingScope(
      pool, postWithdraw, this.config.usdgAddress, this.config.autoTopupDustBps ?? 25
    );

    const target = buildTargetRange(
      poolState.tick, pool.key.tickSpacing,
      this.config.tightWidthBps, this.config.rangePreset
    );
    const swapPlan = await buildExactBalancedSwapPlan({
      pool, quoter: this.quoter,
      rawAmount0: fundingScope.funding.raw0,
      rawAmount1: fundingScope.funding.raw1,
      sqrtPriceX96: poolState.sqrtPriceX96,
      tickLower: target.tickLower,
      tickUpper: target.tickUpper,
      slippageBps: this.config.swapSlippageBps,
      maxPriceImpactBps,
      preferRemainderTokenIndex: fundingScope.stableIndex,
      preferredRemainderBps: fundingScope.stableIndex === null ? 0 : Math.min(this.config.autoTopupDustBps ?? 25, 50)
    });
    if (swapPlan.blockedReason) {
      throw new Error(`Sequential preflight cannot swap within price-impact limit: ${swapPlan.blockedReason}`);
    }

    let projected = fundingScope.funding;
    let finalTarget = target;
    let finalSqrtPriceX96 = poolState.sqrtPriceX96;
    let swapRequest = null;
    if (swapPlan.direction !== 'none') {
      swapRequest = this.router.buildV4ExactInputSingle({
        pool, quote: swapPlan.quote, deadline
      });
      const swapApprovals = await this.buildTopUpApprovalRequests(pool, swapPlan, {
        amount0Max: 0n, amount1Max: 0n
      });
      const preview = await simulateSequentialCalls(this.writeProvider, {
        ...simulationArgs,
        calls: [
          ...swapApprovals.map(({ tx }) => ({
            to: tx.to, data: tx.data, value: tx.value || 0n,
            gasLimit: Number(TOP_UP_APPROVAL_GAS_RESERVE)
          })),
          withdrawCall,
          { to: swapRequest.router, data: swapRequest.data,
            value: swapRequest.value, gasLimit: Number(TOP_UP_SWAP_GAS_LIMIT) },
          ...balanceCalls
        ]
      });
      const swapReceipt = preview[swapApprovals.length + 1];
      let swapPrice = null;
      for (const entry of swapReceipt.logs || []) {
        try {
          const event = swapEventInterface.parseLog(entry);
          if (String(event.args.id).toLowerCase() === pool.id.toLowerCase()) {
            swapPrice = {
              tick: Number(event.args.tick),
              sqrtPriceX96: BigInt(event.args.sqrtPriceX96)
            };
          }
        } catch {}
      }
      if (!swapPrice || swapPrice.sqrtPriceX96 <= 0n) {
        throw new Error('Sequential preflight swap did not emit the expected pool price');
      }
      projected = swapPlan.tokenIn === 0
        ? { raw0: fundingScope.funding.raw0 - swapPlan.rawAmountIn,
            raw1: fundingScope.funding.raw1 + BigInt(swapPlan.quote.minRawAmountOut) }
        : { raw0: fundingScope.funding.raw0 + BigInt(swapPlan.quote.minRawAmountOut),
            raw1: fundingScope.funding.raw1 - swapPlan.rawAmountIn };
      const postSwap = {
        raw0: BigInt(erc20Interface.decodeFunctionResult('balanceOf', preview.at(-2).returnData)[0]),
        raw1: BigInt(erc20Interface.decodeFunctionResult('balanceOf', preview.at(-1).returnData)[0])
      };
      const actualInventory = operationDelta(fundingScope.dustRaw, postSwap);
      if (actualInventory.raw0 < projected.raw0 || actualInventory.raw1 < projected.raw1) {
        throw new Error('Sequential preflight swap returned less than conservative minOut inventory');
      }
      finalTarget = buildTargetRange(
        swapPrice.tick, pool.key.tickSpacing,
        this.config.tightWidthBps, this.config.rangePreset
      );
      finalSqrtPriceX96 = swapPrice.sqrtPriceX96;
    }

    const depositPlan = buildExactDepositPlan({
      rawAmount0: projected.raw0,
      rawAmount1: projected.raw1,
      sqrtPriceX96: finalSqrtPriceX96,
      tickLower: finalTarget.tickLower,
      tickUpper: finalTarget.tickUpper,
      slippageBps: this.config.depositSlippageBps,
      liquidityReserveBps: this.config.depositLiquidityReserveBps
    });
    this.assertValidDeposit(depositPlan, 'Sequential preflight deposit plan is invalid');
    const fullApprovals = await this.buildTopUpApprovalRequests(pool, swapPlan, depositPlan);
    const depositData = this.fables.encodeDeposit(
      pool, finalTarget, depositPlan.liquidity,
      depositPlan.amount0Max, depositPlan.amount1Max, deadline
    );
    const fullCalls = [
      ...fullApprovals.map(({ tx }) => ({
        to: tx.to, data: tx.data, value: tx.value || 0n,
        gasLimit: Number(TOP_UP_APPROVAL_GAS_RESERVE)
      })),
      withdrawCall,
      ...(swapRequest ? [{ to: swapRequest.router, data: swapRequest.data,
        value: swapRequest.value, gasLimit: Number(TOP_UP_SWAP_GAS_LIMIT) }] : []),
      { to: pool.key.hooks, data: depositData, value: 0n,
        gasLimit: Number(TOP_UP_DEPOSIT_GAS_LIMIT) }
    ];
    const simulated = await simulateSequentialCalls(this.writeProvider, {
      ...simulationArgs, calls: fullCalls
    });
    const deposited = this.findWalletDepositEvent(pool, simulated.at(-1));
    if (!deposited || deposited.liquidity <= 0n) {
      throw new Error('Sequential preflight did not mint a wallet LP position');
    }
    return {
      status: 'full-sequence-simulated',
      callCount: simulated.length,
      simulatedGasUsed: simulated.reduce(
        (total, receipt) => total + BigInt(receipt.gasUsed || 0), 0n
      ).toString(),
      swapPriceImpactBps: swapPlan.priceImpactBps ?? null,
      finalTarget,
      mintedLiquidity: deposited.liquidity.toString()
    };
  }

  async buildTopUpApprovalRequests(pool, swapPlan, depositPlan) {
    const requests = [];
    const swapAmountByAddress = new Map();
    if (swapPlan.direction !== 'none') {
      const tokenIn = swapPlan.tokenIn === 0 ? pool.token0 : pool.token1;
      swapAmountByAddress.set(tokenIn.address.toLowerCase(), BigInt(swapPlan.rawAmountIn));
    }
    const now = Math.floor(Date.now() / 1000);
    const add = (label, to, data) => requests.push({
      label,
      tx: { to, data, value: 0n, from: this.config.walletAddress }
    });

    for (const [index, token] of [pool.token0, pool.token1].entries()) {
      const address = token.address.toLowerCase();
      const swapAmount = swapAmountByAddress.get(address) || 0n;
      if (swapAmount > 0n) {
        const tokenContract = new Contract(token.address, ERC20_ABI, this.readProvider);
        const erc20Allowance = BigInt(await tokenContract.allowance(this.config.walletAddress, PERMIT2));
        if (erc20Allowance !== swapAmount
          && !(await this.hasFixedInfinitePermit2Allowance(token, erc20Allowance))) {
          if (erc20Allowance > 0n) add(`approve:${token.symbol}:permit2:reset`, token.address, erc20Interface.encodeFunctionData('approve', [PERMIT2, 0n]));
          add(`approve:${token.symbol}:permit2`, token.address, erc20Interface.encodeFunctionData('approve', [PERMIT2, swapAmount]));
        }
        const permit2 = new Contract(PERMIT2, PERMIT2_ABI, this.readProvider);
        const allowance = await permit2.allowance(this.config.walletAddress, token.address, UNISWAP_UNIVERSAL_ROUTER_212);
        if (BigInt(allowance.amount) !== swapAmount || Number(allowance.expiration) <= now + this.config.txDeadlineSec) {
          const expiration = now + this.config.permit2ExpirationSec;
          if (BigInt(allowance.amount) > 0n) {
            add(`permit2:${token.symbol}:router:reset`, PERMIT2, permit2Interface.encodeFunctionData('approve', [
              token.address,
              UNISWAP_UNIVERSAL_ROUTER_212,
              0n,
              expiration
            ]));
          }
          add(`permit2:${token.symbol}:router`, PERMIT2, permit2Interface.encodeFunctionData('approve', [
            token.address,
            UNISWAP_UNIVERSAL_ROUTER_212,
            swapAmount,
            expiration
          ]));
        }
      }

      const depositAmount = index === 0 ? BigInt(depositPlan.amount0Max) : BigInt(depositPlan.amount1Max);
      if (depositAmount > 0n) {
        const tokenContract = new Contract(token.address, ERC20_ABI, this.readProvider);
        const allowance = BigInt(await tokenContract.allowance(this.config.walletAddress, pool.key.hooks));
        if (allowance !== depositAmount) {
          if (allowance > 0n) add(`approve:${token.symbol}:hook:reset`, token.address, erc20Interface.encodeFunctionData('approve', [pool.key.hooks, 0n]));
          add(`approve:${token.symbol}:hook`, token.address, erc20Interface.encodeFunctionData('approve', [pool.key.hooks, depositAmount]));
        }
      }
    }
    return requests;
  }

  async assertTopUpGasBudget({ reserveWei, maxFeePerGas, futureGasLimit, phase }) {
    reserveWei = BigInt(reserveWei);
    maxFeePerGas = BigInt(maxFeePerGas);
    futureGasLimit = BigInt(futureGasLimit);
    if (reserveWei <= 0n || maxFeePerGas <= 0n || futureGasLimit < 0n) {
      throw new Error('Top-up gas reserve inputs are invalid');
    }
    const nativeBalance = BigInt(await this.readProvider.getBalance(this.config.walletAddress));
    const estimatedCost = futureGasLimit * maxFeePerGas;
    if (nativeBalance < estimatedCost + reserveWei) {
      throw new Error(
        `Top-up gas reserve is insufficient at ${phase}: wallet ${nativeBalance}, `
        + `estimated future fees ${estimatedCost}, required reserve ${reserveWei}`
      );
    }
    return { nativeBalance, estimatedCost, reserveWei };
  }

  async previewCrossPoolExecution(plan, destinationPool) {
    const sourcePool = plan.pool;
    const routePools = plan.routingPools || [sourcePool, destinationPool];
    let trackedTokens = [];
    try {
      const sourceState = await this.assertPlanStillOutOfRange(plan, 'cross-pool-dry-run');
      const destinationState = await this.fables.readPoolState(destinationPool);
      if (destinationState.paused !== false || destinationState.liquidity <= 0n) {
        throw new Error('Destination pool is paused or has no active liquidity');
      }
      if ([sourcePool, destinationPool].some((pool) =>
        pool.token0.address.toLowerCase() === ZERO_ADDRESS || pool.token1.address.toLowerCase() === ZERO_ADDRESS
      )) throw new Error('Cross-pool preview does not support native-token pools');

      trackedTokens = uniquePairTokens(sourcePool, destinationPool);
      const beforeBalances = await this.readRawTokenBalances(trackedTokens);
      const withdrawBounds = buildExactWithdrawBounds({
        sqrtPriceX96: sourceState.sqrtPriceX96,
        tickLower: plan.position.tickLower,
        tickUpper: plan.position.tickUpper,
        liquidity: plan.position.shares,
        slippageBps: this.config.withdrawSlippageBps
      });
      const dustRawByAddress = plan.dustRawByAddress || {};
      const fundingScope = buildCrossPoolFundingScope({
        sourcePool,
        destinationPool,
        walletBalances: beforeBalances,
        expectedWithdraw: withdrawBounds,
        dustRawByAddress
      });
      const destinationAddresses = new Set([destinationPool.token0.address.toLowerCase(), destinationPool.token1.address.toLowerCase()]);
      const conversionAssets = fundingScope.filter((entry) =>
        [sourcePool.token0.address.toLowerCase(), sourcePool.token1.address.toLowerCase()].includes(entry.address)
        && !destinationAddresses.has(entry.address)
        && entry.maxSpendRaw > 0n
      );
      const anchorPlan = conversionAssets.length
        ? chooseInvestmentAnchor(conversionAssets.map((entry) => entry.token), destinationPool, routePools, 1)
        : { anchor: destinationPool.token0, routes: new Map(), score: 0 };
      const projectedInventory = new Map(fundingScope.map((entry) => [entry.address, entry.maxSpendRaw]));
      const routePreflight = [];
      for (const entry of conversionAssets) {
        const route = anchorPlan.routes.get(entry.address);
        const quote = await this.quoteDirectRoute(route, entry.token, entry.maxSpendRaw);
        let simulation = { status: 'capital-locked-until-withdraw' };
        const walletRaw = beforeBalances.get(entry.address) || 0n;
        const simAmount = walletRaw > entry.dustRaw ? walletRaw - entry.dustRaw : 0n;
        if (simAmount > 0n) {
          const simQuote = simAmount === entry.maxSpendRaw
            ? quote
            : await this.quoteDirectRoute(route, entry.token, simAmount);
          try {
            const request = this.router.buildV4ExactInputSingle({ pool: route[0], quote: simQuote, deadline: this.deadline() });
            await this.router.simulateV4ExactInputSingle({ pool: route[0], quote: simQuote, deadline: request.deadline, from: this.config.walletAddress });
            simulation = { status: 'simulated', amountInRaw: simAmount.toString() };
          } catch (error) {
            simulation = { status: 'failed', amountInRaw: simAmount.toString(), error: error.message };
          }
        }
        routePreflight.push({
          token: entry.token.address,
          walletRaw: entry.walletRaw.toString(),
          expectedWithdrawRaw: entry.withdrawRaw.toString(),
          dustRaw: entry.dustRaw.toString(),
          maxSpendRaw: entry.maxSpendRaw.toString(),
          tokenOut: quote.tokenOut,
          rawAmountOut: quote.rawAmountOut,
          minRawAmountOut: quote.minRawAmountOut,
          poolIds: route.map((pool) => pool.id),
          routerSimulation: simulation
        });
        const anchorAddress = anchorPlan.anchor.address.toLowerCase();
        projectedInventory.set(entry.address, 0n);
        projectedInventory.set(anchorAddress, (projectedInventory.get(anchorAddress) || 0n) + BigInt(quote.minRawAmountOut));
      }

      let destinationBalances = {
        raw0: projectedInventory.get(destinationPool.token0.address.toLowerCase()) || 0n,
        raw1: projectedInventory.get(destinationPool.token1.address.toLowerCase()) || 0n
      };
      const targetRange = buildTargetRange(
        destinationState.tick,
        destinationPool.key.tickSpacing,
        this.config.tightWidthBps,
        this.config.rangePreset
      );
      let balancePlan = await buildExactBalancedSwapPlan({
        pool: destinationPool,
        quoter: this.quoter,
        rawAmount0: destinationBalances.raw0,
        rawAmount1: destinationBalances.raw1,
        sqrtPriceX96: destinationState.sqrtPriceX96,
        tickLower: targetRange.tickLower,
        tickUpper: targetRange.tickUpper,
        slippageBps: this.config.swapSlippageBps,
        maxPriceImpactBps: this.config.maxSwapPriceImpactBps ?? 200
      });
      let balanceSimulation = { status: 'not-required' };
      if (balancePlan.direction !== 'none') {
        const request = this.router.buildV4ExactInputSingle({ pool: destinationPool, quote: balancePlan.quote, deadline: this.deadline() });
        const inputAddress = balancePlan.tokenIn === 0 ? destinationPool.token0.address.toLowerCase() : destinationPool.token1.address.toLowerCase();
        const walletRaw = beforeBalances.get(inputAddress) || 0n;
        const scopedRaw = balancePlan.tokenIn === 0 ? destinationBalances.raw0 : destinationBalances.raw1;
        if (walletRaw >= scopedRaw && scopedRaw > 0n) {
          try {
            await this.router.simulateV4ExactInputSingle({ pool: destinationPool, quote: balancePlan.quote, deadline: request.deadline, from: this.config.walletAddress });
            balanceSimulation = { status: 'simulated', amountInRaw: balancePlan.rawAmountIn.toString() };
          } catch (error) {
            balanceSimulation = { status: 'failed', amountInRaw: balancePlan.rawAmountIn.toString(), error: error.message };
          }
        } else {
          balanceSimulation = { status: 'capital-locked-until-withdraw' };
        }
        const output = BigInt(balancePlan.quote.minRawAmountOut);
        if (balancePlan.tokenIn === 0) destinationBalances = { raw0: destinationBalances.raw0 - balancePlan.rawAmountIn, raw1: destinationBalances.raw1 + output };
        else destinationBalances = { raw0: destinationBalances.raw0 + output, raw1: destinationBalances.raw1 - balancePlan.rawAmountIn };
      }
      const depositPlan = buildExactDepositPlan({
        rawAmount0: destinationBalances.raw0,
        rawAmount1: destinationBalances.raw1,
        sqrtPriceX96: destinationState.sqrtPriceX96,
        tickLower: targetRange.tickLower,
        tickUpper: targetRange.tickUpper,
        slippageBps: this.config.depositSlippageBps,
        liquidityReserveBps: this.config.depositLiquidityReserveBps
      });
      this.assertValidDeposit(depositPlan, 'Cross-pool dry-run deposit liquidity is invalid');
      const output = {
        status: 'dry-run',
        sourcePoolId: sourcePool.id,
        sourcePair: `${sourcePool.token0.symbol}/${sourcePool.token1.symbol}`,
        destinationPoolId: destinationPool.id,
        destinationPair: `${destinationPool.token0.symbol}/${destinationPool.token1.symbol}`,
        positionId: plan.position.id,
        capitalScope: {
          policy: 'source-and-destination-pair-wallet-balances plus source-withdrawal-delta',
          tokens: fundingScope.map((entry) => ({
            address: entry.address,
            symbol: entry.token.symbol,
            walletSource: entry.walletSource,
            walletRaw: entry.walletRaw.toString(),
            expectedWithdrawRaw: entry.withdrawRaw.toString(),
            dustRaw: entry.dustRaw.toString(),
            maxSpendRaw: entry.maxSpendRaw.toString()
          }))
        },
        anchor: { address: anchorPlan.anchor.address, symbol: anchorPlan.anchor.symbol },
        routes: routePreflight,
        balanceSwap: balancePlan.direction === 'none' ? null : {
          plan: serializeSwapPlan(balancePlan),
          routerSimulation: balanceSimulation
        },
        targetRange,
        destinationInventoryRaw: stringifyRawBalances(destinationBalances),
        depositPlan: serializeDepositPlan(depositPlan),
        preflight: {
          sourceOutOfRange: true,
          destinationActive: true,
          multiHopEnabled: false
        }
      };
      this.ledger.append('rebalance.cross_pool_dry_run', output);
      log('info', 'rebalance.cross_pool_dry_run', output);
      return { status: 'dry-run', plan: output };
    } catch (error) {
      const blocked = {
        status: 'blocked',
        sourcePoolId: sourcePool.id,
        destinationPoolId: destinationPool.id,
        positionId: plan.position.id,
        capitalScope: 'source-and-destination-pair-wallet-balances plus source-withdrawal-delta',
        reason: error.message
      };
      this.ledger.append('rebalance.cross_pool_dry_run_blocked', blocked);
      return { status: 'blocked', reason: error.message, plan: blocked };
    }
  }

  async quoteDirectRoute(route, tokenIn, amountIn) {
    if (!Array.isArray(route) || route.length !== 1) {
      throw new Error('Multi-hop reinvestment is disabled until Universal Router calldata has independent evidence');
    }
    const routePool = route[0];
    amountIn = BigInt(amountIn);
    if (amountIn <= 0n || amountIn > MAX_UINT128) {
      throw new Error('Direct route amount is outside the router uint128 input bounds');
    }
    const address = tokenIn.address.toLowerCase();
    const token0 = routePool.token0.address.toLowerCase();
    const token1 = routePool.token1.address.toLowerCase();
    if (address !== token0 && address !== token1) throw new Error('Direct route token is not in the selected pool');
    const state = await this.fables.readPoolState(routePool);
    if (state.paused !== false || BigInt(state.liquidity || 0) <= 0n) {
      throw new Error('Direct route pool is paused or has no active liquidity');
    }
    const quote = await this.quoter.quoteExactInputSingleRaw(routePool, address === token0 ? 0 : 1, amountIn, this.config.swapSlippageBps);
    if (BigInt(quote.rawAmountIn) !== BigInt(amountIn) || BigInt(quote.minRawAmountOut) <= 0n) {
      throw new Error('Direct route quote is invalid or has zero minimum output');
    }
    const impactBps = this.assertQuotePriceImpact(routePool, quote, BigInt(amountIn), state);
    return { ...quote, priceImpactBps: Number(impactBps) };
  }

  assertQuotePriceImpact(pool, quote, rawAmountIn, state, maxOverrideBps = null) {
    const inputAddress = String(quote.tokenIn || '').toLowerCase();
    const tokenInIndex = inputAddress === String(pool.token0.address).toLowerCase()
      ? 0
      : inputAddress === String(pool.token1.address).toLowerCase()
        ? 1
        : -1;
    if (tokenInIndex < 0) throw new Error('Swap quote input token does not belong to the quoted pool');
    const impactBps = quotePriceImpactBps(rawAmountIn, BigInt(quote.rawAmountOut), tokenInIndex, state.sqrtPriceX96);
    const maxImpactBps = BigInt(maxOverrideBps ?? this.config.maxSwapPriceImpactBps ?? 200);
    if (impactBps > maxImpactBps) {
      throw new Error(`Swap price impact ${impactBps} bps exceeds ${maxImpactBps} bps`);
    }
    return impactBps;
  }

  async quoteCrossPoolRoute(route, tokenIn, amountIn, maxImpactBps, withdrawCall = null) {
    if (!Array.isArray(route) || !route.length || route.length > 3) {
      throw new Error('Cross-pool route must contain 1..3 active Fables pools');
    }
    amountIn = BigInt(amountIn);
    if (amountIn <= 0n || amountIn > MAX_UINT128) throw new Error('Cross-pool route input is outside uint128 bounds');
    let cursor = tokenIn.address.toLowerCase();
    let spotOutput = amountIn;
    const q192 = 1n << 192n;
    for (const pool of route) {
      if (pool.token0.address.toLowerCase() === ZERO_ADDRESS || pool.token1.address.toLowerCase() === ZERO_ADDRESS) {
        throw new Error('Native-token cross-pool route is not enabled');
      }
      const state = await this.fables.readPoolState(pool);
      if (state.paused !== false || BigInt(state.liquidity || 0) <= 0n) {
        throw new Error('Cross-pool route contains a paused or empty pool');
      }
      const zeroForOne = cursor === pool.token0.address.toLowerCase();
      if (!zeroForOne && cursor !== pool.token1.address.toLowerCase()) {
        throw new Error('Cross-pool route token order is discontinuous');
      }
      const squared = BigInt(state.sqrtPriceX96) ** 2n;
      spotOutput = zeroForOne ? spotOutput * squared / q192 : spotOutput * q192 / squared;
      cursor = (zeroForOne ? pool.token1 : pool.token0).address.toLowerCase();
    }
    if (spotOutput <= 0n) throw new Error('Cross-pool route spot output rounds to zero');
    // If this path uses the source pool, quote against the state *after* the
    // guarded withdrawal. A pre-withdrawal quote can materially understate
    // impact because withdrawing the LP also removes its active liquidity.
    const quoteProvider = withdrawCall ? {
      call: async ({ to, data }) => {
        const receipts = await simulateSequentialCalls(this.writeProvider, {
          walletAddress: this.config.walletAddress,
          chainId: this.config.chainId,
          calls: [withdrawCall, { to, data, value: 0n, gasLimit: 3_000_000 }]
        });
        return receipts[1].returnData;
      }
    } : null;
    const quoter = quoteProvider ? new V4QuoterAdapter(quoteProvider, this.quoter.address) : this.quoter;
    const quote = route.length === 1
      ? await quoter.quoteExactInputSingleRaw(route[0],
        tokenIn.address.toLowerCase() === route[0].token0.address.toLowerCase() ? 0 : 1,
        amountIn, this.config.swapSlippageBps)
      : await quoter.quoteExactInputPathRaw(route, tokenIn, amountIn, this.config.swapSlippageBps);
    if (BigInt(quote.rawAmountIn) !== amountIn || BigInt(quote.minRawAmountOut) <= 0n
      || quote.tokenOut.toLowerCase() !== cursor) {
      throw new Error('Cross-pool route quote amount or output does not match the selected path');
    }
    const amountOut = BigInt(quote.rawAmountOut);
    const impactBps = amountOut >= spotOutput ? 0n : (spotOutput - amountOut) * 10_000n / spotOutput;
    if (impactBps > BigInt(maxImpactBps)) {
      throw new Error(`Cross-pool route cost ${impactBps} bps exceeds ${maxImpactBps} bps`);
    }
    const request = route.length === 1
      ? this.router.buildV4ExactInputSingle({ pool: route[0], quote, deadline: this.deadline() })
      : this.router.buildV4ExactInputPath({ route, tokenIn, quote, deadline: this.deadline() });
    return { route, tokenIn, quote, request, impactBps: Number(impactBps), rawAmountIn: amountIn };
  }

  async preflightCrossPoolSequence(plan, destinationPool) {
    const sourcePool = plan.pool;
    const sourceState = await this.assertPlanStillOutOfRange(plan, 'cross-pool-sequence-preflight');
    const destinationState = await this.fables.readPoolState(destinationPool);
    if (destinationState.paused !== false || BigInt(destinationState.liquidity || 0) <= 0n) {
      throw new Error('Destination pool is paused or empty');
    }
    const trackedTokens = uniquePairTokens(sourcePool, destinationPool);
    if (trackedTokens.some((token) => token.address.toLowerCase() === ZERO_ADDRESS)) {
      throw new Error('Native-token cross-pool execution is not enabled');
    }
    const before = await this.readRawTokenBalances(trackedTokens);
    const balanceCall = (token) => ({
      to: token.address,
      data: erc20Interface.encodeFunctionData('balanceOf', [this.config.walletAddress]),
      value: 0n, gasLimit: 100_000
    });
    const deadline = this.deadline();
    const bounds = buildExactWithdrawBounds({
      sqrtPriceX96: sourceState.sqrtPriceX96,
      tickLower: plan.position.tickLower,
      tickUpper: plan.position.tickUpper,
      liquidity: BigInt(plan.position.shares),
      slippageBps: this.config.withdrawSlippageBps
    });
    const guardedData = guardInterface.encodeFunctionData('guardedWithdrawAndClaim', [[
      sourcePool.key.currency0, sourcePool.key.currency1, sourcePool.key.fee,
      sourcePool.key.tickSpacing, sourcePool.key.hooks
    ], plan.position.tickLower, plan.position.tickUpper, BigInt(plan.position.shares),
    this.config.walletAddress, bounds.amount0Min, bounds.amount1Min,
    BigInt(deadline), this.config.fablesWalk]);
    const withdrawCall = { to: this.config.walletAddress, data: guardedData, value: 0n, gasLimit: 1_500_000 };
    const simulationArgs = { walletAddress: this.config.walletAddress, chainId: this.config.chainId };
    const withdrawnSimulation = await simulateSequentialCalls(this.writeProvider, {
      ...simulationArgs, calls: [withdrawCall, ...trackedTokens.map(balanceCall)]
    });
    const postWithdraw = new Map(trackedTokens.map((token, index) => [
      token.address.toLowerCase(),
      BigInt(erc20Interface.decodeFunctionResult('balanceOf', withdrawnSimulation[index + 1].returnData)[0])
    ]));
    const sourceAddresses = [sourcePool.token0.address.toLowerCase(), sourcePool.token1.address.toLowerCase()];
    const withdrawn = sourceAddresses.map((address) => (postWithdraw.get(address) || 0n) - (before.get(address) || 0n));
    if (withdrawn.some((value) => value < 0n) || withdrawn.every((value) => value === 0n)) {
      throw new Error('Cross-pool preflight did not return non-negative LP inventory');
    }
    const dustRawByAddress = Object.fromEntries(trackedTokens.map((token) => {
      const address = token.address.toLowerCase();
      const reserveBps = address === this.config.usdgAddress.toLowerCase()
        ? BigInt(this.config.autoTopupDustBps ?? 25) : 0n;
      return [address, (postWithdraw.get(address) || 0n) * reserveBps / 10_000n];
    }));
    const funding = buildCrossPoolFundingScope({
      sourcePool, destinationPool, walletBalances: before,
      expectedWithdraw: { raw0: withdrawn[0], raw1: withdrawn[1] }, dustRawByAddress
    });
    const destinationAddresses = new Set([
      destinationPool.token0.address.toLowerCase(), destinationPool.token1.address.toLowerCase()
    ]);
    const conversionAssets = funding.filter((entry) =>
      sourceAddresses.includes(entry.address) && !destinationAddresses.has(entry.address)
      && entry.maxSpendRaw > 0n);
    const anchor = conversionAssets.length
      ? chooseInvestmentAnchor(conversionAssets.map((entry) => entry.token),
        destinationPool, (plan.routingPools || []).filter((pool) =>
          pool.id.toLowerCase() !== destinationPool.id.toLowerCase()
          && pool.token0.address.toLowerCase() !== ZERO_ADDRESS
          && pool.token1.address.toLowerCase() !== ZERO_ADDRESS), 3)
      : { anchor: destinationPool.token0, routes: new Map() };
    const maxImpactBps = this.config.crossPoolMaxSwapPriceImpactBps ?? 350;
    const projected = new Map(funding.map((entry) => [entry.address, entry.maxSpendRaw]));
    const routeSwaps = [];
    for (const entry of conversionAssets) {
      const route = anchor.routes.get(entry.address);
      const routeUsesSource = route.some((pool) => pool.id.toLowerCase() === sourcePool.id.toLowerCase());
      const swap = await this.quoteCrossPoolRoute(route, entry.token, entry.maxSpendRaw,
        maxImpactBps, routeUsesSource ? withdrawCall : null);
      if (swap.quote.tokenOut.toLowerCase() !== anchor.anchor.address.toLowerCase()) {
        throw new Error('Cross-pool route quote does not reach the chosen anchor');
      }
      routeSwaps.push(swap);
      projected.set(entry.address, 0n);
      const anchorAddress = anchor.anchor.address.toLowerCase();
      projected.set(anchorAddress, (projected.get(anchorAddress) || 0n) + BigInt(swap.quote.minRawAmountOut));
    }
    const destinationInventory = {
      raw0: projected.get(destinationPool.token0.address.toLowerCase()) || 0n,
      raw1: projected.get(destinationPool.token1.address.toLowerCase()) || 0n
    };
    const initialTarget = buildTargetRange(destinationState.tick, destinationPool.key.tickSpacing,
      this.config.tightWidthBps, this.config.rangePreset);
    const balancePlan = await buildExactBalancedSwapPlan({
      pool: destinationPool, quoter: this.quoter,
      rawAmount0: destinationInventory.raw0, rawAmount1: destinationInventory.raw1,
      sqrtPriceX96: destinationState.sqrtPriceX96,
      tickLower: initialTarget.tickLower, tickUpper: initialTarget.tickUpper,
      slippageBps: this.config.swapSlippageBps, maxPriceImpactBps: maxImpactBps,
      preferRemainderTokenIndex: destinationPool.token0.address.toLowerCase() === this.config.usdgAddress.toLowerCase()
        ? 0 : destinationPool.token1.address.toLowerCase() === this.config.usdgAddress.toLowerCase() ? 1 : null,
      preferredRemainderBps: this.config.autoTopupDustBps ?? 25
    });
    if (balancePlan.blockedReason) throw new Error(`Cross-pool balance quote is blocked: ${balancePlan.blockedReason}`);
    const usdValue = (token, raw) => {
      const price = Number(this.getUsdPrice?.(token.address));
      const value = Number(formatUnits(BigInt(raw), token.decimals)) * price;
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Cross-pool USD valuation is unavailable for ${token.symbol}`);
      }
      return value;
    };
    const portfolioUsd = funding.filter((entry) => entry.maxSpendRaw > 0n)
      .reduce((sum, entry) => sum + usdValue(entry.token, entry.maxSpendRaw), 0);
    const costLegs = routeSwaps.map((swap) => ({
      inputUsd: usdValue(swap.tokenIn, swap.rawAmountIn), impactBps: swap.impactBps
    }));
    if (balancePlan.direction !== 'none') {
      const inputToken = balancePlan.tokenIn === 0 ? destinationPool.token0 : destinationPool.token1;
      costLegs.push({ inputUsd: usdValue(inputToken, balancePlan.rawAmountIn),
        impactBps: balancePlan.priceImpactBps });
    }
    // Each leg is weighted by the share of the complete redeployed wallet
    // inventory it trades. Add the configured minOut slippage on each leg so
    // the ceiling bounds the worst permitted whole-wallet conversion loss.
    const totalImpactBps = assertCrossPoolWeightedQuoteCost(costLegs,
      portfolioUsd, maxImpactBps, this.config.swapSlippageBps);
    const balanceSwap = balancePlan.direction === 'none' ? null : {
      plan: balancePlan,
      request: this.router.buildV4ExactInputSingle({ pool: destinationPool, quote: balancePlan.quote, deadline })
    };
    const projectedAfterSwaps = { ...destinationInventory };
    if (balanceSwap) {
      if (balancePlan.tokenIn === 0) {
        projectedAfterSwaps.raw0 -= balancePlan.rawAmountIn;
        projectedAfterSwaps.raw1 += BigInt(balancePlan.quote.minRawAmountOut);
      } else {
        projectedAfterSwaps.raw1 -= balancePlan.rawAmountIn;
        projectedAfterSwaps.raw0 += BigInt(balancePlan.quote.minRawAmountOut);
      }
    }
    const zeroDeposit = { amount0Max: 0n, amount1Max: 0n };
    const swapApprovals = [];
    for (const swap of routeSwaps) {
      const firstPool = swap.route[0];
      const tokenInIndex = firstPool.token0.address.toLowerCase() === swap.tokenIn.address.toLowerCase() ? 0 : 1;
      swapApprovals.push(...await this.buildTopUpApprovalRequests(firstPool,
        { direction: 'route', tokenIn: tokenInIndex, rawAmountIn: swap.rawAmountIn }, zeroDeposit));
    }
    if (balanceSwap) swapApprovals.push(...await this.buildTopUpApprovalRequests(
      destinationPool, balancePlan, zeroDeposit));
    const swapCalls = [
      ...routeSwaps.map((swap) => ({ to: swap.request.router, data: swap.request.data,
        value: swap.request.value, gasLimit: Number(TOP_UP_SWAP_GAS_LIMIT) })),
      ...(balanceSwap ? [{ to: balanceSwap.request.router, data: balanceSwap.request.data,
        value: balanceSwap.request.value, gasLimit: Number(TOP_UP_SWAP_GAS_LIMIT) }] : [])
    ];
    const toSimulationCall = ({ tx }) => ({ to: tx.to, data: tx.data,
      value: tx.value || 0n, gasLimit: Number(TOP_UP_APPROVAL_GAS_RESERVE) });
    const swapSimulation = await simulateSequentialCalls(this.writeProvider, {
      ...simulationArgs,
      calls: [...swapApprovals.map(toSimulationCall), withdrawCall, ...swapCalls,
        balanceCall(destinationPool.token0), balanceCall(destinationPool.token1)]
    });
    const simulatedRaw0 = BigInt(erc20Interface.decodeFunctionResult('balanceOf', swapSimulation.at(-2).returnData)[0]);
    const simulatedRaw1 = BigInt(erc20Interface.decodeFunctionResult('balanceOf', swapSimulation.at(-1).returnData)[0]);
    if (simulatedRaw0 - (dustRawByAddress[destinationPool.token0.address.toLowerCase()] || 0n) < projectedAfterSwaps.raw0
      || simulatedRaw1 - (dustRawByAddress[destinationPool.token1.address.toLowerCase()] || 0n) < projectedAfterSwaps.raw1) {
      throw new Error('Cross-pool simulated swap inventory is below the conservative minOut inventory');
    }
    let finalPrice = { tick: destinationState.tick, sqrtPriceX96: destinationState.sqrtPriceX96 };
    for (const receipt of swapSimulation) for (const logEntry of receipt.logs || []) {
      try {
        const event = swapEventInterface.parseLog(logEntry);
        if (String(event.args.id).toLowerCase() === destinationPool.id.toLowerCase()) {
          finalPrice = { tick: Number(event.args.tick), sqrtPriceX96: BigInt(event.args.sqrtPriceX96) };
        }
      } catch {}
    }
    const finalTarget = buildTargetRange(finalPrice.tick, destinationPool.key.tickSpacing,
      this.config.tightWidthBps, this.config.rangePreset);
    const depositPlan = buildExactDepositPlan({
      rawAmount0: projectedAfterSwaps.raw0, rawAmount1: projectedAfterSwaps.raw1,
      sqrtPriceX96: finalPrice.sqrtPriceX96,
      tickLower: finalTarget.tickLower, tickUpper: finalTarget.tickUpper,
      slippageBps: this.config.depositSlippageBps,
      liquidityReserveBps: this.config.depositLiquidityReserveBps
    });
    this.assertValidDeposit(depositPlan, 'Cross-pool sequence deposit plan is invalid');
    const depositApprovals = await this.buildTopUpApprovalRequests(destinationPool,
      { direction: 'none' }, depositPlan);
    const depositData = this.fables.encodeDeposit(destinationPool, finalTarget,
      depositPlan.liquidity, depositPlan.amount0Max, depositPlan.amount1Max, deadline);
    const fullSimulation = await simulateSequentialCalls(this.writeProvider, {
      ...simulationArgs,
      calls: [...swapApprovals.map(toSimulationCall), ...depositApprovals.map(toSimulationCall),
        withdrawCall, ...swapCalls,
        { to: destinationPool.key.hooks, data: depositData, value: 0n,
          gasLimit: Number(TOP_UP_DEPOSIT_GAS_LIMIT) }]
    });
    const deposited = this.findWalletDepositEvent(destinationPool, fullSimulation.at(-1));
    if (!deposited || deposited.liquidity <= 0n) {
      throw new Error('Full cross-pool sequence did not mint a destination LP position');
    }
    return {
      status: 'full-sequence-simulated', sourcePoolId: sourcePool.id, destinationPoolId: destinationPool.id,
      positionId: plan.position.id, guardedData, before, postWithdraw, funding,
      routeSwaps, balanceSwap, depositPlan, finalTarget, deadline,
      simulatedGasUsed: fullSimulation.reduce((total, receipt) =>
        total + BigInt(receipt.gasUsed || 0), 0n).toString(),
      simulatedCallCount: fullSimulation.length,
      pendingApprovalCount: swapApprovals.length + depositApprovals.length,
      routeImpactBps: routeSwaps.map((swap) => swap.impactBps),
      balanceImpactBps: balancePlan.priceImpactBps ?? null,
      totalImpactBps,
      mintedLiquidity: deposited.liquidity.toString()
    };
  }

  samePoolRebalanceMaxImpactBps(pool) {
    const defaultLimit = this.config.maxSwapPriceImpactBps ?? 200;
    const scopedPoolId = String(this.config.oorRebalanceSwapPoolId || '').toLowerCase();
    return scopedPoolId && scopedPoolId === String(pool.id).toLowerCase()
      ? this.config.oorRebalanceMaxSwapPriceImpactBps ?? defaultLimit
      : defaultLimit;
  }

  async refreshSingleSwapQuote(pool, swapPlan, phase, maxOverrideBps = null) {
    const state = await this.fables.readPoolState(pool);
    if (state.paused !== false || BigInt(state.liquidity || 0) <= 0n) {
      throw new Error(`Swap pool is paused or illiquid at ${phase}`);
    }
    const quote = await this.quoter.quoteExactInputSingleRaw(
      pool,
      swapPlan.tokenIn,
      swapPlan.rawAmountIn,
      this.config.swapSlippageBps
    );
    const impactBps = this.assertQuotePriceImpact(pool, quote, swapPlan.rawAmountIn, state, maxOverrideBps);
    return { ...swapPlan, quote: { ...quote, priceImpactBps: Number(impactBps) }, priceImpactBps: Number(impactBps), poolState: state };
  }

  async executeCrossPool(plan, destinationPool) {
    if (this.config.dryRun || !this.config.enableLiveWrites) {
      return this.previewCrossPoolExecution(plan, destinationPool);
    }
    await this.assertLiveReady(plan);
    this.assertNoUnfinishedExecution();
    let phase = 'prepared';
    let journal = {
      id: `${Date.now()}:${plan.pool.id}:${plan.position.id}:${destinationPool.id}`,
      phase, startedAt: Date.now(), poolId: plan.pool.id,
      destinationPoolId: destinationPool.id,
      sourcePair: `${plan.pool.token0.symbol}/${plan.pool.token1.symbol}`,
      destinationPair: `${destinationPool.token0.symbol}/${destinationPool.token1.symbol}`,
      oldPosition: { id: plan.position.id, tickLower: plan.position.tickLower,
        tickUpper: plan.position.tickUpper, shares: String(plan.position.shares) },
      tx: { routeSwaps: [] }
    };
    this.saveJournal(journal);
    try {
      let preflight = await this.preflightCrossPoolSequence(plan, destinationPool);
      journal = this.patchJournal(journal, {
        phase: 'cross_pool_preflighted',
        preflight: {
          simulatedCallCount: preflight.simulatedCallCount,
          simulatedGasUsed: preflight.simulatedGasUsed,
          routeImpactBps: preflight.routeImpactBps,
          balanceImpactBps: preflight.balanceImpactBps,
          target: preflight.finalTarget,
          mintedLiquidity: preflight.mintedLiquidity
        }
      });
      for (const swap of preflight.routeSwaps) {
        await this.ensureSwapAllowances(swap.tokenIn, swap.rawAmountIn);
      }
      if (preflight.balanceSwap) {
        const token = preflight.balanceSwap.plan.tokenIn === 0
          ? destinationPool.token0 : destinationPool.token1;
        await this.ensureSwapAllowances(token, preflight.balanceSwap.plan.rawAmountIn);
      }
      await this.ensureHookAllowance(destinationPool.token0, destinationPool.key.hooks,
        preflight.depositPlan.amount0Max);
      await this.ensureHookAllowance(destinationPool.token1, destinationPool.key.hooks,
        preflight.depositPlan.amount1Max);
      journal = this.patchJournal(journal, { phase: 'approvals_ready' });

      // Approvals may take blocks. Rebuild and simulate the entire transaction
      // sequence against their actual on-chain allowance state before moving LP.
      preflight = await this.preflightCrossPoolSequence(plan, destinationPool);
      if (preflight.pendingApprovalCount > 0) {
        // An approval quote changed while permissions were being mined. Fail
        // before withdrawal; the next monitor cycle can re-quote from scratch.
        throw new Error('Cross-pool approvals changed during preflight; retry before moving LP');
      }
      const feeOverrides = await this.getPinnedFeeOverrides();
      await this.assertTopUpGasBudget({
        reserveWei: this.config.topUpMinGasReserveWei,
        maxFeePerGas: feeOverrides.maxFeePerGas || feeOverrides.gasPrice,
        futureGasLimit: BigInt(preflight.simulatedGasUsed) * 3n / 2n,
        phase: 'cross-pool-before-withdrawal'
      });
      journal = this.patchJournal(journal, {
        phase: 'sequence_preflighted',
        preflight: {
          simulatedCallCount: preflight.simulatedCallCount,
          simulatedGasUsed: preflight.simulatedGasUsed,
          routeImpactBps: preflight.routeImpactBps,
          balanceImpactBps: preflight.balanceImpactBps,
          target: preflight.finalTarget,
          mintedLiquidity: preflight.mintedLiquidity
        }
      });
      await this.assertPlanStillOutOfRange(plan, 'cross-pool-after-sequence-preflight');
      const withdrawReceipt = await this.sendVerifiedTx({
        label: 'crossPoolGuardedWithdrawAndClaim',
        to: this.config.walletAddress,
        data: preflight.guardedData,
        value: 0n,
        onSent: (hash) => {
          phase = 'withdraw_sent';
          journal = this.patchJournal(journal, { phase, tx: { ...journal.tx, withdraw: hash } });
        }
      });
      phase = 'withdraw_confirmed';
      journal = this.patchJournal(journal, {
        phase, tx: { ...journal.tx, withdraw: withdrawReceipt.hash || journal.tx.withdraw }
      });
      const oldShares = await this.readPositionShares(plan.pool, plan.position.id);
      if (oldShares !== 0n) throw new Error(`Old LP shares remain after cross-pool withdrawal: ${oldShares}`);
      const routeHashes = [];
      for (const swap of preflight.routeSwaps) {
        const beforeInput = await this.readRawTokenBalance(swap.tokenIn);
        const outputToken = [destinationPool.token0, destinationPool.token1]
          .find((token) => token.address.toLowerCase() === swap.quote.tokenOut.toLowerCase());
        if (!outputToken || beforeInput < swap.rawAmountIn) {
          throw new Error('Cross-pool conversion input or output token changed after withdrawal');
        }
        const beforeOutput = await this.readRawTokenBalance(outputToken);
        const receipt = await this.sendVerifiedTx({
          label: `crossPoolRoute:${swap.tokenIn.symbol}->${outputToken.symbol}`,
          to: swap.request.router, data: swap.request.data, value: swap.request.value,
          onSent: (hash) => {
            phase = 'route_swap_sent';
            journal = this.patchJournal(journal, { phase,
              tx: { ...journal.tx, routeSwaps: [...routeHashes, hash] } });
          }
        });
        const afterInput = await this.readRawTokenBalance(swap.tokenIn);
        const afterOutput = await this.readRawTokenBalance(outputToken);
        if (beforeInput - afterInput !== swap.rawAmountIn
          || afterOutput - beforeOutput < BigInt(swap.quote.minRawAmountOut)) {
          throw new Error('Cross-pool route receipt balances differ from exact-input minOut');
        }
        routeHashes.push(receipt.hash || journal.tx.routeSwaps.at(-1));
        phase = 'route_swap_confirmed';
        journal = this.patchJournal(journal, { phase,
          tx: { ...journal.tx, routeSwaps: [...routeHashes] } });
      }
      if (preflight.balanceSwap) {
        const beforeBalances = await this.readRawPairBalances(destinationPool);
        const swap = preflight.balanceSwap;
        const receipt = await this.sendVerifiedTx({
          label: 'crossPoolBalanceSwap', to: swap.request.router,
          data: swap.request.data, value: swap.request.value,
          onSent: (hash) => {
            phase = 'swap_sent';
            journal = this.patchJournal(journal, { phase, tx: { ...journal.tx, swap: hash } });
          }
        });
        const afterBalances = await this.readRawPairBalances(destinationPool);
        this.assertSwapReceiptBalances(destinationPool, swap.plan, beforeBalances, afterBalances);
        phase = 'swap_confirmed';
        journal = this.patchJournal(journal, { phase,
          tx: { ...journal.tx, swap: receipt.hash || journal.tx.swap } });
      }
      const finalBalances = await this.readRawPairBalances(destinationPool);
      const dust = new Map(preflight.funding.map((entry) => [entry.address, entry.dustRaw]));
      const inventory = {
        raw0: finalBalances.raw0 - (dust.get(destinationPool.token0.address.toLowerCase()) || 0n),
        raw1: finalBalances.raw1 - (dust.get(destinationPool.token1.address.toLowerCase()) || 0n)
      };
      if (inventory.raw0 < 0n || inventory.raw1 < 0n) {
        throw new Error('Cross-pool destination inventory fell below retained dust');
      }
      const destinationState = await this.fables.readPoolState(destinationPool);
      if (destinationState.paused !== false) throw new Error('Destination pool paused before deposit');
      const target = buildTargetRange(destinationState.tick, destinationPool.key.tickSpacing,
        this.config.tightWidthBps, this.config.rangePreset);
      const depositPlan = buildExactDepositPlan({
        rawAmount0: inventory.raw0, rawAmount1: inventory.raw1,
        sqrtPriceX96: destinationState.sqrtPriceX96,
        tickLower: target.tickLower, tickUpper: target.tickUpper,
        slippageBps: this.config.depositSlippageBps,
        liquidityReserveBps: this.config.depositLiquidityReserveBps
      });
      this.assertValidDeposit(depositPlan, 'Actual cross-pool deposit plan is invalid');
      await this.ensureHookAllowance(destinationPool.token0, destinationPool.key.hooks,
        depositPlan.amount0Max);
      await this.ensureHookAllowance(destinationPool.token1, destinationPool.key.hooks,
        depositPlan.amount1Max);
      const depositData = this.fables.encodeDeposit(destinationPool, target,
        depositPlan.liquidity, depositPlan.amount0Max, depositPlan.amount1Max, this.deadline());
      journal = this.patchJournal(journal, { phase: 'deposit_preflighted', target,
        depositPlan: serializeDepositPlan(depositPlan) });
      const depositReceipt = await this.sendVerifiedTx({
        label: 'crossPoolFablesDeposit', to: destinationPool.key.hooks,
        data: depositData, value: 0n,
        onSent: (hash) => {
          phase = 'deposit_sent';
          journal = this.patchJournal(journal, { phase, tx: { ...journal.tx, deposit: hash } });
        }
      });
      phase = 'deposit_confirmed';
      const depositEvent = this.findWalletDepositEvent(destinationPool, depositReceipt);
      if (!depositEvent) throw new Error('Cross-pool deposit receipt lacks the wallet deposit event');
      const mintedRange = await this.fables.readRangeKey(destinationPool, depositEvent.rangeId);
      if (!mintedRange.exists || !samePoolKeyLocal(mintedRange.key, destinationPool.key)
        || Number(mintedRange.tickLower) !== target.tickLower
        || Number(mintedRange.tickUpper) !== target.tickUpper) {
        throw new Error('Cross-pool deposit minted an unexpected PoolKey or range');
      }
      const shares = await this.readPositionShares(destinationPool, depositEvent.rangeId);
      if (shares <= 0n) throw new Error('Cross-pool deposit confirmed without new LP shares');
      journal = this.patchJournal(journal, { phase: 'completed', completedAt: Date.now(),
        tx: { ...journal.tx, deposit: depositReceipt.hash || journal.tx.deposit },
        newPosition: { id: depositEvent.rangeId, shares: shares.toString(), target } });
      this.clearJournal();
      this.ledger.append('rebalance.cross_pool_completed', {
        sourcePoolId: plan.pool.id, destinationPoolId: destinationPool.id,
        sourcePair: journal.sourcePair, destinationPair: journal.destinationPair,
        oldPositionId: plan.position.id, newPositionId: depositEvent.rangeId,
        withdrawHash: journal.tx.withdraw, routeSwapHashes: routeHashes,
        balanceSwapHash: journal.tx.swap || null, depositHash: journal.tx.deposit,
        target, aprPct: plan.destinationStats?.aprPct ?? null
      });
      return { status: 'completed', withdrawHash: journal.tx.withdraw,
        routeSwapHashes: routeHashes, swapHash: journal.tx.swap || null,
        depositHash: journal.tx.deposit, newPositionId: depositEvent.rangeId, target };
    } catch (error) {
      const moved = error.code === 'BROADCAST_OUTCOME_UNCERTAIN' || [
        'withdraw_sent', 'withdraw_confirmed', 'route_swap_sent', 'route_swap_confirmed',
        'swap_sent', 'swap_confirmed', 'deposit_preflighted', 'deposit_sent', 'deposit_confirmed'
      ].includes(phase);
      if (moved) {
        journal = this.patchJournal(journal, { phase: 'recovery_required',
          failedAt: Date.now(), error: error.message });
        this.ledger.append('rebalance.recovery_required', jsonSafe(journal));
      } else {
        this.patchJournal(journal, { phase: 'failed', failedAt: Date.now(), error: error.message });
      }
      throw error;
    }
  }

  async readRawTokenBalances(tokens) {
    const balances = await Promise.all((tokens || []).map(async (token) => [
      token.address.toLowerCase(),
      await this.readRawTokenBalance(token)
    ]));
    return new Map(balances);
  }

  assertNoUnfinishedExecution() {
    if (!this.state) return;
    const active = this.state.getSetting('activeRebalanceExecution', null);
    if (!active || !active.phase) return;
    const terminal = new Set(['completed', 'failed']);
    if (terminal.has(active.phase)) return;
    throw new Error(
      `Unfinished rebalance execution requires recovery before new writes: ${active.phase} (${active.id || 'unknown'})`
    );
  }

  async assertLiveReady(plan) {
    if (!this.config.enableAutoRedeploy) throw new Error('ENABLE_AUTO_REDEPLOY is not enabled');
    if (!this.signer) throw new Error('PRIVATE_KEY is missing');
    if (this.signer.address.toLowerCase() !== this.config.walletAddress.toLowerCase()) {
      throw new Error('PRIVATE_KEY does not match WALLET_ADDRESS');
    }
    if (!this.config.eip7702GuardAddress || !this.config.eip7702GuardVerified) {
      throw new Error('EIP-7702 atomic OOR guard is not configured and verified');
    }
    if (
      plan.pool.token0.address.toLowerCase() === ZERO_ADDRESS ||
      plan.pool.token1.address.toLowerCase() === ZERO_ADDRESS
    ) {
      throw new Error('Native-token live rebalance is not enabled');
    }
    await this.assertAtomicGuardReady();
    await this.assertGasGuard();
  }

  async assertAtomicGuardReady() {
    const code = (await this.readProvider.getCode(this.config.walletAddress)).toLowerCase();
    const expected = ('0xef0100' + this.config.eip7702GuardAddress.slice(2)).toLowerCase();
    if (code !== expected) {
      throw new Error(`Wallet is not delegated to the verified EIP-7702 guard: expected ${expected}, got ${code}`);
    }
    const versionData = guardInterface.encodeFunctionData('guardVersion', []);
    const rawVersion = await this.readProvider.call({
      from: this.config.walletAddress,
      to: this.config.walletAddress,
      data: versionData
    });
    const [version] = guardInterface.decodeFunctionResult('guardVersion', rawVersion);
    const expectedVersion = id('Fables7702Guard/v1');
    if (String(version).toLowerCase() !== expectedVersion.toLowerCase()) {
      throw new Error(`Unexpected EIP-7702 guard version: expected ${expectedVersion}, got ${version}`);
    }
    const implementationData = guardInterface.encodeFunctionData('IMPLEMENTATION', []);
    const rawImplementation = await this.readProvider.call({
      from: this.config.walletAddress,
      to: this.config.walletAddress,
      data: implementationData
    });
    const [implementation] = guardInterface.decodeFunctionResult('IMPLEMENTATION', rawImplementation);
    if (String(implementation).toLowerCase() !== this.config.eip7702GuardAddress.toLowerCase()) {
      throw new Error(
        `Unexpected EIP-7702 guard implementation: expected ${this.config.eip7702GuardAddress}, got ${implementation}`
      );
    }
  }

  async assertPlanStillOutOfRange(plan, phase) {
    const latestState = await this.fables.readPoolState(plan.pool);
    const outside = isLpOutOfRange(
      latestState.tick,
      plan.position.tickLower,
      plan.position.tickUpper
    );
    plan.currentTick = latestState.tick;
    plan.pool.state = latestState;

    if (outside) return latestState;

    const details = {
      positionId: plan.position.id,
      poolId: plan.pool.id,
      pair: `${plan.pool.token0.symbol}/${plan.pool.token1.symbol}`,
      reason: 'absolute in-range hold',
      phase,
      latestTick: latestState.tick,
      tickLower: plan.position.tickLower,
      tickUpper: plan.position.tickUpper
    };
    this.ledger.append('rebalance.blocked', details);
    log('warn', 'rebalance.in_range_hold', details);
    throw new Error(
      `Absolute in-range hold: refusing LP withdrawal at tick ${latestState.tick} within [${plan.position.tickLower}, ${plan.position.tickUpper})`
    );
  }

  async readRawPairBalances(pool) {
    const [raw0, raw1] = await Promise.all([
      this.readRawTokenBalance(pool.token0),
      this.readRawTokenBalance(pool.token1)
    ]);
    return { raw0, raw1 };
  }

  async readRawTokenBalance(token) {
    if (token.address.toLowerCase() === ZERO_ADDRESS) {
      return this.readProvider.getBalance(this.config.walletAddress);
    }
    const contract = new Contract(token.address, ERC20_ABI, this.readProvider);
    return BigInt(await contract.balanceOf(this.config.walletAddress));
  }

  async readPositionShares(pool, rangeId) {
    const hook = new Contract(pool.key.hooks, HOOK_ABI, this.readProvider);
    return BigInt(await hook.balanceOf(this.config.walletAddress, rangeId));
  }

  async ensureSwapAllowances(token, rawAmountIn) {
    rawAmountIn = BigInt(rawAmountIn);
    if (rawAmountIn <= 0n) return;
    if (token.address.toLowerCase() === ZERO_ADDRESS) throw new Error('Native input is not enabled');
    const tokenContract = new Contract(token.address, ERC20_ABI, this.readProvider);
    let erc20Allowance = BigInt(await tokenContract.allowance(this.config.walletAddress, PERMIT2));
    if (erc20Allowance !== rawAmountIn
      && !(await this.hasFixedInfinitePermit2Allowance(token, erc20Allowance))) {
      if (erc20Allowance > 0n) {
        await this.sendVerifiedTx({
          label: `approve:${token.symbol}:permit2:reset`,
          to: token.address,
          data: erc20Interface.encodeFunctionData('approve', [PERMIT2, 0n]),
          value: 0n
        });
      }
      await this.sendVerifiedTx({
        label: `approve:${token.symbol}:permit2`,
        to: token.address,
        data: erc20Interface.encodeFunctionData('approve', [PERMIT2, rawAmountIn]),
        value: 0n
      });
      erc20Allowance = BigInt(await tokenContract.allowance(this.config.walletAddress, PERMIT2));
      if (erc20Allowance !== rawAmountIn) throw new Error('ERC20 -> Permit2 allowance did not update to the exact requested amount');
    }

    const permit2 = new Contract(PERMIT2, PERMIT2_ABI, this.readProvider);
    const allowance = await permit2.allowance(
      this.config.walletAddress,
      token.address,
      UNISWAP_UNIVERSAL_ROUTER_212
    );
    const now = Math.floor(Date.now() / 1000);
    if (BigInt(allowance.amount) !== rawAmountIn || Number(allowance.expiration) <= now + this.config.txDeadlineSec) {
      const expiration = now + this.config.permit2ExpirationSec;
      if (BigInt(allowance.amount) > 0n) {
        await this.sendVerifiedTx({
          label: `permit2:${token.symbol}:router:reset`,
          to: PERMIT2,
          data: permit2Interface.encodeFunctionData('approve', [token.address, UNISWAP_UNIVERSAL_ROUTER_212, 0n, expiration]),
          value: 0n
        });
      }
      await this.sendVerifiedTx({
        label: `permit2:${token.symbol}:router`,
        to: PERMIT2,
        data: permit2Interface.encodeFunctionData('approve', [
          token.address,
          UNISWAP_UNIVERSAL_ROUTER_212,
          rawAmountIn,
          expiration
        ]),
        value: 0n
      });
      const updated = await permit2.allowance(
        this.config.walletAddress,
        token.address,
        UNISWAP_UNIVERSAL_ROUTER_212
      );
      if (BigInt(updated.amount) !== rawAmountIn || Number(updated.expiration) <= now + this.config.txDeadlineSec) {
        throw new Error('Permit2 -> Universal Router allowance did not update to the exact requested amount');
      }
    }
  }

  async hasFixedInfinitePermit2Allowance(token, allowance) {
    if (BigInt(allowance) !== MaxUint256) return false;
    // Solady ERC20 may hardwire Permit2 allowance to uint256.max and reject
    // approve(Permit2, ...). Confirm that exact custom error before accepting
    // the immutable layer; the Permit2 -> router allowance stays exact/expiring.
    try {
      await this.readProvider.call({
        from: this.config.walletAddress,
        to: token.address,
        data: erc20Interface.encodeFunctionData('approve', [PERMIT2, 0n])
      });
      return false;
    } catch (error) {
      const revertData = [error?.data, error?.info?.error?.data, error?.error?.data]
        .find((value) => typeof value === 'string' && /^0x[0-9a-fA-F]{8}/.test(value));
      if (revertData?.slice(0, 10).toLowerCase() === '0x3f68539a') return true;
      throw error;
    }
  }

  async ensureHookAllowance(token, hookAddress, rawAmount) {
    rawAmount = BigInt(rawAmount);
    if (rawAmount === 0n) return;
    if (token.address.toLowerCase() === ZERO_ADDRESS) throw new Error('Native Fables deposits are not enabled');
    const tokenContract = new Contract(token.address, ERC20_ABI, this.readProvider);
    let allowance = BigInt(await tokenContract.allowance(this.config.walletAddress, hookAddress));
    if (allowance === rawAmount) return;
    if (allowance > 0n) {
      await this.sendVerifiedTx({
        label: `approve:${token.symbol}:hook:reset`,
        to: token.address,
        data: erc20Interface.encodeFunctionData('approve', [hookAddress, 0n]),
        value: 0n
      });
    }
    await this.sendVerifiedTx({
      label: `approve:${token.symbol}:hook`,
      to: token.address,
      // Fables deposit amount caps are uint128. Never grant a dynamic hook
      // more ERC20 allowance than the ABI can actually consume per deposit.
      data: erc20Interface.encodeFunctionData('approve', [hookAddress, rawAmount]),
      value: 0n
    });
    allowance = BigInt(await tokenContract.allowance(this.config.walletAddress, hookAddress));
    if (allowance !== rawAmount) throw new Error(`${token.symbol} -> Fables hook allowance did not update to the exact requested amount`);
  }

  async assertExactHookAllowance(token, hookAddress, rawAmount) {
    rawAmount = BigInt(rawAmount);
    if (rawAmount === 0n) return;
    const tokenContract = new Contract(token.address, ERC20_ABI, this.readProvider);
    const allowance = BigInt(await tokenContract.allowance(this.config.walletAddress, hookAddress));
    if (allowance !== rawAmount) {
      throw new Error(`${token.symbol} -> Fables hook allowance differs from the preflighted exact amount; refusing deposit`);
    }
  }

  assertSwapReceiptBalances(pool, swapPlan, before, after) {
    const inputBefore = swapPlan.tokenIn === 0 ? before.raw0 : before.raw1;
    const inputAfter = swapPlan.tokenIn === 0 ? after.raw0 : after.raw1;
    const outputBefore = swapPlan.tokenOut === 0 ? before.raw0 : before.raw1;
    const outputAfter = swapPlan.tokenOut === 0 ? after.raw0 : after.raw1;
    const spent = inputBefore - inputAfter;
    const received = outputAfter - outputBefore;
    if (spent !== swapPlan.rawAmountIn) {
      throw new Error(`Swap receipt input mismatch for exact-in request: spent ${spent}, expected ${swapPlan.rawAmountIn}`);
    }
    if (received < BigInt(swapPlan.quote.minRawAmountOut)) {
      throw new Error(`Swap receipt output below minOut: ${received} < ${swapPlan.quote.minRawAmountOut}`);
    }
  }

  findWalletDepositEvent(pool, receipt) {
    const walletTopic = zeroPadValue(this.config.walletAddress, 32).toLowerCase();
    const entry = (receipt.logs || []).find((logEntry) =>
      String(logEntry.address).toLowerCase() === pool.key.hooks.toLowerCase()
      && String(logEntry.topics?.[0] || '').toLowerCase() === depositedTopic
      && String(logEntry.topics?.[1] || '').toLowerCase() === walletTopic
      && logEntry.topics?.[2]
    );
    if (!entry) return null;
    return {
      rangeId: String(entry.topics[2]).toLowerCase(),
      liquidity: BigInt(entry.data || 0)
    };
  }

  async getPinnedFeeOverrides(preferred = null) {
    if (preferred) return preferred;
    const [feeData, latestBlock] = await Promise.all([
      this.writeProvider.getFeeData(),
      this.writeProvider.getBlock('latest')
    ]);
    const baseFeePerGas = latestBlock?.baseFeePerGas == null ? 0n : BigInt(latestBlock.baseFeePerGas);
    const maxFeePerGas = feeData.maxFeePerGas == null ? 0n : BigInt(feeData.maxFeePerGas);
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas == null ? 0n : BigInt(feeData.maxPriorityFeePerGas);
    if (maxFeePerGas > 0n && maxPriorityFeePerGas > 0n && maxPriorityFeePerGas <= maxFeePerGas) {
      // A quote from the previous block can already be below the current base
      // fee. Keep room for several blocks before the signed tx is included.
      const buffered = baseFeePerGas > 0n ? baseFeePerGas * 2n + maxPriorityFeePerGas : 0n;
      return { maxFeePerGas: maxFeePerGas > buffered ? maxFeePerGas : buffered, maxPriorityFeePerGas };
    }
    const gasPrice = feeData.gasPrice == null ? 0n : BigInt(feeData.gasPrice);
    if (gasPrice > 0n) {
      const reference = gasPrice > baseFeePerGas ? gasPrice : baseFeePerGas;
      // Robinhood RPC can return a legacy gasPrice lower than the next block's
      // base fee. Buffer the pinned quote before budgeting the whole sequence.
      return { gasPrice: baseFeePerGas > 0n ? reference * 2n : gasPrice };
    }
    throw new Error('Fee data is unavailable or incomplete; refusing to build a transaction');
  }

  async assertWriteChainId() {
    const expected = BigInt(this.config.chainId || 0);
    if (expected <= 0n || !this.writeProvider?.send) {
      throw new Error('Configured chainId or raw eth_chainId RPC method is unavailable');
    }
    const rawChainId = await this.writeProvider.send('eth_chainId', []);
    const actual = BigInt(rawChainId);
    if (actual !== expected) {
      throw new Error(`Write RPC chainId mismatch: configured ${expected}, raw eth_chainId ${actual}`);
    }
    return actual;
  }

  async sendVerifiedTx({ label, to, data, value = 0n, onSent = null, feeOverrides = null }) {
    const fees = await this.getPinnedFeeOverrides(feeOverrides);
    await this.assertGasGuard(fees);
    const chainId = BigInt(this.config.chainId || 0);
    if (chainId <= 0n) throw new Error('Configured chainId is unavailable');
    const semanticRequest = { to, data, value: BigInt(value), from: this.config.walletAddress };
    // eth_call/estimateGas with a pinned fee can fail on RPC fee drift or on
    // the node's large default call gas limit even when the contract succeeds.
    await this.readProvider.call(semanticRequest);
    const gasEstimate = await this.signer.estimateGas(semanticRequest);
    const request = { to, data, value: BigInt(value), chainId: Number(chainId), ...fees };
    const populated = await this.signer.populateTransaction({
      ...request,
      gasLimit: gasEstimate * 120n / 100n
    });
    const rawTransaction = await this.signer.signTransaction(populated);
    const hash = keccak256(rawTransaction);
    await this.assertWriteChainId();
    this.ledger.append('tx.broadcast_pending', {
      label,
      hash,
      to,
      gasEstimate: gasEstimate.toString(),
      nonce: populated.nonce,
      chainId: chainId.toString(),
      feeOverrides: jsonSafe(fees)
    });

    let defaultJournal = null;
    if (onSent) {
      // Persist the expected hash before contacting the RPC. A node can accept
      // the signed transaction even if its broadcast response later rejects.
      onSent(hash);
    } else if (this.state) {
      const active = this.state.getSetting('activeRebalanceExecution', null);
      if (active?.phase && !['completed', 'failed'].includes(active.phase)) {
        defaultJournal = { id: active.id, previousPhase: active.phase };
        this.saveJournal({
          ...active,
          phase: 'tx_broadcast_pending',
          pendingTx: { label, hash, to, previousPhase: active.phase }
        });
      }
    }

    let tx;
    try {
      tx = await this.writeProvider.broadcastTransaction(rawTransaction);
    } catch (error) {
      this.markUncertainBroadcast({ label, hash, to, error, defaultJournal });
      const uncertain = new Error(`${label} broadcast outcome is uncertain for ${hash}: ${error.message}`);
      uncertain.code = 'BROADCAST_OUTCOME_UNCERTAIN';
      uncertain.txHash = hash;
      throw uncertain;
    }
    if (String(tx.hash).toLowerCase() !== hash.toLowerCase()) {
      const error = new Error('RPC returned a transaction hash different from the signed payload');
      this.markUncertainBroadcast({ label, hash, to, error, defaultJournal, returnedHash: tx.hash });
      const uncertain = new Error(`${label} broadcast returned an unexpected hash; expected ${hash}, got ${tx.hash}`);
      uncertain.code = 'BROADCAST_OUTCOME_UNCERTAIN';
      uncertain.txHash = hash;
      throw uncertain;
    }
    this.ledger.append('tx.sent', { label, hash, to, gasEstimate: gasEstimate.toString() });

    let receipt;
    try {
      receipt = await tx.wait(this.config.confirmations);
    } catch (error) {
      this.markUncertainBroadcast({ label, hash, to, error, defaultJournal, stage: 'receipt-wait' });
      const uncertain = new Error(`${label} receipt outcome is uncertain for ${hash}: ${error.message}`);
      uncertain.code = 'BROADCAST_OUTCOME_UNCERTAIN';
      uncertain.txHash = hash;
      throw uncertain;
    }
    if (!receipt || receipt.status !== 1) {
      this.restoreBroadcastJournal(defaultJournal, { label, hash, status: 'reverted' });
      throw new Error(`${label} failed: ${tx.hash}`);
    }
    this.restoreBroadcastJournal(defaultJournal, { label, hash, status: 'confirmed' });
    const gasPrice = receipt.gasPrice || tx.gasPrice || fees.maxFeePerGas || fees.gasPrice || 0n;
    const gasEth = Number(formatUnits(receipt.gasUsed * gasPrice, 18));
    const ethUsd = Number(this.getUsdPrice?.(ZERO_ADDRESS) || 0);
    this.ledger.append('tx.confirmed', {
      label,
      hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      gasPriceWei: gasPrice.toString(),
      gasEth,
      gasUsd: ethUsd > 0 ? gasEth * ethUsd : 0
    });
    return receipt;
  }

  markUncertainBroadcast({ label, hash, to, error, defaultJournal, returnedHash = null, stage = 'broadcast' }) {
    this.ledger.append('tx.broadcast_uncertain', {
      label,
      hash,
      returnedHash,
      to,
      stage,
      error: error.message
    });
    if (!this.state) return;
    const active = this.state.getSetting('activeRebalanceExecution', null);
    if (!active || !defaultJournal || active.id !== defaultJournal.id) return;
    this.saveJournal({
      ...active,
      phase: 'recovery_required',
      failedAt: Date.now(),
      error: error.message,
      pendingTx: { label, hash, to, stage, outcome: 'uncertain' }
    });
  }

  restoreBroadcastJournal(defaultJournal, { label, hash, status }) {
    if (!this.state || !defaultJournal) return;
    const active = this.state.getSetting('activeRebalanceExecution', null);
    if (!active || active.id !== defaultJournal.id || active.pendingTx?.hash !== hash) return;
    this.saveJournal({
      ...active,
      phase: defaultJournal.previousPhase,
      pendingTx: null,
      lastApprovalTx: { label, hash, status }
    });
  }

  async assertGasGuard(feeOverrides = null) {
    const fees = await this.getPinnedFeeOverrides(feeOverrides);
    const gasPrice = feeCap(fees);
    const maxGasGwei = Number(this.config.maxGasGwei);
    if (!Number.isFinite(maxGasGwei) || maxGasGwei <= 0) throw new Error('MAX_GAS_GWEI is unavailable or invalid');
    const maxWei = BigInt(Math.floor(maxGasGwei * 1e9));
    if (gasPrice > maxWei) {
      throw new Error(`Gas guard: ${formatUnits(gasPrice, 'gwei')} gwei > ${maxGasGwei} gwei`);
    }
  }

  deadline() {
    return Math.floor(Date.now() / 1000) + this.config.txDeadlineSec;
  }

  saveJournal(journal) {
    if (this.state) this.state.setSetting('activeRebalanceExecution', jsonSafe(journal));
  }

  patchJournal(journal, patch) {
    const next = { ...journal, ...patch, updatedAt: Date.now() };
    this.saveJournal(next);
    return next;
  }

  clearJournal() {
    if (this.state) this.state.setSetting('activeRebalanceExecution', null);
  }
}

function serializablePlan(plan) {
  return {
    poolId: plan.pool.id,
    pair: `${plan.pool.token0.symbol}/${plan.pool.token1.symbol}`,
    hook: plan.pool.key.hooks,
    currentTick: plan.currentTick,
    position: {
      id: plan.position.id,
      tickLower: plan.position.tickLower,
      tickUpper: plan.position.tickUpper,
      shares: plan.position.shares.toString()
    },
    target: plan.target,
    inventoryPlan: plan.inventoryPlan || null,
    quote: plan.quote || null,
    depositPlan: plan.depositPlan || null
  };
}

function samePoolKeyLocal(left, right) {
  if (!left || !right) return false;
  return String(left.currency0).toLowerCase() === String(right.currency0).toLowerCase()
    && String(left.currency1).toLowerCase() === String(right.currency1).toLowerCase()
    && Number(left.fee) === Number(right.fee)
    && Number(left.tickSpacing) === Number(right.tickSpacing)
    && String(left.hooks).toLowerCase() === String(right.hooks).toLowerCase();
}

function operationDelta(before, after) {
  return { raw0: after.raw0 - before.raw0, raw1: after.raw1 - before.raw1 };
}
function positiveOperationDelta(before, after) {
  const delta = operationDelta(before, after);
  return {
    raw0: delta.raw0 > 0n ? delta.raw0 : 0n,
    raw1: delta.raw1 > 0n ? delta.raw1 : 0n
  };
}
function uniquePairTokens(...pools) {
  const tokens = new Map();
  for (const pool of pools) {
    for (const token of [pool?.token0, pool?.token1]) {
      if (token?.address) tokens.set(String(token.address).toLowerCase(), token);
    }
  }
  return [...tokens.values()];
}
function serializeFundingEntry(entry) {
  return {
    address: entry.address,
    symbol: entry.token.symbol,
    walletSource: entry.walletSource,
    walletRaw: entry.walletRaw.toString(),
    withdrawRaw: entry.withdrawRaw.toString(),
    dustRaw: entry.dustRaw.toString(),
    maxSpendRaw: entry.maxSpendRaw.toString()
  };
}
function applySwapBudget(balances, swapPlan, useMinimumOutput = true) {
  const result = { raw0: BigInt(balances.raw0), raw1: BigInt(balances.raw1) };
  if (!swapPlan || swapPlan.direction === 'none') return result;
  const input = BigInt(swapPlan.rawAmountIn);
  const output = BigInt(useMinimumOutput ? swapPlan.quote.minRawAmountOut : swapPlan.quote.rawAmountOut);
  if (input <= 0n || output <= 0n) throw new Error('Swap budget plan has invalid input/output');
  if (swapPlan.tokenIn === 0) {
    if (input > result.raw0) throw new Error('Swap budget exceeds scoped token0 capital');
    result.raw0 -= input;
    result.raw1 += output;
  } else if (swapPlan.tokenIn === 1) {
    if (input > result.raw1) throw new Error('Swap budget exceeds scoped token1 capital');
    result.raw1 -= input;
    result.raw0 += output;
  } else {
    throw new Error('Swap budget has an invalid input token index');
  }
  return result;
}
function feeCap(feeOverrides) {
  return BigInt(feeOverrides?.maxFeePerGas ?? feeOverrides?.gasPrice ?? 0n);
}
function stringifyRawBalances(value) {
  return { raw0: value.raw0.toString(), raw1: value.raw1.toString() };
}
function serializeSwapPlan(plan) {
  return {
    direction: plan.direction,
    tokenIn: plan.tokenIn,
    tokenOut: plan.tokenOut,
    rawAmountIn: plan.rawAmountIn?.toString?.() || '0',
    quote: plan.quote || null
  };
}
function serializeDepositPlan(plan) {
  return {
    provisional: false,
    basis: plan.basis,
    tickLower: plan.tickLower,
    tickUpper: plan.tickUpper,
    liquidity: plan.liquidity.toString(),
    required0: plan.required0.toString(),
    required1: plan.required1.toString(),
    amount0Max: plan.amount0Max.toString(),
    amount1Max: plan.amount1Max.toString()
  };
}
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v));
}
