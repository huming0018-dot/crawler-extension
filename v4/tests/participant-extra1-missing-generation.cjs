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
 const bg=fs.readFileSync(path.join(SRC,'participant-background.js'),'utf8');
 const a=bg.indexOf('  async retireSupplementPage(valid){'),b=bg.indexOf('\n  },',a)+5;
 const retire=(tabs,chrome)=>new Function('workTabs','chrome','return ({'+bg.slice(a,b)+'}).retireSupplementPage')(tabs,chrome);
 const oa=bg.indexOf('  async open(url, unused = false, slot = null) {'),ob=bg.indexOf('\n  async probe(',oa);
 const open=(tabs,storage)=>new Function('workTabs','CrowdCore','trace','clearNavigation','storage','pendingTabCreation','return ({'+bg.slice(oa,ob)+'}).open')(tabs,CrowdCore,{event:async()=>{}},async()=>{},storage,null);
 let f=fixture({task:null,enrichment:null,phase:'idle'});await f.session.openLogin();let state=await f.read();assert.equal(state.verification_page.stage,'confirmed');
 await f.workTabs.removed(999);assert.equal((await f.workTabs.entries()).search.state,'missing');
 const url=CrowdCore.taskPlatform({}).searchURL('original');
 await assert.rejects(()=>f.workTabs.open(url,'search'),e=>e.poolCause==='entry_state');
 // Install only the production thin wrapper; no old tab read, close or parser substitute.
 const install=randomUUID(),g={schema:'crowd-acceptance-extra1-v1',id:randomUUID(),task_id:19,installation_id:install,baseline_received:2,extra_limit:1,remaining:1,expires_at:new Date(f.now+3600000).toISOString()};
 await f.storage.set('node-monitor:fixture-owner',{installation_id:install});
 f.r.retireSupplementPage=retire(f.workTabs,f.chrome);f.r.open=open(f.workTabs,f.storage);
 const rpc=f.agent.api.rpc;f.agent.api.rpc=async(n,p)=>{if(n==='guard'){f.calls.push({name:n,p});return {...f.policy(p.p_action),allowed:true,pilot_phase:'awaiting_acceptance',acceptance_supplement:structuredClone(g)};}if(n==='claim'){f.calls.push({name:n,p});return {acceptance_supplement:structuredClone(g),task:{...f.task,id:19,received:2,target:3,remaining_today:1,lease_token:'new-permitted',lease_until:new Date(f.now+3600000).toISOString()}};}return rpc(n,p);};
 f.advance(60001);await f.agent.step(()=>{},new AbortController().signal);state=await f.read();assert.equal(state.acceptance_supplement?.state,'admitted','known removed old generation must retire without touching old tab');assert.equal((await f.workTabs.entries()).search.state,'retired');
 await f.agent.step(()=>{},new AbortController().signal);state=await f.read();assert.equal(state.task.id,19);assert.equal(state.phase,'idle');
 await f.agent.step(()=>{},new AbortController().signal);state=await f.read();assert.equal(state.phase,'search');const entries=await f.workTabs.entries();assert.equal(entries.search.state,'opened');assert.notEqual(entries.search.tab,999);assert.equal(entries.search.session,await f.workTabs.session());
 const proof=await f.workTabs.read('ownership','search');assert.equal(proof.token,entries.search.token);assert.equal(proof.document,(await f.workTabs.entries()).search.document);assert.equal(state.received,2);assert.deepEqual(state.history,['body-one','body-two']);assert.equal(f.calls.filter(c=>c.name==='claim').length,1);
 assert(Object.values(entries).some(e=>e.tab===999&&e.state==='retired'));
 // Continue through original Agent/WorkTabs ownership+body validation+durable outbox/receipt.
 const note='e'.repeat(24),urlNote=CrowdCore.HOST+'/explore/'+note,text='原任务同输入脱敏公开正文；保留原两条记录与身份，不是实际平台采集。';
 const record={schema_version:4,standard:{platform:'xiaohongshu',note_id:note,url:urlNote,title:'原任务脱敏正文',captured_at:new Date(f.now).toISOString(),published_at:null,author_display:'脱敏作者',like_count:0,collect_count:0,comment_count:0},extra:{author_opinion_quotes:[]},evidence:{text,original_length:text.length,truncated:false,parser_version:'4.2.76',source:'rendered_public_dom'}};
 const originalProbe=f.workTabs.probe.bind(f.workTabs);f.workTabs.probe=async(id,action,...args)=>{if(action==='ownership')return originalProbe(id,action,...args);if(action==='search')return {response:{ready:true,keyword:'original',links:[urlNote]}};if(action==='note_ready'||action==='note')return {response:{ready:true,record:structuredClone(record)}};throw Error('unexpected source action '+action);};
 const browserUpdate=f.chrome.tabs.update;f.chrome.tabs.update=async(id,patch)=>{const result=await browserUpdate(id,patch);if(patch.url===urlNote){const tab=f.tabs.get(id);tab.document=randomUUID();tab.token=null;return {...tab};}return result;};
 f.r.fastCapture=true;f.r.probe=(action,slot)=>f.workTabs.read(action,slot||'search');let submitCount=0;const originalRPC=f.agent.api.rpc;f.agent.api.rpc=async(n,p)=>{if(n!=='submit')return originalRPC(n,p);submitCount++;assert.equal(p.p_task,19);assert.equal(p.p_record.evidence.text,text);assert.equal(p.p_record.standard.note_id,note);return {request:p.p_request,gate:'received',inserted:true,duplicate:false,task_received:3};};
 for(let i=0;i<6&&state.received!==3;i++){f.advance(2000);await f.agent.step(()=>{},new AbortController().signal);state=await f.read();}
 assert.equal(state.received,3,JSON.stringify({state,calls:f.calls}));assert.equal(submitCount,1);assert.equal(state.outbox.length,0);assert.equal(state.acceptance_supplement.state,'consumed');assert.equal(state.pilot_waiting,true);assert.equal(state.last_error,'test_completed');assert.deepEqual(state.history,['body-one','body-two',note]);assert.equal(f.calls.filter(c=>c.name==='claim').length,1);
 // The stopped-session periodic supplement caller uses the SAME runtime retirement, without Start.
 {const q=fixture({task:null,enrichment:null,phase:'idle'});await q.session.openLogin();await q.workTabs.removed(999);const install=randomUUID(),g2={...g,id:randomUUID(),installation_id:install,expires_at:new Date(q.now+3600000).toISOString()};await q.storage.set('node-monitor:fixture-owner',{installation_id:install});q.r.retireSupplementPage=retire(q.workTabs,q.chrome);await q.modify({enabled:false,last_error:'control_unavailable',pilot_waiting:true});q.agent.api.rpc=async(n,p)=>{if(n==='guard')return {...q.policy(p.p_action),allowed:true,pilot_phase:'awaiting_acceptance',acceptance_supplement:g2};throw Error('periodic admission must not Start/claim');};assert.equal(await q.agent.checkAcceptanceSupplement(async()=>true),true);assert.equal((await q.read()).received,2);assert.equal((await q.read()).acceptance_supplement.state,'admitted');assert.equal((await q.workTabs.entries()).search.state,'retired');}
 // Missing in the same generation or uncertain navigation is never retired.
 for(const mode of ['same_generation_missing','no_old_session','no_marker','opening','unknown','claiming','foreign_owner','unsafe']){
  const q=fixture({task:null,enrichment:null,phase:'idle'});await q.session.openLogin();await q.workTabs.removed(999);const e=await q.workTabs.entries(),marker=await q.workTabs.session();
  if(mode==='same_generation_missing')e.search.session=marker;
  if(mode==='no_old_session')delete e.search.session;
  if(['opening','unknown','claiming'].includes(mode))e.search.state=mode;
  await q.storage.set('work_tabs:fixture-owner',e);if(mode==='no_marker')await q.chrome.storage.session.set({crowd_work_session:''});
  const before=structuredClone(await q.workTabs.entries());await assert.rejects(()=>retire(q.workTabs,q.chrome)(async()=>!['foreign_owner','unsafe'].includes(mode)),/task_reconciliation_required|cancelled/);assert.deepEqual(await q.workTabs.entries(),before);assert.equal(q.calls.filter(c=>c.name==='claim').length,0);
 }
 // Unknown old navigation must never be retired to clear a path.
 for(const bad of ['opening','claiming','unknown']){const before=await f.workTabs.entries();before.search={...before.search,state:bad,session:'old-browser'};await f.storage.set('work_tabs:fixture-owner',before);await assert.rejects(()=>f.r.retireSupplementPage(async()=>true),/task_reconciliation_required/);assert.equal((await f.workTabs.entries()).search.state,bad);}
 console.log('PASS real removed() missing previous generation; body submit ACK3 automatic stop; eight missing/unsafe denials; reproduced stale search entry_state; actual Agent.step control/claim/search admission + exact runtime.open + real WorkTabs navigation/bind/ownership; retired metadata only, no old-tab access, three unknown-state refusals');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
