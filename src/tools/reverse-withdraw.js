import fs from 'node:fs';
import path from 'node:path';
import { AbiCoder, Contract, Interface, id, keccak256, zeroPadValue } from 'ethers';
import { getAmountsForLiquidity, getSqrtPriceAtTick } from '../math/v4-fixed.js';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';
import { HOOK_ABI, WITHDRAWN_EVENT } from '../abi.js';

function transactionHashes(argv) {
  const hashes = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--tx') {
      const value = argv[++index];
      if (!value) throw new Error('Missing value after --tx.');
      hashes.push(value);
    } else if (arg.startsWith('--tx=')) {
      hashes.push(arg.slice(5));
    } else {
      throw new Error('Use --tx=<transaction hash> for each transaction to inspect.');
    }
  }
  if (hashes.length === 0) throw new Error('Provide at least one --tx=<transaction hash>.');
  for (const hash of hashes) {
    if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Invalid transaction hash format.');
  }
  return [...new Set(hashes.map((hash) => hash.toLowerCase()))];
}

const hashes = transactionHashes(process.argv.slice(2));
loadDotEnv();
const config = loadConfig();
const { readProvider, rawProviders } = createProviders(config);
await verifyProviders(rawProviders, config.chainId);

const withdrawnTopic=id(WITHDRAWN_EVENT).toLowerCase();
const iface=new Interface(HOOK_ABI);
const stateViewIface = new Interface(['function getSlot0(bytes32) view returns(uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)']);
const poolManagerIface = new Interface(['function extsload(bytes32,uint256) view returns(bytes32[])']);
const stateView = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b';
const coder = AbiCoder.defaultAbiCoder();
const candidateSignatures = [
  'withdraw((address,address,uint24,int24,address),int24,int24,uint128,address,uint128,uint128,uint256,uint16)',
  'withdraw((address,address,uint24,int24,address),int24,int24,uint128,address,uint128,uint128,uint256,uint24)',
  'withdraw((address,address,uint24,int24,address),int24,int24,uint128,address,uint128,uint128,uint256,uint32)',
  'withdraw((address,address,uint24,int24,address),int24,int24,uint128,address,uint128,uint128,uint256,uint64)',
  'withdraw((address,address,uint24,int24,address),int24,int24,uint128,address,uint128,uint128,uint256,uint128)',
  'withdraw((address,address,uint24,int24,address),int24,int24,uint128,address,uint128,uint128,uint256,uint256)',
  'withdraw((address,address,uint24,int24,address),int24,int24,uint256,address,uint256,uint256,uint256,uint16)',
  'withdraw((address,address,uint24,int24,address),int24,int24,uint128,address,uint256,uint256,uint256,uint16)'
];
const candidateSelectors = Object.fromEntries(candidateSignatures.map((sig)=>[sig,id(sig).slice(0,10)]));
const rows=[];

for (const hash of hashes) {
  const [tx,receipt]=await Promise.all([
    readProvider.getTransaction(hash),
    readProvider.getTransactionReceipt(hash)
  ]);
  if(!tx||!receipt) throw new Error('transaction or receipt was not found.');
  const log=receipt.logs.find(x=>String(x.topics?.[0]||'').toLowerCase()===withdrawnTopic);
  if(!log) throw new Error('withdraw event was not found.');
  const rangeId=String(log.topics[2]).toLowerCase();
  const liquidity=BigInt(log.data);
  const hook=new Contract(tx.to,HOOK_ABI,readProvider);
  const range=await hook.rangeKey(rangeId);
  const block=await readProvider.getBlock(receipt.blockNumber);
  const body=tx.data.slice(10);
  const words=[];
  for(let i=0;i<body.length;i+=64){
    const hex='0x'+body.slice(i,i+64).padEnd(64,'0');
    const u=BigInt(hex);
    const signed=u >= (1n<<255n) ? u-(1n<<256n) : u;
    const low24=Number(u & 0xffffffn);
    const int24=low24 >= 0x800000 ? low24-0x1000000 : low24;
    const addr='0x'+hex.slice(-40);
    words.push({index:i/64,hex,uint:u.toString(),signed:signed.toString(),int24,address:addr});
  }
  const decoded = iface.decodeFunctionData('withdrawAndClaim', tx.data);
  let historical = null;
  try {
    const poolId = keccak256(coder.encode(
      ['tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'],
      [[range.key.currency0, range.key.currency1, range.key.fee, range.key.tickSpacing, range.key.hooks]]
    ));
    const historicalState = await readHistoricalPoolState(poolId, hook, receipt.blockNumber - 1);
    const amounts = getAmountsForLiquidity(
      historicalState.sqrtPriceX96,
      getSqrtPriceAtTick(Number(range.tickLower)),
      getSqrtPriceAtTick(Number(range.tickUpper)),
      liquidity,
      false
    );
    const realMin0 = BigInt(decoded[5]);
    const realMin1 = BigInt(decoded[6]);
    historical = {
      source: historicalState.source,
      sqrtPriceX96: historicalState.sqrtPriceX96.toString(),
      tick: historicalState.tick,
      expected0: amounts.amount0.toString(),
      expected1: amounts.amount1.toString(),
      realMin0: realMin0.toString(),
      realMin1: realMin1.toString(),
      inferredDiscountBps0: inferDiscountBps(amounts.amount0, realMin0),
      inferredDiscountBps1: inferDiscountBps(amounts.amount1, realMin1)
    };
  } catch (error) {
    historical = { error: error.message };
  }

  rows.push({
    hash,
    blockNumber:receipt.blockNumber,
    timestamp:Number(block.timestamp),
    from:tx.from,
    to:tx.to,
    selector:tx.data.slice(0,10),
    data:tx.data,
    calldataBytes:(tx.data.length-2)/2,
    value:tx.value.toString(),
    rangeId,
    eventLiquidity:liquidity.toString(),
    historical,
    range:{
      currency0:String(range.key.currency0),
      currency1:String(range.key.currency1),
      fee:Number(range.key.fee),
      tickSpacing:Number(range.key.tickSpacing),
      hooks:String(range.key.hooks),
      tickLower:Number(range.tickLower),
      tickUpper:Number(range.tickUpper),
      exists:Boolean(range.exists)
    },
    words
  });
}

