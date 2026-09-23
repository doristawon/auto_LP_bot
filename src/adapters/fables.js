import {
  AbiCoder,
  Contract,
  Interface,
  getAddress,
  id as eventId,
  keccak256,
  zeroPadValue
} from 'ethers';
import {
  DEPOSITED_EVENT,
  ERC20_ABI,
  HOOK_ABI,
  POOL_MANAGER_ABI,
  REGISTRY_ABI
} from '../abi.js';
import { POOLS_STORAGE_SLOT, ZERO_ADDRESS } from '../constants.js';
import { log } from '../logger.js';

const abiCoder = AbiCoder.defaultAbiCoder();
const hookInterface = new Interface(HOOK_ABI);
const depositedTopic = eventId(DEPOSITED_EVENT);

export class FablesAdapter {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.registry = new Contract(config.registryAddress, REGISTRY_ABI, provider);
    this.tokens = new Map();
    this.positionScans = new Map();
  }

  async discoverTargetPools() {
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
      pool.token0 = await this.getToken(pool.key.currency0);
      pool.token1 = await this.getToken(pool.key.currency1);
      if (this.matchesTarget(pool)) pools.push(pool);
    }

    return pools;
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
      address,
      symbol: symbolResult.status === 'fulfilled' ? String(symbolResult.value) : short(address),
      decimals: decimalsResult.status === 'fulfilled' ? Number(decimalsResult.value) : null
    };
    this.tokens.set(key, result);
    return result;
  }

  async readPoolState(pool) {
    const hook = new Contract(pool.key.hooks, HOOK_ABI, this.provider);
    const [poolManagerAddress, paused] = await Promise.all([hook.poolManager(), hook.paused().catch(() => false)]);
    const poolManager = new Contract(poolManagerAddress, POOL_MANAGER_ABI, this.provider);
    const slot = keccak256(abiCoder.encode(['bytes32', 'uint256'], [pool.id, POOLS_STORAGE_SLOT]));
    const words = await poolManager.extsload(slot, 4);
    if (!words || words.length < 4) throw new Error(`Pool state unavailable for ${pool.id}`);

    const packed = BigInt(words[0]);
    const sqrtMask = (1n << 160n) - 1n;
    const sqrtPriceX96 = packed & sqrtMask;
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

  async discoverPositions(pool) {
    const scanKey = pool.id.toLowerCase();
    let scan = this.positionScans.get(scanKey);
    if (!scan) {
      scan = {
        candidates: new Set(this.config.positionIds),
        nextBlock: this.config.logFromBlock
      };
      this.positionScans.set(scanKey, scan);
    }

    const latest = await this.provider.getBlockNumber();
    const walletTopic = zeroPadValue(this.config.walletAddress, 32).toLowerCase();

    for (let from = scan.nextBlock; from <= latest; from += this.config.logChunkBlocks + 1) {
      const to = Math.min(latest, from + this.config.logChunkBlocks);
      let logs;
      try {
        logs = await this.provider.getLogs({
          address: pool.key.hooks,
          fromBlock: from,
          toBlock: to,
          topics: [depositedTopic, walletTopic]
        });
      } catch (error) {
        log('warn', 'logs.read_failed', { poolId: pool.id, from, to, error: error.message });
        throw error;
      }
      for (const item of logs) {
        if (item.topics[2]) scan.candidates.add(item.topics[2].toLowerCase());
      }
      scan.nextBlock = to + 1;
    }

    const candidates = scan.candidates;
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
    return positions;
  }

  encodeClaimFees(pool, position) {
    return hookInterface.encodeFunctionData('claimFees', [
      poolKeyArgs(pool),
      position.tickLower,
      position.tickUpper,
      this.config.walletAddress,
      0
    ]);
  }

  encodeWithdraw(pool, position, deadline) {
    return hookInterface.encodeFunctionData('withdraw', [
      poolKeyArgs(pool),
      position.tickLower,
      position.tickUpper,
      position.shares,
      this.config.walletAddress,
      0n,
      0n,
      deadline
    ]);
  }
}

export function poolKeyArgs(pool) {
  return [
    pool.key.currency0,
    pool.key.currency1,
    pool.key.fee,
    pool.key.tickSpacing,
    pool.key.hooks
  ];
}

function short(value) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}
