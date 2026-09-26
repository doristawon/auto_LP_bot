import fs from 'node:fs';
import path from 'node:path';
import {
  AbiCoder,
  Contract,
  Interface,
  formatUnits,
  id,
  keccak256,
  zeroPadValue
} from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';
import { FablesAdapter, poolKeyFingerprint } from '../adapters/fables.js';
import {
  DEPOSITED_EVENT,
  ERC20_ABI,
  HOOK_ABI,
  WITHDRAWN_EVENT
} from '../abi.js';
import {
  buildExactDepositPlan,
  buildExactWithdrawBounds
} from '../math/v4-fixed.js';
import { buildCenteredRange } from '../math/ticks.js';
import { ZERO_ADDRESS } from '../constants.js';

loadDotEnv();
const config = loadConfig();
const { readProvider, rawProviders } = createProviders(config);
await verifyProviders(rawProviders, config.chainId);

const fromBlock = Number(process.env.REPLAY_FROM_BLOCK || 69_000_000);
const latestBlock = await readProvider.getBlockNumber();
const lifecycleLookaheadMin = Number(process.env.REPLAY_DEPOSIT_LOOKAHEAD_MIN || 180);
const preSwapBuffer = Number(process.env.REPLAY_SWAP_BUFFER_BLOCKS || 100_000);
const wallet = config.walletAddress.toLowerCase();
const hookIface = new Interface(HOOK_ABI);
const erc20Iface = new Interface(ERC20_ABI);
const coder = AbiCoder.defaultAbiCoder();
const depositedTopic = id(DEPOSITED_EVENT).toLowerCase();
const withdrawnTopic = id(WITHDRAWN_EVENT).toLowerCase();
const transferTopic = id('Transfer(address,address,uint256)').toLowerCase();
const swapIface = new Interface([
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)'
]);
const swapTopic = id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)').toLowerCase();

console.log('[replay] wallet', config.walletAddress, 'blocks', fromBlock, '->', latestBlock);

const fables = new FablesAdapter(readProvider, config);
const allPools = await fables.discoverAllPools();
const poolByFingerprint = new Map(allPools.map((pool) => [poolKeyFingerprint(pool.key), pool]));
const hooks = [...new Set(allPools.map((pool) => pool.key.hooks.toLowerCase()))];
const walletTopic = zeroPadValue(config.walletAddress, 32).toLowerCase();

const lifecycleLogs = [];
for (const hook of hooks) {
  const logs = await fables.getLogsAdaptive({
    address: hook,
    topics: [[depositedTopic, withdrawnTopic], walletTopic]
  }, fromBlock, latestBlock);
  lifecycleLogs.push(...logs);
}
lifecycleLogs.sort(logOrder);
if (!lifecycleLogs.length) throw new Error('No wallet Fables lifecycle events found');

const hookContracts = new Map();
const rangeInfo = new Map();
for (const log of lifecycleLogs) {
  const hook = String(log.address).toLowerCase();
  const rangeId = String(log.topics?.[2] || '').toLowerCase();
  if (!rangeId) continue;
  const rk = rangeMapKey(hook, rangeId);
  if (rangeInfo.has(rk)) continue;
  let contract = hookContracts.get(hook);
  if (!contract) {
    contract = new Contract(log.address, HOOK_ABI, readProvider);
    hookContracts.set(hook, contract);
  }
  const range = await contract.rangeKey(rangeId);
  if (!range.exists) continue;
  const pool = poolByFingerprint.get(poolKeyFingerprint(range.key));
  if (!pool) continue;
  rangeInfo.set(rk, {
    hook,
    rangeId,
    pool,
    tickLower: Number(range.tickLower),
    tickUpper: Number(range.tickUpper)
  });
}

const events = [];
for (const log of lifecycleLogs) {
  const hook = String(log.address).toLowerCase();
  const rangeId = String(log.topics?.[2] || '').toLowerCase();
  const info = rangeInfo.get(rangeMapKey(hook, rangeId));
  if (!info) continue;
  const kind = String(log.topics[0]).toLowerCase() === depositedTopic ? 'deposit' : 'withdraw';
  events.push({
    kind,
    blockNumber: Number(log.blockNumber),
    logIndex: Number(log.index || 0),
    txHash: String(log.transactionHash).toLowerCase(),
    hook,
    rangeId,
    liquidity: BigInt(log.data || 0),
    pool: info.pool,
    tickLower: info.tickLower,
    tickUpper: info.tickUpper
  });
}
events.sort(eventOrder);

