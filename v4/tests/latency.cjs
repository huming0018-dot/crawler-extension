'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
for(const name of ['core','agent'])vm.runInThisContext(fs.readFileSync('v4/src/'+name+'.js','utf8'));
const C=CrowdCore;
function fixture(mode={}) {
 let now=Date.now(),state,blockedSave,releaseSave,submitted=[],actions=[],failure=mode.fail;
 const id='a'.repeat(24),other='b'.repeat(24);
 const record={schema_version:4,standard:{platform:'xiaohongshu',note_id:id,url:C.HOST+'/explore/'+id,title:'餐厅',captured_at:new Date(now).toISOString(),published_at:null,author_display:null,like_count:1,collect_count:null,comment_count:0,view_count:null},extra:{author_opinion_quotes:[],comments:{items:[],coverage:'visible_loaded_only',complete:false,captured_count:0,loaded_count:0,omitted_count:0,truncated:false,more_available:false}},evidence:{text:'餐厅正文',original_length:4,truncated:false,parser_version:C.VERSION,source:'rendered_public_dom'}};
 state={...C.initial(),enabled:true,consent:C.CONSENT,profiles:false,phase:'note',task:{id:1,query:'餐厅',target:mode.target||1,received:0,lease_token:'lease',lease_until:new Date(now+1e7).toISOString()},note_id:id,note_url:record.standard.url,loaded_at:now-100000,dwell_ms:45000,scrolls:2,last_tick:now,candidates:[C.HOST+'/explore/'+other]};
 const saveEntered=new Promise(resolve=>blockedSave=resolve);
 const r={splitCapture:true,storage:{get:async()=>structuredClone(state),set:async(_,v)=>{
  state=structuredClone(v);
  if(mode.stopAtSave && state.outbox.length && !releaseSave){blockedSave();await new Promise(resolve=>releaseSave=resolve);}
 }},now:()=>now,random:()=>0,uuid:crypto.randomUUID,schedule:async()=>{},cancel:async()=>{},close:async()=>actions.push('close'),open:async()=>actions.push('open'),probe:async kind=>{actions.push(kind);return {ready:true,record:structuredClone(record)};}};
 const api={rpc:async(name,p)=>{
  actions.push(name==='guard'?'guard:'+p.p_action:name);
  if(name==='guard'){const denied=mode.denyDetail&&p.p_action==='detail';return {version:1,observations:1,ttl_ms:600000,paused:false,allowed:!denied,reason:denied?'action_gap':null,wait_ms:denied?30000:0,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:1,comment:0,scroll:2}};}
  if(name==='submit'||name==='observe') {
   assert.equal(state.outbox[0].request,p.p_request,'persist before RPC');
   if(name==='observe')assert.equal(state.received,1,'base ACK before supplement');
   submitted.push(structuredClone(p));
   if(failure){failure=false;throw Error('offline');}
   return name==='submit'?{request:p.p_request,gate:'received',inserted:true,duplicate:false,task_received:1}:{request:p.p_request,gate:'observed'};
  }
  if(name==='finish')return {status:'complete',received:1};
  throw Error('unexpected '+name);
 }};
 return {r,api,get state(){return state;},actions,submitted,saveEntered,release:()=>releaseSave(),advance:()=>{now=state.outbox[0].retry_at+1;}};
}
(async()=>{
 const success=fixture();await new CrowdAgent(success.r,success.api).tick();
 assert.equal(success.state.received,1);assert.equal(success.state.outbox.length,0);assert.equal(success.state.task,null,'finish does not wait an empty profile tick');
 assert.equal(success.actions.includes('profile_claim'),false);assert.equal(success.actions.includes('comments'),false);
 assert.deepEqual(success.actions.filter(x=>['submit','observe','finish'].includes(x)),['submit','observe','finish']);
 const denied=fixture({target:2,denyDetail:true});await new CrowdAgent(denied.r,denied.api).tick();
 assert.equal(denied.state.received,1);assert.equal(denied.state.last_error,'action_gap');assert.equal(denied.actions.includes('open'),false,'ready local transitions still obey server action gap');
 const retry=fixture({fail:true});await new CrowdAgent(retry.r,retry.api).tick();
 const item=structuredClone(retry.state.outbox[0]);assert.equal(retry.state.received,0);assert.equal(retry.submitted.length,1);
 await new CrowdAgent(retry.r,retry.api).tick();assert.equal(retry.submitted.length,1,'restart cannot bypass retry_at');
 retry.advance();await new CrowdAgent(retry.r,retry.api).tick();assert.equal(retry.submitted[1].p_request,item.request);assert.deepEqual(retry.submitted[1].p_record,item.record);assert.equal(retry.state.received,1);
 const stopped=fixture({stopAtSave:true}),agent=new CrowdAgent(stopped.r,stopped.api);
 const tick=agent.tick();await stopped.saveEntered;const stop=agent.stop();stopped.release();await Promise.all([tick,stop]);
 assert.equal(stopped.submitted.length,0,'stop between persistence and send cancels immediate upload');assert.equal(stopped.state.enabled,false);assert.equal(stopped.state.outbox.length,1,'stop preserves queued evidence');
 console.log('PASS latency: immediate durable submit, base ACK before supplement, no disabled profile tick, immediate finish, server denial respected, restart/backoff stable UUID, stop at persistence preserves evidence');
})().catch(e=>{console.error(e);process.exitCode=1;});
