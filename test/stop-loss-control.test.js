import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { AutoLpBot } from '../src/bot.js';
import { DashboardServer } from '../src/dashboard/server.js';
import { dashboardPage } from '../src/dashboard/page.js';

function harness(){
 const settings=new Map(),calls=[],bot=Object.create(AutoLpBot.prototype);
 bot.config={walletAddress:'0x0000000000000000000000000000000000000001',dashboardManualControlEnabled:true,pollIntervalMs:300000};
 bot.state={getSetting:(k,v)=>settings.has(k)?settings.get(k):v,setSetting:(k,v)=>settings.set(k,v)};
 bot.ledger={append(){},writeSnapshot(){},readSnapshot:()=>bot.snapshot};
 bot.snapshot={generatedAt:Date.now(),portfolio:{currentValueUsd:1000},bot:{}};
 bot.runOnce=async opts=>{calls.push(opts);return bot.snapshot};
 bot.performStopLiquidation=async ()=>{calls.push('liquidate');bot.state.setSetting('stopLiquidationStatus',{status:'completed'});return{status:'completed'}};
 bot.executor={};bot.executionPaused=false;
 return{bot,calls,settings};
}
test('manual stop pauses immediately, waits for observation, and runs readonly preflight before exit',async()=>{
 const{bot,calls,settings}=harness();bot.cycleActive=true;
 const request=bot.requestStopLiquidation({confirm:'STOP_AND_LIQUIDATE'});
 assert.equal(bot.executionPaused,true);assert.equal(request.latched,true);assert.equal(settings.get('executionPaused'),true);assert.equal(calls.length,0);
 bot.requestStopLiquidation({confirm:'STOP_AND_LIQUIDATE'}); // coalesce duplicate requests
 bot.cycleActive=false;await bot.stopLiquidationPromise;
 assert.equal(calls.length,3);assert.equal(calls[0].executeRebalances,false);assert.equal(calls[1],'liquidate');assert.equal(calls[2].source,'stop-liquidate-readback');assert.equal(calls[2].executeRebalances,false);assert.equal(bot.executionPaused,true);
 assert.equal(settings.get('stopLossLatched'),true);
});
test('manual stop failure stays latched and exposes error; recovery blocks rebase',async()=>{
 const{bot,settings}=harness();bot.performStopLiquidation=async()=>{settings.set('activeRebalanceExecution',{phase:'recovery_required'});throw new Error('receipt unknown')};
 bot.requestStopLiquidation({confirm:'STOP_AND_LIQUIDATE'});await bot.stopLiquidationPromise;
 assert.equal(settings.get('stopLiquidationStatus').status,'failed');assert.equal(settings.get('stopLossLatched'),true);assert.equal(bot.executionPaused,true);
 assert.throws(()=>bot.setStopLossSettings({enabled:true,lossPct:15,rebase:true}),/待確認/);
});
test('risk HTTP API uses the captured wallet worker and requires same-origin for mutations',async()=>{
 const{bot,settings}=harness();let targeted=false;
 const fleet={getBot(address){assert.equal(address,'selected-worker');targeted=true;return bot}};
 const server=new DashboardServer({dashboardEnabled:true,dashboardHost:'127.0.0.1',dashboardPort:0,dashboardManualControlEnabled:true},bot,bot.ledger,{},fleet);
 await server.start();const base='http://127.0.0.1:'+server.server.address().port;
 try{
  const headers={Origin:base,'Content-Type':'application/json','X-Wallet-Address':'selected-worker'};
  const save=await fetch(base+'/api/risk/stop-loss',{method:'POST',headers,body:JSON.stringify({enabled:true,lossPct:15})});
  assert.equal(save.status,200);assert.equal(targeted,true);assert.equal(settings.get('stopLossReference').equityUsd,1000);
  const bad=await fetch(base+'/api/risk/stop-loss',{method:'POST',headers,body:JSON.stringify({enabled:true,lossPct:100})});assert.equal(bad.status,409);
  const foreign=await fetch(base+'/api/control/stop-liquidate',{method:'POST',headers:{...headers,Origin:'https://other.invalid'},body:JSON.stringify({confirm:'STOP_AND_LIQUIDATE'})});assert.equal(foreign.status,403);assert.equal(settings.get('stopLossLatched'),false);
  const noConfirm=await fetch(base+'/api/control/stop-liquidate',{method:'POST',headers,body:'{}'});assert.equal(noConfirm.status,409);
  const stop=await fetch(base+'/api/control/stop-liquidate',{method:'POST',headers,body:JSON.stringify({confirm:'STOP_AND_LIQUIDATE'})});assert.equal(stop.status,202);await bot.stopLiquidationPromise;assert.equal(bot.executionPaused,true);
 }finally{await server.stop()}
});
test('dashboard risk script parses and distinguishes pause from liquidation',()=>{
 const page=dashboardPage(),script=page.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(script);
 assert.match(page,/id="stopAndLiquidate"/);assert.match(page,/id="stopLossPct"/);assert.match(page,/api\/control\/stop-liquidate/);assert.match(page,/暫停自動平衡.*仍只暫停/);
});

