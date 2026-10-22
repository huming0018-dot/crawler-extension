'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
for(const file of ['core','agent','pool','work-tabs'])vm.runInThisContext(fs.readFileSync('v4/src/'+file+'.js','utf8'));
const C=CrowdCore,ids=['a'.repeat(24),'b'.repeat(24),'c'.repeat(24)];
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture({quota=2,unknown=false,holdFirst=true,comments=false}={}) {
 let now=Date.now(),nextAction=0,state={...C.initial(),timing_version:1,run_generation:0,parallelism:2,enabled:true,consent:C.CONSENT,phase:'search_done',last_tick:now,profiles:false,
  task:{id:1,query:'餐厅',target:2,received:0,remaining_today:quota,lease_token:'lease',lease_until:new Date(now+1e7).toISOString()},candidates:ids.map(id=>C.HOST+'/explore/'+id)};
 const held=new Map(),opened=[],closed=[],sent=[],observed=[],commentActions=[];
 const record=id=>({schema_version:4,standard:{platform:'xiaohongshu',note_id:id,url:C.HOST+'/explore/'+id,title:'餐厅'+id[0],captured_at:new Date(now).toISOString(),published_at:null,author_display:null,like_count:1,collect_count:null,comment_count:0},extra:{author_opinion_quotes:[],comments:{items:[],coverage:'visible_loaded_only',complete:false,captured_count:0,truncated:false,more_available:false,progress:{empty:true,at_end:true,expand_count:0}}},evidence:{text:'餐厅正文'+id[0],original_length:5,truncated:false,parser_version:C.VERSION,source:'rendered_public_dom'}});
 const r={poolAllowed:async()=>true,storage:{get:async()=>structuredClone(state),set:async(_,s)=>state=structuredClone(s)},now:()=>now,random:()=>0,uuid:crypto.randomUUID,schedule:async()=>{},cancel:async()=>{},close:async()=>{},closeLegacy:async()=>{},closeSlot:async slot=>closed.push(slot),open:async(url,_,slot)=>opened.push({id:C.noteURL(url).id,slot}),probe:async(action,slot)=>{
  const id=opened.find(item=>item.slot===slot)?.id;
  if(id===ids[0] && action==='note_ready' && holdFirst)return new Promise(resolve=>held.set(slot,resolve));
  if(action==='comments')commentActions.push({id,opened:opened.length});
  const value=record(id);if(comments){value.standard.comment_count=2;value.extra.comments.more_available=true;}
  return {ready:true,record:value};
 }};
 const api={rpc:async(name,p)=>{
  if(name==='guard'){const action=p.p_action!=='control',allowed=!action||now>=nextAction;if(action&&allowed)nextAction=now+30000;return {version:1,observations:1,ttl_ms:600000,paused:false,allowed,reason:allowed?null:'action_gap',wait_ms:allowed?0:nextAction-now,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:opened.length,comment:0,scroll:0}};}
  if(name==='submit'){assert.equal(state.outbox[0].request,p.p_request);sent.push(p);if(unknown)throw Error('offline');return {request:p.p_request,gate:'received',inserted:true,duplicate:false,task_received:sent.length};}
  if(name==='observe'){assert.ok(sent.some(item=>item.p_request===p.p_parent));observed.push(p);return {request:p.p_request,gate:'observed'};}
  if(name==='finish')return {status:'complete',received:sent.length};
  if(name==='status')return {participant:{status:'approved'}};
  if(name==='claim')return {task:structuredClone(state.task)};
  throw Error('unexpected '+name);
 }};
 return {r,api,get state(){return state;},record,opened,closed,sent,observed,commentActions,advance:ms=>now+=ms,release:()=>{for(const [slot,resolve] of held)resolve({ready:true,record:record(ids[0])});held.clear();}};
}
(async()=>{
 const fast=fixture({holdFirst:false,comments:true}),priority=new CrowdAgent(fast.r,fast.api);
 await priority.tick();await settle();assert.equal(fast.sent.length,1);assert.equal(fast.commentActions.length,0);
 fast.advance(30000);await priority.tick();await settle();
 assert.equal(fast.opened.length,2,'next detail uses admission before first-note comments');
 assert.equal(fast.sent.length,2,'both bases can arrive before optional comment interactions');
 fast.advance(30000);await priority.tick();await settle();
 assert.ok(fast.commentActions.length>0,'comments continue after both detail slots have been dispatched');
 assert.ok(fast.commentActions.every(action=>action.opened===2));
 assert.equal(fast.opened.length,2,'priority never opens a third detail');
 const f=fixture(),a=new CrowdAgent(f.r,f.api);
 await a.tick();await settle();assert.equal(f.opened.length,1);
 f.advance(30000);await a.tick();await settle();
 assert.equal(f.opened.length,2);assert.equal(f.sent.length,1);assert.equal(f.sent[0].p_record.standard.note_id,ids[1],'fast B sends before slow A');
 assert.equal(f.state.work_slots.length,2,'fast B retains its slot until the empty comment DOM is confirmed stable');
 f.advance(1000);await a.tick();await settle();assert.equal(f.state.work_slots.length,1);
 f.release();await settle();await a.tick();await settle();
 assert.equal(f.sent.length,2,'slow A body ACK also precedes terminal comment confirmation');
 f.advance(1000);await a.tick();await settle();
 assert.equal(f.sent.length,2);assert.equal(f.observed.length,2);assert.equal(f.state.work_slots.length,0);assert.equal(f.state.task,null);assert.equal(f.opened.length,2,'two-target task cannot start C');
 const limited=fixture({quota:1}),l=new CrowdAgent(limited.r,limited.api);await l.tick();limited.advance(30000);await l.tick();await settle();assert.equal(limited.opened.length,1,'in-flight slot occupies last quota');limited.release();await settle();
 const stopped=fixture(),b=new CrowdAgent(stopped.r,stopped.api);await b.tick();await settle();const stop=b.stop();await settle();assert.equal(stopped.state.enabled,false,'stop persisted while probe is still pending');
 const restored=new CrowdAgent(stopped.r,stopped.api);await restored.tick(true);assert.equal(stopped.opened.length,1,'restart after durable stop does not open');stopped.release();await stop;await settle();assert.equal(stopped.sent.length,0,'late result cannot submit after stop');
 assert.equal(stopped.state.work_slots.length,0);assert.equal(stopped.state.interrupted[0].note_id,ids[0]);assert.equal(stopped.state.interrupted[0].action_consumed,true);
 assert.equal(stopped.state.interrupted[0].outcome,'confirmed_abandoned');
 await b.start();stopped.advance(30000);await b.tick();await settle();assert.equal(stopped.opened[1].id,ids[1],'explicit Continue skips abandoned A, preserves its charged attempt');
 const blocked=fixture({unknown:true}),u=new CrowdAgent(blocked.r,blocked.api);await u.tick();blocked.advance(30000);await u.tick();await settle();const uuid=blocked.state.outbox[0].request;blocked.advance(1000);await new CrowdAgent(blocked.r,blocked.api).tick(true);assert.equal(blocked.state.outbox[0].request,uuid);assert.equal(blocked.opened.length,2,'unknown ACK cannot dispatch C');blocked.release();await settle();
 await u.stop();assert.equal(blocked.state.outbox[0].request,uuid);assert.ok(blocked.state.interrupted.some(item=>item.outcome==='delivery_unknown'));
 await u.start();blocked.advance(300000);await u.tick();await settle();assert.equal(blocked.opened.length,2,'Continue with unknown ACK cannot dispatch a replacement');assert.equal(blocked.state.outbox[0].request,uuid);
 for(const bad of ['invalid','oversize']) {
  const f=fixture(),agent=new CrowdAgent(f.r,f.api),s=await agent.read(),record=f.record(ids[0]);
  if(bad==='invalid')record.schema_version=99;else record.evidence.text='正文'.repeat(40000);
  s.work_slots=[{id:'stop-test',note_id:ids[0],enrichment:{record,parent:'parent'}}];await agent.save(s);await agent.stop();
  assert.equal(f.state.enabled,false);assert.equal(f.state.rejected.length,1);assert.equal(f.state.work_slots.length,0);
 }
 const quota=fixture(),q=new CrowdAgent(quota.r,quota.api),qs=await q.read();qs.task.target=4;qs.outbox=[{request:'lost-ack',task:1,lease:'lease',record:quota.record(ids[0])}];await q.save(qs);
 quota.api.rpc=async()=>({request:'lost-ack',gate:'received',inserted:false,duplicate:true,task_received:1});await q.flushOutbox(qs,()=>{},new AbortController().signal);assert.equal(quota.state.task.remaining_today,1,'recovered duplicate ACK still consumes previously unknown successful quota');
 console.log('PASS two-slot agent: B before slow A, shared admission/quota, bounded target, base before supplement, durable stop before cancellation, late-result discard, unknown ACK UUID/backpressure');
})().catch(error=>{console.error(error);process.exitCode=1;});
