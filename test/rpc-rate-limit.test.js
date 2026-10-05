import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { FetchRequest } from 'ethers';
import { RateLimitedJsonRpcProvider, endpointGate } from '../src/rpc/rate-limited-provider.js';

async function server(handler, fn) {
  const app=http.createServer(async (req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;handler(JSON.parse(raw),res);});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try{await fn(`http://127.0.0.1:${app.address().port}`);}finally{await new Promise(resolve=>app.close(resolve));}
}
const make=(url,gate)=>{const r=new FetchRequest(url);r.retryFunc=async()=>false;
  return new RateLimitedJsonRpcProvider(r,{chainId:4663,name:'robinhood'},{staticNetwork:true},gate);};

test('RPC retries rate limited reads at most twice, including JSON-RPC 429',async()=>{
  let count=0;
  await server((r,res)=>{count++;res.end(JSON.stringify({jsonrpc:'2.0',id:r.id,
    ...(count<3?{error:{code:429,message:'Too Many Requests'}}:{result:'0x2a'})}));},async url=>{
    const p=make(url,endpointGate(url,{spacingMs:1,retryDelayMs:1}));
    try{assert.equal(await p.send('eth_blockNumber',[]),'0x2a');assert.equal(count,3);}finally{p.destroy();}
  });
});
test('RPC never retries signed broadcast after HTTP 429',async()=>{
  let count=0;
  await server((_r,res)=>{count++;res.writeHead(429);res.end('Too Many Requests');},async url=>{
    const p=make(url,endpointGate(url,{spacingMs:1,retryDelayMs:1}));
    try{await assert.rejects(p.send('eth_sendRawTransaction',['0x1234']));assert.equal(count,1);}finally{p.destroy();}
  });
});
test('RPC retries HTTP 429 reads but does not retry exhausted-credit responses',async()=>{
 let count=0,exhausted=false;
 await server((r,res)=>{count++;if(exhausted||count===1){res.writeHead(429);res.end(exhausted?'API credits exhausted':'Too Many Requests');}
 else res.end(JSON.stringify({jsonrpc:'2.0',id:r.id,result:'0x2a'}));},async url=>{
  const p=make(url,endpointGate(url,{spacingMs:1,retryDelayMs:1}));
  try{assert.equal(await p.send('eth_blockNumber',[]),'0x2a');assert.equal(count,2);
   exhausted=true;await assert.rejects(p.send('eth_blockNumber',[]));assert.equal(count,3);}finally{p.destroy();}
 });
});
test('RPC read retry is finite when endpoint remains rate limited',async()=>{
  let count=0;
  await server((r,res)=>{count++;res.end(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32005,message:'rate limit'}}));},async url=>{
    const p=make(url,endpointGate(url,{spacingMs:1,retryDelayMs:1}));
    try{await assert.rejects(p.send('eth_call',[{},'latest']));assert.equal(count,3);}finally{p.destroy();}
  });
});
test('wallets sharing endpoint share admission pacing and concurrency',async()=>{
  const gate=endpointGate('shared-test',{spacingMs:20,retryDelayMs:1});
  assert.equal(endpointGate('shared-test'),gate);
  const starts=[];let active=0,max=0;
  await Promise.all(Array.from({length:5},()=>gate.run(async()=>{starts.push(Date.now());active++;max=Math.max(active,max);
    await new Promise(r=>setTimeout(r,35));active--;})));
  assert.ok(max<=2);for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=18);
});
