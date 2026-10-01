// Read-only mainnet rehearsal. State overrides install the candidate runtime
// temporarily; no signer is created and no transaction is broadcast.
import fs from 'node:fs';
import path from 'node:path';
import { Contract, Interface, JsonRpcProvider, getAddress, id, zeroPadValue } from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { FablesAdapter } from '../adapters/fables.js';
import { RebalanceExecutor } from '../adapters/executor.js';
import { EIP7702_GUARD_ABI, ERC20_ABI, HOOK_ABI, REGISTRY_ABI } from '../abi.js';
import { buildExactWithdrawBounds, getLiquidityForAmounts, getSqrtPriceAtTick } from '../math/v4-fixed.js';
import { buildTargetRange } from '../math/ticks.js';
import { buildPairFundingScope } from '../execution/pair-funding.js';
import { buildAtomicDepositRequest, findAtomicDepositEvent } from '../execution/atomic-deposit.js';

loadDotEnv();
const config = { ...loadConfig(), privateKey: '', dryRun: true, enableLiveWrites: false };
const provider = new JsonRpcProvider(config.rpcUrls[0], config.chainId,
  { staticNetwork: true, batchMaxCount: 1 });
if (BigInt(await provider.send('eth_chainId', [])) !== BigInt(config.chainId)) throw new Error('Wrong chain');
const block = await provider.send('eth_blockNumber', []);
const originalSend = provider.send.bind(provider);
provider.send = (method, args) => {
  if (method === 'eth_call') args = [args[0], block];
  if (method === 'eth_simulateV1') args = [args[0], block];
  return originalSend(method, args);
};
const saved = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'wallets',
  config.walletAddress.toLowerCase(), 'latest-snapshot.json'), 'utf8'));
const active = saved.pools.flatMap(pool => (pool.positions || []).filter(p => BigInt(p.shares) > 0n)
  .map(position => ({ poolId: pool.id, position })));
if (active.length !== 1) throw new Error('Atomic rehearsal requires one currently active range');
const entries = await new Contract(config.registryAddress, REGISTRY_ABI, provider).activePools();
const entry = entries.find(p => p.active && p.id.toLowerCase() === active[0].poolId.toLowerCase());
if (!entry) throw new Error('Active pool is not registered');
const key = { currency0: getAddress(entry.key.currency0), currency1: getAddress(entry.key.currency1),
  fee: Number(entry.key.fee), tickSpacing: Number(entry.key.tickSpacing), hooks: getAddress(entry.key.hooks) };
const fables = new FablesAdapter(provider, config);
const pool = { id: active[0].poolId, key,
  token0: await fables.getToken(key.currency0), token1: await fables.getToken(key.currency1) };
const position = active[0].position;
const shares = await new Contract(key.hooks, HOOK_ABI, provider).balanceOf(config.walletAddress, position.id);
if (shares <= 0n) throw new Error('No live LP shares');
const state = await fables.readPoolState(pool);
const hook = new Interface(HOOK_ABI), token = new Interface(ERC20_ABI);
const deadline = Math.floor(Date.now() / 1000) + config.txDeadlineSec;
const bounds = buildExactWithdrawBounds({ sqrtPriceX96: state.sqrtPriceX96,
  tickLower: position.tickLower, tickUpper: position.tickUpper, liquidity: shares,
  slippageBps: config.withdrawSlippageBps });
// Direct hook withdrawal is only a temporary prefix in this read-only tool.
// The live executor retains guarded OOR withdrawal and its full preflight.
const withdraw = { to: key.hooks, data: hook.encodeFunctionData('withdrawAndClaim', [key,
  position.tickLower, position.tickUpper, shares, config.walletAddress,
  bounds.amount0Min, bounds.amount1Min, deadline, config.fablesWalk]), value: 0n, gasLimit: 1_500_000 };
