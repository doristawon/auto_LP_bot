import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface } from 'ethers';
import { captureLpSessionReference, evaluateStopLoss, normalizeStopLoss } from '../src/analytics/stop-loss.js';
import { executeStopLiquidation, reconcileStopLiquidation } from '../src/execution/stop-liquidation.js';
import { AutoLpBot } from '../src/bot.js';
import { UniversalRouterAdapter } from '../src/adapters/universal-router.js';
import { ZERO_ADDRESS } from '../src/constants.js';
import { ERC20_ABI, UNIVERSAL_ROUTER_ABI } from '../src/abi.js';

const A='0x0000000000000000000000000000000000000011';
const S='0x0000000000000000000000000000000000000022';
const W='0x0000000000000000000000000000000000000033';
const H='0x0000000000000000000000000000000000000044';
const now=1_790_800_000_000;
const settings={enabled:true,lossPct:15};
const ref={equityUsd:1000,at:now-10000,netCashflowUsd:50,flowAccountingComplete:false,wallet:W};
const snapshot=(equity)=>({generatedAt:now,bot:{wallet:W},portfolio:{currentValueUsd:equity,netCashflowUsd:50,accountingComplete:false}});

test('15% armed-equity stop triggers exactly at threshold, not at 14.99%',()=>{
  assert.equal(evaluateStopLoss(settings,ref,snapshot(850),now).triggered,true);
  assert.equal(evaluateStopLoss(settings,ref,snapshot(850.1),now).triggered,false);
  assert.equal(evaluateStopLoss(settings,ref,snapshot(900),now).triggerBelowUsd,850);
});
test('missing, null, nonfinite, stale and cross-wallet valuations never become zero-loss exits',()=>{
  for(const value of [null,undefined,NaN,Infinity,'0'])assert.equal(evaluateStopLoss(settings,ref,snapshot(value),now).status,'unavailable');
  assert.equal(evaluateStopLoss(settings,ref,{...snapshot(0),generatedAt:now-901000},now).triggered,false);
  assert.equal(evaluateStopLoss(settings,ref,{...snapshot(0),generatedAt:'invalid'},now).triggered,false);
  assert.equal(evaluateStopLoss({...settings,lossPct:NaN},ref,snapshot(0),now).status,'unavailable');
  assert.equal(evaluateStopLoss(settings,ref,{...snapshot(0),generatedAt:now+60000},now).triggered,false);
  assert.equal(evaluateStopLoss(settings,ref,{...snapshot(0),bot:{wallet:A}},now).triggered,false);
});
test('reconciled flows adjust basis; incomplete accounting stays explicitly fixed equity',()=>{
  const next=snapshot(1000);next.portfolio.netCashflowUsd=250;next.portfolio.accountingComplete=true;
  assert.equal(evaluateStopLoss(settings,{...ref,flowAccountingComplete:true},next,now).principalUsd,1200);
  const fixed=evaluateStopLoss(settings,ref,next,now);
  assert.equal(fixed.principalUsd,1000);assert.equal(fixed.flowMode,'fixed-equity');assert.match(fixed.transferNotice,/重新設定/);
});
test('risk settings reject malformed ranges and keep the chosen reference mode',()=>{
  for(const lossPct of [0,100,NaN])assert.throws(()=>normalizeStopLoss({enabled:true,lossPct}));
  assert.throws(()=>normalizeStopLoss({enabled:'true',lossPct:15}));
  assert.equal(normalizeStopLoss({enabled:true,lossPct:15}).basisMode,'armed-equity');
  assert.equal(normalizeStopLoss({enabled:true,lossPct:15,basisMode:'lp-session'}).version,2);
  assert.throws(()=>normalizeStopLoss({enabled:true,lossPct:15,basisMode:'per-rebalance'}));
});

