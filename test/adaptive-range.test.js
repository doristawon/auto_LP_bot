import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Interface } from 'ethers';
import { chooseOptimalWidth, liquidityForUsd, analyzeAdaptiveRange, normalizeAdaptiveRangeSettings, PONS_POOL_ID } from '../src/analytics/adaptive-range.js';
import { buildFixedTickRange, buildExecutionTargetRange, prepareAdaptiveExecution, assertAdaptiveMinimumHold, adaptiveHoldingSince, syncAdaptiveHoldingTopology } from '../src/execution/pool-target-range.js';
import { readAdaptiveRangeSamples } from '../src/adapters/adaptive-range-feed.js';
import { RebalanceExecutor } from '../src/adapters/executor.js';
import { AutoLpBot } from '../src/bot.js';
import { dashboardPage } from '../src/dashboard/page.js';
import { getSqrtPriceAtTick } from '../src/math/v4-fixed.js';
import { rebalanceTiming } from '../src/dashboard/rebalance-timing.js';
import { DashboardServer } from '../src/dashboard/server.js';


const tokens={token0:{address:'0x'+'aa'.repeat(20),decimals:18},token1:{address:'0x'+'bb'.repeat(20),decimals:6}};
const optimizer=(extra={})=>{const tick=extra.tick??-285000;return chooseOptimalWidth({sigma:68,drift:-3.7,feesPerDayUsd:21000,averageFee:0.0059,
 activeLiquidity:2.5e19,tick,sizeUsd:3000,decimals0:18,decimals1:6,stableIndex:1,rangeForWidth:w=>buildFixedTickRange(tick,60,w),...extra});};
test('net optimizer considers 79 widths, uses K and lambda and rejects infeasible widths',()=>{
 const r=optimizer();assert.equal(r.status,'ready');assert.ok(r.estimatedRebalancesPerDay<=6);assert.equal(r.widthTicks%60,0);
 const h=r.widthTicks/2;const reb=24*2.9*(68**2/h**2+3.7/h);
 assert.ok(Math.abs(r.estimatedRebalancesPerDay-reb)<1e-10);
 assert.ok(Math.abs(r.costPerDayUsd-reb*(0.5*0.0059+0.22*(1.0001**h-1))*3000)<1e-7);
 assert.equal(optimizer({sigma:10000}).reason,'no-feasible-width');
 assert.equal(optimizer({sigma:0,drift:0}).eligibleCandidates,79);
 assert.equal(optimizer({sigma:0,drift:0}).estimatedRebalancesPerDay,0);
 assert.equal(optimizer({feesPerDayUsd:0}).status,'ready');
 assert.throws(()=>optimizer({sizeUsd:NaN}));
 assert.throws(()=>normalizeAdaptiveRangeSettings({enabled:'true'}));
});
test('liquidity uses actual tick and decimals, including reversed token order',()=>{
 const sizeUsd=3000,tick=-285000,range=buildFixedTickRange(tick,60,960);
 const x=liquidityForUsd({sizeUsd,tick,...range,decimals0:18,decimals1:6,stableIndex:1});
 const sp=1.0001**(tick/2),sa=1.0001**(range.tickLower/2),sb=1.0001**(range.tickUpper/2);
 const expected=sizeUsd/(((sb-sp)/(sp*sb))/1e18*(1.0001**tick*1e12)+(sp-sa)/1e6);
 assert.ok(Math.abs(x/expected-1)<1e-12);
 const reverse=liquidityForUsd({sizeUsd,tick:-tick,tickLower:-range.tickUpper,tickUpper:-range.tickLower,decimals0:6,decimals1:18,stableIndex:0});
 assert.ok(Math.abs(reverse/x-1)<1e-12);
});
test('24h statistics deduplicate swaps, price both directions and reject short or stale windows',()=>{
 const now=1800000000000;
 const swaps=Array.from({length:25},(_,i)=>({blockNumber:100+i,logIndex:0,tick:i%2?10:0,amount0:'1000000000000000000',amount1:'-1000000',fee:5000}));
 const data={swaps:[...swaps].reverse(),startTimestampSeconds:now/1000-86400,endTimestampSeconds:now/1000,
  asOfTimestampSeconds:now/1000,windowStartTimestampSeconds:now/1000-86400,pool:tokens,usdgAddress:tokens.token1.address};
 const r=analyzeAdaptiveRange(data,{nowMs:now});assert.equal(r.status,'ready');assert.equal(r.sigma,10);
 assert.ok(Math.abs(r.feesPerDayUsd-25*0.005)<1e-12);assert.ok(Math.abs(r.averageFee-0.005)<1e-12);
 assert.equal(analyzeAdaptiveRange({...data,swaps:[...swaps,swaps[0]]},{nowMs:now}).sampleCount,25);
 assert.equal(analyzeAdaptiveRange({...data,startTimestampSeconds:now/1000-3600},{nowMs:now}).reason,'insufficient-window');
 assert.equal(analyzeAdaptiveRange(data,{nowMs:now+6*60000}).reason,'stale-chain');
 assert.equal(analyzeAdaptiveRange({...data,swaps:[...swaps,{...swaps[0],tick:100}]},{nowMs:now}).reason,'conflicting-events');
});

