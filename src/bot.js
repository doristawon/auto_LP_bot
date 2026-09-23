import { JsonRpcProvider } from 'ethers';
import { FablesAdapter } from './adapters/fables.js';
import { RebalanceExecutor } from './adapters/executor.js';
import { evaluatePosition } from './strategy/tight-range.js';
import { StateStore } from './state.js';
import { log } from './logger.js';

export class AutoLpBot {
  constructor(config) {
    this.config = config;
    this.provider = new JsonRpcProvider(config.rpcUrl, { chainId: config.chainId, name: 'robinhood' }, { staticNetwork: true });
    this.fables = new FablesAdapter(this.provider, config);
    this.executor = new RebalanceExecutor(this.provider, config, this.fables);
    this.state = new StateStore(config.stateFile);
    this.running = false;
  }

  async verifyNetwork() {
    const network = await this.provider.getNetwork();
    if (Number(network.chainId) !== this.config.chainId) {
      throw new Error(`Wrong chain: expected ${this.config.chainId}, got ${network.chainId}`);
    }
    log('info', 'network.ready', { chainId: Number(network.chainId), rpcUrl: redactUrl(this.config.rpcUrl) });
  }

  async runOnce() {
    const pools = await this.fables.discoverTargetPools();
    if (!pools.length) {
      log('warn', 'pool.none', { targetSymbols: this.config.targetSymbols, targetPoolIds: this.config.targetPoolIds });
      return;
    }

    for (const pool of pools) {
      await this.inspectPool(pool);
    }
  }

  async inspectPool(pool) {
    const poolState = await this.fables.readPoolState(pool);
    const pair = `${pool.token0.symbol}/${pool.token1.symbol}`;
    log('info', 'pool.state', {
      pair,
      poolId: pool.id,
      hook: pool.key.hooks,
      tick: poolState.tick,
      tickSpacing: pool.key.tickSpacing,
      paused: poolState.paused
    });

    if (poolState.paused) {
      log('warn', 'pool.paused', { pair, poolId: pool.id });
      return;
    }

    const positions = await this.fables.discoverPositions(pool);
    if (!positions.length) {
      log('warn', 'position.none', { pair, poolId: pool.id, wallet: this.config.walletAddress });
      return;
    }

    for (const position of positions) {
      await this.inspectPosition(pool, poolState, position);
    }
  }

  async inspectPosition(pool, poolState, position) {
    const stored = this.state.getPosition(position.id);
    const evaluation = evaluatePosition({
      currentTick: poolState.tick,
      tickSpacing: pool.key.tickSpacing,
      position,
      widthBps: this.config.tightWidthBps,
      edgeBufferTicks: this.config.edgeBufferTicks,
      confirmationsSeen: stored.outOfRangeConfirmations || 0,
      confirmationsRequired: this.config.outOfRangeConfirmations,
      cooldownUntil: stored.cooldownUntil || 0
    });

    this.state.setPosition(position.id, {
      outOfRangeConfirmations: evaluation.nextConfirmations,
      lastTick: poolState.tick,
      lastSeenAt: Date.now(),
      lastRange: [position.tickLower, position.tickUpper]
    });

    log(evaluation.outside ? 'warn' : 'info', 'position.status', {
      id: position.id,
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      currentTick: poolState.tick,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      shares: position.shares,
      outside: evaluation.outside,
      confirmations: evaluation.nextConfirmations,
      confirmationsRequired: this.config.outOfRangeConfirmations,
      target: evaluation.target
    });

    if (!evaluation.shouldRebalance) return;

    const recent = this.state.recentRebalances();
    if (recent.length >= this.config.maxRebalancesPerHour) {
      log('warn', 'rebalance.rate_limited', {
        count: recent.length,
        limit: this.config.maxRebalancesPerHour,
        positionId: position.id
      });
      return;
    }

    const plan = {
      pool,
      position,
      currentTick: poolState.tick,
      target: evaluation.target
    };

    const result = await this.executor.execute(plan);
    const cooldownUntil = Date.now() + this.config.minRebalanceIntervalSec * 1000;
    this.state.setPosition(position.id, { cooldownUntil, outOfRangeConfirmations: 0 });
    this.state.recordRebalance({
      ts: Date.now(),
      positionId: position.id,
      poolId: pool.id,
      result: result.status,
      currentTick: poolState.tick,
      target: evaluation.target
    });
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.verifyNetwork();
    log('info', 'bot.started', {
      dryRun: this.config.dryRun,
      liveWrites: this.config.enableLiveWrites,
      autoRedeploy: this.config.enableAutoRedeploy,
      pollIntervalMs: this.config.pollIntervalMs,
      tightWidthBps: this.config.tightWidthBps
    });

    while (this.running) {
      const startedAt = Date.now();
      try {
        await this.runOnce();
      } catch (error) {
        log('error', 'cycle.failed', { error: error.stack || error.message });
      }
      const elapsed = Date.now() - startedAt;
      const delay = Math.max(1000, this.config.pollIntervalMs - elapsed);
      await sleep(delay);
    }
  }

  stop() {
    this.running = false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.length > 24) parsed.pathname = '/...';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return '<configured>';
  }
}
