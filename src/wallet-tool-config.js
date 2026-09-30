import { getAddress } from 'ethers';
import path from 'node:path';
import { WalletVault } from './wallet-vault.js';
import { registerSensitiveValues } from './logger.js';

// Tool selection is explicit and never rewrites the primary .env signer.
export function selectToolWallet(config, argv = process.argv, vault = new WalletVault()) {
  const option = argv.find(value => value.startsWith('--wallet='));
  if (!option) return config;
  const address = getAddress(option.slice('--wallet='.length));
  if (address.toLowerCase() === config.walletAddress.toLowerCase()) return config;
  const record = vault.read().find(item => item.address.toLowerCase() === address.toLowerCase());
  if (!record?.privateKey) throw new Error('Selected wallet has no locally stored signer');
  registerSensitiveValues([record.privateKey]);
  // Guard tools do not instantiate AutoLpBot/ledger. verify:guard resolves
  // dataDir/wallets/address itself, so dataDir must remain the root here.
  return { ...config, walletAddress: record.address, privateKey: record.privateKey,
    stateFile: path.join(config.dataDir, 'wallets', record.address.toLowerCase(), 'bot-state.json'),
    eip7702GuardVerified: record.guardVerified,
    eip7702GuardVerificationEnabled: record.guardVerified,
    eip7702GuardVerifiedFor: record.guardVerified ? record.address : '' };
}
