import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Interface, formatUnits, getAddress, id, Wallet } from 'ethers';
import { createProviders, probeRpcEndpoint, verifyProviders } from './rpc/providers.js';
import { FablesAdapter, lifecycleEventType, lifecycleLiquidity } from './adapters/fables.js';
import { RebalanceExecutor } from './adapters/executor.js';
import { V4QuoterAdapter } from './adapters/quoter.js';
import { fetchFablesPoolStats, fetchFablesPoolTvl } from './adapters/fables-stats.js';
import { fetchWalletCashflowCandidates, fetchEthUsdCloseAt, fetchNativeBalanceAt } from './adapters/wallet-cashflows.js';
import { buildUsdPriceMap } from './analytics/prices.js';
import { computeAllocationFunding, normalizeInvestmentAllocation, valuePoolPositionsUsdG } from './analytics/allocation.js';
import { PortfolioAnalytics } from './analytics/portfolio.js';
import { captureLpSessionReference, evaluateStopLoss, normalizeStopLoss } from './analytics/stop-loss.js';
import { executeStopLiquidation, reconcileStopLiquidation } from './execution/stop-liquidation.js';
import { rebalanceTiming } from './dashboard/rebalance-timing.js';
import { describeExecutionProgress } from './dashboard/execution-progress.js';
import { PointsTracker } from './analytics/points-tracker.js';
import { POINTS_DAY_MS, pointsCampaignDayStartMs } from './analytics/points.js';
import { valueSwapFeeInUsd } from './analytics/points-accounting.js';
import { buildDepositPlan } from './analytics/rebalance-plan.js';
import { chooseInvestmentAnchor, rankAprPools } from './execution/investment-target.js';
import { probePoolSwapCosts } from './execution/pool-quote-probes.js';
import { evaluatePosition } from './strategy.js';
import { LedgerStore } from './ledger.js';
import { StateStore } from './state.js';
import { normalizeRuntimeIntervals } from './config.js';
import { persistRuntimeCredentials } from './runtime-credentials.js';
import { DEFAULT_RPC_URL, ZERO_ADDRESS } from './constants.js';
import { isRpcRateLimitError, isRpcTimeoutError } from './rpc/errors.js';
import { isLpOutOfRange } from './math/ticks.js';
import { buildExactWithdrawBounds } from './math/v4-fixed.js';
import { spotToken1PerToken0 } from './analytics/liquidity.js';
import { EIP7702_GUARD_ABI, HOOK_ABI } from './abi.js';
import { log, registerSensitiveValues, sanitize } from './logger.js';

const hookInterface = new Interface(HOOK_ABI);
const guardInterface = new Interface(EIP7702_GUARD_ABI);
const transferTopic = id('Transfer(address,address,uint256)').toLowerCase();
const PROLOGUE_FEE_DISTRIBUTOR = '0xc9ecc11728a4955b31f77c077b97fec521d78760';
const REBALANCE_FAILURE_BASE_MS = 60_000;
const REBALANCE_FAILURE_MAX_MS = 30 * 60_000;
const RPC_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const RPC_TIMEOUT_BACKOFF_MS = 2 * 60_000;

function hasNativeCurrency(pool) {
  return [pool?.token0, pool?.token1].some((token) =>
    String(token?.address || '').toLowerCase() === ZERO_ADDRESS);
}

function rebalanceFailureKey(pool, position) {
  return `${String(pool.id).toLowerCase()}:${String(position.id).toLowerCase()}`;
}

function rebalanceFailureMap(state) {
  const saved = state.getSetting('rebalanceFailureBackoffs', {});
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
}

function recordRebalanceFailure(state, ledger, pool, position, reason) {
  const now = Date.now();
  const key = rebalanceFailureKey(pool, position);
  const previous = rebalanceFailureMap(state)[key];
  const count = previous && now - Number(previous.updatedAt || 0) < 24 * 60 * 60_000
    ? Math.min(32, Number(previous.count || 0) + 1)
    : 1;
  const delayMs = Math.min(REBALANCE_FAILURE_MAX_MS,
    REBALANCE_FAILURE_BASE_MS * 2 ** Math.min(count - 1, 5));
  const entry = { poolId: pool.id, positionId: position.id, count, updatedAt: now,
    nextRetryAt: now + delayMs, reason: sanitize(String(reason || 'unknown failure')) };
  const recent = Object.fromEntries(Object.entries(rebalanceFailureMap(state))
    .filter(([, item]) => now - Number(item?.updatedAt || 0) < 24 * 60 * 60_000));
  recent[key] = entry;
  state.setSetting('rebalanceFailureBackoffs', recent);
  ledger.append('rebalance.backoff', entry);
  if (count === 3) ledger.append('rebalance.needs_attention', entry);
  return entry;
}

function clearRebalanceFailure(state, pool, position) {
  const key = rebalanceFailureKey(pool, position);
  const saved = rebalanceFailureMap(state);
  if (!(key in saved)) return;
  const next = { ...saved };
  delete next[key];
  state.setSetting('rebalanceFailureBackoffs', next);
}

export class AutoLpBot {
  constructor(config) {
    this.config = config;
    this.manualRotationPreview = null;
    this.baseExecutionTarget = {
      mode: config.targetMode,
      poolIds: [...(config.targetPoolIds || [])],
      symbols: [...(config.targetSymbols || [])]
    };
    registerSensitiveValues([...(config.rpcUrls || []), config.privateKey || '', config.blockscoutApiKey || '']);
    this.baseDataDir = config.dataDir;
    this.baseStateFile = config.stateFile;
    this.preferenceState = new StateStore(path.join(this.baseDataDir, 'dashboard-settings.json'));
    const savedIntervals = this.preferenceState.getSetting('runtimeIntervals', null);
    if (savedIntervals) Object.assign(this.config, normalizeRuntimeIntervals({ ...this.getRuntimeIntervals(), ...savedIntervals }));
    this.initialWalletAddress = config.walletAddress.toLowerCase();
    const savedWalletDir = path.join(this.baseDataDir, 'wallets', this.initialWalletAddress);
    const savedWalletState = path.join(savedWalletDir, 'bot-state.json');
    if (fs.existsSync(savedWalletState)) {
      this.config.dataDir = savedWalletDir;
      this.config.stateFile = savedWalletState;
    }
    this.walletProfiles = new Map([[this.initialWalletAddress, {
      address: config.walletAddress,
      privateKey: config.privateKey || '',
      type: config.privateKey ? 'environment' : 'watch-only',
      importedAt: null
    }]]);
    this.walletImportState = config.walletAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()
      ? { status: 'failed', address: config.walletAddress, error: '尚未設定有效的監控錢包地址' }
      : { status: 'scanning', address: config.walletAddress, error: null };
    this.providers = createProviders(config);
    this.rpcEndpointIdByUrl = new Map((config.rpcUrls || []).map((endpoint) => [endpoint, randomUUID()]));
    this.rpcDiagnostics = new Map();
    this.activeRpcUrls = [];
    this.rpcManagementActive = false;
    this.guardReadinessCache = new WeakMap();
    this.initializing = false;
    this.state = new StateStore(config.stateFile);
    this.applyStoredExecutionTarget();
    this.ledger = new LedgerStore(config.dataDir);
    this.fables = new FablesAdapter(this.providers.readProvider, config);
    this.quoter = new V4QuoterAdapter(this.providers.readProvider);
    this.analytics = new PortfolioAnalytics(config, this.ledger, this.state);
    this.points = new PointsTracker(config, this.ledger, this.state);
    this.market = { refreshedAt: 0, stateRefreshedAt: 0, pools: [], prices: new Map(), latestBlock: 0, fablesStats: null };
    this.rpcHealth = [];
    this.resumeExecutionAfterStartup = this.state.getSetting('executionPaused', true) === false
      && !this.state.getSetting('stopLossLatched', false);
    this.executionPaused = true;
    // Keep the persisted operator intent until the first healthy wallet scan.
    // If this process dies during startup, the next one must still retry the
    // previously running monitor instead of treating boot as an explicit pause.
    this.nextMonitorAt = null;
    this.snapshot = this.ledger.readSnapshot();
    this.allocationFunding = null;
    this.running = false;
    this.cycleActive = false;
    this.globalPointScanPromise = null;
    this.pointsSimulationTimer = null;
    this.blockTimeCache = new Map();
    this.executor = new RebalanceExecutor(
      this.providers.readProvider,
      this.providers.writeProvider,
      config,
      this.fables,
      this.ledger,
      (address) => this.market.prices.get(String(address).toLowerCase()) || 0,
      this.state
    );
  }

  async initialize() {
    if (this.initializing) throw new Error('Bot initialization is already in progress');
    this.initializing = true;
    try {
      // Rebuild from the full configured URL list. useHealthyRpcEndpoints may
      // have narrowed rawProviders after an earlier boot, while config.rpcUrls
      // intentionally retains unhealthy entries for recovery and operator UI.
      this.providers = createProviders(this.config);
      this.fables = new FablesAdapter(this.providers.readProvider, this.config);
      this.quoter = new V4QuoterAdapter(this.providers.readProvider);
      this.executor = this.createExecutor();
      try {
        this.rpcHealth = await verifyProviders(this.providers.rawProviders, this.config.chainId, this.config.rpcUrls);
      } catch (error) {
        if (Array.isArray(error.rpcHealth)) this.rpcHealth = error.rpcHealth;
        this.activeRpcUrls = [];
        this.rpcHealth.forEach((result, index) => {
          const endpoint = this.config.rpcUrls[index];
          if (endpoint) this.rpcDiagnostics.set(endpoint, result);
        });
        throw error;
      }
      this.rpcHealth.forEach((result, index) => {
        const endpoint = this.config.rpcUrls[index];
        if (endpoint) this.rpcDiagnostics.set(endpoint, result);
      });
      log('info', 'rpc.health', { endpoints: this.rpcHealth.map((x) => ({ index: x.index, ok: x.ok, chainId: x.chainId })) });
      this.useHealthyRpcEndpoints();
      await reconcileStopLiquidation(this.executor);
      await this.executor.reconcileStartupJournal();
      const stopped = this.state.getSetting('stopLiquidationStatus', null);
      if (['queued', 'running'].includes(stopped?.status)) {
        this.state.setSetting('stopLiquidationStatus', { ...stopped, status: 'failed',
          error: '服務中斷；已維持停止狀態，請查看交易復原狀態後重試剩餘清倉。', at: Date.now() });
      }
      await this.refreshMarket(true);
    } finally {
      this.initializing = false;
    }
  }

  useHealthyRpcEndpoints() {
    const healthy = this.rpcHealth.filter((entry) => entry.ok).map((entry) => entry.index);
    this.activeRpcUrls = healthy.map((index) => this.config.rpcUrls[index]);
    if (!healthy.length || (healthy.length === this.config.rpcUrls.length && healthy[0] === 0)) return;
    const usableUrls = healthy.map((index) => this.config.rpcUrls[index]);
    this.providers = createProviders({ ...this.config, rpcUrls: usableUrls });
    this.fables = new FablesAdapter(this.providers.readProvider, this.config);
    this.quoter = new V4QuoterAdapter(this.providers.readProvider);
    this.executor = this.createExecutor();
    log('warn', 'rpc.unhealthy_endpoints_skipped', {
      configured: this.config.rpcUrls.length,
      healthyIndices: healthy
    });
  }

  setExecutionPaused(value, source = 'system') {
    const next = Boolean(value);
    if (next && source === 'dashboard') this.resumeExecutionAfterStartup = false;
    if (!next && source !== 'startup-restore') this.resumeExecutionAfterStartup = false;
    if (!next) {
      if (this.state.getSetting('stopLossLatched', false)) throw new Error('已停止清倉；請確認清倉結果後重新設定停損基準才能啟動。');
      const activeExecution = this.state.getSetting('activeRebalanceExecution', null);
      const terminal = new Set(['completed', 'failed']);
      if (activeExecution?.phase && !terminal.has(activeExecution.phase)) {
        throw new Error(`Cannot resume while rebalance execution requires review: ${activeExecution.phase}`);
      }
    }
    this.executionPaused = next;
    this.state.setSetting('executionPaused', this.executionPaused);
    this.ledger.append('execution.control', { paused: this.executionPaused, source });
    if (this.snapshot?.bot) this.snapshot.bot.executionPaused = this.executionPaused;
    log('warn', 'execution.control', { paused: this.executionPaused, source });
  }

  async controlStatus() {
    const activeExecution = this.state.getSetting('activeRebalanceExecution', null);
    const signerConfigured = Boolean(this.config.privateKey);
    const guardConfigured = Boolean(this.config.eip7702GuardAddress);
    const guardVerifiedFlag = Boolean(this.config.eip7702GuardVerified);
    let guardRuntimeReady = false;
    let guardError = null;
    if (guardConfigured && guardVerifiedFlag) {
      const guardStatus = await this.getUiGuardReadiness();
      guardRuntimeReady = guardStatus.ready;
      guardError = guardStatus.error;
    }
    const topologyCooldownUntil = Number(this.state.getSetting('walletTopologyCooldownUntil', 0) || 0);
    const recoveryRequired = activeExecution?.phase === 'recovery_required';
    const terminalExecution = new Set(['completed', 'failed']);
    const executionBusy = Boolean(activeExecution?.phase && !terminalExecution.has(activeExecution.phase));
    const executionUpdatedAt = Number(activeExecution?.updatedAt || activeExecution?.startedAt || 0);
    const staleExecution = executionBusy && executionUpdatedAt > 0
      && Date.now() - executionUpdatedAt > Math.max(5 * 60_000, this.config.rpcRequestTimeoutMs * 2);
    const rebalanceBackoffs = Object.values(rebalanceFailureMap(this.state))
      .filter((entry) => Date.now() < Number(entry?.nextRetryAt || 0));
    const rebalanceNeedsAttention = rebalanceBackoffs.some((entry) => Number(entry.count || 0) >= 3);
    const liveReady = !this.config.dryRun
      && this.config.enableLiveWrites
      && this.config.enableAutoRedeploy
      && signerConfigured
      && guardConfigured
      && guardVerifiedFlag
      && guardRuntimeReady
      && !this.executionPaused
      && !this.cycleActive
      && !executionBusy
      && !recoveryRequired;
    const startBlockers = [];
    const stopLoss = this.getStopLossSnapshot();
    if (stopLoss.latched) startBlockers.push('stop-loss-latched');
    else if (stopLoss.settings.enabled && stopLoss.status === 'unavailable') startBlockers.push('stop-loss-valuation-unavailable');
    const allocationConfig = this.getInvestmentAllocationConfig();
    const allocationEnabled = allocationConfig.enabled === true;
    const allocationSnapshot = allocationEnabled ? this.getInvestmentAllocationSnapshot() : null;
    const selectedTargetPoolId = this.getSelectedExecutionTargetPoolId();
    if (!allocationEnabled && !selectedTargetPoolId) startBlockers.push('target-required');
    else if (!allocationEnabled && !this.market.pools.some((pool) => pool.id.toLowerCase() === selectedTargetPoolId)) startBlockers.push('target-unavailable');
    const selectedPool = this.snapshot?.pools?.find((pool) => pool.id.toLowerCase() === selectedTargetPoolId);
    const investmentMode = this.getInvestmentTargetSettings().mode;
    const activeLp = ['apr-highest', 'specific-pool'].includes(investmentMode)
      ? Boolean((this.snapshot?.portfolio?.positions || []).some((position) => BigInt(position.shares || 0) > 0n))
      : Boolean(selectedPool?.positions?.some((position) => BigInt(position.shares || 0) > 0n));
    if (!this.config.walletAddress || this.config.walletAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      startBlockers.push('wallet-address-missing');
    } else if (this.walletImportState.status !== 'ready') {
      startBlockers.push(`wallet-${this.walletImportState.status || 'not-ready'}`);
    }
    if (!this.rpcHealth.some((item) => item.ok && Number(item.chainId) === this.config.chainId)) startBlockers.push('rpc-not-ready');
    // Starting only lifts the pause flag. The running cycle still rechecks
    // pool state, wallet topology, and the complete transaction path before
    // moving funds, so a routine scan must not disable the start control.
    if (recoveryRequired) startBlockers.push('recovery-required');
    else if (executionBusy) startBlockers.push('execution-busy');
    if (allocationEnabled && (allocationSnapshot?.status !== 'ready'
      || allocationSnapshot?.priceStatus?.status !== 'fresh')) {
      startBlockers.push(allocationConfig.invalid ? 'allocation-config-invalid' : 'allocation-valuation-not-ready');
    }
    if (!this.config.dryRun) {
      if (!allocationEnabled && !activeLp) startBlockers.push('active-lp-required');
      const snapshotAge = Date.now() - Number(this.snapshot?.generatedAt || 0);
      if (snapshotAge > Math.max(120_000, this.config.pollIntervalMs * 3)) startBlockers.push('wallet-snapshot-stale');
      if (!this.config.enableLiveWrites) startBlockers.push('live-writes-disabled');
      if (!this.config.enableAutoRedeploy) startBlockers.push('auto-redeploy-disabled');
      if (!signerConfigured) startBlockers.push('signer-required');
      if (!guardConfigured || !guardVerifiedFlag || !guardRuntimeReady) startBlockers.push('guard-not-ready');
    }

    const status = {
      generatedAt: Date.now(),
      mode: this.config.dryRun ? 'dry-run' : 'live',
      walletAddress: this.config.walletAddress,
      walletImportState: this.walletImportState,
      walletProfiles: [...this.walletProfiles.values()].map((profile) => ({
        address: profile.address,
        type: profile.type,
        signerConfigured: Boolean(profile.privateKey),
        importedAt: profile.importedAt,
        active: profile.address.toLowerCase() === this.config.walletAddress.toLowerCase()
      })),
      rpc: {
        customConfigured: this.config.rpcUrls.some((url) => url !== DEFAULT_RPC_URL),
        customHealthy: this.config.rpcUrls.some((url, index) => url !== DEFAULT_RPC_URL && this.rpcHealth[index]?.ok),
        endpointCount: this.config.rpcUrls.length,
        activeEndpointCount: this.providers.rawProviders.length,
        chainId: this.config.chainId
      },
      runtimeIntervals: this.getRuntimeIntervals(),
      stopLoss,
      targetMode: this.config.targetMode,
      selectedExecutionTargetPoolId: selectedTargetPoolId || null,
      investmentTarget: this.getInvestmentTargetSnapshot(),
      investmentAllocation: allocationSnapshot,
      dryRun: this.config.dryRun,
      liveWrites: this.config.enableLiveWrites,
      autoRedeploy: this.config.enableAutoRedeploy,
      autoTopupEnabled: this.config.autoTopupEnabled,
      autoTopupSwapEnabled: this.config.autoTopupSwapEnabled,
      externalSwapRoutesEnabled: this.config.externalSwapRoutesEnabled,
      executionPaused: this.executionPaused,
      cycleActive: this.cycleActive,
      nextMonitorAt: this.nextMonitorAt,
      signerConfigured,
      credentialPersistenceEnabled: Boolean(this.config.persistRuntimeCredentials),
      guard: {
        address: this.config.eip7702GuardAddress || null,
        configured: guardConfigured,
        verifiedFlag: guardVerifiedFlag,
        runtimeReady: guardRuntimeReady,
        error: guardError
      },
      activeRebalanceExecution: activeExecution,
      recoveryRequired,
      executionBusy,
      staleExecution,
      rebalanceBackoffs,
      rebalanceNeedsAttention,
      topologyCooldownUntil,
      liveReady,
      manualIdleReady: !activeLp && this.config.dashboardManualControlEnabled
        && this.resumeExecutionAfterStartup
        && startBlockers.every((blocker) => [
          'active-lp-required', 'target-required', 'target-unavailable'
        ].includes(blocker)),
      startReadiness: { ready: startBlockers.length === 0, blockers: startBlockers },
      limits: {
        maxGasGwei: this.config.maxGasGwei,
        withdrawSlippageBps: this.config.withdrawSlippageBps,
        swapSlippageBps: this.config.swapSlippageBps,
        maxSwapPriceImpactBps: this.config.maxSwapPriceImpactBps,
        crossPoolMaxSwapPriceImpactBps: this.config.crossPoolMaxSwapPriceImpactBps,
        depositSlippageBps: this.config.depositSlippageBps,
        minRebalanceIntervalSec: this.config.minRebalanceIntervalSec,
        maxRebalancesPerHour: this.config.maxRebalancesPerHour
      },
      topup: {
        enabled: this.config.autoTopupEnabled,
        swapEnabled: this.config.autoTopupSwapEnabled,
        swapPoolId: this.config.autoTopupSwapPoolId || null,
        maxSwapPriceImpactBps: this.config.autoTopupMaxSwapPriceImpactBps,
        minIdleUsd: this.config.autoTopupMinIdleUsd,
        dustBps: this.config.autoTopupDustBps,
        minIntervalSec: this.config.autoTopupMinIntervalSec
      },
      strategy: {
        absoluteInRangeHold: true,
        tightWidthBps: this.config.tightWidthBps,
        rangePreset: this.config.rangePreset,
        ...rangePolicySnapshot(this.config)
      }
    };
    status.rebalanceTiming = rebalanceTiming(status, this.snapshot, status.generatedAt);
    status.executionProgress = this.getExecutionProgress();
    return status;
  }

