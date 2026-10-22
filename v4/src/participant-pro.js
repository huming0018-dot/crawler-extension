/* Native participant transport. Pro owns acquisition; auth never leaves this worker. */
(function(root){
 'use strict';
 const SCHEMA='crowd-participant-native-v1',LIMIT=262144;
 const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
 const BASE=['schema','type','id','session','epoch'];
 const EXTRA={rpc_request:['method','params'],pro_state:['run_id','state','phase','received','target','pending','error']};
 const PARAMS={scope:[],verify_platform_principal:['uid'],pro_claim:['p_task','p_installation_id'],pro_guard:['p_task','p_lease','p_action','p_note','p_installation_id'],pro_submit:['p_task','p_lease','p_request','p_installation_id','p_payload'],pro_status:['p_task','p_installation_id'],pro_receipt:['p_task','p_installation_id','p_request'],pro_finish:['p_task','p_lease','p_installation_id'],pro_comment_submit:['p_task','p_lease','p_request','p_parent_request','p_payload','p_installation_id'],pro_comment_commit:['p_task','p_lease','p_request','p_parent_request','p_payload','p_installation_id'],pro_comment_receipt:['p_task','p_installation_id','p_request']};
 const STATES=new Set(['ready','not_ready','running','complete','partial','finish_unknown','source_failed','source_unknown','delivery_unknown','source_launch_unknown','stopped','blocked','unknown','native_ready','launching']);
 const PHASES=new Set(['initial','local_status','scope','delivery','import','stage','finish','source','stopping']);
 const HELD=new Set(['running','launching','native_ready','finish_unknown','source_unknown','delivery_unknown','source_launch_unknown','unknown']);
 const ERRORS=new Set(['participant_scope_changed','participant_writer_busy','participant_stopped','participant_rpc_outcome_unknown','participant_protocol_invalid','participant_contract_refused','participant_installation_invalid','participant_existing_run','pro_not_ready','participant_dependencies_missing','participant_native_unavailable','participant_waiting_task','participant_capability_required','participant_recovery_required','consent_required','approval_required','backend_login_required','login_required','backend_permission_denied','daily_quota','test_completed']);
 const keys=(v,w)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...w].sort().join(',');
 const integer=v=>Number.isSafeInteger(v)&&v>=0;
 const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
 const requireValue=(ok,code='participant_protocol_invalid')=>{if(!ok)throw Error(code);};
 function capability(v){
  requireValue(keys(v,['schema','runtime_sha256','entry_sha256','worker_sha256','upstream_commit','comment_options_v1','max_api_requests'])&&v.schema==='crowd-participant-pro-capability-v1'&&v.comment_options_v1===true&&['runtime_sha256','entry_sha256','worker_sha256'].every(k=>typeof v[k]==='string'&&/^[a-f0-9]{64}$/.test(v[k]))&&typeof v.upstream_commit==='string'&&/^[a-f0-9]{40}$/.test(v.upstream_commit)&&Number.isSafeInteger(v.max_api_requests)&&v.max_api_requests>=1&&v.max_api_requests<=100);
  return {...v};
 }
 function validate(v){
  requireValue(v&&v.schema===SCHEMA&&UUID.test(v.id)&&UUID.test(v.session)&&integer(v.epoch)&&EXTRA[v.type]&&keys(v,[...BASE,...EXTRA[v.type],...(v.type==='pro_state'&&Object.hasOwn(v,'capabilities')?['capabilities']:[])])&&bytes(v)<=LIMIT);
  if(v.type==='rpc_request')requireValue(Object.hasOwn(PARAMS,v.method)&&keys(v.params,PARAMS[v.method]));
  else requireValue((v.run_id===null||UUID.test(v.run_id))&&STATES.has(v.state)&&PHASES.has(v.phase)&&(v.received===null||integer(v.received))&&(v.target===null||integer(v.target))&&integer(v.pending)&&(v.error===null||ERRORS.has(v.error)));
  if(v.type==='pro_state'&&Object.hasOwn(v,'capabilities'))capability(v.capabilities);
  return v;
 }
 class ParticipantPro {
  static capability(value){return capability(value);}
  constructor(r){this.r=r;this.port=null;this.binding=null;this.seen=new Set();this.inflight=0;this.tail=Promise.resolve();this.rpcTail=Promise.resolve();this.starting=null;this.revision=0;}
  key(owner){return 'participant-pro:'+owner;}
  async read(owner){owner ||= await this.r.owner();return owner?await this.r.storage.get(this.key(owner))||null:null;}
  async save(owner,update,revision=this.revision){
   const job=this.tail.catch(()=>{}).then(async()=>{if(revision!==this.revision||owner!==await this.r.owner())return false;const old=await this.read(owner);await this.r.storage.set(this.key(owner),{...old,...update});return true;});
   this.tail=job;return job;
  }
  frame(type,extra={}){const b=this.binding;requireValue(b);return {schema:SCHEMA,type,id:this.r.uuid(),session:b.session,epoch:b.epoch,...extra};}
  post(v){requireValue(bytes(v)<=LIMIT);requireValue(this.port,'participant_rpc_outcome_unknown');this.port.postMessage(v);}
  closeClean(){const port=this.port;this.port=null;if(port)port.disconnect();}
  async busy(){const p=await this.read();return !!this.starting||this.inflight>0||!!p&&(p.pending>0||HELD.has(p.state));}
  async check(b=this.binding,lock=null){
   requireValue(b&&b===this.binding&&this.port,'participant_scope_changed');
   const scope=await this.r.scope(lock);
   requireValue(b===this.binding&&scope.subject===b.subject&&scope.installation_id===b.installation_id&&scope.generation===b.epoch,'participant_scope_changed');
   return scope;
  }
  async connect(saved){
   requireValue(!this.port,'participant_writer_busy');this.binding={...saved};this.seen.clear();
   const port=this.r.connect();this.port=port;
   const ready=new Promise((resolve,reject)=>{this.ready={resolve,reject};});
   let messages=Promise.resolve();
   port.onMessage.addListener(v=>{const revision=this.revision;const operation=messages.then(()=>this.message(v,port,revision));messages=operation.catch(error=>this.fail(ERRORS.has(error?.message)?error.message:'participant_protocol_invalid',port));});
   port.onDisconnect.addListener(()=>{void this.fail('participant_rpc_outcome_unknown',port);});
   this.post(this.frame('pro_hello',{version:1,...(this.r.capabilityRequest?{capability_request:'pro_comment_options_v1'}:{})}));
   let timer;try{return await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('participant_native_unavailable')),10000);})]);}
   finally{clearTimeout(timer);this.ready=null;}
  }
  async fail(error,port=this.port){
   if(!port||this.port!==port)return;
   const b=this.binding;this.port=null;this.ready?.reject(Error(error));try{port.disconnect();}catch(_){}
   if(!b)return;const p=await this.read(b.subject);
   if(p?.session===b.session&&p.desired_running)await this.save(b.subject,{state:p.intent?'unknown':'not_ready',error,pending:p.pending||0});
  }
  async message(raw,port,revision=this.revision){
   if(port!==this.port||revision!==this.revision)return;const v=validate(raw),b=this.binding;
   requireValue(v.session===b.session&&v.epoch===b.epoch&&!this.seen.has(v.id)&&this.seen.size<4096);
   this.seen.add(v.id);
   if(v.type==='rpc_request'){
    this.inflight++;
    const operation=this.rpcTail.catch(()=>{}).then(()=>this.reverse(v,b));this.rpcTail=operation;
    try{await operation;}finally{this.inflight--;}
    return;
   }
   const capabilityState=v.capabilities?await this.read(b.subject):null;
   if(v.capabilities&&this.r.releaseDigest&&capabilityState?.desired_running===true){
    const digest=await this.r.releaseDigest(),identity=await this.r.identity();
    requireValue(port===this.port&&revision===this.revision&&this.binding===b&&identity.subject===b.subject&&identity.installation_id===b.installation_id&&(!this.r.generation||this.r.generation()===b.epoch)&&/^[a-f0-9]{64}$/.test(digest),'participant_scope_changed');
    if(!await this.save(b.subject,{capabilities:capability(v.capabilities),capability_at:Date.now(),capability_release_digest:digest},revision))return;
   }else if(v.state==='ready')await this.save(b.subject,{capabilities:null,capability_at:null,capability_release_digest:null},revision);
   if(v.state==='ready'&&this.ready){this.ready.resolve();return;}
   if(v.state==='not_ready'&&this.ready){this.ready.reject(Error(v.error||'participant_dependencies_missing'));return;}
   const stopped=await this.read(b.subject);if(revision!==this.revision)return;
   if(v.state==='stopped'&&stopped?.session===b.session&&stopped.desired_running===false){
    const scope=await this.r.identity();requireValue(scope.subject===b.subject&&scope.installation_id===b.installation_id,'participant_scope_changed');
    if(revision!==this.revision)return;
    await this.save(b.subject,{state:v.pending?'delivery_unknown':'stopped',phase:v.phase,run_id:v.run_id,pending:v.pending,error:v.pending?'participant_rpc_outcome_unknown':'participant_stopped'},revision);
    if(!v.pending&&!this.inflight)this.closeClean();return;
   }
   await this.check(b);const p=await this.read(b.subject);if(revision!==this.revision)return;
   requireValue(p?.session===b.session&&p.intent,'participant_scope_changed');
   if(!p.desired_running)return;
   if(v.state==='complete'){
    this.inflight++;let lock,clean=false;
    try{
     lock=this.r.acquire();
     const fresh=await this.r.rpc('pro_status',{p_task:p.task_id,p_installation_id:b.installation_id});await this.check(b,lock);if(revision!==this.revision)return;
     const t=fresh?.task;
     requireValue(t?.id===p.task_id&&t.source_executor==='mediacrawler_pro'&&integer(t.received)&&integer(t.target)&&t.target>0&&t.received===t.target&&t.status==='complete','participant_receipt_invalid');
     if(!await this.save(b.subject,{state:'complete',phase:v.phase,run_id:v.run_id,desired_running:false,pending:0,received:t.received,target:t.target,error:null},revision)||revision!==this.revision)return;
     await this.r.intent(false);clean=true;await this.r.event('stop',{status:'completed',counts:{received:t.received,queued:0}});
    }finally{this.r.release(lock);this.inflight--;if(clean&&!this.inflight)this.closeClean();}
   }else{
    if(!await this.save(b.subject,{state:v.state,phase:v.phase,run_id:v.run_id,received:v.received,target:v.target,pending:v.pending,error:v.error},revision)||revision!==this.revision)return;
    await this.r.event(v.phase==='delivery'?'outbox':'session',{status:v.state==='running'?'started':'waiting',error_code:v.error||null,counts:{queued:v.pending,...(v.received===null?{}:{received:v.received})}});
   }
  }
  async reverse(v,b){
   let result=null,error=null,called=false,lock;const revision=this.revision;
   try{
    lock=this.r.acquire();
    const scope=await this.check(b,lock),p=await this.read(b.subject),params=v.params;
    await this.check(b,lock);requireValue(revision===this.revision,'participant_stopped');
    requireValue(p?.desired_running===true&&p.intent&&p.session===b.session,'participant_stopped');
    requireValue(!this.r.busy(lock),'participant_writer_busy');
    if(v.method==='scope')result=scope;
    else if(v.method==='verify_platform_principal'){
     requireValue(/^[a-f0-9]{24}$/.test(params.uid),'participant_protocol_invalid');
     result=await this.r.principal(params.uid,scope);await this.check(b,lock);
     await this.save(b.subject,{principal_verified_at:result?.matched===true?Date.now():null},revision);
    }else{
     requireValue(params.p_task===p.task_id&&params.p_installation_id===b.installation_id,'participant_scope_changed');
     if('p_lease' in params)requireValue(UUID.test(params.p_lease));
     if('p_request' in params)requireValue(UUID.test(params.p_request));
     if(v.method==='pro_guard')requireValue(['control','search','detail','comment','captcha','rate_limit'].includes(params.p_action)&&(params.p_note===null||/^[a-f0-9]{24}$/.test(params.p_note)));
     if(v.method==='pro_submit')requireValue(params.p_payload?.schema==='crowd-participant-pro-v1'&&params.p_payload?.reward_eligible===false&&bytes(params.p_payload)<=180000);
     if(v.method==='pro_comment_submit'||v.method==='pro_comment_commit')requireValue(UUID.test(params.p_parent_request)&&params.p_payload?.schema===(v.method==='pro_comment_submit'?'crowd-participant-pro-comment-v1':'crowd-participant-pro-comment-capture-v1')&&params.p_payload?.source_kind==='mediacrawler_pro'&&params.p_payload?.reward_eligible===false&&bytes(params.p_payload)<=131072);
     await this.check(b,lock);called=true;
     result=await this.r.rpc(v.method,params);
     await this.check(b,lock);
     if(v.method==='pro_submit'&&result?.gate==='received')await this.r.event('receipt',{status:'completed',counts:{received:result.task_received}});
    }
    await this.check(b,lock);requireValue(revision===this.revision,'participant_stopped');
   }catch(e){error=called?'participant_rpc_outcome_unknown':['participant_scope_changed','participant_writer_busy','participant_stopped','participant_protocol_invalid'].includes(e.message)?e.message:'participant_rpc_outcome_unknown';result=null;}finally{this.r.release(lock);}
   if(this.port&&this.binding===b)this.post(this.frame('rpc_result',{id:v.id,ok:error===null,result,error}));
  }
  async start(){
   if(this.starting)return this.starting;
   const job=this.activate();this.starting=job;
   try{return await job;}finally{if(this.starting===job)this.starting=null;}
  }
  async requestStart(){
   const revision=this.revision;await this.r.intent(true);
   setTimeout(()=>{if(revision===this.revision)void this.start().catch(()=>{});},0);
  }
  async activate(){
   const revision=this.revision,scope=await this.r.scope();requireValue(!this.r.busy(),'participant_writer_busy');
   const old=await this.read(scope.subject);
   requireValue(!old||!HELD.has(old.state)&&!old.pending,'participant_recovery_required');
   await this.r.intent(true);requireValue(revision===this.revision,'participant_stopped');
   const session=this.r.uuid();await this.save(scope.subject,{...scope,session,state:'not_ready',desired_running:true,intent:null,run_id:null,pending:0,error:null,startup_phase:'connect'},revision);
   if(this.port){const port=this.port;this.port=null;port.disconnect();}
   let startupPhase='connect';
   try{await this.connect({...scope,epoch:scope.generation,session});startupPhase='check';await this.check();
    requireValue(revision===this.revision,'participant_stopped');
    startupPhase='claim';const claim=await this.r.claim();startupPhase='check';await this.check();
    startupPhase='claim';
    requireValue(revision===this.revision,'participant_stopped');
    if(claim?.error)throw Error(ERRORS.has(claim.error)?claim.error:'participant_contract_refused');
    if(!claim?.task){await this.save(scope.subject,{state:'stopped',error:'participant_waiting_task',startup_phase:'idle'},revision);this.closeClean();return;}
    const task=claim.task;requireValue(Number.isSafeInteger(task.id)&&task.id>0,'participant_protocol_invalid');
    const intent=this.r.uuid();await this.save(scope.subject,{state:'native_ready',startup_phase:'idle',task_id:task.id,query:task.query,intent,target:task.target,received:task.received,error:null},revision);
    // UI mutation releases its command lock before the native child can request RPC.
    setTimeout(()=>{void this.launch(scope.subject,revision);},0);
   }catch(error){
    await this.save(scope.subject,{state:'not_ready',startup_phase:startupPhase,error:ERRORS.has(error.message)?error.message:startupPhase==='claim'?'participant_rpc_outcome_unknown':'participant_native_unavailable'},revision);
    // No pro_start has been sent on activate's failure path.
    if(this.binding?.session===session)this.closeClean();throw error;
   }
  }
  async launch(owner,revision){
   try{if(revision!==this.revision)return;const b=this.binding,p=await this.read(owner);await this.check(b);
    if(revision!==this.revision||b!==this.binding||!this.port||!p?.desired_running||!p.intent||p.state!=='native_ready')return;
    this.post(this.frame('pro_start',{subject:owner,installation_id:p.installation_id,task_id:p.task_id,intent:p.intent}));
    await this.save(owner,{state:'launching'},revision);
   }catch(_){await this.save(owner,{state:'unknown',error:'participant_rpc_outcome_unknown'},revision);}
  }
  async stop(){
   this.revision++;await this.r.intent(false);
   const owner=await this.r.owner(),p=await this.read(owner);
   if(!p)return;await this.save(owner,{capabilities:null,capability_at:null,capability_release_digest:null,desired_running:false,state:HELD.has(p.state)?'source_unknown':'stopped',error:'participant_stopped'});
   // Revocation can stop its own old epoch after Agent invalidation; never authorize RPC.
   if(this.port&&this.binding?.subject===owner){this.post(this.frame('pro_stop',{run_id:p.run_id||null}));return;}
   if(!HELD.has(p.state)||!UUID.test(p.run_id||'')||!UUID.test(p.session||'')||!integer(p.generation))return;
   const revision=this.revision,saved={subject:owner,installation_id:p.installation_id,session:p.session,epoch:p.generation};
   let stopPort=null,stopBinding=null;
   try{
    const identity=await this.r.identity();
    requireValue(identity.subject===owner&&identity.installation_id===p.installation_id&&revision===this.revision,'participant_scope_changed');
    requireValue(!this.port,'participant_writer_busy');
    const connected=this.connect(saved);stopPort=this.port;stopBinding=this.binding;await connected;
    const fresh=await this.read(owner),now=await this.r.identity();
    requireValue(now.subject===owner&&now.installation_id===saved.installation_id&&revision===this.revision&&fresh?.session===p.session&&fresh.run_id===p.run_id&&fresh.desired_running===false&&this.port===stopPort&&this.binding===stopBinding&&this.binding?.session===saved.session&&this.binding?.epoch===saved.epoch,'participant_scope_changed');
    this.post(this.frame('pro_stop',{run_id:p.run_id}));
   }catch(error){
    if(stopPort&&this.port===stopPort&&this.binding===stopBinding)this.closeClean();await this.save(owner,{error:ERRORS.has(error.message)?error.message:'participant_rpc_outcome_unknown'},revision);
   }
  }
  async poll(){
   const p=await this.read();if(!p)return;
   if(this.port){if(p.intent&&UUID.test(p.run_id||''))this.post(this.frame('pro_status',{run_id:p.run_id}));return;}
   if(HELD.has(p.state)||p.pending)return; // Unknown launch is durable; never replay Start.
   // One recovery for the source-free pre-phase error retained across an OTA release.
   const stale=v=>v?.desired_running===true&&v.state==='not_ready'&&v.pending===0&&v.intent===null&&v.run_id===null&&v.startup_phase==null&&v.error==='participant_native_unavailable'&&UUID.test(v.subject||'')&&UUID.test(v.installation_id||'')&&/^[a-f0-9]{64}$/.test(v.capability_release_digest||'');
   if(stale(p)&&this.r.releaseDigest&&!this.starting&&!this.otaRecovering&&!this.r.busy()){
    this.otaRecovering=true;const revision=this.revision;
    try{
     capability(p.capabilities);const digest=await this.r.releaseDigest(),owner=await this.r.owner(),fresh=await this.read(owner),node=await this.r.storage.get('node-monitor:'+owner);
     if(revision!==this.revision||this.starting||this.r.busy()||!stale(fresh)||fresh.subject!==owner||fresh.subject!==p.subject||fresh.installation_id!==p.installation_id||!UUID.test(node?.installation_id||'')||node.installation_id!==fresh.installation_id||fresh.capability_release_digest!==p.capability_release_digest||!/^[a-f0-9]{64}$/.test(digest)||digest===fresh.capability_release_digest||fresh.startup_recovery_release_digest===digest)return;
     if(!await this.save(owner,{startup_recovery_release_digest:digest},revision)||revision!==this.revision||this.r.busy())return;
     return await this.start();
    }finally{this.otaRecovering=false;}
   }
   if(p.desired_running&&p.error==='participant_waiting_task'&&!this.starting&&!this.r.busy())return this.start();
  }
 }
 ParticipantPro.validate=validate;ParticipantPro.bytes=bytes;ParticipantPro.LIMIT=LIMIT;
 root.CrowdParticipantPro=ParticipantPro;
})(globalThis);

