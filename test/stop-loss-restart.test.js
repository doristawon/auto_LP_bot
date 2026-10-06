import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoLpBot } from '../src/bot.js';
import { DashboardServer } from '../src/dashboard/server.js';
import { RebalanceExecutor } from '../src/adapters/executor.js';
import { Interface } from 'ethers';
import { ERC20_ABI, PERMIT2_ABI } from '../src/abi.js';
import { PERMIT2 } from '../src/constants.js';
const wallet='0x0000000000000000000000000000000000000001',poolId='0x'+'ab'.repeat(32);
function harness(active=true){
 const values=new Map([['executionPaused',true],['stopLossLatched',true],['stopLossSettings',{enabled:true,lossPct:15,basisMode:'lp-session'}],['stopLossReference',{equityUsd:1500,at:Date.now()-10000,basisMode:'lp-session',wallet}],['activeRebalanceExecution',{kind:'stop_liquidation',phase:'failed'}],['stopLossIncident',{source:'auto-stop-loss',lossPct:16,at:Date.now()}]]),events=[],calls=[];
 const b=Object.create(AutoLpBot.prototype);b.config={walletAddress:wallet,dashboardManualControlEnabled:true,dryRun:false,enableLiveWrites:true,enableAutoRedeploy:true,pollIntervalMs:300000};b.state={getSetting:(k,d)=>values.has(k)?values.get(k):d,setSetting:(k,v)=>values.set(k,v)};b.ledger={append:(type,data)=>events.push({type,...data})};b.executor={hasPendingWrite:false};b.executionPaused=true;
 b.snapshot={generatedAt:Date.now(),bot:{wallet},portfolio:{currentValueUsd:1000,netCashflowUsd:0,positions:active?[{id:'position',poolId,shares:'100',principalUsd:900}]:[]}};
 b.getInvestmentTargetSettings=()=>({mode:'specific-pool',poolId});b.getInvestmentAllocationConfig=()=>({enabled:false});b.controlStatus=async()=>({startReadiness:{blockers:values.get('stopLossLatched')?['stop-loss-latched']:[]}});
 b.runOnce=async o=>{calls.push(o.source);b.snapshot.generatedAt=Date.now();return b.snapshot};b.startExecution=async()=>{calls.push('start');b.setExecutionPaused(false,'test');return{ok:true}};
 b.manualImmediateRotation=async o=>{calls.push(o);b.snapshot.portfolio.positions=[{id:'new',poolId,shares:'100',principalUsd:900}];b.capturePendingLpStopLossReference(b.snapshot);return{status:'completed'}};
 return{b,values,calls,events};
}
test('stop-loss reset restarts existing LP only after explicit request and keeps saved threshold',async()=>{
 const{b,values,calls}=harness();assert.throws(()=>b.requestStopLossRestart({}),/確認/);assert.equal(values.get('stopLossLatched'),true);
 b.requestStopLossRestart({confirm:'RESET_AND_RESTART'});await b.stopLossRestartPromise;
 assert.deepEqual(calls,['stop-loss-restart-scan','start']);assert.equal(values.get('stopLossLatched'),false);assert.equal(b.executionPaused,false);assert.equal(values.get('stopLossSettings').lossPct,15);assert.equal(values.get('stopLossReference').equityUsd,1000);assert.ok(values.get('stopLossIncident').resetAt);assert.equal(values.get('stopLossRestartStatus').status,'completed');
});
test('reset with no LP uses guarded direct idle deposit before starting',async()=>{
 const{b,values,calls}=harness(false);b.requestStopLossRestart({confirm:'RESET_AND_RESTART'});await b.stopLossRestartPromise;
 assert.equal(calls[1].destinationPoolId,poolId);assert.equal(calls[1].directExecute,true);assert.equal(calls[2],'stop-loss-restart-readback');assert.equal(calls[3],'start');assert.equal(values.get('stopLossRestartStatus').status,'completed');assert.equal(values.get('stopLossReference').pending,undefined);
});
test('failed reentry pauses and reports failure instead of claiming restart',async()=>{
 const{b,values}=harness(false);b.manualImmediateRotation=async()=>{throw new Error('simulation failed')};b.requestStopLossRestart({confirm:'RESET_AND_RESTART'});await b.stopLossRestartPromise;
 assert.equal(b.executionPaused,true);assert.equal(values.get('stopLossRestartStatus').status,'failed');assert.match(values.get('stopLossRestartStatus').error,/simulation failed/);
});
test('manual reset request coalesces and can be cancelled while waiting for a readonly scan',async()=>{
 const{b,values,calls}=harness();b.cycleActive=true;b.requestStopLossRestart({confirm:'RESET_AND_RESTART'});const promise=b.stopLossRestartPromise;b.requestStopLossRestart({confirm:'RESET_AND_RESTART'});assert.equal(b.stopLossRestartPromise,promise);b.stopLossRestartCancelled=true;await promise;
 assert.equal(values.get('stopLossLatched'),true);assert.deepEqual(calls,[]);assert.equal(values.get('stopLossRestartStatus').status,'failed');
});
test('unconfirmed transactions and failed readiness cannot reset baseline',async()=>{
 const{b,values}=harness();values.set('activeRebalanceExecution',{phase:'recovery_required'});assert.throws(()=>b.requestStopLossRestart({confirm:'RESET_AND_RESTART'}),/待確認/);
 values.set('activeRebalanceExecution',{phase:'failed'});b.controlStatus=async()=>({startReadiness:{blockers:['stop-loss-latched','guard-not-ready']}});b.requestStopLossRestart({confirm:'RESET_AND_RESTART'});await b.stopLossRestartPromise;assert.equal(values.get('stopLossLatched'),true);assert.equal(values.get('stopLossReference').equityUsd,1500);
});
test('restart interruption never restores automatic execution intent',()=>{
 const{b,values}=harness();values.set('executionPaused',false);values.set('stopLossRestartStatus',{status:'depositing'});assert.equal(b.reconcileStopLossRestartOnBoot(),true);assert.equal(values.get('executionPaused'),true);assert.equal(values.get('stopLossRestartStatus').status,'failed');
});
test('legacy triggered incident is recovered from ledger once and never overwritten by latest equity',()=>{
 const{b,values}=harness();values.delete('stopLossIncident');let reads=0;b.ledger.list=()=>{reads++;return[{ts:123,lossPct:16,settings:{lossPct:15},principalUsd:1000,equityUsd:840}]};assert.equal(b.getStopLossSnapshot().incident.lossPct,16);b.snapshot.portfolio.currentValueUsd=900;assert.equal(b.getStopLossSnapshot().incident.equityUsd,840);assert.equal(reads,1);
});
function approvalHarness(){
 const values=new Map([['executionPaused',true],['stopLossLatched',true],['activeRebalanceExecution',{id:'exit-1',kind:'stop_liquidation',phase:'stop_confirmed'}]]);
 const ex=Object.create(RebalanceExecutor.prototype);ex.state={getSetting:(k,d)=>values.has(k)?values.get(k):d};ex.config={walletAddress:wallet};const erc=new Interface(ERC20_ABI),permit=new Interface(PERMIT2_ABI);
 ex.readProvider={call:async req=>req.to.toLowerCase()===PERMIT2.toLowerCase()?permit.encodeFunctionResult('allowance',[100n,Math.floor(Date.now()/1000)+3600,0]):erc.encodeFunctionResult('allowance',[100n])};return{ex,values};
}
test('restart API requires confirmation and same origin and targets only the selected worker',async()=>{
 const{b,values}=harness();let selected=0;
 const server=new DashboardServer({dashboardEnabled:true,dashboardHost:'127.0.0.1',dashboardPort:0},b,b.ledger,{},
  {getBot:address=>{assert.equal(address,wallet);selected++;return b}});
 await server.start();const base='http://127.0.0.1:'+server.server.address().port;
 const headers={Origin:base,'Content-Type':'application/json','X-Wallet-Address':wallet};
 try{
  const foreign=await fetch(base+'/api/risk/stop-loss/restart',{method:'POST',headers:{...headers,Origin:'https://other.invalid'},body:JSON.stringify({confirm:'RESET_AND_RESTART'})});assert.equal(foreign.status,403);assert.equal(values.get('stopLossLatched'),true);
  const missing=await fetch(base+'/api/risk/stop-loss/restart',{method:'POST',headers,body:'{}'});assert.equal(missing.status,409);
  const response=await fetch(base+'/api/risk/stop-loss/restart',{method:'POST',headers,body:JSON.stringify({confirm:'RESET_AND_RESTART'})});assert.equal(response.status,202);await b.stopLossRestartPromise;assert.equal(values.get('stopLossRestartStatus').status,'completed');assert.ok(selected>0);
 }finally{await server.stop()}
});
test('paused swaps remain blocked; only the matching active latched exit can read/reuse exact allowances',async()=>{
 const{ex,values}=approvalHarness(),token={address:'0x0000000000000000000000000000000000000002'};
 await assert.rejects(ex.ensureSwapAllowances(token,100n),/paused/);await assert.rejects(ex.ensureSwapAllowances(token,100n,{stopLiquidationId:'other'}),/paused/);
 await ex.ensureSwapAllowances(token,100n,{stopLiquidationId:'exit-1'});
 values.set('stopLossLatched',false);await assert.rejects(ex.ensureSwapAllowances(token,100n,{stopLiquidationId:'exit-1'}),/paused/);
 values.set('stopLossLatched',true);values.get('activeRebalanceExecution').phase='completed';await assert.rejects(ex.ensureSwapAllowances(token,100n,{stopLiquidationId:'exit-1'}),/paused/);
});

