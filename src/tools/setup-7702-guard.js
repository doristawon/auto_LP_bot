import fs from 'node:fs';
import { Interface, Wallet, getAddress, keccak256, parseUnits } from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';
import { ZERO_ADDRESS } from '../constants.js';
import { selectToolWallet } from '../wallet-tool-config.js';
import { assertGuardVersion } from '../execution/guard-version.js';
import { walletGuardConfig } from '../execution/wallet-guard.js';

loadDotEnv();
const selected = selectToolWallet(loadConfig());
const config = { ...selected, ...walletGuardConfig(selected, selected.walletAddress) };
if (!config.privateKey) throw new Error('PRIVATE_KEY is required');
const { rawProviders } = createProviders(config);
const rpcHealth = await verifyProviders(rawProviders, config.chainId);
const writeProvider = rawProviders[rpcHealth.find(item => item.ok).index];
const wallet = new Wallet(config.privateKey, writeProvider);
if (wallet.address.toLowerCase() !== config.walletAddress.toLowerCase()) throw new Error('PRIVATE_KEY does not match WALLET_ADDRESS');

const revoke = process.argv.includes('--revoke');
const guardAddress = revoke ? ZERO_ADDRESS : getAddress(config.eip7702GuardAddress || '');
if (!revoke) {
  const code = await writeProvider.getCode(guardAddress);
  if (!code || code === '0x') throw new Error('EIP7702_GUARD_ADDRESS has no deployed code');
}
const txNonce = await wallet.getNonce('pending');
if (await wallet.getNonce('latest') !== txNonce) throw new Error('Wallet has a pending transaction; delegation update is blocked');
const authorization = await wallet.authorize({
  address: guardAddress,
  chainId: config.chainId,
  nonce: txNonce + 1
});
let data = '0x';
if (!revoke) {
  const artifact = JSON.parse(fs.readFileSync('artifacts/Fables7702Guard.json', 'utf8'));
  data = new Interface(artifact.abi).encodeFunctionData('guardVersion', []);
}
const fees = await writeProvider.getFeeData();
const maxFeePerGas = parseUnits(String(config.maxGasGwei), 'gwei');
if (!fees.gasPrice || fees.gasPrice > maxFeePerGas) throw new Error('Guard setup gas price exceeds configured limit');
const request = {
  to: wallet.address,
  data,
  nonce: txNonce,
  type: 4,
  authorizationList: [authorization],
  maxFeePerGas,
  maxPriorityFeePerGas: (fees.maxPriorityFeePerGas || 0n) > maxFeePerGas ? maxFeePerGas : (fees.maxPriorityFeePerGas || 0n)
};
const estimatedGas = await wallet.estimateGas(request);
const gasLimit = (estimatedGas * 125n + 99n) / 100n;
if (gasLimit > 150000n) throw new Error('Guard setup requires more than the 150000 gas limit');
const journalPath = 'artifacts/guard-setup-journal.json';
if (fs.existsSync(journalPath)) throw new Error('Existing guard setup journal requires receipt reconciliation before another authorization');
const populated = await wallet.populateTransaction({ ...request, chainId: config.chainId, gasLimit });
const raw = await wallet.signTransaction(populated);
const expectedHash = keccak256(raw);
const journal = { phase: 'broadcast_pending', hash: expectedHash, wallet: wallet.address,
  guardAddress, nonce: txNonce, revoke, chainId: config.chainId };
fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
const tx = await writeProvider.broadcastTransaction(raw);
if (tx.hash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error('Guard setup returned an unexpected transaction hash');
console.log(JSON.stringify({ sent: tx.hash, revoke, guardAddress }, null, 2));
const receipt = await tx.wait(config.confirmations, 60_000);
if (!receipt || receipt.status !== 1) throw new Error('EIP-7702 setup transaction failed');
const code = (await writeProvider.getCode(wallet.address)).toLowerCase();
const expected = revoke ? '0x' : ('0xef0100' + guardAddress.slice(2)).toLowerCase();
if (code !== expected) throw new Error(`Delegation verification failed: expected ${expected}, got ${code}`);
if (!revoke) {
  const artifact = JSON.parse(fs.readFileSync('artifacts/Fables7702Guard.json', 'utf8'));
  const iface = new Interface(artifact.abi);
  const versionRaw = await writeProvider.call({
    from: wallet.address,
    to: wallet.address,
    data: iface.encodeFunctionData('guardVersion', [])
  });
  const [version] = iface.decodeFunctionResult('guardVersion', versionRaw);
  assertGuardVersion(version, config);
  const implRaw = await writeProvider.call({
    from: wallet.address,
    to: wallet.address,
    data: iface.encodeFunctionData('IMPLEMENTATION', [])
  });
  const [implementation] = iface.decodeFunctionResult('IMPLEMENTATION', implRaw);
  if (String(implementation).toLowerCase() !== guardAddress.toLowerCase()) {
    throw new Error(`Guard implementation mismatch after delegation: expected ${guardAddress}, got ${implementation}`);
  }
}
console.log(JSON.stringify({ ok: true, wallet: wallet.address, code }, null, 2));
journal.phase = 'completed'; journal.blockNumber = receipt.blockNumber;
fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
for (const provider of rawProviders) provider.destroy();
