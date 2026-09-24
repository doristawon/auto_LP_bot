import fs from 'node:fs';
import path from 'node:path';
import { Contract, Interface, id, zeroPadValue } from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';
import { HOOK_ABI, WITHDRAWN_EVENT } from '../abi.js';

loadDotEnv();
const config = loadConfig();
const { readProvider, rawProviders } = createProviders(config);
await verifyProviders(rawProviders, config.chainId);

const hashes = [
'0x1af2774f8c98a1700fa8ac52c45b336ed49baac4b3dbbee91230713a4387702b',
'0xc668f2cbb41a0e6d459795114153d5405f131529d4c9983bc7288a1f0f8c1a79',
'0xe0b934f700752336414bd3176153ff1aabddb2000a368de8b0b14383315ddc6d',
'0x5a0590acaabccc444303df844d8826b9ed467ac398f63cb5ab6153fa3fcc0038',
'0x096e99a317389cb485bd3a646a7a3b7bd546895a7da0395b571123865a91cd4c',
'0x7ce57b92a8c73547a5e2e7eea82ea01ec67bc269899faaf5eee7f0f51ca50c48',
'0x2ba6dc189c53c81029d34b2b958858149fa8fd21ac2a097837a174736806c88f',
'0xc5a7d54ee1bd0d22715646c12a89bc8fea61a699320ec2d69dbdfe18cad134d2',
'0x9fb1319a6f82c003a4f4d796b752ff980482b9ee43ab39d6acc4902ee0071299',
'0xa03ead3a217c8eeed74a69a0d845dae6816c21afad7a1b3d6cc05bdbd0597189',
'0xea2682a0603435e58a2d65425ad946ec91cc43572bcf49234696543275d641f9',
'0x398098be5f836a18b72b856294b95c69c3e355ae0cf80260c2edcf54b894cb6c',
'0x357f7f0bfce8dc7aaf8a9f9e01b1ffcf112789c25a18e0b0aa97b6313e94df0f',
'0x3fbe5115ee85fb26c4f550de43717e7c73b7ed1ebe1d190df41ca232b8d9c066',
'0x8218f7225fef34a711db21d75f8d1ace9066207ab36dac2afd5eff0540580d51',
'0x23003b7955296ed45de85931f1c85bfcca0315c986938ef26c623779dc6b49cc',
'0x3a91a366564e6bf45cfa9ee58dc2617afb7523d866f05c794a056987c529aa71',
'0xe23c9eae086f824de4975002d200b8ecb970ec431e9c2e4702f65c29f0a06e77'
];

const withdrawnTopic=id(WITHDRAWN_EVENT).toLowerCase();
const iface=new Interface(HOOK_ABI);
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
  if(!tx||!receipt) throw new Error('missing tx '+hash);
  const log=receipt.logs.find(x=>String(x.topics?.[0]||'').toLowerCase()===withdrawnTopic);
  if(!log) throw new Error('withdraw event missing '+hash);
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
  rows.push({
    hash,
    blockNumber:receipt.blockNumber,
    timestamp:Number(block.timestamp),
    from:tx.from,
    to:tx.to,
    selector:tx.data.slice(0,10),
    calldataBytes:(tx.data.length-2)/2,
    value:tx.value.toString(),
    rangeId,
    eventLiquidity:liquidity.toString(),
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
