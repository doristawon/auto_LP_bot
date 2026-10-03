import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, keccak256 } from 'ethers';
import { claimRetiredRangeFees, sweepRetiredFees } from '../src/execution/retired-fee-claims.js';
import { LENS_ABI } from '../src/analytics/points-evidence.js';
import { HOOK_ABI } from '../src/abi.js';
import { describeExecutionProgress } from '../src/dashboard/execution-progress.js';

const wallet = '0x00000000000000000000000000000000000000aa';
const hook = '0x0000000000000000000000000000000000000011';
const token0 = '0x0000000000000000000000000000000000000022';
const token1 = '0x0000000000000000000000000000000000000033';
const key = { currency0: token0, currency1: token1, fee: 8388608, tickSpacing: 60, hooks: hook };
const coder = AbiCoder.defaultAbiCoder();
const poolId = keccak256(coder.encode(['(address,address,uint24,int24,address)'], [[token0, token1, key.fee, 60, hook]]));
const rangeId = keccak256(coder.encode(['bytes32','int24','int24'], [poolId, -120, 120]));
const pool = { id: poolId, key, token0: {address:token0,decimals:6,symbol:'A'}, token1:{address:token1,decimals:6,symbol:'B'} };
const lens = new Interface(LENS_ABI), hookInterface = new Interface(HOOK_ABI);
const transfer = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const hash = `0x${'ab'.repeat(32)}`;

function fixture({ sendError = null, receiptMismatch = false } = {}) {
  const saved = new Map(), events = [];
  let sends = 0;
  const f = {
    config: { enableLiveWrites:true,dryRun:false,walletAddress:wallet,fablesWalk:1000,topUpMinGasReserveWei:1n },
    state: { getSetting:(k,d)=>saved.has(k)?saved.get(k):d, setSetting:(k,v)=>saved.set(k,v) },
    ledger: { append:(type,data)=>events.push({type,...data}) },
    runWalletWrite: fn=>fn(), assertLiveReady:async()=>{}, assertTopUpGasBudget:async()=>{},
    getPinnedFeeOverrides:async()=>({gasPrice:1n}), getUsdPrice:()=>2000,
    writeProvider: { getTransactionCount:async()=>1 }, signer:{estimateGas:async()=>100000n},
    readProvider: { call:async(tx)=>{
      if (tx.to.toLowerCase() === hook.toLowerCase()) {
        const name = hookInterface.parseTransaction(tx).name;
        if(name==='balanceOf') return hookInterface.encodeFunctionResult(name,[0n]);
        if(name==='userPosition') return hookInterface.encodeFunctionResult(name,[[0n,receiptMismatch?1n:0n,0n,0n,0n,0n,0n,0n,0n]]);
        throw new Error('unexpected hook read');
      }
      const row=[BigInt(rangeId),true,[token0,token1,key.fee,60,hook],-120,120,0n,0n,1000000n,2000000n,
        0n,0n,0,false,false,1n,0,true,0,0,1n,1n,0n,0n];
      return lens.encodeFunctionResult('userRanges',[[row],[1n,1n,1n,true]]);
    } },
    saveJournal:j=>saved.set('activeRebalanceExecution',j),
    patchJournal:(j,p)=>{const next={...j,...p,lastKnownPhase:j.phase,updatedAt:Date.now()};saved.set('activeRebalanceExecution',next);return next;},
    clearJournal:()=>saved.set('activeRebalanceExecution',null),
    sendVerifiedTx:async({to,data,onSent})=>{
      sends++;
      const call=hookInterface.parseTransaction({data});
      assert.equal(to,hook); assert.equal(call.name,'claimFees'); assert.equal(call.args.recipient.toLowerCase(),wallet);
      onSent(hash); if(sendError) throw Object.assign(new Error('private RPC error'),{code:sendError});
      return {hash,status:1,blockNumber:2,logs:[0,1].map(i=>({address:i?token1:token0,
        ...transfer.encodeEventLog(transfer.getEvent('Transfer'),['0x0000000000000000000000000000000000000099',wallet,BigInt(i+1)*1000000n])}))};
    }
  };
  return {f,saved,events,sends:()=>sends};
}