test('stop-loss approval scope is rechecked immediately before each broadcast',async()=>{
 const{ex,values}=approvalHarness(),token={address:'0x0000000000000000000000000000000000000002'};
 const erc=new Interface(ERC20_ABI),permit=new Interface(PERMIT2_ABI);let broadcasts=0;
 ex.readProvider.call=async req=>req.to.toLowerCase()===PERMIT2.toLowerCase()?permit.encodeFunctionResult('allowance',[0n,0,0]):erc.encodeFunctionResult('allowance',[0n]);
 ex.sendVerifiedTx=async req=>{values.get('activeRebalanceExecution').id='replaced';req.beforeBroadcast();broadcasts++;return{}};
 await assert.rejects(ex.ensureSwapAllowances(token,100n,{stopLiquidationId:'exit-1'}),/paused/);assert.equal(broadcasts,0);
});
test('paused emergency liquidation permits exact approvals while normal execution stays paused',async()=>{
 const{ex,values}=approvalHarness(),token={address:'0x0000000000000000000000000000000000000002'};
 const erc=new Interface(ERC20_ABI),permit=new Interface(PERMIT2_ABI);let broadcasts=0;
 ex.config.txDeadlineSec=300;ex.config.permit2ExpirationSec=3600;
 ex.readProvider.call=async req=>req.to.toLowerCase()===PERMIT2.toLowerCase()?permit.encodeFunctionResult('allowance',[broadcasts>=2?100n:0n,broadcasts>=2?Math.floor(Date.now()/1000)+3600:0,0]):erc.encodeFunctionResult('allowance',[broadcasts>=1?100n:0n]);
 ex.sendVerifiedTx=async req=>{req.beforeBroadcast();broadcasts++;return{}};
 const result=await ex.ensureSwapAllowances(token,100n,{stopLiquidationId:'exit-1'});assert.equal(result.broadcasted,true);assert.equal(broadcasts,2);assert.equal(values.get('executionPaused'),true);
});

test('scheduled monitor cannot race the manually confirmed restart valuation',async()=>{
 const{b}=harness();b.stopLossRestartPromise=Promise.resolve();b.providers=new Proxy({},{get(){throw new Error('unexpected RPC')}});
 const snapshot=await AutoLpBot.prototype.runOnce.call(b);assert.equal(snapshot,b.snapshot);assert.equal(b.cycleActive,undefined);
});
