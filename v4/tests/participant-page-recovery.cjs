'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{randomUUID,createHash}=require('node:crypto');
for(const n of ['core','agent','work-tabs','session-health','participant-session'])vm.runInThisContext(fs.readFileSync('v4/src/'+n+'.js','utf8'));
const background=fs.readFileSync('v4/src/participant-background.js','utf8'),probeCode=background.slice(background.indexOf('async function normalizeSessionPage'),background.indexOf('let indicatedPlatformSession'));
const pause=()=>new Promise(r=>setImmediate(r));
function fixture(extra={}){
 let now=Date.now(),mode='complete',seq=10,owner='fixture-owner',page='authenticated',principal='a'.repeat(24),storageFailure=false;
 const data={},sessionData={},calls=[],tabs=new Map(),hash=x=>createHash('sha256').update(x).digest('hex'),expected=hash(owner+'\nxiaohongshu\n'+'a'.repeat(24));
 const raw={get:async k=>structuredClone(data[k]),set:async(k,v)=>{if(storageFailure&&k.startsWith('agent:')&&v.task_archives?.length)throw Error('storage_full');data[k]=structuredClone(v);}};data.session={user:{id:owner}};
 const storage=CrowdCore.accountStorage(raw),task={id:19,query:'original',platform:'xiaohongshu',lease_token:'old-lease',lease_until:new Date(now-600000).toISOString(),received:2,target:2,comments_capture:false,structured_capture:false};
 data['agent:'+owner]={...CrowdCore.initial(),enabled:true,delivery_enabled:true,consent:CrowdCore.CONSENT,task,phase:'enrich',pilot_phase:'awaiting_acceptance',pilot_waiting:true,last_error:'test_completed',received:2,history:['body-one','body-two'],enrichment:{stage:'comments',parent:'original-parent',proof:'original-proof',cursor:17},...extra};
 data['platform-health:'+owner]={xiaohongshu:{status:'authenticated',expected_ref:expected,observed_ref:expected}};
 data['participant-session:'+owner]={desired_running:true,pending:false,initial_confirmed_at:now-600000};
 data['work_tabs:'+owner]={search:{session:'old-browser',tab:999,url:CrowdCore.HOST+'/search_result?keyword=old',token:'old-token',document:'old-doc',state:'opened'}};
 const originalTask=structuredClone(task),originalPartial=structuredClone(data['agent:'+owner].enrichment);
 const chrome={storage:{session:{get:async k=>({[k]:sessionData[k]}),set:async v=>Object.assign(sessionData,v)}},tabs:{
  query:async()=>[...tabs.values()].map(t=>({...t})),
  get:async id=>{assert.notEqual(id,999,'old browser tab ID cannot be read/adopted');if(!tabs.has(id))throw Error('missing');return {...tabs.get(id)};},
  update:async(id,patch)=>{assert.notEqual(id,999);calls.push({name:'tab-update',patch});Object.assign(tabs.get(id),patch);return {...tabs.get(id)};},
  sendMessage:async(id,m)=>{assert.notEqual(id,999);const t=tabs.get(id);if(m.type==='crowd_bind'){t.token=m.token;return {document:t.document};}if(m.type==='crowd_session_probe')return {platform:'xiaohongshu',status:page,...(page==='authenticated'?{principal_id:principal,verification:'rendered_account_navigation'}:page==='challenge'?{reason:'captcha'}:{})};throw Error('unexpected message');},
  remove:async()=>{throw Error('must not close real/old tabs');}
 },windows:{create:async({url})=>{calls.push({name:'open',url});const t={id:++seq,windowId:1,status:'complete',url,document:randomUUID(),token:null};tabs.set(t.id,t);return {id:1,tabs:[{...t}]};},update:async()=>{calls.push({name:'focus'});}}};
 const next={...task,id:21,query:'next permitted',lease_token:'new-lease',lease_until:new Date(now+3600000).toISOString(),received:0};
 const policy=(action)=>({version:1,ttl_ms:60000,allowed:action==='search',paused:false,reason:null,wait_ms:0,gap_ms:1000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:1,detail:2,comment:0,scroll:0},pilot_phase:'active'});
 const api={rpc:async(name,p)=>{calls.push({name,p});if(name==='status')return {participant:{status:'approved'}};if(name==='finish')return {status:'complete',received:2,available_at:null};if(name==='claim')return {task:structuredClone(next)};if(name==='guard')return mode==='active'?policy(p.p_action):{error:'test_completed',pilot_phase:'awaiting_acceptance'};throw Error('unexpected RPC '+name);}};
 let health,agent,workTabs,session;const r={recoveryPages:true,storage,owner:async()=>owner,now:()=>now,uuid:randomUUID,random:()=>.5,leaseScope:async x=>hash(x),schedule:async()=>{},scheduleDelivery:async()=>{},cancel:async()=>{},cancelDelivery:async()=>{},close:async()=>{throw Error('must preserve pages');}};
 const makeTabs=()=>new CrowdWorkTabs({chrome,storage,owner:r.owner,uuid:randomUUID,probe:async(id,action)=>{assert.notEqual(id,999);const t=tabs.get(id);return {response:action==='ownership'?{token:t.token,document:t.document}:{ready:true}};}});workTabs=makeTabs();
 agent=new CrowdAgent(r,api);
 const probes=new Function('runtime','workTabs','platformHealth','storage','chrome','agent',probeCode+';return {probePlatformSessions,normalizeSessionPage};');
 let normalize;const wire=()=>{const p=probes(r,workTabs,health,storage,chrome,agent);normalize=p.normalizeSessionPage;return p;};
 health=new CrowdPlatformHealth({storage,owner:r.owner,now:r.now,probe:async()=>wire().probePlatformSessions()});
 r.verificationCurrent=slot=>workTabs.verificationCurrent(slot);
 r.expectedPrincipal=async()=>(await health.read()).xiaohongshu?.expected_ref;
 r.verifyPage=async slot=>normalize(await workTabs.verificationProbe(slot,async p=>(await normalize(p,owner)).principal_ref===await r.expectedPrincipal()),owner);
 r.openVerification=async(url,slot,manual,valid)=>{assert.ok(await valid());await workTabs.open(url,slot,{verificationHome:manual});if(manual)await workTabs.focusVerification(slot);};
 r.focusVerification=slot=>workTabs.focusVerification(slot);r.adoptVerification=(slot,valid)=>workTabs.adoptVerification(slot,valid);
 const makeSession=()=>new CrowdParticipantSession({storage,owner:r.owner,now:r.now,agent,health,start:agent.start.bind(agent),stop:agent.stop.bind(agent),rebind:valid=>workTabs.rebindAfterLogin(valid),reconcile:valid=>agent.reconcileCompletedTask(valid),recoverPage:(valid,options)=>agent.recoverLoginPage(valid,options),verificationNeeded:()=>workTabs.recoveryNeeded()});session=makeSession();wire();r.sourceHealth=()=>session.require();
 return {data,storage,calls,agent,health,chrome,tabs,task,next,originalTask,originalPartial,r,policy,get session(){return session;},get workTabs(){return workTabs;},get now(){return now;},set mode(v){mode=v;},set page(v){page=v;},set principal(v){principal=v;},set storageFailure(v){storageFailure=v;},advance(n){now+=n;},restart(){workTabs=makeTabs();session=makeSession();wire();},async tick(){await session.check(true);await agent.tick();await session.check(true);},read:()=>agent.read(),async modify(p){const s=await agent.read();Object.assign(s,p);await agent.save(s);}};
}
(async()=>{
 // Full real-class chain: old marker + expired full task + partial comments ->
 // cloud-only finish and archival while parked; armed -> one new real claim and
 // one admitted owned page -> original principal -> preserve new search, no replay.
 let f=fixture();await f.tick();let s=await f.read();assert.equal(s.pilot_waiting,true);assert.equal(s.task,null);assert.deepEqual(s.task_archives[0].task,f.originalTask);assert.deepEqual(s.task_archives[0].enrichment,f.originalPartial);assert.equal(s.task_archives[0].enrichment_result,'partial_archived');assert.deepEqual(s.history,['body-one','body-two']);assert.equal(s.received,2);assert.equal(f.calls.filter(c=>c.name==='finish').length,1);assert.equal(f.calls.filter(c=>c.name==='open'||c.name==='claim').length,0);
 f.mode='active';f.advance(60001);await f.tick();s=await f.read();assert.equal(s.task.id,21);assert.equal(s.phase,'search');assert.equal(s.enabled,true);assert.equal(s.verification_page.stage,'confirmed');assert.equal(f.calls.filter(c=>c.name==='claim').length,1);assert.equal(f.calls.filter(c=>c.name==='guard'&&c.p.p_action==='search').length,1);assert.equal(f.calls.filter(c=>c.name==='open').length,1);assert.equal((await f.health.read()).xiaohongshu.expected_ref,(await f.health.read()).xiaohongshu.observed_ref);
 f.restart();await f.session.check(true);assert.equal(f.calls.filter(c=>c.name==='open').length,1);
 // Actual second-device checkpoint: stopped by stale lease before normal parking.
 f=fixture({enabled:false,last_error:'lease_lost',pilot_waiting:false});await f.tick();s=await f.read();assert.equal(s.pilot_waiting,true);assert.equal(s.enabled,true);assert.equal(s.task,null);assert.equal(f.calls.filter(c=>c.name==='open'||c.name==='claim').length,0);
 // Manual login during acceptance is a homepage-only user navigation. No task
 // claim/search guard, no budget/identity/checkpoint edits; same page on repeat.
 f=fixture();await f.session.openLogin();s=await f.read();assert.equal(s.verification_page.manual,true);assert.equal(s.verification_page.stage,'confirmed');assert.equal(s.task.id,19);assert.deepEqual(s.enrichment,f.originalPartial);assert.equal(f.calls.filter(c=>c.name==='claim'||c.name==='finish'||c.name==='guard'&&c.p.p_action==='search').length,0);assert.equal(f.calls.filter(c=>c.name==='open').length,1);await f.session.openLogin();assert.equal(f.calls.filter(c=>c.name==='open').length,1);
 // Missing/wrong account on the new page cannot be masked by another tab.
 for(const page of ['unknown','logged_out','challenge']){f=fixture();f.page=page;await f.session.openLogin();assert.equal((await f.read()).verification_page.stage,'opened');assert.equal(f.calls.filter(c=>c.name==='claim').length,0);}
 f=fixture();f.principal='b'.repeat(24);await f.session.openLogin();assert.equal((await f.read()).verification_page.stage,'opened');assert.equal((await f.health.read()).xiaohongshu.status,'account_changed');
 // Worker restart before first bound proof can bind only its known current-session
 // verification slot after the original principal is independently observed.
 f=fixture();f.page='unknown';await f.session.openLogin();f.restart();f.page='authenticated';await f.session.openLogin();assert.equal((await f.read()).verification_page.stage,'confirmed');assert.equal(f.calls.filter(c=>c.name==='open').length,1);
 // Cloud finish unknown is idempotent same-token retry, never a fresh task claim.
 f=fixture();const original=f.agent.api.rpc;let fail=true;f.agent.api.rpc=async(n,p)=>{if(n==='finish'&&fail){f.calls.push({name:n,p});throw Error('network_unknown');}return original(n,p);};await f.tick();s=await f.read();assert.equal(s.task.id,19);assert.deepEqual(s.enrichment,f.originalPartial);f.restart();await f.tick();assert.equal(f.calls.filter(c=>c.name==='finish').length,1);fail=false;f.advance(60001);await f.tick();assert.equal((await f.read()).task,null);assert.deepEqual(f.calls.filter(c=>c.name==='finish').map(c=>c.p),[{p_task:19,p_lease:'old-lease'},{p_task:19,p_lease:'old-lease'}]);
 f=fixture();f.storageFailure=true;await f.session.check(true).catch(()=>{});assert.equal(f.data['agent:fixture-owner'].task.id,19);assert.deepEqual(f.data['agent:fixture-owner'].enrichment,f.originalPartial);assert.equal(f.calls.filter(c=>c.name==='claim').length,0);
 // Unknown claim/open never retries after restart or repeated explicit buttons.
 for(const failing of ['claim','open']){f=fixture();await f.tick();f.mode='active';await f.modify({pilot_phase:'active',pilot_waiting:false,last_error:'identity_verification_required',enabled:false});if(failing==='claim'){const rpc=f.agent.api.rpc;f.agent.api.rpc=async(n,p)=>{if(n==='claim'){f.calls.push({name:n,p});throw Error('network_unknown');}return rpc(n,p);};}else f.chrome.windows.create=async()=>{f.calls.push({name:'open'});throw Error('network_unknown');};await f.session.check(true);f.restart();await f.session.check(true);await f.session.start();assert.equal(f.calls.filter(c=>c.name===failing).length,1);assert.equal((await f.read()).enabled,false);}
 // Manual stop, unknown queue/SDK/risk and unfinished old lease cannot be hidden.
 for(const patch of [{outbox:[{request:'original-unknown'}]},{sdk_pending:{status:'unknown'}},{risk_report:{state:'unknown'}},{work_slots:[{phase:'note'}]},{pending_batch:{request:'x'}},{last_error:'backend_permission_denied'}]){f=fixture(patch);await f.session.check(true);assert.equal(f.calls.length,0,JSON.stringify(patch));assert.equal((await f.read()).task.id,19);}
 f=fixture();await f.session.intent(false);await f.agent.stop('user_stopped',{keepPage:true});await f.tick();assert.equal(f.calls.length,0);
 f=fixture({enabled:false,last_error:'identity_verification_required',pilot_phase:'active',pilot_waiting:false,task:{id:19,query:'old',platform:'xiaohongshu',lease_token:'old',lease_until:new Date(Date.now()-1000).toISOString(),received:1,target:2}});f.mode='active';await f.session.check(true);assert.equal((await f.read()).task.id,19);assert.equal((await f.read()).last_error,'task_reconciliation_required');assert.equal(f.calls.filter(c=>c.name==='claim'||c.name==='open').length,0);
 // Known guard refusal honors the saved deadline even after explicit Continue.
 f=fixture();await f.tick();f.mode='active';await f.modify({pilot_phase:'active',pilot_waiting:false,last_error:'identity_verification_required',enabled:false});let blocked=true;{const rpc=f.agent.api.rpc;f.agent.api.rpc=async(n,p)=>{const v=await rpc(n,p);return n==='guard'&&p.p_action==='search'&&blocked?{...v,allowed:false,reason:'action_gap',wait_ms:120000}:v;};}await f.session.check(true);const n=f.calls.length;f.restart();await f.session.start();assert.equal(f.calls.length,n);blocked=false;f.advance(120001);await f.session.check(true);assert.equal(f.calls.filter(c=>c.name==='claim').length,1);assert.equal(f.calls.filter(c=>c.name==='open').length,1);
 // Stop while an admission is pending prevents any later window creation.
 f=fixture();await f.tick();f.mode='active';await f.modify({pilot_phase:'active',pilot_waiting:false,last_error:'identity_verification_required',enabled:false});let release;{const rpc=f.agent.api.rpc;f.agent.api.rpc=async(n,p)=>{const v=await rpc(n,p);return n==='guard'&&p.p_action==='search'?new Promise(r=>release=()=>r(v)):v;};}const running=f.session.check(true);while(!release)await pause();await f.session.intent(false);const stopping=f.agent.stop('user_stopped',{keepPage:true});release();await Promise.all([running,stopping]);assert.equal(f.calls.filter(c=>c.name==='open').length,0);assert.equal((await f.read()).enabled,false);
 // A different ordinary tab must not supply the missing owned-page identity.
 f=fixture();f.page='unknown';await f.session.openLogin();const send=f.chrome.tabs.sendMessage;f.tabs.set(77,{id:77,windowId:1,status:'complete',url:CrowdCore.HOST+'/explore/'+'a'.repeat(24),document:'other'});f.chrome.tabs.sendMessage=async(id,m)=>id===77&&m.type==='crowd_session_probe'?{platform:'xiaohongshu',status:'authenticated',principal_id:'a'.repeat(24),verification:'rendered_account_navigation'}:send(id,m);await f.health.check(true);assert.equal((await f.health.read()).xiaohongshu.status,'unknown');assert.equal((await f.read()).verification_page.stage,'opened');
 // A same-account login document can rebind only this current-browser verification slot.
 f=fixture();await f.session.openLogin();const tab=[...f.tabs.values()][0];tab.document=randomUUID();tab.token=null;f.page='logged_out';await f.health.check(true);assert.equal((await f.health.read()).xiaohongshu.status,'logged_out');f.page='authenticated';await f.health.check(true);assert.equal((await f.health.read()).xiaohongshu.status,'authenticated');assert.equal(f.calls.filter(c=>c.name==='open').length,1);
 // Wake-up preserves unfinished comment cursor and original parent before enrich.
 f=fixture({pilot_waiting:false,pilot_phase:'active',last_error:null});f.r.recoveryPages=false;f.mode='active';
 await f.modify({last_tick:f.now-130000,task:{...f.task,received:1,target:2,lease_until:new Date(f.now+3600000).toISOString()},enrichment:{stage:'comments',cursor:17,parent:'kept-parent'},control:f.policy('control'),control_checked:f.now,control_expires:f.now+60000,next_at:f.now});
 let checkpoint=null;f.agent.enrich=async state=>{checkpoint=structuredClone(state.enrichment);};await f.agent.tick();
 assert.deepEqual(checkpoint,{stage:'comments',cursor:17,parent:'kept-parent'});assert.equal(f.calls.filter(c=>c.name==='open').length,0);
 // Repeated OTA/browser generations reuse the original task and budgeted admission,
 // never the stale tab ID or the previous confirmed proof.
 f=fixture();await f.tick();f.mode='active';f.advance(60001);await f.tick();
 for(let round=0;round<2;round++){
   f.chrome.storage.session.get=async()=>({});f.restart();f.advance(60001);await f.session.check(true);
   assert.equal((await f.read()).verification_page.stage,'confirmed');
   assert.equal((await f.read()).task.id,21);assert.equal(f.calls.filter(c=>c.name==='claim').length,1);
   assert.equal(f.calls.filter(c=>c.name==='open').length,round+2);
 }
 // Non-responding owned receiver releases the health/session mutex and a late
 // reply cannot write confirmation after the timed-out invocation has returned.
 f=fixture();f.page='unknown';await f.session.openLogin();const sender=f.chrome.tabs.sendMessage;let late;
 f.chrome.tabs.sendMessage=async(id,m)=>m.type==='crowd_session_probe'?new Promise(resolve=>{late=resolve;}):sender(id,m);
 await f.session.check(true);assert.equal(f.session.active,null);assert.equal(f.health.active,null);
 assert.equal((await f.read()).verification_page.stage,'opened');
 late?.({platform:'xiaohongshu',status:'authenticated',principal_id:'a'.repeat(24),verification:'rendered_account_navigation'});
 await pause();assert.equal((await f.read()).verification_page.stage,'opened');
 console.log('PASS recovery actual Agent/Session/Health/WorkTabs/background probes: full-task idempotent closure, partial archive, stopped lease migration, manual owned page, armed actual task once, same principal, original marker refusal, restart/unknown/stop/queue/auth/expired boundaries');
})().catch(e=>{console.error(e);process.exitCode=1;});
