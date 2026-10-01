import test from 'node:test';
import assert from 'node:assert/strict';
import { walletGuardConfig } from '../src/execution/wallet-guard.js';
const first = '0x' + '1'.repeat(40), second = '0x' + '2'.repeat(40);
const v1 = '0x' + '3'.repeat(40), v2 = '0x' + '4'.repeat(40);

test('atomic wallet pin is independent of the paused legacy wallet', () => {
  const config = { walletAddress: first, atomicDepositEnabled: true, atomicDepositWallets: [first],
    eip7702GuardAddress: v2, legacyEip7702GuardAddress: v1 };
  assert.deepEqual(walletGuardConfig(config, first), { atomicDepositEnabled: true, eip7702GuardAddress: v2 });
  assert.deepEqual(walletGuardConfig(config, second), { atomicDepositEnabled: false, eip7702GuardAddress: v1 });
});

test('global feature selection can upgrade a secondary wallet while primary stays legacy', () => {
  const config = { walletAddress: first, atomicDepositEnabled: false, atomicDepositFeatureEnabled: true,
    atomicDepositWallets: [second], eip7702GuardAddress: v2, legacyEip7702GuardAddress: v1 };
  assert.equal(walletGuardConfig(config, second).atomicDepositEnabled, true);
  assert.equal(walletGuardConfig(config, first).eip7702GuardAddress, v1);
});
