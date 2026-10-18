'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),path=require('node:path');
const ROOT=__dirname,SRC=process.argv[2]?path.resolve(process.argv[2]):path.join(ROOT,'../src');for(const n of ['core','agent','participant-session'])vm.runInThisContext(fs.readFileSync(path.join(SRC,n+'.js'),'utf8'));
function fixture(){const now=Date.now(),owner='fixture-owner',install=randomUUID(),ref='a'.repeat(64),calls=[],g={schema:'crowd-acceptance-extra1-v1',id:randomUUID(),task_id:19,installation_id:install,baseline_received:2,extra_limit:1,remaining:1,expires_at:new Date(now+3600000).toISOString()},data={};let health={status:'authenticated',expected_ref:ref,observed_ref:ref,checked_at:now},reply;
 const storage={get:async k=>structuredClone(data[k]),set:async(k,v)=>{data[k]=structuredClone(v);}};data.agent={...CrowdCore.initial(),owner_id:owner,enabled:true,delivery_enabled:true,consent:CrowdCore.CONSENT,received:2,history:['old-one','old-two'],pilot_phase:'awaiting_acceptance',pilot_waiting:true,last_error:'test_completed',phase:'idle',cursor:17,task_archives:[{task:{id:19},cursor:17}]};data['node-monitor:'+owner]={installation_id:install};
 const policy=()=>({version:1,ttl_ms:60000,allowed:true,paused:false,reason:null,wait_ms:0,gap_ms:15000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:0,comment:0,scroll:0},pilot_phase:'awaiting_acceptance',acceptance_supplement:structuredClone(g)});
 const r={storage,owner:async()=>owner,now:()=>now,uuid:randomUUID,expectedPrincipal:async()=>ref,sourceHealth:async()=>{calls.push({name:'health'});return structuredClone(health);},retireSupplementPage:async()=>{},schedule:async()=>{},scheduleDelivery:async()=>{},cancelDelivery:async()=>{},cancel:async()=>{},random:()=>.5};
 const api={rpc:async(name,p)=>{calls.push({name,p});if(name==='guard')return policy();if(name==='claim')return {acceptance_supplement:structuredClone(g),task:{id:19,target:3,received:2,remaining_today:1,query:'original',lease_token:'new-exact-lease',lease_until:new Date(now+3600000).toISOString(),known_note_ids:['old-one','old-two']}};if(name==='submit')return reply||{request:p.p_request,gate:'received',inserted:true,duplicate:false,task_received:3};throw Error('unexpected_rpc');}};
 const agent=new CrowdAgent(r,api);return {agent,r,g,data,calls,policy,set health(v){health=v;},set reply(v){reply=v;},now};}
async function admit(f){let s=await f.agent.read();assert.equal(await f.agent.acceptSupplement(s,f.policy(),()=>{}),true);await f.agent.save(s);return s;}

function batch(){const f=fixture();f.g.schema='crowd-acceptance-batch-v1';delete f.g.expires_at;f.g.extra_limit=20;f.g.remaining=20;f.g.target=22;let received=2;const receipts=new Map();const original=f.agent.api.rpc;
 f.agent.api.rpc=async(name,p)=>{if(name==='claim'){f.calls.push({name,p});return {acceptance_supplement:{...f.g,remaining:22-received},task:{id:19,target:22,received,remaining_today:22-received,query:'original',lease_token:'new-exact-lease',lease_until:new Date(f.now+3600000).toISOString(),known_note_ids:['old-one','old-two']}};}
 if(name==='submit'){f.calls.push({name,p});if(receipts.has(p.p_request))return receipts.get(p.p_request);const r={request:p.p_request,gate:'received',inserted:true,duplicate:false,task_received:++received};receipts.set(p.p_request,r);return r;}return original(name,p);};return f;}


(async()=>{
 for(const mode of ['no-task','action','retry','existing-task','unknown-claim','wrong-task']){
  const f=batch();f.g.remaining=15;Object.assign(f.data.agent,{timing_version:1,received:7,enabled:true,last_error:null,pilot_waiting:false,next_at:f.now+300000,phase:'idle',wait_kind:null,action_not_before:0,seen:['old-rejected'],acceptance_supplement:{...f.g,state:'admitted',baseline_history:['old-one','old-two']}});
  if(mode==='action'){f.data.agent.wait_kind='action';f.data.agent.action_not_before=f.now+300000;}
  if(mode==='retry'){f.data.agent.wait_kind='retry';f.data.agent.retry_at=f.now+300000;}
  const task={id:19,target:22,received:7,remaining_today:15,query:'original',lease_token:'second-lease',lease_start_received:7,lease_until:new Date(f.now+3600000).toISOString(),known_note_ids:['old-one','old-two']};
  if(mode==='existing-task')f.data.agent.task=structuredClone(task);
  const rpc=f.agent.api.rpc;f.agent.api.rpc=async(n,p)=>{if(n==='status')return {participant:{status:'approved'}};if(n==='claim'){f.calls.push({name:n,p});if(mode==='unknown-claim')throw Error('network_unknown');return {acceptance_supplement:structuredClone(f.g),task:{...task,id:mode==='wrong-task'?20:19}};}return rpc(n,p);};
  await f.agent.start(false);let s=await f.agent.read();assert.equal(s.next_at,f.now+300000,'normal start itself does not erase old deadline');
  await f.agent.step(()=>{},new AbortController().signal);s=await f.agent.read();
  if(mode==='no-task'){assert.equal(s.next_at,f.now);assert.equal(s.task.received,7);assert.equal(s.task.lease_start_received,7);assert.deepEqual(s.seen,['old-rejected']);assert.equal(s.acceptance_supplement.remaining,15);}
  else{assert(s.next_at>=f.now+300000,'action/retry/old task/unknown do not clear deadline: '+mode);if(mode==='action')assert.equal(s.action_not_before,f.now+300000);if(mode==='retry')assert.equal(s.retry_at,f.now+300000);}
  assert.equal(f.calls.filter(c=>c.name==='claim').length,1);assert(!f.calls.some(c=>['submit','search','scroll'].includes(c.name)));
 }
 console.log('PASS actual start(false) retains deadline until exact batch claim; no-task valid newlease7 releases only stale wait; action/retry/existing task/UNKNOWN/wrongtask preserve; no source actions');
})().catch(e=>{console.error(e);process.exitCode=1;});