const touchedPools = new Map();
for (const e of events) touchedPools.set(e.pool.id, e.pool);
for (const pool of touchedPools.values()) {
  [pool.token0, pool.token1] = await Promise.all([
    fables.getToken(pool.key.currency0),
    fables.getToken(pool.key.currency1)
  ]);
}

const managerByHook = new Map();
const swapsByPool = new Map();
for (const pool of touchedPools.values()) {
  const hookLower = pool.key.hooks.toLowerCase();
  let manager = managerByHook.get(hookLower);
  if (!manager) {
    const hook = new Contract(pool.key.hooks, HOOK_ABI, readProvider);
    manager = String(await hook.poolManager());
    managerByHook.set(hookLower, manager);
  }
  const logs = await fables.getLogsAdaptive({
    address: manager,
    topics: [swapTopic, pool.id]
  }, Math.max(0, fromBlock - preSwapBuffer), latestBlock);
  const points = logs.map((log) => {
    const parsed = swapIface.parseLog(log);
    return {
      blockNumber: Number(log.blockNumber),
      logIndex: Number(log.index || 0),
      txHash: String(log.transactionHash).toLowerCase(),
      sqrtPriceX96: BigInt(parsed.args.sqrtPriceX96),
      tick: Number(parsed.args.tick)
    };
  }).sort(pointOrder);
  swapsByPool.set(pool.id, points);
}

const txCache = new Map();
async function loadTx(hash) {
  hash = String(hash).toLowerCase();
  if (txCache.has(hash)) return txCache.get(hash);
  const [tx, receipt] = await Promise.all([
    readProvider.getTransaction(hash),
    readProvider.getTransactionReceipt(hash)
  ]);
  const row = { hash, tx, receipt, blockNumber: Number(receipt?.blockNumber || tx?.blockNumber || 0) };
  txCache.set(hash, row);
  return row;
}

const tokenMap = new Map();
for (const pool of touchedPools.values()) {
  tokenMap.set(pool.token0.address.toLowerCase(), pool.token0);
  tokenMap.set(pool.token1.address.toLowerCase(), pool.token1);
}
const transferTxHashes = new Set(events.map((e) => e.txHash));
for (const token of tokenMap.values()) {
  if (token.address.toLowerCase() === ZERO_ADDRESS) continue;
  const outgoing = await fables.getLogsAdaptive({
    address: token.address,
    topics: [transferTopic, walletTopic]
  }, events[0].blockNumber, latestBlock);
  const incoming = await fables.getLogsAdaptive({
    address: token.address,
    topics: [transferTopic, null, walletTopic]
  }, events[0].blockNumber, latestBlock);
  for (const log of [...outgoing, ...incoming]) transferTxHashes.add(String(log.transactionHash).toLowerCase());
}
await mapLimit([...transferTxHashes], 8, loadTx);

const activity = [...txCache.values()]
  .filter((row) => row.receipt)
  .map((row) => ({
    ...row,
    deltas: receiptDeltas(row.receipt),
    timestampMs: null
  }))
  .sort((a,b) => a.blockNumber - b.blockNumber || Number(a.receipt.index || 0) - Number(b.receipt.index || 0));

const blockTimeCache = new Map();
async function blockTime(blockNumber) {
  if (blockTimeCache.has(blockNumber)) return blockTimeCache.get(blockNumber);
  const b = await readProvider.getBlock(blockNumber);
  const ms = Number(b.timestamp) * 1000;
  blockTimeCache.set(blockNumber, ms);
  return ms;
}
await mapLimit([...new Set(activity.map((x) => x.blockNumber))], 12, async (b) => blockTime(b));
for (const row of activity) row.timestampMs = blockTimeCache.get(row.blockNumber);
for (const e of events) e.timestampMs = await blockTime(e.blockNumber);

