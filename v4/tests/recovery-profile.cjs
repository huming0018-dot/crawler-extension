// Actual immutable 58 Core/Agent with the recovery-only guard; no source or cloud I/O.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),cp=require('node:child_process'),path=require('node:path');
const baseline=process.argv[2];if(!baseline)throw Error('Pass exact frozen participant 58 ZIP');
const read=name=>cp.execFileSync('/usr/bin/unzip',['-p',baseline,name],{encoding:'utf8'});
const uid='00000000-0000-4000-8000-000000000001';
async function fixture(extra={}){
 const state={enabled:true,delivery_enabled:true,owner_id:uid,consent:'crowd-public-v4',run_generation:1,timing_version:1,
  outbox:[{request:'original-request',task:13,lease:'original-lease',kind:'structured',record:{source:'page_response',page:0}}],
  task:{id:13,node_run:{run_id:'original-run'}},accepted_parents:[{request:'original-parent'}],...extra};
 const values={session:{user:{id:uid}},['agent:'+uid]:state,['node-monitor:'+uid]:{installation_id:'original-installation',seq:41,rows:[{event_id:'original-event'}]},other_key:{retain:true}};
 const counters={start:0,step:0,stop:0,flushOutbox:0};let writes=0;
 const ctx=vm.createContext({URL,URLSearchParams,console});vm.runInContext(read('src/core.js'),ctx);vm.runInContext(read('src/agent.js'),ctx);
 const storage=ctx.CrowdCore.accountStorage({get:async key=>structuredClone(values[key]),set:async(key,value)=>{writes++;values[key]=structuredClone(value);}});
 for(const method of Object.keys(counters))ctx.CrowdAgent.prototype[method]=async function(){counters[method]++;return 'original-'+method;};
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/recovery-guard.js'),'utf8'),ctx);
 const agent=new ctx.CrowdAgent({storage,owner:async()=>uid,uuid:()=> 'synthetic-rating-id',now:()=>1000,cancel:async()=>{},cancelDelivery:async()=>{}},{});
 return {agent,values,counters,writes:()=>writes,state};
}
(async()=>{
 for(const extra of [{sdk_unknown:true},{sdk_pending:{status:'sending',id:'original-id'}},{sdk_pending:{status:'unknown'}},{pending_observation_batch:{rows:[{request:'original-request',snapshot:'original-bytes'}]}},{enrichment:{sdk_pending:{status:'unknown',id:'nested-id'}}},{work_slots:[{enrichment:{sdk_pending:{status:'sending',id:'slot-id'}}}]}]){
  const f=await fixture(extra),before=JSON.stringify(f.values);
  const status=await f.agent.read();assert.equal(status.enabled,false);assert.equal(status.delivery_enabled,false);assert.equal(status.recovery_hold,true);
  await assert.rejects(f.agent.start(),/pool_recovery_required/);assert.equal(await f.agent.step(()=>{},null,false),false);assert.equal(await f.agent.step(()=>{},null,true),false);
  await assert.rejects(f.agent.flushOutbox(f.state,()=>{},null),/pool_recovery_required/);await f.agent.stop();
  await assert.rejects(f.agent.save(status),/pool_recovery_required/);
  await assert.rejects(f.agent.save({...status,recovery_hold:false,sdk_unknown:false,sdk_pending:null,pending_observation_batch:null,enrichment:null,work_slots:[]}),/pool_recovery_required/);
  await assert.rejects(f.agent.queueRating(1,5,'synthetic rating reason'),/pool_recovery_required/);
  assert.equal(JSON.stringify(f.values),before);assert.equal(f.writes(),0);assert.deepEqual(f.counters,{start:0,step:0,stop:0,flushOutbox:0});
 }
 const f=await fixture({sdk_pending:{status:'accepted'},sdk_unknown:false}),nodeBefore=JSON.stringify(f.values['node-monitor:'+uid]);
 for(const method of ['start','step','flushOutbox','stop'])assert.equal(await f.agent[method](f.state),'original-'+method);
 const snapshot=await f.agent.read();await f.agent.save(snapshot);assert.equal(JSON.stringify(f.values['node-monitor:'+uid]),nodeBefore);assert.deepEqual(f.values['agent:'+uid].outbox,f.state.outbox);assert.equal(f.values['agent:'+uid].task.node_run.run_id,'original-run');assert.deepEqual(f.values['agent:'+uid].accepted_parents,f.state.accepted_parents);
 console.log('PASS recovery profile: six unresolved 60 shapes block start/source/delivery/stop mutation; original storage byte-equivalent; resolved state delegates baseline; identity, node log and outbox preserved');
})().catch(error=>{console.error(error);process.exit(1);});
