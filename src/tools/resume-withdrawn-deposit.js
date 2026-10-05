import fs from 'node:fs';
import net from 'node:net';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders } from '../rpc/providers.js';
import { StateStore } from '../state.js';
import { LedgerStore } from '../ledger.js';
import { FablesAdapter } from '../adapters/fables.js';
import { RebalanceExecutor } from '../adapters/executor.js';
import { walletGuardConfig } from '../execution/wallet-guard.js';
import { verifyWithdrawnInventory, resumeWithdrawnDeposit } from '../execution/withdrawn-deposit-recovery.js';
import { resolveWalletStorage } from './wallet-storage.js';
import { registerSensitiveValues, sanitize } from '../logger.js';
import { usdGAssetPriceFromPool } from '../analytics/allocation.js';

loadDotEnv();
const execute=process.argv.includes('--execute');
const base=loadConfig();
registerSensitiveValues([base.privateKey,...base.rpcUrls]);
const config={...base,...walletGuardConfig(base,base.walletAddress),
  ...(execute?{}:{privateKey:'',dryRun:true,enableLiveWrites:false})};
const storage=resolveWalletStorage(config);
const state=new StateStore(storage.stateFile),ledger=new LedgerStore(storage.dataDir);
const providers=createProviders(config);
const initial=state.getSetting('activeRebalanceExecution',null);
const proof={at:new Date().toISOString(),execute,wallet:config.walletAddress,journalId:initial?.id};
async function assertDashboardOffline(){
  await new Promise((resolve,reject)=>{
    const socket=net.createConnection({host:'127.0.0.1',port:config.dashboardPort||18087});
    socket.setTimeout(3000);
    socket.once('connect',()=>{socket.destroy();reject(Error('Stop the dashboard supervisor before offline recovery'));});
    socket.once('timeout',()=>{socket.destroy();reject(Error('Dashboard offline state is uncertain'));});
    socket.once('error',error=>{socket.destroy();error.code==='ECONNREFUSED'?resolve():reject(error);});
  });
}
try{
  if(execute)await assertDashboardOffline();
  const fables=new FablesAdapter(providers.readProvider,config);
  const entry=(await fables.registry.activePools()).find(p=>p.id.toLowerCase()===initial?.poolId?.toLowerCase());
  if(!entry)throw Error('Recovery pool is no longer registered');
  const pool={id:entry.id,key:{currency0:entry.key.currency0,currency1:entry.key.currency1,
    fee:Number(entry.key.fee),tickSpacing:Number(entry.key.tickSpacing),hooks:entry.key.hooks}};
  [pool.token0,pool.token1]=await Promise.all([fables.getToken(pool.key.currency0),fables.getToken(pool.key.currency1)]);
  const spot=await fables.readPoolState(pool);
  const price=usdGAssetPriceFromPool({...pool,state:spot},config.usdgAddress).priceUsdG;
  const executor=new RebalanceExecutor(providers.readProvider,providers.writeProvider,config,fables,ledger,
    address=>address.toLowerCase()===config.usdgAddress.toLowerCase()?1:price,state);
  proof.pair=`${pool.token0.symbol}/${pool.token1.symbol}`;
  proof.inventory=(await verifyWithdrawnInventory(executor,pool)).proof;
  if(!execute){
    const preflight=await executor.preflightCrossPoolSequence({pool,manualIdle:true,manualImmediate:true,
      manualMaxCostBps:executor.samePoolRebalanceMaxImpactBps(pool),routingPools:[pool]},pool);
    proof.ok=preflight.status==='full-sequence-simulated';proof.simulation={status:preflight.status,
      atomic:preflight.atomic,target:preflight.finalTarget,gas:preflight.simulatedGasUsed,
      balanceImpactBps:preflight.balanceImpactBps,planningBlockTag:preflight.planningBlockTag};
  }else{
    if(state.getSetting('executionPaused',false)!==true)throw Error('Offline recovery must begin paused');
    await assertDashboardOffline();
    state.setSetting('executionPaused',false);
    try{proof.result=await executor.runWalletWrite(()=>resumeWithdrawnDeposit(executor,pool));proof.ok=proof.result.status==='completed';}
    finally{state.setSetting('executionPaused',true);}
  }
}catch(error){proof.ok=false;proof.error=sanitize(error.shortMessage||error.message).slice(0,480);process.exitCode=1;}
finally{for(const p of new Set([...providers.rawProviders,providers.readProvider,providers.writeProvider]))p.destroy();}
fs.mkdirSync('artifacts',{recursive:true});
fs.writeFileSync(`artifacts/withdrawn-deposit-${execute?'execution':'preflight'}.json`,JSON.stringify(proof,null,2));
console.log(JSON.stringify(proof,null,2));
