import fs from 'node:fs';
import { ContractFactory, Interface, JsonRpcProvider, Wallet, getCreateAddress, keccak256, parseUnits } from 'ethers';
import { loadDotEnv } from '../env.js';
import { CHAIN_ID } from '../constants.js';
import { assertGuardDeploymentChain, requireDedicatedGuardDeployerKey } from './guard-deployment-safety.js';

loadDotEnv();
if (String(process.env.DEPLOY_EIP7702_GUARD || '').toLowerCase() !== 'true') {
  throw new Error('Set DEPLOY_EIP7702_GUARD=true to explicitly allow guard deployment');
}
const rpc = process.env.GUARD_RPC_URL?.trim() || process.env.RPC_URLS?.split(',')[0]?.trim();
const key = requireDedicatedGuardDeployerKey(process.env.GUARD_DEPLOYER_PRIVATE_KEY);
if (!rpc) throw new Error('GUARD_RPC_URL or RPC_URLS is required');
if (!fs.existsSync('artifacts/Fables7702Guard.json')) {
  throw new Error('Run npm run compile:guard first');
}
const provider = new JsonRpcProvider(rpc);
const network = await provider.getNetwork();
assertGuardDeploymentChain(network.chainId, CHAIN_ID);
const wallet = new Wallet(key, provider);
const artifact = JSON.parse(fs.readFileSync('artifacts/Fables7702Guard.json', 'utf8'));
const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
const journalPath = 'artifacts/guard-deployment-journal.json';
if (fs.existsSync(journalPath)) {
  const old = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  throw new Error(`Existing guard deployment journal requires receipt reconciliation before another deployment: ${old.hash}`);
}
const [latest, pending, fees, deployRequest] = await Promise.all([
  wallet.getNonce('latest'), wallet.getNonce('pending'), provider.getFeeData(), factory.getDeployTransaction()]);
if (latest !== pending) throw new Error('Dedicated deployer has a pending transaction');
const gasCeiling = parseUnits(process.env.MAX_GAS_GWEI || '1', 'gwei');
if (!fees.maxFeePerGas || fees.maxFeePerGas > gasCeiling) throw new Error('Guard deployment exceeds gas fee ceiling');
const gas = await wallet.estimateGas(deployRequest);
if (gas > 5_000_000n) throw new Error('Unexpected guard deployment gas estimate');
const populated = await wallet.populateTransaction({ ...deployRequest, chainId: CHAIN_ID, nonce: pending,
  gasLimit: gas * 150n / 100n + 25_000n, maxFeePerGas: fees.maxFeePerGas,
  maxPriorityFeePerGas: fees.maxPriorityFeePerGas || 0n });
const raw = await wallet.signTransaction(populated);
const hash = keccak256(raw);
const address = getCreateAddress({ from: wallet.address, nonce: pending });
const record = { phase: 'broadcast_pending', hash, address, deployer: wallet.address,
  nonce: pending, chainId: CHAIN_ID, bytecodeHash: keccak256(artifact.bytecode), createdAt: Date.now() };
const persist = () => fs.writeFileSync(journalPath, JSON.stringify(record, null, 2));
persist();
let receipt;
try {
  const tx = await provider.broadcastTransaction(raw);
  if (tx.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('Deployment hash mismatch');
  console.log(JSON.stringify({ sent: hash, deployer: wallet.address, guardAddress: address }));
  receipt = await tx.wait(1, 60_000);
  if (!receipt || receipt.status !== 1) throw new Error('Guard deployment receipt not successful');
} catch {
  record.phase = 'reconciliation_required'; persist();
  throw new Error(`Guard deployment outcome requires reconciliation; do not resend: ${hash}`);
}
const code = await provider.getCode(address);
if (!code || code === '0x') throw new Error('Guard deployment has no runtime code');
const iface = new Interface(artifact.abi);
const [implementation] = iface.decodeFunctionResult('IMPLEMENTATION', await provider.call({
  to: address, data: iface.encodeFunctionData('IMPLEMENTATION') }));
if (implementation.toLowerCase() !== address.toLowerCase()) throw new Error('Deployed implementation mismatch');
record.phase = 'completed'; record.blockNumber = receipt.blockNumber; persist();
console.log(JSON.stringify({ ok: true, guardAddress: address, runtimeBytes: (code.length - 2) / 2 }, null, 2));
provider.destroy();
