import { getAddress } from 'ethers';
import { CHAIN_ID, DEFAULT_RPC_URL, FABLES_REGISTRY, USDG } from './constants.js';
import { envBool, envInt, envList, envNum } from './env.js';

export function loadConfig() {
  const walletAddress = requiredAddress('WALLET_ADDRESS');
  const privateKey = process.env.PRIVATE_KEY?.trim() || '';
  const dryRun = envBool('DRY_RUN', true);
  const enableLiveWrites = envBool('ENABLE_LIVE_WRITES', false);
  const enableAutoRedeploy = envBool('ENABLE_AUTO_REDEPLOY', false);
  const rpcUrls = envList('RPC_URLS', [DEFAULT_RPC_URL]);

  if (!rpcUrls.length) throw new Error('RPC_URLS must contain at least one endpoint');
  if (!dryRun && enableLiveWrites && !privateKey) throw new Error('PRIVATE_KEY is required when live writes are enabled');
  if (!dryRun && enableAutoRedeploy) {
    throw new Error('Live auto-redeploy is gated until Fables deposit and swap calldata are independently verified');
  }

  return {
    chainId: CHAIN_ID,
    rpcUrls,
    registryAddress: getAddress(process.env.FABLES_REGISTRY?.trim() || FABLES_REGISTRY),
    usdgAddress: getAddress(process.env.USDG_ADDRESS?.trim() || USDG),
    walletAddress,
    privateKey,
    dryRun,
    enableLiveWrites,
    enableAutoRedeploy,
    targetSymbols: envList('TARGET_SYMBOLS', ['CASHCAT', 'USDG']).map((x) => x.toUpperCase()),
    targetPoolIds: envList('TARGET_POOL_IDS', []).map((x) => x.toLowerCase()),
    positionIds: envList('POSITION_IDS', []).map(normalizeBytes32),
    pollIntervalMs: envInt('POLL_INTERVAL_MS', 15_000),
    logChunkBlocks: envInt('LOG_CHUNK_BLOCKS', 500_000),
    minLogChunkBlocks: envInt('MIN_LOG_CHUNK_BLOCKS', 25_000),
    logFromBlock: envInt('LOG_FROM_BLOCK', 44_000_000),
    feeLogFromBlock: envInt('FEE_LOG_FROM_BLOCK', 0),
    marketRefreshMs: envInt('MARKET_REFRESH_MS', 60_000),
    reorgLookbackBlocks: envInt('REORG_LOOKBACK_BLOCKS', 64),
    tightWidthBps: envInt('TIGHT_WIDTH_BPS', 120),
    edgeBufferTicks: envInt('EDGE_BUFFER_TICKS', 0),
    outOfRangeConfirmations: envInt('OUT_OF_RANGE_CONFIRMATIONS', 2),
    minRebalanceIntervalSec: envInt('MIN_REBALANCE_INTERVAL_SEC', 300),
    maxRebalancesPerHour: envInt('MAX_REBALANCES_PER_HOUR', 3),
    claimBeforeWithdraw: envBool('CLAIM_BEFORE_WITHDRAW', true),
    allowZeroMinOut: envBool('ALLOW_ZERO_MIN_OUT', false),
    txDeadlineSec: envInt('TX_DEADLINE_SEC', 1200),
    confirmations: envInt('TX_CONFIRMATIONS', 1),
    maxGasGwei: envNum('MAX_GAS_GWEI', 1),
    dashboardEnabled: envBool('DASHBOARD_ENABLED', true),
    dashboardHost: process.env.DASHBOARD_HOST?.trim() || '127.0.0.1',
    dashboardPort: envInt('DASHBOARD_PORT', 8787),
    dashboardToken: process.env.DASHBOARD_TOKEN?.trim() || '',
    dataDir: process.env.DATA_DIR?.trim() || './data',
    stateFile: process.env.STATE_FILE?.trim() || './state/bot-state.json',
    actualPointsBaseline: envNum('ACTUAL_POINTS_BASELINE', 0),
    actualPointsBaselineAt: process.env.ACTUAL_POINTS_BASELINE_AT?.trim() || '',
    manualNetCashflowUsd: envNum('MANUAL_NET_CASHFLOW_USD', 0),
    referenceDepositTx: process.env.REFERENCE_DEPOSIT_TX?.trim() || ''
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
