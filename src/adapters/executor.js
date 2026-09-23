import { Contract, Wallet, formatUnits, parseUnits } from 'ethers';
import { ERC20_ABI } from '../abi.js';
import { ZERO_ADDRESS } from '../constants.js';
import { log } from '../logger.js';

export class RebalanceExecutor {
  constructor(readProvider, writeProvider, config, fables, ledger, getUsdPrice) {
    this.readProvider = readProvider;
    this.writeProvider = writeProvider;
    this.config = config;
    this.fables = fables;
    this.ledger = ledger;
    this.getUsdPrice = getUsdPrice;
    this.signer = config.privateKey ? new Wallet(config.privateKey, writeProvider) : null;
  }

  async execute(plan) {
    if (this.config.dryRun || !this.config.enableLiveWrites) {
      this.ledger.append('rebalance.dry_run', serializablePlan(plan));
      log('info', 'rebalance.dry_run', serializablePlan(plan));
      return { status: 'dry-run' };
    }
    this.assertLiveWallet();
    await this.assertGasGuard();
    if (!this.config.allowZeroMinOut) {
      throw new Error('Live withdrawal blocked: set ALLOW_ZERO_MIN_OUT=true only after validating expected output amounts');
    }

    if (this.config.claimBeforeWithdraw && (plan.position.owed0 > 0n || plan.position.owed1 > 0n)) {
      await this.sendVerifiedHookTx({
        to: plan.pool.key.hooks,
        data: this.fables.encodeClaimFees(plan.pool, plan.position),
        label: 'claimFees',
        pool: plan.pool
      });
    }

    const deadline = Math.floor(Date.now() / 1000) + this.config.txDeadlineSec;
    const withdrawal = await this.sendVerifiedHookTx({
      to: plan.pool.key.hooks,
      data: this.fables.encodeWithdraw(plan.pool, plan.position, deadline),
      label: 'withdraw',
      pool: plan.pool
    });

    this.ledger.append('rebalance.redeploy_gated', {
      withdrawalHash: withdrawal.hash,
      target: plan.target,
      inventoryPlan: plan.inventoryPlan || null,
      quote: plan.quote || null,
      reason: 'Deposit broadcast remains gated until the Fables deposit execution manifest is verified'
    });
    return { status: 'withdrawn-redeploy-gated', withdrawalHash: withdrawal.hash };
  }

  assertLiveWallet() {
    if (!this.signer) throw new Error('PRIVATE_KEY is missing');
    if (this.signer.address.toLowerCase() !== this.config.walletAddress.toLowerCase()) {
      throw new Error('PRIVATE_KEY does not match WALLET_ADDRESS');
    }
  }

  async assertGasGuard() {
    const feeData = await this.writeProvider.getFeeData();
    const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
    if (!gasPrice) return;
    const max = parseUnits(String(this.config.maxGasGwei), 'gwei');
    if (gasPrice > max) throw new Error(`Gas guard: ${formatUnits(gasPrice, 'gwei')} gwei > ${this.config.maxGasGwei} gwei`);
  }

  async sendVerifiedHookTx({ to, data, label, pool }) {
    const before = await this.readPairBalances(pool);
    const request = { to, data, value: 0n };
    await this.readProvider.call({ ...request, from: this.signer.address });
    const gasEstimate = await this.signer.estimateGas(request);
    const tx = await this.signer.sendTransaction({ ...request, gasLimit: (gasEstimate * 120n) / 100n });
    this.ledger.append('tx.sent', { label, hash: tx.hash, to, gasEstimate: gasEstimate.toString() });
    const receipt = await tx.wait(this.config.confirmations);
    if (!receipt || receipt.status !== 1) throw new Error(`${label} failed: ${tx.hash}`);
    const after = await this.readPairBalances(pool);
    const gasPrice = receipt.gasPrice || tx.gasPrice || 0n;
    const gasEth = Number(formatUnits(receipt.gasUsed * gasPrice, 18));
    const ethUsd = Number(this.getUsdPrice?.(ZERO_ADDRESS) || 0);
    const gasUsd = ethUsd > 0 ? gasEth * ethUsd : 0;
    const delta0 = after.amount0 - before.amount0;
    const delta1 = after.amount1 - before.amount1;
    this.ledger.append('tx.confirmed', {
      label,
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      gasPriceWei: gasPrice.toString(),
      gasEth,
      gasUsd,
      token0: pool.token0.symbol,
      token1: pool.token1.symbol,
      delta0,
      delta1
    });
    if (label === 'claimFees') {
      const p0 = Number(this.getUsdPrice?.(pool.token0.address) || 0);
      const p1 = Number(this.getUsdPrice?.(pool.token1.address) || 0);
      const feeUsd = Math.max(0, delta0) * p0 + Math.max(0, delta1) * p1;
      this.ledger.append('fee.realized', {
        hash: tx.hash,
        pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
        amount0: Math.max(0, delta0),
        amount1: Math.max(0, delta1),
        symbol0: pool.token0.symbol,
        symbol1: pool.token1.symbol,
        feeUsd
      });
    }
    log('info', 'tx.confirmed', { label, hash: tx.hash, gasEth, gasUsd, delta0, delta1 });
    return receipt;
  }

  async readPairBalances(pool) {
    const amount0 = await this.readTokenBalance(pool.token0);
    const amount1 = await this.readTokenBalance(pool.token1);
    return { amount0, amount1 };
  }

  async readTokenBalance(token) {
    if (token.address.toLowerCase() === ZERO_ADDRESS) {
      return Number(formatUnits(await this.readProvider.getBalance(this.config.walletAddress), 18));
    }
    const contract = new Contract(token.address, ERC20_ABI, this.readProvider);
    const raw = await contract.balanceOf(this.config.walletAddress);
    return Number(formatUnits(raw, token.decimals));
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
    quote: plan.quote || null
  };
}
