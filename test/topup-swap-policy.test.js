import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTopUpSwapPolicy } from '../src/execution/topup-swap-policy.js';

test('saved single-pool target enables its verified top-up swap at no more than 350 bps', () => {
  const result = resolveTopUpSwapPolicy({
    poolId: 'cashcat', autoTopupSwapEnabled: true, autoTopupSwapPoolId: 'legacy-moo',
    autoTopupMaxSwapPriceImpactBps: 500, crossPoolMaxSwapPriceImpactBps: 350,
    maxSwapPriceImpactBps: 200, investmentTargetMode: 'specific-pool',
    investmentTargetPoolId: 'cashcat'
  });
  assert.equal(result.swapEnabledForPool, true);
  assert.equal(result.isSavedSpecificTarget, true);
  assert.equal(result.maxPriceImpactBps, 350);
});

test('a legacy configured pool cannot override a mismatching saved specific target', () => {
  const result = resolveTopUpSwapPolicy({
    poolId: 'legacy-moo', autoTopupSwapEnabled: true, autoTopupSwapPoolId: 'legacy-moo',
    investmentTargetMode: 'specific-pool', investmentTargetPoolId: 'cashcat'
  });
  assert.equal(result.swapEnabledForPool, false);
  assert.equal(result.savedSpecificTargetMismatch, true);
});

test('enabled allocation scope takes precedence over a stale saved specific target', () => {
  const result = resolveTopUpSwapPolicy({
    poolId: 'moo-allocation', autoTopupSwapEnabled: true,
    autoTopupSwapPoolId: 'legacy-moo', allocationEnabled: true,
    investmentTargetMode: 'specific-pool', investmentTargetPoolId: 'cashcat'
  });
  assert.equal(result.savedSpecificTargetMismatch, false);
  assert.equal(result.swapEnabledForPool, true);
});

test('APR mode only enables swaps after the executor verifies an existing in-range position', () => {
  const input = { poolId: 'cashcat', autoTopupSwapEnabled: true,
    autoTopupSwapPoolId: 'legacy-moo', autoTopupMaxSwapPriceImpactBps: 350,
    crossPoolMaxSwapPriceImpactBps: 350, investmentTargetMode: 'apr-highest' };
  assert.equal(resolveTopUpSwapPolicy(input).swapEnabledForPool, false);
  const verified = resolveTopUpSwapPolicy({ ...input, verifiedExistingInRangePosition: true });
  assert.equal(verified.swapEnabledForPool, true);
  assert.equal(verified.maxPriceImpactBps, 350);
});

test('configured legacy pool retains its own price impact cap', () => {
  const result = resolveTopUpSwapPolicy({
    poolId: 'legacy-moo', autoTopupSwapEnabled: true, autoTopupSwapPoolId: 'legacy-moo',
    autoTopupMaxSwapPriceImpactBps: 275, maxSwapPriceImpactBps: 200
  });
  assert.equal(result.swapEnabledForPool, true);
  assert.equal(result.maxPriceImpactBps, 275);
});

test('saved target falls back to the global cap when no top-up-specific cap is configured', () => {
  const result = resolveTopUpSwapPolicy({
    poolId: 'cashcat', autoTopupSwapEnabled: true, autoTopupSwapPoolId: 'legacy-moo',
    maxSwapPriceImpactBps: 200, investmentTargetMode: 'specific-pool',
    investmentTargetPoolId: 'cashcat'
  });
  assert.equal(result.maxPriceImpactBps, 200);
});

test('disabled top-up swap setting never enables a swap', () => {
  const result = resolveTopUpSwapPolicy({
    poolId: 'cashcat', autoTopupSwapEnabled: false, autoTopupSwapPoolId: 'legacy-moo',
    autoTopupMaxSwapPriceImpactBps: 350, investmentTargetMode: 'specific-pool',
    investmentTargetPoolId: 'cashcat'
  });
  assert.equal(result.swapEnabledForPool, false);
});