const topology = replayTopology(events);
const finalTopology = await verifyFinalTopology(topology.rangeBalances);

const withdrawals = [];
for (let i = 0; i < events.length; i++) {
  const e = events[i];
  if (e.kind !== 'withdraw') continue;
  const row = await loadTx(e.txHash);
  const decoded = hookIface.parseTransaction({ data: row.tx.data, value: row.tx.value });
  if (!decoded || decoded.name !== 'withdrawAndClaim') {
    throw new Error('Unexpected withdraw selector for ' + e.txHash);
  }
  const args = decoded.args;
  const decodedPoolKey = {
    currency0: args[0].currency0,
    currency1: args[0].currency1,
    fee: Number(args[0].fee),
    tickSpacing: Number(args[0].tickSpacing),
    hooks: args[0].hooks
  };
  const abiValid = poolKeyFingerprint(decodedPoolKey) === poolKeyFingerprint(e.pool.key)
    && Number(args[1]) === e.tickLower
    && Number(args[2]) === e.tickUpper
    && BigInt(args[3]) === e.liquidity
    && String(args[4]).toLowerCase() === wallet
    && Number(args[8]) === config.fablesWalk;

  const prePrice = lastSwapBefore(swapsByPool.get(e.pool.id) || [], e.blockNumber, e.logIndex);
  const actualDelta = positiveOnly(receiptDeltasForPool(row.receipt, e.pool));
  let botWithdraw = null;
  if (prePrice) {
    botWithdraw = buildExactWithdrawBounds({
      sqrtPriceX96: prePrice.sqrtPriceX96,
      tickLower: e.tickLower,
      tickUpper: e.tickUpper,
      liquidity: e.liquidity,
      slippageBps: config.withdrawSlippageBps
    });
  }
  const realMin0 = BigInt(args[5]);
  const realMin1 = BigInt(args[6]);
  const botWouldPassActual = botWithdraw
    ? actualDelta.raw0 >= botWithdraw.amount0Min && actualDelta.raw1 >= botWithdraw.amount1Min
    : null;

  const nextDeposit = findNextSamePoolDeposit(events, i, lifecycleLookaheadMin);
  let handoff = null;
  if (nextDeposit) {
    const depRow = await loadTx(nextDeposit.txHash);
    const depDecoded = hookIface.parseTransaction({ data: depRow.tx.data, value: depRow.tx.value });
    const depositPool = nextDeposit.pool;
    const between = activity.filter((x) =>
      x.timestampMs >= e.timestampMs &&
      x.timestampMs <= nextDeposit.timestampMs
    );
    const beforeDepositActivity = between.filter((x) => x.hash !== nextDeposit.txHash);
    const operation = { raw0: 0n, raw1: 0n };
    for (const tx of beforeDepositActivity) {
      const d = deltasForPoolMap(tx.deltas, depositPool);
      operation.raw0 += d.raw0;
      operation.raw1 += d.raw1;
    }
    const depositSpend = negativeOnly(receiptDeltasForPool(depRow.receipt, depositPool));
    const preDepositPrice = lastSwapBefore(
      swapsByPool.get(depositPool.id) || [],
      nextDeposit.blockNumber,
      nextDeposit.logIndex
    );
    let botTarget = null;
    let exactDeposit = null;
    let exactDepositFeasible = null;
    if (preDepositPrice && operation.raw0 > 0n && operation.raw1 > 0n) {
      botTarget = buildCenteredRange(
        preDepositPrice.tick,
        depositPool.key.tickSpacing,
        config.tightWidthBps
      );
      try {
        exactDeposit = buildExactDepositPlan({
          rawAmount0: operation.raw0,
          rawAmount1: operation.raw1,
          sqrtPriceX96: preDepositPrice.sqrtPriceX96,
          tickLower: botTarget.tickLower,
          tickUpper: botTarget.tickUpper,
          slippageBps: config.depositSlippageBps,
          liquidityReserveBps: config.depositLiquidityReserveBps
        });
        exactDepositFeasible =
          exactDeposit.amount0Max <= operation.raw0 &&
          exactDeposit.amount1Max <= operation.raw1;
      } catch (error) {
        exactDeposit = { error: error.message };
        exactDepositFeasible = false;
      }
    }

    const actualRange = {
      tickLower: Number(depDecoded?.args?.[1] ?? nextDeposit.tickLower),
      tickUpper: Number(depDecoded?.args?.[2] ?? nextDeposit.tickUpper),
      liquidity: String(depDecoded?.args?.[3] ?? nextDeposit.liquidity)
    };
    const nonLifecycle = between
      .filter((tx) => tx.hash !== e.txHash && tx.hash !== nextDeposit.txHash)
      .filter((tx) => {
        const d = deltasForPoolMap(tx.deltas, depositPool);
        return d.raw0 !== 0n || d.raw1 !== 0n;
      })
      .map((tx) => {
        const d = deltasForPoolMap(tx.deltas, depositPool);
        return {
          hash: tx.hash,
          blockNumber: tx.blockNumber,
          raw0: d.raw0.toString(),
          raw1: d.raw1.toString()
        };
      });

    handoff = {
      depositHash: nextDeposit.txHash,
      minutesToDeposit: (nextDeposit.timestampMs - e.timestampMs) / 60000,
      actualRange,
      botTarget,
      targetMatchesActual:
        botTarget
        ? botTarget.tickLower === actualRange.tickLower && botTarget.tickUpper === actualRange.tickUpper
        : null,
      operationInventoryRaw: {
        raw0: operation.raw0.toString(),
        raw1: operation.raw1.toString()
      },
      actualDepositSpendRaw: {
        raw0: depositSpend.raw0.toString(),
        raw1: depositSpend.raw1.toString()
      },
      exactDeposit: serializeDeposit(exactDeposit),
      exactDepositStatus: exactDepositFeasible === true
        ? 'pass'
        : exactDepositFeasible === false
          ? 'fail'
          : 'needs-bot-swap',
      exactDepositFeasible,
      intermediateWalletTxs: nonLifecycle
    };
  }

  withdrawals.push({
    hash: e.txHash,
    blockNumber: e.blockNumber,
    pair: pairName(e.pool),
    rangeId: e.rangeId,
    range: [e.tickLower, e.tickUpper],
    liquidity: e.liquidity.toString(),
    abiValid,
    deadline: Number(args[7]),
    walk: Number(args[8]),
    realMin0: realMin0.toString(),
    realMin1: realMin1.toString(),
    actualWithdrawRaw0: actualDelta.raw0.toString(),
    actualWithdrawRaw1: actualDelta.raw1.toString(),
    preWithdrawTick: prePrice?.tick ?? null,
    botWithdraw: botWithdraw ? {
      expected0: botWithdraw.expected0.toString(),
      expected1: botWithdraw.expected1.toString(),
      amount0Min: botWithdraw.amount0Min.toString(),
      amount1Min: botWithdraw.amount1Min.toString()
    } : null,
    botWouldPassActual,
    handoff
  });
}

