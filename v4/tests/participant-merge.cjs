/* Public capability scope and compatibility are tested without source requests. */
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
for(const name of ['core','agent'])vm.runInThisContext(fs.readFileSync('v4/src/'+name+'.js','utf8'));
const now=Date.now(),owner=randomUUID(),run=randomUUID(),lease=randomUUID(),parent=randomUUID();
function fixture(mode){
 const calls=[],requests=[randomUUID(),randomUUID()],store={};
 const state={...CrowdCore.initial(),owner_id:owner,enabled:true,delivery_enabled:true,consent:CrowdCore.CONSENT,task:{id:1,lease_token:lease,lease_until:new Date(now+120000).toISOString(),capabilities:{batch_observe_v1:true,site_sdk_v1:true},node_run:{run_id:run,task_id:1}},outbox:requests.map((request,page)=>({request,kind:'structured',parent,task:1,lease,record:{kind:'comments',source:'page_response',run,page,total:2,items:[]}}))};
 const r={siteSDK:true,batchObservations:true,fastDelivery:true,now:()=>now,uuid:randomUUID,schedule:async()=>{},scheduleDelivery:async()=>{},cancel:async()=>{},storage:{get:async k=>store[k],set:async(k,v)=>store[k]=structuredClone(v)}};
 const api={rpc:async(name,p)=>{calls.push(name);if(name==='batch_observe'){
  if(mode==='missing')throw Object.assign(Error('function absent'),{code:'PGRST202'});
  if(mode==='unknown')throw Error('network lost');
  if(mode==='invalid')return {halted:false,receipts:[]};
  return {halted:false,receipts:p.p_pages.map(row=>({request:row.request,gate:'observed',run:row.data.run,page:row.data.page,source:'page_response',reward_eligible:false}))};
 }assert.equal(name,'structured_observe');return {request:p.p_request,gate:'observed',run:p.p_data.run,page:p.p_data.page,source:'page_response',reward_eligible:false};}};
 return {agent:new CrowdAgent(r,api),state,calls,requests,store};
}
(async()=>{
 let f=fixture();assert.equal(f.agent.captureScope(f.state),run);assert.equal(f.agent.captureMetrics(f.state),f.state.sdk_metrics);assert.equal(f.state.test_run,undefined);
 f.state.task.capabilities.site_sdk_v1=false;assert.equal(f.agent.captureScope(f.state),null);f.state.task.capabilities.site_sdk_v1=true;f.state.task.node_run.task_id=2;assert.equal(f.agent.captureScope(f.state),null);
 f=fixture();delete f.state.task.capabilities;assert.equal(f.agent.observationBatch(f.state),null,'unscoped public batch never inherits a private experiment grant');
 f=fixture();f.state.outbox[0].lease='old-lease';assert.equal(f.agent.observationBatch(f.state),null,'new task grant cannot enable a historical lease batch');
 f=fixture();await f.agent.flushOutbox(f.state,()=>{});assert.deepEqual(f.calls,['batch_observe']);assert.equal(f.state.outbox.length,0);
 f=fixture('missing');await f.agent.flushOutbox(f.state,()=>{});assert.deepEqual(f.calls,['batch_observe','structured_observe']);assert.equal(f.state.outbox[0].request,f.requests[1]);assert.equal(f.state.batch_endpoint_unavailable,true);await f.agent.flushOutbox(f.state,()=>{});assert.deepEqual(f.calls,['batch_observe','structured_observe','structured_observe']);
 for(const mode of ['unknown','invalid']){f=fixture(mode);await assert.rejects(()=>f.agent.flushOutbox(f.state,()=>{}));assert.deepEqual(f.calls,['batch_observe']);assert.deepEqual(f.state.outbox.map(x=>x.request),f.requests);assert.equal(f.state.pending_observation_batch.rows.length,2);}
 f=fixture();f.state.task.capabilities.batch_observe_v1=false;await f.agent.flushOutbox(f.state,()=>{});assert.deepEqual(f.calls,['structured_observe']);assert.equal(f.state.outbox.length,1);
 f=fixture();f.agent.api.rpc=async()=>({error:'test_completed',pilot_phase:'awaiting_acceptance'});const value=await f.agent.control(f.state,'control',()=>{});assert.equal(value.reason,'test_completed');assert.equal(f.state.pilot_waiting,true);assert.equal(f.state.enabled,true);assert.equal(f.state.outbox.length,2);
 f=fixture();f.agent.api.rpc=async()=>({error:'task_full',pilot_phase:'active'});await f.agent.control(f.state,'control',()=>{});assert.equal(f.state.assignment_refresh,true);assert.equal(f.state.enabled,true);
 f=fixture();f.agent.api.rpc=async()=>({error:'user_stopped',pilot_phase:'closed'});await f.agent.control(f.state,'control',()=>{});assert.equal(f.state.enabled,false);assert.equal(f.state.delivery_enabled,true);assert.equal(f.state.outbox.length,2);
 console.log('PASS scoped public SDK/batch, private isolation, definite-missing-only serial fallback, unknown/invalid ACK UUID preservation and pilot wait/close durable outbox');
})().catch(e=>{console.error(e);process.exitCode=1;});