function withLp(s, id='range-one'){
  return {...s,portfolio:{...s.portfolio,positions:[{id,poolId:'pool-one',shares:'100',principalUsd:950}]}};
}
test('LP session starts only with a fresh, positive confirmed LP and full portfolio valuation',()=>{
  const s=withLp(snapshot(1000));
  const reference=captureLpSessionReference(s,W,{now});
  assert.equal(reference.equityUsd,1000);assert.equal(reference.basisMode,'lp-session');
  assert.equal(reference.initialPositions[0].rangeId,'range-one');
  assert.equal(captureLpSessionReference(snapshot(1000),W,{now}),null);
  assert.equal(captureLpSessionReference(s,W,{now,minimumAt:now+1}),null);
  assert.equal(captureLpSessionReference({...s,generatedAt:now-901000},W,{now}),null);
  assert.equal(captureLpSessionReference(s,A,{now}),null);
  assert.equal(captureLpSessionReference(withLp(snapshot(null)),W,{now}),null);
  const invalid=withLp(snapshot(1000));invalid.portfolio.positions[0].shares='invalid';
  assert.equal(captureLpSessionReference(invalid,W,{now}),null);
});
test('LP session tracks total capital through new ranges, idle balances, fees and transaction losses',()=>{
  const reference=captureLpSessionReference(withLp(snapshot(1000)),W,{now});
  const risk={enabled:true,lossPct:15,basisMode:'lp-session'};
  const next=withLp(snapshot(850),'range-after-rebalance');
  assert.equal(evaluateStopLoss(risk,reference,next,now).triggered,true);
  assert.equal(evaluateStopLoss(risk,reference,withLp(snapshot(850.1),'range-three'),now).triggered,false);
  assert.equal(evaluateStopLoss(risk,{pending:true},snapshot(1000),now).status,'waiting-lp');
  assert.equal(evaluateStopLoss(risk,{pending:true},next,now).status,'unavailable');
  assert.equal(evaluateStopLoss(risk,ref,next,now).status,'unavailable');
});
function botFixture(){
  const store=new Map(),bot=Object.create(AutoLpBot.prototype);
  bot.state={getSetting:(key,fallback)=>store.has(key)?store.get(key):fallback,setSetting:(key,value)=>store.set(key,value)};
  bot.config={walletAddress:W,pollIntervalMs:300000,dashboardManualControlEnabled:true};
  bot.ledger={append(){}};bot.snapshot={generatedAt:Date.now(),blockNumber:42,portfolio:{currentValueUsd:1000,netCashflowUsd:20,accountingComplete:false},bot:{wallet:W}};
  bot.executor={assertNoUnfinishedExecution(){}};
  return{bot,store};
}
test('pending LP baseline captures exactly once and survives rebalance, threshold edits and resumed workers',()=>{
  const{bot,store}=botFixture();
  bot.setStopLossSettings({enabled:true,lossPct:15,basisMode:'lp-session',rebase:true});
  const pending=store.get('stopLossReference');assert.equal(pending.pending,true);
  assert.equal(bot.getStopLossSnapshot().status,'waiting-lp');
  const current=withLp({...bot.snapshot,generatedAt:pending.armedAt+1});
  assert.equal(bot.capturePendingLpStopLossReference(current),true);
  const reference=store.get('stopLossReference');assert.equal(reference.equityUsd,1000);
  bot.snapshot=withLp({...current,portfolio:{...current.portfolio,currentValueUsd:910}},'next-range');
  assert.equal(bot.capturePendingLpStopLossReference(bot.snapshot),false);
  bot.setStopLossSettings({enabled:true,lossPct:10});
  assert.equal(store.get('stopLossSettings').basisMode,'lp-session');
  assert.equal(store.get('stopLossReference'),reference);
  const resumed=Object.create(AutoLpBot.prototype);Object.assign(resumed,{state:bot.state,config:bot.config,snapshot:bot.snapshot});
  assert.equal(resumed.getStopLossSnapshot().principalUsd,1000);
  assert.equal(resumed.capturePendingLpStopLossReference(bot.snapshot),false);
});
test('switching an existing LP to session mode resets the old stop latch only on explicit rearming',()=>{
  const{bot,store}=botFixture();bot.setStopLossSettings({enabled:true,lossPct:15});
  store.set('stopLossLatched',true);bot.snapshot=withLp(bot.snapshot);
  bot.setStopLossSettings({enabled:true,lossPct:15,basisMode:'lp-session',rebase:true});
  assert.equal(store.get('stopLossLatched'),false);
  assert.equal(store.get('stopLossReference').basisMode,'lp-session');
  assert.equal(store.get('stopLossReference').pending,undefined);
});
test('arming persists a wallet reference; changing threshold preserves it and disabled does not erase latch',()=>{
  const{bot,store}=botFixture();bot.setStopLossSettings({enabled:true,lossPct:15});
  const reference=store.get('stopLossReference');assert.equal(reference.equityUsd,1000);assert.equal(reference.wallet,W);
  bot.snapshot.portfolio.currentValueUsd=910;bot.setStopLossSettings({enabled:true,lossPct:10});assert.equal(store.get('stopLossReference'),reference);
  store.set('stopLossLatched',true);bot.setStopLossSettings({enabled:false,lossPct:10});assert.equal(store.get('stopLossLatched'),true);
  assert.throws(()=>bot.setExecutionPaused(false),/已停止清倉/);
  bot.setStopLossSettings({enabled:true,lossPct:15,rebase:true});assert.equal(store.get('stopLossLatched'),false);assert.equal(store.get('stopLossReference').equityUsd,910);
});
test('unfinished writes prevent resetting risk and explicit manual stop requires arming/confirmation',()=>{
  const{bot,store}=botFixture();store.set('activeRebalanceExecution',{phase:'stop_sent'});
  assert.throws(()=>bot.setStopLossSettings({enabled:true,lossPct:15,rebase:true}),/待確認/);
  assert.throws(()=>bot.requestStopLiquidation({confirm:'no'}),/確認/);
  bot.config.dashboardManualControlEnabled=false;assert.throws(()=>bot.requestStopLiquidation({confirm:'STOP_AND_LIQUIDATE'}),/人工/);
});
function liquidationFixture(){
  const store=new Map(),sent=[],events=[],balances=new Map([[A,100n],[S,0n]]);
  let shares=1000n;
  const token0={address:A,symbol:'MEME',decimals:18},token1={address:S,symbol:'USDG',decimals:6};
  const pool={id:'0x'+'11'.repeat(32),key:{currency0:A,currency1:S,hooks:H,fee:3000,tickSpacing:10},token0,token1,
    state:{paused:false,liquidity:1000000n},positions:[{id:'0x'+'22'.repeat(32),shares:1000n,tickLower:-100,tickUpper:100,outside:false}]};
  const erc20=new Interface(ERC20_ABI);
  const executor={config:{walletAddress:W,dryRun:false,enableLiveWrites:true,enableAutoRedeploy:true,usdgAddress:S,
    withdrawSlippageBps:50,swapSlippageBps:50,txDeadlineSec:120},signer:{address:W},state:{getSetting:(key,fallback)=>store.has(key)?store.get(key):fallback,setSetting:(key,value)=>store.set(key,value)},
    ledger:{append:(type,data)=>events.push({type,...data})},runWalletWrite:fn=>fn(),assertNoUnfinishedExecution(){},assertAtomicGuardReady:async()=>{},assertGasGuard:async()=>{},
    saveJournal(j){store.set('activeRebalanceExecution',j)},patchJournal(j,p){const next={...j,...p};this.saveJournal(next);return next},
    readPositionShares:async()=>shares,readRawTokenBalance:async t=>balances.get(t.address.toLowerCase())||0n,
    fables:{readPoolState:async()=>({sqrtPriceX96:1n<<96n,paused:false}),readRangeKey:async()=>({exists:true,tickLower:-100,tickUpper:100,key:pool.key}),
      encodeWithdrawAndClaim:()=> 'withdraw'},deadline:()=>123,ensureSwapAllowances:async()=>{},
    quoteCrossPoolRoute:async()=>({request:{router:H,data:'swap',value:0n},quote:{minRawAmountOut:'80'}}),
    writeProvider:{getBalance:async()=>0n,call:async({to})=>erc20.encodeFunctionResult('balanceOf',[balances.get(to.toLowerCase())||0n])},
    getPinnedFeeOverrides:async()=>({maxFeePerGas:1n}),
    sendVerifiedTx:async function(req){sent.push(req.label);req.onSent('0x'+'aa'.repeat(32));
      if(req.label==='stopLossWithdrawAndClaim')shares=0n;
      if(req.label==='stopLossSwapToUSDG'){balances.set(A,0n);balances.set(S,90n)}
      return{hash:'0x'+'aa'.repeat(32),status:1};}
  };
  return{executor,pool,store,sent,events,balances};
}
test('explicit stop withdraws in-range LP then consumes all meme into USDG, with no redeposit',async()=>{
  const{executor,pool,store,sent}=liquidationFixture();
  const result=await executeStopLiquidation(executor,{pools:[pool]});
  assert.equal(result.status,'completed');assert.deepEqual(sent,['stopLossWithdrawAndClaim','stopLossSwapToUSDG']);
  assert.equal(store.get('activeRebalanceExecution').phase,'completed');
});
test('unsupported and over-cost assets are reported as partial instead of false completed',async()=>{
  const{executor,pool,sent}=liquidationFixture();executor.quoteCrossPoolRoute=async()=>{throw new Error('cost above cap')};
  executor.readRawTokenBalance=async t=>t.address===S?0n:100n;
  const result=await executeStopLiquidation(executor,{pools:[pool],extraTokens:[{address:W}]});
  assert.equal(result.status,'partial');assert.equal(result.residual.length,2);assert.deepEqual(sent,['stopLossWithdrawAndClaim']);
});
test('uncertain withdrawal persists recovery, does not swap or retry',async()=>{
  const{executor,pool,store,sent}=liquidationFixture();
  executor.sendVerifiedTx=async req=>{sent.push(req.label);req.onSent('hash');const error=new Error('uncertain');error.code='BROADCAST_OUTCOME_UNCERTAIN';throw error};
  await assert.rejects(executeStopLiquidation(executor,{pools:[pool]}),/uncertain/);
  assert.equal(store.get('activeRebalanceExecution').phase,'recovery_required');assert.equal(sent.length,1);
});
test('mismatched on-chain range prevents any stop withdrawal',async()=>{
  const{executor,pool,sent}=liquidationFixture();executor.fables.readRangeKey=async()=>({exists:false});
  await assert.rejects(executeStopLiquidation(executor,{pools:[pool]}),/range key/);assert.equal(sent.length,0);
});
test('native V4 remains blocked by default; explicit native-input exit sends exact msg.value',()=>{
  const adapter=new UniversalRouterAdapter(null,{walletAddress:W});
  const pool={key:{currency0:ZERO_ADDRESS,currency1:S,fee:3000,tickSpacing:10,hooks:H},token0:{address:ZERO_ADDRESS},token1:{address:S}};
  const quote={zeroForOne:true,tokenIn:ZERO_ADDRESS,tokenOut:S,rawAmountIn:'1000',minRawAmountOut:'5'};
  assert.throws(()=>adapter.buildV4ExactInputSingle({pool,quote,deadline:123}),/Native-token/);
  const request=adapter.buildV4ExactInputSingle({pool,quote,deadline:123,allowNative:true});assert.equal(request.value,1000n);
  const decoded=new Interface(UNIVERSAL_ROUTER_ABI).decodeFunctionData('execute',request.data);assert.equal(decoded[0],'0x1004');assert.equal(decoded[1].length,2);const refund=AbiCoder.defaultAbiCoder().decode(['address','address','uint256'],decoded[1][1]);assert.equal(refund[0],ZERO_ADDRESS);assert.equal(refund[1].toLowerCase(),W.toLowerCase());
  const[actions,params]=AbiCoder.defaultAbiCoder().decode(['bytes','bytes[]'],decoded[1][0]);assert.equal(actions,'0x060c0f');
  assert.equal(AbiCoder.defaultAbiCoder().decode(['address','uint256'],params[1])[0],ZERO_ADDRESS);
  assert.throws(()=>adapter.buildV4ExactInputSingle({pool,quote:{...quote,zeroForOne:false,tokenIn:S,tokenOut:ZERO_ADDRESS},deadline:123,allowNative:true}),/Native-token/);
});

