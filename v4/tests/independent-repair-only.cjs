'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
for(const file of ['core','agent','pool'])vm.runInThisContext(fs.readFileSync('v4/src/'+file+'.js','utf8'));
const C=CrowdCore,ids=['a','b','c','d','e'].map(c=>c.repeat(24));
const settle=async()=>{for(let i=0;i<16;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(parallelism=2){
 let now=Date.parse('2026-10-10T05:00:00Z'),owner='owner-a',offline=false,duplicate=false,reject=0;
 const store={agent:{...C.initial(),timing_version:1,run_generation:0,parallelism,enabled:true,consent:C.CONSENT,phase:'search_done',last_tick:now,profiles:false,
  task:{id:1,query:'餐厅',target:8,received:0,remaining_today:8,lease_token:'lease',lease_until:new Date(now+1e7).toISOString()},candidates:ids.map(id=>C.HOST+'/explore/'+id)}};
 const opened=[],sent=[],closed=[],charged=[],alarms=[],receipts=new Map();let single=null;
 const record=id=>({schema_version:4,standard:{platform:'xiaohongshu',note_id:id,url:C.HOST+'/explore/'+id,title:'餐厅',captured_at:new Date(now).toISOString(),published_at:null,author_display:null,like_count:1,collect_count:null,comment_count:0},extra:{author_opinion_quotes:[],comments:{items:[],coverage:'visible_loaded_only',complete:false,captured_count:0,truncated:false,more_available:false}},evidence:{text:'餐厅正文',original_length:4,truncated:false,parser_version:C.VERSION,source:'rendered_public_dom'}});
 const r={owner:async()=>owner,poolAllowed:async()=>true,fastCapture:true,splitCapture:true,storage:{get:async key=>structuredClone(store[key]),set:async(key,value)=>{store[key]=structuredClone(value);}},now:()=>now,random:()=>0,uuid:crypto.randomUUID,schedule:async at=>alarms.push(at),cancel:async()=>{},scheduleDelivery:async()=>{},cancelDelivery:async()=>{},close:async()=>closed.push('all'),closeLegacy:async()=>{},closeSlot:async id=>closed.push(id),open:async(url,_,slot)=>{single=C.noteURL(url).id;opened.push({id:single,slot});},probe:async(_,slot)=>({ready:true,record:record(slot?opened.find(o=>o.slot===slot).id:single)})};
 const api={rpc:async(name,p)=>{
  if(name==='status')return {participant:{status:'approved'}};
  if(name==='claim')return {task:structuredClone(store.agent.task)};
  if(name==='guard'){if(p.p_action!=='control')charged.push(p.p_action);return {version:1,observations:1,ttl_ms:600000,paused:false,allowed:true,reason:null,wait_ms:0,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:opened.length,comment:0,scroll:0}};}
  if(name==='submit'){
   assert.equal(store.agent.outbox[0].request,p.p_request);sent.push(p);
   if(!receipts.has(p.p_request)){
    const rejected=reject>0;if(rejected)reject--;
    const received=[...receipts.values()].filter(value=>value.inserted).length;
    receipts.set(p.p_request,rejected?{request:p.p_request,gate:'rejected',error:'unrelated_note'}:{request:p.p_request,gate:'received',inserted:!duplicate,duplicate,task_received:received+(duplicate?0:1)});
   }
   if(offline)throw Error('offline');return receipts.get(p.p_request);
  }
  if(name==='observe')return {request:p.p_request,gate:'observed'};
  if(name==='finish')throw Error('test must not exhaust a larger task');
  throw Error('unexpected '+name);
 }};
 return {r,api,store,opened,sent,charged,record,closed,alarms,setOffline:v=>offline=v,setDuplicate:v=>duplicate=v,setReject:v=>reject=v,setOwner:v=>owner=v,advance:ms=>now+=ms};
}
async function run(f,agent){for(let i=0;i<15 && f.store.agent.enabled;i++){await agent.tick();await settle();f.advance(30000);}await settle();}
(async()=>{
 const f=fixture(2);f.r.localTest=true;f.store.agent.enabled=false;f.store.agent.phase='search_done';f.store.agent.candidates=[];f.store.agent.history=[...ids];f.store.agent.task.repair_only=true;f.store.agent.task.received=4;f.store.agent.task.target=4;f.store.agent.task.remaining_today=0;f.store.agent.task.acceptance_goal=4;f.store.agent.task.comments_capture=true;f.store.agent.task.repair_notes=ids.map(id=>({parent:crypto.randomUUID(),record:f.record(id)}));
 let searchOpens=0;const rawOpen=f.r.open;f.r.open=async(url,...args)=>{if(new URL(url).pathname==='/search_result'){searchOpens++;return;}return rawOpen(url,...args)};
 const expanded=new Map(),observed=[],admitted=[];let next=0,observeOffline=false;
 const rpc=f.api.rpc;
 f.api.rpc=async(name,args)=>{
  if(name==='guard'){
   const now=f.r.now(),action=args.p_action!=='control',allowed=action?now>=next:true;
   if(action&&allowed){admitted.push({at:now,action:args.p_action});next=now+3000;}
   return {version:1,observations:1,ttl_ms:600000,paused:false,allowed,reason:allowed?null:'action_gap',wait_ms:Math.max(0,next-now),action_wait_ms:Math.max(0,next-now),gap_ms:2000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:0,comment:0,scroll:0}};
  }
  if(name==='finish')return {status:'complete',received:4};
  if(name==='observe'||name==='comments_observe'){observed.push({...args,kind:name});if(observeOffline)throw Error('offline');return {request:args.p_request,gate:'observed'};}
  return rpc(name,args);
 };
 const probe=f.r.probe;
 f.r.probe=async(action,slot)=>{
 if(action==='search')return {ready:true,keyword:'餐厅',links:ids.map(id=>C.HOST+'/explore/'+id),cards:[]};
 if(action==='scroll')return {ready:true};
  const id=f.opened.find(o=>o.slot===slot)?.id;
  if(action==='comments'){expanded.set(id,(expanded.get(id)||0)+1);return {ready:true};}
  const p=await probe(action,slot),n=Math.min(39,(expanded.get(id)||0)*5);p.record.standard.comment_count=39;
  p.record.extra.comments={items:Array.from({length:n},(_,i)=>({key:'comment-'+(i+1),comment_id:String(i+1),parent_key:null,is_reply:false,author_display:'reader',text:'真实显示评论'+i,original_length:('真实显示评论'+i).length,truncated:false,like_count:0,published_label:null})),coverage:'visible_loaded_only',complete:false,captured_count:n,loaded_count:n,truncated:false,more_available:n<39,progress:{top:100,height:200,client:100,at_end:n===39,expand_count:n<39?1:0,end_marker:n===39,empty:false}};return p;
 };
 const a=new CrowdAgent(f.r,f.api);await a.start(true);
 let sawTwoPending=false;
 for(let i=0;i<600&&f.store.agent.enabled;i++){
  await a.tick();await settle();
  if(f.store.agent.test_run.accepted.length===2&&f.store.agent.work_slots.length){sawTwoPending=true;assert.equal(f.store.agent.enabled,true,'two body ACKs must not interrupt comments');}
  f.advance(1000);
 }
 assert.equal(f.store.agent.last_error,'test_completed',JSON.stringify(f.store.agent));assert.equal(f.opened.length,5);assert.equal(searchOpens,1,'same-task stopped checkpoint must rediscover once');assert.equal(f.store.agent.test_run.goal,0);assert.equal(f.store.agent.test_run.limit,0);assert.equal(f.store.agent.test_run.attempts,0);
 assert.equal(observed.filter(p=>p.kind==='comments_observe'&&p.p_data.items.length===39&&p.p_data.summary.complete).length,5,'all five full captures ACK before stop');assert.equal(f.sent.length,0,'repair-only must never submit or reward again');
 assert.ok([...expanded.values()].every(n=>n>=8),'real comment actions preserved for both notes');
 assert.equal(f.store.agent.work_slots.length,0);assert.equal(f.store.agent.outbox.length,0);
 for(let i=1;i<admitted.length;i++)assert.ok(admitted[i].at-admitted[i-1].at>=3000,'shared server exact admission wait is preserved');
 assert.ok(admitted.some(x=>x.action==='comment'));assert.ok(f.r.now()-Date.parse('2026-10-10T05:00:00Z')<240000);
 console.log('PASS independent repair-only: zero new bodies and five39 repairs, >4 comment actions each, five full captures ACK before automatic stop, no duplicate base/reward, exact shared pacing');
})().catch(e=>{console.error(e);process.exit(1);});
