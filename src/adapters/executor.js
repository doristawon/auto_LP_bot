import { Wallet, formatUnits, parseUnits } from 'ethers';
import { log } from '../logger.js';

export class RebalanceExecutor {
  constructor(provider, config, fables) {
    this.provider = provider;
    this.config = config;
    this.fables = fables;
    this.signer = config.privateKey ? new Wallet(config.privateKey, provider) : null;
  }

  async execute(plan) {
    if (this.config.dryRun || !this.config.enableLiveWrites) {
      log('info', 'rebalance.dry_run', serializablePlan(plan));
      return { status: 'dry-run' };
    }

    this.assertLiveWallet();
    await this.assertGasGuard();

    if (!this.config.allowZeroMinOut) {
      throw new Error('Live withdrawal blocked: ALLOW_ZERO_MIN_OUT must be explicitly enabled in v0.1');
    }

    if (this.config.claimBeforeWithdraw && (plan.position.owed0 > 0n || plan.position.owed1 > 0n)) {
      await this.sendVerifiedHookTx({
        to: plan.pool.key.hooks,
        data: this.fables.encodeClaimFees(plan.pool, plan.position),
        label: 'claimFees'
      });
    }

    const deadline = Math.floor(Date.now() / 1000) + this.config.txDeadlineSec;
    const withdrawal = await this.sendVerifiedHookTx({
      to: plan.pool.key.hooks,
      data: this.fables.encodeWithdraw(plan.pool, plan.position, deadline),
      label: 'withdraw'
    });

    if (!this.config.enableAutoRedeploy) {
      log('warn', 'rebalance.redeploy_gated', {
        reason: 'Fables deposit/new-range ABI is not independently verified in v0.1',
        target: plan.target,
        withdrawalHash: withdrawal.hash
      });
      return { status: 'withdrawn-redeploy-gated', withdrawalHash: withdrawal.hash };
    }

    throw new Error('Auto redeploy must not be enabled until the Fables deposit ABI and swap route are verified');
  }

  assertLiveWallet() {
    if (!this.signer) throw new Error('PRIVATE_KEY is missing');
    if (this.signer.address.toLowerCase() !== this.config.walletAddress.toLowerCase()) {
      throw new Error('PRIVATE_KEY does not match WALLET_ADDRESS');
    }
  }

  async assertGasGuard() {
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
    if (!gasPrice) return;
    const max = parseUnits(String(this.config.maxGasGwei), 'gwei');
    if (gasPrice > max) {
      throw new Error(`Gas guard blocked write: ${formatUnits(gasPrice, 'gwei')} gwei > ${this.config.maxGasGwei} gwei`);
    }
  }

  async sendVerifiedHookTx({ to, data, label }) {
    const request = { to, data, value: 0n };
    await this.provider.call({ ...request, from: this.signer.address });
    const gasEstimate = await this.signer.estimateGas(request);
    const tx = await this.signer.sendTransaction({ ...request, gasLimit: (gasEstimate * 120n) / 100n });
    log('info', 'tx.sent', { label, hash: tx.hash, gasEstimate });
    const receipt = await tx.wait(this.config.confirmations);
    if (!receipt || receipt.status !== 1) throw new Error(`${label} failed: ${tx.hash}`);
    log('info', 'tx.confirmed', { label, hash: tx.hash, blockNumber: receipt.blockNumber });
    return receipt;
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
      shares: plan.position.shares.toString(),
      owed0: plan.position.owed0.toString(),
      owed1: plan.position.owed1.toString()
    },
    target: plan.target,
    note: 'v0.1 dry-run computes the new range; live redeposit remains gated pending ABI verification'
  };
}