test('all widths align to spacing with exact total W, including odd Wide spacing count', () => {
  for(const width of [240,480,960,2820])for(const tick of [-887220,-285111,1,887160]) {
    const r=buildFixedTickRange(tick,60,width);
    assert.equal(r.tickUpper-r.tickLower,width);
    assert.equal(Math.abs(r.tickLower%60),0);assert.equal(Math.abs(r.tickUpper%60),0);
    assert.ok(r.tickLower<=tick&&tick<r.tickUpper);
  }
  assert.throws(()=>buildFixedTickRange(100,60,481));
});

test('only exact PONS pool uses adaptive width; state fallback rejects stale decisions',async()=>{
  const pool={id:PONS_POOL_ID,key:{tickSpacing:60}};
  const decision={status:'ready',model:'net-yield-v2',widthTicks:960,observedAt:Date.now()};
  const saved={adaptiveRangeSettings:{enabled:true},adaptiveRangeDecision:decision};
  const executor={config:{rangePreset:'fables-tight'},state:{getSetting:(k,v)=>saved[k]??v}};
  assert.equal(buildExecutionTargetRange(executor,pool,100).widthTicks,960);
  assert.equal(buildExecutionTargetRange(executor,{...pool,id:'other'},100).widthTicks,undefined);
  await RebalanceExecutor.prototype.runWalletWrite.call(executor,async()=>{
    saved.adaptiveRangeDecision={...decision,observedAt:0};
    assert.equal(buildExecutionTargetRange(executor,pool,100).widthTicks,960);
  });
  assert.equal(executor.adaptiveRangeContext,null);
  assert.throws(()=>buildExecutionTargetRange(executor,pool,100),/過舊/);
  assert.equal(executor.activeWrites,0);
});