/* Explicit local login help only. Pro self/principal validation still owns authorization. */
(function(root){
 'use strict';
 const HOME='https://www.xiaohongshu.com/';
 const need=(ok,code='participant_stopped')=>{if(!ok)throw Error(code);};
 const platform=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['www.xiaohongshu.com','m.xiaohongshu.com'].includes(u.hostname);}catch(_){return false;}};
 const home=value=>{try{const u=new URL(value);return platform(value)&&!u.search&&!u.hash&&['/','/explore'].includes(u.pathname);}catch(_){return false;}};
 class ProManualLogin {
  constructor(r){this.r=r;this.active=null;}
  async open(){
   need(!this.active,'participant_writer_busy');const job=this.run();this.active=job;
   try{return await job;}catch(error){const code=error?.message;throw Error(['participant_stopped','participant_writer_busy','participant_scope_changed','identity_verification_required','participant_login_page_pending','participant_login_creation_unknown','participant_login_browser_required','participant_login_page_changed'].includes(code)?code:'participant_login_help_unknown');}finally{if(this.active===job)this.active=null;}
  }
  async run(){
   const r=this.r,s=await r.scope(),key='pro-manual-login:'+s.subject;
   const check=async()=>{const n=await r.scope();need(Object.keys(s).every(k=>n[k]===s[k]));};
   need(/^[a-f0-9]{64}$/.test(s.expected_ref||''),'identity_verification_required');
   let old=await r.storage.get(key);await check();
   if(old)need(old.schema==='crowd-pro-manual-login-v1'&&old.installation_id===s.installation_id&&typeof old.intent==='string'&&Number.isSafeInteger(old.generation)&&['creating','opened'].includes(old.stage)&&(old.stage==='creating'?old.tab_id===null:Number.isSafeInteger(old.tab_id)),'participant_scope_changed');
   const tabs=await r.chrome.tabs.query({});await check();
   const candidates=tabs.filter(t=>!t.incognito&&(platform(t.url)||platform(t.pendingUrl)));
   need(!candidates.some(t=>t.pendingUrl),'participant_login_page_pending');
   const windows=await r.chrome.windows.getAll({populate:false});await check();
   const normal=new Map(windows.filter(w=>w.type==='normal'&&w.incognito===false).map(w=>[w.id,w]));
   const eligible=candidates.filter(t=>normal.has(t.windowId));
   eligible.sort((a,b)=>(b.id===old?.tab_id)-(a.id===old?.tab_id)||Number(home(b.url))-Number(home(a.url))||(b.lastAccessed||0)-(a.lastAccessed||0)||a.id-b.id);
   let tab=eligible[0],created=false;
   if(!tab){
    // An unresolved creation belongs to this helper; never issue it again.
    need(!old||old.stage!=='creating','participant_login_creation_unknown');
    const window=[...normal.values()].sort((a,b)=>Number(b.focused)-Number(a.focused)||a.id-b.id)[0];
    need(window,'participant_login_browser_required');
    const intent={schema:'crowd-pro-manual-login-v1',intent:r.uuid(),installation_id:s.installation_id,generation:s.generation,stage:'creating',tab_id:null};
    await r.storage.set(key,intent);await check();
    // This is a manual tab, unrelated to old WorkTabs/verification metadata.
    try{tab=await r.chrome.tabs.create({windowId:window.id,url:HOME,active:true});}
    catch(_){throw Error('participant_login_creation_unknown');}
    created=true;await check();need(Number.isSafeInteger(tab?.id)&&tab.windowId===window.id&&!tab.incognito&&platform(tab.pendingUrl||tab.url),'participant_login_creation_unknown');
    old={...intent,stage:'opened',tab_id:tab.id};await r.storage.set(key,old);await check();
   }
   if(!created&&(!old||old.stage!=='creating')){await r.storage.set(key,{schema:'crowd-pro-manual-login-v1',intent:old?.intent||r.uuid(),installation_id:s.installation_id,generation:s.generation,stage:'opened',tab_id:tab.id});await check();}
   // Re-read the selected tab/window before each explicit presentation action.
   const fresh=await r.chrome.tabs.get(tab.id);await check();
   need(fresh.windowId===tab.windowId&&!fresh.incognito&&(!fresh.pendingUrl||created&&fresh.pendingUrl===HOME)&&platform(fresh.pendingUrl||fresh.url),'participant_login_page_changed');
   const window=await r.chrome.windows.get(fresh.windowId);await check();
   need(window.type==='normal'&&window.incognito===false,'participant_login_page_changed');
   await r.chrome.tabs.update(fresh.id,{active:true});await check();
   await r.chrome.windows.update(window.id,{state:'normal',focused:true});await check();
   return {opened:true,reused:!created,login_verified:false};
  }
 }
 root.CrowdProManualLogin=ProManualLogin;
})(globalThis);