test('claims old fees only, records receipt amounts, and never double counts fee accrual or cashflows',async()=>{
  const x=fixture();
  const result=await claimRetiredRangeFees.call(x.f,{pool,range:{rangeId}});
  assert.equal(result.status,'completed');assert.equal(x.sends(),1);
  assert.equal(result.amount0,1);assert.equal(result.amount1,2);
  assert.deepEqual(x.events.map(e=>e.type),['fee.claimed']);
  assert.equal(x.saved.get('activeRebalanceExecution'),null);
});

test('paused, stop-loss, recovery and pending nonce do not send a claim',async()=>{
  for(const [key,value] of [['executionPaused',true],['stopLossLatched',true],['activeRebalanceExecution',{phase:'recovery_required'}]]){
    const x=fixture();x.saved.set(key,value);
    assert.equal((await claimRetiredRangeFees.call(x.f,{pool,range:{rangeId}})).status,'blocked');assert.equal(x.sends(),0);
  }
  const x=fixture();x.f.writeProvider.getTransactionCount=async(_w,tag)=>tag==='pending'?2:1;
  assert.equal((await claimRetiredRangeFees.call(x.f,{pool,range:{rangeId}})).reason,'pending-transaction');
});

test('unknown send and receipt mismatch preserve recovery journal and forbid a second send',async()=>{
  for(const options of [{sendError:'BROADCAST_OUTCOME_UNCERTAIN'},{receiptMismatch:true}]){
    const x=fixture(options);
    await assert.rejects(claimRetiredRangeFees.call(x.f,{pool,range:{rangeId}}));
    assert.equal(x.saved.get('activeRebalanceExecution').phase,'recovery_required');
    assert.equal(x.saved.get('activeRebalanceExecution').tx.claim,hash);
    await claimRetiredRangeFees.call(x.f,{pool,range:{rangeId}});assert.equal(x.sends(),1);
  }
});

test('confirmed revert clears failed claim; pause during preparation prevents sending',async()=>{
  const x=fixture({sendError:'TRANSACTION_REVERTED'});
  await assert.rejects(claimRetiredRangeFees.call(x.f,{pool,range:{rangeId}}));
  assert.equal(x.saved.get('activeRebalanceExecution'),null);
  const y=fixture();y.f.signer.estimateGas=async()=>{y.saved.set('executionPaused',true);return 100n;};
  assert.equal((await claimRetiredRangeFees.call(y.f,{pool,range:{rangeId}})).status,'blocked');assert.equal(y.sends(),0);
});

test('fee sweep in paused/recovery state never contacts the indexer',async()=>{
  const x=fixture();x.f.executionPaused=true;
  await sweepRetiredFees.call(x.f,[pool],{force:true});assert.equal(x.sends(),0);
  x.f.executionPaused=false;x.saved.set('activeRebalanceExecution',{phase:'recovery_required'});
  await sweepRetiredFees.call(x.f,[pool],{force:true});assert.equal(x.sends(),0);
});

test('tiny fees cannot pay disproportionate gas costs',async()=>{
  const x=fixture();x.f.getPinnedFeeOverrides=async()=>({gasPrice:1000000000000000n});
  const result=await claimRetiredRangeFees.call(x.f,{pool,range:{rangeId}});
  assert.equal(result.status,'deferred');assert.equal(result.reason,'fees-below-gas-cost');assert.equal(x.sends(),0);
});

test('fee claim progress shows only preflight, claim and verification',()=>{
  const p=describeExecutionProgress({id:'fee1',kind:'fee_claim',phase:'claim_sent',tx:{claim:hash}});
  assert.equal(p.label,'自動領取手續費');assert.deepEqual(p.steps.map(s=>s.key),['preflight','claim','verify']);
  assert.equal(p.transactions[0].status,'pending');
});