const abi=new Interface(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)']);
const manager='0x'+'11'.repeat(20), sender='0x'+'22'.repeat(20), now=1800000000000;
function feedProvider({reorg=false,quota=false,rangeLimit=false}={}) {
  const calls=[];let endReads=0;
  const hash=n=>'0x'+n.toString(16).padStart(64,'0');
  const logs=Array.from({length:25},(_,i)=>{
    const blockNumber=14000+i*3550;
    return {...abi.encodeEventLog(abi.getEvent('Swap'),[PONS_POOL_ID,sender,1000,-1000000,1,1,i%2?10:0,3000]),address:manager,blockNumber,index:0,blockHash:hash(blockNumber)};
  });
  return {calls,async getBlock(n){calls.push(['block',n]);n=n==='latest'?100020:n;if(n===100000)endReads++;return {number:n,timestamp:now/1000-100000+n,hash:reorg&&n===100000&&endReads>1?hash(1):hash(n)};},
    async getLogs(filter){calls.push(['logs',filter]);if(quota)throw new Error('quota exceeded');
      if(rangeLimit&&filter.toBlock-filter.fromBlock+1>10000)throw new Error('limited to 10000 blocks');
      return logs.filter(l=>l.blockNumber>=filter.fromBlock&&l.blockNumber<=filter.toBlock);}};
}
test('feed scans one pool in bounded chunks and does not request each swap timestamp',async()=>{
  const p=feedProvider({rangeLimit:true});
  const f=await readAdaptiveRangeSamples(p,{poolId:PONS_POOL_ID,poolManager:manager,nowMs:now});
  assert.equal(f.samples.length,25);assert.ok(f.requests<40);
  const metric=analyzeAdaptiveRange({swaps:f.samples,startTimestampSeconds:f.firstSwapTimestampSeconds,endTimestampSeconds:f.lastSwapTimestampSeconds,asOfTimestampSeconds:f.asOfTimestampSeconds,windowStartTimestampSeconds:f.windowStartTimestampSeconds,pool:tokens,usdgAddress:tokens.token1.address},{nowMs:now});
  assert.equal(metric.status,'ready');
  for(const [,filter] of p.calls.filter(c=>c[0]==='logs'))assert.equal(filter.topics[1],PONS_POOL_ID);
});
test('feed rejects reorg, quota and exhausted budget without a retry storm',async()=>{
  for(const flags of [{reorg:true},{quota:true}])await assert.rejects(readAdaptiveRangeSamples(feedProvider(flags),{poolId:PONS_POOL_ID,poolManager:manager,nowMs:now}));
  const p=feedProvider();await assert.rejects(readAdaptiveRangeSamples(p,{poolId:PONS_POOL_ID,poolManager:manager,nowMs:now,maxRequests:2}),/budget/);
  assert.equal(p.calls.length,2);
});

function botStub(){
  const data=new Map();const bot=Object.create(AutoLpBot.prototype);
  Object.assign(bot,{config:{},state:{getSetting:(k,v)=>data.has(k)?data.get(k):v,setSetting:(k,v)=>data.set(k,v)},ledger:{append(){}},market:{pools:[]}});
  bot.applyStoredAdaptiveRange();return bot;
}
test('wallet settings persist independently, busy writes reject changes, failed feed is cached hourly',async()=>{
  const a=botStub(),b=botStub();
  a.setAdaptiveRangeSettings({enabled:true});assert.equal(a.getAdaptiveRangeSnapshot().settings.enabled,true);
  assert.equal(b.getAdaptiveRangeSnapshot().settings.enabled,false);
  a.cycleActive=true;assert.throws(()=>a.setAdaptiveRangeSettings({enabled:false}),/尚未完成/);a.cycleActive=false;
  await a.refreshAdaptiveRange();const attempt=a.state.getSetting('adaptiveRangeLastAttemptAt');
  assert.equal(a.getAdaptiveRangeSnapshot().stats.status,'unavailable');
  await a.refreshAdaptiveRange();assert.equal(a.state.getSetting('adaptiveRangeLastAttemptAt'),attempt);
  a.applyStoredAdaptiveRange();assert.equal(a.config.adaptiveRange.settings.enabled,true);
});

test('dashboard inline script parses and adaptive drafts do not leak across wallets',()=>{
  const html=dashboardPage();new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const source=html.match(/function renderAdaptiveRange\(\)\{[\s\S]*?\n\}/)[0];
  const elements=new Map();const context={control:{walletAddress:'a',adaptiveRange:{settings:{enabled:true},decision:null}},selectedWalletAddress:'a',busy:false,adaptiveDraftWallet:'a',adaptiveDraftDirty:true,$:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);}};
  vm.createContext(context);vm.runInContext(source,context);context.renderAdaptiveRange();
  assert.match(elements.get('adaptiveRangeStatus').textContent,/暫緩/);
  context.control={walletAddress:'b',adaptiveRange:{settings:{enabled:false}}};context.renderAdaptiveRange();
  assert.equal(elements.get('adaptiveRangeEnabled').value,'false');assert.equal(context.adaptiveDraftDirty,false);
});

