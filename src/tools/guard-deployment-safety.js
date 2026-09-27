import { CHAIN_ID } from '../constants.js';

export function requireDedicatedGuardDeployerKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) throw new Error('GUARD_DEPLOYER_PRIVATE_KEY is required; refusing to use the LP wallet key');
  return key;
}

export function assertGuardDeploymentChain(actualChainId, expectedChainId = CHAIN_ID) {
  if (BigInt(actualChainId) !== BigInt(expectedChainId)) {
    throw new Error(`Guard deployment RPC chain mismatch: expected ${expectedChainId}, got ${actualChainId}`);
  }
}