function cycleHarness(){
 const {bot,calls,settings}=harness();
 bot.config={...bot.config,targetMode:'wallet-active',positionIds:[],dryRun:false};
 bot.providers={readProvider:{getBlockNumber:async()=>100}};
 bot.market={pools:[],prices:new Map(),fablesStats:null};
 bot.refreshMarket=async()=>{};bot.resolveTargetPools=async()=>({pools:[],accountingPools:[]});
 bot.points={noteUserTrackingStarted(){},snapshot:()=>({})};bot.fables={readWalletBalances:async()=>({})};
 bot.backfillGuardedWithdrawFees=async()=>{};bot.scanExternalCashflows=async()=>{};
 bot.getInvestmentAllocationConfig=()=>({enabled:false});bot.getInvestmentAllocationSnapshot=()=>({enabled:false});
 bot.getInvestmentTargetSnapshot=()=>({});bot.attachRebalanceQuotes=async()=>{};bot.recordPortfolioSnapshot=()=>{};
 bot.analytics={build:()=>({currentValueUsd:840,netCashflowUsd:0,accountingComplete:false,positions:[]})};
 settings.set('stopLossSettings',{enabled:true,lossPct:15});settings.set('stopLossReference',{equityUsd:1000,at:Date.now(),wallet:bot.config.walletAddress});
 bot.performStopLiquidation=async()=>{calls.push('exit');settings.set('stopLossLatched',true);bot.setExecutionPaused(true,'test-stop')};
 bot.maybeTopUpIdleBalance=async()=>calls.push('topup');bot.maybeRebalance=async()=>calls.push('rebalance');
 bot.runOnce=AutoLpBot.prototype.runOnce;
 return {bot,calls,settings};
}
test('automatic stop precedes every rebalance/topup and does not automatically repeat after latch',async()=>{
 const{bot,calls}=cycleHarness();await bot.runOnce();assert.deepEqual(calls,['exit']);assert.equal(bot.executionPaused,true);
 await bot.runOnce();assert.deepEqual(calls,['exit']);
});

test('LP-session loss across rebalancing reaches threshold and exits before another capital action',async()=>{
 const{bot,calls,settings}=cycleHarness();
 settings.set('stopLossSettings',{enabled:true,lossPct:15,basisMode:'lp-session'});
 const reference={equityUsd:1000,at:Date.now(),wallet:bot.config.walletAddress,basisMode:'lp-session',initialPositions:[{rangeId:'first-range'}]};
 settings.set('stopLossReference',reference);
 bot.analytics.build=()=>({currentValueUsd:840,netCashflowUsd:0,accountingComplete:false,positions:[{id:'third-range',shares:'500',principalUsd:800}]});
 await bot.runOnce();assert.deepEqual(calls,['exit']);
 assert.equal(settings.get('stopLossReference'),reference);
 assert.equal(bot.executionPaused,true);assert.equal(settings.get('stopLossLatched'),true);
});
test('readonly scan cannot liquidate, and paused monitoring does not initiate financial operations',async()=>{
 const{bot,calls}=cycleHarness();await bot.runOnce({executeRebalances:false});assert.deepEqual(calls,[]);
 bot.executionPaused=true;bot.maybeTopUpIdleBalance=AutoLpBot.prototype.maybeTopUpIdleBalance;
 await bot.runOnce();assert.deepEqual(calls,[]);
});

test('a completed capital cycle schedules one readonly portfolio readback without another topup',async()=>{
 const{bot,calls,settings}=cycleHarness();
 settings.set('stopLossSettings',{enabled:false,lossPct:15});
 bot.maybeTopUpIdleBalance=async()=>{calls.push('topup');bot.capitalReadbackPending=true};
 bot.runOnce=async opts=>{
  if(opts?.source==='capital-readback'){
   assert.equal(opts.executeRebalances,false);calls.push('capital-readback');
  }
  return AutoLpBot.prototype.runOnce.call(bot,opts);
 };
 await bot.runOnce();
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.deepEqual(calls,['topup','capital-readback']);
 assert.equal(bot.capitalReadbackPending,false);
 assert.equal(bot.cycleActive,false);
});
