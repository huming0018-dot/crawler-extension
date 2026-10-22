'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{randomUUID,createHash}=require('node:crypto');
const path=require('node:path'),SRC=process.argv[2]?path.resolve(process.argv[2]):path.join(__dirname,'../src');
for(const n of ['core','agent','work-tabs','session-health','participant-session'])vm.runInThisContext(fs.readFileSync(path.join(SRC,n+'.js'),'utf8'));
const background=fs.readFileSync(path.join(SRC,'participant-background.js'),'utf8'),probeCode=background.slice(background.indexOf('async function normalizeSessionPage'),background.indexOf('let indicatedPlatformSession'));
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
 },windows:{create:async({url})=>{calls.push({name:'open',url});const t={id:++seq,windowId:1,status:'complete',url,document:randomUUID(),token:null};tabs.set(t.id,t);return {id:1,tabs:[{...t}]};},get:async()=>({id:1,type:'normal',state:'minimized',tabs:[...tabs.values()].slice(-1)}),update:async(_,patch)=>{calls.push({name:'focus',patch});}}};
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
 r.openVerification=(...args)=>new Function('workTabs','return ({'+background.match(/  async openVerification[^\n]+/)[0]+'}).openVerification')(workTabs)(...args);
 const retireStart=background.indexOf('  async retireMissingVerification'),retireEnd=background.indexOf('  expectedPrincipal:',retireStart);if(retireStart>=0)r.retireMissingVerification=(...args)=>new Function('runtime','workTabs','storage','chrome','platformHealth','agent','return ({'+background.slice(retireStart,retireEnd)+'}).retireMissingVerification')(r,workTabs,storage,chrome,health,agent)(...args);
 r.focusVerification=slot=>workTabs.focusVerification(slot);r.adoptVerification=(slot,valid)=>workTabs.adoptVerification(slot,valid);
 const makeSession=()=>new CrowdParticipantSession({storage,owner:r.owner,now:r.now,agent,health,start:agent.start.bind(agent),stop:agent.stop.bind(agent),rebind:valid=>workTabs.rebindAfterLogin(valid),reconcile:valid=>agent.reconcileCompletedTask(valid),recoverPage:(valid,options)=>agent.recoverLoginPage(valid,options),verificationCurrent:slot=>workTabs.verificationCurrent(slot),verificationNeeded:()=>workTabs.recoveryNeeded()});session=makeSession();wire();r.sourceHealth=()=>session.require();
 return {data,storage,calls,api,agent,health,chrome,tabs,task,next,originalTask,originalPartial,r,policy,get session(){return session;},get workTabs(){return workTabs;},get now(){return now;},set mode(v){mode=v;},set page(v){page=v;},set principal(v){principal=v;},set storageFailure(v){storageFailure=v;},advance(n){now+=n;},restart(){workTabs=makeTabs();session=makeSession();wire();},async tick(){await session.check(true);await agent.tick();await session.check(true);},read:()=>agent.read(),async modify(p){const s=await agent.read();Object.assign(s,p);await agent.save(s);}};
}