const failures = [];
for (const w of withdrawals) {
  if (!w.abiValid) failures.push({ hash:w.hash, reason:'withdraw ABI mismatch' });
  if (w.botWouldPassActual === false) failures.push({ hash:w.hash, reason:'bot 50bps withdraw min-out would reject actual historical output' });
  if (w.handoff?.exactDepositFeasible === false) failures.push({ hash:w.hash, reason:'exact deposit plan infeasible on reconstructed operation inventory' });
}
if (!finalTopology.ok) failures.push({ reason:'final replay topology mismatches on-chain ERC-6909 balances', detail: finalTopology });

const report = {
  generatedAt: new Date().toISOString(),
  wallet: config.walletAddress,
  blockWindow: { fromBlock, latestBlock },
  lifecycleEvents: events.length,
  deposits: events.filter((e)=>e.kind==='deposit').length,
  withdrawals: events.filter((e)=>e.kind==='withdraw').length,
  touchedPools: [...touchedPools.values()].map((p)=>({id:p.id,pair:pairName(p)})),
  topology: {
    replayActiveRanges: topology.activeRanges,
    finalVerification: finalTopology
  },
  withdrawReplay: withdrawals,
  summary: {
    withdrawCount: withdrawals.length,
    abiValidCount: withdrawals.filter((x)=>x.abiValid).length,
    withdrawBoundPassCount: withdrawals.filter((x)=>x.botWouldPassActual===true).length,
    withdrawBoundUnknownCount: withdrawals.filter((x)=>x.botWouldPassActual==null).length,
    samePoolHandoffs: withdrawals.filter((x)=>x.handoff).length,
    exactDepositFeasibleCount: withdrawals.filter((x)=>x.handoff?.exactDepositFeasible===true).length,
    targetMatchCount: withdrawals.filter((x)=>x.handoff?.targetMatchesActual===true).length,
    failures
  }
};

