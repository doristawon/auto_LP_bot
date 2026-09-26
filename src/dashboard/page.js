export function dashboardPage() {
  return String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Fables Auto LP Bot · Control Center</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e9edf5;background:#0a0f18;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:#0a0f18}main{max-width:1640px;margin:auto;padding:20px}
h1,h2,h3{margin:.2em 0}.top{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap}.muted{color:#91a0b8}.small{font-size:12px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pill{display:inline-flex;align-items:center;padding:5px 9px;border:1px solid #2b3a55;border-radius:999px;font-size:12px;gap:6px}.pill.good{border-color:#23623f}.pill.bad{border-color:#713636}.pill.warn{border-color:#665423}
.grid{display:grid;grid-template-columns:repeat(4,minmax(170px,1fr));gap:12px;margin:16px 0}.card{background:#101827;border:1px solid #24324b;border-radius:14px;padding:14px}.label{font-size:12px;color:#91a0b8}.value{font-size:24px;font-weight:750;margin-top:5px}.good{color:#68d391}.bad{color:#fc8181}.warn{color:#f6c85f}.neutral{color:#d8e1ef}
.row{display:grid;grid-template-columns:1.5fr .5fr;gap:12px}.row-equal{display:grid;grid-template-columns:1fr 1fr;gap:12px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:9px;border-bottom:1px solid #24324b;white-space:nowrap;vertical-align:middle}th{color:#91a0b8;font-weight:600}
.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}button,input{background:#172235;border:1px solid #354764;color:#eef3fb;border-radius:8px;padding:8px 10px}button{cursor:pointer}button:hover:not(:disabled){background:#1d2d46}button:disabled{opacity:.45;cursor:not-allowed}.danger{border-color:#7b3b3b;background:#2b171d}.primary{border-color:#416188;background:#183050}.events{max-height:420px;overflow:auto}
.status-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;margin-top:10px}.status-item{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #1d2a40}.banner{display:none;margin:12px 0;padding:11px 13px;border-radius:10px;border:1px solid #6e5830;background:#261f12}.banner.bad{border-color:#713636;background:#2b171d;color:#ffd7d7}.banner.good{border-color:#23623f;background:#11251a;color:#c9f6d8}.action-note{max-width:320px;white-space:normal}
@media(max-width:1100px){.grid{grid-template-columns:repeat(2,1fr)}.row,.row-equal{grid-template-columns:1fr}}@media(max-width:620px){.grid{grid-template-columns:1fr}.status-list{grid-template-columns:1fr}main{padding:12px}}
</style>
</head>
<body><main>
<div class="top">
  <div>
    <h1>Fables Auto LP Bot</h1>
    <div class="muted small">Robinhood Chain · local control center · <span id="updated">loading</span></div>
  </div>
  <div class="controls">
    <span class="pill" id="mode">--</span>
    <span class="pill" id="armed">--</span>
    <button id="scan" class="primary">Scan now · no trades</button>
    <button id="pause">Pause execution</button>
    <button id="refresh">Refresh</button>
  </div>
</div>

<div id="liveBanner" class="banner"></div>

<div class="grid">
  <div class="card"><div class="label">Tracked value</div><div class="value" id="valueUsd">--</div><div class="small muted" id="hodl">--</div></div>
  <div class="card"><div class="label">Net PnL</div><div class="value" id="netPnl">--</div><div class="small muted" id="excess">--</div></div>
  <div class="card"><div class="label">Impermanent Loss</div><div class="value" id="il">--</div><div class="small muted">相對 position baseline</div></div>
  <div class="card"><div class="label">LP fees / Gas</div><div class="value" id="fees">--</div><div class="small muted" id="gas">--</div></div>
  <div class="card"><div class="label">Active LP</div><div class="value" id="rangeCount">--</div><div class="small muted" id="oorCount">--</div></div>
  <div class="card"><div class="label">Execution</div><div class="value" id="execution">--</div><div class="small muted" id="lastAction">--</div></div>
  <div class="card"><div class="label">Atomic guard</div><div class="value" id="guard">--</div><div class="small muted mono" id="guardAddr">--</div></div>
  <div class="card"><div class="label">Recovery state</div><div class="value" id="recovery">--</div><div class="small muted" id="recoveryDetail">--</div></div>
</div>

<div class="row-equal">
  <section class="card">
    <h2>Deployment & safety gates</h2>
    <div class="status-list">
      <div class="status-item"><span class="muted">Signer</span><strong id="signer">--</strong></div>
      <div class="status-item"><span class="muted">Live writes</span><strong id="liveWrites">--</strong></div>
      <div class="status-item"><span class="muted">Auto redeploy</span><strong id="autoRedeploy">--</strong></div>
      <div class="status-item"><span class="muted">Manual control</span><strong id="manualControl">--</strong></div>
      <div class="status-item"><span class="muted">Guard config flag</span><strong id="guardFlag">--</strong></div>
      <div class="status-item"><span class="muted">Guard runtime</span><strong id="guardRuntime">--</strong></div>
      <div class="status-item"><span class="muted">RPC health</span><strong id="rpc">--</strong></div>
      <div class="status-item"><span class="muted">Current block</span><strong id="block">--</strong></div>
    </div>
  </section>
  <section class="card">
    <h2>Range policy / limits</h2>
    <div class="status-list">
      <div class="status-item"><span class="muted">Absolute In-Range Hold</span><strong class="good">ON</strong></div>
      <div class="status-item"><span class="muted">Evaluation</span><strong id="policyScan">--</strong></div>
      <div class="status-item"><span class="muted">Deep OOR threshold</span><strong id="policyDeep">--</strong></div>
      <div class="status-item"><span class="muted">Shallow max wait</span><strong id="policyWait">--</strong></div>
      <div class="status-item"><span class="muted">Deep confirmations</span><strong id="policyConfirm">--</strong></div>
      <div class="status-item"><span class="muted">Target width</span><strong id="policyWidth">--</strong></div>
      <div class="status-item"><span class="muted">W / S / D slippage</span><strong id="slippage">--</strong></div>
      <div class="status-item"><span class="muted">Max gas</span><strong id="maxGas">--</strong></div>
    </div>
  </section>
</div>

<section class="card" style="margin-top:12px">
  <div class="top"><div><h2>LP positions & manual control</h2><div class="muted small">Manual rebalance 只允許已符合既定 OOR policy 的 position；不提供 In-Range bypass。</div></div></div>
  <div class="table-wrap"><table>
    <thead><tr><th>Pair</th><th>Status</th><th>Tick / Range</th><th>Excursion</th><th>OOR time</th><th>Deep conf.</th><th>Eligibility</th><th>Target</th><th>Value / Fees</th><th>Action</th></tr></thead>
    <tbody id="positions"></tbody>
  </table></div>
</section>

<div class="row" style="margin-top:12px">
  <section class="card">
    <h2>Transaction / accounting ledger</h2>
    <div class="events table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Tx</th><th>Gas USD</th><th>Fee USD</th><th>Detail</th></tr></thead><tbody id="events"></tbody></table></div>
  </section>
  <section class="card">
    <h2>Accounting tools</h2>
    <p class="muted small">Points baseline 與手動 cashflow 只影響 dashboard accounting，不會送鏈上交易。</p>
    <div class="controls"><input id="actualPoints" type="number" step="any" placeholder="Actual points"/><button id="savePoints">Set points baseline</button></div>
    <div style="height:14px"></div>
    <div class="controls"><input id="cashflow" type="number" step="any" placeholder="+deposit / -withdraw USD"/><input id="cashflowNote" placeholder="note"/><button id="addCashflow">Add cashflow</button></div>
    <div style="height:18px"></div>
    <h3>Fables Points</h3>
    <div class="value" id="points">--</div><div class="small muted" id="pointsNote">--</div>
  </section>
</div>

<script>
const $=id=>document.getElementById(id);
let snapshot=null,control=null,busy=false;
const dashboardToken=new URLSearchParams(location.search).get('token')||'';
const usd=v=>Number.isFinite(Number(v))?'$'+Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}):'--';
const num=v=>Number.isFinite(Number(v))?Number(v).toLocaleString(undefined,{maximumFractionDigits:4}):'--';
const pct=v=>Number.isFinite(Number(v))?Number(v).toFixed(2)+'%':'--';
const short=v=>v?v.slice(0,8)+'…'+v.slice(-6):'';
const yesNo=v=>v?'<span class="good">READY</span>':'<span class="bad">NO</span>';
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function api(path,opts){opts=opts||{};opts.headers=Object.assign({},opts.headers||{},dashboardToken?{'x-dashboard-token':dashboardToken}:{});const r=await fetch(path,opts);const text=await r.text();let body={};try{body=text?JSON.parse(text):{}}catch{body={error:text}}if(!r.ok)throw new Error(body.error||text||('HTTP '+r.status));return body}
function cls(v){return Number(v)>0?'good':Number(v)<0?'bad':''}
function dt(ms){return ms?new Date(ms).toLocaleString():'--'}
function durationMin(v){const n=Number(v||0);if(n<1)return n>0?Math.round(n*60)+' sec':'0 min';if(n<120)return Math.round(n)+' min';return (n/60).toFixed(1)+' h'}
function detail(e){
  if(e.type==='portfolio.snapshot')return 'PnL '+usd(e.netPnlUsd)+' · IL '+usd(e.ilUsd)+' · points '+num(e.estimatedPoints);
  if(e.type==='wallet.lp_topology_changed')return 'pools +'+(e.added||[]).length+'/-'+(e.removed||[]).length+' · ranges +'+(e.addedRanges||[]).length+'/-'+(e.removedRanges||[]).length;
  if(e.type==='rebalance.manual_requested')return 'MANUAL '+(e.pair||'')+(e.dryRun?' · dry-run':' · live');
  if(e.type==='rebalance.recovery_required')return 'RECOVERY REQUIRED · '+(e.error||'');
  if(e.type==='rebalance.blocked')return 'BLOCKED · '+(e.reason||'');
  if(e.type==='pool.fee_unattributed')return 'shared hook · pair attribution skipped';
  return e.note||e.label||e.pair||e.reason||e.status||e.error||e.eventKey||'';
}
function eventRow(e){return '<tr><td>'+dt(e.ts)+'</td><td>'+esc(e.type)+'</td><td class="mono">'+(e.hash?esc(short(e.hash)):'')+'</td><td>'+(e.gasUsd!=null?usd(e.gasUsd):'')+'</td><td>'+(e.feeUsd!=null?usd(e.feeUsd):'')+'</td><td class="small">'+esc(detail(e))+'</td></tr>'}
function actionState(x){
  if(!x.outside)return {disabled:true,label:'In range · HOLD',note:'withdraw forbidden'};
  if(!x.shouldRebalance)return {disabled:true,label:'Waiting policy',note:(x.rebalanceReason||'not eligible')};
  if(!control||!control.manualControlEnabled)return {disabled:true,label:'Manual disabled',note:'arm DASHBOARD_MANUAL_CONTROL_ENABLED'};
  if(control.executionPaused)return {disabled:true,label:'Paused',note:'resume execution first'};
  if(control.recoveryRequired)return {disabled:true,label:'Recovery lock',note:'inspect recovery first'};
  if(control.cycleActive||control.executionBusy)return {disabled:true,label:'Execution busy',note:'wait for current cycle/journal'};
  if(!control.dryRun&&!control.liveReady)return {disabled:true,label:'Live gates not ready',note:'guard/signer/live flags incomplete'};
  return {disabled:false,label:control.dryRun?'Run dry-run':'Manual rebalance',note:control.dryRun?'no capital movement':'will move capital'};
}
function positionRow(x){
  const a=actionState(x);
  const status=x.outside?'<span class="bad">OUT</span>':'<span class="good">IN</span>';
  const eligibility=x.shouldRebalance?'<span class="warn">ELIGIBLE</span>':(x.outside?'<span class="neutral">WAIT</span>':'<span class="good">HOLD</span>');
  const target=x.target?x.target.tickLower+' … '+x.target.tickUpper:'--';
  const btn='<button '+(a.disabled?'disabled ':'')+'data-pool="'+esc(x.poolId)+'" data-pos="'+esc(x.id)+'" data-pair="'+esc(x.pair)+'" class="'+(!a.disabled&&!control.dryRun?'danger':'')+'">'+esc(a.label)+'</button><div class="small muted action-note">'+esc(a.note)+'</div>';
  return '<tr><td>'+esc(x.pair)+'</td><td>'+status+'</td><td>'+esc(x.currentTick)+'<div class="small muted">'+esc(x.tickLower)+' … '+esc(x.tickUpper)+'</div></td><td>'+pct(x.excursionPct)+'</td><td>'+durationMin(x.outOfRangeElapsedMin)+'</td><td>'+esc(x.deepConfirmations)+'</td><td>'+eligibility+'<div class="small muted">'+esc(x.rebalanceReason||'')+'</div></td><td>'+esc(target)+'</td><td>'+usd(x.principalUsd)+'<div class="small muted">fees '+usd(x.unclaimedFeeUsd)+'</div></td><td>'+btn+'</td></tr>';
}
function setBusy(v){busy=v;$('scan').disabled=v;$('pause').disabled=v;$('refresh').disabled=v}
function render(){
  const state=snapshot||{},ctl=control||{},p=state.portfolio||{},pt=state.points||{},bot=state.bot||{};
  $('updated').textContent=state.generatedAt?dt(state.generatedAt):'no snapshot';
  $('mode').textContent=(ctl.dryRun?'DRY RUN':'LIVE')+' · '+(ctl.executionPaused?'PAUSED':'RUNNING')+' · v'+(bot.version||'?');
  $('mode').className='pill '+(ctl.dryRun?'warn':(ctl.liveReady?'bad':'warn'));
  $('armed').textContent=ctl.manualControlEnabled?'MANUAL ARMED':'MANUAL SAFE-OFF';
  $('armed').className='pill '+(ctl.manualControlEnabled?'warn':'good');
  $('valueUsd').textContent=usd(p.currentValueUsd);$('hodl').textContent='HODL baseline '+usd(p.hodlValueUsd);
  $('netPnl').textContent=usd(p.netPnlUsd);$('netPnl').className='value '+cls(p.netPnlUsd);$('excess').textContent='vs HODL '+usd(p.excessVsHodlUsd);
  $('il').textContent=usd(p.currentIlUsd);$('il').className='value '+cls(p.currentIlUsd);$('fees').textContent=usd(p.trackedFeeUsd);$('gas').textContent='Gas '+usd(p.gasUsd);
  const pos=p.positions||[];$('rangeCount').textContent=pos.length;$('oorCount').textContent=pos.filter(x=>x.outside).length+' out of range';
  $('execution').textContent=ctl.executionPaused?'PAUSED':(ctl.dryRun?'DRY RUN':(ctl.liveReady?'LIVE READY':'LIVE BLOCKED'));$('lastAction').textContent=bot.lastAction||'No action yet';
  $('guard').textContent=ctl.guard&&ctl.guard.runtimeReady?'READY':(ctl.guard&&ctl.guard.verifiedFlag?'VERIFY FAIL':'NOT ARMED');$('guard').className='value '+(ctl.guard&&ctl.guard.runtimeReady?'good':(ctl.guard&&ctl.guard.verifiedFlag?'bad':'warn'));$('guardAddr').textContent=ctl.guard&&ctl.guard.address?short(ctl.guard.address):'not configured';
  $('recovery').textContent=ctl.recoveryRequired?'REQUIRED':(ctl.executionBusy?'BUSY':'CLEAR');$('recovery').className='value '+(ctl.recoveryRequired?'bad':(ctl.executionBusy?'warn':'good'));$('recoveryDetail').textContent=ctl.activeRebalanceExecution?(ctl.activeRebalanceExecution.phase+' · '+(ctl.activeRebalanceExecution.pair||'')):'no pending execution';
  $('signer').innerHTML=yesNo(ctl.signerConfigured);$('liveWrites').innerHTML=yesNo(ctl.liveWrites);$('autoRedeploy').innerHTML=yesNo(ctl.autoRedeploy);$('manualControl').innerHTML=ctl.manualControlEnabled?'<span class="warn">ARMED</span>':'<span class="good">SAFE-OFF</span>';
  $('guardFlag').innerHTML=yesNo(ctl.guard&&ctl.guard.verifiedFlag);$('guardRuntime').innerHTML=(ctl.guard&&ctl.guard.runtimeReady)?'<span class="good">READY</span>':'<span class="bad">'+esc((ctl.guard&&ctl.guard.error)||'NOT READY')+'</span>';
  const healthy=(state.rpcHealth||[]).filter(x=>x.ok).length;$('rpc').textContent=healthy+'/'+(state.rpcHealth||[]).length;$('block').textContent=state.blockNumber||'--';
  const s=ctl.strategy||{},l=ctl.limits||{};$('policyScan').textContent=Math.round(Number(s.evaluationIntervalMs||0)/60000)+' min';$('policyDeep').textContent=pct(s.shallowThresholdPct);$('policyWait').textContent=num(s.maxWaitMin)+' min';$('policyConfirm').textContent=num(s.deepConfirmationsRequired);$('policyWidth').textContent=num(s.tightWidthBps)+' bps';
  $('slippage').textContent=num(l.withdrawSlippageBps)+' / '+num(l.swapSlippageBps)+' / '+num(l.depositSlippageBps)+' bps';$('maxGas').textContent=num(l.maxGasGwei)+' gwei';
  $('points').textContent=num(pt.estimatedTotal);$('pointsNote').textContent='Actual baseline '+num(pt.actualBaseline)+' + estimated delta '+num(pt.estimatedDelta);
  $('positions').innerHTML=pos.map(positionRow).join('')||'<tr><td colspan="10" class="muted">No tracked positions</td></tr>';
  const cd=Math.max(0,Math.ceil((Number(ctl.topologyCooldownUntil||0)-Date.now())/1000));if(cd>0)$('lastAction').textContent+=' · topology cooldown '+cd+'s';
  const b=$('liveBanner');
  if(ctl.recoveryRequired){b.style.display='block';b.className='banner bad';b.textContent='RECOVERY REQUIRED：已有 capital-moving execution 未完成。禁止新的 rebalance，先檢查 receipts / balances。'}
  else if(!ctl.dryRun&&ctl.liveReady&&ctl.manualControlEnabled){b.style.display='block';b.className='banner bad';b.textContent='LIVE ARMED：Manual Rebalance 會送出真實鏈上交易。In-Range Hold、OOR policy、rate limit、atomic guard 仍不可繞過。'}
  else if(ctl.dryRun){b.style.display='block';b.className='banner good';b.textContent='DRY RUN：Manual Rebalance 只跑完整 preflight / planning，不會移動本金。'}
  else{b.style.display='none'}
  $('pause').textContent=ctl.executionPaused?'Resume execution':'Pause new execution';
  $('pause').title='Pause prevents new rebalance starts. It does not interrupt an already-started capital-moving state machine.';
}
async function load(){const results=await Promise.all([api('/api/state'),api('/api/control/status'),api('/api/events?limit=250')]);snapshot=results[0];control=results[1];$('events').innerHTML=(results[2].events||[]).map(eventRow).join('');render()}
async function manualRebalance(poolId,positionId,pair){
  if(busy)return;
  const mode=control&&control.dryRun?'DRY-RUN':'LIVE';
  const message=mode+' manual rebalance for '+pair+'?\n\nThis action cannot bypass In-Range Hold or OOR policy. '+(mode==='LIVE'?'It WILL submit real on-chain transactions if every safety gate passes.':'No capital will move.');
  if(!confirm(message))return;
  setBusy(true);
  try{
    const result=await api('/api/control/rebalance',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({poolId:poolId,positionId:positionId,confirm:'REBALANCE'})});
    alert('Result: '+JSON.stringify(result.result||result));
    await load();
  }catch(e){alert('Manual rebalance blocked/failed: '+e.message);await load()}finally{setBusy(false)}
}
$('positions').onclick=e=>{const b=e.target.closest('button[data-pool]');if(!b||b.disabled)return;manualRebalance(b.dataset.pool,b.dataset.pos,b.dataset.pair)};
$('refresh').onclick=()=>load().catch(e=>alert(e.message));
$('scan').onclick=async()=>{if(busy)return;setBusy(true);try{await api('/api/control/scan',{method:'POST'});await load()}catch(e){alert('Scan failed: '+e.message)}finally{setBusy(false)}};
$('pause').onclick=async()=>{if(busy)return;setBusy(true);try{await api('/api/control/'+(control&&control.executionPaused?'resume':'pause'),{method:'POST'});await load()}catch(e){alert(e.message)}finally{setBusy(false)}};
$('savePoints').onclick=async()=>{await api('/api/points/baseline',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({points:Number($('actualPoints').value)})});$('actualPoints').value='';await load()};
$('addCashflow').onclick=async()=>{await api('/api/cashflow',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({usd:Number($('cashflow').value),note:$('cashflowNote').value})});$('cashflow').value='';$('cashflowNote').value='';await load()};
load().catch(e=>{console.error(e);$('updated').textContent='load failed: '+e.message});setInterval(()=>{if(!busy)load().catch(console.error)},10000);
</script>
</main></body></html>`;
}
