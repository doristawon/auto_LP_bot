import { getAddress } from 'ethers';
import { CHAIN_ID, DEFAULT_RPC_URL, FABLES_REGISTRY } from './constants.js';
import { envBool, envInt, envList } from './env.js';

export function loadConfig() {
  const walletAddress = requiredAddress('WALLET_ADDRESS');
  const privateKey = process.env.PRIVATE_KEY?.trim() || '';
  const dryRun = envBool('DRY_RUN', true);
  const enableLiveWrites = envBool('ENABLE_LIVE_WRITES', false);
  const enableAutoRedeploy = envBool('ENABLE_AUTO_REDEPLOY', false);

  if (!dryRun && enableLiveWrites && !privateKey) {
    throw new Error('PRIVATE_KEY is required when live writes are enabled');
  }
  if (!dryRun && enableAutoRedeploy) {
    throw new Error('Live auto-redeploy is intentionally gated in v0.1 until the Fables deposit ABI is independently verified');
  }

  const targetSymbols = envList('TARGET_SYMBOLS', ['CASHCAT', 'USDG']).map((x) => x.toUpperCase());
  const positionIds = envList('POSITION_IDS', []);

  return {
    chainId: CHAIN_ID,
    rpcUrl: process.env.RPC_URL?.trim() || DEFAULT_RPC_URL,
    registryAddress: getAddress(process.env.FABLES_REGISTRY?.trim() || FABLES_REGISTRY),
    walletAddress,
    privateKey,
    dryRun,
    enableLiveWrites,
    enableAutoRedeploy,
    targetSymbols,
    targetPoolIds: envList('TARGET_POOL_IDS', []).map((x) => x.toLowerCase()),
    positionIds: positionIds.map(normalizeBytes32),
    pollIntervalMs: envInt('POLL_INTERVAL_MS', 15_000),
    logChunkBlocks: envInt('LOG_CHUNK_BLOCKS', 1_000_000),
    logFromBlock: envInt('LOG_FROM_BLOCK', 0),
    tightWidthBps: envInt('TIGHT_WIDTH_BPS', 120),
    edgeBufferTicks: envInt('EDGE_BUFFER_TICKS', 0),
    outOfRangeConfirmations: envInt('OUT_OF_RANGE_CONFIRMATIONS', 2),
    minRebalanceIntervalSec: envInt('MIN_REBALANCE_INTERVAL_SEC', 300),
    maxRebalancesPerHour: envInt('MAX_REBALANCES_PER_HOUR', 3),
    claimBeforeWithdraw: envBool('CLAIM_BEFORE_WITHDRAW', true),
    allowZeroMinOut: envBool('ALLOW_ZERO_MIN_OUT', false),
    txDeadlineSec: envInt('TX_DEADLINE_SEC', 1200),
    confirmations: envInt('TX_CONFIRMATIONS', 1),
    maxGasGwei: Number(process.env.MAX_GAS_GWEI || 1),
    stateFile: process.env.STATE_FILE?.trim() || './state/bot-state.json'
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