const artifact = JSON.parse(fs.readFileSync('artifacts/Fables7702Guard.json', 'utf8'));
const implementation = getAddress('0x000000000000000000000000000000000000bEEF');
let code = artifact.deployedBytecode.slice(2);
for (const refs of Object.values(artifact.immutableReferences)) for (const ref of refs) {
  const value = zeroPadValue(implementation, ref.length).slice(2);
  code = code.slice(0, ref.start * 2) + value + code.slice((ref.start + ref.length) * 2);
}
const overrides = { [config.walletAddress]: { code: '0x' + code } };
let rpcCalls = 0;
const simulate = async (calls, stateOverrides = {}) => {
  rpcCalls++;
  const blocks = await provider.send('eth_simulateV1', [{ blockStateCalls: [{ stateOverrides,
    calls: calls.map(call => ({ from: call.from || config.walletAddress, to: call.to,
      data: call.data, value: '0x0', gas: '0x' + BigInt(call.gasLimit || 4_000_000).toString(16) })) }],
    validation: false }, 'latest']);
  return blocks[0].calls;
};
const balanceCalls = [pool.token0, pool.token1].map(t => ({ to: t.address,
  data: token.encodeFunctionData('balanceOf', [config.walletAddress]), gasLimit: 100_000 }));
const withdrawal = await simulate([withdraw, ...balanceCalls]);
if (withdrawal.some(r => r.status !== '0x1')) throw new Error('Temporary withdrawal failed');
const balances = { raw0: token.decodeFunctionResult('balanceOf', withdrawal[1].returnData)[0],
  raw1: token.decodeFunctionResult('balanceOf', withdrawal[2].returnData)[0] };
const scope = buildPairFundingScope(pool, balances, config.usdgAddress, config.autoTopupDustBps);
const executor = new RebalanceExecutor(provider, provider, config, fables, { append() {} }, () => 1);
// Quotes must see the reduced liquidity after withdrawal too.
executor.quoter.provider = { call: async request => {
  const results = await simulate([withdraw, { ...request, gasLimit: 3_000_000 }]);
  if (results.some(r => r.status !== '0x1')) throw new Error('Post-withdraw quote failed');
  return results.at(-1).returnData;
} };
const fitted = await executor.prepareRangeBalancedSwap({ pool, funding: scope.funding, state,
  target: buildTargetRange(state.tick, key.tickSpacing, config.tightWidthBps, config.rangePreset),
  stableIndex: scope.stableIndex, maxPriceImpactBps: executor.samePoolRebalanceMaxImpactBps(pool),
  prefixCalls: [withdraw], expectedOutput: true,
  chooseTarget: tick => buildTargetRange(tick, key.tickSpacing, config.tightWidthBps, config.rangePreset) });
const swap = fitted.swapPlan;
const request = swap.direction === 'none' ? null : executor.router.buildV4ExactInputSingle({
  pool: swap.swapPool || pool, quote: swap.quote, deadline });
const projected = { ...scope.funding };
if (swap.direction !== 'none') {
  if (swap.tokenIn === 0) { projected.raw0 -= swap.rawAmountIn; projected.raw1 += BigInt(swap.quote.minRawAmountOut); }
  else { projected.raw1 -= swap.rawAmountIn; projected.raw0 += BigInt(swap.quote.minRawAmountOut); }
}
const minLiquidity = getLiquidityForAmounts(fitted.postState.sqrtPriceX96,
  getSqrtPriceAtTick(fitted.target.tickLower), getSqrtPriceAtTick(fitted.target.tickUpper),
  projected.raw0, projected.raw1) * BigInt(10_000 - config.depositSlippageBps) / 10_000n;
const atomic = buildAtomicDepositRequest({ pool, walletAddress: config.walletAddress,
  target: fitted.target, balances, funding: scope.funding, swapPlan: swap,
  routerRequest: request, minLiquidity, deadline });