test('restart reconciliation unlocks only confirmed stop transactions, never resumes trading',async()=>{
  const{executor,store}=liquidationFixture();executor.ledger.all=()=>[];
  store.set('activeRebalanceExecution',{kind:'stop_liquidation',phase:'stop_sent',startedAt:10,tx:{withdraw:'hash'}});
  executor.writeProvider.getTransactionReceipt=async()=>({hash:'hash',status:1,blockNumber:10});
  executor.writeProvider.getTransactionCount=async()=>2;
  assert.equal(await reconcileStopLiquidation(executor),true);
  assert.equal(store.get('activeRebalanceExecution').phase,'failed');
  assert.equal(store.get('activeRebalanceExecution').reconciliation.receiptsConfirmed,true);
});
test('restart reconciliation keeps unknown receipt or pending nonce locked',async()=>{
  const{executor,store}=liquidationFixture();executor.ledger.all=()=>[];
  const journal={kind:'stop_liquidation',phase:'stop_sent',startedAt:10,tx:{withdraw:'hash'}};
  store.set('activeRebalanceExecution',journal);executor.writeProvider.getTransactionReceipt=async()=>null;
  executor.writeProvider.getTransactionCount=async()=>2;
  assert.equal(await reconcileStopLiquidation(executor),false);assert.equal(store.get('activeRebalanceExecution').phase,'recovery_required');
  store.set('activeRebalanceExecution',journal);executor.writeProvider.getTransactionReceipt=async()=>({hash:'hash',status:1,blockNumber:10});
  executor.writeProvider.getTransactionCount=async(_,tag)=>tag==='pending'?3:2;
  assert.equal(await reconcileStopLiquidation(executor),false);assert.equal(store.get('activeRebalanceExecution').phase,'recovery_required');
});

