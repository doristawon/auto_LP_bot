import test from 'node:test';
import assert from 'node:assert/strict';
import { assertGuardVersion, GUARD_VERSION_IDS } from '../src/execution/guard-version.js';

test('legacy guard mode accepts either supported guard version', () => {
  assert.equal(assertGuardVersion(GUARD_VERSION_IDS.v1), 'v1');
  assert.equal(assertGuardVersion(GUARD_VERSION_IDS.v2), 'v2');
  assert.equal(assertGuardVersion(GUARD_VERSION_IDS.v1, { atomicDepositEnabled: false }), 'v1');
});

test('atomic deposit mode requires guard v2', () => {
  assert.equal(assertGuardVersion(GUARD_VERSION_IDS.v2, { atomicDepositEnabled: true }), 'v2');
  assert.throws(() => assertGuardVersion(GUARD_VERSION_IDS.v1, { atomicDepositEnabled: true }),
    /requires Fables7702Guard\/v2/);
});

test('official reposition requires v3 while legacy and atomic modes retain their supported versions', () => {
  assert.equal(assertGuardVersion(GUARD_VERSION_IDS.v3, { officialRepositionEnabled: true }), 'v3');
  assert.throws(() => assertGuardVersion(GUARD_VERSION_IDS.v2, { officialRepositionEnabled: true }),
    /requires Fables7702Guard\/v3/);
  assert.equal(assertGuardVersion(GUARD_VERSION_IDS.v3, { atomicDepositEnabled: true }), 'v3');
  assert.equal(assertGuardVersion(GUARD_VERSION_IDS.v2, { atomicDepositEnabled: true }), 'v2');
  assert.equal(assertGuardVersion(GUARD_VERSION_IDS.v1, { atomicDepositEnabled: false }), 'v1');
});

test('unknown or malformed guard versions fail closed', () => {
  assert.throws(() => assertGuardVersion('0x1234'), /Unexpected EIP-7702 guard version/);
  assert.throws(() => assertGuardVersion(null), /Unexpected EIP-7702 guard version/);
});
