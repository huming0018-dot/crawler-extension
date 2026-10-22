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
 const f=fixture({enabled:false,last_error:'test_completed',phase:'idle'});await f.session.intent(false);f.page='logged_out';await f.session.openLogin();let s=await f.read();assert.equal(s.verification_page.stage,'opened');
 const keep=()=>JSON.stringify({task:s.task,received:s.received,history:s.history,enrichment:s.enrichment,outbox:s.outbox,enabled:s.enabled,pilot_phase:s.pilot_phase,pilot_waiting:s.pilot_waiting});const before=keep();const oldCalls=f.calls.length;
 f.agent.api.rpc=async()=>{throw Error('unexpected new RPC during DOM-only confirmation')};f.session.r.start=async()=>{throw Error('must not restart stopped collection')};f.page='authenticated';f.advance(60001);await f.session.check(true);s=await f.read();assert.equal(s.verification_page.stage,'confirmed','same original account login while stopped must confirm without another button');assert.equal(s.verification_page.manual,true);assert.equal(keep(),before);assert.equal((await f.session.status()).desired_running,false);assert.equal(f.calls.length,oldCalls);console.log('PASS stopped same-original DOM recovery confirms without start/claim/guard/navigation/budget changes');
})().catch(e=>{console.error(e);process.exitCode=1});
