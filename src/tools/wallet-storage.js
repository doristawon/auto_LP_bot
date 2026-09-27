import fs from 'node:fs';
import path from 'node:path';

export function resolveWalletStorage(config) {
  const baseDataDir = config.dataDir || './data';
  const baseStateFile = config.stateFile || './state/bot-state.json';
  const walletAddress = String(config.walletAddress || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(walletAddress)) {
    throw new Error('A valid WALLET_ADDRESS is required to resolve wallet storage');
  }

  const walletDataDir = path.join(baseDataDir, 'wallets', walletAddress);
  const walletStateFile = path.join(walletDataDir, 'bot-state.json');
  if (fs.existsSync(walletStateFile)) {
    return { dataDir: walletDataDir, stateFile: walletStateFile, walletSpecific: true };
  }
  return { dataDir: baseDataDir, stateFile: baseStateFile, walletSpecific: false };
}
