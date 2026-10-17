'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
for(const file of ['core','agent','pool'])vm.runInThisContext(fs.readFileSync('v4/src/'+file+'.js','utf8'));
const C=CrowdCore,ids=['a','b','c','d'].map(c=>c.repeat(24));
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
 const simultaneous=fixture(1),simAgent=new CrowdAgent(simultaneous.r,simultaneous.api);
 let concurrent=0,maxConcurrent=0;const activate=simAgent.activate.bind(simAgent);
 simAgent.activate=async(...args)=>{concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);try{return await activate(...args);}finally{concurrent--;}};
 await Promise.all([simAgent.start(true),simAgent.start(true)]);assert.equal(maxConcurrent,1,'simultaneous commands keep the single-writer lock');
 const cancelExpired=fixture(1),ce=new CrowdAgent(cancelExpired.r,cancelExpired.api);
 cancelExpired.store.agent.enabled=false;cancelExpired.store.agent.test_run={id:'old-expired',limit:2,attempts:1,accepted:[],state:'waiting',expires_at:cancelExpired.r.now()-1};
 let entered,release;const retiring=new Promise(resolve=>entered=resolve);
 cancelExpired.r.close=async()=>{entered();await new Promise(resolve=>release=resolve);};
 const starting=ce.start(true);await retiring;const stopping=ce.stop('user_stopped',{drain:true});release();
 await assert.rejects(starting,/cancelled/);await stopping;assert.equal(cancelExpired.store.agent.enabled,false,'Stop during expiry retirement forbids restart');
 assert.equal(cancelExpired.store.agent.test_run.id,'old-expired');
 for(const state of ['waiting','active']) {
  const f=fixture(1),a=new CrowdAgent(f.r,f.api);f.store.agent.enabled=false;
  f.store.agent.test_run={id:'expired-original',limit:2,attempts:1,accepted:[],state,expires_at:f.r.now()-1};
  await a.start(true);assert.equal(f.store.agent.enabled,true,'one explicit click starts a fresh batch after expiry');
  assert.notEqual(f.store.agent.test_run.id,'expired-original');assert.equal(f.store.agent.test_run.state,'waiting');assert.equal(f.opened.length,0);
 }
 for(const width of [1,2]){
  const f=fixture(width),a=new CrowdAgent(f.r,f.api);await a.start(true);await run(f,a);
  assert.equal(f.opened.length,2,JSON.stringify(f.store.agent));assert.equal(f.store.agent.test_run.accepted.length,2,JSON.stringify(f.store.agent));assert.equal(f.store.agent.test_run.attempts,2);
  assert.equal(f.store.agent.enabled,false);assert.equal(f.store.agent.test_run.state,'complete');assert.equal(f.store.agent.task.id,1);assert.ok(f.closed.includes('all'));
  f.advance(86400000);await new CrowdAgent(f.r,f.api).tick(true);assert.equal(f.opened.length,2,'restart/day never resumes complete batch');await assert.rejects(a.start(),/test_new_run_required/);
 }
 for(const width of [1,2]) {
  const rejected=fixture(width),agent=new CrowdAgent(rejected.r,rejected.api);rejected.setReject(1);await agent.start(true);await run(rejected,agent);
  assert.equal(rejected.opened.length,3,'one rejection permits one bounded replacement');assert.equal(rejected.store.agent.test_run.accepted.length,2);assert.equal(rejected.store.agent.test_run.reason,'test_completed');
  const failed=fixture(width),fa=new CrowdAgent(failed.r,failed.api);failed.setReject(4);await fa.start(true);await run(failed,fa);assert.equal(failed.opened.length,4);assert.equal(failed.store.agent.test_run.reason,'test_partial');assert.equal(failed.store.agent.test_run.accepted.length,0);
  const legacy=fixture(width),la=new CrowdAgent(legacy.r,legacy.api);legacy.store.agent.test_run={id:'kept',limit:2,attempts:0,accepted:[],state:'active',expires_at:legacy.r.now()+900000,day:'2026-10-10'};legacy.setReject(1);await la.start(true);await run(legacy,la);assert.equal(legacy.opened.length,2,'persisted older attempt boundary remains unchanged');assert.equal(legacy.store.agent.test_run.reason,'test_partial');
 }
 const search=fixture(1),searchAgent=new CrowdAgent(search.r,search.api);search.store.agent.enabled=false;search.store.agent.phase='search';search.store.agent.candidates=[];search.store.agent.task.anchor_terms=['餐厅'];
 await searchAgent.start(true);search.store.agent.phase='search';search.store.agent.page_deadline=search.r.now()+30000;search.store.agent.next_at=search.r.now();let scrolls=0;
 search.r.probe=async kind=>{if(kind==='scroll'){scrolls++;return {};}return {ready:true,links:ids.slice(0,2).map(id=>C.HOST+'/explore/'+id),cards:[{url:C.HOST+'/explore/'+ids[0],title:'餐厅'},{url:C.HOST+'/explore/'+ids[1],title:'上海吃食'}]};};
 await searchAgent.tick();await settle();assert.equal(scrolls,0,'enough unseen candidates skip title-only expansion');assert.ok(['search_done','note'].includes(search.store.agent.phase));assert.ok(search.opened.length<=1);
 for(const local of [false,true]) for(const reason of ['session_rest','test_expired',null,'captcha','rate_limit']) {
  const wait=fixture(1),a=new CrowdAgent(wait.r,wait.api);wait.r.localTest=local;const s=wait.store.agent;s.wait_kind='action';s.last_error=reason;s.next_at=wait.r.now()+1800000;s.action_not_before=s.next_at;
  await a.control(s,'control',()=>{},new AbortController().signal);
  assert.equal(s.next_at,(local || reason==='session_rest') && !['captcha','rate_limit'].includes(reason)?wait.r.now():wait.r.now()+1800000,'authoritative cleared rest retires formal and local waits; risk waits remain');
 }
 const still=fixture(1),stillAgent=new CrowdAgent(still.r,still.api);still.r.localTest=true;const ws=still.store.agent;ws.wait_kind='action';ws.last_error='session_rest';ws.next_at=still.r.now()+1800000;
 const restRpc=still.api.rpc;still.api.rpc=async(name,args)=>name==='guard'?{...await restRpc(name,args),allowed:false,reason:'session_rest',wait_ms:1800000}:restRpc(name,args);
 await stillAgent.control(ws,'control',()=>{},new AbortController().signal);assert.equal(ws.next_at,still.r.now()+1800000,'ongoing server rest is never bypassed');
 const old=fixture(),oa=new CrowdAgent(old.r,old.api);old.store.agent.outbox=[{request:'old-request',task:1,lease:'lease',record:old.record(ids[3])}];await oa.start(true);await run(old,oa);assert.equal(old.sent.length,3);assert.equal(old.store.agent.test_run.accepted.length,2,'old outbox ACK excluded');
 const unknown=fixture(),u=new CrowdAgent(unknown.r,unknown.api);unknown.setOffline(true);await u.start(true);await u.tick();await settle();const original=structuredClone(unknown.store.agent.outbox[0]);assert.ok(original.test_run_id);
 unknown.advance(60000);await new CrowdAgent(unknown.r,unknown.api).tick(true);assert.equal(unknown.opened.length,1,'unknown consumes slot and prevents replacements');assert.equal(unknown.store.agent.outbox[0].request,original.request);
 unknown.setOffline(false);unknown.advance(300000);await run(unknown,new CrowdAgent(unknown.r,unknown.api));assert.equal(unknown.store.agent.test_run.accepted.length,2);assert.equal(unknown.opened.length,2);assert.equal(unknown.sent[0].p_request,unknown.sent[1].p_request,'lost ACK retries original UUID');
 const dupe=fixture(),d=new CrowdAgent(dupe.r,dupe.api);dupe.setDuplicate(true);await d.start(true);await run(dupe,d);assert.equal(dupe.opened.length,4);assert.equal(dupe.store.agent.test_run.accepted.length,0);assert.equal(dupe.store.agent.test_run.reason,'test_partial');
 const expired=fixture(),e=new CrowdAgent(expired.r,expired.api);expired.store.agent.outbox=[{request:'kept',record:expired.record(ids[0]),task:1,lease:'lease'}];await e.start(true);expired.advance(900001);await e.tick();await settle();assert.equal(expired.opened.length,0);assert.equal(expired.store.agent.enabled,false);assert.equal(expired.store.agent.outbox[0].request,'kept');assert.equal(expired.store.agent.test_run.reason,'test_expired');
 const stopped=fixture(),s=new CrowdAgent(stopped.r,stopped.api);await s.start(true);await s.stop('user_stopped',{drain:true});await new CrowdAgent(stopped.r,stopped.api).tick(true);assert.equal(stopped.opened.length,0);assert.equal(stopped.store.agent.test_run.state,'stopped');
 const settings=fixture(1),p=new CrowdAgent(settings.r,settings.api);settings.store.agent.phase='note';settings.store.agent.note_id=ids[0];const before=structuredClone(settings.store.agent);
 await p.requestParallelism(2);assert.deepEqual(settings.store.agent,before,'live agent state untouched by preference');assert.equal((await p.preferences()).parallelism,2);
 settings.setOwner('owner-b');assert.equal(await p.preferences(),null,'another account cannot inherit preference');settings.setOwner('owner-a');settings.store.agent.phase='search_done';await p.tick();await settle();assert.equal(settings.store.agent.parallelism,2,'actor consumes preference at safe boundary');
 const finish=fixture(),fa=new CrowdAgent(finish.r,finish.api);finish.store.agent.task.target=2;const finishRpc=finish.api.rpc;
 finish.api.rpc=async(name,args)=>{if(name==='finish'){assert.equal(finish.store.agent.enabled,false,'local terminal persists before finish RPC');throw Error('backend_unavailable');}return finishRpc(name,args);};
 await fa.start(true);await run(finish,fa);assert.equal(finish.store.agent.test_run.state,'complete');assert.equal(finish.store.agent.test_run.finish_error,'backend_unavailable');assert.equal(finish.store.agent.task.id,1,'unconfirmed finish retains task');assert.equal(finish.opened.length,2);
 for(const width of [1,2]) {
  const expiry=fixture(width),ea=new CrowdAgent(expiry.r,expiry.api),rpc=expiry.api.rpc;await ea.start(true);expiry.store.agent.test_run.expires_at=expiry.r.now()+500;
  expiry.api.rpc=async(name,args)=>{const result=await rpc(name,args);if(name==='guard' && args.p_action==='detail')expiry.advance(1000);return result;};
  await ea.tick();await settle();assert.equal(expiry.opened.length,0,'guard return beyond deadline cannot open');assert.equal(expiry.store.agent.test_run.reason,'test_expired');
 }
 const midnight=fixture(),ma=new CrowdAgent(midnight.r,midnight.api);midnight.advance(11*3600000-10000);midnight.store.agent.task.lease_until=new Date(midnight.r.now()+1e7).toISOString();await ma.start(true);
 assert.equal(midnight.store.agent.test_run.expires_at,midnight.r.now()+10000);midnight.store.agent.next_at=midnight.r.now()+86400000;await ma.tick();assert.ok(midnight.alarms.every(at=>at<=midnight.store.agent.test_run.expires_at),'long cooldown alarm capped at midnight');midnight.advance(10001);await ma.tick();await settle();assert.equal(midnight.opened.length,0);assert.equal(midnight.store.agent.enabled,false);
 for(const command of ['settings','test']) {
  const switched=fixture(1),agent=new CrowdAgent(switched.r,switched.api);let release;switched.r.poolAllowed=()=>new Promise(resolve=>release=resolve);
  const pending=command==='settings'?agent.requestParallelism(2):agent.start(true);await settle();switched.setOwner('owner-b');release(true);await assert.rejects(pending,/cancelled/);assert.equal(switched.store['agent-settings:owner-b'],undefined);assert.equal(switched.store.agent.test_run,undefined,'A test command cannot start for B');
 }
 const login=fixture(),la=new CrowdAgent(login.r,login.api);await la.start(true);login.r.sourceHealth=async()=>{throw Error('login_required');};await la.tick();await settle();assert.equal(login.store.agent.enabled,false);assert.equal(login.store.agent.test_run.state,'stopped');assert.equal(login.opened.length,0);
 const retired=fixture(1),ra=new CrowdAgent(retired.r,retired.api);await ra.start(true);await ra.tick();assert.equal(retired.opened.length,1);await ra.stop();assert.equal(retired.store.agent.phase,'search_done');assert.equal(retired.store.agent.note_url,null);assert.equal(retired.store.agent.interrupted[0].note_id,ids[0]);await ra.start(true);await run(retired,ra);assert.equal(retired.opened.length,3);assert.equal(retired.opened[1].id,ids[1],'new batch cannot reopen retired old detail outside its cap');assert.equal(retired.store.agent.test_run.attempts,2);
 for(const width of [1,2]) {
  const local=fixture(width);local.r.localTest=true;local.store.agent.task.target=2;local.store.agent.task.remaining_today=2;
  let finishes=0;const rpc=local.api.rpc;local.api.rpc=async(name,args)=>name==='finish'?(finishes++,{status:'complete',received:2}):rpc(name,args);
  const a=new CrowdAgent(local.r,local.api);await a.start();await run(local,a);
  assert.equal(local.opened.length,2,'ordinary local start is bounded');assert.equal(local.store.agent.enabled,false);assert.equal(local.store.agent.test_run.state,'complete');assert.equal(finishes,1);
 }
 for(const width of [1,2]) {
  const legacy=fixture(width);legacy.r.localTest=true;legacy.store.agent.task.target=2;legacy.store.agent.task.received=2;legacy.store.agent.task.remaining_today=0;
  const extra={parent:'confirmed-base',record:legacy.record(ids[1]),stage:'comments',rounds:0,stalls:0};
  if(width===2){legacy.store.agent.phase='parallel';legacy.store.agent.work_slots=[{id:'old-slot',task:1,lease:'lease',phase:'enrich',request:'confirmed-base',base_received:true,enrichment:extra}];}else{legacy.store.agent.phase='enrich';legacy.store.agent.enrichment=extra;}
  let finishes=0;const rpc=legacy.api.rpc;legacy.api.rpc=async(name,args)=>name==='finish'?(finishes++,{status:'complete',received:2}):rpc(name,args);
  const a=new CrowdAgent(legacy.r,legacy.api);await a.tick(true);await settle();
  assert.equal(legacy.store.agent.enabled,false,'worker upgrade stops filled unlimited run');assert.equal(legacy.opened.length,0);assert.equal(legacy.charged.length,0,'no optional admission after two receipts');assert.equal(finishes,1);
  assert.equal(legacy.store.agent.test_run.reason,'test_quota','historical ACKs do not become new batch success');assert.equal(legacy.store.agent.test_run.accepted.length,0);
  assert.ok(legacy.store.agent.outbox.some(item=>item.parent==='confirmed-base'),'already visible comments survive stop');
 }
 for(const kind of ['note',null]) {
  const pending=fixture(2);pending.r.localTest=true;pending.store.agent.task.received=2;pending.store.agent.task.target=2;pending.store.agent.task.remaining_today=0;
  pending.store.agent.outbox=[{kind,request:'unknown-original',task:1,lease:'lease',parent:kind?'base':undefined,record:pending.record(ids[0])}];pending.setOffline(true);
  const rpc=pending.api.rpc;pending.api.rpc=async(name,args)=>name==='finish'?{status:'complete',received:2}:rpc(name,args);
  await new CrowdAgent(pending.r,pending.api).tick(true);await settle();assert.equal(pending.store.agent.enabled,false,'unknown delivery cannot keep collection enabled');assert.equal(pending.store.agent.outbox[0].request,'unknown-original');assert.equal(pending.sent.length,0);assert.equal(pending.opened.length,0);
 }
 const larger=fixture(2);larger.r.localTest=true;const la2=new CrowdAgent(larger.r,larger.api);await la2.start();await run(larger,la2);assert.equal(larger.store.agent.test_run.state,'complete');assert.equal(larger.store.agent.task.id,1,'two-note local batch does not exhaust larger task');
 const quota=fixture(2);quota.store.agent.task.remaining_today=0;await new CrowdAgent(quota.r,quota.api).tick();assert.equal(quota.opened.length,0);assert.notEqual(quota.store.agent.phase,'parallel','empty quota pool cannot spin');assert.equal(quota.store.agent.enabled,true,'formal continuous mode unchanged');
 const fresh=fixture(1),fr=new CrowdAgent(fresh.r,fresh.api),freshRpc=fresh.api.rpc;
 fresh.store.agent.next_at=fresh.r.now()+600000;const oldDeadline=fresh.store.agent.next_at;
 fresh.api.rpc=async(name,args)=>name==='claim'?{task:{...fresh.store.agent.task,target:3,received:2,remaining_today:1,known_note_ids:[ids[0]]}}:freshRpc(name,args);
 await fr.start();await fr.step(()=>{},new AbortController().signal);
 assert.equal(fresh.store.agent.task.target,3);assert.equal(fresh.store.agent.task.received,2);assert.equal(fresh.store.agent.candidates[0],C.HOST+'/explore/'+ids[1]);assert.equal(fresh.store.agent.next_at,oldDeadline,'assignment sync preserves waits');assert.equal(fresh.opened.length,0);
 const replaced=fixture(1),rr=new CrowdAgent(replaced.r,replaced.api),replaceRpc=replaced.api.rpc,claimArgs=[];
 replaced.api.rpc=async(name,args)=>{if(name==='claim'){claimArgs.push(args.p_task);return args.p_task?{task:null}:{task:{...replaced.store.agent.task,id:2,query:'新任务',lease_token:'new-lease'}};}return replaceRpc(name,args);};
 await rr.start();await rr.step(()=>{},new AbortController().signal);assert.deepEqual(claimArgs,[1,null]);assert.equal(replaced.store.agent.task.id,2);assert.deepEqual(replaced.store.agent.candidates,[]);
 const checkpoint=fixture(2),ca=new CrowdAgent(checkpoint.r,checkpoint.api),checkpointRpc=checkpoint.api.rpc;
 checkpoint.store.agent.work_slots=[{id:'kept-slot',task:1,lease:'lease',phase:'unknown'}];checkpoint.api.rpc=async(name,args)=>name==='claim'?{task:{...checkpoint.store.agent.task,id:2,lease_token:'new-lease'}}:checkpointRpc(name,args);
 await ca.start();await ca.step(()=>{},new AbortController().signal);await settle();assert.equal(checkpoint.store.agent.enabled,false);assert.equal(checkpoint.store.agent.task.id,1);assert.equal(checkpoint.store.agent.work_slots[0].id,'kept-slot','active checkpoint never moved into new assignment');
 const rollback=fixture(1),rb=new CrowdAgent(rollback.r,rollback.api),rbRpc=rollback.api.rpc;rollback.store.agent.task.received=2;
 rollback.api.rpc=async(name,args)=>name==='claim'?{task:{...rollback.store.agent.task,received:1}}:rbRpc(name,args);
 await rb.start();await rb.step(()=>{},new AbortController().signal);assert.equal(rollback.store.agent.task.received,2);assert.equal(rollback.store.agent.assignment_refresh,true);assert.equal(rollback.opened.length,0);
 const single=fixture(1),sa=new CrowdAgent(single.r,single.api),singleRpc=single.api.rpc;single.store.agent.phase='note';single.store.agent.note_id=ids[0];single.store.agent.note_url=C.HOST+'/explore/'+ids[0];
 single.api.rpc=async(name,args)=>name==='claim'?{task:{...single.store.agent.task,lease_token:'new-token'}}:singleRpc(name,args);
 await sa.start();await sa.step(()=>{},new AbortController().signal);await settle();assert.equal(single.store.agent.enabled,false);assert.equal(single.store.agent.task.lease_token,'lease');assert.equal(single.store.agent.note_id,ids[0]);assert.equal(single.opened.length,0);
 for(const fallback of [false,true]) {
  const parked=fixture(1),pa=new CrowdAgent(parked.r,parked.api),parkRpc=parked.api.rpc;let claims=0,quotas=0;
  parked.api.rpc=async(name,args)=>{if(name!=='claim')return parkRpc(name,args);claims++;if(fallback && args.p_task)return {task:null};if(quotas++===0)return {error:'daily_quota',reset_at:new Date(parked.r.now()+60000).toISOString()};return {task:{...parked.store.agent.task,id:fallback?2:1,known_note_ids:[ids[0]]}};};
  await pa.start();await pa.step(()=>{},new AbortController().signal);assert.equal(parked.store.agent.assignment_refresh,true);const before=claims;
  await pa.step(()=>{},new AbortController().signal);assert.equal(claims,before,'quota wait cannot repeatedly claim');parked.advance(60001);await pa.step(()=>{},new AbortController().signal);
  assert.ok(claims>before,'reset must refresh before any old source visit');assert.equal(parked.opened.length,0);assert.equal(parked.store.agent.assignment_refresh,false);if(fallback)assert.equal(parked.store.agent.task.id,2);else assert.equal(parked.store.agent.candidates[0],C.HOST+'/explore/'+ids[1]);
 }
 console.log('PASS bounded local test: single/pool <=4 attempts and <=2 accepted receipts, ACK ledger, old queue exclusion, lost ACK stable UUID, duplicate not counted, expiry/stop/day durable, pending owner-scoped preferences');
})().catch(error=>{console.error(error);process.exitCode=1;});
