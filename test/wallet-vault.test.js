import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { WalletVault, validateWalletRecord } from '../src/wallet-vault.js';

const PRIVATE_KEY = `0x${'33'.repeat(32)}`;
const ADDRESS = new Wallet(PRIVATE_KEY).address;

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lpbot-wallet-vault-')); }

test('wallet vault round-trips wallet mode without exposing key in errors', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, '.env.wallets.json');
    const vault = new WalletVault(file, true);
    const record = { address: ADDRESS, privateKey: PRIVATE_KEY, type: 'private-key', live: true, guardVerified: true };
    assert.equal(vault.write([record]), true);
    const [loaded] = vault.read();
    assert.equal(loaded.address, ADDRESS);
    assert.equal(loaded.privateKey, PRIVATE_KEY);
    assert.equal(loaded.live, true);
    assert.equal(loaded.guardVerified, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wallet vault rejects malformed or mismatched credentials with sanitized errors', () => {
  assert.throws(() => validateWalletRecord({ address: ADDRESS, privateKey: `0x${'44'.repeat(32)}` }),
    error => !error.message.includes(PRIVATE_KEY) && /未掛載/.test(error.message));
  const dir = tempDir();
  try {
    const file = path.join(dir, '.env.wallets.json');
    fs.writeFileSync(file, '{not-json', 'utf8');
    const vault = new WalletVault(file, true);
    assert.throws(() => vault.read(), error => !error.message.includes(PRIVATE_KEY) && /無法安全讀取/.test(error.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wallet vault refuses a symlink instead of reading or replacing its target', t => {
  const dir = tempDir();
  try {
    const target = path.join(dir, 'target.json');
    const file = path.join(dir, '.env.wallets.json');
    fs.writeFileSync(target, JSON.stringify({ version: 1, wallets: [] }), 'utf8');
    try { fs.symlinkSync(target, file, 'file'); }
    catch { t.skip('Symlink creation is unavailable for this Windows account'); return; }
    const vault = new WalletVault(file, true);
    assert.throws(() => vault.read(), /無法安全讀取/);
    assert.throws(() => vault.write([]), /未變更/);
    assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify({ version: 1, wallets: [] }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
