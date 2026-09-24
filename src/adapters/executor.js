import { log } from '../logger.js';
import { isLpOutOfRange } from '../math/ticks.js';

export class RebalanceExecutor {
  constructor(readProvider, writeProvider, config, fables, ledger, getUsdPrice) {
    this.readProvider = readProvider;
    this.writeProvider = writeProvider;
    this.config = config;
    this.fables = fables;
    this.ledger = ledger;
    this.getUsdPrice = getUsdPrice;
  }

  async execute(plan) {
    // Absolute rule is re-checked at the executor boundary even for dry-run.
    await this.assertPlanStillOutOfRange(plan, 'executor-entry');

    if (this.config.dryRun || !this.config.enableLiveWrites) {
      const payload = serializablePlan(plan);
      this.ledger.append('rebalance.dry_run', payload);
      log('info', 'rebalance.dry_run', payload);
      return { status: 'dry-run' };
    }

    // Intentionally no partial live implementation exists here.
    // Re-enable writes only after a receipt-reconciled state machine implements:
    // OOR guard -> withdraw -> actual balances -> quote/simulate swap -> swap ->
    // actual balances/tick -> exact deposit math -> simulate deposit -> deposit ->
    // minted ERC-6909 share verification.
    throw new Error(
      'Live rebalance blocked: full withdraw -> swap -> deposit state machine is not implemented; refusing all rebalance writes'
    );
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