const approvals = await executor.buildTopUpApprovalRequests(pool, swap, { amount0Max: 0n, amount1Max: 0n });
const full = await simulate([...approvals.map(r => r.tx), withdraw, atomic, ...balanceCalls], overrides);
const atomicResult = full[approvals.length + 1];
const result = { readOnly: true, broadcast: false, candidateVersion: 'v2', poolId: pool.id,
  pinnedBlock: Number(block),
  target: fitted.target, capacityMismatchBps: fitted.capacityMismatchBps, rpcCalls,
  callStatuses: full.map(r => r.status), atomicGas: Number(atomicResult.gasUsed), atomicError: atomicResult.error || null };
if (atomicResult.status === '0x1') {
  const event = findAtomicDepositEvent(atomicResult, config.walletAddress, pool.id);
  result.liquidity = String(event.liquidity);
  result.residualBps = [Number(event.residual0 * 10_000n / event.funding0),
    Number(event.residual1 * 10_000n / event.funding1)];
  result.depositEvents = atomicResult.logs.filter(l =>
    l.address.toLowerCase() === key.hooks.toLowerCase() && l.topics[0] === id('Deposited(address,uint256,uint128)')).length;
  result.walletDeposit = Boolean(executor.findWalletDepositEvent(pool, atomicResult));
}
const guard = new Interface(artifact.abi);
const wrongCaller = getAddress('0x0000000000000000000000000000000000001234');
const callerCanary = await simulate([{ ...atomic, from: wrongCaller }], overrides);
const directCanary = await simulate([{ ...atomic, to: implementation }],
  { [implementation]: { code: '0x' + code } });
const fakePlan = { ...atomic.plan, key: { ...key, hooks: wrongCaller } };
const fakePool = await simulate([{ to: atomic.to,
  data: guard.encodeFunctionData('atomicSwapAndDeposit', [fakePlan]) }], overrides);
const protectedBounds = async (results, expectedError) => {
  const r = results[0];
  const raw = [r.returnData, r.error?.data].find(value => typeof value === 'string' && value.length >= 10);
  if (r.status !== '0x0' || !raw || guard.parseError(raw)?.name !== expectedError) {
    throw new Error('Atomic canary failed: ' + expectedError + ' ' + JSON.stringify(r));
  }
};
await protectedBounds(callerCanary, 'OnlySelfCall');
await protectedBounds(directCanary, 'DirectImplementationCall');
await protectedBounds(fakePool, 'InvalidHook');
result.canaries = ['OnlySelfCall', 'DirectImplementationCall', 'InvalidHook'];
if (swap.direction !== 'none') {
  const badCommands = new Interface(['function execute(bytes,bytes[],uint256)']);
  const malformed = { ...atomic.plan,
    routerData: badCommands.encodeFunctionData('execute', ['0x04', ['0x'], deadline]) };
  const badRoute = await simulate([...approvals.map(r => r.tx), withdraw,
    { to: atomic.to, data: guard.encodeFunctionData('atomicSwapAndDeposit', [malformed]) }], overrides);
  await protectedBounds([badRoute.at(-1)], 'InvalidAtomicPlan');
  result.canaries.push('InvalidAtomicPlan');
}
const noResidual = { ...atomic.plan, maxResidualBps: 0 };
const rollback = await simulate([...approvals.map(r => r.tx), withdraw,
  { to: atomic.to, data: guard.encodeFunctionData('atomicSwapAndDeposit', [noResidual]) }, ...balanceCalls], overrides);
const revert = rollback[approvals.length + 1];
const revertRaw = [revert.returnData, revert.error?.data].find(value => typeof value === 'string' && value.length >= 10);
if (revert.status === '0x0' && revertRaw && guard.parseError(revertRaw)?.name === 'ExcessResidual') {
  if (token.decodeFunctionResult('balanceOf', rollback.at(-2).returnData)[0] !== balances.raw0
    || token.decodeFunctionResult('balanceOf', rollback.at(-1).returnData)[0] !== balances.raw1) {
    throw new Error('Atomic revert failed to restore both token balances');
  }
  result.canaries.push('ExcessResidual restores pre-swap balances');
}
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/atomic-mainnet-rehearsal.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (full.some(r => r.status !== '0x1')) throw new Error('Atomic mainnet rehearsal failed');
provider.destroy();