let openchainLookup = null;
try {
  const response = await fetch('https://api.openchain.xyz/signature-database/v1/lookup?function=0x289a2a15', {
    headers: { accept: 'application/json', 'user-agent': 'auto-LP-bot-withdraw-reverse/0.3.4' }
  });
  openchainLookup = response.ok ? await response.json() : { httpStatus: response.status };
} catch (error) {
  openchainLookup = { error: error.message };
}

const summary={
  selectors:[...new Set(rows.map(x=>x.selector))],
  openchainLookup,
  candidateSelectors,
  selectorMatches:Object.entries(candidateSelectors).filter(([,selector])=>rows.some(x=>x.selector===selector)).map(([signature,selector])=>({signature,selector})),
  calldataBytes:[...new Set(rows.map(x=>x.calldataBytes))],
  wordCount:[...new Set(rows.map(x=>x.words.length))],
  rows
};
const dir=path.join(config.dataDir,'withdraw-reverse');
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'fixtures.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({
  selectors:summary.selectors,
  openchainLookup:summary.openchainLookup,
  selectorMatches:summary.selectorMatches,
  candidateSelectors:summary.candidateSelectors,
  calldataBytes:summary.calldataBytes,
  wordCount:summary.wordCount,
  sample:rows.slice(0,3)
},null,2));

function inferDiscountBps(expected, minimum) {
  expected = BigInt(expected);
  minimum = BigInt(minimum);
  if (expected <= 0n) return null;
  return Number((expected - minimum) * 10000n / expected);
}

async function readHistoricalPoolState(poolId, hook, blockNumber) {
  const tag = '0x' + Math.max(0, Number(blockNumber)).toString(16);
  try {
    const data = stateViewIface.encodeFunctionData('getSlot0', [poolId]);
    const raw = await readProvider.send('eth_call', [{ to: stateView, data }, tag]);
    const [sqrtPriceX96, tick] = stateViewIface.decodeFunctionResult('getSlot0', raw);
    return { source: 'StateView', sqrtPriceX96: BigInt(sqrtPriceX96), tick: Number(tick) };
  } catch {}

  const managerAddress = await hook.poolManager();
  const poolsSlot = 6n;
  const storageSlot = keccak256(coder.encode(['bytes32', 'uint256'], [poolId, poolsSlot]));
  const data = poolManagerIface.encodeFunctionData('extsload', [storageSlot, 4]);
  const raw = await readProvider.send('eth_call', [{ to: managerAddress, data }, tag]);
  const [words] = poolManagerIface.decodeFunctionResult('extsload', raw);
  const packed = BigInt(words[0]);
  const sqrtPriceX96 = packed & ((1n << 160n) - 1n);
  let tick = Number((packed >> 160n) & 0xffffffn);
  if (tick >= 2 ** 23) tick -= 2 ** 24;
  return { source: 'PoolManager.extsload', sqrtPriceX96, tick };
}