  getExecutionProgress() {
    const active = this.state.getSetting('activeRebalanceExecution', null);
    if (active) return describeExecutionProgress(active);
    return this.state.getSetting('lastExecutionProgress', null);
  }

  // The two-second dashboard feed reads only in-memory state. In particular it
  // must not call controlStatus(), guard probes, providers, or explorer APIs.
  getExecutionStatus() {
    const journal = this.state.getSetting('activeRebalanceExecution', null);
    const executionBusy = Boolean(journal?.phase && !['completed', 'failed'].includes(journal.phase));
    const updatedAt = Number(journal?.updatedAt || journal?.startedAt || 0);
    const status = {
      generatedAt: Date.now(), walletAddress: this.config.walletAddress,
      executionPaused: this.executionPaused, cycleActive: this.cycleActive,
      executionBusy, recoveryRequired: journal?.phase === 'recovery_required',
      staleExecution: executionBusy && updatedAt > 0
        && Date.now() - updatedAt > Math.max(5 * 60_000, (this.config.rpcRequestTimeoutMs || 30_000) * 2),
      nextMonitorAt: this.nextMonitorAt || null,
      selectedExecutionTargetPoolId: this.getSelectedExecutionTargetPoolId(),
      rebalanceBackoffs: Object.values(rebalanceFailureMap(this.state))
        .filter(entry => Date.now() < Number(entry?.nextRetryAt || 0)),
      strategy: { ...rangePolicySnapshot(this.config) },
      executionProgress: this.getExecutionProgress()
    };
    status.rebalanceTiming = rebalanceTiming(status, this.snapshot, status.generatedAt);
    return status;
  }

  getRuntimeIntervals() {
    return {
      marketRefreshMs: this.config.marketRefreshMs,
      rangeCheckIntervalMs: this.config.rangeCheckIntervalMs,
      pointsSimulationIntervalMs: this.config.pointsSimulationIntervalMs
    };
  }

  setRuntimeIntervals(values = {}) {
    const previous = this.getRuntimeIntervals();
    const intervals = normalizeRuntimeIntervals({ ...this.getRuntimeIntervals(), ...values });
    Object.assign(this.config, intervals);
    this.preferenceState.setSetting('runtimeIntervals', intervals);
    if (intervals.marketRefreshMs !== previous.marketRefreshMs) this.market.refreshedAt = 0;
    if (intervals.pointsSimulationIntervalMs !== previous.pointsSimulationIntervalMs) {
      this.points?.invalidate();
      this.updatePointsSnapshot(true);
      this.schedulePointsSimulation();
    }
    log('info', 'dashboard.intervals_updated', intervals);
    return intervals;
  }

  updatePointsSnapshot(force = false) {
    const points = this.points.snapshot({ force });
    if (this.snapshot) {
      this.snapshot = { ...this.snapshot, points };
      this.ledger.writeSnapshot(this.snapshot);
    }
    return points;
  }

  schedulePointsSimulation() {
    if (this.pointsSimulationTimer) clearTimeout(this.pointsSimulationTimer);
    this.pointsSimulationTimer = null;
    if (!this.running) return;
    this.pointsSimulationTimer = setTimeout(async () => {
      this.pointsSimulationTimer = null;
      if (!this.running) return;
      try {
        const tracker = this.points;
        await tracker.refreshEvidence({
          address: this.config.walletAddress,
          provider: this.providers.readProvider,
          pools: this.market.pools,
          prices: this.market.prices
        });
        if (this.running && tracker === this.points) this.updatePointsSnapshot(true);
      }
      catch (error) { log('warn', 'points.simulation_failed', { error: error.message }); }
      this.schedulePointsSimulation();
    }, this.config.pointsSimulationIntervalMs);
    this.pointsSimulationTimer.unref?.();
  }

  rpcMutationBlocker() {
    if (this.rpcManagementActive) return 'busy';
    if (this.initializing) return 'busy';
    if (this.cycleActive) return 'busy';
    if (this.globalPointScanPromise) return 'busy';
    const active = this.state.getSetting('activeRebalanceExecution', null);
    if (active?.phase && !new Set(['completed', 'failed']).has(active.phase)) return 'busy';
    return null;
  }

  assertRpcIdle() {
    const blocker = this.rpcMutationBlocker();
    if (blocker) throw new Error('busy');
  }

  rpcId(endpoint) {
    if (!this.rpcEndpointIdByUrl.has(endpoint)) this.rpcEndpointIdByUrl.set(endpoint, randomUUID());
    return this.rpcEndpointIdByUrl.get(endpoint);
  }

  rpcResult(endpoint, index, diagnostic = this.rpcDiagnostics.get(endpoint)) {
    const fallback = this.rpcHealth[index] || {};
    const status = diagnostic || fallback;
    return {
      id: this.rpcId(endpoint),
      label: maskRpcEndpointLabel(endpoint),
      priority: index + 1,
      active: this.activeRpcUrls.includes(endpoint),
      chainId: Number.isFinite(status.chainId) ? status.chainId : null,
      reachable: Boolean(status.reachable ?? status.ok),
      chainValid: Boolean(status.chainValid ?? (status.ok && Number(status.chainId) === this.config.chainId)),
      latencyMs: Number.isFinite(status.latencyMs) ? status.latencyMs : null,
      blockNumber: Number.isSafeInteger(status.blockNumber) ? status.blockNumber : null,
      errorType: status.errorType ?? (this.isHealthyRpcStatus(status) ? null : status.ok ? null : 'unknown'),
      checkedAt: status.checkedAt || null,
      removable: true
    };
  }

  isHealthyRpcStatus(status) {
    return Boolean(status?.reachable ?? status?.ok)
      && Boolean(status?.chainValid ?? (status?.ok && Number(status.chainId) === this.config.chainId))
      && Number(status?.chainId) === this.config.chainId
      && status?.errorType == null
      && Number.isSafeInteger(status?.blockNumber) && status.blockNumber >= 0;
  }

  getRpcSettings() {
    const endpoints = this.config.rpcUrls.map((endpoint, index) => this.rpcResult(endpoint, index));
    const healthy = endpoints.some((entry) => this.isHealthyRpcStatus(entry));
    return { ok: true, chainId: this.config.chainId, persisted: Boolean(this.config.persistRuntimeCredentials),
      latestBlockNumber: Math.max(0, ...endpoints.map((entry) => entry.blockNumber || 0)) || null,
      endpoints: endpoints.map((entry) => ({ ...entry, removable: endpoints.length > 1 })),
      healthyEndpointCount: endpoints.filter((entry) => this.isHealthyRpcStatus(entry)).length,
      hasHealthyEndpoint: healthy };
  }

  async probeRpcById(id) {
    this.assertRpcIdle();
    const endpoint = [...this.rpcEndpointIdByUrl].find(([, value]) => value === String(id || ''))?.[0];
    if (!endpoint || !this.config.rpcUrls.includes(endpoint)) throw new Error('invalid_id');
    this.rpcManagementActive = true;
    try {
      const result = await probeRpcEndpoint(endpoint, this.config.chainId, { timeoutMs: Math.min(8000, this.config.rpcRequestTimeoutMs || 8000) });
      this.rpcDiagnostics.set(endpoint, result);
      const index = this.config.rpcUrls.indexOf(endpoint);
      this.rpcHealth[index] = { index, ...result, ok: this.isHealthyRpcStatus(result) };
      return { ok: true, result: this.rpcResult(endpoint, index, result) };
    } finally {
      this.rpcManagementActive = false;
    }
  }

