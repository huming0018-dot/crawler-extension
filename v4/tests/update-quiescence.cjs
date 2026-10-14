'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const guard=fs.readFileSync('v4/src/background.js','utf8').match(/isBusy:(async\(\)=>\{const s=await agent.read\(\);return [^}]+\}),version:/)?.[1];
assert(guard,'test the actual updater busy guard');
const stopBody=fs.readFileSync('v4/src/background.js','utf8').match(/if\(message.type==='stop'\)\{([\s\S]+?)\n  \}/)?.[1];
assert(stopBody);const trackStop=new Function('agent','operation',stopBody+';return agent.pendingStop;');
function fixture(){
 const state={enabled:false,work_slots:[{id:'original-slot',request:'unknown-original'}],outbox:[{request:'unknown-original',record:{body:'original'}}]};
 const agent={read:async()=>state},kol={},context=vm.createContext({agent,kol,pendingCommands:0});
 vm.runInContext(fs.readFileSync('v4/src/updater.js','utf8'),context);
 const data={updater_enabled:true,updater_protocol:2},calls=[],alarms=[];
 const updater=new context.CrowdUpdater({agent,storage:{get:async k=>data[k],set:async(k,v)=>{data[k]=v}},version:'4.2.15',releaseHash:async()=>'a'.repeat(64),isBusy:vm.runInContext('('+guard+')',context),chrome:{runtime:{sendNativeMessage:async(_,m)=>{calls.push(m);return {status:m.action==='ack'?'ready':m.action==='settings'?'configured':'current',version:'4.2.15',protocol:2};}},alarms:{create:async(k,v)=>alarms.push([k,v]),get:async()=>null,clear:async()=>{}}}});
 return {state,agent,kol,context,data,calls,alarms,updater};
}
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));};
(async()=>{
 const stopped=fixture(),original=JSON.stringify(stopped.state);await stopped.updater.check();
 assert.equal(stopped.calls.length,1,'stopped checkpoint cannot permanently block software update');
 assert.equal(stopped.calls[0].action,'apply');assert.equal(JSON.stringify(stopped.state),original,'checkpoints/outbox/UUIDs remain unchanged');
 const prefs=fixture();prefs.data.updater_enabled=false;await prefs.updater.setEnabled(true);assert.equal(prefs.data.updater_enabled,true);assert.equal(JSON.stringify(prefs.state),original,'stopped checkpoints cannot block opt-in either');
 for(const mutate of [f=>f.state.enabled=true,f=>f.agent.pendingStop=Promise.resolve(),f=>f.agent.stopping=true,f=>f.agent.stopActive=Promise.resolve(),f=>f.agent.poolJobs=new Map([['job',Promise.resolve()]]),f=>f.kol.active=Promise.resolve(),f=>f.context.pendingCommands=1]){
  const f=fixture();mutate(f);assert.equal((await f.updater.check()).blocked,'executor_busy');assert.equal(f.calls.length,0,'active work never reaches native apply');
 }
 const writing=fixture();let doneActive,doneWrite;
 writing.agent.active=new Promise(r=>doneActive=r);writing.agent.writeTail=new Promise(r=>doneWrite=r);
 const check=writing.updater.check();await settle();assert.equal(writing.calls.length,0);
 assert.equal(writing.agent.maintenance,true,'new ticks/start blocked while settling existing writer');
 doneActive();await settle();assert.equal(writing.calls.length,0,'durable writes also finish before apply');
 doneWrite();await check;assert.equal(writing.calls.length,1);assert.equal(writing.agent.maintenance,false);
 const race=fixture();let release;race.agent.active=new Promise(r=>release=r);
 const raced=race.updater.check();await settle();race.agent.stopping=true;release();
 assert.equal((await raced).blocked,'executor_busy');assert.equal(race.calls.length,0,'stop starting during settlement is caught by second guard');
 for(const route of ['apply','bootstrap','rollback']){
  const f=fixture();let nativeDone,stopDone,reloads=0;
  f.updater.chrome.runtime.reload=()=>{reloads++;};
  f.updater.chrome.runtime.sendNativeMessage=async(_,m)=>{
   if(route==='rollback'&&m.action==='apply')return {status:'error',error:'version_mismatch'};
   await new Promise(r=>nativeDone=r);return {status:route==='rollback'?'rolled_back':'pending_reload',version:'4.2.16'};
  };
  const update=route==='bootstrap'?f.updater.bootstrap():f.updater.check();await settle();
  const stopping=new Promise(r=>stopDone=r).finally(()=>{f.agent.pendingStop=null;});f.agent.pendingStop=stopping;
  nativeDone();await settle();assert.equal(reloads,0,route+' cannot interrupt Stop before actor.stop has even been entered');
  stopDone();await update;assert.equal(reloads,1,route+' reload follows durable Stop');
 }
 for(const failure of ['stop','write','earlier-stop']){
  const f=fixture();let nativeDone,rejectStop,reloads=0;
  f.updater.chrome.runtime.reload=()=>reloads++;
  f.updater.chrome.runtime.sendNativeMessage=async()=>{await new Promise(r=>nativeDone=r);return {status:'pending_reload',version:'4.2.16'};};
  const update=f.updater.check();await settle();
  if(failure==='earlier-stop')f.agent.updateStopFailed=true;
  else {
   const failed=new Promise((_,r)=>rejectStop=r);failed.catch(()=>{});
   if(failure==='stop')f.agent.pendingStop=failed;else f.agent.writeTail=failed;
  }
  nativeDone();await settle();if(rejectStop)rejectStop(Error('storage_write_failed'));
  await update;assert.equal(reloads,0,failure+' failure cannot be mistaken for a durable stop');assert.equal(f.data.updater_status.error,'executor_busy');
 }
 const merged=fixture();let failFirst,finishSecond,reloads=0;
 merged.updater.chrome.runtime.reload=()=>reloads++;
 const first=trackStop(merged.agent,new Promise((_,reject)=>failFirst=reject));first.catch(()=>{});
 const second=trackStop(merged.agent,new Promise(resolve=>finishSecond=resolve));second.catch(()=>{});
 failFirst(Error('first_stop_failed'));await settle();assert(merged.agent.pendingStop,'first failure cannot release the second Stop');
 const third=trackStop(merged.agent,Promise.resolve());third.catch(()=>{});
 const reload=merged.updater.reloadSettled().then(()=>null,error=>error);await settle();assert.equal(reloads,0);
 finishSecond();const error=await reload;assert.equal(error.message,'executor_busy');assert.equal(reloads,0);assert.equal(merged.agent.updateStopFailed,true);
 await Promise.allSettled([first,second,third]);
 await trackStop(merged.agent,Promise.resolve());assert.equal(merged.agent.updateStopFailed,false,'fresh successful Stop recovers after all earlier Stops ended');
 await merged.updater.reloadSettled();assert.equal(reloads,1);
 console.log('PASS updater quiescence: stopped checkpoint preserved, active/stop/pool/KOL/command guards, actor and writes drained, second guard race');
})().catch(e=>{console.error(e);process.exitCode=1});
