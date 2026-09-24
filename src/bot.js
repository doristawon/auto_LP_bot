import { formatUnits } from 'ethers';
import { createProviders, verifyProviders } from './rpc/providers.js';
import { FablesAdapter, lifecycleEventType, lifecycleLiquidity } from './adapters/fables.js';
import { RebalanceExecutor } from './adapters/executor.js';
import { V4QuoterAdapter } from './adapters/quoter.js';
import { buildUsdPriceMap } from './analytics/prices.js';
import { PortfolioAnalytics } from './analytics/portfolio.js';
import { PointsTracker } from './analytics/points-tracker.js';
import { evaluatePosition } from './strategy.js';
import { LedgerStore } from './ledger.js';
import { StateStore } from './state.js';
import { ZERO_ADDRESS } from './constants.js';
import { log } from './logger.js';

export class AutoLpBot {
  constructor(config) {
    this.config = config;
    this.providers = createProviders(config);
    this.state = new StateStore(config.stateFile);
    this.ledger = new LedgerStore(config.dataDir);
    this.fables = new FablesAdapter(this.providers.readProvider, config);
    this.quoter = new V4QuoterAdapter(this.providers.readProvider);
    this.analytics = new PortfolioAnalytics(config, this.ledger, this.state);
    this.points = new PointsTracker(config, this.ledger, this.state);
    this.market = { refreshedAt: 0, pools: [], prices: new Map(), latestBlock: 0 };
    this.rpcHealth = [];
    this.executionPaused = Boolean(this.state.getSetting('executionPaused', false));
    this.snapshot = this.ledger.readSnapshot();
    this.running = false;
    this.cycleActive = false;
    this.blockTimeCache = new Map();
    this.executor = new RebalanceExecutor(
      this.providers.readProvider,
      this.providers.writeProvider,
      config,
      this.fables,
      this.ledger,
      (address) => this.market.prices.get(String(address).toLowerCase()) || 0
    );
  }

  async initialize() {
    this.rpcHealth = await verifyProviders(this.providers.rawProviders, this.config.chainId);
    log('info', 'rpc.health', { endpoints: this.rpcHealth.map((x) => ({ index: x.index, ok: x.ok, chainId: x.chainId })) });
    await this.refreshMarket(true);
  }

  setExecutionPaused(value, source = 'system') {
    this.executionPaused = Boolean(value);
    this.state.setSetting('executionPaused', this.executionPaused);
    this.ledger.append('execution.control', { paused: this.executionPaused, source });
    if (this.snapshot?.bot) this.snapshot.bot.executionPaused = this.executionPaused;
    log('warn', 'execution.control', { paused: this.executionPaused, source });
  }

  async refreshMarket(force = false) {
    if (!force && Date.now() - this.market.refreshedAt < this.config.marketRefreshMs) return this.market;
    const latestBlock = await this.providers.readProvider.getBlockNumber();
    const discovered = await this.fables.discoverAllPools();
    const pools = await this.fables.hydratePoolStates(discovered);
    const prices = buildUsdPriceMap(pools, this.config.usdgAddress);
    this.market = { refreshedAt: Date.now(), pools, prices, latestBlock };
    await this.scanGlobalPoolFees(pools, latestBlock);
    log('info', 'market.refreshed', {
      block: latestBlock,
      pools: pools.length,
      pricedAssets: prices.size,
      targetMode: this.config.targetMode,
      targetPools: this.config.targetMode === 'wallet-active' ? null : this.fables.targetPools(pools).length
    });
    return this.market;
  }

