// A v2 upgrade of one wallet must not change another wallet's delegation pin.
export function walletGuardConfig(config, walletAddress) {
  const atomicFeatureEnabled = (config.atomicDepositFeatureEnabled ?? config.atomicDepositEnabled) === true;
  const atomicWallets = config.atomicDepositWallets || [config.walletAddress];
  const atomicDepositEnabled = atomicFeatureEnabled && atomicWallets.some(address =>
    String(address).toLowerCase() === String(walletAddress).toLowerCase());
  const officialFeatureEnabled = (config.officialRepositionFeatureEnabled
    ?? config.officialRepositionEnabled) === true;
  const officialWallets = config.officialRepositionWallets || [config.walletAddress];
  const officialRepositionEnabled = officialFeatureEnabled && officialWallets.some(address =>
    String(address).toLowerCase() === String(walletAddress).toLowerCase());
  const legacyGuardAddress = atomicFeatureEnabled && !atomicDepositEnabled && config.legacyEip7702GuardAddress
    ? config.legacyEip7702GuardAddress : config.eip7702GuardAddress;
  const atomicGuardAddress = atomicDepositEnabled
    ? config.atomicEip7702GuardAddress || config.eip7702GuardAddress : legacyGuardAddress;
  return {
    atomicDepositEnabled,
    officialRepositionEnabled,
    eip7702GuardAddress: officialRepositionEnabled
      ? config.officialEip7702GuardAddress || '' : atomicGuardAddress
  };
}
