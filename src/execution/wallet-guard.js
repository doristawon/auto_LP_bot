// A v2 upgrade of one wallet must not change another wallet's delegation pin.
export function walletGuardConfig(config, walletAddress) {
  const enabled = (config.atomicDepositFeatureEnabled ?? config.atomicDepositEnabled) === true;
  const wallets = config.atomicDepositWallets || [config.walletAddress];
  const atomicDepositEnabled = enabled && wallets.some(address =>
    String(address).toLowerCase() === String(walletAddress).toLowerCase());
  return { atomicDepositEnabled,
    eip7702GuardAddress: atomicDepositEnabled
      ? config.atomicEip7702GuardAddress || config.eip7702GuardAddress
      : enabled && config.legacyEip7702GuardAddress
        ? config.legacyEip7702GuardAddress : config.eip7702GuardAddress };
}
