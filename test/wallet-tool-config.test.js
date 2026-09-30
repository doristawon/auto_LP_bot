import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { selectToolWallet } from '../src/wallet-tool-config.js';
import { registerSensitiveValues, sanitize } from '../src/logger.js';

test('guard tools explicitly select additional signer without mutating primary config', () => {
  const primary = Wallet.createRandom();
  const secondary = Wallet.createRandom();
  const config = { walletAddress: primary.address, privateKey: primary.privateKey, dataDir: 'data',
    eip7702GuardVerified: true, stateFile: 'state/bot-state.json' };
  const vault = { read: () => [{ address: secondary.address, privateKey: secondary.privateKey, guardVerified: false }] };
  assert.equal(selectToolWallet(config, [], vault), config);
  const selected = selectToolWallet(config, [`--wallet=${secondary.address}`], vault);
  assert.equal(selected.walletAddress, secondary.address);
  assert.equal(selected.privateKey, secondary.privateKey);
  assert.equal(selected.eip7702GuardVerified, false);
  assert.equal(config.privateKey, primary.privateKey);
  assert.equal(config.stateFile, 'state/bot-state.json');
  assert.match(selected.stateFile, /wallets/);
  assert.equal(sanitize(secondary.privateKey), '[REDACTED]');
});

test('guard tools reject unknown or watch-only additional wallet', () => {
  const config = { walletAddress: Wallet.createRandom().address };
  const secondary = Wallet.createRandom();
  const vault = { read: () => [{ address: secondary.address, privateKey: '' }] };
  assert.throws(() => selectToolWallet(config, [`--wallet=${secondary.address}`], vault), /no locally stored signer/);
  assert.throws(() => selectToolWallet(config, [`--wallet=${Wallet.createRandom().address}`], vault), /no locally stored signer/);
});

test('registering a later wallet preserves earlier signers and removed RPC redactions', () => {
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  const rpc = 'https://rpc.example.invalid/key-one-abcdef0123456789';
  registerSensitiveValues([a.privateKey, rpc]);
  registerSensitiveValues([b.privateKey]);
  assert.equal(sanitize(a.privateKey), '[REDACTED]');
  assert.equal(sanitize(b.privateKey), '[REDACTED]');
  assert.equal(sanitize(rpc), '[REDACTED]');
});