  async runOnce() {
    if (this.cycleActive) {
      log('warn', 'cycle.skipped', { reason: 'previous cycle still running' });
      return this.snapshot;
    }
    this.cycleActive = true;
    try {
      await this.refreshMarket(false);
      const latestBlock = await this.providers.readProvider.getBlockNumber();
      this.market.latestBlock = latestBlock;
      const selection = await this.resolveTargetPools(latestBlock);
      const targetPools = selection.pools;
      const accountingPools = selection.accountingPools || targetPools;
      if (!targetPools.length) {
        const snapshot = {
          generatedAt: Date.now(),
          blockNumber: latestBlock,
          bot: {
            version: '0.3.0',
            wallet: this.config.walletAddress,
            dryRun: this.config.dryRun,
            liveWrites: this.config.enableLiveWrites,
            autoRedeploy: this.config.enableAutoRedeploy,
            executionPaused: this.executionPaused,
            targetMode: this.config.targetMode,
            activePoolIds: [],
            topologyCooldownUntil: this.state.getSetting('walletTopologyCooldownUntil', 0),
            lastAction: this.state.getSetting('lastAction', null),
            swapSlippageBps: this.config.swapSlippageBps
          },
          rpcHealth: this.rpcHealth,
          portfolio: this.snapshot?.portfolio || emptyPortfolio(),
          points: this.points.snapshot(),
          prices: Object.fromEntries(this.market.prices),
          walletBalances: {},
          pools: []
        };
        this.snapshot = snapshot;
        this.ledger.writeSnapshot(snapshot);
        log('warn', 'wallet_pool.none_active', { targetMode: this.config.targetMode, block: latestBlock });
        return snapshot;
      }

      for (const pool of targetPools) {
        pool.state = await this.fables.readPoolState(pool);
        const cursorKey = `positionLogs:${pool.id}`;
        const fallbackCursor = this.config.targetMode === 'wallet-active'
          ? Math.max(this.config.logFromBlock, latestBlock - this.config.reorgLookbackBlocks)
          : this.config.logFromBlock;
        const previousCursor = this.state.getCursor(cursorKey, fallbackCursor);
        const fromBlock = Math.max(this.config.logFromBlock, previousCursor - this.config.reorgLookbackBlocks);
        const result = await this.fables.discoverPositions(pool, fromBlock, latestBlock);
        pool.positions = result.positions;
        await this.recordLifecycleLogs(pool, result.lifecycleLogs);
        this.state.setCursor(cursorKey, latestBlock + 1);
        for (const position of pool.positions) {
          await this.decoratePosition(pool, position);
          this.trackFeeAccrual(pool, position);
        }
      }

      const uniqueTokens = uniqueTargetTokens(accountingPools);
      const walletBalances = await this.fables.readWalletBalances(uniqueTokens);
      const portfolio = this.analytics.build({
        targetPools,
        walletBalances,
        prices: this.market.prices,
        trackedTokens: uniqueTokens
      });
      await this.attachRebalanceQuotes(targetPools, portfolio);
      const points = this.points.snapshot();
      const snapshot = {
        generatedAt: Date.now(),
        blockNumber: latestBlock,
        bot: {
          version: '0.3.0',
          wallet: this.config.walletAddress,
          dryRun: this.config.dryRun,
          liveWrites: this.config.enableLiveWrites,
          autoRedeploy: this.config.enableAutoRedeploy,
          executionPaused: this.executionPaused,
          lastAction: this.state.getSetting('lastAction', null),
          targetMode: this.config.targetMode,
          activePoolIds: targetPools.map((pool) => pool.id),
          accountingPoolIds: accountingPools.map((pool) => pool.id),
          topologyCooldownUntil: this.state.getSetting('walletTopologyCooldownUntil', 0),
          targetSymbols: this.config.targetSymbols,
          swapSlippageBps: this.config.swapSlippageBps
        },
        rpcHealth: this.rpcHealth,
        portfolio,
        points,
        prices: Object.fromEntries(this.market.prices),
        walletBalances: Object.fromEntries(Object.entries(walletBalances).map(([k, v]) => [k, { amount: v.amount }])),
        pools: targetPools.map(snapshotPool)
      };
      this.snapshot = snapshot;
      this.ledger.writeSnapshot(snapshot);
      this.recordPortfolioSnapshot(snapshot);

      for (const pool of targetPools) {
        for (const position of pool.positions || []) {
          if (!position.shouldRebalance) continue;
          await this.maybeRebalance(pool, position);
        }
      }
      return snapshot;
    } finally {
      this.cycleActive = false;
    }
  }