  async addRpcEndpoint(value) {
    this.assertRpcIdle();
    const endpoint = String(value || '').trim();
    if (!endpoint || endpoint.length > 2048) throw new Error(endpoint ? 'invalid_url' : 'invalid_url');
    let parsed;
    try { parsed = new URL(endpoint); } catch { throw new Error('invalid_url'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('invalid_url');
    if (this.config.rpcUrls.includes(endpoint)) throw new Error('duplicate');
    this.rpcManagementActive = true;
    try {
      const diagnostic = await probeRpcEndpoint(endpoint, this.config.chainId, { timeoutMs: Math.min(8000, this.config.rpcRequestTimeoutMs || 8000) });
      this.rpcDiagnostics.set(endpoint, diagnostic);
      if (!diagnostic.reachable || !diagnostic.chainValid || diagnostic.errorType
        || !Number.isSafeInteger(diagnostic.blockNumber) || diagnostic.blockNumber < 0) {
        const error = new Error(diagnostic.errorType || 'wrong_chain');
        error.rpcResult = { ...this.rpcResult(endpoint, this.config.rpcUrls.length, diagnostic), removable: false };
        throw error;
      }
      await this.applyRpcEndpointSet([endpoint, ...this.config.rpcUrls], new Map([[endpoint, diagnostic]]));
      return { ok: true, result: this.rpcResult(endpoint, 0), persisted: Boolean(this.config.persistRuntimeCredentials),
        healthyEndpointCount: this.getRpcSettings().healthyEndpointCount };
    } finally {
      this.rpcManagementActive = false;
    }
  }

  async removeRpcEndpoint(id) {
    this.assertRpcIdle();
    const endpoint = [...this.rpcEndpointIdByUrl].find(([, value]) => value === String(id || ''))?.[0];
    if (!endpoint || !this.config.rpcUrls.includes(endpoint)) throw new Error('invalid_id');
    if (this.config.rpcUrls.length <= 1) throw new Error('last_healthy');
    this.rpcManagementActive = true;
    try {
      const nextUrls = this.config.rpcUrls.filter((item) => item !== endpoint);
      await this.applyRpcEndpointSet(nextUrls);
      this.rpcEndpointIdByUrl.delete(endpoint);
      this.rpcDiagnostics.delete(endpoint);
      return { ok: true, removedId: String(id), persisted: Boolean(this.config.persistRuntimeCredentials),
        healthyEndpointCount: this.getRpcSettings().healthyEndpointCount };
    } finally {
      this.rpcManagementActive = false;
    }
  }

  async applyRpcEndpointSet(urls, knownDiagnostics = new Map()) {
    const diagnostics = [];
    for (const endpoint of urls) {
      const result = knownDiagnostics.get(endpoint)
        || await probeRpcEndpoint(endpoint, this.config.chainId, { timeoutMs: Math.min(8000, this.config.rpcRequestTimeoutMs || 8000) });
      this.rpcDiagnostics.set(endpoint, result);
      diagnostics.push({ index: diagnostics.length, ...result,
        ok: result.reachable && result.chainValid && result.errorType == null
          && Number.isSafeInteger(result.blockNumber) && result.blockNumber >= 0 });
    }
    await this.applyRpcUrls(urls, diagnostics, { persist: true });
  }

  async applyRpcUrls(urls, health, { persist = false } = {}) {
    const orderedUrls = [...urls];
    const diagnostics = health.map((entry, index) => ({ ...entry, index }));
    if (orderedUrls.length !== diagnostics.length) throw new Error('invalid_response');
    const healthyUrls = diagnostics.filter((entry) => entry.ok && entry.chainValid
      && Number(entry.chainId) === this.config.chainId && entry.errorType == null
      && Number.isSafeInteger(entry.blockNumber) && entry.blockNumber >= 0).map((entry) => orderedUrls[entry.index]);
    if (!healthyUrls.length) throw new Error('last_healthy');
    if (persist) {
      persistRuntimeCredentials({ rpcUrls: orderedUrls, walletAddress: this.config.walletAddress, privateKey: this.config.privateKey },
        { enabled: this.config.persistRuntimeCredentials, filePath: this.config.runtimeCredentialsFile || path.resolve('.env') });
    }
    const previousEndpoints = new Set(this.config.rpcUrls);
    this.config.rpcUrls = orderedUrls;
    this.rpcHealth = diagnostics;
    diagnostics.forEach((result, index) => this.rpcDiagnostics.set(orderedUrls[index], result));
    for (const endpoint of orderedUrls) this.rpcId(endpoint);
    for (const endpoint of previousEndpoints) {
      if (!orderedUrls.includes(endpoint)) {
        this.rpcEndpointIdByUrl.delete(endpoint);
        this.rpcDiagnostics.delete(endpoint);
      }
    }
    registerSensitiveValues([...orderedUrls, ...[...this.walletProfiles.values()].map((profile) => profile.privateKey),
      this.config.blockscoutApiKey || '']);
    this.providers = createProviders({ ...this.config, rpcUrls: healthyUrls });
    this.activeRpcUrls = healthyUrls;
    this.fables = new FablesAdapter(this.providers.readProvider, this.config);
    this.quoter = new V4QuoterAdapter(this.providers.readProvider);
    this.executor = this.createExecutor();
    this.market.refreshedAt = 0;
    this.market.stateRefreshedAt = 0;
  }

  async setRpcEndpoint(value) {
    const result = await this.addRpcEndpoint(value);
    return { ok: true, chainId: this.config.chainId, endpointCount: this.config.rpcUrls.length, ...result };
  }

  async mountWallet(addressValue, privateKey, type) {
    if (this.initializing || this.rpcManagementActive) throw new Error('busy');
    if (this.cycleActive) throw new Error('Wait for the current monitor cycle before mounting another wallet');
    const activeExecution = this.state.getSetting('activeRebalanceExecution', null);
    if (activeExecution?.phase && !new Set(['completed', 'failed']).has(activeExecution.phase)) {
      throw new Error('Resolve the active wallet recovery journal before switching wallets');
    }

    let address;
    try { address = getAddress(addressValue); }
    catch { throw new Error('Wallet address did not validate'); }
    if (address.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      throw new Error('Zero address cannot be used as a monitoring wallet');
    }
    let normalizedKey = '';
    if (privateKey) {
      try {
        const signer = new Wallet(privateKey);
        if (signer.address.toLowerCase() !== address.toLowerCase()) {
          throw new Error('address mismatch');
        }
        normalizedKey = signer.privateKey;
      } catch {
        throw new Error('Wallet signer did not validate for this address');
      }
    }

    const profile = {
      address,
      privateKey: normalizedKey,
      type,
      importedAt: Date.now()
    };
    persistRuntimeCredentials({
      rpcUrls: this.config.rpcUrls,
      walletAddress: profile.address,
      privateKey: profile.privateKey
    }, { enabled: this.config.persistRuntimeCredentials });
    this.walletProfiles.set(address.toLowerCase(), profile);
    registerSensitiveValues([
      ...(this.config.rpcUrls || []),
      ...[...this.walletProfiles.values()].map((item) => item.privateKey),
      this.config.blockscoutApiKey || ''
    ]);
    this.activateWalletProfile(profile);
    return { ok: true, address, status: this.walletImportState.status };
  }

  switchWallet(addressValue) {
    if (this.cycleActive) throw new Error('Wait for the current monitor cycle before switching wallets');
    const profile = this.walletProfiles.get(String(addressValue || '').toLowerCase());
    if (!profile) throw new Error('Wallet is not mounted in this session');
    persistRuntimeCredentials({
      rpcUrls: this.config.rpcUrls,
      walletAddress: profile.address,
      privateKey: profile.privateKey
    }, { enabled: this.config.persistRuntimeCredentials });
    this.activateWalletProfile(profile);
    return { ok: true, address: profile.address, status: this.walletImportState.status };
  }

  setWatchedPool(poolId, watch) {
    const normalized = String(poolId || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error('Invalid pool ID');
    if (!this.market.pools.some((pool) => pool.id.toLowerCase() === normalized)) {
      throw new Error('Pool is not present in the current Fables registry');
    }
    const ids = new Set((this.state.getSetting('watchedPoolIds', []) || []).map((id) => String(id).toLowerCase()));
    if (watch) ids.add(normalized);
    else ids.delete(normalized);
    this.state.setSetting('watchedPoolIds', [...ids].sort());
    return [...ids];
  }

  getSelectedExecutionTargetPoolId() {
    return String(this.state?.getSetting('selectedExecutionTargetPoolId', '') || '').toLowerCase();
  }

  getInvestmentTargetSettings() {
    return {
      mode: String(this.state?.getSetting('investmentTargetMode', 'apr-highest') || 'apr-highest'),
      poolId: String(
        this.state?.getSetting('investmentTargetPoolId', this.getSelectedExecutionTargetPoolId())
        || this.getSelectedExecutionTargetPoolId()
      ).toLowerCase()
    };
  }

  getInvestmentAllocationConfig() {
    const stored = this.state?.getSetting('investmentAllocation', null);
    if (stored == null) return { version: 1, enabled: false, allocations: [] };
    if (stored && stored.version === 1 && typeof stored.enabled === 'boolean'
      && Array.isArray(stored.allocations)) {
      const seen = new Set();
      const validEntries = stored.allocations.every((entry) => {
        const poolId = String(entry?.poolId || '').toLowerCase();
        const weightBps = Number(entry?.weightBps);
        if (!/^0x[0-9a-f]{64}$/.test(poolId) || seen.has(poolId)
          || !Number.isInteger(weightBps) || weightBps < 1 || weightBps > 10_000) return false;
        seen.add(poolId);
        return true;
      });
      const allocationCount = stored.allocations.length;
      const allocationTotal = stored.allocations.reduce((sum, entry) => sum + Number(entry?.weightBps), 0);
      const validEnabled = stored.enabled
        ? allocationCount >= 1 && allocationCount <= 2 && allocationTotal === 10_000
        : allocationCount === 0 || (allocationCount <= 2 && allocationTotal === 10_000);
      if (validEntries && validEnabled) return stored;
      return { version: 1, enabled: true, allocations: [], invalid: true };
    }
    return { version: 1, enabled: true, allocations: [], invalid: true };
  }

  getInvestmentAllocationSnapshot() {
    const config = this.getInvestmentAllocationConfig();
    const updatedAt = Number(this.state?.getSetting('investmentAllocationUpdatedAt', 0) || 0);
    const funding = this.allocationFunding;
    const matchesConfig = funding?.allocationUpdatedAt === updatedAt;
    const isFresh = !config.invalid && matchesConfig && funding?.status === 'ready'
      && Date.now() >= Number(funding.priceObservedAt || 0)
      && Date.now() - Number(funding.priceObservedAt || 0) <= 5 * 60_000;
    const allocations = config.allocations.map((entry) => {
      const pool = this.market.pools.find((item) => item.id.toLowerCase() === entry.poolId);
      return { ...entry, pair: pool ? `${pool.token0.symbol}/${pool.token1.symbol}` : null };
    });
    const base = isFresh ? funding : null;
    const configuredIds = new Set(allocations.map((entry) => entry.poolId));
    const excludedAssets = isFresh ? funding.excludedAssets || [] : [];
    return {
      version: 1,
      enabled: config.enabled,
      allocations,
      totalWeightBps: allocations.reduce((sum, entry) => sum + Number(entry.weightBps || 0), 0),
      status: !config.enabled ? 'disabled' : config.invalid ? 'blocked' : isFresh ? 'ready'
        : funding?.status === 'blocked' && matchesConfig ? 'blocked' : 'pending-refresh',
      priceStatus: {
        status: !config.enabled ? 'unavailable' : config.invalid ? 'missing'
          : base ? 'fresh' : funding?.status === 'blocked' && matchesConfig ? 'missing' : 'unavailable',
        source: 'pool-local-spot',
        asOfBlock: base?.asOfBlock ?? null,
        observedAt: base?.priceObservedAt ?? null,
        missingPoolIds: allocations.filter((entry) => !this.market.pools.some((pool) =>
          pool.id.toLowerCase() === entry.poolId)).map((entry) => entry.poolId)
      },
      capital: {
        denomination: 'USDG',
        asOfBlock: base?.asOfBlock ?? null,
        observedAt: base?.priceObservedAt ?? null,
        totalUsdG: base?.totalUsdG ?? null,
        byPool: base?.byPool ?? [],
        excludedAssets,
        pendingRefresh: config.enabled && !config.invalid && !isFresh
      }
    };
  }

  setInvestmentAllocation(input = {}) {
    const disablingPausedStrategy = input.enabled === false && this.executionPaused === true;
    if ((this.cycleActive && !disablingPausedStrategy) || this.initializing || this.rpcManagementActive) {
      throw new Error('目前掃描或設定更新中，請等本輪完成後再切換模式。');
    }
    if (this.executor?.hasPendingWrite) throw new Error('Wait for queued wallet transactions before changing allocations');
    const activeExecution = this.state?.getSetting('activeRebalanceExecution', null);
    if (activeExecution?.phase && !['completed', 'failed'].includes(activeExecution.phase)) {
      throw new Error(`Wait for the active rebalance journal to finish before changing allocations (${activeExecution.phase})`);
    }
    this.executor?.assertNoUnfinishedExecution();
    const { enabled, allocations } = input || {};
    if (typeof enabled !== 'boolean') throw new Error('資金分配 enabled 必須是布林值');
    const previous = this.getInvestmentAllocationConfig();
    let normalized;
    if (!enabled) {
      // Disabling must not depend on current liquidity/paused state of the old pools.
      const retained = previous.invalid ? [] : previous.allocations.map((entry) => ({ ...entry }));
      normalized = { version: 1, enabled: false, allocations: retained };
    } else {
      normalized = normalizeInvestmentAllocation({ enabled: true,
        allocations: allocations === undefined ? previous.allocations : allocations },
      this.market.pools, this.config.usdgAddress);
    }
    const updatedAt = Date.now();
    this.state.setSetting('investmentAllocation', normalized);
    this.state.setSetting('investmentAllocationUpdatedAt', updatedAt);
    this.allocationFunding = null;
    this.ledger.append('investment.allocation_updated', {
      enabled: normalized.enabled,
      allocations: normalized.allocations
    });
    if (normalized.enabled) {
      this.config.targetMode = 'wallet-active';
      this.config.targetPoolIds = [];
      this.config.targetSymbols = [];
    } else this.applyStoredExecutionTarget();
    return this.getInvestmentAllocationSnapshot();
  }

  getAllocationFundingScope(poolId) {
    const config = this.getInvestmentAllocationConfig();
    if (!config.enabled) return null;
    const allocation = config.allocations.find((entry) => entry.poolId === String(poolId).toLowerCase());
    if (!allocation) throw new Error('Pool is outside the saved allocation');
    const snapshot = this.getInvestmentAllocationSnapshot();
    if (snapshot.status !== 'ready') throw new Error('Fresh allocation valuation is required before spending');
    const item = snapshot.capital.byPool.find((entry) => entry.poolId === allocation.poolId);
    if (!item) throw new Error('Allocation funding cap is unavailable');
    return {
      allocationUpdatedAt: Number(this.state.getSetting('investmentAllocationUpdatedAt', 0)),
      poolId: allocation.poolId,
      weightBps: allocation.weightBps,
      availableUsdG: Number(item.availableUsdG),
      targetUsdG: Number(item.targetUsdG),
      lpEquityUsdG: Number(item.lpEquityUsdG),
      ownWalletUsdG: Number(item.ownWalletUsdG),
      sharedUsdgAvailableUsdG: Number(item.sharedUsdgAvailableUsdG),
      driftUsdG: Number(item.driftUsdG),
      tokenCaps: { ...item.tokenCaps },
      asOfBlock: snapshot.capital.asOfBlock,
      priceObservedAt: snapshot.capital.observedAt
    };
  }

  async refreshAllocationFundingSnapshot({ pools = null, walletBalances = null,
    asOfBlock = null, refreshPositions = false } = {}) {
    const config = this.getInvestmentAllocationConfig();
    if (!config.enabled) {
      this.allocationFunding = null;
      return null;
    }
    if (config.invalid) {
      this.allocationFunding = { status: 'blocked', reason: 'saved-allocation-invalid', allocation: config,
        allocationUpdatedAt: Number(this.state.getSetting('investmentAllocationUpdatedAt', 0)),
        byPool: [], totalUsdG: null, priceObservedAt: null, asOfBlock: null, excludedAssets: [] };
      return this.allocationFunding;
    }
    try {
      const selected = config.allocations.map((entry) => {
        const pool = (pools || this.market.pools).find((item) => item.id.toLowerCase() === entry.poolId);
        if (!pool) throw new Error('Saved allocation pool is no longer in the Fables registry');
        return pool;
      });
      const block = Number(asOfBlock || await this.providers.readProvider.getBlockNumber());
      for (const pool of selected) {
        pool.state = await this.fables.readPoolState(pool);
        if (refreshPositions) {
          const fromBlock = Math.max(this.config.logFromBlock, block - this.config.reorgLookbackBlocks);
          const discovered = await this.fables.discoverPositions(pool, fromBlock, block);
          pool.positions = discovered.positions;
          for (const position of pool.positions) await this.decoratePosition(pool, position);
        }
      }
      const tokens = [...new Map(selected.flatMap((pool) => [pool.token0, pool.token1])
        .map((token) => [token.address.toLowerCase(), token])).values()];
      const currentBalances = walletBalances || await this.fables.readWalletBalances(tokens);
      const usdG = this.config.usdgAddress.toLowerCase();
      const tokenPricesUsdG = new Map([[usdG, 1]]);
      const lpEquityUsdG = {};
      for (const pool of selected) {
        const value = valuePoolPositionsUsdG(pool, usdG);
        tokenPricesUsdG.set(value.tokenAddress, value.priceUsdG);
        lpEquityUsdG[pool.id.toLowerCase()] = value.lpEquityUsdG;
      }
      const computed = computeAllocationFunding({
        allocation: config,
        pools: selected,
        lpEquityUsdG,
        walletBalances: currentBalances,
        pricesUsdG: tokenPricesUsdG,
        usdgAddress: usdG,
        priceObservedAt: Date.now(),
        asOfBlock: block
      });
      const selectedTokens = new Set(tokens.map((token) => token.address.toLowerCase()));
      const tokenByAddress = new Map(tokens.map((token) => [token.address.toLowerCase(), token]));
      const excludedAssets = Object.entries(currentBalances)
        .filter(([address, entry]) => !selectedTokens.has(address.toLowerCase())
          && Number(entry?.amount || 0) > 0)
        .map(([address]) => ({ address: address.toLowerCase(), reason: 'outside-selected-pool-assets' }));
      this.allocationFunding = {
        ...computed,
        allocationUpdatedAt: Number(this.state.getSetting('investmentAllocationUpdatedAt', 0)),
        excludedAssets
      };
      return this.allocationFunding;
    } catch (error) {
      this.allocationFunding = {
        status: 'blocked', reason: sanitize(error.message), allocation: config,
        allocationUpdatedAt: Number(this.state.getSetting('investmentAllocationUpdatedAt', 0)),
        byPool: [], totalUsdG: null, priceObservedAt: null, asOfBlock: null, excludedAssets: []
      };
      return this.allocationFunding;
    }
  }

  getInvestmentTargetSnapshot() {
    const settings = this.getInvestmentTargetSettings();
    const freshStats = Date.now() - Number(this.market.fablesStats?.aprObservedAt || 0) <= 5 * 60_000
      ? this.market.fablesStats : null;
    const ranked = settings.mode === 'apr-highest'
      ? rankAprPools({
        pools: this.market.pools,
        stats: this.market.fablesStats,
        nowMs: Date.now(),
        maxStatsAgeMs: Math.max(5 * 60 * 1000, this.config.marketRefreshMs * 3),
        minTvlUsd: this.config.aprPoolMinTvlUsd
      })
      : [];
    const currentPosition = (this.snapshot?.portfolio?.positions || []).find((position) => BigInt(position.shares || 0) > 0n);
    const sourcePool = currentPosition
      ? this.market.pools.find((pool) => pool.id.toLowerCase() === String(currentPosition.poolId).toLowerCase())
      : null;
    const aprSelected = ranked.find(({ pool }) => {
      if (hasNativeCurrency(pool) || (sourcePool && hasNativeCurrency(sourcePool))) return false;
      if (!sourcePool) return true;
      try {
        chooseInvestmentAnchor(
          [sourcePool.token0, sourcePool.token1, pool.token0, pool.token1],
          pool,
          this.market.pools
        );
        return true;
      } catch { return false; }
    })?.pool;
    const selected = settings.mode === 'specific-pool'
      ? this.market.pools.find((pool) => pool.id.toLowerCase() === settings.poolId)
      : aprSelected;
    const stats = selected && freshStats?.pools?.get(selected.id.toLowerCase());
    const tvlStats = selected && Date.now() - Number(this.market.fablesStats?.observedAt || 0) <= 5 * 60_000
      ? this.market.fablesStats?.pools?.get(selected.id.toLowerCase()) : null;
    return {
      mode: settings.mode,
      poolId: selected?.id || (settings.mode === 'specific-pool' ? settings.poolId : null),
      specificPoolId: settings.poolId || null,
      pair: selected ? selected.token0.symbol + '/' + selected.token1.symbol : null,
      aprPct: stats?.aprPct ?? null,
      tvlUsd: tvlStats?.tvlUsd ?? null,
      statsObservedAt: this.market.fablesStats?.aprObservedAt ?? null,
      minTvlUsd: this.config.aprPoolMinTvlUsd,
      executionConstraint: settings.mode === 'apr-highest'
        ? 'cross-pool candidates require a complete live sequence preflight'
        : null
    };
  }

  resolveInvestmentTarget(sourcePool) {
    const settings = this.getInvestmentTargetSettings();
    if (settings.mode === 'specific-pool') {
      const selected = this.market.pools.find((pool) => pool.id.toLowerCase() === settings.poolId);
      if (!selected) throw new Error('指定的再投入池不在目前 Fables 登錄清單內');
      if (selected.state?.paused !== false || BigInt(selected.state?.liquidity || 0) <= 0n) {
        throw new Error('指定的再投入池已暫停或沒有可用流動性');
      }
      if (hasNativeCurrency(selected) || hasNativeCurrency(sourcePool)) {
        throw new Error('原生 ETH 池尚未支援自動跨池實盤');
      }
      chooseInvestmentAnchor(
        [sourcePool.token0, sourcePool.token1, selected.token0, selected.token1],
        selected,
        this.market.pools
      );
      return selected;
    }
    if (settings.mode !== 'apr-highest') throw new Error('未知的再投入模式');
    const ranked = rankAprPools({
      pools: this.market.pools,
      stats: this.market.fablesStats,
      nowMs: Date.now(),
      maxStatsAgeMs: Math.max(5 * 60 * 1000, this.config.marketRefreshMs * 3),
      minTvlUsd: this.config.aprPoolMinTvlUsd
    });
    for (const candidate of ranked) {
      if (hasNativeCurrency(candidate.pool) || hasNativeCurrency(sourcePool)) continue;
      try {
        chooseInvestmentAnchor(
          [sourcePool.token0, sourcePool.token1, candidate.pool.token0, candidate.pool.token1],
          candidate.pool,
          this.market.pools
        );
        return candidate.pool;
      } catch {}
    }
    throw new Error('沒有 APR 資料新鮮、TVL 達標且資產兌換路徑可用的 Fables 池；保留原 LP');
  }

  async resolveExecutableInvestmentTarget(sourcePool, position) {
    const ranked = rankAprPools({
      pools: this.market.pools,
      stats: this.market.fablesStats,
      nowMs: Date.now(),
      maxStatsAgeMs: Math.max(5 * 60 * 1000, this.config.marketRefreshMs * 3),
      minTvlUsd: this.config.aprPoolMinTvlUsd
    });
    const skipped = [];
    for (const candidate of ranked) {
      const pool = candidate.pool;
      if (pool.id.toLowerCase() === sourcePool.id.toLowerCase()) return pool;
      if (hasNativeCurrency(pool) || hasNativeCurrency(sourcePool)) {
        skipped.push({ poolId: pool.id, pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
          reason: '原生 ETH 池尚未支援跨池實盤' });
        continue;
      }
      try {
        await this.executor.preflightCrossPoolSequence({
          pool: sourcePool, position, routingPools: this.market.pools
        }, pool);
        this.ledger.append('investment.cross_pool_candidate_ready', {
          sourcePoolId: sourcePool.id, destinationPoolId: pool.id,
          pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
          aprPct: candidate.aprPct, candidatesSkipped: skipped.length
        });
        return pool;
      } catch (error) {
        skipped.push({ poolId: pool.id, pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
          reason: sanitize(error.message) });
      }
    }
    this.ledger.append('investment.cross_pool_candidates_skipped', {
      sourcePoolId: sourcePool.id, positionId: position.id,
      considered: ranked.length, skipped: skipped.slice(0, 20)
    });
    // Keep the original OOR LP in a fresh Tight range when no higher APR pool
    // has a fully simulated route. This avoids withdrawing into an unsafe path.
    return sourcePool;
  }

  applyStoredExecutionTarget() {
    const selectedPoolId = this.getSelectedExecutionTargetPoolId();
    if (selectedPoolId && !/^0x[0-9a-f]{64}$/.test(selectedPoolId)) {
      throw new Error('Stored execution target pool is invalid; refusing to start');
    }
    const investmentMode = String(this.state?.getSetting('investmentTargetMode', 'apr-highest') || 'apr-highest');
    if (this.getInvestmentAllocationConfig?.()?.enabled === true || ['apr-highest', 'specific-pool'].includes(investmentMode)) {
      this.config.targetMode = 'wallet-active';
      this.config.targetPoolIds = [];
      this.config.targetSymbols = [];
      return;
    }
    this.config.targetMode = selectedPoolId ? 'allowlist' : this.baseExecutionTarget.mode;
    this.config.targetPoolIds = selectedPoolId ? [selectedPoolId] : [...this.baseExecutionTarget.poolIds];
    this.config.targetSymbols = selectedPoolId ? [] : [...this.baseExecutionTarget.symbols];
  }

  setInvestmentTarget(mode, poolId = '') {
    if (this.cycleActive) throw new Error('Wait for the current monitor cycle before changing the investment target');
    if (this.getInvestmentAllocationConfig?.()?.enabled === true) {
      throw new Error('Disable pool allocation before changing the legacy single investment target');
    }
    const normalizedMode = String(mode || '').trim().toLowerCase();
    if (!['apr-highest', 'specific-pool'].includes(normalizedMode)) {
      throw new Error('再投入模式只能是最高 APR 或指定池');
    }
    const normalizedPoolId = String(poolId || '').trim().toLowerCase();
    let pool = null;
    if (normalizedMode === 'specific-pool') {
      if (!/^0x[0-9a-f]{64}$/.test(normalizedPoolId)) throw new Error('請從清單選擇指定再投入池');
      pool = this.market.pools.find((item) => item.id.toLowerCase() === normalizedPoolId) || null;
      if (!pool) throw new Error('指定的再投入池不在目前 Fables 登錄清單內');
      if (pool.state?.paused !== false || BigInt(pool.state?.liquidity || 0) <= 0n) {
        throw new Error('指定池已暫停或目前沒有流動性，不能作為再投入目標');
      }
      if (hasNativeCurrency(pool)) throw new Error('原生 ETH 池尚未支援自動跨池實盤');
    }
    return this.persistInvestmentTarget(normalizedMode, pool);
  }

  persistInvestmentTarget(mode, pool) {
    this.state.setSetting('investmentTargetMode', mode);
    if (pool) this.state.setSetting('investmentTargetPoolId', pool.id.toLowerCase());
    if (mode === 'specific-pool' && pool) {
      // Keep the legacy dashboard/start-readiness selection in sync with the
      // wallet's specific reinvestment target. Each bot owns its own state.
      this.state.setSetting('selectedExecutionTargetPoolId', pool.id.toLowerCase());
    }
    this.applyStoredExecutionTarget();
    const target = this.getInvestmentTargetSnapshot();
    this.ledger.append('investment.target_updated', {
      mode,
      poolId: mode === 'specific-pool' ? pool?.id.toLowerCase() : null,
      pair: pool ? `${pool.token0.symbol}/${pool.token1.symbol}` : null
    });
    return target;
  }

  setExecutionTargetPool(poolId = '') {
    if (this.cycleActive) throw new Error('Wait for the current monitor cycle before changing the execution target');
    if (this.getInvestmentAllocationConfig?.()?.enabled === true) {
      throw new Error('Disable pool allocation before changing the legacy execution target');
    }
    const normalized = String(poolId || '').trim().toLowerCase();
    if (normalized && !/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error('Invalid pool ID');
    const pool = normalized ? this.market.pools.find((item) => item.id.toLowerCase() === normalized) : null;
    if (normalized && !pool) throw new Error('Pool is not present in the current Fables registry');

    this.state.setSetting('selectedExecutionTargetPoolId', normalized);
    this.applyStoredExecutionTarget();
    log('info', 'dashboard.execution_target_updated', {
      poolId: normalized || null,
      pair: pool ? `${pool.token0.symbol}/${pool.token1.symbol}` : null,
      targetMode: this.config.targetMode
    });
    return {
      poolId: normalized || null,
      pair: pool ? `${pool.token0.symbol}/${pool.token1.symbol}` : null,
      targetMode: this.config.targetMode
    };
  }

  getStopLossSnapshot() {
    const settings = this.state.getSetting('stopLossSettings', { enabled: false, lossPct: 15, basisMode: 'armed-equity', version: 1 });
    const reference = this.state.getSetting('stopLossReference', null);
    return { ...evaluateStopLoss(settings, reference, this.snapshot), settings, reference,
      latched: this.state.getSetting('stopLossLatched', false),
      liquidation: this.state.getSetting('stopLiquidationStatus', null),
      scanIntervalMs: this.config.pollIntervalMs };
  }

  setStopLossSettings(value) {
    const settings = normalizeStopLoss({ ...value, basisMode: value?.basisMode
      ?? this.state.getSetting('stopLossSettings', null)?.basisMode ?? 'armed-equity' });
    if (this.stopLiquidationPromise || this.initializing || this.rpcManagementActive
      || (this.cycleActive && this.state.getSetting('stopLossLatched', false))) throw new Error('停止清倉或初始化正在執行，請稍後修改。');
    const journal = this.state.getSetting('activeRebalanceExecution', null);
    if (journal?.phase && !['completed', 'failed'].includes(journal.phase)) throw new Error('有待確認交易，無法重設停損。');
    const previous = this.state.getSetting('stopLossSettings', { enabled: false });
    const capture = settings.enabled && (!previous.enabled || value.rebase === true
      || settings.basisMode !== (previous.basisMode || 'armed-equity')
      || !this.state.getSetting('stopLossReference', null));
    if (capture) {
      const portfolio = this.snapshot?.portfolio;
      const equity = portfolio?.currentValueUsd;
      const age = Date.now() - Number(this.snapshot?.generatedAt || 0);
      if (this.cycleActive || !Number.isFinite(equity) || !(equity > 0) || !Number.isFinite(age)
        || !(Number(this.snapshot?.generatedAt) > 0) || age < -30_000 || age > 15 * 60_000) throw new Error('請先完成最新且所有追蹤資產都有價格的錢包掃描，再設定啟用估值基準。');
      if (this.snapshot?.bot?.wallet && this.snapshot.bot.wallet.toLowerCase() !== this.config.walletAddress.toLowerCase()) throw new Error('停損基準的快照錢包不符，請重新掃描。');
      const reference = settings.basisMode === 'lp-session'
        ? captureLpSessionReference(this.snapshot, this.config.walletAddress)
          || { basisMode: 'lp-session', pending: true, armedAt: Date.now(), wallet: this.config.walletAddress.toLowerCase() }
        : { equityUsd: equity, at: this.snapshot.generatedAt,
          asOfBlock: this.snapshot.blockNumber, netCashflowUsd: portfolio.netCashflowUsd,
          flowAccountingComplete: portfolio.accountingComplete === true,
          wallet: this.config.walletAddress.toLowerCase() };
      this.state.setSetting('stopLossReference', reference);
      this.state.setSetting('stopLossLatched', false);
    }
    this.state.setSetting('stopLossSettings', settings);
    this.ledger.append('stop_loss.settings', { ...settings, rebased: capture });
    return this.getStopLossSnapshot();
  }

  capturePendingLpStopLossReference(snapshot) {
    const settings = this.state.getSetting('stopLossSettings', null);
    const pending = this.state.getSetting('stopLossReference', null);
    if (settings?.enabled !== true || settings.basisMode !== 'lp-session'
      || pending?.pending !== true || this.state.getSetting('stopLossLatched', false)) return false;
    const reference = captureLpSessionReference(snapshot, this.config.walletAddress, { minimumAt: pending.armedAt });
    if (!reference) return false;
    this.state.setSetting('stopLossReference', reference);
    this.ledger.append('stop_loss.lp_session_started', { basisAt: reference.at,
      equityUsd: reference.equityUsd, asOfBlock: reference.asOfBlock, initialPositions: reference.initialPositions });
    return true;
  }

  requestStopLiquidation({ confirm, maxCostBps = 500 } = {}) {
    if (!this.config.dashboardManualControlEnabled) throw new Error('人工交易控制尚未啟用。');
    if (confirm !== 'STOP_AND_LIQUIDATE') throw new Error('請確認撤出全部 LP 並換回 USDG。');
    if (!Number.isInteger(maxCostBps) || maxCostBps < 1 || maxCostBps > 500) throw new Error('換幣成本上限須介於 1 與 500 bps。');
    if (this.stopLiquidationPromise || (this.cycleActive
      && this.state.getSetting('stopLiquidationStatus', null)?.status === 'running')) return this.getStopLossSnapshot();
    this.state.setSetting('stopLossLatched', true);
    this.resumeExecutionAfterStartup = false;
    this.setExecutionPaused(true, 'stop-liquidate-request');
    this.state.setSetting('stopLiquidationStatus', { status: 'queued', requestedAt: Date.now(), source: 'manual' });
    this.stopLiquidationPromise = (async () => {
      const until = Date.now() + 120_000;
      while (this.cycleActive || this.initializing || this.rpcManagementActive) {
        if (Date.now() > until) throw new Error('等待既有流程逾時；已停止新交易，請確認現有交易後重試清倉。');
        await sleep(250);
      }
      await this.runOnce({ executeRebalances: false, source: 'stop-liquidate-scan' });
      this.cycleActive = true;
      let liquidation;
      try { liquidation = await this.performStopLiquidation({ maxCostBps, source: 'manual' }); }
      finally { this.cycleActive = false; }
      try { await this.runOnce({ executeRebalances: false, source: 'stop-liquidate-readback' }); }
      catch (error) { this.ledger.append('stop_loss.readback_deferred', { error: sanitize(error.message) }); }
      return liquidation;
    })().catch(error => {
      this.state.setSetting('stopLiquidationStatus', { status: 'failed', error: sanitize(error.message), at: Date.now() });
      this.ledger.append('stop_loss.request_failed', { error: sanitize(error.message) });
    }).finally(() => { this.stopLiquidationPromise = null; });
    return this.getStopLossSnapshot();
  }

  async performStopLiquidation({ maxCostBps = 500, source = 'auto-stop-loss' } = {}) {
    this.state.setSetting('stopLossLatched', true);
    this.resumeExecutionAfterStartup = false;
    this.setExecutionPaused(true, source);
    this.state.setSetting('stopLiquidationStatus', { status: 'running', source, at: Date.now() });
    try {
      // Discover ALL wallet Fables ranges, regardless of the selected investment pool.
      const latest = await this.providers.readProvider.getBlockNumber();
      const result = await this.fables.discoverWalletActivePools(this.market.pools,
        Math.max(this.config.walletPoolDiscoveryFromBlock,
          this.state.getCursor('walletPoolDiscovery', this.config.walletPoolDiscoveryFromBlock) - this.config.reorgLookbackBlocks),
        latest, this.state.getSetting('walletRangeCandidates', []), { strict: true });
      this.state.setSetting('walletRangeCandidates', result.knownRangeKeys);
      const hydrated = await this.fables.hydratePoolStates(this.market.pools);
      const pools = hydrated.map(pool => ({ ...pool, positions: [] }));
      for (const pool of pools) {
        if (!result.activePoolIds.some(id => id.toLowerCase() === pool.id.toLowerCase())) continue;
        const positions = await this.fables.discoverPositions(pool,
          Math.max(this.config.logFromBlock, latest - this.config.reorgLookbackBlocks), latest);
        pool.positions = positions.positions;
      }
      const extraTokens = Object.keys(this.snapshot?.portfolio?.inventory || {}).map(address => ({ address }));
      const liquidation = await executeStopLiquidation(this.executor, { pools, extraTokens, maxCostBps });
      this.state.setSetting('stopLiquidationStatus', { ...liquidation, source, at: Date.now() });
      if (source === 'auto-stop-loss') this.stopLiquidationReadbackPending = true;
      this.state.setSetting('lastAction', { type: 'stop-liquidate', status: liquidation.status, at: Date.now() });
      // The current portfolio is pre-exit; next readonly monitor replaces it.
      if (this.snapshot?.bot) this.snapshot.bot.executionPaused = true;
      return liquidation;
    } catch (error) {
      this.state.setSetting('stopLiquidationStatus', { status: 'failed', error: sanitize(error.message), at: Date.now() });
      throw error;
    }
  }

  async startExecution(source = 'dashboard') {
    const status = await this.controlStatus();
    if (!status.startReadiness.ready) {
      return { ok: false, blockers: status.startReadiness.blockers };
    }
    this.setExecutionPaused(false, source);
    return { ok: true, executionPaused: false, mode: status.mode };
  }

  activateWalletProfile(profile) {
    // The old wallet's background points scan retains its own state/ledger.
    // A newly selected wallet may start its own independent scan.
    this.globalPointScanPromise = null;
    this.config.walletAddress = profile.address;
    this.config.privateKey = profile.privateKey || '';
    if (this.config.persistRuntimeCredentials) {
      this.config.eip7702GuardVerificationEnabled = process.env.EIP7702_GUARD_VERIFIED?.toLowerCase() === 'true';
      this.config.eip7702GuardVerifiedFor = process.env.EIP7702_GUARD_VERIFIED_FOR || '';
    }
    this.config.eip7702GuardVerified = Boolean(this.config.eip7702GuardVerificationEnabled)
      && Boolean(this.config.eip7702GuardVerifiedFor)
      && this.config.eip7702GuardVerifiedFor.toLowerCase() === profile.address.toLowerCase();
    this.config.dryRun = true;
    this.config.enableLiveWrites = false;
    this.config.enableAutoRedeploy = false;
    this.executionPaused = true;

    const lowerAddress = profile.address.toLowerCase();
    const walletDir = path.join(this.baseDataDir, 'wallets', lowerAddress);
    if (lowerAddress === this.initialWalletAddress && !fs.existsSync(path.join(walletDir, 'bot-state.json'))) {
      this.config.dataDir = this.baseDataDir;
      this.config.stateFile = this.baseStateFile;
    } else {
      this.config.dataDir = walletDir;
      this.config.stateFile = path.join(walletDir, 'bot-state.json');
    }
    this.state = new StateStore(this.config.stateFile);
    this.applyStoredExecutionTarget();
    this.ledger = new LedgerStore(this.config.dataDir);
    this.analytics = new PortfolioAnalytics(this.config, this.ledger, this.state);
    this.points = new PointsTracker(this.config, this.ledger, this.state);
    this.state.setSetting('executionPaused', true);
    this.fables.positionCandidates.clear();
    this.market.refreshedAt = 0;
    this.snapshot = this.ledger.readSnapshot();
    this.walletImportState = { status: 'scanning', address: profile.address, error: null };
    this.executor = this.createExecutor();

    const address = profile.address.toLowerCase();
    void this.runOnce({ executeRebalances: false, source: 'wallet-import' })
      .then(() => {
        if (this.config.walletAddress.toLowerCase() === address) {
          this.walletImportState = { status: 'ready', address: profile.address, error: null };
        }
      })
      .catch(() => {
        if (this.config.walletAddress.toLowerCase() === address) {
          this.walletImportState = { status: 'failed', address: profile.address, error: 'Initial scan failed; check RPC health and logs' };
        }
      });
  }

  createExecutor() {
    if (this.guardReadinessCache && this.providers?.readProvider) {
      this.guardReadinessCache.delete(this.providers.readProvider);
    }
    return new RebalanceExecutor(
      this.providers.readProvider,
      this.providers.writeProvider,
      this.config,
      this.fables,
      this.ledger,
      (address) => this.market.prices.get(String(address).toLowerCase()) || 0,
      this.state
    );
  }

  async getUiGuardReadiness() {
    const provider = this.providers.readProvider;
    if (!this.guardReadinessCache) this.guardReadinessCache = new WeakMap();
    let entries = this.guardReadinessCache.get(provider);
    if (!entries) {
      entries = new Map();
      this.guardReadinessCache.set(provider, entries);
    }
    const key = `${String(this.config.walletAddress || '').toLowerCase()}|${String(this.config.eip7702GuardAddress || '').toLowerCase()}`;
    const now = Date.now();
    const current = entries.get(key);
    if (current && (current.pending || now < current.expiresAt)) return current.promise;

    const entry = { pending: true, expiresAt: Infinity, promise: null };
    entry.promise = Promise.resolve().then(() => this.executor.assertAtomicGuardReady())
      .then(() => ({ ready: true, error: null }))
      .catch((error) => ({ ready: false, error: sanitize(error.shortMessage || error.message || 'Guard readiness check failed') }))
      .then((result) => {
        entry.pending = false;
        entry.expiresAt = Date.now() + (result.ready ? 5 * 60_000 : 60_000);
        return result;
      });
    entries.set(key, entry);
    return entry.promise;
  }

  async manualRebalance(poolId, positionId, source = 'dashboard') {
    if (this.rpcManagementActive || this.initializing) throw new Error('busy');
    poolId = String(poolId || '').toLowerCase();
    positionId = String(positionId || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(poolId)) throw new Error('Invalid poolId');
    if (!/^0x[0-9a-f]{64}$/.test(positionId)) throw new Error('Invalid positionId');
    if (this.cycleActive) throw new Error('A monitoring/execution cycle is already running');
    if (this.executionPaused) throw new Error('Execution is paused; resume before manual rebalance');

    const snapshot = await this.runOnce({ executeRebalances: false, source: 'manual-preflight' });
    if (this.cycleActive) throw new Error('Monitoring cycle did not release execution lock');

    const activePoolIds = new Set((snapshot?.bot?.activePoolIds || []).map((x) => String(x).toLowerCase()));
    if (!activePoolIds.has(poolId)) throw new Error('Requested pool is not an active wallet LP pool');

    const pool = this.market.pools.find((x) => String(x.id).toLowerCase() === poolId);
    const position = pool?.positions?.find((x) => String(x.id).toLowerCase() === positionId);
    if (!pool || !position) throw new Error('Requested LP position is not active after fresh chain scan');
    if (position.outside !== true) throw new Error('Absolute in-range hold: manual withdrawal is forbidden while LP is in range');
    if (position.shouldRebalance !== true) {
      throw new Error('Position is OOR but has not satisfied the configured rebalance policy yet');
    }

    this.cycleActive = true;
    try {
      if (this.config.targetMode === 'wallet-active') {
        const stable = await this.revalidateTopologyBeforeExecution(snapshot.blockNumber, [{ pool, position }]);
        if (!stable) throw new Error('Wallet LP topology changed during manual preflight');
      }
      this.ledger.append('rebalance.manual_requested', {
        source,
        poolId: pool.id,
        positionId: position.id,
        pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
        dryRun: this.config.dryRun
      });
      const result = await this.maybeRebalance(pool, position, { source, throwOnFailure: true });
      return result || { status: 'blocked', reason: 'manual rebalance was blocked by a safety gate' };
    } finally {
      this.cycleActive = false;
    }
  }

  async manualImmediateRotation({ poolId, positionId, destinationPoolId, previewId = '',
    previewOnly = false, directExecute = false, maxCostBps = null }) {
    if (this.state.getSetting('stopLossLatched', false) || this.stopLiquidationPromise) throw new Error('停止清倉已鎖定；請先完成清倉並重新設定停損基準。');
    if (this.rpcManagementActive || this.initializing) throw new Error('busy');
    if (this.getInvestmentAllocationConfig?.()?.enabled === true) {
      throw new Error('Disable pool allocation before using legacy manual rotation');
    }
    poolId = String(poolId || '').toLowerCase();
    positionId = String(positionId || '').toLowerCase();
    destinationPoolId = String(destinationPoolId || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(destinationPoolId)
      || (poolId && !/^0x[0-9a-f]{64}$/.test(poolId))
      || (positionId && !/^0x[0-9a-f]{64}$/.test(positionId))) {
      throw new Error('立即換倉需要有效的來源部位與目的池');
    }
    const costCapBps = Number(maxCostBps ?? this.config.crossPoolMaxSwapPriceImpactBps ?? 350);
    if (!Number.isInteger(costCapBps) || costCapBps < 1 || costCapBps > 500) {
      throw new Error('單次換倉成本上限須為 1 至 500 bps');
    }
    if (!this.config.dashboardManualControlEnabled) throw new Error('人工交易控制尚未啟用');
    if (this.cycleActive) throw new Error('目前有鏈上掃描或交易流程，請稍後重試');
    let approved = null;
    if (!previewOnly && !directExecute) {
      approved = this.manualRotationPreview;
      this.manualRotationPreview = null;
      if (!approved || approved.id !== previewId || approved.expiresAt < Date.now()
        || approved.wallet !== this.config.walletAddress.toLowerCase()
        || approved.poolId !== poolId || approved.positionId !== positionId
        || approved.destinationPoolId !== destinationPoolId
        || approved.maxCostBps !== costCapBps) {
        throw new Error('立即換倉預演已過期或目標變更，請重新預演');
      }
      if (this.executionPaused) throw new Error('執行已暫停，無法立即換倉');
    }
    const snapshot = await this.runOnce({ executeRebalances: false, source: 'manual-rotation-preflight' });
    if (this.cycleActive) throw new Error('鏈上掃描尚未釋放執行鎖');
    this.cycleActive = true;
    try {
      if (approved && approved.expiresAt < Date.now()) {
        throw new Error('立即換倉預演已過期，請重新預演');
      }
      const settings = this.getInvestmentTargetSettings();
      if (!directExecute && (settings.mode !== 'specific-pool' || settings.poolId !== destinationPoolId)) {
        throw new Error('請先儲存指定池，立即換倉只使用已保存的目的池');
      }
      const active = (snapshot?.portfolio?.positions || []).filter((item) => BigInt(item.shares || 0) > 0n);
      const destinationPool = this.market.pools.find((item) => item.id.toLowerCase() === destinationPoolId);
      if (!destinationPool) throw new Error('目的池已不在最新清單');
      const idleWallet = active.length === 0;
      if (idleWallet && !directExecute) throw new Error('沒有 LP 時請使用直接換倉操作');
      if (idleWallet && (poolId || positionId)) {
        throw new Error('來源 LP 已撤出或變動，請重新載入錢包餘額後再執行');
      }
      let sourcePool;
      let position;
      if (idleWallet) {
        sourcePool = this.resolveIdleRotationSource(snapshot, destinationPool);
        position = { id: '0x' + '0'.repeat(64), shares: 0n, tickLower: 0, tickUpper: 0 };
      } else {
        if (poolId === destinationPoolId) throw new Error('目前 LP 已在指定池，無需跨池換倉');
        if (!active.some((item) => String(item.poolId).toLowerCase() === poolId
          && String(item.id).toLowerCase() === positionId)) {
          throw new Error('來源 LP 已變動，請重新掃描後選擇部位');
        }
        sourcePool = this.market.pools.find((item) => item.id.toLowerCase() === poolId);
        position = sourcePool?.positions?.find((item) => item.id.toLowerCase() === positionId);
        if (!sourcePool || !position) throw new Error('來源 LP 已不在最新清單');
      }
      if (destinationPool.state?.paused !== false || BigInt(destinationPool.state?.liquidity || 0) <= 0n) {
        throw new Error('目的池已暫停或沒有可用流動性');
      }
      if (hasNativeCurrency(sourcePool) || hasNativeCurrency(destinationPool)) {
        throw new Error('原生 ETH 池尚未支援立即跨池換倉');
      }
      if ((this.executionPaused && !(idleWallet && directExecute && this.resumeExecutionAfterStartup))
        || this.config.dryRun || !this.config.enableLiveWrites) {
        throw new Error('立即換倉需要未暫停的實盤執行狀態');
      }
      // Explicit manual rotation uses a fresh wallet scan and full-sequence
      // preflight. Automatic retry timers and quotas do not apply.
      if (!idleWallet && this.config.targetMode === 'wallet-active'
        && !(await this.revalidateTopologyBeforeExecution(snapshot.blockNumber, [{ pool: sourcePool, position }]))) {
        throw new Error('錢包 LP 部位在預演期間變動');
      }
      const plan = {
        pool: sourcePool, destinationPool, position, routingPools: this.market.pools,
        destinationStats: this.market.fablesStats?.pools?.get(destinationPoolId) || null,
        manualImmediate: true, manualIdle: idleWallet,
        manualSource: 'dashboard', manualMaxCostBps: costCapBps
      };
      if (previewOnly) {
        await this.executor.assertLiveReady(plan);
        this.executor.assertNoUnfinishedExecution();
        const result = await this.executor.preflightCrossPoolSequence(plan, destinationPool);
        const id = randomUUID();
        this.manualRotationPreview = {
          id, expiresAt: Date.now() + 10 * 60_000,
          wallet: this.config.walletAddress.toLowerCase(), poolId, positionId,
          destinationPoolId, maxCostBps: costCapBps
        };
        return {
          status: 'ready', previewId: id, expiresAt: this.manualRotationPreview.expiresAt,
          sourcePair: `${sourcePool.token0.symbol}/${sourcePool.token1.symbol}`,
          destinationPair: `${destinationPool.token0.symbol}/${destinationPool.token1.symbol}`,
          totalImpactBps: result.totalImpactBps,
          simulatedGasUsed: result.simulatedGasUsed,
          simulatedCallCount: result.simulatedCallCount,
          pendingApprovalCount: result.pendingApprovalCount,
          maxCostBps: costCapBps,
          target: result.finalTarget
        };
      }
      if (directExecute) {
        await this.executor.assertLiveReady(plan);
        this.executor.assertNoUnfinishedExecution();
      }
      this.ledger.append('rebalance.manual_immediate_requested', {
        poolId: idleWallet ? null : poolId, positionId: idleWallet ? null : positionId, destinationPoolId,
        sourcePair: `${sourcePool.token0.symbol}/${sourcePool.token1.symbol}`,
        destinationPair: `${destinationPool.token0.symbol}/${destinationPool.token1.symbol}`
      });
      if (idleWallet) {
        try {
          const result = await this.executor.executeCrossPool(plan, destinationPool);
          if (result.status === 'completed') {
            this.persistInvestmentTarget('specific-pool', destinationPool);
            this.state.setSetting('lastAction', `completed wallet → ${destinationPool.token0.symbol}/${destinationPool.token1.symbol}`);
            if (this.executionPaused && this.resumeExecutionAfterStartup) {
              this.setExecutionPaused(false, 'manual_idle_rotation');
              this.resumeExecutionAfterStartup = false;
            }
          }
          return result;
        } catch (error) {
          if (this.state.getSetting('activeRebalanceExecution', null)?.phase === 'recovery_required') {
            this.setExecutionPaused(true, 'idle_rotation_recovery_required');
          }
          throw error;
        }
      }
      const result = await this.maybeRebalance(sourcePool, position, {
        source: 'dashboard', manualImmediate: true, destinationPool,
        manualMaxCostBps: costCapBps, throwOnFailure: true
      });
      if (result.status === 'completed') this.persistInvestmentTarget('specific-pool', destinationPool);
      return result;
    } finally {
      this.cycleActive = false;
    }
  }

  resolveIdleRotationSource(snapshot, destinationPool) {
    const destinationTokens = new Set([
      destinationPool.token0.address.toLowerCase(), destinationPool.token1.address.toLowerCase()
    ]);
    const inventory = snapshot?.portfolio?.inventory || {};
    const prices = this.market.prices;
    const others = Object.entries(inventory).filter(([address, amount]) => {
      const key = address.toLowerCase();
      return key !== ZERO_ADDRESS && !destinationTokens.has(key)
        && Number(amount) * Number(prices.get(key) || 0) >= 1;
    });
    if (others.length > 1) throw new Error('錢包有多種待換代幣；請先整理餘額，避免誤換無關資產');
    if (!others.length) return destinationPool;
    const tokenAddress = others[0][0].toLowerCase();
    const sourcePool = this.market.pools.find((pool) =>
      !hasNativeCurrency(pool)
      && [pool.token0.address.toLowerCase(), pool.token1.address.toLowerCase()].includes(tokenAddress)
      && [pool.token0.address.toLowerCase(), pool.token1.address.toLowerCase()]
        .includes(this.config.usdgAddress.toLowerCase()));
    if (!sourcePool) throw new Error('找不到錢包待換代幣與 USDG 的有效來源池');
    return sourcePool;
  }

  async refreshMarket(force = false) {
    if (!force && Date.now() - this.market.refreshedAt < this.config.marketRefreshMs) return this.market;
    log('info', 'market.refresh_started', { force });
    const latestBlock = await this.providers.readProvider.getBlockNumber();
    const fullStateRefresh = force || !this.market.pools.length
      || Date.now() - Number(this.market.stateRefreshedAt || 0) >= (this.config.marketStateRefreshMs || 5 * 60_000);
    const pools = fullStateRefresh
      ? await this.fables.hydratePoolStates(await this.fables.discoverAllPools())
      : this.market.pools;
    // TVL weights USD price routes; the separate 24h fee/APR endpoint is only
    // queried when an OOR position passes the execution gates.
    let fablesStats = this.market.fablesStats;
    try { fablesStats = await fetchFablesPoolTvl(); }
    catch (error) { log('warn', 'fables.tvl_unavailable', { error: error.message }); }
    const prices = buildUsdPriceMap(pools, this.config.usdgAddress, { fablesStats });
    this.market = {
      refreshedAt: Date.now(),
      stateRefreshedAt: fullStateRefresh ? Date.now() : this.market.stateRefreshedAt,
      pools, prices, latestBlock, fablesStats
    };
    if (this.config.pointsGlobalSwapScanEnabled !== false) {
      const retryAt = Number(this.state.getSetting('pointsGlobalScanRetryAt', 0) || 0);
      if (!this.globalPointScanPromise && Date.now() >= retryAt) {
        log('info', 'points.global_scan_started', { block: latestBlock, pools: pools.length });
        const scan = this.scanGlobalPointFees(pools, latestBlock)
          .catch((error) => log('warn', 'points.global_scan_failed', { error: error.message }))
          .finally(() => {
            if (this.globalPointScanPromise === scan) this.globalPointScanPromise = null;
          });
        this.globalPointScanPromise = scan;
      }
    } else {
      log('info', 'points.global_scan_skipped', { reason: 'POINTS_GLOBAL_SWAP_SCAN_ENABLED=false' });
    }
    await this.scanGlobalPoolFees(pools, latestBlock);
    log('info', 'market.refreshed', {
      block: latestBlock,
      pools: pools.length,
      fullStateRefresh,
      pricedAssets: prices.size,
      targetMode: this.config.targetMode,
      targetPools: this.config.targetMode === 'wallet-active' ? null : this.fables.targetPools(pools).length
    });
    return this.market;
  }

  async refreshAprForRebalance() {
    const fablesStats = await fetchFablesPoolStats();
    this.market.fablesStats = fablesStats;
    this.market.prices = buildUsdPriceMap(this.market.pools, this.config.usdgAddress, { fablesStats });
    if (this.snapshot) {
      const watched = new Set((this.state.getSetting('watchedPoolIds', []) || [])
        .map((id) => String(id).toLowerCase()));
      this.snapshot = {
        ...this.snapshot,
        markets: this.market.pools.map((pool) => snapshotMarket(
          pool, fablesStats.pools?.get(pool.id.toLowerCase()) || null,
          watched.has(pool.id.toLowerCase()), fablesStats
        )),
        prices: Object.fromEntries(this.market.prices),
        bot: { ...this.snapshot.bot, investmentTarget: this.getInvestmentTargetSnapshot() }
      };
      this.ledger.writeSnapshot(this.snapshot);
    }
    log('info', 'market.apr_refreshed_for_rebalance', {
      pools: fablesStats.pools?.size || 0,
      observedAt: fablesStats.observedAt
    });
    return fablesStats;
  }

  async refreshPoolQuoteProbes() {
    if (this.cycleActive) throw new Error('Wait for the current wallet scan or execution to finish');
    if (this.poolQuoteProbePromise) return this.poolQuoteProbePromise;
    const probe = probePoolSwapCosts({
      pools: this.market.pools,
      quoter: this.quoter,
      usdPrices: this.market.prices,
      usdgAddress: this.config.usdgAddress,
      slippageBps: this.config.swapSlippageBps
    }).then((quotes) => {
      this.state.setSetting('poolQuoteProbes', quotes);
      this.ledger.append('market.pool_quote_probes_refreshed', {
        total: Object.keys(quotes).length,
        quoted: Object.values(quotes).filter((entry) => entry.status === 'quoted').length,
        approximatelyThreePercent: Object.values(quotes).filter((entry) => entry.approximatelyThreePercent).length
      });
      return quotes;
    }).finally(() => { this.poolQuoteProbePromise = null; });
    this.poolQuoteProbePromise = probe;
    return probe;
  }

  async runOnce(options = {}) {
    const executeRebalances = options.executeRebalances !== false;
    if (this.rpcManagementActive || this.initializing) {
      if (options.source) throw new Error('busy');
      log('warn', 'cycle.skipped', { reason: 'rpc management is active' });
      return this.snapshot;
    }
    if (this.cycleActive) {
      log('warn', 'cycle.skipped', { reason: 'previous cycle still running' });
      return this.snapshot;
    }
    this.cycleActive = true;
    try {
      try {
        await this.refreshMarket(false);
      } catch (error) {
        if (!this.market.pools.length) throw error;
        // A registry/APR refresh failure must not freeze fresh on-chain LP checks.
        // APR rotation still rejects stale statistics in rankAprPools.
        log('warn', 'market.refresh_failed_using_cached_pools', { error: error.message });
      }
      const latestBlock = await this.providers.readProvider.getBlockNumber();
      this.market.latestBlock = latestBlock;
      const selection = await this.resolveTargetPools(latestBlock);
      const targetPools = selection.pools;
      const accountingPools = selection.accountingPools || targetPools;
      if (!targetPools.length) {
        // No active LP is an execution state, not a reason to freeze accounting.
        // Continue through the normal wallet-balance/portfolio path using known
        // historical pools so a manual full withdrawal is reflected immediately.
        log('warn', 'wallet_pool.none_active', {
          targetMode: this.config.targetMode,
          block: latestBlock,
          accountingPools: accountingPools.map((pool) => pool.id)
        });
      }

      this.points.noteUserTrackingStarted(Date.now());
      const executionPoolIds = new Set(targetPools.map((pool) => pool.id.toLowerCase()));

      // Accounting must continue for pools that just became inactive; otherwise a
      // full withdrawal can disappear from the execution set before its final fee
      // claim is reconciled.
      for (const pool of accountingPools) {
        pool.state = await this.fables.readPoolState(pool);
        const cursorKey = `positionLogs:${pool.id}`;
        const candidatesKey = `positionCandidates:${pool.id}`;
        const knownCandidates = this.state.getSetting(candidatesKey, []) || [];
        const candidates = this.fables.positionCandidates.get(pool.id) || new Set(this.config.positionIds);
        for (const id of knownCandidates) {
          if (/^0x[0-9a-f]{64}$/i.test(String(id))) candidates.add(String(id).toLowerCase());
        }
        this.fables.positionCandidates.set(pool.id, candidates);
        const fallbackCursor = this.config.targetMode === 'wallet-active'
          ? Math.max(this.config.logFromBlock, latestBlock - this.config.reorgLookbackBlocks)
          : this.config.logFromBlock;
        const previousCursor = this.state.getCursor(cursorKey, fallbackCursor);
        const fromBlock = Math.max(this.config.logFromBlock, previousCursor - this.config.reorgLookbackBlocks);
        const result = await this.fables.discoverPositions(pool, fromBlock, latestBlock);
        pool.positions = result.positions;
        this.state.setSetting(candidatesKey, [...this.fables.positionCandidates.get(pool.id)].sort());
        await this.recordLifecycleLogs(pool, result.lifecycleLogs);
        this.state.setCursor(cursorKey, latestBlock + 1);
        for (const position of pool.positions) {
          if (executionPoolIds.has(pool.id.toLowerCase())) await this.decoratePosition(pool, position);
          this.trackFeeAccrual(pool, position);
        }
      }
      await this.backfillGuardedWithdrawFees();

      const uniqueTokens = uniqueTargetTokens(accountingPools);
      if (!uniqueTokens.some((token) => token.address.toLowerCase() === ZERO_ADDRESS)) {
        uniqueTokens.push({ address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 });
      }
      const walletBalances = await this.fables.readWalletBalances(uniqueTokens);
      try { await this.scanExternalCashflows(latestBlock); }
      catch (error) {
        this.state.setSetting('cashflowCoverage', {
          complete: false, error: sanitize(error.message), at: Date.now()
        });
        log('warn', 'cashflow.scan_failed', { error: error.message });
      }
      if (this.getInvestmentAllocationConfig?.()?.enabled === true) {
        await this.refreshAllocationFundingSnapshot({ pools: targetPools, walletBalances, asOfBlock: latestBlock });
      }
      const portfolio = this.analytics.build({
        targetPools: accountingPools,
        walletBalances,
        prices: this.market.prices,
        trackedTokens: uniqueTokens,
        blockNumber: latestBlock
      });
      await this.attachRebalanceQuotes(targetPools, portfolio);
      const points = this.points.snapshot();
      if (this.config.walletAddress.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
        this.walletImportState = { status: 'ready', address: this.config.walletAddress, error: null };
      }
      const snapshot = {
        generatedAt: Date.now(),
        blockNumber: latestBlock,
        markets: this.market.pools.map((pool) => snapshotMarket(
          pool,
          this.market.fablesStats?.pools?.get(pool.id) || null,
          new Set((this.state.getSetting('watchedPoolIds', []) || []).map((id) => String(id).toLowerCase())).has(pool.id.toLowerCase()),
          this.market.fablesStats
        )),
        bot: {
          version: '0.6.0',
          wallet: this.config.walletAddress,
          walletImportState: this.walletImportState,
          dryRun: this.config.dryRun,
          liveWrites: this.config.enableLiveWrites,
          autoRedeploy: this.config.enableAutoRedeploy,
          autoTopupEnabled: this.config.autoTopupEnabled,
          executionPaused: this.executionPaused,
          lastAction: this.state.getSetting('lastAction', null),
          targetMode: this.config.targetMode,
          investmentTarget: this.getInvestmentTargetSnapshot(),
          investmentAllocation: this.getInvestmentAllocationSnapshot(),
          activePoolIds: targetPools.map((pool) => pool.id),
          accountingPoolIds: accountingPools.map((pool) => pool.id),
          watchedPoolIds: this.state.getSetting('watchedPoolIds', []) || [],
          topologyCooldownUntil: this.state.getSetting('walletTopologyCooldownUntil', 0),
          targetSymbols: this.config.targetSymbols,
          swapSlippageBps: this.config.swapSlippageBps,
          rangePolicy: rangePolicySnapshot(this.config),
          absoluteInRangeHold: true,
          activeRebalanceExecution: this.state.getSetting('activeRebalanceExecution', null)
        },
        rpcHealth: this.rpcHealth,
        portfolio,
        points,
        prices: Object.fromEntries(this.market.prices),
        walletBalances: Object.fromEntries(Object.entries(walletBalances).map(([k, v]) => [k, { amount: v.amount }])),
        pools: targetPools.map(snapshotPool)
      };
      this.snapshot = snapshot;
      this.capturePendingLpStopLossReference(snapshot);
      this.ledger.writeSnapshot(snapshot);
      this.recordPortfolioSnapshot(snapshot);

      const pendingRebalances = targetPools.flatMap((pool) =>
        (pool.positions || [])
          .filter((position) => position.outside === true && position.shouldRebalance === true)
          .map((position) => ({ pool, position }))
      );
      if (!executeRebalances || this.allocationUpdatePending) return snapshot;
      if (this.state.getSetting('stopLossLatched', false) || this.stopLiquidationPromise) return snapshot;
      const risk = this.getStopLossSnapshot();
      if (!this.executionPaused && risk.settings.enabled) {
        if (risk.status === 'unavailable') {
          this.setExecutionPaused(true, 'stop-loss-valuation-unavailable');
          return snapshot;
        }
        if (risk.triggered) {
          this.ledger.append('stop_loss.triggered', risk);
          try { await this.performStopLiquidation(); }
          catch (error) { log('error', 'stop_loss.liquidation_failed', { error: error.message }); }
          return snapshot;
        }
      }
      if (this.getInvestmentAllocationConfig?.()?.enabled === true) {
        await this.runAllocationExecutionCycle(targetPools, pendingRebalances);
        if (this.snapshot) {
          this.snapshot = {
            ...this.snapshot,
            bot: { ...this.snapshot.bot, investmentAllocation: this.getInvestmentAllocationSnapshot() }
          };
          this.ledger.writeSnapshot(this.snapshot);
        }
        return this.snapshot;
      }
      if (pendingRebalances.length && this.config.targetMode === 'wallet-active') {
        const stable = await this.revalidateTopologyBeforeExecution(latestBlock, pendingRebalances);
        if (!stable) return snapshot;
      }
      for (const { pool, position } of pendingRebalances) {
        await this.maybeRebalance(pool, position);
      }
      if (!pendingRebalances.length) await this.maybeTopUpIdleBalance(targetPools, walletBalances);
      return snapshot;
    } finally {
      this.cycleActive = false;
      if (this.stopLiquidationReadbackPending || this.capitalReadbackPending) {
        const readbackSource = this.stopLiquidationReadbackPending ? 'auto-stop-readback' : 'capital-readback';
        this.stopLiquidationReadbackPending = false;
        this.capitalReadbackPending = false;
        const timer = setTimeout(() => {
          void this.runOnce({ executeRebalances: false, source: readbackSource })
            .catch(error => log('warn', 'portfolio.readback_deferred', { source: readbackSource, error: error.message }));
        }, 0);
        timer.unref?.();
      }
    }
  }

  async runAllocationJob(pool, kind, run) {
    const key = pool.id.toLowerCase() + ':' + kind;
    const backoffs = this.state.getSetting('allocationJobBackoffs', {}) || {};
    if (Date.now() < Number(backoffs[key]?.nextRetryAt || 0)) return { status: 'deferred', reason: 'allocation-backoff' };
    try {
      const result = await run();
      if (result?.status === 'completed') {
        const next = { ...backoffs }; delete next[key]; this.state.setSetting('allocationJobBackoffs', next);
      } else if (result?.status === 'dry-run' || result?.status === 'full-sequence-simulated' || result?.status === 'deferred') {
        this.ledger.append(result.status === 'deferred' ? 'allocation.job_deferred' : 'allocation.bootstrap_dry_run', { poolId: pool.id, ...result });
        this.state.setSetting('allocationJobBackoffs', { ...backoffs,
          [key]: { count: 0, nextRetryAt: Date.now() + (this.config.autoTopupMinIntervalSec || 300) * 1000 } });
      }
      return result;
    } catch (error) {
      const count = Number(backoffs[key]?.count || 0) + 1;
      const nextRetryAt = Date.now() + Math.min(30 * 60_000, 5 * 60_000 * 2 ** Math.min(count - 1, 6));
      this.state.setSetting('allocationJobBackoffs', { ...backoffs, [key]: { count, nextRetryAt } });
      this.ledger.append('allocation.job_failed', { poolId: pool.id, kind, error: sanitize(error.message), nextRetryAt });
      if (this.state.getSetting('activeRebalanceExecution', null)?.phase === 'recovery_required') {
        this.setExecutionPaused(true, 'allocation_recovery_required');
        this.ledger.append('rebalance.auto_paused', { poolId: pool.id, reason: 'allocation_recovery_required' });
      }
      return { status: 'failed', reason: sanitize(error.message), nextRetryAt };
    }
  }

  async runAllocationExecutionCycle(targetPools, pendingRebalances) {
    try {
      return await this.runAllocationExecutionCycleUnlocked(targetPools, pendingRebalances);
    } catch (error) {
      this.ledger.append('allocation.cycle_blocked', { error: sanitize(error.message) });
      if (this.state.getSetting('activeRebalanceExecution', null)?.phase === 'recovery_required') {
        this.setExecutionPaused(true, 'allocation_recovery_required');
      }
      return { status: 'blocked', reason: sanitize(error.message) };
    }
  }

  async runAllocationExecutionCycleUnlocked(targetPools, pendingRebalances) {
    if (this.allocationUpdatePending || this.executionPaused || (this.config.dryRun !== true
      && (!this.config.enableLiveWrites || !this.config.enableAutoRedeploy || !this.config.privateKey))) return null;
    const journal = this.state.getSetting('activeRebalanceExecution', null);
    if (journal?.phase && !['completed', 'failed'].includes(journal.phase)) return null;

    // One capital-moving job per monitor cycle. This keeps the token caps fixed
    // across every receipt in a sequence; the next cycle recomputes balances,
    // LP equity, and shared USDG reservations from chain state.
    if (this.getInvestmentAllocationSnapshot().status !== 'ready') {
      this.ledger.append('allocation.blocked', { reason: 'allocation-valuation-not-ready' });
      return { status: 'blocked', reason: 'allocation-valuation-not-ready' };
    }
    const refreshedDue = [];
    for (const candidate of pendingRebalances) {
      const pool = targetPools.find((entry) => entry.id.toLowerCase() === candidate.pool.id.toLowerCase());
      const position = pool?.positions?.find((entry) => entry.id.toLowerCase() === candidate.position.id.toLowerCase());
      if (!pool || !position) continue;
      await this.decoratePosition(pool, position);
      const backoff = rebalanceFailureMap(this.state)[rebalanceFailureKey(pool, position)];
      if (position.outside === true && position.shouldRebalance === true
        && !(backoff && Date.now() < Number(backoff.nextRetryAt || 0))) {
        refreshedDue.push({ pool, position });
      }
    }
    refreshedDue.sort((a, b) => Number(a.position.outOfRangeSince || 0)
      - Number(b.position.outOfRangeSince || 0));
    const due = refreshedDue[0];
    if (due) {
      const scope = this.getAllocationFundingScope(due.pool.id);
      return this.maybeRebalance(due.pool, due.position, {
        source: 'allocation-out-of-range', allocationFundingScope: scope
      });
    }

    if (!this.config.autoTopupEnabled) return null;
    const fundingOrder = [...targetPools].sort((a, b) => {
      const hasActive = (pool) => (pool.positions || []).some((position) => BigInt(position.shares || 0) > 0n);
      return Number(hasActive(a)) - Number(hasActive(b));
    });
    for (const pool of fundingOrder) {
      const kind = (pool.positions || []).some(entry => BigInt(entry.shares || 0) > 0n) ? 'topup' : 'bootstrap';
      const backoff = this.state.getSetting('allocationJobBackoffs', {})?.[pool.id.toLowerCase() + ':' + kind];
      if (Date.now() < Number(backoff?.nextRetryAt || 0)) continue;
      const scope = this.getAllocationFundingScope(pool.id);
      const availableUsdG = Number(scope.availableUsdG || 0);
      if (!Number.isFinite(availableUsdG) || availableUsdG < this.config.autoTopupMinIdleUsd) continue;
      const active = (pool.positions || []).filter((position) => BigInt(position.shares || 0) > 0n);
      if (active.length === 0) {
        const result = await this.runAllocationJob(pool, 'bootstrap', () => this.executor.executeAllocationBootstrap({
          pool,
          allocationFundingScope: scope,
          maxPriceImpactBps: this.executor.allocationSwapMaxImpactBps?.(pool)
            ?? this.config.maxSwapPriceImpactBps ?? 200,
          minGasReserveWei: this.config.topUpMinGasReserveWei
        }));
        if (result?.status === 'completed') {
          await this.refreshAllocationFundingSnapshot({ pools: targetPools, refreshPositions: true });
        }
        return result;
      }
      const position = active.filter((entry) => entry.outside === false
        && pool.state.tick >= entry.tickLower && pool.state.tick < entry.tickUpper)
        .sort((a, b) => { const left = BigInt(a.shares), right = BigInt(b.shares);
          return left === right ? String(a.id).localeCompare(String(b.id)) : left > right ? -1 : 1; })[0];
      if (!position) continue;
      if (position.outside !== false || pool.state.tick < position.tickLower
        || pool.state.tick >= position.tickUpper) continue;
      const key = `${pool.id.toLowerCase()}:${position.id.toLowerCase()}`;
      const attempts = this.state.getSetting('autoTopupAttempts', {}) || {};
      const previous = attempts[key];
      if (previous && Date.now() - Number(previous.at || 0)
        < this.config.autoTopupMinIntervalSec * 1000) continue;
      const next = Object.fromEntries(Object.entries(attempts)
        .filter(([, entry]) => Date.now() - Number(entry?.at || 0) < 7 * 24 * 60 * 60_000));
      next[key] = { at: Date.now(), idleUsd: availableUsdG };
      this.state.setSetting('autoTopupAttempts', next);
      const result = await this.runAllocationJob(pool, 'topup', () => this.executor.topUpPoolPosition({
        pool, position, dustBps: this.config.autoTopupDustBps,
        minGasReserveWei: this.config.topUpMinGasReserveWei,
        allocationFundingScope: scope
      }));
      if (result?.status === 'completed') {
        await this.refreshAllocationFundingSnapshot({ pools: targetPools, refreshPositions: true });
      }
      return result;
    }
    return null;
  }

  async scanExternalCashflows(latestBlock) {
    const baseline = this.ledger.readBaseline();
    if (!baseline) return;
    const wallet = this.config.walletAddress.toLowerCase();
    const baselineMs = Number(baseline.createdAt);
    if (!Number.isFinite(baselineMs) || baselineMs <= 0) throw new Error('Portfolio baseline timestamp unavailable');
    if (!Object.hasOwn(baseline.inventory || {}, ZERO_ADDRESS)) {
      const native = await fetchNativeBalanceAt({
        wallet, atMs: baselineMs, apiKey: this.config.blockscoutApiKey
      });
      const ethBasisPriceUsd = native.amount > 0 ? await fetchEthUsdCloseAt(baselineMs) : 0;
      const recovered = {
        ...baseline,
        inventory: { ...baseline.inventory, [ZERO_ADDRESS]: native.amount },
        initialValueUsd: Number(baseline.initialValueUsd) + native.amount * ethBasisPriceUsd,
        nativeBasisPriceUsd: ethBasisPriceUsd,
        nativeBasisSource: 'Blockscout balance history; Coinbase transfer-minute ETH/USD close',
        nativeBasisBlockNumber: native.blockNumber
      };
      this.ledger.writeBaseline(recovered);
      this.ledger.append('portfolio.native_baseline_recovered', {
        amountEth: native.amount, ethBasisPriceUsd, basisUsd: native.amount * ethBasisPriceUsd,
        blockNumber: native.blockNumber, baselineCreatedAt: baselineMs
      });
    }
    const previousScan = Number(this.state.getSetting('externalCashflowScannedAt', 0));
    const sinceMs = Math.max(baselineMs, previousScan > 0 ? previousScan - 60 * 60_000 : baselineMs);
    const candidates = await fetchWalletCashflowCandidates({
      wallet, usdgAddress: this.config.usdgAddress, sinceMs,
      apiKey: this.config.blockscoutApiKey
    });
    const ethPriceCache = new Map();
    for (const { type, direction, timestamp, item } of candidates) {
      if (item.status && item.status !== 'ok') continue;
      const from = String(item.from?.hash || '').toLowerCase();
      const to = String(item.to?.hash || '').toLowerCase();
      if (direction === 'in' && to !== wallet) continue;
      if (direction === 'out' && from !== wallet) continue;
      const counterparty = direction === 'in' ? from : to;
      const counterpartyInfo = direction === 'in' ? item.from : item.to;
      const hash = String(item.transaction_hash || item.hash || '').toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(hash)) continue;
      if (type === 'usdg') {
        if (String(item.token?.address_hash || '').toLowerCase() !== this.config.usdgAddress.toLowerCase()) continue;
        const decimals = Number(item.total?.decimals);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
        const amount = Number(formatUnits(BigInt(item.total.value), decimals));
        if (!(amount > 0)) continue;
        const eventKey = `cashflow:usdg:${hash}:${Number(item.log_index)}`;
        if (direction === 'in' && counterparty === PROLOGUE_FEE_DISTRIBUTOR
          && item.method === '0x3d13f874') {
          this.ledger.appendUnique(eventKey, 'reward.claimed', {
            token: this.config.usdgAddress.toLowerCase(), symbol: 'USDG', amount, usd: amount,
            hash, blockNumber: Number(item.block_number), classification: 'contract-claim-transfer'
          }, timestamp);
        } else if (counterpartyInfo?.is_contract === false) {
          const signed = direction === 'in' ? amount : -amount;
          this.ledger.appendUnique(eventKey, 'cashflow.external_transfer', {
            token: this.config.usdgAddress.toLowerCase(), symbol: 'USDG', amount: signed, usd: signed,
            direction, hash, blockNumber: Number(item.block_number),
            logIndex: Number(item.log_index), counterparty, classification: 'external-eoa-transfer'
          }, timestamp);
        }
      } else if (type === 'eth' && counterpartyInfo?.is_contract === false) {
        const amount = Number(formatUnits(BigInt(item.value || 0), 18));
        if (!(amount > 0)) continue;
        const priceMinute = Math.floor(timestamp / 60_000);
        if (!ethPriceCache.has(priceMinute)) ethPriceCache.set(priceMinute, await fetchEthUsdCloseAt(timestamp));
        const ethPriceUsd = ethPriceCache.get(priceMinute);
        const signed = direction === 'in' ? amount : -amount;
        this.ledger.appendUnique(`cashflow:eth:${hash}`, 'cashflow.external_transfer', {
          token: ZERO_ADDRESS, symbol: 'ETH', amount: signed, usd: signed * ethPriceUsd,
          direction, hash, blockNumber: Number(item.block_number), counterparty,
          classification: 'external-eoa-transfer', priceBasis: 'transfer-minute ETH/USD close'
        }, timestamp);
      }
    }
    this.state.setSetting('externalCashflowScannedAt', Date.now());
    this.state.setSetting('cashflowCoverage', {
      complete: true, source: 'blockscout', throughBlock: latestBlock, at: Date.now()
    });
  }

  async resolveTargetPools(latestBlock) {
    if (this.config.targetMode !== 'wallet-active') {
      const pools = this.fables.targetPools(this.market.pools);
      return { pools, accountingPools: pools, discovery: null };
    }
    if (this.config.walletAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      return { pools: [], accountingPools: [], discovery: null };
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

    const allocation = this.getInvestmentAllocationConfig?.() || { enabled: false, allocations: [] };
    if (!allocation.enabled) {
      return { pools: result.activePools, accountingPools: result.knownPools || result.activePools, discovery: result };
    }
    const selectedPools = allocation.allocations.map((entry) => this.market.pools.find((pool) =>
      pool.id.toLowerCase() === entry.poolId)).filter(Boolean);
    const accounting = new Map((result.knownPools || result.activePools).map((pool) =>
      [pool.id.toLowerCase(), pool]));
    for (const pool of selectedPools) accounting.set(pool.id.toLowerCase(), pool);
    return { pools: selectedPools, accountingPools: [...accounting.values()], discovery: result };
  }

  async revalidateTopologyBeforeExecution(snapshotBlock, pendingRebalances = []) {
    const beforePoolIds = (this.state.getSetting('activeWalletPoolIds', []) || [])
      .map((x) => String(x).toLowerCase()).sort();
    const beforeRangeKeys = (this.state.getSetting('activeWalletRangeKeys', []) || [])
      .map((x) => String(x).toLowerCase()).sort();
    const latest = await this.providers.readProvider.getBlockNumber();
    if (latest <= snapshotBlock) return true;

    const verification = await this.resolveTargetPools(latest);
    const afterPoolIds = (verification.discovery?.activePoolIds || [])
      .map((x) => String(x).toLowerCase()).sort();
    const afterRangeKeys = (verification.discovery?.activeRangeKeys || [])
      .map((x) => String(x).toLowerCase()).sort();
    const stable = sameStringArray(beforePoolIds, afterPoolIds)
      && sameStringArray(beforeRangeKeys, afterRangeKeys);

    if (!stable) {
      for (const { pool, position } of pendingRebalances) {
        this.ledger.append('rebalance.blocked', {
          positionId: position.id,
          poolId: pool.id,
          reason: 'wallet topology changed during cycle',
          snapshotBlock,
          verificationBlock: latest,
          beforePoolIds,
          afterPoolIds,
          beforeRangeKeys,
          afterRangeKeys
        });
      }
      log('warn', 'rebalance.topology_race_blocked', {
        snapshotBlock,
        verificationBlock: latest,
        beforePoolIds,
        afterPoolIds,
        beforeRangeKeys,
        afterRangeKeys
      });
      return false;
    }
    return true;
  }

  async attachRebalanceQuotes(targetPools, portfolio) {
    for (const metric of portfolio.positions || []) {
      // Chain quote/deposit planning is only needed once the hysteresis policy has
      // actually made the position execution-eligible. Waiting OOR positions keep
      // their analytical inventory plan but do not burn RPC quota on transient quotes.
      if (!metric.outside || !metric.shouldRebalance || !metric.rebalancePlan || !metric.target) continue;
      const pool = targetPools.find((x) => x.id === metric.poolId);
      if (!pool) continue;
      let quote = null;
      try {
        if (metric.rebalancePlan.direction !== 'none' && metric.rebalancePlan.amountIn > 0) {
          quote = await this.quoter.quoteExactInputSingle(
            pool,
            metric.rebalancePlan.tokenIn,
            metric.rebalancePlan.amountIn,
            this.config.swapSlippageBps
          );
          metric.rebalanceQuote = quote;
        }
        metric.depositPlan = buildDepositPlan({
          amount0: metric.amount0 + metric.owed0,
          amount1: metric.amount1 + metric.owed1,
          inventoryPlan: metric.rebalancePlan,
          quote,
          sqrtPriceX96: pool.state.sqrtPriceX96,
          tickLower: metric.target.tickLower,
          tickUpper: metric.target.tickUpper,
          decimals0: pool.token0.decimals,
          decimals1: pool.token1.decimals,
          slippageBps: this.config.depositSlippageBps,
          liquidityReserveBps: this.config.depositLiquidityReserveBps
        });
        const position = (pool.positions || []).find((x) => x.id.toLowerCase() === metric.id.toLowerCase());
        if (position) {
          position.rebalancePlan = metric.rebalancePlan;
          position.rebalanceQuote = quote;
          position.depositPlan = metric.depositPlan;
        }
      } catch (error) {
        metric.rebalanceQuoteError = error.message;
        metric.depositPlan = null;
        log('warn', 'rebalance.plan_failed', { positionId: metric.id, poolId: metric.poolId, error: error.message });
      }
    }
  }

  recordPortfolioSnapshot(snapshot) {
    const now = snapshot.generatedAt;
    const last = Number(this.state.getSetting('lastPortfolioSnapshotAt', 0) || 0);
    if (last && now - last < this.config.portfolioSnapshotIntervalMs) return;
    this.ledger.append('portfolio.snapshot', {
      accountingVersion: 2,
      blockNumber: snapshot.blockNumber,
      currentValueUsd: snapshot.portfolio.currentValueUsd,
      netInvestedUsd: snapshot.portfolio.netInvestedUsd,
      externalCashflowUsd: snapshot.portfolio.externalCashflowUsd,
      accountingComplete: snapshot.portfolio.accountingComplete,
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
    const nowMs = Date.now();
    const evaluation = evaluatePosition({
      currentTick: pool.state.tick,
      tickSpacing: pool.key.tickSpacing,
      position,
      widthBps: this.config.tightWidthBps,
      rangePreset: this.config.rangePreset,
      edgeBufferTicks: this.config.edgeBufferTicks,
      lastEvaluationAt: Number(stored.lastRangeEvaluationAt || 0),
      outOfRangeSince: Number(stored.outOfRangeSince || 0),
      checkIntervalMs: this.config.rangeCheckIntervalMs,
      confirmDelayMs: this.config.oorConfirmDelayMs,
      cooldownUntil: stored.cooldownUntil || 0,
      nowMs
    });
    Object.assign(position, {
      outside: evaluation.outside,
      nearEdge: Boolean(evaluation.nearEdge),
      excursionPct: evaluation.excursionPct,
      outOfRangeSince: evaluation.outOfRangeSince,
      outOfRangeElapsedMin: evaluation.outOfRangeElapsedMs / 60000,
      evaluationDue: evaluation.evaluationDue,
      lastRangeEvaluationAt: evaluation.evaluatedAt,
      nextRangeEvaluationAt: evaluation.nextEvaluationAt,
      cooldownActive: evaluation.cooldownActive,
      shouldRebalance: pool.state?.paused === false && evaluation.shouldRebalance,
      rebalanceReason: pool.state?.paused === false ? evaluation.rebalanceReason : null,
      executionBlockedReason: pool.state?.paused === false ? null : 'fables pool paused or status unknown',
      target: evaluation.target
    });
    this.state.setPosition(stateKey, {
      outOfRangeConfirmations: 0,
      deepOutOfRangeConfirmations: 0,
      outOfRangeSince: evaluation.outOfRangeSince,
      lastRangeEvaluationAt: evaluation.evaluatedAt,
      lastExcursionPct: evaluation.excursionPct,
      lastTick: pool.state.tick,
      lastSeenAt: nowMs,
      lastRange: [position.tickLower, position.tickUpper]
    });
    log(evaluation.outside ? 'warn' : 'info', 'position.status', {
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      id: position.id,
      tick: pool.state.tick,
      range: [position.tickLower, position.tickUpper],
      outside: evaluation.outside,
      excursionPct: evaluation.excursionPct,
      outOfRangeElapsedMin: evaluation.outOfRangeElapsedMs / 60000,
      evaluationDue: evaluation.evaluationDue,
      shouldRebalance: pool.state?.paused === false && evaluation.shouldRebalance,
      rebalanceReason: pool.state?.paused === false ? evaluation.rebalanceReason : null,
      executionBlockedReason: pool.state?.paused === false ? null : 'fables pool paused or status unknown',
      target: evaluation.target
    });
  }

  trackFeeAccrual(pool, position) {
    const key = `feeState:${positionStateKey(pool, position)}`;
    const previous = this.state.getSetting(key, null);
    const current = { owed0: position.owed0.toString(), owed1: position.owed1.toString(), shares: position.shares.toString(), at: Date.now() };
    this.state.setSetting(key, current);
    if (!previous) return;
    const prev0 = BigInt(previous.owed0 || 0);
    const prev1 = BigInt(previous.owed1 || 0);
    const d0 = position.owed0 - prev0;
    const d1 = position.owed1 - prev1;
    if (d0 > 0n || d1 > 0n) {
      const raw0 = d0 > 0n ? d0 : 0n;
      const raw1 = d1 > 0n ? d1 : 0n;
      const amount0 = Number(formatUnits(raw0, pool.token0.decimals));
      const amount1 = Number(formatUnits(raw1, pool.token1.decimals));
      const feeUsd = pool.state?.sqrtPriceX96
        ? this.feePairUsdAtSwap(pool, raw0, raw1, pool.state.sqrtPriceX96)
        : amount0 * this.priceOf(pool.token0.address) + amount1 * this.priceOf(pool.token1.address);
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
      this.points.markUserCoverageBroken(Date.now(), 'active-position-owed-decrease', {
        poolId: pool.id,
        positionId: position.id
      });
    }
  }

  async maybeTopUpIdleBalance(targetPools, walletBalances) {
    if (!this.config.autoTopupEnabled || this.executionPaused) return null;
    if (!this.config.dryRun && (!this.config.enableLiveWrites || !this.config.enableAutoRedeploy
      || !this.config.privateKey)) return null;
    const journal = this.state.getSetting('activeRebalanceExecution', null);
    if (journal?.phase && !['completed', 'failed'].includes(journal.phase)) return null;

    const active = targetPools.flatMap((pool) => (pool.positions || [])
      .filter((position) => BigInt(position.shares || 0) > 0n)
      .map((position) => ({ pool, position })));
    // Never guess which range should receive funds when this wallet owns several.
    if (active.length !== 1) return null;
    const { pool, position } = active[0];
    if (pool.state?.paused !== false || position.outside !== false
      || pool.state.tick < position.tickLower || pool.state.tick >= position.tickUpper) return null;
    // APR rotation happens only after an OOR withdrawal. While this LP remains
    // in range, idle pair tokens belong to its existing range.
    const target = this.getInvestmentTargetSettings();
    if (target.mode === 'specific-pool' && target.poolId !== pool.id.toLowerCase()) return null;
    if (!['apr-highest', 'specific-pool'].includes(target.mode)) return null;

    const tokenValues = [pool.token0, pool.token1].map((token) => {
      const amount = Number(walletBalances[token.address.toLowerCase()]?.amount || 0);
      const price = this.priceOf(token.address);
      return Number.isFinite(amount) && amount >= 0 && Number.isFinite(price) && price > 0
        ? amount * price : NaN;
    });
    if (!tokenValues.every((value) => Number.isFinite(value) && value >= 0)) return null;
    const idleUsd = tokenValues[0] + tokenValues[1];
    if (idleUsd < this.config.autoTopupMinIdleUsd) return null;

    const now = Date.now();
    const key = `${pool.id.toLowerCase()}:${position.id.toLowerCase()}`;
    const stored = this.state.getSetting('autoTopupAttempts', {});
    const attempts = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    const previous = attempts[key];
    if (previous && now - Number(previous.at || 0) < this.config.autoTopupMinIntervalSec * 1000) return null;
    const next = Object.fromEntries(Object.entries(attempts)
      .filter(([, entry]) => now - Number(entry?.at || 0) < 7 * 24 * 60 * 60_000));
    next[key] = { at: now, idleUsd };
    this.state.setSetting('autoTopupAttempts', next);

    try {
      const result = await this.executor.topUpPoolPosition({
        pool, position, dustBps: this.config.autoTopupDustBps,
        minGasReserveWei: this.config.topUpMinGasReserveWei
      });
      if (result?.status === 'completed') {
        this.capitalReadbackPending = true;
        this.state.setSetting('lastAction', `top-up ${pool.token0.symbol}/${pool.token1.symbol}`);
      }
      return result;
    } catch (error) {
      const message = sanitize(error.message);
      this.ledger.append('lp.topup_failed', { poolId: pool.id, positionId: position.id, idleUsd, error: message });
      if (this.state.getSetting('activeRebalanceExecution', null)?.phase === 'recovery_required') {
        this.setExecutionPaused(true, 'topup_recovery_required');
      }
      log('error', 'lp.topup_failed', { poolId: pool.id, positionId: position.id, error: message });
      return { status: 'failed', error: message };
    }
  }

  async maybeRebalance(pool, position, options = {}) {
    const source = options.source || 'automatic';
    const throwOnFailure = Boolean(options.throwOnFailure);
    const manualImmediate = options.manualImmediate === true && source === 'dashboard';
    // ABSOLUTE RULE: never auto-withdraw an LP that is currently in its original range.
    // Re-read the chain immediately before any executor path is allowed to proceed.
    if (!manualImmediate && (position.outside !== true || position.shouldRebalance !== true)) {
      this.ledger.append('rebalance.blocked', {
        positionId: position.id,
        poolId: pool.id,
        reason: 'absolute in-range hold / position not OOR-eligible'
      });
      return { status: 'blocked', reason: 'position-not-oor-eligible' };
    }
    if (!manualImmediate && !(await this.assertStillOutOfRangeBeforeRebalance(pool, position))) {
      return { status: 'blocked', reason: 'latest-chain-state-not-eligible' };
    }
    if (manualImmediate) {
      if (!options.destinationPool || options.destinationPool.id.toLowerCase() === pool.id.toLowerCase()) {
        throw new Error('立即換倉需要與來源不同的目的池');
      }
      await this.executor.assertManualRotationSource({
        pool, position, manualImmediate: true, manualSource: 'dashboard'
      }, 'manual-immediate-entry');
    }

    const topologyCooldownUntil = Number(this.state.getSetting('walletTopologyCooldownUntil', 0) || 0);
    if (!manualImmediate && Date.now() < topologyCooldownUntil) {
      this.ledger.append('rebalance.blocked', {
        positionId: position.id,
        poolId: pool.id,
        reason: 'wallet topology cooldown',
        cooldownUntil: topologyCooldownUntil
      });
      return { status: 'blocked', reason: 'wallet-topology-cooldown' };
    }
    if (this.executionPaused) {
      this.ledger.append('rebalance.blocked', { positionId: position.id, reason: 'execution paused', source });
      return { status: 'blocked', reason: 'execution-paused' };
    }

    const failureBackoff = rebalanceFailureMap(this.state)[rebalanceFailureKey(pool, position)];
    if (!manualImmediate && failureBackoff && Date.now() < Number(failureBackoff.nextRetryAt || 0)) {
      return { status: 'blocked', reason: 'rebalance-failure-backoff',
        nextRetryAt: failureBackoff.nextRetryAt, consecutiveFailures: failureBackoff.count };
    }

    const minIntervalMs = Math.max(0, Number(this.config.minRebalanceIntervalSec || 0) * 1000);
    if (!manualImmediate && minIntervalMs > 0) {
      const recentForInterval = this.state.recentRebalances(minIntervalMs);
      const latestSuccessful = recentForInterval.reduce(
        (latest, entry) => Number(entry.ts || 0) > Number(latest?.ts || 0) ? entry : latest,
        null
      );
      if (latestSuccessful && Date.now() - Number(latestSuccessful.ts) < minIntervalMs) {
        this.ledger.append('rebalance.blocked', {
          positionId: position.id,
          poolId: pool.id,
          reason: 'global minimum rebalance interval',
          source,
          previousPositionId: latestSuccessful.positionId || null,
          previousPoolId: latestSuccessful.poolId || null,
          previousRebalanceAt: latestSuccessful.ts,
          minIntervalSec: this.config.minRebalanceIntervalSec
        });
        return { status: 'blocked', reason: 'global-min-rebalance-interval' };
      }
    }

    if (!manualImmediate && this.state.recentRebalances().length >= this.config.maxRebalancesPerHour) {
      this.ledger.append('rebalance.blocked', { positionId: position.id, reason: 'hourly rate limit', source });
      return { status: 'blocked', reason: 'hourly-rate-limit' };
    }
    let destinationPool;
    const allocationEnabled = this.getInvestmentAllocationConfig?.()?.enabled === true;
    try {
      const investmentMode = this.getInvestmentTargetSettings().mode;
      if (!manualImmediate && !allocationEnabled) {
        try { await this.refreshAprForRebalance(); }
        catch (error) {
          log('warn', 'fables.stats_unavailable_for_rebalance', { error: error.message });
          if (investmentMode === 'apr-highest' && !allocationEnabled) throw error;
        }
      }
      destinationPool = allocationEnabled && !manualImmediate ? pool
        : manualImmediate ? options.destinationPool
        : investmentMode === 'apr-highest' && this.config.enableLiveWrites && !this.config.dryRun
          ? await this.resolveExecutableInvestmentTarget(pool, position)
          : this.resolveInvestmentTarget(pool);
      if (allocationEnabled && (!options.allocationFundingScope
        || options.allocationFundingScope.poolId !== pool.id.toLowerCase())) {
        throw new Error('Fresh pool-specific allocation cap is required for execution');
      }
      if (investmentMode === 'apr-highest' && destinationPool.id.toLowerCase() === pool.id.toLowerCase()) {
        this.ledger.append('rebalance.target_fallback', {
          sourcePoolId: pool.id, destinationPoolId: pool.id, positionId: position.id,
          reason: 'no higher APR pool passed the complete cross-pool sequence preflight'
        });
      }
    } catch (error) {
      const backoff = recordRebalanceFailure(this.state, this.ledger, pool, position, error.message);
      this.ledger.append('rebalance.blocked', {
        positionId: position.id,
        poolId: pool.id,
        reason: 'investment target unavailable',
        error: sanitize(error.message),
        nextRetryAt: backoff.nextRetryAt
      });
      return { status: 'blocked', reason: 'investment-target-unavailable',
        error: sanitize(error.message), nextRetryAt: backoff.nextRetryAt };
    }
    const plan = {
      pool,
      destinationPool,
      destinationStats: this.market.fablesStats?.pools?.get(destinationPool.id.toLowerCase()) || null,
      destinationStatsObservedAt: this.market.fablesStats?.aprObservedAt ?? 0,
      routingPools: this.market.pools,
      routingTokens: String(destinationPool.id).toLowerCase() === String(pool.id).toLowerCase()
        ? []
        : uniqueTargetTokens(this.market.pools, { excludeNative: true }),
      investmentTargetMode: manualImmediate ? 'specific-pool' : this.getInvestmentTargetSettings().mode,
      allocationFundingScope: allocationEnabled ? options.allocationFundingScope : null,
      allocationJobId: allocationEnabled
        ? `allocation:${Number(this.state.getSetting('investmentAllocationUpdatedAt', 0))}:${pool.id.toLowerCase()}:${position.id.toLowerCase()}`
        : null,
      manualImmediate,
      manualSource: manualImmediate ? source : null,
      manualMaxCostBps: manualImmediate ? options.manualMaxCostBps : null,
      position,
      currentTick: pool.state.tick,
      target: position.target,
      inventoryPlan: position.rebalancePlan || null,
      quote: position.rebalanceQuote || null,
      depositPlan: position.depositPlan || null
    };
    try {
      const result = await this.executor.execute(plan);

      // Dry-run is observation only. Never mutate the strategy state as though the
      // on-chain position moved, otherwise cooldown/rate-limit/OOR timers diverge
      // from the wallet's real LP.
      if (result.status === 'dry-run') {
        this.state.setSetting(
          'lastAction',
          `dry-run ${pool.token0.symbol}/${pool.token1.symbol} ${position.id.slice(0, 10)}…`
        );
        return result;
      }

      // Only a fully completed state machine may commit a rebalance to strategy state.
      if (result.status !== 'completed') {
        recordRebalanceFailure(this.state, this.ledger, pool, position,
          result.reason || result.error || `executor returned ${String(result.status || 'unknown')}`);
        this.ledger.append('rebalance.uncommitted', {
          positionId: position.id,
          poolId: pool.id,
          status: result.status,
          reason: sanitize(String(result.reason || result.error || 'executor did not report a fully completed withdraw-swap-deposit cycle'))
        });
        return result;
      }

      clearRebalanceFailure(this.state, pool, position);
      this.capitalReadbackPending = true;
      const cooldownUntil = Date.now() + this.config.minRebalanceIntervalSec * 1000;
      this.state.setPosition(positionStateKey(pool, position), {
        cooldownUntil,
        outOfRangeConfirmations: 0,
        deepOutOfRangeConfirmations: 0,
        outOfRangeSince: 0,
        lastRangeEvaluationAt: 0
      });
      this.state.recordRebalance({
        ts: Date.now(), positionId: position.id, poolId: pool.id, result: result.status,
        destinationPoolId: destinationPool.id,
        currentTick: pool.state.tick, target: position.target
      });
      this.state.setSetting(
        'lastAction',
        'completed ' + pool.token0.symbol + '/' + pool.token1.symbol
          + ' → ' + destinationPool.token0.symbol + '/' + destinationPool.token1.symbol
      );
      return result;
    } catch (error) {
      const backoff = recordRebalanceFailure(this.state, this.ledger, pool, position, error.message);
      this.ledger.append('rebalance.failed', { positionId: position.id, poolId: pool.id,
        error: sanitize(error.message), nextRetryAt: backoff.nextRetryAt });
      const activeExecution = this.state.getSetting('activeRebalanceExecution', null);
      if (activeExecution?.phase === 'recovery_required') {
        this.setExecutionPaused(true, 'rebalance_recovery_required');
        this.ledger.append('rebalance.auto_paused', {
          positionId: position.id,
          poolId: pool.id,
          executionId: activeExecution.id || null,
          reason: 'capital moved but execution did not complete'
        });
      }
      log('error', 'rebalance.failed', { positionId: position.id, error: error.message, source });
      if (throwOnFailure) throw error;
      return { status: 'failed', error: sanitize(error.message), nextRetryAt: backoff.nextRetryAt };
    }
  }

  async assertStillOutOfRangeBeforeRebalance(pool, position) {
    const latestState = await this.fables.readPoolState(pool);
    const outside = isLpOutOfRange(latestState.tick, position.tickLower, position.tickUpper);
    pool.state = latestState;

    if (latestState.paused !== false) {
      this.ledger.append('rebalance.blocked', {
        positionId: position.id,
        poolId: pool.id,
        reason: 'fables pool paused',
        latestTick: latestState.tick
      });
      log('warn', 'rebalance.pool_paused', {
        pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
        positionId: position.id,
        latestTick: latestState.tick
      });
      return false;
    }

    if (outside) return true;

    const stateKey = positionStateKey(pool, position);
    this.state.setPosition(stateKey, {
      outOfRangeConfirmations: 0,
      deepOutOfRangeConfirmations: 0,
      outOfRangeSince: 0,
      lastRangeEvaluationAt: Date.now(),
      lastTick: latestState.tick
    });
    this.ledger.append('rebalance.blocked', {
      positionId: position.id,
      poolId: pool.id,
      reason: 'absolute in-range hold',
      latestTick: latestState.tick,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper
    });
    log('info', 'rebalance.in_range_hold', {
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      positionId: position.id,
      latestTick: latestState.tick,
      range: [position.tickLower, position.tickUpper]
    });
    return false;
  }

  async scanGlobalPointFees(pools, latestBlock) {
    const state = this.state;
    const points = this.points;
    const fables = this.fables;
    const ledger = this.ledger;
    const config = { ...this.config };
    const retryAt = Number(state.getSetting('pointsGlobalScanRetryAt', 0) || 0);
    if (Date.now() < retryAt) return;
    // Backfill a bounded block window per market refresh. A new wallet can be
    // hundreds of thousands of blocks behind; blocking startup on that entire
    // history would leave the trading readiness scan unavailable for minutes.
    const maxBlocksPerScan = 10_000;
    const desiredStartMs = points.predictionStartMs(Date.now());
    const previousStartMs = Number(state.getSetting('pointsGlobalSwapScanStartMs', 0) || 0);
    if (previousStartMs && desiredStartMs < previousStartMs) {
      // A user moved the official baseline backwards. Re-open the cursor so the
      // missing earlier campaign interval is backfilled; appendUnique keeps
      // already-known swaps idempotent.
      state.setCursor('pointsGlobalSwapsV2', 0);
    }
    state.setSetting('pointsGlobalSwapScanStartMs', desiredStartMs);

    const startBlock = await this.blockAtOrAfterTimestamp(desiredStartMs, latestBlock, state);
    const storedCursor = state.getCursor('pointsGlobalSwapsV2', 0);
    const fromBlock = storedCursor > 0
      ? Math.max(startBlock, storedCursor - config.reorgLookbackBlocks)
      : startBlock;
    if (fromBlock > latestBlock) return;
    const scannedThroughBlock = Math.min(latestBlock, fromBlock + maxBlocksPerScan - 1);
    state.setSetting('pointsGlobalScanProgress', {
      fromBlock, scannedThroughBlock, latestBlock, complete: false, inProgress: true, at: Date.now()
    });

    let swaps;
    try {
      swaps = await fables.scanGlobalSwaps(pools, fromBlock, scannedThroughBlock);
    } catch (error) {
      const rateLimited = isRpcRateLimitError(error);
      log('warn', 'points.global_swap_scan_failed', {
        fromBlock,
        scannedThroughBlock,
        error: rateLimited ? 'rpc-rate-limited' : error.message
      });
      if (rateLimited || isRpcTimeoutError(error)) {
        state.setSetting('pointsGlobalScanRetryAt', Date.now()
          + (rateLimited ? RPC_RATE_LIMIT_BACKOFF_MS : RPC_TIMEOUT_BACKOFF_MS));
      }
      state.setSetting('pointsGlobalScanProgress', {
        fromBlock, scannedThroughBlock, latestBlock, complete: false, inProgress: false,
        error: rateLimited ? 'rpc-rate-limited' : error.message, at: Date.now()
      });
      return;
    }

    let swapTimes;
    try {
      swapTimes = await this.campaignSwapTimestamps(swaps, latestBlock, state);
    } catch (error) {
      const rateLimited = isRpcRateLimitError(error);
      if (rateLimited || isRpcTimeoutError(error)) {
        state.setSetting('pointsGlobalScanRetryAt', Date.now()
          + (rateLimited ? RPC_RATE_LIMIT_BACKOFF_MS : RPC_TIMEOUT_BACKOFF_MS));
      }
      state.setSetting('pointsGlobalScanProgress', {
        fromBlock, scannedThroughBlock, latestBlock, complete: false, inProgress: false,
        error: rateLimited ? 'rpc-rate-limited' : error.message, at: Date.now()
      });
      throw error;
    }
    let priced = 0;
    let unpriced = 0;
    for (let index = 0; index < swaps.length; index += 1) {
      const swap = swaps[index];
      const valuation = valueSwapFeeInUsd({
        pool: swap.pool,
        swap,
        usdgAddress: config.usdgAddress
      });
      const ts = swapTimes[index];
      if (valuation.priced) priced += 1;
      else unpriced += 1;
      ledger.appendUnique(
        `points-swap:${swap.transactionHash}:${swap.index}`,
        'points.global_swap_fee',
        {
          poolId: swap.poolId,
          pair: `${swap.pool.token0.symbol}/${swap.pool.token1.symbol}`,
          hash: swap.transactionHash,
          blockNumber: swap.blockNumber,
          logIndex: swap.index,
          feePips: swap.fee,
          amount0Raw: swap.amount0.toString(),
          amount1Raw: swap.amount1.toString(),
          sqrtPriceX96: swap.sqrtPriceX96.toString(),
          tick: swap.tick,
          priced: valuation.priced,
          valuation: valuation.valuation || null,
          reason: valuation.reason || null,
          inputToken: valuation.inputToken,
          inputAmount: valuation.inputAmount,
          feeAmount: valuation.feeAmount,
          feeUsd: valuation.feeUsd,
          timestampEstimated: swap.blockNumber !== swaps[0].blockNumber
            && swap.blockNumber !== swaps.at(-1).blockNumber
        },
        ts
      );
    }
    state.setCursor('pointsGlobalSwapsV2', scannedThroughBlock + 1);
    const complete = scannedThroughBlock >= latestBlock;
    state.setSetting('pointsGlobalScanProgress', {
      fromBlock, scannedThroughBlock, latestBlock, complete, inProgress: false, at: Date.now()
    });
    state.setSetting('pointsLastGlobalScan', {
      at: Date.now(),
      fromBlock,
      latestBlock,
      scannedThroughBlock,
      complete,
      swaps: swaps.length,
      priced,
      unpriced,
      desiredStartAt: new Date(desiredStartMs).toISOString()
    });
    if (swaps.length || unpriced) {
      log('info', 'points.global_scan', { fromBlock, scannedThroughBlock, latestBlock, complete, swaps: swaps.length, priced, unpriced });
    }
  }

  async campaignSwapTimestamps(swaps, latestBlock, state = this.state) {
    if (!swaps.length) return [];
    const firstBlock = swaps[0].blockNumber;
    const lastBlock = swaps.at(-1).blockNumber;
    const firstTime = await this.blockTimestamp(firstBlock);
    const lastTime = lastBlock === firstBlock ? firstTime : await this.blockTimestamp(lastBlock);
    let dayStart = pointsCampaignDayStartMs(firstTime);
    if (dayStart == null) return swaps.map(() => firstTime);
    const boundaries = [];
    for (let boundary = dayStart + POINTS_DAY_MS; boundary <= lastTime; boundary += POINTS_DAY_MS) {
      boundaries.push({
        block: await this.blockAtOrAfterTimestamp(boundary, latestBlock, state),
        dayStart: boundary
      });
    }
    let boundaryIndex = 0;
    return swaps.map((swap) => {
      while (boundaryIndex < boundaries.length && swap.blockNumber >= boundaries[boundaryIndex].block) {
        dayStart = boundaries[boundaryIndex].dayStart;
        boundaryIndex += 1;
      }
      const fraction = lastBlock === firstBlock ? 0
        : (swap.blockNumber - firstBlock) / (lastBlock - firstBlock);
      const estimate = Math.round(firstTime + fraction * (lastTime - firstTime));
      return Math.max(dayStart, Math.min(dayStart + POINTS_DAY_MS - 1, estimate));
    });
  }

  async blockAtOrAfterTimestamp(timestampMs, latestBlock, state = this.state) {
    const cacheKey = `pointsBlockAtOrAfter:${timestampMs}`;
    const cached = Number(state.getSetting(cacheKey, 0) || 0);
    if (cached > 0 && cached <= latestBlock) return cached;

    let low = 0;
    let high = latestBlock;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const block = await this.providers.readProvider.getBlock(mid);
      if (!block) {
        low = mid + 1;
        continue;
      }
      if (Number(block.timestamp) * 1000 < timestampMs) low = mid + 1;
      else high = mid;
    }
    state.setSetting(cacheKey, low);
    return low;
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
        if (isRpcRateLimitError(error) || isRpcTimeoutError(error)) throw error;
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
    const unresolvedKeys = new Set(this.ledger.all()
      .filter((event) => event.type === 'points.withdraw_fee_unresolved')
      .map((event) => `${event.hash}:${event.logIndex}`));
    for (const entry of logs) {
      const kind = lifecycleEventType(entry);
      if (!kind) continue;
      const rangeId = entry.topics?.[2]?.toLowerCase();
      const logIndex = Number(entry.index ?? 0);
      const eventKey = `lifecycle:${entry.transactionHash}:${logIndex}`;
      const feeKey = `points-withdraw-fee:${entry.transactionHash}:${logIndex}`;
      const needsLifecycle = !this.ledger.seenKeys.has(eventKey);
      const needsWithdrawalFee = kind === 'withdraw'
        && !this.ledger.seenKeys.has(feeKey)
        && !unresolvedKeys.has(`${entry.transactionHash}:${logIndex}`);
      if (!needsLifecycle && !needsWithdrawalFee) continue;

      const ts = await this.blockTimestamp(entry.blockNumber);
      let gasEth = 0;
      let gasUsd = 0;
      let txFrom = null;
      let receipt = null;
      let tx = null;
      try {
        [receipt, tx] = await Promise.all([
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

      if (needsLifecycle) {
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

      if (needsWithdrawalFee) {
        const result = this.reconcileWithdrawalUserFees(pool, rangeId, entry, receipt, tx, ts);
        const feeEventData = {
          poolId: pool.id,
          pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
          positionId: rangeId,
          hash: entry.transactionHash,
          blockNumber: Number(entry.blockNumber),
          logIndex,
          ...result
        };
        if (result.ok) {
          this.ledger.appendUnique(feeKey, 'points.withdraw_fee_reconciled', feeEventData, ts);
        } else {
          unresolvedKeys.add(`${entry.transactionHash}:${logIndex}`);
          this.ledger.appendUnique(
            `points-withdraw-fee-unresolved:${entry.transactionHash}:${logIndex}:${result.reason || 'unknown'}`,
            'points.withdraw_fee_unresolved',
            feeEventData,
            ts
          );
          if (ts >= this.points.predictionStartMs(Date.now())) {
            this.points.markUserCoverageBroken(ts, 'withdraw-fee-unresolved', {
              poolId: pool.id,
              positionId: rangeId,
              hash: entry.transactionHash,
              detail: result.reason || 'unknown'
            });
          }
        }
      }
    }
  }

  reconcileWithdrawalUserFees(pool, rangeId, entry, receipt, tx, ts, options = {}) {
    if (!rangeId || !receipt || !tx) return { ok: false, reason: 'missing-withdrawal-receipt-or-transaction' };
    const decoded = this.decodeWithdrawalCall(pool, tx);
    if (!decoded.ok) return decoded;

    const preSwap = this.lastPointSwapBefore(pool.id, Number(entry.blockNumber), Number(entry.index ?? 0));
    if (!preSwap?.sqrtPriceX96) return { ok: false, reason: 'missing-pre-withdraw-swap-state' };

    let principal;
    try {
      principal = buildExactWithdrawBounds({
        sqrtPriceX96: BigInt(preSwap.sqrtPriceX96),
        tickLower: Number(decoded.args[1]),
        tickUpper: Number(decoded.args[2]),
        liquidity: BigInt(decoded.args[3]),
        slippageBps: 0
      });
    } catch (error) {
      return { ok: false, reason: `principal-reconstruction-failed:${error.message}` };
    }

    const actual = this.receiptWalletDeltasForPool(receipt, pool);
    if (!actual) return { ok: false, reason: 'unsupported-native-token-withdrawal' };
    const claimed0 = actual.raw0 > principal.expected0 ? actual.raw0 - principal.expected0 : 0n;
    const claimed1 = actual.raw1 > principal.expected1 ? actual.raw1 - principal.expected1 : 0n;

    const feeStateKey = `feeState:${pool.id.toLowerCase()}:${rangeId.toLowerCase()}`;
    const previous = options.previousOwed || this.state.getSetting(feeStateKey, null);
    if (!previous) return { ok: false, reason: 'missing-pre-withdraw-user-fee-state' };

    const previousOwed0 = BigInt(previous.owed0 || 0);
    const previousOwed1 = BigInt(previous.owed1 || 0);
    const tolerance = 2n;
    if (claimed0 + tolerance < previousOwed0 || claimed1 + tolerance < previousOwed1) {
      return {
        ok: false,
        reason: 'reconstructed-claim-below-last-observed-owed',
        claimed0: claimed0.toString(),
        claimed1: claimed1.toString(),
        previousOwed0: previousOwed0.toString(),
        previousOwed1: previousOwed1.toString()
      };
    }

    const unseen0 = claimed0 > previousOwed0 ? claimed0 - previousOwed0 : 0n;
    const unseen1 = claimed1 > previousOwed1 ? claimed1 - previousOwed1 : 0n;
    const feeUsd = this.feePairUsdAtSwap(pool, unseen0, unseen1, BigInt(preSwap.sqrtPriceX96));

    if (unseen0 > 0n || unseen1 > 0n) {
      this.ledger.appendUnique(
        `points-user-fee-adjust:${entry.transactionHash}:${Number(entry.index ?? 0)}`,
        'points.user_fee_adjustment',
        {
          poolId: pool.id,
          pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
          positionId: rangeId,
          hash: entry.transactionHash,
          blockNumber: Number(entry.blockNumber),
          amount0: Number(formatUnits(unseen0, pool.token0.decimals)),
          amount1: Number(formatUnits(unseen1, pool.token1.decimals)),
          symbol0: pool.token0.symbol,
          symbol1: pool.token1.symbol,
          feeUsd,
          reason: 'withdrawAndClaim receipt minus exact principal minus last observed owed'
        },
        ts
      );
    }

    if (!options.historical) {
      this.state.setSetting(feeStateKey, {
        owed0: '0', owed1: '0', shares: '0', at: ts
      });
    }

    return {
      ok: true,
      preSwapBlock: preSwap.blockNumber,
      principal0: principal.expected0.toString(),
      principal1: principal.expected1.toString(),
      claimed0: claimed0.toString(),
      claimed1: claimed1.toString(),
      previousOwed0: previousOwed0.toString(),
      previousOwed1: previousOwed1.toString(),
      unseen0: unseen0.toString(),
      unseen1: unseen1.toString(),
      feeUsd
    };
  }

  async backfillGuardedWithdrawFees() {
    const startMs = this.points.predictionStartMs(Date.now());
    const rows = this.ledger.all();
    const pending = rows.filter((event) => event.type === 'points.withdraw_fee_unresolved'
      && event.ts >= startMs
      && String(event.reason || '').startsWith('unsupported-withdrawal-call:')
      && !this.ledger.seenKeys.has(`points-withdraw-fee:${event.hash}:${event.logIndex}`))
      .sort((a, b) => a.ts - b.ts);
    for (const event of pending) {
      const noteBlocked = (reason) => this.ledger.appendUnique(
        `points-withdraw-backfill-blocked:${event.hash}:${event.logIndex}:${String(reason).split(':')[0]}`,
        'points.withdraw_fee_backfill_blocked', {
          poolId: event.poolId, positionId: event.positionId, hash: event.hash,
          logIndex: event.logIndex, reason: sanitize(reason)
        }, event.ts);
      const pool = this.market.pools.find((item) => item.id.toLowerCase() === String(event.poolId).toLowerCase());
      if (!pool) { noteBlocked('pool-not-in-current-registry'); continue; }
      const decreases = rows.filter((item) => item.type === 'fee.owed_decrease'
        && item.poolId?.toLowerCase() === String(event.poolId).toLowerCase()
        && item.positionId?.toLowerCase() === String(event.positionId).toLowerCase()
        && item.ts >= event.ts && item.ts <= event.ts + 15 * 60_000);
      const saved = this.state.getSetting(
        `feeState:${String(event.poolId).toLowerCase()}:${String(event.positionId).toLowerCase()}`, null);
      const snapshotIsPreWithdrawal = saved && Number(saved.at) <= event.ts
        && event.ts - Number(saved.at) <= 5 * 60_000
        && BigInt(saved.shares || 0) > 0n;
      const previousOwed = decreases.length === 1
        ? { owed0: decreases[0].previousOwed0, owed1: decreases[0].previousOwed1 }
        : decreases.length === 0 && snapshotIsPreWithdrawal
          ? { owed0: saved.owed0, owed1: saved.owed1 }
          : null;
      if (!previousOwed) { noteBlocked(`matched-owed-decreases:${decreases.length};snapshot:${snapshotIsPreWithdrawal ? 'eligible' : 'unavailable'}`); continue; }
      if (previousOwed.owed0 == null || previousOwed.owed1 == null) {
        noteBlocked('missing-historical-owed-amounts'); continue;
      }
      try {
        const [receipt, tx] = await Promise.all([
          this.providers.readProvider.getTransactionReceipt(event.hash),
          this.providers.readProvider.getTransaction(event.hash)
        ]);
        const result = this.reconcileWithdrawalUserFees(pool, event.positionId, {
          blockNumber: event.blockNumber, index: event.logIndex, transactionHash: event.hash
        }, receipt, tx, event.ts, {
          previousOwed,
          historical: true
        });
        if (!result.ok) { noteBlocked(result.reason || 'reconciliation-failed'); continue; }
        this.ledger.appendUnique(`points-withdraw-fee:${event.hash}:${event.logIndex}`,
          'points.withdraw_fee_reconciled', {
            poolId: event.poolId, pair: event.pair, positionId: event.positionId,
            hash: event.hash, blockNumber: event.blockNumber, logIndex: event.logIndex,
            historical: true, ...result
          }, event.ts);
      } catch (error) {
        log('warn', 'points.withdraw_fee_backfill_failed', {
          poolId: event.poolId, positionId: event.positionId,
          reason: sanitize(error.message)
        });
      }
    }
    const broken = this.state.getSetting('pointsUserCoverageBrokenV2', null);
    if (!broken || Number(broken.at) < startMs) return;
    const all = this.ledger.all();
    const unresolved = all.some((event) => event.type === 'points.withdraw_fee_unresolved'
      && event.ts >= startMs
      && !this.ledger.seenKeys.has(`points-withdraw-fee:${event.hash}:${event.logIndex}`));
    const unmatchedDecrease = all.some((event) => event.type === 'fee.owed_decrease'
      && event.ts >= startMs
      && !all.some((candidate) => candidate.type === 'points.withdraw_fee_reconciled'
        && candidate.poolId?.toLowerCase() === event.poolId?.toLowerCase()
        && candidate.positionId?.toLowerCase() === event.positionId?.toLowerCase()
        && candidate.ts <= event.ts && event.ts <= candidate.ts + 15 * 60_000));
    if (!unresolved && !unmatchedDecrease
      && ['withdraw-fee-unresolved', 'active-position-owed-decrease'].includes(broken.reason)) {
      this.state.setSetting('pointsUserCoverageBrokenV2', null);
      this.points.invalidate();
      this.ledger.append('points.user_coverage_restored', { from: startMs, through: Date.now() });
    }
  }

  decodeWithdrawalCall(pool, tx) {
    const target = String(tx?.to || '').toLowerCase();
    const wallet = this.config.walletAddress.toLowerCase();
    const hook = pool.key.hooks.toLowerCase();
    const call = { data: tx?.data, value: tx?.value || 0n };
    let decoded = null;
    try {
      if (target === hook) decoded = hookInterface.parseTransaction(call);
      else if (target === wallet) decoded = guardInterface.parseTransaction(call);
    } catch { return { ok: false, reason: 'withdrawal-calldata-decode-failed' }; }
    const allowed = target === hook ? 'withdrawAndClaim' : target === wallet ? 'guardedWithdrawAndClaim' : null;
    if (!decoded || decoded.name !== allowed) {
      return { ok: false, reason: `unsupported-withdrawal-call:${decoded?.name || 'unknown'}` };
    }
    const key = decoded.args[0];
    if (String(key.currency0).toLowerCase() !== pool.key.currency0.toLowerCase()
      || String(key.currency1).toLowerCase() !== pool.key.currency1.toLowerCase()
      || Number(key.fee) !== Number(pool.key.fee)
      || Number(key.tickSpacing) !== Number(pool.key.tickSpacing)
      || String(key.hooks).toLowerCase() !== hook
      || String(decoded.args[4]).toLowerCase() !== wallet) {
      return { ok: false, reason: 'withdrawal-pool-key-or-recipient-mismatch' };
    }
    return { ok: true, args: decoded.args, guarded: target === wallet };
  }

  lastPointSwapBefore(poolId, blockNumber, logIndex) {
    const rows = this.ledger.all();
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const event = rows[i];
      if (event.type !== 'points.global_swap_fee') continue;
      if (String(event.poolId).toLowerCase() !== String(poolId).toLowerCase()) continue;
      const eventBlock = Number(event.blockNumber || 0);
      const eventIndex = Number(event.logIndex || 0);
      if (eventBlock < blockNumber || (eventBlock === blockNumber && eventIndex < logIndex)) return event;
    }
    return null;
  }

  receiptWalletDeltasForPool(receipt, pool) {
    if (
      pool.token0.address.toLowerCase() === ZERO_ADDRESS
      || pool.token1.address.toLowerCase() === ZERO_ADDRESS
    ) return null;
    const wallet = this.config.walletAddress.toLowerCase();
    const totals = new Map([
      [pool.token0.address.toLowerCase(), 0n],
      [pool.token1.address.toLowerCase(), 0n]
    ]);
    for (const item of receipt.logs || []) {
      if (String(item.topics?.[0] || '').toLowerCase() !== transferTopic) continue;
      const token = String(item.address || '').toLowerCase();
      if (!totals.has(token)) continue;
      const from = topicAddress(item.topics?.[1]);
      const to = topicAddress(item.topics?.[2]);
      const amount = BigInt(item.data || 0);
      let delta = totals.get(token) || 0n;
      if (from === wallet) delta -= amount;
      if (to === wallet) delta += amount;
      totals.set(token, delta);
    }
    const raw0 = totals.get(pool.token0.address.toLowerCase()) || 0n;
    const raw1 = totals.get(pool.token1.address.toLowerCase()) || 0n;
    return {
      raw0: raw0 > 0n ? raw0 : 0n,
      raw1: raw1 > 0n ? raw1 : 0n
    };
  }

  feePairUsdAtSwap(pool, raw0, raw1, sqrtPriceX96) {
    const amount0 = Number(formatUnits(raw0, pool.token0.decimals));
    const amount1 = Number(formatUnits(raw1, pool.token1.decimals));
    const usdg = this.config.usdgAddress.toLowerCase();
    const k0 = pool.token0.address.toLowerCase();
    const k1 = pool.token1.address.toLowerCase();
    if (k0 === usdg) {
      const spot = spotToken1PerToken0(sqrtPriceX96, pool.token0.decimals, pool.token1.decimals);
      return amount0 + (spot > 0 ? amount1 / spot : 0);
    }
    if (k1 === usdg) {
      const spot = spotToken1PerToken0(sqrtPriceX96, pool.token0.decimals, pool.token1.decimals);
      return amount1 + amount0 * spot;
    }
    return amount0 * this.priceOf(pool.token0.address) + amount1 * this.priceOf(pool.token1.address);
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
    this.walletImportState = this.config.walletAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()
      ? { status: 'failed', address: this.config.walletAddress, error: '尚未設定有效的監控錢包地址' }
      : { status: 'scanning', address: this.config.walletAddress, error: null };
    this.schedulePointsSimulation();
    while (this.running) {
      const started = Date.now();
      this.nextMonitorAt = null;
      try {
        await this.runOnce();
        this.rpcTimeoutStreak = 0;
        if (this.resumeExecutionAfterStartup) {
          const restored = await this.startExecution('startup-restore');
          if (restored.ok) this.resumeExecutionAfterStartup = false;
          else log('warn', 'execution.startup_restore_waiting', { blockers: restored.blockers });
        }
      }
      catch (error) {
        const rateLimited = isRpcRateLimitError(error);
        const timedOut = isRpcTimeoutError(error);
        this.rpcTimeoutStreak = timedOut ? (this.rpcTimeoutStreak || 0) + 1 : 0;
        if (this.walletImportState.status === 'scanning') {
          this.walletImportState = { status: 'failed', address: this.config.walletAddress, error: 'Initial scan failed; check RPC health and logs' };
        }
        this.ledger.append('cycle.failed', { error: rateLimited ? 'rpc-rate-limited' : error.message });
        log('error', 'cycle.failed', { error: rateLimited ? 'rpc-rate-limited' : error.stack || error.message });
        let backoffMs = 0;
        if (rateLimited) backoffMs = RPC_RATE_LIMIT_BACKOFF_MS;
        else if (this.rpcTimeoutStreak >= 3) backoffMs = Math.min(
          RPC_RATE_LIMIT_BACKOFF_MS,
          RPC_TIMEOUT_BACKOFF_MS * (this.rpcTimeoutStreak - 2)
        );
        if (backoffMs) {
          this.nextMonitorAt = Date.now() + backoffMs;
          await sleep(backoffMs);
        }
      }
      const wait = Math.max(1000, this.config.pollIntervalMs - (Date.now() - started));
      this.nextMonitorAt = Date.now() + wait;
      await sleep(wait);
    }
    this.nextMonitorAt = null;
  }

  stop() {
    this.running = false;
    if (this.pointsSimulationTimer) clearTimeout(this.pointsSimulationTimer);
    this.pointsSimulationTimer = null;
  }

  async waitForCycleIdle() {
    while (this.cycleActive) await sleep(250);
  }
}

function maskRpcEndpointLabel(endpoint) {
  try {
    const parsed = new URL(endpoint);
    const labels = parsed.hostname.split('.');
    const host = labels.length > 2 ? `••••.${labels.slice(-2).join('.')}` : `••••.${labels.at(-1) || 'rpc'}`;
    return `${parsed.protocol}//${host}${parsed.pathname !== '/' ? '/••••' : ''}`;
  } catch {
    return 'RPC endpoint';
  }
}

function uniqueTargetTokens(pools, { excludeNative = false } = {}) {
  const map = new Map();
  for (const pool of pools) {
    for (const token of [pool.token0, pool.token1]) {
      const address = token.address.toLowerCase();
      if (excludeNative && address === ZERO_ADDRESS.toLowerCase()) continue;
      map.set(address, token);
    }
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
      outside: p.outside, nearEdge: Boolean(p.nearEdge), excursionPct: p.excursionPct,
      outOfRangeSince: p.outOfRangeSince,
      outOfRangeElapsedMin: p.outOfRangeElapsedMin, evaluationDue: p.evaluationDue,
      lastRangeEvaluationAt: p.lastRangeEvaluationAt, nextRangeEvaluationAt: p.nextRangeEvaluationAt,
      shouldRebalance: p.shouldRebalance, rebalanceReason: p.rebalanceReason,
      executionBlockedReason: p.executionBlockedReason || null, target: p.target,
      rebalancePlan: p.rebalancePlan || null, rebalanceQuote: p.rebalanceQuote || null,
      depositPlan: p.depositPlan || null
    }))
  };
}
function snapshotMarket(pool, stats, watched, fablesStats) {
  const fresh = Date.now() - Number(fablesStats?.observedAt || 0) <= 5 * 60_000;
  const freshApr = Date.now() - Number(fablesStats?.aprObservedAt || 0) <= 5 * 60_000;
  const currentStats = fresh ? stats : null;
  return {
    id: pool.id,
    pair: pool.token0.symbol + '/' + pool.token1.symbol,
    token0: pool.token0.symbol,
    token1: pool.token1.symbol,
    tick: pool.state?.tick ?? null,
    paused: pool.state?.paused ?? null,
    watched,
    tvlUsd: currentStats?.tvlUsd ?? null,
    volume24hUsd: currentStats?.volume24hUsd ?? null,
    fees24hUsd: currentStats?.fees24hUsd ?? null,
    aprPct: freshApr ? (currentStats?.aprPct ?? null) : null,
    statsObservedAt: fablesStats?.aprObservedAt ?? null,
    statsSource: fablesStats?.source ?? null
  };
}
function positionStateKey(pool, position) {
  return `${pool.id.toLowerCase()}:${position.id.toLowerCase()}`;
}
function sameStringArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function rangePolicySnapshot(config) {
  return {
    rangePreset: config.rangePreset,
    evaluationIntervalMs: config.rangeCheckIntervalMs,
    confirmDelayMin: config.oorConfirmDelayMin,
    monitorPollIntervalMs: config.pollIntervalMs
  };
}

function topicAddress(value) {
  const raw = String(value || '').toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(raw) ? `0x${raw.slice(-40)}` : null;
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