test('entry selects from fresh capital and state once; expiry and later model updates cannot change a funded operation',async()=>{
  const data=new Map(),pool={id:PONS_POOL_ID,key:{tickSpacing:60},...tokens};
  let reads=0;
  const policy={settings:{enabled:true},stats:{status:'ready',sigma:68,drift:-3.7,feesPerDayUsd:21000,averageFee:0.0059,observedAt:Date.now()}};
  const executor={config:{adaptiveRange:policy,usdgAddress:tokens.token1.address},
    state:{getSetting:(k,v)=>data.get(k)??v,setSetting:(k,v)=>data.set(k,v)},ledger:{append(){}},
    fables:{async readPoolState(){reads++;return {tick:-285000,sqrtPriceX96:getSqrtPriceAtTick(-285000),liquidity:25000000000000000000n};}},
    async readRawPairBalances(){return {raw0:0n,raw1:3000000000n}}};
  await RebalanceExecutor.prototype.runWalletWrite.call(executor,async()=>{
    await prepareAdaptiveExecution(executor,{pool},pool);
    const chosen=executor.adaptiveRangeContext.decision;
    assert.equal(chosen.sizeUsd,3000);assert.equal(chosen.tick,-285000);assert.equal(reads,1);
    policy.stats={...policy.stats,sigma:10000};
    await prepareAdaptiveExecution(executor,{pool},pool);
    assert.equal(reads,1);assert.equal(buildExecutionTargetRange(executor,pool,-285001).widthTicks,chosen.widthTicks);
  });
  assert.ok(data.get('adaptiveRangeDecision').widthTicks>=120);
});

test('adaptive minimum holding period persists and is only enforced for PONS',()=>{
 const data=new Map(),pool={id:PONS_POOL_ID},position={id:'position'},executor={config:{adaptiveRange:{settings:{enabled:true}}},
  state:{getSetting:(k,v)=>data.get(k)??v,setSetting:(k,v)=>data.set(k,v)}};
 assert.throws(()=>assertAdaptiveMinimumHold(executor,pool,position),/1 小時/);
 data.set('adaptiveHolding:'+PONS_POOL_ID+':position',Date.now()-3600001);
 assert.doesNotThrow(()=>assertAdaptiveMinimumHold(executor,pool,position));
 assert.doesNotThrow(()=>assertAdaptiveMinimumHold(executor,{id:'other'},position));
});

test('reused historical range starts a new holding episode while unchanged ranges retain their clock',()=>{
 const data=new Map(),state={getSetting:(k,v)=>data.get(k)??v,setSetting:(k,v)=>data.set(k,v)};
 const pool={id:PONS_POOL_ID,key:{hooks:'0xhook'}},position={id:'range'},executor={state};
 const key=`adaptiveHolding:${PONS_POOL_ID}:range`,range='0xhook|range';
 data.set(`positionBaseline:${PONS_POOL_ID}:range`,{createdAt:1});
 assert.equal(adaptiveHoldingSince(executor,pool,position,10000),10000);
 syncAdaptiveHoldingTopology(state,[pool],[range],[range],20000);
 assert.equal(data.get(key),10000);
 syncAdaptiveHoldingTopology(state,[pool],[range],[],30000);assert.equal(data.get(key),0);
 syncAdaptiveHoldingTopology(state,[pool],[],[range],40000);
 assert.equal(adaptiveHoldingSince(executor,pool,position,50000),40000);
});

test('adaptive countdown uses position age instead of old OOR delay/excursion settings',()=>{
 const now=Date.now(),snapshot={generatedAt:now,portfolio:{positions:[{shares:'1',poolId:PONS_POOL_ID,id:'position',outside:true,
  outOfRangeSince:now-1000,adaptiveEnabled:true,adaptiveHoldUntil:now+120000,excursionPct:0.01,shouldRebalance:false}]}};
 const r=rebalanceTiming({strategy:{confirmDelayMin:5,minExcursionPct:0.25,monitorPollIntervalMs:60000},nextMonitorAt:now+60000},snapshot,now);
 assert.equal(r.policyReadyAt,now+120000);assert.equal(r.targetAt,now+120000);assert.equal(r.phase,'confirming');
});

