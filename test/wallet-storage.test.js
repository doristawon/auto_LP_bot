import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWalletStorage } from '../src/tools/wallet-storage.js';

const walletAddress = '0x6F196aF3B69c521eEd9436Abc9130699dF1c50bF';

test('wallet-specific state and snapshot directory follows bot wallet routing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lpbot-wallet-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const walletDataDir = path.join(root, 'data', 'wallets', walletAddress.toLowerCase());
  fs.mkdirSync(walletDataDir, { recursive: true });
  fs.writeFileSync(path.join(walletDataDir, 'bot-state.json'), '{}', 'utf8');

  assert.deepEqual(resolveWalletStorage({
    walletAddress,
    dataDir: path.join(root, 'data'),
    stateFile: path.join(root, 'state', 'bot-state.json')
  }), {
    dataDir: walletDataDir,
    stateFile: path.join(walletDataDir, 'bot-state.json'),
    walletSpecific: true
  });
});

test('wallet without a stored state uses the configured base state path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lpbot-wallet-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const stateFile = path.join(root, 'state', 'bot-state.json');

  assert.deepEqual(resolveWalletStorage({ walletAddress, dataDir, stateFile }), {
    dataDir,
    stateFile,
    walletSpecific: false
  });
});