  async resolveTargetPools(latestBlock) {
    if (this.config.targetMode !== 'wallet-active') {
      const pools = this.fables.targetPools(this.market.pools);
      return { pools, accountingPools: pools, discovery: null };
    }

    const cursorKey = 'walletPoolDiscovery';
    const previousCursor = this.state.getCursor(cursorKey, this.config.walletPoolDiscoveryFromBlock);
    const fromBlock = Math.max(
      this.config.walletPoolDiscoveryFromBlock,
      previousCursor - this.config.reorgLookbackBlocks
    );
    const knownRangeKeys = this.state.getSetting('walletRangeCandidates', []);
    const result = await this.fables.discoverWalletActivePools(
      this.market.pools,
      fromBlock,
      latestBlock,
      knownRangeKeys
    );

    this.state.setCursor(cursorKey, latestBlock + 1);
    this.state.setSetting('walletRangeCandidates', result.knownRangeKeys);

    const previousIds = (this.state.getSetting('activeWalletPoolIds', []) || []).map((x) => String(x).toLowerCase()).sort();
    const currentIds = result.activePoolIds.map((x) => String(x).toLowerCase()).sort();
    const previousRanges = (this.state.getSetting('activeWalletRangeKeys', []) || []).map((x) => String(x).toLowerCase()).sort();
    const currentRanges = result.activeRangeKeys.map((x) => String(x).toLowerCase()).sort();
    const poolsChanged = !sameStringArray(previousIds, currentIds);
    const rangesChanged = !sameStringArray(previousRanges, currentRanges);
    if (poolsChanged || rangesChanged) {
      const previousSet = new Set(previousIds);
      const currentSet = new Set(currentIds);
      const previousRangeSet = new Set(previousRanges);
      const currentRangeSet = new Set(currentRanges);
      const added = currentIds.filter((id) => !previousSet.has(id));
      const removed = previousIds.filter((id) => !currentSet.has(id));
      const addedRanges = currentRanges.filter((id) => !previousRangeSet.has(id));
      const removedRanges = previousRanges.filter((id) => !currentRangeSet.has(id));
      const cooldownUntil = Date.now() + this.config.manualTopologyCooldownSec * 1000;
      this.state.setSetting('activeWalletPoolIds', currentIds);
      this.state.setSetting('activeWalletRangeKeys', currentRanges);
      this.state.setSetting('walletTopologyCooldownUntil', cooldownUntil);
      this.ledger.append('wallet.lp_topology_changed', {
        poolsChanged,
        rangesChanged,
        added,
        removed,
        addedRanges,
        removedRanges,
        activePoolIds: currentIds,
        activeRangeKeys: currentRanges,
        cooldownUntil,
        cooldownSec: this.config.manualTopologyCooldownSec
      });
      log('warn', 'wallet.lp_topology_changed', {
        poolsChanged,
        rangesChanged,
        added,
        removed,
        addedRanges,
        removedRanges,
        activePoolIds: currentIds,
        cooldownUntil
      });
    }

    return { pools: result.activePools, accountingPools: result.knownPools || result.activePools, discovery: result };
  }

  async attachRebalanceQuotes(targetPools, portfolio) {
    for (const metric of portfolio.positions || []) {
      if (!metric.outside || !metric.rebalancePlan || metric.rebalancePlan.direction === 'none' || !(metric.rebalancePlan.amountIn > 0)) continue;
      const pool = targetPools.find((x) => x.id === metric.poolId);
      if (!pool) continue;
      try {
        const quote = await this.quoter.quoteExactInputSingle(
          pool,
          metric.rebalancePlan.tokenIn,
          metric.rebalancePlan.amountIn,
          this.config.swapSlippageBps
        );
        metric.rebalanceQuote = quote;
        const position = (pool.positions || []).find((x) => x.id.toLowerCase() === metric.id.toLowerCase());
        if (position) {
          position.rebalancePlan = metric.rebalancePlan;
          position.rebalanceQuote = quote;
        }
      } catch (error) {
        metric.rebalanceQuoteError = error.message;
        log('warn', 'rebalance.quote_failed', { positionId: metric.id, poolId: metric.poolId, error: error.message });
      }
    }
  }

