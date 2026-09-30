import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const BASE = {
  WALLET_ADDRESS: '0x0000000000000000000000000000000000000004',
  DRY_RUN: 'true',
  ENABLE_LIVE_WRITES: 'false',
  ENABLE_AUTO_REDEPLOY: 'false'
};

function withEnv(extra, fn) {
  const keys = new Set([...Object.keys(BASE), ...Object.keys(extra), 'TARGET_POOL_IDS', 'TARGET_SYMBOLS', 'TARGET_MODE', 'SWAP_SLIPPAGE_BPS', 'MAX_SWAP_PRICE_IMPACT_BPS', 'OOR_REBALANCE_SWAP_POOL_ID', 'OOR_REBALANCE_MAX_SWAP_PRICE_IMPACT_BPS', 'OOR_CONFIRM_DELAY_MIN', 'OOR_MAX_WAIT_MIN', 'AUTO_TOPUP_SWAP_ENABLED', 'AUTO_TOPUP_SWAP_POOL_ID', 'AUTO_TOPUP_MAX_SWAP_PRICE_IMPACT_BPS', 'PRIVATE_KEY', 'EIP7702_GUARD_ADDRESS', 'EIP7702_GUARD_VERIFIED', 'EIP7702_GUARD_VERIFIED_FOR', 'DASHBOARD_MANUAL_CONTROL_ENABLED', 'POINTS_GLOBAL_SWAP_SCAN_ENABLED', 'RPC_REQUEST_TIMEOUT_MS']);
  const previous = Object.fromEntries([...keys].map((k) => [k, process.env[k]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, BASE, extra);
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('allowlist mode refuses empty pool ids instead of targeting all pools', () => {
  assert.throws(
    () => withEnv({ TARGET_MODE: 'allowlist', TARGET_POOL_IDS: '' }, () => loadConfig()),
    /requires at least one TARGET_POOL_IDS/
  );
});

test('symbols mode refuses empty symbols instead of targeting all pools', () => {
  assert.throws(
    () => withEnv({ TARGET_MODE: 'symbols', TARGET_SYMBOLS: '' }, () => loadConfig()),
    /requires TARGET_SYMBOLS/
  );
});

test('wallet-active mode allows empty static target fields', () => {
  const config = withEnv({ TARGET_MODE: 'wallet-active' }, () => loadConfig());
  assert.equal(config.targetMode, 'wallet-active');
  assert.deepEqual(config.targetPoolIds, []);
  assert.deepEqual(config.targetSymbols, []);
});

test('RPC request timeout defaults to 30 seconds and is bounded', () => {
  const config = withEnv({ TARGET_MODE: 'wallet-active' }, () => loadConfig());
  assert.equal(config.rpcRequestTimeoutMs, 30_000);
  assert.equal(config.pointsGlobalSwapScanEnabled, true);
  const smokeConfig = withEnv({
    TARGET_MODE: 'wallet-active',
    POINTS_GLOBAL_SWAP_SCAN_ENABLED: 'false'
  }, () => loadConfig());
  assert.equal(smokeConfig.pointsGlobalSwapScanEnabled, false);
  assert.throws(
    () => withEnv({ TARGET_MODE: 'wallet-active', RPC_REQUEST_TIMEOUT_MS: '999' }, () => loadConfig()),
    /RPC_REQUEST_TIMEOUT_MS/
  );
});

test('OOR confirmation defaults to 15 minutes and ignores legacy max wait', () => {
  const config = withEnv({ OOR_MAX_WAIT_MIN: '30' }, loadConfig);
  assert.equal(config.oorConfirmDelayMin, 15);
  assert.equal(config.oorConfirmDelayMs, 15 * 60_000);
  assert.throws(() => withEnv({ OOR_CONFIRM_DELAY_MIN: '0' }, loadConfig), /OOR_CONFIRM_DELAY_MIN/);
});

test('invalid swap slippage fails closed', () => {
  assert.throws(
    () => withEnv({ TARGET_MODE: 'wallet-active', SWAP_SLIPPAGE_BPS: '10000' }, () => loadConfig()),
    /SWAP_SLIPPAGE_BPS/
  );
});

test('top-up swap cost override is bound to one explicitly selected pool', () => {
  const poolId = '0x' + 'ab'.repeat(32);
  const config = withEnv({
    AUTO_TOPUP_SWAP_ENABLED: 'true',
    AUTO_TOPUP_SWAP_POOL_ID: poolId,
    MAX_SWAP_PRICE_IMPACT_BPS: '200',
    AUTO_TOPUP_MAX_SWAP_PRICE_IMPACT_BPS: '350'
  }, loadConfig);
  assert.equal(config.maxSwapPriceImpactBps, 200);
  assert.equal(config.autoTopupMaxSwapPriceImpactBps, 350);
  assert.equal(config.autoTopupSwapPoolId, poolId);
  assert.throws(() => withEnv({ AUTO_TOPUP_SWAP_ENABLED: 'true' }, loadConfig), /requires AUTO_TOPUP_SWAP_POOL_ID/);
  assert.throws(() => withEnv({ AUTO_TOPUP_SWAP_POOL_ID: 'not-a-pool' }, loadConfig), /pool bytes32 ID/);
});

test('same-pool OOR swap cost override requires one explicit pool', () => {
  const poolId = '0x' + 'ab'.repeat(32);
  const config = withEnv({
    MAX_SWAP_PRICE_IMPACT_BPS: '200',
    OOR_REBALANCE_SWAP_POOL_ID: poolId,
    OOR_REBALANCE_MAX_SWAP_PRICE_IMPACT_BPS: '350'
  }, loadConfig);
  assert.equal(config.maxSwapPriceImpactBps, 200);
  assert.equal(config.oorRebalanceMaxSwapPriceImpactBps, 350);
  assert.equal(config.oorRebalanceSwapPoolId, poolId);
  assert.throws(() => withEnv({ OOR_REBALANCE_MAX_SWAP_PRICE_IMPACT_BPS: '350' }, loadConfig), /requires OOR_REBALANCE_SWAP_POOL_ID/);
  assert.throws(() => withEnv({ OOR_REBALANCE_SWAP_POOL_ID: 'bad' }, loadConfig), /pool bytes32 ID/);
});

test('live auto-redeploy requires the atomic guard to be configured and canary-verified', () => {
  assert.throws(
    () => withEnv({
      TARGET_MODE: 'wallet-active',
      DRY_RUN: 'false',
      ENABLE_LIVE_WRITES: 'true',
      ENABLE_AUTO_REDEPLOY: 'true',
      PRIVATE_KEY: '0x' + '11'.repeat(32)
    }, () => loadConfig()),
    /EIP-7702 atomic OOR guard/
  );
});

test('guard verification applies only to the wallet that passed its canary', () => {
  const guard = '0x00000000000000000000000000000000000000aa';
  const otherWallet = '0x00000000000000000000000000000000000000bb';
  const matching = withEnv({ EIP7702_GUARD_ADDRESS: guard,
    EIP7702_GUARD_VERIFIED: 'true', EIP7702_GUARD_VERIFIED_FOR: BASE.WALLET_ADDRESS }, loadConfig);
  assert.equal(matching.eip7702GuardVerified, true);
  const mismatched = withEnv({ EIP7702_GUARD_ADDRESS: guard,
    EIP7702_GUARD_VERIFIED: 'true', EIP7702_GUARD_VERIFIED_FOR: otherWallet }, loadConfig);
  assert.equal(mismatched.eip7702GuardVerified, false);
  const unbound = withEnv({ EIP7702_GUARD_ADDRESS: guard,
    EIP7702_GUARD_VERIFIED: 'true' }, loadConfig);
  assert.equal(unbound.eip7702GuardVerified, false);
  const disabled = withEnv({ EIP7702_GUARD_ADDRESS: guard,
    EIP7702_GUARD_VERIFIED: 'false', EIP7702_GUARD_VERIFIED_FOR: BASE.WALLET_ADDRESS }, loadConfig);
  assert.equal(disabled.eip7702GuardVerificationEnabled, false);
  assert.equal(disabled.eip7702GuardVerified, false);
});


test('dashboard manual control defaults safe-off and requires explicit opt-in', () => {
  const safe = withEnv({ TARGET_MODE: 'wallet-active' }, () => loadConfig());
  assert.equal(safe.dashboardManualControlEnabled, false);

  const armed = withEnv({
    TARGET_MODE: 'wallet-active',
    DASHBOARD_MANUAL_CONTROL_ENABLED: 'true'
  }, () => loadConfig());
  assert.equal(armed.dashboardManualControlEnabled, true);
});
