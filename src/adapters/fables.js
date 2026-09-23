import {
  AbiCoder,
  Contract,
  Interface,
  formatUnits,
  getAddress,
  id as eventId,
  keccak256,
  zeroPadValue
} from 'ethers';
import {
  DEPOSITED_EVENT,
  ERC20_ABI,
  FEES_COLLECTED_EVENT,
  HOOK_ABI,
  POOL_MANAGER_ABI,
  REGISTRY_ABI,
  WITHDRAWN_EVENT
} from '../abi.js';
import { POOLS_STORAGE_SLOT, ZERO_ADDRESS } from '../constants.js';
import { log } from '../logger.js';

const abiCoder = AbiCoder.defaultAbiCoder();
const hookInterface = new Interface(HOOK_ABI);
const depositedTopic = eventId(DEPOSITED_EVENT);
const withdrawnTopic = eventId(WITHDRAWN_EVENT);
const feesTopic = eventId(FEES_COLLECTED_EVENT);

export class FablesAdapter {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.registry = new Contract(config.registryAddress, REGISTRY_ABI, provider);
    this.tokens = new Map();
    this.positionCandidates = new Map();
  }

  async discoverAllPools() {
    const entries = await this.registry.activePools();
    const pools = [];
    for (const entry of entries) {
      if (!entry.active) continue;
      const key = entry.key;
      const pool = {
        id: String(entry.id).toLowerCase(),
        key: {
          currency0: getAddress(key.currency0),
          currency1: getAddress(key.currency1),
          fee: Number(key.fee),
          tickSpacing: Number(key.tickSpacing),
          hooks: getAddress(key.hooks)
        }
      };
      [pool.token0, pool.token1] = await Promise.all([
        this.getToken(pool.key.currency0),
        this.getToken(pool.key.currency1)
      ]);
      pools.push(pool);
    }
    return pools;
  }

  targetPools(allPools) {
    return allPools.filter((pool) => this.matchesTarget(pool));
  }

  matchesTarget(pool) {
    if (this.config.targetPoolIds.length && this.config.targetPoolIds.includes(pool.id)) return true;
    if (!this.config.targetSymbols.length) return true;
    const symbols = new Set([pool.token0.symbol.toUpperCase(), pool.token1.symbol.toUpperCase()]);
    return this.config.targetSymbols.every((symbol) => symbols.has(symbol));
  }

  async getToken(address) {
    const key = address.toLowerCase();
    if (this.tokens.has(key)) return this.tokens.get(key);
    if (key === ZERO_ADDRESS) {
      const native = { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 };
      this.tokens.set(key, native);
      return native;
    }
    const token = new Contract(address, ERC20_ABI, this.provider);
    const [symbolResult, decimalsResult] = await Promise.allSettled([token.symbol(), token.decimals()]);
    const result = {
      address: getAddress(address),
      symbol: symbolResult.status === 'fulfilled' ? String(symbolResult.value) : short(address),
      decimals: decimalsResult.status === 'fulfilled' ? Number(decimalsResult.value) : null
    };
    this.tokens.set(key, result);
    return result;
  }

  async readPoolState(pool) {
    const hook = new Contract(pool.key.hooks, HOOK_ABI, this.provider);
    const [poolManagerAddress, paused] = await Promise.all([
      hook.poolManager(),
      hook.paused().catch(() => false)
    ]);
    const manager = new Contract(poolManagerAddress, POOL_MANAGER_ABI, this.provider);
    const slot = keccak256(abiCoder.encode(['bytes32', 'uint256'], [pool.id, POOLS_STORAGE_SLOT]));
    const words = await manager.extsload(slot, 4);
    if (!words || words.length < 4) throw new Error(`Pool state unavailable for ${pool.id}`);
    const packed = BigInt(words[0]);
    const sqrtPriceX96 = packed & ((1n << 160n) - 1n);
    let tick = Number((packed >> 160n) & 0xffffffn);
    if (tick >= 2 ** 23) tick -= 2 ** 24;
    return {
      poolManager: getAddress(poolManagerAddress),
      sqrtPriceX96,
      tick,
      liquidity: BigInt(words[3]),
      paused: Boolean(paused)
    };
  }

  async hydratePoolStates(pools, concurrency = 4) {
    const out = [];
    for (let i = 0; i < pools.length; i += concurrency) {
      const batch = pools.slice(i, i + concurrency);
      const states = await Promise.all(batch.map(async (pool) => {
        try { return { ...pool, state: await this.readPoolState(pool) }; }
        catch (error) {
          log('warn', 'pool.state_failed', { poolId: pool.id, error: error.message });
          return { ...pool, state: null };
        }
      }));
      out.push(...states);
    }
    return out;
  }

  async discoverPositions(pool, fromBlock, latestBlock) {
    const key = pool.id.toLowerCase();
    let candidates = this.positionCandidates.get(key);
    if (!candidates) {
      candidates = new Set(this.config.positionIds);
      this.positionCandidates.set(key, candidates);
    }
    const walletTopic = zeroPadValue(this.config.walletAddress, 32).toLowerCase();
    const logs = await this.getLogsAdaptive({
      address: pool.key.hooks,
      topics: [[depositedTopic, withdrawnTopic], walletTopic]
    }, fromBlock, latestBlock);
    for (const item of logs) if (item.topics[2]) candidates.add(item.topics[2].toLowerCase());

    const hook = new Contract(pool.key.hooks, HOOK_ABI, this.provider);
    const positions = [];
    for (const rangeId of candidates) {
      const [shares, rangeKey, user] = await Promise.all([
        hook.balanceOf(this.config.walletAddress, rangeId),
        hook.rangeKey(rangeId),
        hook.userPosition(rangeId, this.config.walletAddress).catch(() => null)
      ]);
      if (shares === 0n || !rangeKey.exists) continue;
      positions.push({
        id: rangeId,
        shares: BigInt(shares),
        tickLower: Number(rangeKey.tickLower),
        tickUpper: Number(rangeKey.tickUpper),
        owed0: user ? BigInt(user.owed0) : 0n,
        owed1: user ? BigInt(user.owed1) : 0n
      });
    }
    return { positions, lifecycleLogs: logs };
  }

  async scanPoolFees(pool, fromBlock, toBlock) {
    const logs = await this.getLogsAdaptive({ address: pool.key.hooks, topics: [feesTopic] }, fromBlock, toBlock);
    return logs.map((entry) => {
      const data = entry.data.slice(2);
      const amount0 = BigInt(`0x${data.slice(0, 64) || '0'}`);
      const amount1 = BigInt(`0x${data.slice(64, 128) || '0'}`);
      return { blockNumber: entry.blockNumber, transactionHash: entry.transactionHash, index: Number(entry.index ?? 0), amount0, amount1 };
    });
  }

  async readWalletBalances(tokens) {
    const result = {};
    for (const token of tokens) {
      const key = token.address.toLowerCase();
      if (key === ZERO_ADDRESS) {
        const raw = await this.provider.getBalance(this.config.walletAddress);
        result[key] = { raw, amount: Number(formatUnits(raw, 18)) };
      } else if (token.decimals != null) {
        const contract = new Contract(token.address, ERC20_ABI, this.provider);
        const raw = await contract.balanceOf(this.config.walletAddress);
        result[key] = { raw, amount: Number(formatUnits(raw, token.decimals)) };
      }
    }
    return result;
  }

  async getLogsAdaptive(filter, fromBlock, toBlock) {
    if (fromBlock > toBlock) return [];
    const all = [];
    let cursor = fromBlock;
    let span = this.config.logChunkBlocks;
    while (cursor <= toBlock) {
      const end = Math.min(toBlock, cursor + span - 1);
      try {
        const logs = await this.provider.getLogs({ ...filter, fromBlock: cursor, toBlock: end });
        all.push(...logs);
        cursor = end + 1;
        if (span < this.config.logChunkBlocks) span = Math.min(this.config.logChunkBlocks, span * 2);
      } catch (error) {
        if (span <= this.config.minLogChunkBlocks) throw error;
        span = Math.max(this.config.minLogChunkBlocks, Math.floor(span / 2));
        log('warn', 'rpc.log_chunk_reduced', { fromBlock: cursor, toBlock: end, nextSpan: span, error: error.message });
      }
    }
    return all;
  }

  encodeClaimFees(pool, position) {
    return hookInterface.encodeFunctionData('claimFees', [
      poolKeyArgs(pool), position.tickLower, position.tickUpper, this.config.walletAddress, 0
    ]);
  }

  encodeWithdraw(pool, position, deadline) {
    return hookInterface.encodeFunctionData('withdraw', [
      poolKeyArgs(pool), position.tickLower, position.tickUpper, position.shares,
      this.config.walletAddress, 0n, 0n, deadline
    ]);
  }
}

export function poolKeyArgs(pool) {
  return [pool.key.currency0, pool.key.currency1, pool.key.fee, pool.key.tickSpacing, pool.key.hooks];
}

export function lifecycleEventType(logEntry) {
  const topic = logEntry.topics?.[0]?.toLowerCase();
  if (topic === depositedTopic.toLowerCase()) return 'deposit';
  if (topic === withdrawnTopic.toLowerCase()) return 'withdraw';
  return null;
}

export function lifecycleLiquidity(logEntry) {
  try { return BigInt(logEntry.data); } catch { return 0n; }
}

function short(value) { return `${value.slice(0, 6)}...${value.slice(-4)}`; }