test('adaptive bot holds in-range LP even if an old decision requests another width',async()=>{
 const bot=botStub(),pool={id:PONS_POOL_ID,key:{tickSpacing:60},state:{tick:-285000,paused:false},token0:tokens.token0,token1:tokens.token1};
 const position={id:'position',tickLower:-285120,tickUpper:-284880,shares:1n};
 Object.assign(bot.config,{rangePreset:'fables-tight',tightWidthBps:100,rangeCheckIntervalMs:60000,oorConfirmDelayMs:300000,oorMinExcursionPct:0.25});
 bot.state.getPosition=()=>({});bot.state.setPosition=()=>{};
 bot.executor={config:bot.config,state:bot.state};bot.config.adaptiveRange={settings:{enabled:true},stats:{status:'ready',sigma:68,drift:3,feesPerDayUsd:100,averageFee:0.005,observedAt:Date.now()}};
 await bot.decoratePosition(pool,position);assert.equal(position.shouldRebalance,false);assert.equal(position.target,null);
 bot.config.autoTopupEnabled=true;bot.config.dryRun=true;bot.getInvestmentTargetSettings=()=>{throw new Error('in-range adaptive topup must return earlier')};
 pool.positions=[position];assert.equal(await bot.maybeTopUpIdleBalance([pool],{}),null);
});

test('dashboard adaptive settings API is wallet-scoped and requires same origin',async()=>{
 const a=botStub(),b=botStub();
 const server=new DashboardServer({dashboardEnabled:true,dashboardHost:'127.0.0.1',dashboardPort:0},a,null,null,{getBot:wallet=>wallet==='b'?b:a});
 await server.start();const base='http://127.0.0.1:'+server.server.address().port;
 try {
  const response=await fetch(base+'/api/settings/adaptive-range',{method:'POST',headers:{origin:base,'content-type':'application/json','x-wallet-address':'b'},body:JSON.stringify({enabled:true})});
  assert.equal(response.status,200);assert.equal((await response.json()).adaptiveRange.settings.version,2);
  assert.equal(a.getAdaptiveRangeSnapshot().settings.enabled,false);assert.equal(b.getAdaptiveRangeSnapshot().settings.enabled,true);
  const blocked=await fetch(base+'/api/settings/adaptive-range',{method:'POST',headers:{origin:'https://example.invalid','content-type':'application/json'},body:'{"enabled":true}'});
  assert.equal(blocked.status,403);
 } finally { await server.stop(); }
});

test('adaptive idle entry requires no active LP, no stop loss and a stable wallet topology',async()=>{
 const bot=botStub();bot.setAdaptiveRangeSettings({enabled:true});bot.config.adaptiveRange.stats={status:'ready',sigma:1,drift:1,feesPerDayUsd:1,averageFee:0.001,observedAt:Date.now()};
 bot.getInvestmentAllocationConfig=()=>({enabled:false});bot.getInvestmentTargetSettings=()=>({mode:'specific-pool',poolId:PONS_POOL_ID});
 bot.market.pools=[{id:PONS_POOL_ID,state:{paused:false}}];bot.revalidateTopologyBeforeExecution=async()=>true;
 let calls=0;bot.executor={async executeCrossPool(){calls++;return {status:'completed',newPositionId:'new'}}};
 assert.equal(await bot.maybeBootstrapAdaptive({portfolio:{positions:[{shares:'1'}]}}),null);
 bot.state.setSetting('stopLossLatched',true);assert.equal(await bot.maybeBootstrapAdaptive({portfolio:{positions:[]}}),null);
 bot.state.setSetting('stopLossLatched',false);bot.revalidateTopologyBeforeExecution=async()=>false;
 assert.equal(await bot.maybeBootstrapAdaptive({portfolio:{positions:[]}}),null);assert.equal(calls,0);
 bot.revalidateTopologyBeforeExecution=async()=>true;await bot.maybeBootstrapAdaptive({portfolio:{positions:[]}});
 assert.equal(calls,1);assert.equal(bot.capitalReadbackPending,true);
});
