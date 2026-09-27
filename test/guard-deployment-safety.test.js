import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_ID } from '../src/constants.js';
import { assertGuardDeploymentChain, requireDedicatedGuardDeployerKey } from '../src/tools/guard-deployment-safety.js';

test('guard deployment requires a dedicated deployer key', () => {
  assert.throws(() => requireDedicatedGuardDeployerKey(''), /GUARD_DEPLOYER_PRIVATE_KEY/);
  assert.equal(requireDedicatedGuardDeployerKey(' dedicated-key '), 'dedicated-key');
});

test('guard deployment rejects RPCs on any chain other than Robinhood', () => {
  assert.doesNotThrow(() => assertGuardDeploymentChain(BigInt(CHAIN_ID)));
  assert.throws(() => assertGuardDeploymentChain(1), /chain mismatch/);
});