  recordPortfolioSnapshot(snapshot) {
    const now = snapshot.generatedAt;
    const last = Number(this.state.getSetting('lastPortfolioSnapshotAt', 0) || 0);
    if (last && now - last < this.config.portfolioSnapshotIntervalMs) return;
    this.ledger.append('portfolio.snapshot', {
      blockNumber: snapshot.blockNumber,
      currentValueUsd: snapshot.portfolio.currentValueUsd,
      hodlValueUsd: snapshot.portfolio.hodlValueUsd,
      netPnlUsd: snapshot.portfolio.netPnlUsd,
      excessVsHodlUsd: snapshot.portfolio.excessVsHodlUsd,
      ilUsd: snapshot.portfolio.currentIlUsd,
      feeUsd: snapshot.portfolio.trackedFeeUsd,
      gasUsd: snapshot.portfolio.gasUsd,
      estimatedPoints: snapshot.points.estimatedTotal
    }, now);
    this.state.setSetting('lastPortfolioSnapshotAt', now);
  }

  async decoratePosition(pool, position) {
    const stateKey = positionStateKey(pool, position);
    const stored = this.state.getPosition(stateKey);
    const evaluation = evaluatePosition({
      currentTick: pool.state.tick,
      tickSpacing: pool.key.tickSpacing,
      position,
      widthBps: this.config.tightWidthBps,
      edgeBufferTicks: this.config.edgeBufferTicks,
      confirmationsSeen: stored.outOfRangeConfirmations || 0,
      confirmationsRequired: this.config.outOfRangeConfirmations,
      cooldownUntil: stored.cooldownUntil || 0
    });
    Object.assign(position, {
      outside: evaluation.outside,
      confirmations: evaluation.nextConfirmations,
      cooldownActive: evaluation.cooldownActive,
      shouldRebalance: evaluation.shouldRebalance,
      target: evaluation.target
    });
    this.state.setPosition(stateKey, {
      outOfRangeConfirmations: evaluation.nextConfirmations,
      lastTick: pool.state.tick,
      lastSeenAt: Date.now(),
      lastRange: [position.tickLower, position.tickUpper]
    });
    log(evaluation.outside ? 'warn' : 'info', 'position.status', {
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      id: position.id,
      tick: pool.state.tick,
      range: [position.tickLower, position.tickUpper],
      outside: evaluation.outside,
      confirmations: evaluation.nextConfirmations,
      target: evaluation.target
    });
  }

  trackFeeAccrual(pool, position) {
    const key = `feeState:${positionStateKey(pool, position)}`;
    const previous = this.state.getSetting(key, null);
    const current = { owed0: position.owed0.toString(), owed1: position.owed1.toString(), shares: position.shares.toString(), at: Date.now() };
    this.state.setSetting(key, current);
    if (!previous || String(previous.shares) !== position.shares.toString()) return;
    const prev0 = BigInt(previous.owed0 || 0);
    const prev1 = BigInt(previous.owed1 || 0);
    const d0 = position.owed0 - prev0;
    const d1 = position.owed1 - prev1;
    if (d0 > 0n || d1 > 0n) {
      const amount0 = d0 > 0n ? Number(formatUnits(d0, pool.token0.decimals)) : 0;
      const amount1 = d1 > 0n ? Number(formatUnits(d1, pool.token1.decimals)) : 0;
      const feeUsd = amount0 * this.priceOf(pool.token0.address) + amount1 * this.priceOf(pool.token1.address);
      this.ledger.append('fee.accrual', {
        positionId: position.id,
        poolId: pool.id,
        pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
        amount0,
        amount1,
        symbol0: pool.token0.symbol,
        symbol1: pool.token1.symbol,
        feeUsd
      });
    } else if (d0 < 0n || d1 < 0n) {
      this.ledger.append('fee.owed_decrease', {
        positionId: position.id,
        poolId: pool.id,
        pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
        previousOwed0: prev0.toString(),
        previousOwed1: prev1.toString(),
        currentOwed0: position.owed0.toString(),
        currentOwed1: position.owed1.toString(),
        note: 'Claim, withdraw, checkpoint, or accounting reset detected'
      });
    }
  }