async function prepared({current=false}={}){
 const f=fixture({task:null,enrichment:null,phase:'idle',pilot_waiting:false,last_error:'identity_verification_required'});f.page='authenticated';await f.session.openLogin();let s=await f.read();const slot=s.verification_page.slot,entry=(await f.workTabs.entries())[slot];
 await f.modify({received:20,task:null,enrichment:null,phase:'idle',enabled:false,delivery_error:null,pilot_phase:'awaiting_acceptance',pilot_waiting:false,last_error:'identity_verification_required',verification_page:{...s.verification_page,stage:'confirmed'},acceptance_supplement:{schema:'crowd-acceptance-batch-v1',state:'admitted',id:randomUUID(),task_id:19,installation_id:randomUUID(),baseline_received:2,extra_limit:20,target:22,remaining:2}});
 f.data['node-monitor:fixture-owner']={installation_id:(await f.read()).acceptance_supplement.installation_id};f.data['participant-session:fixture-owner'].pending=true;f.data['participant-session:fixture-owner'].reason='identity_verification_required';f.data['work_tabs:fixture-owner']={[slot]:{...entry,state:'missing'}};f.tabs.delete(entry.tab);
 const oldGet=f.chrome.tabs.get;f.chrome.tabs.get=async id=>{if(id===entry.tab){if(!current)throw Error('old metadata must not read tab');throw Error('No tab with id: '+id+'.');}return oldGet(id);};
 if(!current){await f.chrome.storage.session.set({crowd_work_session:'post-OTA-browser'});f.restart();}
 const g=(await f.read()).acceptance_supplement,wire=Object.fromEntries(['schema','id','task_id','installation_id','baseline_received','extra_limit','target','remaining'].map(k=>[k,g[k]]));f.api.rpc=async(name,args)=>{f.calls.push({name,p:args});if(name==='status')return {participant:{status:'approved'}};if(name==='guard')return {...f.policy(args.p_action),allowed:true,pilot_phase:'awaiting_acceptance',acceptance_supplement:structuredClone(wire)};if(name==='claim')return {task:null,acceptance_supplement:structuredClone(wire)};throw Error('unexpected_rpc_'+name);};
 f.page='authenticated';return {f,slot,entry,wire,before:structuredClone(await f.read()),oldGet};
}
const opens=f=>f.calls.filter(c=>c.name==='open').length,sourceCalls=f=>f.calls.filter(c=>c.name==='guard'&&['search','detail','scroll','comment'].includes(c.p?.p_action));
(async()=>{
 for(const current of [false,true]){const {f,slot,before}=await prepared({current});const n=opens(f),focus=f.calls.filter(c=>c.name==='focus').length;await f.session.check(true);let s=await f.read();assert.equal(opens(f),n+1,'authorized tasknull batch must recover quiet HOME');assert.equal(s.verification_page.stage,'confirmed');assert.notEqual(s.verification_page.slot,slot);assert.equal((await f.workTabs.entries())[slot].state,'retired');assert.equal(f.calls.filter(c=>c.name==='focus').length,focus);assert.equal(s.received,20);assert.deepEqual(s.history,before.history);assert.deepEqual(s.outbox,before.outbox);assert.equal(s.acceptance_supplement.remaining,2);assert.equal(s.task,null);assert.equal((await f.health.read()).xiaohongshu.status,'authenticated');assert.equal(sourceCalls(f).length,0);await f.session.check(true);assert.equal(opens(f),n+1,'same proof does not create again');}
 const cases=[s=>s.acceptance_supplement.state='consumed',s=>s.acceptance_supplement.remaining=0,s=>s.acceptance_supplement.remaining=1,s=>s.acceptance_supplement.schema='crowd-acceptance-extra1-v1',s=>s.last_error='user_stopped',s=>s.last_error='platform_identity_changed',s=>s.pending_risk='captcha',s=>s.outbox=[{request:'unknown'}],s=>s.sdk_pending={status:'unknown'},s=>s.delivery_error='backend_unavailable',s=>s.verification_page.stage='opening',s=>s.acceptance_supplement.installation_id=randomUUID(),s=>s.task_closure={stage:'pending'},s=>s.enrichment={}];
 for(const mutate of cases){const {f}=await prepared();const s=await f.read();mutate(s);await f.agent.save(s);const n=opens(f);try{await f.session.check(true)}catch(_){}assert.equal(opens(f),n);assert.equal(sourceCalls(f).length,0);}
 for(const variant of ['denied','changedgrant','unknownentry','unknownNoTab','presentTab','CASrace','differentaccount','desiredfalse']){const {f,slot,entry}=await prepared({current:variant==='unknownNoTab'||variant==='presentTab'}),n=opens(f),rpc=f.api.rpc;
  if(variant==='denied'||variant==='changedgrant')f.api.rpc=async(name,args)=>{const value=await rpc(name,args);if(name==='guard'){if(variant==='denied'){value.allowed=false;value.reason='test_completed';}else value.acceptance_supplement.remaining=1;}return value;};
  if(variant==='unknownentry')f.data['work_tabs:fixture-owner'][slot].state='opening';
  if(variant==='unknownNoTab')f.chrome.tabs.get=async()=>{throw Error('unknown browser error');};
  if(variant==='presentTab')f.chrome.tabs.get=async()=>({id:entry.tab,url:CrowdCore.HOST+'/',status:'complete'});
  if(variant==='CASrace'){const write=f.workTabs.write.bind(f.workTabs);f.workTabs.write=(fn,key)=>{f.data['work_tabs:fixture-owner'][slot].token=randomUUID();return write(fn,key);};}
  if(variant==='differentaccount')f.principal='b'.repeat(24);
  if(variant==='desiredfalse')f.data['participant-session:fixture-owner'].desired_running=false;
  try{await f.session.check(true)}catch(_){}assert.equal(sourceCalls(f).length,0,variant);if(variant==='differentaccount'){assert.equal(opens(f),n+1);assert.notEqual((await f.health.read()).xiaohongshu.status,'authenticated');assert.equal(f.calls.filter(c=>c.name==='claim').length,0);}else assert.equal(opens(f),n,variant);
 }
 console.log('PASS actual Session+Agent+WorkTabs+runtime quiet tasknull authorized batch recovery old/current missing; same-account confirmation/no source/no repeat;22 unsafe/permission/unknown/race denials');
})().catch(e=>{console.error(e.stack);process.exitCode=1});
