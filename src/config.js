import { getAddress, parseEther } from 'ethers';
import { CHAIN_ID, DEFAULT_RPC_URL, FABLES_REGISTRY, USDG } from './constants.js';
import { envBool, envInt, envList, envNum } from './env.js';

export const RUNTIME_INTERVAL_LIMITS = Object.freeze({
  marketRefreshMs: { min: 15_000, max: 60 * 60 * 1000, label: '池資料更新間隔', minLabel: '15 秒', maxLabel: '60 分鐘' },
  rangeCheckIntervalMs: { min: 30_000, max: 24 * 60 * 60 * 1000, label: '區間檢查間隔', minLabel: '30 秒', maxLabel: '24 小時' },
  pointsSimulationIntervalMs: { min: 5_000, max: 60 * 60 * 1000, label: '分數模擬間隔', minLabel: '5 秒', maxLabel: '60 分鐘' }
});

export function normalizeRuntimeIntervals(values) {
  return Object.fromEntries(Object.entries(RUNTIME_INTERVAL_LIMITS).map(([key, bounds]) => {
    const value = Number(values?.[key]);
    if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
      throw new Error(`${bounds.label}須介於${bounds.minLabel}至${bounds.maxLabel}。`);
    }
    return [key, value];
  }));
}

export function loadConfig() {
  const walletAddress = requiredAddress('WALLET_ADDRESS');
  const privateKey = process.env.PRIVATE_KEY?.trim() || '';
  const dryRun = envBool('DRY_RUN', true);
  const enableLiveWrites = envBool('ENABLE_LIVE_WRITES', false);
  const enableAutoRedeploy = envBool('ENABLE_AUTO_REDEPLOY', false);
  const rpcUrls = envList('RPC_URLS', [DEFAULT_RPC_URL]);
  const rpcRequestTimeoutMs = envInt('RPC_REQUEST_TIMEOUT_MS', 30_000);
  const pointsGlobalSwapScanEnabled = envBool('POINTS_GLOBAL_SWAP_SCAN_ENABLED', true);
  const targetMode = (process.env.TARGET_MODE?.trim() || 'wallet-active').toLowerCase();
  const logFromBlock = envInt('LOG_FROM_BLOCK', 44_000_000);
  const oorConfirmDelayMin = envInt('OOR_CONFIRM_DELAY_MIN', 15);
  const targetSymbols = envList('TARGET_SYMBOLS', []).map((x) => x.toUpperCase());
  const targetPoolIds = envList('TARGET_POOL_IDS', []).map((x) => x.toLowerCase());
  const rangePreset = (process.env.RANGE_PRESET?.trim() || 'custom-bps').toLowerCase();
  const runtimeIntervals = normalizeRuntimeIntervals({
    marketRefreshMs: envInt('MARKET_REFRESH_MS', 5 * 60_000),
    rangeCheckIntervalMs: envInt('RANGE_CHECK_INTERVAL_MS', 5 * 60 * 1000),
    pointsSimulationIntervalMs: envInt('POINTS_SIMULATION_INTERVAL_MS', 15_000)
  });
  const { marketRefreshMs, rangeCheckIntervalMs, pointsSimulationIntervalMs } = runtimeIntervals;
  const marketStateRefreshMs = envInt('MARKET_STATE_REFRESH_MS', Math.max(marketRefreshMs, 5 * 60_000));
  const pollIntervalMs = envInt('POLL_INTERVAL_MS', 5 * 60_000);
  const aprPoolMinTvlUsd = envNum('APR_POOL_MIN_TVL_USD', 30_000);
  const swapSlippageBps = envInt('SWAP_SLIPPAGE_BPS', 50);
  const maxSwapPriceImpactBps = envInt('MAX_SWAP_PRICE_IMPACT_BPS', 200);
  const crossPoolMaxSwapPriceImpactBps = envInt('CROSS_POOL_MAX_SWAP_PRICE_IMPACT_BPS', 350);
  const oorRebalanceSwapPoolId = process.env.OOR_REBALANCE_SWAP_POOL_ID?.trim().toLowerCase() || '';
  const oorRebalanceMaxSwapPriceImpactBps = envInt('OOR_REBALANCE_MAX_SWAP_PRICE_IMPACT_BPS', maxSwapPriceImpactBps);
  const autoTopupMaxSwapPriceImpactBps = envInt('AUTO_TOPUP_MAX_SWAP_PRICE_IMPACT_BPS', maxSwapPriceImpactBps);
  const autoTopupSwapPoolId = process.env.AUTO_TOPUP_SWAP_POOL_ID?.trim().toLowerCase() || '';
  const autoTopupSwapEnabled = envBool('AUTO_TOPUP_SWAP_ENABLED', false);
  const depositSlippageBps = envInt('DEPOSIT_SLIPPAGE_BPS', 50);
  const withdrawSlippageBps = envInt('WITHDRAW_SLIPPAGE_BPS', 50);
  const eip7702GuardAddress = optionalAddress('EIP7702_GUARD_ADDRESS');
  const atomicDepositFeatureEnabled = envBool('ATOMIC_DEPOSIT_ENABLED', false);
  const atomicDepositWallets = envList('ATOMIC_DEPOSIT_WALLETS', [walletAddress]).map(getAddress);
  const legacyEip7702GuardAddress = optionalAddress('LEGACY_EIP7702_GUARD_ADDRESS');
  const atomicDepositEnabled = atomicDepositFeatureEnabled
    && atomicDepositWallets.some(address => address.toLowerCase() === walletAddress.toLowerCase());
  const officialRepositionFeatureEnabled = envBool('OFFICIAL_REPOSITION_ENABLED', false);
  const officialRepositionWallets = envList('OFFICIAL_REPOSITION_WALLETS', [walletAddress]).map(getAddress);
  const officialEip7702GuardAddress = optionalAddress('OFFICIAL_EIP7702_GUARD_ADDRESS');
  const officialRepositionEnabled = officialRepositionFeatureEnabled
    && officialRepositionWallets.some(address => address.toLowerCase() === walletAddress.toLowerCase());
  const eip7702GuardVerifiedFor = optionalAddress('EIP7702_GUARD_VERIFIED_FOR');
  const eip7702GuardVerificationEnabled = envBool('EIP7702_GUARD_VERIFIED', false);
  const eip7702GuardVerified = eip7702GuardVerificationEnabled
    && Boolean(eip7702GuardVerifiedFor)
    && eip7702GuardVerifiedFor.toLowerCase() === walletAddress.toLowerCase();
  const autoTopupMinIdleUsd = envNum('AUTO_TOPUP_MIN_IDLE_USD', 25);
  const autoTopupDustBps = envInt('AUTO_TOPUP_DUST_BPS', 25);
  const autoTopupMinIntervalSec = envInt('AUTO_TOPUP_MIN_INTERVAL_SEC', 1800);
  const topUpMinGasReserveWei = parseEther(process.env.AUTO_TOPUP_MIN_GAS_ETH?.trim() || '0.0002');
  const depositTickTolerance = envInt('DEPOSIT_TICK_TOLERANCE', -1);
  if (!Number.isInteger(depositTickTolerance) || depositTickTolerance < -1 || depositTickTolerance > 2000) {
    throw new Error('DEPOSIT_TICK_TOLERANCE must be -1 or 0..2000');
  }

  if (!rpcUrls.length) throw new Error('RPC_URLS must contain at least one endpoint');
  if (!Number.isSafeInteger(rpcRequestTimeoutMs) || rpcRequestTimeoutMs < 1_000 || rpcRequestTimeoutMs > 300_000) {
    throw new Error('RPC_REQUEST_TIMEOUT_MS must be between 1000 and 300000');
  }
  if (!['wallet-active', 'allowlist', 'symbols'].includes(targetMode)) {
    throw new Error('TARGET_MODE must be wallet-active, allowlist, or symbols');
  }
  if (targetMode === 'allowlist' && !targetPoolIds.length) {
    throw new Error('TARGET_MODE=allowlist requires at least one TARGET_POOL_IDS entry; refusing fail-open all-pool selection');
  }
  if (targetMode === 'symbols' && !targetSymbols.length) {
    throw new Error('TARGET_MODE=symbols requires TARGET_SYMBOLS; refusing fail-open all-pool selection');
  }
  if (!['custom-bps', 'fables-tight'].includes(rangePreset)) {
    throw new Error('RANGE_PRESET must be custom-bps or fables-tight');
  }
  if (!(aprPoolMinTvlUsd > 0)) throw new Error('APR_POOL_MIN_TVL_USD must be > 0');
  if (marketStateRefreshMs < 60_000 || marketStateRefreshMs > 60 * 60_000) {
    throw new Error('MARKET_STATE_REFRESH_MS must be between 1 and 60 minutes');
  }
  if (pollIntervalMs < 5_000 || pollIntervalMs > 60 * 60_000) {
    throw new Error('POLL_INTERVAL_MS must be between 5 seconds and 60 minutes');
  }
  if (oorConfirmDelayMin <= 0) throw new Error('OOR_CONFIRM_DELAY_MIN must be > 0');
  if (swapSlippageBps < 0 || swapSlippageBps >= 10_000) throw new Error('SWAP_SLIPPAGE_BPS must be 0..9999');
  if (maxSwapPriceImpactBps < 0 || maxSwapPriceImpactBps > 1000) {
    throw new Error('MAX_SWAP_PRICE_IMPACT_BPS must be 0..1000');
  }
  if (crossPoolMaxSwapPriceImpactBps < 0 || crossPoolMaxSwapPriceImpactBps > 1000) {
    throw new Error('CROSS_POOL_MAX_SWAP_PRICE_IMPACT_BPS must be 0..1000');
  }
  if (oorRebalanceMaxSwapPriceImpactBps < 0 || oorRebalanceMaxSwapPriceImpactBps > 1000) {
    throw new Error('OOR_REBALANCE_MAX_SWAP_PRICE_IMPACT_BPS must be 0..1000');
  }
  if (oorRebalanceSwapPoolId && !/^0x[0-9a-f]{64}$/.test(oorRebalanceSwapPoolId)) {
    throw new Error('OOR_REBALANCE_SWAP_POOL_ID must be a pool bytes32 ID');
  }
  if (oorRebalanceMaxSwapPriceImpactBps !== maxSwapPriceImpactBps && !oorRebalanceSwapPoolId) {
    throw new Error('OOR_REBALANCE_MAX_SWAP_PRICE_IMPACT_BPS override requires OOR_REBALANCE_SWAP_POOL_ID');
  }
  if (autoTopupMaxSwapPriceImpactBps < 0 || autoTopupMaxSwapPriceImpactBps > 1000) {
    throw new Error('AUTO_TOPUP_MAX_SWAP_PRICE_IMPACT_BPS must be 0..1000');
  }
  if (autoTopupSwapPoolId && !/^0x[0-9a-f]{64}$/.test(autoTopupSwapPoolId)) {
    throw new Error('AUTO_TOPUP_SWAP_POOL_ID must be a pool bytes32 ID');
  }
  if (autoTopupSwapEnabled && !autoTopupSwapPoolId) {
    throw new Error('AUTO_TOPUP_SWAP_ENABLED requires AUTO_TOPUP_SWAP_POOL_ID');
  }
  if (depositSlippageBps < 0 || depositSlippageBps >= 10_000) throw new Error('DEPOSIT_SLIPPAGE_BPS must be 0..9999');
  if (withdrawSlippageBps < 0 || withdrawSlippageBps >= 10_000) throw new Error('WITHDRAW_SLIPPAGE_BPS must be 0..9999');
  if (!(autoTopupMinIdleUsd > 0) || !Number.isFinite(autoTopupMinIdleUsd)) {
    throw new Error('AUTO_TOPUP_MIN_IDLE_USD must be positive');
  }
  if (autoTopupDustBps < 0 || autoTopupDustBps > 1000) {
    throw new Error('AUTO_TOPUP_DUST_BPS must be 0..1000');
  }
  if (autoTopupMinIntervalSec < 60) throw new Error('AUTO_TOPUP_MIN_INTERVAL_SEC must be at least 60');
  if (topUpMinGasReserveWei < 0n || topUpMinGasReserveWei > parseEther('1')) {
    throw new Error('AUTO_TOPUP_MIN_GAS_ETH must be between 0 and 1 ETH');
  }
  if (!dryRun && enableLiveWrites && !privateKey) throw new Error('PRIVATE_KEY is required when live writes are enabled');
  if (!dryRun && enableAutoRedeploy && !enableLiveWrites) throw new Error('ENABLE_AUTO_REDEPLOY requires ENABLE_LIVE_WRITES=true');
  if (!dryRun && enableAutoRedeploy && (!eip7702GuardAddress || !eip7702GuardVerified)) {
    throw new Error('Live auto-redeploy requires a deployed and canary-verified EIP-7702 atomic OOR guard');
  }
  if (officialRepositionEnabled && !officialEip7702GuardAddress) {
    throw new Error('OFFICIAL_REPOSITION_ENABLED for this wallet requires OFFICIAL_EIP7702_GUARD_ADDRESS');
  }

  return {
    chainId: CHAIN_ID,
    rpcUrls,
    rpcRequestTimeoutMs,
    pointsGlobalSwapScanEnabled,
    registryAddress: getAddress(process.env.FABLES_REGISTRY?.trim() || FABLES_REGISTRY),
    usdgAddress: getAddress(process.env.USDG_ADDRESS?.trim() || USDG),
    walletAddress,
    privateKey,
    persistRuntimeCredentials: envBool('PERSIST_RUNTIME_CREDENTIALS', false),
    dryRun,
    enableLiveWrites,
    enableAutoRedeploy,
    externalSwapRoutesEnabled: envBool('EXTERNAL_SWAP_ROUTES_ENABLED', false),
    autoTopupEnabled: envBool('AUTO_TOPUP_ENABLED', false),
    autoTopupSwapEnabled,
    autoTopupSwapPoolId,
    autoTopupMaxSwapPriceImpactBps,
    autoTopupMinIdleUsd,
    autoTopupDustBps,
    autoTopupMinIntervalSec,
    topUpMinGasReserveWei,
    targetMode,
    targetSymbols,
    targetPoolIds,
    rangePreset,
    positionIds: envList('POSITION_IDS', []).map(normalizeBytes32),
    pollIntervalMs,
    logChunkBlocks: envInt('LOG_CHUNK_BLOCKS', 5_000),
    minLogChunkBlocks: envInt('MIN_LOG_CHUNK_BLOCKS', 500),
    logFromBlock,
    walletPoolDiscoveryFromBlock: envInt('WALLET_POOL_DISCOVERY_FROM_BLOCK', logFromBlock),
    manualTopologyCooldownSec: envInt('MANUAL_TOPOLOGY_COOLDOWN_SEC', 120),
    feeLogFromBlock: envInt('FEE_LOG_FROM_BLOCK', 0),
    marketRefreshMs,
    marketStateRefreshMs,
    pointsSimulationIntervalMs,
    reorgLookbackBlocks: envInt('REORG_LOOKBACK_BLOCKS', 64),
    tightWidthBps: envInt('TIGHT_WIDTH_BPS', 120),
    edgeBufferTicks: envInt('EDGE_BUFFER_TICKS', 0),
    rangeCheckIntervalMs,
    aprPoolMinTvlUsd,
    oorConfirmDelayMin,
    oorConfirmDelayMs: oorConfirmDelayMin * 60 * 1000,
    minRebalanceIntervalSec: envInt('MIN_REBALANCE_INTERVAL_SEC', 300),
    maxRebalancesPerHour: envInt('MAX_REBALANCES_PER_HOUR', 3),
    swapSlippageBps,
    maxSwapPriceImpactBps,
    crossPoolMaxSwapPriceImpactBps,
    oorRebalanceSwapPoolId,
    oorRebalanceMaxSwapPriceImpactBps,
    depositSlippageBps,
    withdrawSlippageBps,
    depositLiquidityReserveBps: envInt('DEPOSIT_LIQUIDITY_RESERVE_BPS', 10),
    depositTickTolerance,
    fablesWalk: envInt('FABLES_WALK', 1000),
    permit2ExpirationSec: envInt('PERMIT2_EXPIRATION_SEC', 30 * 24 * 60 * 60),
    eip7702GuardAddress: officialRepositionEnabled ? officialEip7702GuardAddress
      : atomicDepositFeatureEnabled && !atomicDepositEnabled && legacyEip7702GuardAddress
        ? legacyEip7702GuardAddress : eip7702GuardAddress,
    atomicEip7702GuardAddress: eip7702GuardAddress,
    atomicDepositEnabled,
    atomicDepositFeatureEnabled,
    atomicDepositWallets,
    legacyEip7702GuardAddress,
    officialRepositionEnabled,
    officialRepositionFeatureEnabled,
    officialRepositionWallets,
    officialEip7702GuardAddress,
    eip7702GuardVerified,
    eip7702GuardVerificationEnabled,
    eip7702GuardVerifiedFor,
    claimBeforeWithdraw: envBool('CLAIM_BEFORE_WITHDRAW', true),
    allowZeroMinOut: envBool('ALLOW_ZERO_MIN_OUT', false),
    txDeadlineSec: envInt('TX_DEADLINE_SEC', 1200),
    confirmations: envInt('TX_CONFIRMATIONS', 1),
    maxGasGwei: envNum('MAX_GAS_GWEI', 1),
    dashboardEnabled: envBool('DASHBOARD_ENABLED', true),
    dashboardManualControlEnabled: envBool('DASHBOARD_MANUAL_CONTROL_ENABLED', false),
    dashboardHost: process.env.DASHBOARD_HOST?.trim() || '127.0.0.1',
    dashboardPort: envInt('DASHBOARD_PORT', 8787),
    dashboardToken: process.env.DASHBOARD_TOKEN?.trim() || '',
    dataDir: process.env.DATA_DIR?.trim() || './data',
    stateFile: process.env.STATE_FILE?.trim() || './state/bot-state.json',
    actualPointsBaseline: envNum('ACTUAL_POINTS_BASELINE', 0),
    actualPointsBaselineAt: process.env.ACTUAL_POINTS_BASELINE_AT?.trim() || '',
    manualNetCashflowUsd: envNum('MANUAL_NET_CASHFLOW_USD', 0),
    portfolioSnapshotIntervalMs: envInt('PORTFOLIO_SNAPSHOT_INTERVAL_MS', 300_000),
    referenceDepositTx: process.env.REFERENCE_DEPOSIT_TX?.trim() || '',
    blockscoutApiKey: process.env.BLOCKSCOUT_API_KEY?.trim() || '',
    blockscoutApiBase: process.env.BLOCKSCOUT_API_BASE?.trim() || 'https://api.blockscout.com/4663/api/v2'
  };
}

function requiredAddress(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return getAddress(value);
}

function normalizeBytes32(value) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid bytes32: ${value}`);
  return value.toLowerCase();
}

function optionalAddress(name) {
  const value = process.env[name]?.trim();
  return value ? getAddress(value) : '';
}