  async maybeRebalance(pool, position) {
    const topologyCooldownUntil = Number(this.state.getSetting('walletTopologyCooldownUntil', 0) || 0);
    if (Date.now() < topologyCooldownUntil) {
      this.ledger.append('rebalance.blocked', {
        positionId: position.id,
        poolId: pool.id,
        reason: 'wallet topology cooldown',
        cooldownUntil: topologyCooldownUntil
      });
      return;
    }
    if (this.executionPaused) {
      this.ledger.append('rebalance.blocked', { positionId: position.id, reason: 'execution paused' });
      return;
    }
    if (this.state.recentRebalances().length >= this.config.maxRebalancesPerHour) {
      this.ledger.append('rebalance.blocked', { positionId: position.id, reason: 'hourly rate limit' });
      return;
    }
    const plan = {
      pool,
      position,
      currentTick: pool.state.tick,
      target: position.target,
      inventoryPlan: position.rebalancePlan || null,
      quote: position.rebalanceQuote || null
    };
    this.state.setSetting('lastAction', `rebalance ${pool.token0.symbol}/${pool.token1.symbol} ${position.id.slice(0, 10)}…`);
    try {
      const result = await this.executor.execute(plan);
      const cooldownUntil = Date.now() + this.config.minRebalanceIntervalSec * 1000;
      this.state.setPosition(positionStateKey(pool, position), { cooldownUntil, outOfRangeConfirmations: 0 });
      this.state.recordRebalance({
        ts: Date.now(), positionId: position.id, poolId: pool.id, result: result.status,
        currentTick: pool.state.tick, target: position.target
      });
    } catch (error) {
      this.ledger.append('rebalance.failed', { positionId: position.id, poolId: pool.id, error: error.message });
      log('error', 'rebalance.failed', { positionId: position.id, error: error.message });
    }
  }

  async scanGlobalPoolFees(pools, latestBlock) {
    const poolsPerHook = new Map();
    for (const pool of pools) {
      const hook = pool.key.hooks.toLowerCase();
      poolsPerHook.set(hook, (poolsPerHook.get(hook) || 0) + 1);
    }
    for (const pool of pools) {
      if (!pool.state || pool.token0.decimals == null || pool.token1.decimals == null) continue;
      const hook = pool.key.hooks.toLowerCase();
      if ((poolsPerHook.get(hook) || 0) > 1) {
        this.ledger.appendUnique(
          `shared-hook-fee-unattributed:${hook}`,
          'pool.fee_unattributed',
          {
            hook: pool.key.hooks,
            poolCount: poolsPerHook.get(hook),
            reason: 'FeesCollected has no verified PoolKey attribution for shared hooks; skip pair-level totals to avoid double counting'
          }
        );
        continue;
      }
      const cursorKey = `poolFees:${pool.id}`;
      const storedCursor = this.state.getCursor(cursorKey, 0);
      const initial = this.config.feeLogFromBlock > 0 ? this.config.feeLogFromBlock : latestBlock;
      const fromBlock = storedCursor > 0
        ? Math.max(initial, storedCursor - this.config.reorgLookbackBlocks)
        : initial;
      if (fromBlock > latestBlock) continue;
      let events;
      try { events = await this.fables.scanPoolFees(pool, fromBlock, latestBlock); }
      catch (error) {
        log('warn', 'pool_fee.scan_failed', { poolId: pool.id, fromBlock, latestBlock, error: error.message });
        continue;
      }
      for (const event of events) {
        const ts = await this.blockTimestamp(event.blockNumber);
        const amount0 = Number(formatUnits(event.amount0, pool.token0.decimals));
        const amount1 = Number(formatUnits(event.amount1, pool.token1.decimals));
        const feeUsd = amount0 * this.priceOf(pool.token0.address) + amount1 * this.priceOf(pool.token1.address);
        this.ledger.appendUnique(`poolfee:${pool.id}:${event.transactionHash}:${event.index}`, 'pool.fee', {
          poolId: pool.id,
          pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
          hash: event.transactionHash,
          blockNumber: event.blockNumber,
          amount0,
          amount1,
          symbol0: pool.token0.symbol,
          symbol1: pool.token1.symbol,
          feeUsd
        }, ts);
      }
      this.state.setCursor(cursorKey, latestBlock + 1);
    }
  }

