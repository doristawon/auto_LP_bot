import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const BASE = {
  WALLET_ADDRESS: '0x6F196aF3B69c521eEd9436Abc9130699dF1c50bF',
  DRY_RUN: 'true',
  ENABLE_LIVE_WRITES: 'false',
  ENABLE_AUTO_REDEPLOY: 'false'
};

function withEnv(extra, fn) {
  const keys = new Set([...Object.keys(BASE), ...Object.keys(extra), 'TARGET_POOL_IDS', 'TARGET_SYMBOLS', 'TARGET_MODE', 'SWAP_SLIPPAGE_BPS']);
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

test('invalid swap slippage fails closed', () => {
  assert.throws(
    () => withEnv({ TARGET_MODE: 'wallet-active', SWAP_SLIPPAGE_BPS: '10000' }, () => loadConfig()),
    /SWAP_SLIPPAGE_BPS/
  );
});
