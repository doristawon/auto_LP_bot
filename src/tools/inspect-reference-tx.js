import fs from 'node:fs';
import path from 'node:path';
import { Interface } from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';
import { HOOK_ABI } from '../abi.js';

loadDotEnv();
const config = loadConfig();
const hash = process.argv[2] || config.referenceDepositTx;
if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) throw new Error('Provide a transaction hash or set REFERENCE_DEPOSIT_TX');
const providers = createProviders(config);
await verifyProviders(providers.rawProviders, config.chainId);
const [tx, receipt] = await Promise.all([
  providers.readProvider.getTransaction(hash),
  providers.readProvider.getTransactionReceipt(hash)
]);
if (!tx) throw new Error(`Transaction not found: ${hash}`);
let trace = null;
try {
  trace = await providers.writeProvider.send('debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
} catch (error) {
  trace = { unavailable: true, error: error.message };
}
const iface = new Interface(HOOK_ABI);
let hookDecode = null;
try { hookDecode = iface.parseTransaction({ data: tx.data, value: tx.value }); } catch {}
const artifact = {
  inspectedAt: new Date().toISOString(),
  hash,
  transaction: {
    from: tx.from,
    to: tx.to,
    nonce: tx.nonce,
    value: tx.value.toString(),
    selector: tx.data?.slice(0, 10) || '0x',
    data: tx.data
  },
  receipt: receipt ? {
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    gasPrice: (receipt.gasPrice || tx.gasPrice || 0n).toString(),
    logs: receipt.logs.map((x) => ({ address: x.address, topics: [...x.topics], data: x.data, index: x.index }))
  } : null,
  directHookDecode: hookDecode ? { name: hookDecode.name, signature: hookDecode.signature, args: [...hookDecode.args].map(stringify) } : null,
  trace
};
const dir = path.join(config.dataDir, 'reference-tx');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${hash}.json`);
fs.writeFileSync(file, JSON.stringify(artifact, null, 2));
console.log(JSON.stringify({ ok: true, file, selector: artifact.transaction.selector, to: tx.to, traceAvailable: !trace?.unavailable }, null, 2));

function stringify(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(stringify);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stringify(v)]));
  return value;
}
