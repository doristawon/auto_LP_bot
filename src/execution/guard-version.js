import { id } from 'ethers';

export const GUARD_VERSION_V1 = 'Fables7702Guard/v1';
export const GUARD_VERSION_V2 = 'Fables7702Guard/v2';
export const GUARD_VERSION_V3 = 'Fables7702Guard/v3';

export const GUARD_VERSION_IDS = Object.freeze({
  v1: id(GUARD_VERSION_V1),
  v2: id(GUARD_VERSION_V2),
  v3: id(GUARD_VERSION_V3)
});

/** Validate the delegated guard version against the wallet's configured mode. */
export function assertGuardVersion(version, config = {}) {
  const actual = String(version || '').toLowerCase();
  if (actual === GUARD_VERSION_IDS.v3.toLowerCase()) return 'v3';
  if (config.officialRepositionEnabled === true) {
    throw new Error('Official reposition requires Fables7702Guard/v3');
  }
  if (actual === GUARD_VERSION_IDS.v2.toLowerCase()) return 'v2';
  if (actual === GUARD_VERSION_IDS.v1.toLowerCase() && config.atomicDepositEnabled !== true) return 'v1';
  if (actual === GUARD_VERSION_IDS.v1.toLowerCase() && config.atomicDepositEnabled === true) {
    throw new Error('Atomic swap+deposit requires Fables7702Guard/v2');
  }
  throw new Error('Unexpected EIP-7702 guard version; expected Fables7702Guard/v1, Fables7702Guard/v2, or Fables7702Guard/v3');
}
