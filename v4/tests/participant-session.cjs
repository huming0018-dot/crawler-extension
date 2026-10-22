'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{randomUUID}=require('node:crypto');
const path=require('node:path'),SRC=process.argv[2]?path.resolve(process.argv[2]):path.join(__dirname,'../src');
for(const name of ['core','agent','session-health','participant-session'])vm.runInThisContext(fs.readFileSync(path.join(SRC,name+'.js'),'utf8'));
const pause=()=>new Promise(r=>setImmediate(r));
function fixture(extra={}){
 let now=Date.now(),owner='fixture-owner',pages={xiaohongshu:{status:'authenticated',principal_ref:'a'.repeat(64)}},probe=null,status=null;
 const data={},calls=[],schedules=[];
 const raw={get:async k=>structuredClone(data[k]),set:async(k,v)=>{data[k]=structuredClone(v);}};data.session={user:{id:owner}};
 const storage=CrowdCore.accountStorage(raw),task={id:19,query:'original query',platform:'xiaohongshu',lease_token:'original-lease',lease_until:new Date(now+1200000).toISOString(),received:0,target:2};
 data['agent:'+owner]={...CrowdCore.initial(),enabled:true,delivery_enabled:true,consent:CrowdCore.CONSENT,phase:'search',task,...extra};
 const health=new CrowdPlatformHealth({storage,owner:async()=>owner,now:()=>now,probe:async()=>probe?await probe():pages});
 const r={storage,owner:async()=>owner,now:()=>now,uuid:randomUUID,random:()=>.5,schedule:async(...v)=>schedules.push(v),scheduleDelivery:async()=>{},cancelDelivery:async()=>{},cancel:async()=>{},close:async()=>{throw Error('must retain work page');}};
 const api={rpc:async(name,p)=>{calls.push({name,p});if(name==='status')return status?await status():{participant:{status:'approved'}};if(name==='guard')return {version:1,ttl_ms:60000,paused:false,allowed:true,reason:null,wait_ms:0,gap_ms:1000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:0,comment:0,scroll:0}};if(name==='claim')return {task:structuredClone(task)};throw Error('unexpected '+name);}};
 r.retireLoginPage=async()=>calls.push({name:'retire-metadata'});r.open=async url=>{calls.push({name:'open-new-owned',url});};
 const agent=new CrowdAgent(r,api);let controller;
 const make=()=>new CrowdParticipantSession({bootstrap:(valid,retry,stopped)=>agent.bootstrapLoginPage(valid,retry,stopped),storage,owner:r.owner,now:r.now,health,agent,start:agent.start.bind(agent),stop:agent.stop.bind(agent),rebind:async()=>{calls.push({name:'rebind'});}});
 controller=make();r.sourceHealth=()=>controller.require();
 return {data,storage,task,agent,health,calls,schedules,make,get now(){return now;},get controller(){return controller;},restart(){controller=make();},page(p){pages={xiaohongshu:p};now+=60001;},probe(p){probe=p;},status(p){status=p;},advance(n){now+=n;},read:()=>agent.read(),async modify(p){const s=await agent.read();Object.assign(s,p);await agent.save(s);}};
}
(async()=>{
 let f=fixture({outbox:[{request:'stable-original',kind:'rating',proof:'p',score:4,reason:'original review'}],received:1});
 await f.controller.check(true);f.page({status:'logged_out'});await f.controller.check(true);let s=await f.read();assert.equal(s.enabled,false);assert.equal(s.last_error,'login_required');assert.equal(s.task.id,19);assert.equal(s.outbox[0].request,'stable-original');assert.equal((await f.controller.status()).pending,true);
 f.restart();f.page({status:'authenticated',principal_ref:'a'.repeat(64)});await f.controller.check(true);s=await f.read();assert.equal(s.enabled,true);assert.equal(s.phase,'search');assert.equal(s.outbox[0].request,'stable-original');assert.equal(s.task.lease_token,'original-lease');assert.ok((await f.controller.status()).recovered_at);assert.deepEqual(f.calls.map(c=>c.name),['rebind','status','guard']);
 // User stop wins both a later successful probe and a pending start RPC.
 f=fixture();await f.controller.check(true);f.page({status:'logged_out'});await f.controller.check(true);await f.controller.intent(false);await f.agent.stop('user_stopped',{keepPage:true,drain:true});f.page({status:'authenticated',principal_ref:'a'.repeat(64)});await f.controller.check(true);assert.equal((await f.read()).enabled,false);assert.equal(f.calls.length,0);
 f=fixture();await f.controller.check(true);f.page({status:'logged_out'});await f.controller.check(true);let release;f.status(()=>new Promise(r=>release=r));f.page({status:'authenticated',principal_ref:'a'.repeat(64)});const pending=f.controller.check(true);while(!release)await pause();await f.controller.intent(false);const stopping=f.agent.stop('user_stopped',{keepPage:true});release({participant:{status:'approved'}});await Promise.all([pending,stopping]);assert.equal((await f.read()).enabled,false);assert.equal((await f.controller.status()).desired_running,false);
 // Unknown and changed identities never start. Restoring original does.
 f=fixture();await f.controller.check(true);for(const page of [{status:'unknown'},{status:'authenticated',principal_ref:'b'.repeat(64)},{status:'no_page'}]){f.page(page);await f.controller.check(true);assert.equal((await f.read()).enabled,false);assert.equal(f.calls.length,0);}f.page({status:'authenticated',principal_ref:'a'.repeat(64)});await f.controller.check(true);assert.equal((await f.read()).enabled,true);
 // Source recovery must not revive backend errors, tests, risk/unknown actions or old leases.
 for(const patch of [{last_error:'backend_permission_denied'},{delivery_error:'backend_login_required'},{last_error:'rate_limit'},{test_run:{state:'completed'}},{sdk_pending:{status:'unknown'}},{risk_report:{state:'sending'}}]){
  f=fixture();await f.controller.check(true);f.page({status:'logged_out'});await f.controller.check(true);await f.modify({...patch,enabled:false});f.page({status:'authenticated',principal_ref:'a'.repeat(64)});await f.controller.check(true);assert.equal((await f.read()).enabled,false,JSON.stringify(patch));assert.equal(f.calls.length,0);
 }
 f=fixture({received:1});await f.controller.check(true);f.page({status:'logged_out'});await f.controller.check(true);f.advance(1300000);f.page({status:'authenticated',principal_ref:'a'.repeat(64)});await f.controller.check(true);assert.equal((await f.read()).last_error,'lease_lost');assert.equal(f.calls.length,0);
 // First login from62: no previous identity/evidence, exact original task only even expired.
 f=fixture({enabled:false,last_error:'login_required'});f.advance(1300000);f.task.lease_token='renewed-original';f.task.lease_until=new Date(Date.now()+3600000).toISOString();await f.controller.check(true);s=await f.read();assert.equal(s.enabled,true);assert.equal(s.platform_resume_task.allow_renewal,true);assert.ok((await f.controller.status()).initial_confirmed_at);assert.equal((await f.controller.status()).recovered_at,null);await f.agent.step(()=>{},new AbortController().signal);s=await f.read();assert.equal(s.task.id,19);assert.equal(s.task.lease_token,'renewed-original');assert.equal(s.phase,'search');assert.deepEqual(f.calls.filter(x=>x.name==='claim').map(x=>x.p),[{p_task:19}]);
 for(const next of [null,{id:99,query:'another',platform:'xiaohongshu'}]){f=fixture({enabled:false,last_error:'login_required'});const rpc=f.agent.api.rpc;f.agent.api.rpc=async(name,p)=>{if(name==='claim'){f.calls.push({name,p});return {task:next};}return rpc(name,p);};await f.controller.check(true);await f.agent.step(()=>{},new AbortController().signal);assert.equal((await f.read()).enabled,false);assert.equal((await f.read()).task.id,19);assert.deepEqual(f.calls.filter(x=>x.name==='claim').map(x=>x.p),[{p_task:19}]);}
 f=fixture({enabled:false,last_error:'login_required',received:1});await f.controller.check(true);assert.equal((await f.read()).enabled,false);assert.equal(f.calls.length,0,'62 historical unbound pause cannot impersonate original account');
 // Restored backend permission is only retried by an explicit Continue.
 f=fixture();await f.controller.check(true);f.page({status:'logged_out'});await f.controller.check(true);await f.modify({enabled:false,last_error:'backend_login_required',delivery_error:'backend_login_required',delivery_enabled:false});f.page({status:'authenticated',principal_ref:'a'.repeat(64)});await f.controller.check(true);assert.equal((await f.read()).enabled,false);assert.equal(f.calls.length,0);await f.controller.start();assert.equal((await f.read()).enabled,true);assert.deepEqual(f.calls.filter(c=>c.name==='status'||c.name==='guard').map(c=>c.name),['status','guard']);assert.equal((await f.read()).delivery_error,null);
 f=fixture({enabled:false,last_error:'backend_permission_denied',delivery_error:'backend_permission_denied',delivery_enabled:false});await f.controller.check(true);f.status(async()=>{throw Object.assign(Error('forbidden'),{status:403});});await assert.rejects(()=>f.controller.start(),/backend_permission_denied/);assert.equal((await f.read()).enabled,false);assert.equal((await f.read()).delivery_enabled,false);assert.equal(f.calls.filter(c=>c.name==='guard').length,0);
 // An old content receiver is absent after OTA and browser session metadata has reset.
 f=fixture({enabled:false,last_error:'login_required'});f.page({status:'unknown'});await f.controller.check(true);s=await f.read();assert.equal(s.enabled,false);assert.equal(s.first_login_page.stage,'opened');assert.deepEqual(f.calls.map(x=>x.name),['status','claim','guard','retire-metadata','open-new-owned']);assert.equal(f.calls.find(x=>x.name==='guard').p.p_action,'search');assert.equal(f.calls.find(x=>x.name==='claim').p.p_task,19);
 f.restart();await f.controller.check(true);f.restart();await f.controller.check(true);assert.equal(f.calls.filter(x=>x.name==='open-new-owned').length,1);assert.equal(f.calls.filter(x=>x.name==='claim').length,1);
 f.page({status:'authenticated',principal_ref:'a'.repeat(64)});await f.controller.check(true);assert.equal((await f.read()).enabled,true);assert.ok((await f.controller.status()).initial_confirmed_at);
 f=fixture({enabled:false,last_error:'login_required'});f.agent.r.open=async()=>{f.calls.push({name:'open-unknown'});throw Error('navigation_uncommitted');};f.page({status:'unknown'});await f.controller.check(true);assert.equal((await f.read()).enabled,false);f.restart();await f.controller.check(true);assert.equal(f.calls.filter(x=>x.name==='open-unknown').length,1);assert.equal((await f.read()).first_login_page.stage,'opening');
 // A known guard refusal is durable waiting, including the 63 admitting/stale-control state.
 for(const blockedReason of ['session_rest','action_gap','global_pause']){
  f=fixture({enabled:false,last_error:'login_required'});f.page({status:'unknown'});
  const rpc=f.agent.api.rpc;let blocked=true;
  f.agent.api.rpc=async(name,p)=>{const v=await rpc(name,p);if(name==='guard')return {...v,allowed:false,reason:blocked?blockedReason:null,wait_ms:blocked?120000:0,...(p.p_action==='search'&&!blocked?{allowed:true}:{})};return v;};
  await f.controller.check(true);s=await f.read();assert.equal(s.first_login_page.stage,'waiting');assert.equal(s.control.reason,blockedReason);assert.equal(s.last_error,blockedReason);assert.equal(s.enabled,false);assert.equal((await f.controller.status()).pending,true);assert.equal((await f.controller.status()).wait_until,s.first_login_page.retry_at);assert.equal(f.calls.length,3);
  f.restart();await f.controller.check(true);await f.controller.start();assert.equal(f.calls.length,3,'worker restart and explicit Continue cannot skip known deadline');
  blocked=false;f.advance(120001);await f.controller.check(true);s=await f.read();assert.equal(s.first_login_page.stage,'opened');assert.equal(s.enabled,false);assert.equal(s.task.id,19);assert.equal((await f.controller.status()).wait_until,null);
  assert.deepEqual(f.calls.map(x=>x.name),['status','claim','guard','guard','status','claim','guard','retire-metadata','open-new-owned']);assert.deepEqual(f.calls.filter(x=>x.name==='guard').map(x=>x.p.p_action),['search','control','search']);assert.ok(f.calls.filter(x=>x.name==='claim').every(x=>x.p.p_task===19));
  f.restart();await f.controller.check(true);assert.equal(f.calls.filter(x=>x.name==='open-new-owned').length,1);
 }
 async function waiting63(){
  const f=fixture({enabled:false,last_error:'session_rest',first_login_page:{stage:'admitting',task_id:19},control:{version:1,allowed:true,reason:null}});f.page({status:'unknown'});
  await f.storage.set('participant-session:fixture-owner',{initial_login:true,bootstrap_started:true,pending:false,desired_running:true,reason:'session_rest'});return f;
 }
 f=await waiting63();{const rpc=f.agent.api.rpc;f.agent.api.rpc=async(name,p)=>{const v=await rpc(name,p);return name==='guard'?{...v,allowed:false,reason:'session_rest',wait_ms:1800000}:v;};}
 await f.controller.check(true);s=await f.read();assert.equal(s.first_login_page.stage,'waiting');assert.equal(s.control.allowed,false);assert.equal(s.control.reason,'session_rest');assert.deepEqual(f.calls.map(x=>[x.name,x.p?.p_action]),[['guard','control']],'63 old allowed=true is not a current admission');
 f.restart();await f.controller.check(true);assert.equal(f.calls.length,1);await f.controller.intent(false);await f.agent.stop('user_stopped',{keepPage:true});f.advance(1800001);await f.controller.check(true);assert.equal(f.calls.length,1,'manual stop cancels all automatic admission');
 // Explicit Continue after a manual stop can restore only a saved, known waiting checkpoint.
 for(const beforeDeadline of [true,false]){
  f=await waiting63();const rpc=f.agent.api.rpc;let blocked=true;
  f.agent.api.rpc=async(name,p)=>{const v=await rpc(name,p);return name==='guard'?{...v,allowed:!blocked&&p.p_action==='search',reason:blocked?'session_rest':null,wait_ms:blocked?120000:0}:v;};
  await f.controller.check(true);await f.controller.intent(false);await f.agent.stop('user_stopped',{keepPage:true});
  f.restart();await f.controller.check(true);assert.equal(f.calls.length,1,'manual stop never resumes itself');
  if(beforeDeadline){await f.controller.start();assert.equal(f.calls.length,1,'Continue preserves the saved server deadline');assert.equal((await f.read()).last_error,'session_rest');assert.equal((await f.controller.status()).pending,true);f.restart();await f.controller.check(true);assert.equal(f.calls.length,1);}
  blocked=false;f.advance(120001);if(beforeDeadline)await f.controller.check(true);else await f.controller.start();
  assert.equal((await f.read()).first_login_page.stage,'opened');assert.equal((await f.read()).task.id,19);assert.equal(f.calls.filter(x=>x.name==='open-new-owned').length,1);assert.deepEqual(f.calls.filter(x=>x.name==='claim').map(x=>x.p),[{p_task:19}]);
 }
 for(const patch of [{first_login_page:{stage:'opening',task_id:19,reason:'session_rest'}},{first_login_page:{stage:'checking_wait',task_id:19,reason:'session_rest'}},{first_login_page:{stage:'waiting',task_id:99,reason:'session_rest'}},{pending_risk:'captcha'},{outbox:[{request:'unknown-kept',kind:'note'}]},{delivery_error:'backend_permission_denied'}]){
  f=await waiting63();await f.modify({last_error:'user_stopped',first_login_page:{stage:'waiting',task_id:19,reason:'session_rest',retry_at:0},...patch});await f.controller.intent(false);f.restart();await f.controller.check(true);await f.controller.start().catch(()=>{});assert.equal(f.calls.length,0,JSON.stringify(patch));assert.equal((await f.read()).enabled,false);
 }
 // Full first-login actor sequence: admitted search, visible subject, control wait, deadline, first body receipt.
 for(const waitReason of ['action_gap','session_rest','global_pause']){
  f=fixture({enabled:false,last_error:'login_required'});f.page({status:'unknown'});const rpc=f.agent.api.rpc;let until=0;
  f.agent.api.rpc=async(name,p)=>{
   if(name==='submit'){f.calls.push({name,p});return {request:p.p_request,gate:'received',inserted:true,duplicate:false,task_received:1};}
   const v=await rpc(name,p);if(name!=='guard')return v;
   if(p.p_action==='search'){until=f.now+120000;return v;}
   if(p.p_action==='control')return {...v,allowed:false,reason:f.now<until?waitReason:null,wait_ms:Math.max(0,until-f.now)};
   return v;
  };
  await f.controller.check(true);assert.equal((await f.read()).first_login_page.stage,'opened');
  f.page({status:'authenticated',principal_ref:'a'.repeat(64)});await f.controller.check(true);s=await f.read();assert.equal(s.last_error,waitReason);assert.equal(s.enabled,false);assert.equal((await f.controller.status()).pending,true);assert.equal(s.wait_kind,'action');
  const heldCalls=f.calls.length;f.restart();await f.controller.check(true);await f.controller.start();assert.equal(f.calls.length,heldCalls,'known activation wait never calls start before its deadline');
  // Reproduce 64's pending=false checkpoint; explicit persisted intent and current control proof suffice.
  const saved=await f.storage.get('participant-session:fixture-owner');await f.storage.set('participant-session:fixture-owner',{...saved,pending:false});
  f.advance(until-f.now+1);await f.controller.check(true);assert.equal((await f.read()).enabled,true);assert.equal((await f.read()).phase,'search');assert.equal((await f.controller.status()).wait_until,null);
  const ids=['abcdef0123456789abcdef01','abcdef0123456789abcdef02'],links=ids.map(id=>'https://www.xiaohongshu.com/explore/'+id);
  const record={schema_version:4,standard:{platform:'xiaohongshu',note_id:ids[0],url:links[0],title:'Original task fixture',captured_at:new Date(f.now).toISOString(),published_at:null,author_display:null,like_count:1,collect_count:1,comment_count:0},evidence:{text:'Synthetic first body for actor regression.',original_length:42,truncated:false,source:'rendered_public_dom',parser_version:'4.2.65'},extra:{author_opinion_quotes:[]}};
  record.evidence.original_length=record.evidence.text.length;f.agent.r.fastCapture=true;
  f.agent.r.probe=async action=>{f.calls.push({name:'probe-'+action});return action==='search'?{ready:true,keyword:f.task.query,links}:{ready:true,record};};
  const step=()=>f.agent.step(()=>{},new AbortController().signal);
  await step();f.advance(1001);await step();assert.equal((await f.read()).phase,'search_done');await step();assert.equal((await f.read()).phase,'note');f.advance(1001);await step();
  s=await f.read();assert.equal(s.received,1);assert.equal(s.outbox.length,0);assert.equal(s.task.id,19);assert.equal(f.calls.filter(x=>x.name==='guard'&&x.p.p_action==='search').length,1);assert.equal(f.calls.filter(x=>x.name==='open-new-owned'&&x.url.includes('/search_result')).length,1);assert.equal(f.calls.filter(x=>x.name==='submit').length,1);assert.equal(f.calls.find(x=>x.name==='submit').p.p_task,19);
 }
 // A claim's explicit acceptance completion cannot be misreported as platform recovery.
 f=await waiting63();const indications=[];f.controller.r.indicate=async value=>indications.push(value);{const rpc=f.agent.api.rpc;f.agent.api.rpc=async(name,p)=>name==='claim'?{error:'test_completed',pilot_phase:'awaiting_acceptance'}:rpc(name,p);}
 await f.controller.check(true);assert.equal((await f.read()).pilot_waiting,true);assert.equal((await f.controller.status()).pending,false);assert.equal(indications.at(-1).pending,false);assert.equal(indications.at(-1).reason,'test_completed');
 // A manual stop during an activation wait cannot be converted to automatic continuation.
 f=fixture({enabled:false,last_error:'action_gap',control:{version:1,reason:'action_gap'},next_at:0});await f.storage.set('participant-session:fixture-owner',{desired_running:false,pending:false,reason:null});await f.controller.check(true);assert.equal(f.calls.length,0);
 // Unknown control/search results and risk responses must never repeat a source action.
 f=await waiting63();f.agent.api.rpc=async(name,p)=>{f.calls.push({name,p});throw Error('network_unknown');};await f.controller.check(true);assert.equal((await f.read()).first_login_page.stage,'checking_wait');f.restart();await f.controller.check(true);await f.controller.start().catch(()=>{});assert.equal(f.calls.length,1);
 for(const guardReason of ['captcha','rate_limit']){f=await waiting63();const rpc=f.agent.api.rpc;f.agent.api.rpc=async(name,p)=>{const v=await rpc(name,p);return name==='guard'?{...v,allowed:false,reason:guardReason,wait_ms:1000}:v;};await f.controller.check(true);assert.equal((await f.read()).last_error,guardReason);f.advance(2000);f.restart();await f.controller.check(true);assert.equal(f.calls.length,1);}
 f=fixture({enabled:false,last_error:'login_required'});f.page({status:'unknown'});{const rpc=f.agent.api.rpc;f.agent.api.rpc=async(name,p)=>{if(name==='guard'){f.calls.push({name,p});throw Error('network_unknown');}return rpc(name,p);};}await f.controller.check(true);assert.equal((await f.read()).first_login_page.stage,'admitting');assert.equal((await f.read()).last_error,'control_unavailable');f.restart();await f.controller.check(true);assert.equal(f.calls.length,3);
 for(const sourceReason of ['captcha','rate_limit']){f=await waiting63();f.page({status:'challenge',reason:sourceReason});await f.controller.check(true);assert.equal((await f.read()).last_error,sourceReason);assert.equal(f.calls.length,0,'visible platform risk stops before control recheck');}
 // Stop wins an in-flight read-only recheck; no later exact claim or page open.
 f=await waiting63();let controlRelease;{const rpc=f.agent.api.rpc;f.agent.api.rpc=async(name,p)=>{const v=await rpc(name,p);return name==='guard'?new Promise(resolve=>{controlRelease=()=>resolve({...v,allowed:false,reason:null});}):v;};}
 const checking=f.controller.check(true);while(!controlRelease)await pause();await f.controller.intent(false);const halted=f.agent.stop('user_stopped',{keepPage:true});controlRelease();await Promise.all([checking,halted]);assert.equal((await f.read()).enabled,false);assert.equal((await f.controller.status()).desired_running,false);assert.equal(f.calls.length,1);
 console.log('PASS actual agent + platform health: durable same-account resume, stable task/outbox, manual-stop RPC race, unknown/different account, backend/test/unknown/risk blocks, expired lease hold, first-login exact renewal without fallback');
})().catch(e=>{console.error(e);process.exitCode=1;});
