'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
for(const name of ['core','agent','pool'])vm.runInThisContext(fs.readFileSync('v4/src/'+name+'.js','utf8'));
const C=CrowdCore, settle=async()=>{for(let i=0;i<16;i++)await new Promise(r=>setImmediate(r));};
function fixture(mode='normal',batch=true){
 let now=Date.parse('2026-10-12T09:00:00Z'),gap=0;
 const ids={13:'a'.repeat(24),14:'b'.repeat(24)}, totals={13:127,14:179},expanded=new Map(),slots=new Map(),claims=[],visits=[],actions=[],finished=[],pages=[],sent=[];
 const tasks=Object.fromEntries([13,14].map(id=>[id,{id,query:id===13?'上海拉面':'上海咖啡',platform:'xiaohongshu',target:1,received:0,remaining_today:4,comments_capture:true,acceptance_goal:2,...(batch?{acceptance_task_ids:[13,14]}:{}),lease_token:'lease-'+id,lease_until:new Date(now+3600000).toISOString()}]));
 const store={agent:{...C.initial(),timing_version:1,parallelism:2,consent:C.CONSENT,phase:'search_done',task:structuredClone(tasks[13]),candidates:[C.HOST+'/explore/'+ids[13]],last_tick:now}};
 const record=id=>{const n=Math.min(totals[id],(expanded.get(id)||0)*20);return {schema_version:4,standard:{platform:'xiaohongshu',note_id:ids[id],url:C.HOST+'/explore/'+ids[id],title:tasks[id].query,captured_at:new Date(now).toISOString(),published_at:null,author_display:null,like_count:1,collect_count:null,comment_count:totals[id]},extra:{author_opinion_quotes:[],comments:{items:Array.from({length:n},(_,i)=>({key:'comment-'+(i+1),comment_id:id+'-'+i,parent_key:i%2?'comment-'+i:null,parent_comment_id:i%2?id+'-'+(i-1):null,is_reply:!!(i%2),author_display:'reader',text:'comment-'+i,original_length:('comment-'+i).length,truncated:false,like_count:0,published_label:null})),coverage:'visible_loaded_only',complete:false,captured_count:n,loaded_count:n,truncated:false,more_available:n<totals[id],progress:{top:100,height:200,client:100,at_end:n===totals[id],expand_count:n<totals[id]?1:0,end_marker:n===totals[id],empty:false}}},evidence:{text:tasks[id].query+'真实正文',original_length:(tasks[id].query+'真实正文').length,truncated:false,parser_version:C.VERSION,source:'rendered_public_dom'}};};
 if(mode==='repair'){for(const id of [13,14]){tasks[id].received=1;tasks[id].repair_only=true;tasks[id].repair_notes=[{parent:crypto.randomUUID(),record:record(id)}];}store.agent.task=structuredClone(tasks[13]);}
 const r={localTest:true,owner:async()=> 'own',poolAllowed:async()=>true,fastCapture:true,splitCapture:true,storage:{get:async k=>structuredClone(store[k]),set:async(k,v)=>{store[k]=structuredClone(v);}},now:()=>now,random:()=>0,uuid:crypto.randomUUID,schedule:async()=>{},cancel:async()=>{},scheduleDelivery:async()=>{},cancelDelivery:async()=>{},close:async()=>{},closeLegacy:async()=>{},closeSlot:async()=>{},open:async(url,_,slot)=>{visits.push(url);if(slot)slots.set(slot,Object.entries(ids).find(([,n])=>url.includes(n))[0]*1);},probe:async(action,slot)=>{
  if(action==='search')return {ready:true,keyword:store.agent.task.query,links:[C.HOST+'/explore/'+ids[store.agent.task.id]]};
  if(action==='comments'){const id=slots.get(slot);expanded.set(id,(expanded.get(id)||0)+1);return {ready:true};}
  return {ready:true,record:record(slots.get(slot)||store.agent.task.id)};
 }};
 const api={rpc:async(name,p)=>{
  if(name==='status')return {participant:{status:'approved'}};
  if(name==='claim'){
   claims.push(p.p_task);if(mode==='quota'&&p.p_task===14)return {error:'daily_quota'};
   if(mode==='missing'&&p.p_task===14)return {task:null};
   const task=structuredClone(tasks[mode==='finished'&&p.p_task===14?13:p.p_task||13]);if(p.p_task===14&&mode==='foreign')task.id=99;
   if(p.p_task===14&&mode==='changed')task.acceptance_task_ids=[14,13];
   return {task};
  }
  if(name==='guard'){
   const risk=mode==='captcha'&&p.p_task===14,allowed=!risk&&now>=gap;
   if(p.p_action!=='control'&&allowed){actions.push({task:p.p_task,action:p.p_action,at:now});gap=now+2000;}
   return {version:1,observations:1,ttl_ms:600000,paused:false,allowed,reason:risk?'captcha':allowed?null:'action_gap',wait_ms:risk?1800000:Math.max(0,gap-now),action_wait_ms:Math.max(0,gap-now),gap_ms:2000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:0,comment:0,scroll:0}};
  }
  if(name==='submit'){tasks[p.p_task].received++;sent.push(p);return {request:p.p_request,gate:'received',inserted:true,duplicate:false,task_received:tasks[p.p_task].received};}
  if(name==='comments_observe'){pages.push(structuredClone(p));return {request:p.p_request,gate:'observed'};}
  if(name==='observe')return {request:p.p_request,gate:'observed'};
  if(name==='finish'){finished.push(p.p_task);return {status:'complete',received:tasks[p.p_task].received};}
  throw Error(name);
 }};
 return {r,api,store,tasks,claims,visits,actions,finished,pages,sent,expanded,advance:()=>{now+=1000;}};
}
async function run(f){const agent=new CrowdAgent(f.r,f.api);await agent.start(true);for(let i=0;i<700&&f.store.agent.enabled;i++){await agent.tick();await settle();f.advance();}await settle();return agent;}
(async()=>{
 const f=fixture();await run(f);assert.equal(f.store.agent.last_error,'test_completed',JSON.stringify(f.store.agent));assert.deepEqual([...new Set(f.claims)],[13,14]);assert.ok(!f.claims.includes(null));assert.deepEqual(f.finished,[13,14]);assert.equal(f.sent.length,2);assert.equal(f.store.agent.test_run.accepted.length,2);assert.equal(f.store.agent.outbox.length,0);assert.equal(f.store.agent.enabled,false);
 for(const [id,total]of [[13,127],[14,179]]){const captured=f.pages.filter(p=>p.p_task===id);assert.equal(captured.length,Math.ceil(total/50));assert.ok(captured.every(p=>p.p_data.summary.complete));assert.equal(captured.flatMap(p=>p.p_data.items).length,total);assert.ok(f.expanded.get(id)>4);}
 for(let i=1;i<f.actions.length;i++)assert.ok(f.actions[i].at-f.actions[i-1].at>=2000);
 for(const mode of ['foreign','changed','missing','quota','finished']){const x=fixture(mode);await run(x);assert.equal(x.sent.length,1,mode);assert.equal(x.visits.filter(url=>url.includes('b'.repeat(24))).length,0,mode);assert.ok(!x.claims.includes(null),mode);assert.equal(x.store.agent.enabled,false,mode);assert.equal(x.store.agent.last_error,mode==='quota'?'test_quota':'test_no_task',mode);}
 const risk=fixture('captcha');const a=await run(risk);assert.equal(risk.sent.length,1);assert.equal(risk.actions.filter(x=>x.task===14).length,0);const preserved={request:crypto.randomUUID(),kind:'rating',proof:1,score:4,rating_reason:'保留用户原始评价记录'};risk.store.agent.outbox=[preserved];await a.stop('user_stopped');assert.equal(risk.store.agent.enabled,false);assert.equal(risk.store.agent.outbox[0].request,preserved.request);
 const repair=fixture('repair');await run(repair);assert.equal(repair.store.agent.last_error,'test_completed',JSON.stringify(repair.store.agent));assert.deepEqual([...new Set(repair.claims)],[13,14],JSON.stringify({run:repair.store.agent.test_run,task:repair.store.agent.task,finished:repair.finished,pages:repair.pages.length,visits:repair.visits}));assert.equal(repair.sent.length,0);assert.equal(repair.store.agent.test_run.accepted.length,0);assert.equal(repair.store.agent.outbox.length,0);for(const id of[13,14])assert.ok(repair.pages.filter(p=>p.p_task===id).every(p=>p.p_data.summary.complete));assert.equal(repair.store.agent.enabled,false);
 const oneRepair=fixture('repair',false);await run(oneRepair);assert.equal(oneRepair.store.agent.last_error,'test_completed');assert.equal(oneRepair.sent.length,0);assert.ok(!oneRepair.claims.includes(14));
 const legacy=fixture('normal',false);await run(legacy);assert.equal(legacy.sent.length,1);assert.equal(legacy.store.agent.last_error,'test_quota');assert.ok(!legacy.claims.includes(14));
 console.log('PASS bounded explicit two-query tasks, 127/179 paged captures including replies, >4 expansions, shared 2s guard; wrong/missing/changed/quota/risk fail closed; Stop outbox preserved; legacy one-task stop unchanged; two explicit repair tasks full ACK without new body/reward, default single repair unchanged');
})().catch(error=>{console.error(error);process.exit(1);});