const dir=path.join(config.dataDir,'real-replay');
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'latest.json'),JSON.stringify(report,null,2));
fs.writeFileSync(path.join(dir,'latest.md'),renderMarkdown(report));
console.log(JSON.stringify(report.summary,null,2));
if (failures.some((x)=>/ABI mismatch|topology mismatches/.test(x.reason))) process.exitCode=2;

function receiptDeltas(receipt) {
  const map = {};
  for (const log of receipt?.logs || []) {
    if (String(log.topics?.[0] || '').toLowerCase() !== transferTopic) continue;
    const token = tokenMap.get(String(log.address).toLowerCase());
    if (!token || token.address.toLowerCase() === ZERO_ADDRESS) continue;
    const from = topicAddress(log.topics?.[1]);
    const to = topicAddress(log.topics?.[2]);
    const amount = BigInt(log.data || 0);
    const key = token.address.toLowerCase();
    if (!map[key]) map[key] = 0n;
    if (from === wallet) map[key] -= amount;
    if (to === wallet) map[key] += amount;
  }
  return map;
}
function receiptDeltasForPool(receipt,pool){ return deltasForPoolMap(receiptDeltas(receipt),pool); }
function deltasForPoolMap(map,pool){
  return {
    raw0: BigInt(map[pool.token0.address.toLowerCase()] || 0n),
    raw1: BigInt(map[pool.token1.address.toLowerCase()] || 0n)
  };
}
function positiveOnly(d){ return {raw0:d.raw0>0n?d.raw0:0n,raw1:d.raw1>0n?d.raw1:0n}; }
function negativeOnly(d){ return {raw0:d.raw0<0n?-d.raw0:0n,raw1:d.raw1<0n?-d.raw1:0n}; }

