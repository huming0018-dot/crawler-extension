'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
for(const file of ['core','agent'])vm.runInThisContext(fs.readFileSync('v4/src/'+file+'.js','utf8'));
(async()=>{
 let now=Date.now(),mode={},calls=0;
 const item={request:crypto.randomUUID(),task:1,lease:crypto.randomUUID(),record:{standard:{note_id:'a'.repeat(24),captured_at:new Date(now).toISOString()},evidence:{text:'不可丢失的原始证据'}}};
 let state={...CrowdCore.initial(),consent:CrowdCore.CONSENT,enabled:true,outbox:[structuredClone(item)]};
 const runtime={storage:{get:async()=>structuredClone(state),set:async(k,v)=>state=structuredClone(v)},now:()=>now,schedule:async()=>{},cancel:async()=>{},close:async()=>{}};
 const api={rpc:async name=>{if(name==='guard')throw Error('offline control');assert.equal(name,'submit');calls++;return mode;}};
 for(const value of [null,{},[],{ok:true},{gate:'received'},
   {request:item.request,gate:'received',inserted:true,duplicate:true,task_received:1},
   {request:'other',gate:'received',inserted:true,duplicate:false,task_received:1},
   {request:item.request,verdict:'received',inserted:true,duplicate:false,task_received:1},
   {error:'new_unknown_error'}]){
  mode=value;await new CrowdAgent(runtime,api).tick();
  assert.equal(state.outbox.length,1);assert.equal(state.outbox[0].request,item.request);assert.deepEqual(state.outbox[0].record,item.record);
  assert.equal(state.received,0);assert.equal(state.rejected.length,0);assert.equal(state.last_error,'invalid_receipt');
  const before=calls;await new CrowdAgent(runtime,api).tick(true);assert.equal(calls,before,'restart respects upload backoff');
  now=state.outbox[0].retry_at+1;
 }
 mode={error:'daily_quota',reset_at:new Date(now+900000).toISOString(),retry_after_ms:600000};
 await new CrowdAgent(runtime,api).tick();assert.equal(state.outbox[0].retry_at,now+600000);
 assert.equal(state.outbox[0].request,item.request);assert.deepEqual(state.outbox[0].record,item.record);
 now=state.outbox[0].retry_at+1;
 mode={request:item.request,gate:'received',inserted:true,duplicate:false,task_received:1};
 await new CrowdAgent(runtime,api).tick();assert.equal(state.outbox.length,0);assert.equal(state.received,1);assert.equal(state.last_error,null);
 assert.equal(CrowdCore.quotaRetry({},now),now+3600000,'older server fallback is bounded');
 assert.equal(CrowdCore.quotaRetry({retry_after_ms:Infinity,reset_at:'bad'},now),now+3600000);
 assert.equal(CrowdCore.quotaRetry({reset_at:new Date(now+900000).toISOString()},now),now+900000);
 console.log('PASS recovery: missing/mismatched/unknown receipts retain original evidence+UUID across restarts; quota parks to server reset; exact acknowledged record leaves queue once');
})().catch(e=>{console.error(e);process.exitCode=1;});
