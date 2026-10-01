import fs from 'node:fs';
import path from 'node:path';
import { Contract, Interface } from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';
import { FablesAdapter } from '../adapters/fables.js';
import { EIP7702_GUARD_ABI, HOOK_ABI } from '../abi.js';
import { selectToolWallet } from '../wallet-tool-config.js';
import { assertGuardVersion } from '../execution/guard-version.js';
import { walletGuardConfig } from '../execution/wallet-guard.js';
import { buildTargetRange } from '../math/ticks.js';

// This canary only reads an existing snapshot and makes RPC calls. It must not
// instantiate AutoLpBot or update the live state/ledger during another cycle.
loadDotEnv();
process.env.DRY_RUN = 'true';
process.env.ENABLE_LIVE_WRITES = 'false';
process.env.ENABLE_AUTO_REDEPLOY = 'false';
const selected = selectToolWallet(loadConfig());
const config = { ...selected, ...walletGuardConfig(selected, selected.walletAddress) };
if (!config.eip7702GuardAddress) throw new Error('EIP7702_GUARD_ADDRESS is required');

const providers = createProviders(config);
await verifyProviders(providers.rawProviders, config.chainId);
const provider = providers.readProvider;
const snapshotFile = path.resolve(config.dataDir, 'wallets', config.walletAddress.toLowerCase(), 'latest-snapshot.json');
if (!fs.existsSync(snapshotFile)) throw new Error('Wallet snapshot is missing; wait for a successful monitoring cycle');
const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
if (String(snapshot.bot?.wallet || '').toLowerCase() !== config.walletAddress.toLowerCase()) {
  throw new Error('Wallet snapshot belongs to another signer');
}

const fables = new FablesAdapter(provider, config);
const currentPools = await fables.discoverAllPools();
const poolById = new Map(currentPools.map((pool) => [pool.id.toLowerCase(), pool]));
let candidate = null;
let liveCandidate = null;
for (const savedPool of snapshot.pools || []) {
  const pool = poolById.get(String(savedPool.id).toLowerCase());
  if (!pool) continue;
  for (const position of savedPool.positions || []) {
    if (BigInt(position.shares || 0) <= 0n) continue;
    const state = await fables.readPoolState(pool);
    if (state.paused) continue;
    const hook = new Contract(pool.key.hooks, HOOK_ABI, provider);
    const liveShares = await hook.balanceOf(config.walletAddress, position.id);
    if (liveShares <= 0n) continue;
    liveCandidate ||= { pool, position, state, liveShares };
    if (state.tick < position.tickLower || state.tick >= position.tickUpper) continue;
    candidate = { pool, position, state, liveShares };
    break;
  }
  if (candidate) break;
}
const synthetic = !candidate;
if (!candidate && liveCandidate) {
  const range = buildTargetRange(liveCandidate.state.tick, liveCandidate.pool.key.tickSpacing,
    config.tightWidthBps, config.rangePreset);
  candidate = { ...liveCandidate, position: { ...liveCandidate.position, ...range } };
}
if (!candidate) throw new Error('No currently active LP was found for the guard canary');

const code = (await provider.getCode(config.walletAddress)).toLowerCase();
const expected = `0xef0100${config.eip7702GuardAddress.slice(2)}`.toLowerCase();
if (code !== expected) throw new Error('Wallet EIP-7702 delegation does not match the configured guard');

const iface = new Interface([...EIP7702_GUARD_ABI,
  'error InRange(int24 currentTick,int24 tickLower,int24 tickUpper)']);
const versionRaw = await provider.call({
  from: config.walletAddress, to: config.walletAddress,
  data: iface.encodeFunctionData('guardVersion', [])
});
const [version] = iface.decodeFunctionResult('guardVersion', versionRaw);
assertGuardVersion(version, config);
const implementationRaw = await provider.call({
  from: config.walletAddress, to: config.walletAddress,
  data: iface.encodeFunctionData('IMPLEMENTATION', [])
});
const [implementation] = iface.decodeFunctionResult('IMPLEMENTATION', implementationRaw);
if (String(implementation).toLowerCase() !== config.eip7702GuardAddress.toLowerCase()) {
  throw new Error('Guard implementation mismatch');
}

const { pool, position, state, liveShares } = candidate;
const data = iface.encodeFunctionData('guardedWithdrawAndClaim', [
  [pool.key.currency0, pool.key.currency1, pool.key.fee, pool.key.tickSpacing, pool.key.hooks],
  position.tickLower, position.tickUpper, liveShares, config.walletAddress,
  0n, 0n, BigInt(Math.floor(Date.now() / 1000) + config.txDeadlineSec), config.fablesWalk
]);
let blocked = false;
try {
  await provider.call({ from: config.walletAddress, to: config.walletAddress, data });
} catch (error) {
  const raw = error.data || error.info?.error?.data || error.info?.error?.error?.data;
  let parsed = null;
  try { if (typeof raw === 'string') parsed = iface.parseError(raw); }
  catch { /* An unknown revert is a failed canary. */ }
  blocked = parsed?.name === 'InRange';
  if (!blocked) throw new Error('Atomic guard canary reverted for a reason other than InRange');
}
if (!blocked) throw new Error('Atomic guard canary FAILED: In-Range withdrawal unexpectedly succeeded');
console.log(JSON.stringify({
  ok: true, wallet: config.walletAddress, guard: config.eip7702GuardAddress,
  poolId: pool.id, currentTick: state.tick,
  range: [position.tickLower, position.tickUpper],
  syntheticInRange: synthetic,
  result: 'in-range-withdrawal-blocked', revert: 'InRange'
}, null, 2));
for (const provider of providers.rawProviders) provider.destroy();