function replayTopology(events){
  const balances=new Map();
  for(const e of events){
    const key=rangeMapKey(e.hook,e.rangeId);
    const before=balances.get(key)||0n;
    const after=e.kind==='deposit'?before+e.liquidity:(e.liquidity>=before?0n:before-e.liquidity);
    balances.set(key,after);
  }
  const activeRanges=[...balances.entries()].filter(([,v])=>v>0n).map(([key,v])=>({key,shares:v.toString()})).sort((a,b)=>a.key.localeCompare(b.key));
  return {rangeBalances:balances,activeRanges};
}
async function verifyFinalTopology(rangeBalances){
  const mismatches=[];
  const active=[];
  for(const [key,replay] of rangeBalances){
    const [hook,rangeId]=key.split('|');
    const contract=new Contract(hook,HOOK_ABI,readProvider);
    const chain=BigInt(await contract.balanceOf(config.walletAddress,rangeId));
    if(chain!==replay) mismatches.push({key,replay:replay.toString(),chain:chain.toString()});
    if(chain>0n) active.push({key,shares:chain.toString()});
  }
  return {ok:mismatches.length===0,mismatches,activeRanges:active.sort((a,b)=>a.key.localeCompare(b.key))};
}
function findNextSamePoolDeposit(events,index,maxMinutes){
  const source=events[index];
  const maxMs=source.timestampMs+maxMinutes*60000;
  for(let i=index+1;i<events.length;i++){
    const e=events[i];
    if(e.timestampMs>maxMs) break;
    if(e.kind==='deposit'&&e.pool.id===source.pool.id) return e;
  }
  return null;
}
function lastSwapBefore(points,blockNumber,logIndex){
  let best=null;
  for(const p of points){
    if(p.blockNumber>blockNumber) break;
    if(p.blockNumber===blockNumber&&p.logIndex>=logIndex) break;
    best=p;
  }
  return best;
}
function topicAddress(v){
  const x=String(v||'').toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(x)?'0x'+x.slice(-40):null;
}
function rangeMapKey(hook,rangeId){return String(hook).toLowerCase()+'|'+String(rangeId).toLowerCase();}
function pairName(pool){return pool.token0.symbol+'/'+pool.token1.symbol;}
function logOrder(a,b){return Number(a.blockNumber)-Number(b.blockNumber)||Number(a.index||0)-Number(b.index||0);}
function eventOrder(a,b){return a.blockNumber-b.blockNumber||a.logIndex-b.logIndex;}
function pointOrder(a,b){return a.blockNumber-b.blockNumber||a.logIndex-b.logIndex;}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let cursor=0;
  async function worker(){while(true){const i=cursor++;if(i>=items.length)return;out[i]=await fn(items[i],i);}}
  await Promise.all(Array.from({length:Math.min(limit,Math.max(1,items.length))},()=>worker()));
  return out;
}
function serializeDeposit(x){
  if(!x)return null;
  if(x.error)return x;
  return {
    tickLower:x.tickLower,tickUpper:x.tickUpper,
    liquidity:x.liquidity.toString(),
    required0:x.required0.toString(),required1:x.required1.toString(),
    amount0Max:x.amount0Max.toString(),amount1Max:x.amount1Max.toString()
  };
}
function renderMarkdown(r){
  const lines=[
    '# Real Wallet Rebalance Replay',
    '',
    '- Wallet: `'+r.wallet+'`',
    '- Blocks: '+r.blockWindow.fromBlock+' → '+r.blockWindow.latestBlock,
    '- Lifecycle: '+r.lifecycleEvents+' ('+r.deposits+' deposits / '+r.withdrawals+' withdraws)',
    '- Pools: '+r.touchedPools.map(x=>x.pair).join(', '),
    '',
    '## Summary',
    '',
    '| Check | Result |',
    '|---|---:|',
    '| Withdraw ABI valid | '+r.summary.abiValidCount+' / '+r.summary.withdrawCount+' |',
    '| Bot 50bps min-out passes actual output | '+r.summary.withdrawBoundPassCount+' |',
    '| Historical price unavailable | '+r.summary.withdrawBoundUnknownCount+' |',
    '| Same-pool handoffs reconstructed | '+r.summary.samePoolHandoffs+' |',
    '| Exact deposit plans feasible | '+r.summary.exactDepositFeasibleCount+' |',
    '| Human next range == bot centered target | '+r.summary.targetMatchCount+' |',
    '| Topology replay matches current chain | '+(r.topology.finalVerification.ok?'YES':'NO')+' |',
    '',
    '## Withdraw / redeposit replay',
    '',
    '| Block | Pair | ABI | Tick | Actual out | Bot min | Next deposit | Exact plan | Target match |',
    '|---:|---|---|---:|---|---|---|---|---|'
  ];
  for(const w of r.withdrawReplay){
    const out=w.actualWithdrawRaw0+'/'+w.actualWithdrawRaw1;
    const min=w.botWithdraw?w.botWithdraw.amount0Min+'/'+w.botWithdraw.amount1Min:'N/A';
    const exact = !w.handoff ? 'N/A'
      : w.handoff.exactDepositStatus === 'pass' ? 'PASS'
      : w.handoff.exactDepositStatus === 'fail' ? 'FAIL'
      : 'NEEDS SWAP';
    lines.push('| '+w.blockNumber+' | '+w.pair+' | '+(w.abiValid?'PASS':'FAIL')+' | '+(w.preWithdrawTick??'N/A')+' | '+out+' | '+min+' | '+(w.handoff?.depositHash?'yes':'no')+' | '+exact+' | '+(w.handoff?.targetMatchesActual===true?'YES':w.handoff?.targetMatchesActual===false?'NO':'N/A')+' |');
  }
  if(r.summary.failures.length){
    lines.push('','## Findings','');
    for(const f of r.summary.failures) lines.push('- '+f.reason+(f.hash?' — `'+f.hash+'`':''));
  }
  return lines.join('\n');
}