test('native ETH exit spends only balance above gas reserve and checks actual USDG receipt',async()=>{
 const{executor,pool,sent,balances}=liquidationFixture();pool.positions=[];balances.set(A,0n);
 const nativePool={...pool,id:'0x'+'33'.repeat(32),positions:[],key:{...pool.key,currency0:ZERO_ADDRESS},token0:{address:ZERO_ADDRESS,decimals:18}};
 let native=10n**18n,requested=0n;executor.writeProvider.getBalance=async()=>native;
 executor.config.topUpMinGasReserveWei=100n;
 executor.quoter={quoteExactInputSingleRaw:async(p,index,amount)=>{requested=amount;return{rawAmountIn:amount.toString(),minRawAmountOut:'80'}}};
 executor.assertQuotePriceImpact=()=>{};
 executor.router={buildV4ExactInputSingle:({quote,allowNative})=>{assert.equal(allowNative,true);return{router:H,data:'eth-swap',value:BigInt(quote.rawAmountIn)}}};
 executor.sendVerifiedTx=async req=>{sent.push(req.label);req.onSent('hash');native=3000100n-900n;balances.set(S,90n);return{hash:'hash',status:1}};
 const result=await executeStopLiquidation(executor,{pools:[pool,nativePool]});
 assert.equal(result.status,'completed');assert.equal(requested,10n**18n-3000100n);assert.equal(result.retainedGasWei,'3000100');
 assert.equal(result.actualNativeBalanceWei,'2999200');assert.deepEqual(sent,['stopLossETHToUSDG']);
});