  async recordLifecycleLogs(pool, logs) {
    for (const entry of logs) {
      const kind = lifecycleEventType(entry);
      if (!kind) continue;
      const rangeId = entry.topics?.[2]?.toLowerCase();
      const eventKey = `lifecycle:${entry.transactionHash}:${Number(entry.index ?? 0)}`;
      if (this.ledger.seenKeys.has(eventKey)) continue;
      const ts = await this.blockTimestamp(entry.blockNumber);
      let gasEth = 0; let gasUsd = 0; let txFrom = null;
      try {
        const [receipt, tx] = await Promise.all([
          this.providers.readProvider.getTransactionReceipt(entry.transactionHash),
          this.providers.readProvider.getTransaction(entry.transactionHash)
        ]);
        txFrom = tx?.from || null;
        if (receipt && tx && tx.from?.toLowerCase() === this.config.walletAddress.toLowerCase()) {
          const gasPrice = receipt.gasPrice || tx.gasPrice || 0n;
          gasEth = Number(formatUnits(receipt.gasUsed * gasPrice, 18));
          gasUsd = gasEth * this.priceOf(ZERO_ADDRESS);
        }
      } catch {}
      this.ledger.appendUnique(eventKey, `lp.${kind}`, {
        poolId: pool.id,
        pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
        positionId: rangeId,
        hash: entry.transactionHash,
        blockNumber: entry.blockNumber,
        liquidity: lifecycleLiquidity(entry).toString(),
        txFrom,
        gasEth,
        gasUsd
      }, ts);
    }
  }

  async blockTimestamp(blockNumber) {
    if (this.blockTimeCache.has(blockNumber)) return this.blockTimeCache.get(blockNumber);
    const block = await this.providers.readProvider.getBlock(blockNumber);
    const ms = block ? Number(block.timestamp) * 1000 : Date.now();
    this.blockTimeCache.set(blockNumber, ms);
    if (this.blockTimeCache.size > 2000) this.blockTimeCache.delete(this.blockTimeCache.keys().next().value);
    return ms;
  }

  priceOf(address) {
    return Number(this.market.prices.get(String(address).toLowerCase()) || 0);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.initialize();
    while (this.running) {
      const started = Date.now();
      try { await this.runOnce(); }
      catch (error) {
        this.ledger.append('cycle.failed', { error: error.message });
        log('error', 'cycle.failed', { error: error.stack || error.message });
      }
      const wait = Math.max(1000, this.config.pollIntervalMs - (Date.now() - started));
      await sleep(wait);
    }
  }

  stop() { this.running = false; }
}

function uniqueTargetTokens(pools) {
  const map = new Map();
  for (const pool of pools) {
    map.set(pool.token0.address.toLowerCase(), pool.token0);
    map.set(pool.token1.address.toLowerCase(), pool.token1);
  }
  return [...map.values()];
}
function snapshotPool(pool) {
  return {
    id: pool.id,
    pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
    hook: pool.key.hooks,
    tick: pool.state?.tick ?? null,
    tickSpacing: pool.key.tickSpacing,
    paused: pool.state?.paused ?? null,
    positions: (pool.positions || []).map((p) => ({
      id: p.id, shares: p.shares.toString(), tickLower: p.tickLower, tickUpper: p.tickUpper,
      outside: p.outside, confirmations: p.confirmations, target: p.target,
      rebalancePlan: p.rebalancePlan || null, rebalanceQuote: p.rebalanceQuote || null
    }))
  };
}
function positionStateKey(pool, position) {
  return `${pool.id.toLowerCase()}:${position.id.toLowerCase()}`;
}
function sameStringArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function emptyPortfolio() {
  return {
    baseline: null,
    inventory: {},
    currentValueUsd: 0,
    hodlValueUsd: 0,
    grossPnlUsd: 0,
    netPnlUsd: 0,
    excessVsHodlUsd: 0,
    currentIlUsd: 0,
    gasUsd: 0,
    trackedFeeUsd: 0,
    netCashflowUsd: 0,
    positions: []
  };
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
