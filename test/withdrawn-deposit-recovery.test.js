import test from 'node:test';
import assert from 'node:assert/strict';
import { id, zeroPadValue, toBeHex } from 'ethers';
import { WITHDRAWN_EVENT } from '../src/abi.js';
import { verifyWithdrawnInventory, resumeWithdrawnDeposit } from '../src/execution/withdrawn-deposit-recovery.js';
const wallet='0x'+'11'.repeat(20),hook='0x'+'22'.repeat(20),pool={id:'0x'+'33'.repeat(32),key:{hooks:hook}};
const hash='0x'+'44'.repeat(32),range='0x'+'55'.repeat(32);
function harness(){
  const journal={id:'one',startedAt:1,phase:'recovery_required',poolId:pool.id,oldPosition:{id:range,tickLower:-100,tickUpper:100},
    tx:{withdraw:hash},postWithdrawBalancesRaw:{raw0:'100',raw1:'80'}};
  const e={config:{walletAddress:wallet},state:{getSetting:()=>journal},isAllocationModeEnabled:()=>false,
    ledger:{all:()=>[{ts:2,type:'tx.broadcast_pending',hash,label:'guardedWithdrawAndClaim'},{ts:3,type:'tx.confirmed',hash}]},
    writeProvider:{getTransactionCount:async()=>4},readProvider:{getTransactionReceipt:async()=>({hash,status:1,from:wallet,blockNumber:10,
      logs:[{address:hook,topics:[id(WITHDRAWN_EVENT),zeroPadValue(wallet,32),zeroPadValue(toBeHex(BigInt(range)),32)]}]})},
    fables:{readRangeKey:async()=>({exists:true,key:pool.key,tickLower:-100,tickUpper:100})},
    readPositionShares:async()=>0n,readRawPairBalances:async()=>({raw0:100n,raw1:80n})};
  return {e,journal};
}
test('withdrawn deposit recovery proves receipt, empty shares and exact inventory without clearing journal',async()=>{
 const {e,journal}=harness();const r=await verifyWithdrawnInventory(e,pool);assert.equal(r.journal,journal);assert.equal(r.proof.nonce,4);assert.equal(journal.phase,'recovery_required');
});
test('withdrawn deposit recovery rejects pending nonce and changed inventory',async()=>{
 const {e}=harness();e.writeProvider.getTransactionCount=async(_w,tag)=>tag==='pending'?5:4;await assert.rejects(verifyWithdrawnInventory(e,pool));
 e.writeProvider.getTransactionCount=async()=>4;e.readRawPairBalances=async()=>({raw0:101n,raw1:80n});await assert.rejects(verifyWithdrawnInventory(e,pool));
});
test('withdrawn deposit recovery rejects later capital and unknown broadcast',async()=>{
 const {e,journal}=harness();journal.tx.atomicSwapDeposit=hash;await assert.rejects(verifyWithdrawnInventory(e,pool));
 delete journal.tx.atomicSwapDeposit;e.ledger.all=()=>[{ts:2,type:'tx.broadcast_uncertain',hash}];await assert.rejects(verifyWithdrawnInventory(e,pool));
});
test('withdrawn deposit recovery rejects wallet, hook and range receipt mismatch',async()=>{
 const {e}=harness();const original=e.readProvider.getTransactionReceipt;for(const field of ['from','hash']){
 e.readProvider.getTransactionReceipt=async()=>({...await original(),[field]:'0x'+'66'.repeat(field==='from'?20:32)});await assert.rejects(verifyWithdrawnInventory(e,pool));}
 e.readProvider.getTransactionReceipt=async()=>({...await original(),logs:[]});await assert.rejects(verifyWithdrawnInventory(e,pool));
});
test('live recovery refuses paused, changed target or latched stop loss before RPC or signing',async()=>{
 const settings=new Map([['executionPaused',false],['investmentTargetMode','specific-pool'],['investmentTargetPoolId',pool.id]]);
 const e={signer:{address:wallet},config:{walletAddress:wallet,enableLiveWrites:true,dryRun:false,atomicDepositEnabled:true},state:{getSetting:(k,d)=>settings.get(k)??d}};
 settings.set('executionPaused',true);await assert.rejects(resumeWithdrawnDeposit(e,pool),/Explicit live execution/);
 settings.set('executionPaused',false);settings.set('investmentTargetPoolId','other');await assert.rejects(resumeWithdrawnDeposit(e,pool),/saved investment target/);
 settings.set('investmentTargetPoolId',pool.id);settings.set('stopLossLatched',true);await assert.rejects(resumeWithdrawnDeposit(e,pool),/Stop loss is latched/);
});
test('withdrawn deposit recovery refuses wrong PoolKey or original range bounds',async()=>{
 const {e}=harness();e.fables.readRangeKey=async()=>({exists:true,key:{...pool.key,hooks:wallet},tickLower:-100,tickUpper:100});await assert.rejects(verifyWithdrawnInventory(e,pool));
 e.fables.readRangeKey=async()=>({exists:true,key:pool.key,tickLower:-90,tickUpper:100});await assert.rejects(verifyWithdrawnInventory(e,pool));
});
test('live recovery refuses stop-loss breach or stale valuation before RPC',async()=>{
 const settings=new Map([['executionPaused',false],['investmentTargetMode','specific-pool'],['investmentTargetPoolId',pool.id],
  ['stopLossSettings',{enabled:true,lossPct:15,basisMode:'lp-session'}],
  ['stopLossReference',{basisMode:'lp-session',at:Date.now()-1000,equityUsd:100}]]);
 const e={signer:{address:wallet},config:{walletAddress:wallet,enableLiveWrites:true,dryRun:false,atomicDepositEnabled:true},
  state:{getSetting:(k,d)=>settings.get(k)??d},ledger:{readSnapshot:()=>({generatedAt:Date.now(),portfolio:{currentValueUsd:80}})}};
 await assert.rejects(resumeWithdrawnDeposit(e,pool),/stop-loss valuation/);
 e.ledger.readSnapshot=()=>({generatedAt:Date.now()-3600000,portfolio:{currentValueUsd:100}});
 await assert.rejects(resumeWithdrawnDeposit(e,pool),/stop-loss valuation/);
});
