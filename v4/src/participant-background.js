/* Windows/macOS Chrome & Edge MV3. No automatic start on installation. */
if (typeof importScripts === 'function') importScripts('config.js', 'core.js', 'identity.js', 'api.js', 'agent.js', 'pool.js', 'work-tabs.js', 'join.js', 'updater.js', 'participant-policy.js', 'trace.js', 'node-monitor.js', 'session-health.js', 'participant-session.js', 'participant-pro.js');
const storage = CrowdCore.accountStorage({
  async get(key) { return (await chrome.storage.local.get(key))[key]; },
  async set(key, value) { await chrome.storage.local.set({[key]: value}); }
});
if (chrome.storage.local.setAccessLevel) chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}).catch(console.error);
async function probeTab(id, action, payload=null) {
  let timer;
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(id, {type: 'crowd_probe', action,...(payload||{})}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probe_timeout')), ['sdk_plan','sdk_action'].includes(action)?12000:2000); })
    ]);
    return {response, status: response ? 'ok' : 'no_receiver', error: response ? 'none' : 'empty_response'};
  } catch (e) {
    // Only fixed categories leave this helper; browser errors may contain URLs.
    const message = String(e?.message || '');
    const error = message === 'probe_timeout' ? 'timed_out' :
      /Receiving end does not exist/i.test(message) ? 'no_receiver' :
      /message (?:port|channel) closed/i.test(message) ? 'port_closed' :
      /No tab with id|Invalid tab ID/i.test(message) ? 'tab_missing' :
      /Cannot access|Missing host permission/i.test(message) ? 'access_denied' : 'message_failed';
    return {response: null, status: error === 'timed_out' ? 'timed_out' : 'no_receiver', error};
  }
  finally { clearTimeout(timer); }
}
// Only fixed categories leave this helper. Never retain or report a frame URL.
async function navigationDocument(id, tab) {
  const kind = value => {
    if (!value) return 'unavailable';
    if (value === 'about:blank') return 'blank';
    try { const u = new URL(value); return u.protocol === 'https:' && ['www.xiaohongshu.com','m.xiaohongshu.com'].includes(u.hostname) ? 'platform' : 'other'; }
    catch (_) { return 'other'; }
  };
  let current = tab?.url, timer;
  if (!current && chrome.webNavigation?.getFrame) {
    try {
      const frame = await Promise.race([chrome.webNavigation.getFrame({tabId:id, frameId:0}),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 500); })]);
      current = frame?.url;
    } catch (_) {} finally { clearTimeout(timer); }
  }
  return {document_kind:kind(current), pending_kind:tab?.pendingUrl ? kind(tab.pendingUrl) : 'none'};
}
let pendingTabCreation = null, fastTickTimer = null, fastTickAt = null, fastUploadTimer = null, fastUploadAt = null;
const runtime = {
  localTest:false,
  recoveryPages:true,
  siteSDK:true,
  sdkAllowed:async s=>s?.task?.capabilities?.site_sdk_v1===true,
  leaseScope:async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join(''),
  fastDelivery:true,
  batchObservations:true,
  poolAllowed:async()=>false,
  closeSlot:slot=>workTabs.close(slot),
  async close(expectedOwner=null){await workTabs.close(undefined,expectedOwner);if(!expectedOwner)await this.closeLegacy();},
  fastCapture:true,
  owner:async()=>(await storage.get('session'))?.user?.id,
  splitCapture: true,
  sourceHealth:()=>participantSession.require(),
  retireLoginPage:valid=>workTabs.retireLoginPage(valid),
  async retireSupplementPage(valid){
    const old=(await workTabs.entries()).search;if(!old||old.state==='retired')return;
    const marker=(await chrome.storage.session.get('crowd_work_session')).crowd_work_session;
    if(!['opened','missing'].includes(old.state)||(old.state==='missing'&&old.session===marker)||typeof old.session!=='string'||!old.session||typeof marker!=='string'||!marker)throw Error('task_reconciliation_required');
    if(old.session!==marker)await workTabs.retireLoginPage(valid);
  },
  async retireMissingVerification(slot,expected,valid){
    const owner=await runtime.owner(),s=await agent.read(),m=s.verification_page,entries=await workTabs.entries(),entry=entries[slot],marker=(await chrome.storage.session.get('crowd_work_session')).crowd_work_session;
    const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    if(typeof slot!=='string'||!slot.startsWith('verify-')||!uuid(slot.slice(7))||!/^[a-f0-9]{64}$/.test(expected||'')||!await valid()||owner!==agent.generationOwner||s.owner_id!==owner||!m||m.slot!==slot||m.manual!==true||!['opened','confirmed'].includes(m.stage)||m.expected_ref!==expected||(await platformHealth.read()).xiaohongshu?.expected_ref!==expected||!entry||entry.state!=='missing'||entry.verification!==true||entry.url!==CrowdCore.HOST+'/'||!Number.isSafeInteger(entry.tab)||entry.tab<1||!uuid(entry.token)||!uuid(entry.document)||typeof entry.session!=='string'||!entry.session||typeof marker!=='string'||!marker)throw Error('verification_page_unknown');
    if(entry.session===marker){let absent=false;try{await chrome.tabs.get(entry.tab);}catch(error){absent=typeof error?.message==='string'&&new RegExp('^No tab with id: '+entry.tab+'\\.?$').test(error.message);}if(!absent)throw Error('verification_page_unknown');}
    if(!await valid()||owner!==await runtime.owner()||(await platformHealth.read()).xiaohongshu?.expected_ref!==expected)throw Error('cancelled');
    await workTabs.write(all=>{const current=all[slot];if(!current||['tab','session','token','document','url','state','instance','verification'].some(k=>current[k]!==entry[k]))throw Error('cancelled');all[slot]={...current,state:'retired',retired_reason:'known_missing_verification'};},'work_tabs:'+owner);
    if(!await valid()||owner!==await runtime.owner()||(await platformHealth.read()).xiaohongshu?.expected_ref!==expected)throw Error('cancelled');
    return true;
  },
  expectedPrincipal:async()=>(await platformHealth.read()).xiaohongshu?.expected_ref,
  verificationCurrent:slot=>workTabs.verificationCurrent(slot),
  async verifyPage(slot){const owner=await runtime.owner(),expected=(await platformHealth.read()).xiaohongshu?.expected_ref;const page=await workTabs.verificationProbe(slot,async value=>{const p=await normalizeSessionPage(value,owner);return p.status==='authenticated'&&p.principal_ref===expected;});return normalizeSessionPage(page,owner);},
  async openVerification(url,slot,manual,valid,focus=manual){if(!await valid())throw Error('cancelled');await workTabs.open(url,slot,{verificationHome:manual});if(!await valid())throw Error('cancelled');if(manual&&focus===true)await workTabs.focusVerification(slot);},
  adoptVerification:(slot,valid)=>workTabs.adoptVerification(slot,valid),
  focusVerification:slot=>workTabs.focusVerification(slot),
  trace:(stage,options)=>trace.event(stage,options),
  storage, now: Date.now, random: Math.random, uuid: () => crypto.randomUUID(),
  // Align the next wake with the durable deadline, not an unrelated 30s grid.
  // Keep a repeating fallback for worker crashes; poll waits at least once/minute
  // so sleep detection and independent control refresh keep their semantics.
  async schedule(when, replace = false) {
    const now = Date.now(), deadline=Number.isFinite(when)?when:now+30000;
    // Short active waits use a timer; durable alarms still recover worker suspension.
    if(replace && fastTickTimer){clearTimeout(fastTickTimer);fastTickTimer=null;fastTickAt=null;}
    const delay=Math.max(250,deadline-now);
    if(delay<=25000 && (fastTickAt==null || now+delay<fastTickAt)) {
      clearTimeout(fastTickTimer);fastTickAt=now+delay;
      fastTickTimer=setTimeout(()=>{fastTickTimer=null;fastTickAt=null;agent.tick().then(()=>localTests.run()).catch(console.error);},delay);
    }
    const at = Math.max(now + 30000, Math.min(Number.isFinite(when) ? when : now + 30000, now + 60000));
    const alarm = await chrome.alarms.get('crowd_tick');
    // Early page events must not postpone an already scheduled deadline.
    if (replace || alarm?.periodInMinutes !== .5 || !Number.isFinite(alarm.scheduledTime) || alarm.scheduledTime < now || alarm.scheduledTime > at + 1000)
      await chrome.alarms.create('crowd_tick', {when: at, periodInMinutes: .5});
  },
  cancel: () => {clearTimeout(fastTickTimer);fastTickTimer=null;fastTickAt=null;return chrome.alarms.clear('crowd_tick');},
  async scheduleDelivery(when) {
    const now=Date.now(),delay=Math.max(250,(Number.isFinite(when)?when:now+1000)-now);
    if(delay<=25000 && (fastUploadAt==null || now+delay<fastUploadAt)) {
      clearTimeout(fastUploadTimer);fastUploadAt=now+delay;
      fastUploadTimer=setTimeout(()=>{fastUploadTimer=null;fastUploadAt=null;agent.tick(false,true).then(()=>localTests.run()).catch(console.error);},delay);
    }
    if (!await chrome.alarms.get('crowd_upload')) await chrome.alarms.create('crowd_upload', {periodInMinutes: 1});
  },
  cancelDelivery: () => {clearTimeout(fastUploadTimer);fastUploadTimer=null;fastUploadAt=null;return chrome.alarms.clear('crowd_upload');},
  async open(url, unused = false, slot = null) {
    if(slot)return workTabs.open(url,slot);
    CrowdCore.navigationURL(url);await trace.event('open_requested');await clearNavigation(true);
    pendingTabCreation=(async()=>{
      await workTabs.open(url,'search');
      const entry=(await workTabs.entries()).search;
      await storage.set('work_tab',entry.tab);await trace.event('tab_created');
    })();
    try {await pendingTabCreation;}catch(error){await trace.event('update_failed');throw error;}finally{pendingTabCreation=null;}
  },
  async historicalNote(note,valid){
    const owner=await this.owner(),key='work_tabs:'+owner,markerKey='crowd_work_session';
    if(!owner)throw Error('cancelled');
    const before=await storage.get(key)||{},entry=before.search,marker=(await chrome.storage.session.get(markerKey))[markerKey];
    if(typeof marker!=='string'||!marker||!workTabs.historicalOpened(entry,marker))return false;
    try{if(CrowdCore.noteURL(entry.url).id!==note)return false;}catch(_){return false;}
    await valid();if(owner!==await this.owner())throw Error('cancelled');
    const current=(await storage.get(key)||{}).search,after=(await chrome.storage.session.get(markerKey))[markerKey];
    if(after!==marker||!current||['state','session','tab','document','token','url','instance'].some(k=>current[k]!==entry[k]))throw Error('cancelled');
    return true;
  },
  async probe(action,slot = null,sdk=null) {
    const page=await workTabs.read(action,slot||'search',sdk);
    await trace.event(page.ready?'probe_ready':'probe_missing');return page;
  },
  async closeLegacy() {
    // A pre-upgrade bare tab ID is not proof that the current page belongs to us.
    await workTabs.close('search');await storage.set('work_tab',null);
  }

};
const workTabs=new CrowdWorkTabs({chrome,storage,observe:(stage,owner)=>localTrace(stage,{start:true,owner}),owner:async()=>(await storage.get('session'))?.user?.id,probe:probeTab,uuid:()=>crypto.randomUUID(),structuredAllowed:async()=>{const s=await agent.read();return s.enabled===true&&s.task?.structured_capture===true;},presentationAllowed:async()=>{const state=await agent.read();return !agent.pendingStop&&!agent.stopping&&!agent.stopActive&&!agent.maintenance&&state.enabled===true;}});
async function workingTab(){if((await storage.get('session'))?.user?.id){const state=await agent.read(),owned=await workTabs.first((state.work_slots||[]).map(slot=>slot.id));return owned || null;}return null;}
const api = new CrowdAPI(CROWD_CONFIG, storage), agent = new CrowdAgent(runtime, api);
// Legacy 3.x has the same extension ID but a different identity/outbox protocol.
// Detect once per worker, preserve every legacy key, and never enroll over it.
const legacyInstallation = CrowdIdentity.legacy(storage);
async function participantEntry(){
  if(await storage.get('session'))return 'ready';
  const keys=chrome.storage.local.getKeys?await chrome.storage.local.getKeys():Object.keys(await chrome.storage.local.get(null));
  return CrowdIdentity.entry(storage,keys);
}
async function requireParticipant(){
  const entry=await participantEntry();
  if(entry!=='ready')throw Error(entry==='identity_recovery_required'?entry:'invite_required');
}
const tickAgent=agent.tick.bind(agent),startAgent=agent.start.bind(agent),stopAgent=agent.stop.bind(agent);
const platformHealth=new CrowdPlatformHealth({storage,owner:runtime.owner,now:Date.now,probe:probePlatformSessions});
const participantSession=new CrowdParticipantSession({storage,owner:runtime.owner,now:Date.now,health:platformHealth,agent,
  start:startAgent,stop:stopAgent,bootstrap:(valid,retry,stopped)=>agent.bootstrapLoginPage(valid,retry,stopped),rebind:valid=>workTabs.rebindAfterLogin(valid,async page=>{
    const owner=await runtime.owner(),expected=(await platformHealth.read()).xiaohongshu?.expected_ref;
    if(!owner||!/^[a-f0-9]{64}$/.test(expected||''))return false;
    const normalized=await normalizeSessionPage(page,owner);
    if(owner!==await runtime.owner())return false;
    const current=(await platformHealth.read()).xiaohongshu?.expected_ref;
    return normalized.status==='authenticated'&&normalized.principal_ref===expected&&current===expected&&owner===await runtime.owner();
  }),reconcile:valid=>agent.reconcileCompletedTask(valid),supplement:valid=>agent.checkAcceptanceSupplement(valid),recoverPage:(valid,options)=>agent.recoverLoginPage(valid,options),verificationCurrent:slot=>workTabs.verificationCurrent(slot),verificationNeeded:()=>workTabs.recoveryNeeded(),indicate:indicatePlatformSession});
// Direct controller stops cancel persisted intent before any pending recovery can start.
agent.stop=async(reason='user_stopped',options={})=>{await proParticipant.stop();return stopAgent(reason,options);};
agent.tick=async(...args)=>{
  if(await legacyInstallation)return;
  // Pro is the sole source. Preserve original manual-rating/outbox delivery only.
  await proParticipant.poll();
  if(!await proParticipant.busy())return tickAgent(args[0],true);
};
async function normalizeSessionPage(page,owner){
  if(page?.platform!=='xiaohongshu')return {status:'unknown'};
  if(page.status==='authenticated'&&page.verification==='rendered_account_navigation'&&/^[a-f0-9]{24}$/.test(page.principal_id||''))return {status:'authenticated',principal_ref:await runtime.leaseScope(owner+'\n'+'xiaohongshu'+'\n'+page.principal_id)};
  return ['logged_out','challenge','unknown'].includes(page.status)?{status:page.status,reason:page.reason}:{status:'unknown'};
}
async function probePlatformSessions(){
  const owner=await runtime.owner();if(!owner)return {};
  const work=await storage.get('work_tab'),s=await agent.read(),m=s.verification_page;
  const owned=m&&(['opened'].includes(m.stage)||m.manual&&m.stage==='confirmed');
  let primary=null;if(owned){try{primary=await runtime.verifyPage(m.slot);}catch(error){primary={status:error.message==='rate_limit'?'challenge':'unknown',reason:error.message==='rate_limit'?'rate_limit':null};}}
  const tabs=(await chrome.tabs.query({url:['https://www.xiaohongshu.com/*','https://m.xiaohongshu.com/*']})).filter(tab=>!tab.discarded).sort((a,b)=>Number(b.id===work)-Number(a.id===work)||(b.lastAccessed||0)-(a.lastAccessed||0)).slice(0,6);
  const observations=[];
  await Promise.all(tabs.map(async tab=>{let timer;try{
    const page=await Promise.race([chrome.tabs.sendMessage(tab.id,{type:'crowd_session_probe'}),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1500);})]);
    if(page)observations.push(await normalizeSessionPage(page,owner));
  }catch(_){}finally{clearTimeout(timer);}}));
  const loggedOut=observations.find(p=>p.status==='logged_out'),challenge=observations.find(p=>p.status==='challenge'),authenticated=observations.filter(p=>p.status==='authenticated');
  if(primary){
    // Other tabs can veto risk/identity conflict; they can never supply missing
    // identity proof for the one newly created, owned verification document.
    if(challenge)return {xiaohongshu:challenge};
    if(primary.status==='authenticated'&&(loggedOut||authenticated.some(p=>p.principal_ref!==primary.principal_ref)))return {xiaohongshu:{status:'unknown'}};
    return {xiaohongshu:primary};
  }
  return {xiaohongshu:(loggedOut&&authenticated.length||new Set(authenticated.map(p=>p.principal_ref)).size>1)?{status:'unknown'}:challenge||loggedOut||authenticated[0]||{status:tabs.length?'unknown':'no_page'}};
}
let indicatedPlatformSession=null;
async function indicatePlatformSession({reason,pending,recovered_at}){
  const text=reason==='login_required'?'登录':reason==='platform_identity_changed'?'换号':pending?'核验':recovered_at?'继续':'';
  const mark=JSON.stringify({owner:await runtime.owner(),reason:reason||null,pending:pending===true,recovered:!!recovered_at});
  if(mark!==indicatedPlatformSession){indicatedPlatformSession=mark;nodeMonitor.event('session',{status:reason?'waiting':'completed',error_code:reason==='test_completed'?null:reason||null}).then(queueNodeFlush);}
  await chrome.action?.setBadgeText({text});await chrome.action?.setBadgeBackgroundColor({color:reason?'#b54708':'#23704c'});
  await chrome.action?.setTitle({title:reason==='login_required'?'小红书已退出登录；原记录保留，请在原窗口重新登录':reason==='platform_identity_changed'?'当前小红书账号已改变；请切回原账号':reason==='captcha'||reason==='rate_limit'?'小红书需要本人处理验证；原记录保留':pending?'小红书登录待恢复；原账号核验后自动继续原任务':recovered_at?'原账号登录已恢复，继续上次任务':'众包公开笔记采集'});
}
async function repairPlatformHealth(){if(!await chrome.alarms.get('crowd_platform_health'))await chrome.alarms.create('crowd_platform_health',{periodInMinutes:.5});}
let platformHealthTimer=null,lastHealthEvent=0;
function queuePlatformHealth(){if(platformHealthTimer)return;platformHealthTimer=setTimeout(()=>{platformHealthTimer=null;lastHealthEvent=Date.now();legacyInstallation.then(legacy=>{if(!legacy)return participantSession.check(true);}).catch(console.error);},Math.max(300,3000-(Date.now()-lastHealthEvent)));}

const trace = new CrowdTrace({storage,settings:diagnosticSettings,uuid:()=>crypto.randomUUID()});
const baseRPC=api.rpc.bind(api);
const originalRPC=async(...args)=>{if(await legacyInstallation)throw Error('legacy_migration_required');return baseRPC(...args);};
let releaseHashPromise=null;
async function cachedReleaseHash(){
  if(!releaseHashPromise)releaseHashPromise=(async()=>{
    const response=await fetch(chrome.runtime.getURL('release.json'));
    if(response.ok===false)throw Error('release_digest_unavailable');
    const data=await response.arrayBuffer();
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(b=>b.toString(16).padStart(2,'0')).join('');
  })().catch(error=>{releaseHashPromise=null;throw error;});
  return releaseHashPromise;
}
const nodeMonitor=new CrowdNodeMonitor({storage,api:{rpc:originalRPC},settings:diagnosticSettings,
  state:async()=>{const state=await agent.read(),health=(await platformHealth.publicState()).xiaohongshu;let release_digest;
    const owner=await runtime.owner(),pro=owner&&await storage.get('participant-pro:'+owner),age=Date.now()-(pro?.principal_verified_at||0);
    try{release_digest=await cachedReleaseHash();}catch(_){console.warn('release_digest_unavailable');}
    return {release_digest,enabled:pro?pro.desired_running===true:state.enabled===true,
    login_state:pro&&age>=0&&age<=120000?'ready':CrowdNodeMonitor.loginState(state,health,Date.now())};},
  uuid:()=>crypto.randomUUID(),version:CrowdCore.VERSION});
let nodeFlushTimer=null;
function queueNodeFlush(){
  if(!nodeFlushTimer)nodeFlushTimer=setTimeout(()=>{nodeFlushTimer=null;nodeMonitor.flush().catch(()=>{});},5000);
}
const localTrace=trace.event.bind(trace);
trace.event=async(stage,options)=>{await localTrace(stage,options);nodeMonitor.event(stage,options).then(queueNodeFlush);};
const saveAgent=agent.save.bind(agent);
let observedNodeState=null;
agent.save=async (state,stopping=false)=>{
  await saveAgent(state,stopping);
  const current={phase:state.phase,enabled:state.enabled===true,error:state.last_error||null,queued:state.outbox?.length||0,received:state.received||0,comments_requested:state.task?.comments_capture===true||state.task?.structured_capture===true};
  const previous=observedNodeState;observedNodeState=current;
  const diagnostic=state.control_diagnostic,observation=state.control_diagnostic_seq;
  if(diagnostic&&Number.isSafeInteger(observation)&&observation>0){
    const detail={schema:'crowd-control-diagnostic-v1',kind:diagnostic.kind,http_status:diagnostic.http_status,elapsed_ms:diagnostic.elapsed_ms,at_ms:diagnostic.at_ms};
    if(Object.hasOwn(diagnostic,'cause'))detail.cause=diagnostic.cause;
    const completed=['ok','terminal_response'].includes(detail.kind);
    nodeMonitor.event(completed?'session':'stop',{status:completed?'completed':'waiting',error_code:completed?null:'control_unavailable',control_diagnostic:detail,control_observation_seq:observation,control_owner_id:state.owner_id}).then(queueNodeFlush);
  }
  if(previous?.phase!==current.phase)nodeMonitor.event(({search:'list',search_done:'list',note:'detail',reopen_note:'detail',enrich:'comments',idle:'session'})[current.phase]||'session',{status:current.phase==='enrich'?(current.comments_requested?'waiting':'skipped'):'started'}).then(queueNodeFlush);
  if(previous?.queued!==current.queued)nodeMonitor.event('outbox',{status:current.queued?'waiting':'completed',counts:{queued:current.queued,received:current.received}}).then(queueNodeFlush);
  if(current.error!==previous?.error && current.error)nodeMonitor.event(['login_required','backend_login_required','captcha','identity_verification_required','platform_identity_changed'].includes(current.error)?'session':'stop',
    {status:'waiting',error_code:current.error==='test_completed'?null:current.error}).then(queueNodeFlush);
  if(previous?.enabled===true && !current.enabled)nodeMonitor.event('stop',{status:'completed',error_code:current.error==='test_completed'?null:current.error,counts:{received:current.received,queued:current.queued}}).then(queueNodeFlush);
};
api.rpc=async(name,params={},...rest)=>{
  const metrics=rest[1],clock=()=>performance.now(),elapsed=start=>Math.max(0,Math.round(clock()-start)),wrapperAt=metrics?clock():0,traceBefore=metrics?clock():0;
  const admission=name==='guard' && ['search','detail','comment','scroll'].includes(params.p_action);
  const commentState=name==='guard'&&params.p_action==='comment'?await agent.read().catch(()=>null):null;
  const submit=['submit','observe','rating','comments_observe','structured_observe','batch_observe'].includes(name),options=submit?{id:params.p_request}:{};
  if(admission)await trace.event('admission_requested',{start:true});
  if(submit)await trace.event('submit_requested',options);
  if(metrics)metrics.trace_before_ms=elapsed(traceBefore);
  try {const result=name==='claim'?await nodeMonitor.claim(params.p_task||null,...rest):await originalRPC(name,params,...rest);const traceAfter=metrics?clock():0;
    if(admission)await trace.event(result.allowed?'admission_allowed':'admission_denied');
    // This is an admitted dedicated comment action, not incidental DOM or a phase transition.
    if(commentState?.task&&commentState.task.id===params.p_task&&(commentState.task.comments_capture===true||commentState.task.structured_capture===true)
      &&result.allowed===true&&result.paused===false&&result.reason===null&&!result.error&&!rest[0]?.aborted&&!agent.stopping&&!agent.maintenance&&!commentState.pending_risk){
      try{if(commentState.owner_id===await runtime.owner())nodeMonitor.event('comments',{status:'started'}).then(queueNodeFlush);}catch(_){}
    }
    if(submit)await trace.event(result.error||result.gate==='rejected'?'submit_rejected':'submit_accepted',options);
    if(metrics)metrics.trace_after_ms=elapsed(traceAfter);return result;
  }catch(e){if(submit)await trace.event('submit_failed',options);throw e;}finally{if(metrics)metrics.wrapper_ms=elapsed(wrapperAt);}
};
let pendingCommands=0;
const risk=new CrowdRisk({id:chrome.runtime.id,version:CrowdCore.VERSION,storage,owner:runtime.owner,agent,tabs:workTabs});
workTabs.riskObserved=evidence=>risk.captureMetadata(evidence);

const localTests=new CrowdLocalTest({storage,id:chrome.runtime.id,version:CrowdCore.VERSION,owner:runtime.owner,agent,riskCheck:(s,owner,valid)=>risk.preflight(s,owner,valid),isBusy:async()=>pendingCommands>0 || agent.maintenance,start:valid=>agent.start(true,{valid})});
const recovery=new CrowdRecovery({id:chrome.runtime.id,owner:runtime.owner,storage,agent,api,tabs:workTabs,prefs:()=>localTests.status(),busy:()=>pendingCommands>0||!!agent.active||!!agent.maintenance});
async function proIdentity(){
  const subject=await runtime.owner();
  if(subject&&!await storage.get('node-monitor:'+subject))await nodeMonitor.register();
  const node=subject&&await storage.get('node-monitor:'+subject);
  if(!subject||!node?.installation_id)throw Error('participant_scope_changed');
  return {subject,installation_id:node.installation_id};
}
const proBusy=lock=>pendingCommands>0||!!agent.active||!!(agent.maintenance&&agent.maintenance!==lock)||!!agent.stopping||!!agent.stopActive||!!agent.pendingStop||!!agent.poolJobs?.size||!!participantSession.active||!!platformHealth.active;
const proParticipant=new CrowdParticipantPro({storage,owner:runtime.owner,uuid:()=>crypto.randomUUID(),
  identity:proIdentity,scope:async(lock=null)=>{
    await agent.initializeGeneration();const identity=await proIdentity();
    const s=await storage.get('agent')||{},owner=await runtime.owner();
    if(owner!==identity.subject||agent.generationOwner!==owner||s.owner_id&&s.owner_id!==owner||!Number.isSafeInteger(agent.generation))throw Error('participant_scope_changed');
    if(s.consent!==CrowdCore.CONSENT)throw Error('consent_required');
    if(proBusy(lock)||agent.recoveryUnsafe(s)||s.outbox?.length)throw Error('participant_writer_busy');
    return {...identity,generation:agent.generation};
  },busy:proBusy,acquire:()=>{if(proBusy())throw Error('participant_writer_busy');const lock={};agent.maintenance=lock;return lock;},release:lock=>{if(lock&&agent.maintenance===lock)agent.maintenance=null;},
  connect:()=>chrome.runtime.connectNative('com.crowd.v4.updater'),
  intent:enabled=>participantSession.intent(enabled),claim:()=>nodeMonitor.claim(),rpc:originalRPC,
  principal:async(uid,scope)=>{
    const expected=(await platformHealth.read()).xiaohongshu?.expected_ref;
    const ref=await runtime.leaseScope(scope.subject+'\n'+'xiaohongshu'+'\n'+uid);
    const current=(await platformHealth.read()).xiaohongshu?.expected_ref;
    return {...scope,matched:/^[a-f0-9]{64}$/.test(current||'')&&expected===current&&ref===current};
  },event:async(step,fields)=>{await nodeMonitor.event(step,fields);queueNodeFlush();}
});
// Manual login help remains available; automatic checks never open a DOM work page.
participantSession.start=()=>proParticipant.requestStart();
participantSession.check=()=>proParticipant.poll();
localTests.run=async()=>{};
localTests.allowed=()=>false;
recovery.run=async()=>{};
const updater = new CrowdUpdater({chrome,storage,agent,reportOTA:async fields=>{
  const settings=await diagnosticSettings();
  if(!settings.enabled||!settings.id)return false;
  const recorded=await nodeMonitor.event('ota',fields);if(recorded)queueNodeFlush();return recorded===true;
},isBusy:async()=>{
  const s=await agent.read();
  const uncertain=s.sdk_unknown||s.sdk_pending||s.pending_risk||s.pending_observation_batch||['sending','unknown'].includes(s.risk_report?.state);
  const parked=s.pilot_waiting===true&&s.pilot_phase==='awaiting_acceptance'&&s.last_error==='test_completed'&&!s.outbox?.length&&!s.work_slots?.length&&!uncertain;
  return await proParticipant.busy()||!!recovery.active||pendingCommands>0||!!agent.pendingStop||!!agent.stopping||!!agent.stopActive||!!agent.poolJobs?.size||!!(s.enabled&&s.work_slots?.length)||!!(s.pilot_waiting&&!parked&&(uncertain||s.outbox?.length||s.work_slots?.length||s.enrichment||['search','note','reopen_note','enrich','parallel'].includes(s.phase)));
},version:CrowdCore.VERSION,releaseHash:cachedReleaseHash});
let diagnosticReport;
const diagnosticKey = (id, suffix) => 'diagnostics:' + id + ':' + suffix;
const diagnosticErrors = ['navigation_failed','navigation_uncommitted','page_timeout','page_loading','content_unavailable','probe_timeout','page_mismatch','wrong_note','login_required','identity_verification_required','platform_identity_changed','backend_login_required','user_login','captcha','rate_limit','approval_required','consent_required','user_stopped','logged_out','system_suspended','lease_lost','daily_quota','review_local_rejections','backend_unavailable','control_unavailable','global_pause','action_budget','action_gap','session_rest','known_note','note_busy','invalid_receipt','test_completed','test_comments_partial','test_expired','test_quota','test_no_task','test_partial','test_new_run_required','parallel_unavailable','pool_recovery_required','executor_busy','update_in_progress','cancelled'];
const navigationErrors = ['ERR_NAME_NOT_RESOLVED','ERR_INTERNET_DISCONNECTED','ERR_CONNECTION_TIMED_OUT','ERR_TIMED_OUT','ERR_CONNECTION_RESET','ERR_CONNECTION_REFUSED','ERR_CONNECTION_CLOSED','ERR_ADDRESS_UNREACHABLE','ERR_NETWORK_CHANGED','ERR_TUNNEL_CONNECTION_FAILED','ERR_PROXY_CONNECTION_FAILED','ERR_CERT_AUTHORITY_INVALID','ERR_CERT_DATE_INVALID','ERR_SSL_PROTOCOL_ERROR','ERR_BLOCKED_BY_CLIENT','ERR_BLOCKED_BY_ADMINISTRATOR','ERR_ABORTED'];
let navigationQueue = Promise.resolve();
async function clearNavigation(restart = false) {
  await navigationQueue;
  const settings = await diagnosticSettings();
  if (!settings.id) return;
  const key = diagnosticKey(settings.id, 'navigation'), previousKey = diagnosticKey(settings.id, 'previous_navigation');
  if (restart && settings.enabled) {
    const current = await storage.get(key);
    if (current?.revision === settings.revision) await storage.set(previousKey, current);
  } else await storage.set(previousKey, null);
  await storage.set(key, null);
}
// Only the collector's main frame, only during opt-in; no URL is persisted.
for (const [event, stage] of Object.entries({onBeforeNavigate:'started',onCommitted:'committed',onDOMContentLoaded:'dom_ready',onCompleted:'complete',onErrorOccurred:'failed'})) {
  chrome.webNavigation?.[event]?.addListener(details => {
    if (details.frameId !== 0) return;
    if(stage==='committed')risk.captureNavigation(details).catch(console.error);
    const ownership = pendingTabCreation;
    navigationQueue = navigationQueue.then(async () => {
      if (ownership) { try { await ownership; } catch (_) { return; } }
      const settings = await diagnosticSettings();
      if (!settings.enabled || details.tabId !== await storage.get('work_tab')) return;
      try { const u = new URL(details.url); if (u.protocol !== 'https:' || !['www.xiaohongshu.com','m.xiaohongshu.com'].includes(u.hostname)) return; } catch (_) { return; }
      const code = String(details.error || '').replace(/^net::/, '');
      const key = diagnosticKey(settings.id, 'navigation'), previous = await storage.get(key);
      if (!Number.isFinite(details.timeStamp) || (previous?.at > details.timeStamp)) return;
      const current = await diagnosticSettings();
      if (!current.enabled || current.id !== settings.id || current.revision !== settings.revision) return;
      await trace.event('nav_'+stage);
      await storage.set(key, {stage, error: stage === 'failed' ? (navigationErrors.includes(code) ? code : 'OTHER') : null,
        at: details.timeStamp, revision: settings.revision, tab: details.tabId});
    }).catch(console.error);
  }, {url: [{schemes:['https'],hostEquals:'www.xiaohongshu.com'}, {schemes:['https'],hostEquals:'m.xiaohongshu.com'}]});
}
async function diagnosticSettings() {
  const session = await storage.get('session');
  if (!session?.user?.id) return {enabled: false};
  const id = session.user.id;
  return {id, enabled: await storage.get(diagnosticKey(id, 'enabled')) === true,
    pending_clear: await storage.get(diagnosticKey(id, 'clear')) === true,
    pending_enable: await storage.get(diagnosticKey(id, 'enable')) === true,
    revision: await storage.get(diagnosticKey(id, 'revision')) || 0,
    ...await storage.get(diagnosticKey(id, 'status'))};
}
async function initializeParticipantDiagnostics(enabled) {
  const id=(await storage.get('session'))?.user?.id;
  if(!id || typeof enabled!=='boolean' || await storage.get(diagnosticKey(id,'enabled'))!==undefined)return;
  await setDiagnostics(enabled);
}
async function repairDiagnostics() {
  const settings = await diagnosticSettings(), alarm = await chrome.alarms.get('crowd_diagnostics');
  if (settings.enabled || settings.pending_clear) {
    if (alarm?.periodInMinutes !== 1) await chrome.alarms.create('crowd_diagnostics', {periodInMinutes: 1});
  } else if (alarm) await chrome.alarms.clear('crowd_diagnostics');
}
async function reportDiagnostics() {
  if (diagnosticReport) return diagnosticReport;
  diagnosticReport = (async () => {
    const settings = await diagnosticSettings();
    if (!settings.id || (!settings.enabled && !settings.pending_clear)) return;
    const controller = new AbortController(); let timer;
    try {
      await Promise.race([new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('diagnostic_timeout')); }, 3000); }), (async () => {
        if (settings.pending_enable) {
          await api.rpc('diagnostics', {p_action: 'enable', p_revision: settings.revision}, controller.signal);
          if ((await diagnosticSettings()).revision === settings.revision) await storage.set(diagnosticKey(settings.id, 'enable'), false);
        }
        let snapshot = null;
        if (settings.enabled) {
          const s = await agent.read(), id = await workingTab();
          let tab = null, page = null, tabStatus = 'missing', probeStatus = 'unknown', probeError = 'unknown', navDocument = {document_kind:'unavailable',pending_kind:'none'};
          try {
            if (id) {
              tab = await chrome.tabs.get(id);
              navDocument = await navigationDocument(id, tab);
              tabStatus = tab.discarded ? 'discarded' : tab.status === 'loading' ? 'loading' : 'complete';
              if (tabStatus !== 'discarded') {
                // A disconnected content script is recorded, never fixed by bypassing policy.
                const result = await probeTab(id, 'diagnostics');
                probeStatus = result.status;
                probeError = result.error;
                page = result.response?.page || null;
                if (!page && tabStatus === 'complete') tabStatus = 'no_content';
              }
            }
          } catch (_) { tabStatus = tab ? (tab.status === 'loading' ? 'loading' : 'no_content') : 'missing'; }
          const number = (value, max) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0;
          const oneOf = (value, options, fallback) => options.includes(value) ? value : fallback;
          const savedNavigation = await storage.get(diagnosticKey(settings.id, 'navigation'));
          const navigation = savedNavigation?.revision === settings.revision && savedNavigation?.tab === id ? savedNavigation : null;
          const savedPrevious = await storage.get(diagnosticKey(settings.id, 'previous_navigation'));
          const previous = savedPrevious?.revision === settings.revision ? savedPrevious : null;
          const age = at => Number.isFinite(at) ? Math.min(86400, Math.max(0, Math.floor((Date.now() - at) / 1000))) : null;
          const update = await updater.status();
          snapshot = {version: CrowdCore.VERSION, enabled: s.enabled === true,
            trace:await trace.snapshot(),update_state:update.state||'unknown',
            updater_enabled:update.enabled===true,
            ota_last_poll_at:Number.isFinite(update.last_poll_at)&&update.last_poll_at>0&&update.last_poll_at<=4102444800?Math.floor(update.last_poll_at):null,
            ota_poll_status:oneOf(update.poll_status,['current','downloaded','pending_reload','error'],null),
            ota_poll_error:oneOf(update.poll_error,['invalid_signature','hash_mismatch','permission_change','replayed_release','recovery_required','busy','operation_failed','invalid_manifest','invalid_url','wrong_extension','update_failed','ota_network_dns','ota_network_connect','ota_network_timeout','ota_network_tls','ota_network_http','ota_network_transfer','ota_io_permission','ota_io_missing','ota_io_space','ota_io_failed','ota_package_tool_failed','ota_service_failed','ota_process_terminated','ota_process_launch_failed','ota_unknown_exit','too_large','unsafe_archive','invalid_package','lock_failed','swap_failed','process_check_failed','handshake_mismatch','version_mismatch'],null),
            ota_poll_query_error:oneOf(update.poll_query_error,['busy','invalid_response','helper_unavailable'],null),auto_test_enabled:(await localTests.status()).enabled===true,
            document_kind:navDocument.document_kind, pending_kind:navDocument.pending_kind,
            nav_stage: navigation?.stage || 'unknown', nav_error: navigation?.error || null,
            nav_age_s: age(navigation?.at),
            prev_nav_stage: previous?.stage || 'unknown', prev_nav_error: previous?.error || null, prev_nav_age_s: age(previous?.at),
            page_failures: number(s.page_failures, 3), last_tick_age_s: age(s.last_tick),
            next_in_s: Math.min(86400, Math.max(0, Math.ceil(((s.next_at || 0) - Date.now()) / 1000))),
            probe_status: probeStatus, probe_error: probeError,
            phase: oneOf(s.phase, ['idle','search','search_done','note','reopen_note','enrich','parallel'], 'idle'),
            error: s.last_error==='sdk_unknown' ? 'pool_recovery_required' : s.last_error==='task_full' ? 'session_rest' : s.last_error ? oneOf(s.last_error, diagnosticErrors, 'unexpected_error') : null,
            pool_failure:oneOf(s.last_error==='sdk_unknown'?'unknown':s.pool_failure||workTabs.lastFailure,['entry_state','tab_missing','tab_discarded','url_changed','token_changed','document_changed','unbound_restart','bind_failed','presentation_identity','close_identity','unknown'],null),
            task_id: Number.isSafeInteger(s.task?.id) ? s.task.id : null,
            queued: number(s.outbox.length, 99999), rejected: number(s.rejected.length, 99999),
            page_kind: oneOf(page?.kind, ['search','note','other'], tab ? 'unknown' : 'missing'), tab_status: tabStatus,
            document: oneOf(page?.document, ['loading','interactive','complete'], 'unknown'),
            gate: oneOf(page?.gate, ['login_required','captcha','rate_limit'], null),
            links: number(page?.links, 500), search_note_links: number(page?.search_note_links, 500), body_chars: number(page?.body_chars, 24000),
            visible: typeof page?.visible === 'boolean' ? page.visible : null};
        }
        if (controller.signal.aborted) throw new Error('diagnostic_timeout');
        const result = await api.rpc('diagnostics', {p_action: settings.enabled ? 'report' : 'disable', p_revision: settings.revision, p_state: snapshot}, controller.signal);
        if ((await diagnosticSettings()).revision !== settings.revision) return;
        await storage.set(diagnosticKey(settings.id, 'status'), {sent_at: settings.enabled ? Date.parse(result.saved_at) : null, error: null});
        if (!settings.enabled) { await storage.set(diagnosticKey(settings.id, 'clear'), false); await repairDiagnostics(); }
      })()]);
    } catch (_) {
      if ((await diagnosticSettings()).revision === settings.revision) await storage.set(diagnosticKey(settings.id, 'status'), {error: 'unavailable'});
    } finally { clearTimeout(timer); }
  })().finally(() => { diagnosticReport = null; });
  return diagnosticReport;
}
async function setDiagnostics(enabled) {
  await diagnosticReport;
  const settings = await diagnosticSettings(); if (!settings.id) throw new Error('backend_login_required');
  // Server revisions reject delayed reports/control requests after opt-out.
  await storage.set(diagnosticKey(settings.id, 'revision'), Math.max(Date.now(), settings.revision + 1));
  await storage.set(diagnosticKey(settings.id, 'enabled'), enabled);
  await trace.clear(settings.id);
  await clearNavigation();
  await storage.set(diagnosticKey(settings.id, 'enable'), enabled);
  await storage.set(diagnosticKey(settings.id, 'clear'), !enabled);
  await repairDiagnostics(); await reportDiagnostics();
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if(message.type==='platform_session_changed'){
    try{const u=new URL(sender.url||sender.tab?.url);if(sender.tab&&u.protocol==='https:'&&['www.xiaohongshu.com','m.xiaohongshu.com'].includes(u.hostname))queuePlatformHealth();}catch(_){}return;
  }
  if (message.type === 'page_ready') {
    (async()=>{if((await agent.read()).work_slots?.length){const slot=await workTabs.ready(sender,message);if(slot){agent.poolReadySlots ||= new Map();agent.poolReadySlots.set(slot,{generation:agent.generation,target:message.target});agent.poolWake=true;return agent.tick();}}if(await storage.get('work_tab')===sender.tab?.id)return agent.pageReady(message.target,message.keyword);})().catch(console.error);return;
  }
  const allowed = [chrome.runtime.getURL('src/controller.html')];
  if (!allowed.includes(sender.url) || sender.tab?.url?.startsWith(CrowdCore.HOST)) return;
  const mutating=!['state','stop','export','update_check','update_settings'].includes(message.type);
  if(mutating)pendingCommands++;
  const operation=(async () => {
    if (await legacyInstallation && message.type !== 'state') throw Error('legacy_migration_required');
    if (agent.maintenance && !['state','stop','export'].includes(message.type)) throw new Error('update_in_progress');
    switch (message.type) {
      case 'update_settings': await updater.setEnabled(message.enabled); return {};
      case 'update_check': {const result=await updater.check();if(result?.blocked)throw Error(result.blocked);return {};}
      case 'local_test_updates': if(message.enabled===false)await recovery.cancel();await localTests.settings(message.enabled);return {};
      case 'state': { const session=await storage.get('session'), legacy=await legacyInstallation; if(legacy)return {legacy_installation:true,session:!!session,invited:false,agent:CrowdCore.initial(),status:{error:'legacy_migration_required'},progress:null,diagnostics:{enabled:false},updater:{enabled:false,state:'legacy_hold'},local_test:false,local_test_updates:{enabled:false},risk_confirmation:{}}; const settings = await diagnosticSettings(); return {entry_state:await participantEntry(),consent_scope:session?.user?.id||'signed-out',platform_session:await participantSession.status(),legacy_installation:legacy,node_monitor:await nodeMonitor.snapshot(),risk_confirmation:await risk.status(),recovery:!!session&&!legacy&&localTests.allowed()&&(await localTests.status()).enabled===true?await api.rpc('recovery_check',{p_action:'status'}).catch(()=>null):null,local_test:localTests.allowed(),local_test_updates:await localTests.status(),source_executor:'mediacrawler_pro',pro_participant:await proParticipant.read(),parallel_requested:(await agent.preferences())?.parallelism,parallel_allowed:await runtime.poolAllowed(),updater:legacy?{enabled:false,state:'legacy_hold'}:await updater.status(),agent: await agent.read(), session: !!session, invited: !!await storage.get('pending_invite'), diagnostics: {...settings, id: undefined}, status: legacy?{error:'legacy_migration_required'}:session?await api.rpc('status').catch(e => ({error: e.message})):{}, progress:session&&!legacy?await api.rpc('progress').catch(()=>null):null,source_runtime:{active:!!agent.active,stopping:!!agent.stopping,maintenance:!!agent.maintenance,session_active:!!participantSession.active}}; }
      case 'rating': await agent.queueRating(message.proof, message.score, message.reason); agent.tick(false,true).catch(console.error); return {};
      case 'risk_confirm': return risk.confirm(message.confirmed);
      case 'parallelism': {await agent.requestParallelism(message.value);return {};}
      case 'profiles': {
        if(typeof message.enabled !== 'boolean')throw new Error('invalid_request');
        await agent.stop();
        const result=await api.rpc('observation_preferences',{p_profiles:message.enabled});
        const s=await agent.read();s.profiles=result.profiles===true;await agent.save(s);return {};
      }
      case 'diagnostics': {
        if (typeof message.enabled !== 'boolean') throw new Error('invalid_request');
        await setDiagnostics(message.enabled); await nodeMonitor.flush(); return {};
      }
      case 'inspect_work_page': {
        const id = await workingTab(); if (!id) throw new Error('work_page_missing');
        const tab = await chrome.tabs.update(id, {active: true}); await chrome.windows.update(tab.windowId, {focused: true}); return {};
      }
      case 'receive_invite': await storage.set('pending_invite', CrowdJoin.invite(message.invite, CROWD_CONFIG.portal)); return {};
      case 'join': {
        const entry=await participantEntry();
        if(entry==='identity_recovery_required')throw Error(entry);
        if(entry==='ready')throw Error('participant_already_joined');
        if(entry!=='invited')throw Error('invite_required');
        if (message.consent !== CrowdCore.CONSENT) throw new Error('consent_required');
        await agent.stop(); const generation = agent.generation;
        await CrowdJoin.join(api, storage, await storage.get('pending_invite'));
        if (generation !== agent.generation) throw new Error('cancelled');
        const s = await agent.read(); s.consent = CrowdCore.CONSENT; await agent.save(s);
        if (generation !== agent.generation) throw new Error('cancelled');
        await initializeParticipantDiagnostics(message.diagnostics);
        if (generation !== agent.generation) throw new Error('cancelled');
        await participantSession.start(); return {};
      }
      case 'login': await agent.stop(); return api.login(message.email, message.password, message.signup);
      case 'consent': {
        await requireParticipant();
        await agent.stop(); await api.rpc('register', {p_consent: CrowdCore.CONSENT});
        const s = await agent.read(); s.consent = CrowdCore.CONSENT; await agent.save(s); return {};
      }
      case 'start': await requireParticipant(); await participantSession.start(); return {};
      case 'test_start': throw Error('participant_pro_required');
      case 'stop': await recovery.cancel();await localTests.cancel();await agent.stop('user_stopped', {drain:true}); return {};
      case 'logout': {
        await recovery.cancel();
        await localTests.cancel();
        await agent.stop('logged_out');
        const settings = await diagnosticSettings();
        if (settings.enabled || settings.pending_clear) await setDiagnostics(false);
        await api.logout(); await repairDiagnostics(); return {};
      }
      case 'export': { const s = await agent.read(); return {outbox: s.outbox, rejected: s.rejected}; }
      case 'open_login': {
        await agent.stop('user_login',{keepPage:true,drain:true});
        if((await platformHealth.read()).xiaohongshu?.expected_ref)return participantSession.openLogin();
        // Keep the actual challenge/note page. Opening help is a user action,
        // not evidence that either platform or backend authentication failed.
        const held=await participantSession.status();
        if(!held.pending)await agent.stop('user_login', {keepPage:true,drain:true});
        const id = await workingTab() || await storage.get('work_tab');
        if (id) {
          try {
            const tab = await chrome.tabs.get(id), url = new URL(tab.pendingUrl || tab.url);
            if (url.protocol === 'https:' && !url.username && !url.password && !url.port && ['www.xiaohongshu.com','m.xiaohongshu.com'].includes(url.hostname)) {
              await chrome.tabs.update(id, {active: true});
              await chrome.windows.update(tab.windowId, {focused: true}); return {};
            }
          } catch (_) {}
        }
        const tab = await chrome.tabs.create({url: CrowdCore.HOST, active: true});
        await storage.set('work_tab', tab.id); return {};
      }
      default: throw new Error('unknown_command');
    }
  })();
  if(message.type==='stop'){
    const stopped=Promise.allSettled([agent.pendingStop,operation]).then(results=>{
      const failed=results.some(result=>result.status==='rejected');
      if(agent.pendingStop===stopped)agent.updateStopFailed=failed;
      if(failed)throw Error('executor_busy');
    }).finally(()=>{if(agent.pendingStop===stopped)agent.pendingStop=null;});
    agent.pendingStop=stopped;
    stopped.catch(()=>{});
  }
  operation.finally(()=>{if(mutating)pendingCommands--;}).then(data => reply({ok: true, data}), e => reply({ok: false, error: e.message}));

  return true;
});
chrome.runtime.onMessageExternal?.addListener((message, sender, reply) => {
  try {
    const u = new URL(sender.url), portal = new URL(CROWD_CONFIG.portal);
    if (u.origin !== portal.origin || u.pathname !== '/crowd' || message.type !== 'connect') return;
    const value = CrowdJoin.invite(message.invite, CROWD_CONFIG.portal);
    legacyInstallation.then(legacy=>{if(legacy)throw Error('legacy_migration_required');return storage.set('pending_invite', value);}).then(() => chrome.tabs.create({url: chrome.runtime.getURL('src/controller.html'), active: true}))
      .then(() => reply({ok: true}), () => reply({ok: false}));
    return true;
  } catch (_) { return; }
});
chrome.alarms.onAlarm.addListener(async alarm => {
  if(await legacyInstallation)return;
  if(alarm.name==='crowd_platform_health')participantSession.check(true).catch(console.error);
  if(alarm.name==='crowd_node_monitor')nodeMonitor.flush().catch(()=>{});
  if (alarm.name === 'crowd_update') updater.check().catch(console.error);
  if (alarm.name === 'crowd_update_bootstrap') updater.bootstrap().then(()=>localTests.run()).catch(console.error);
  if (alarm.name === 'crowd_tick') agent.tick().then(()=>localTests.run()).catch(console.error);
  if (alarm.name === 'crowd_upload') agent.tick(false, true).then(()=>localTests.run()).catch(console.error);
  if (alarm.name === 'crowd_diagnostics') recovery.run().then(()=>localTests.run()).then(reportDiagnostics).catch(console.error);
});
chrome.runtime.onStartup.addListener(async () => { if(await legacyInstallation)return; await repairPlatformHealth(); await agent.repairDelivery(); await agent.tick(true); await repairDiagnostics(); await reportDiagnostics(); });
chrome.runtime.onInstalled.addListener((details = {reason: 'install'}) => {
  (async () => {
    if(await legacyInstallation){await chrome.runtime.openOptionsPage?.();return;}
    // Also hand off a trial when replacing an unjoined development copy.
    // Never overwrite an existing invitation, consent or participant identity.
    const handoff = /^[a-f0-9]{64}$/.test(CROWD_CONFIG.trialInvite || '') && !await storage.get('pending_invite') && !await storage.get('session');
    if (handoff) await storage.set('pending_invite', CROWD_CONFIG.trialInvite);
    if (details.reason === 'install' || handoff) await chrome.runtime.openOptionsPage?.();
    await agent.tick(details.reason !== 'update');
    await repairDiagnostics();
  })().catch(console.error);
});
chrome.tabs.onRemoved.addListener((id,info) => {
  workTabs.removed(id,info).catch(()=>{});
  storage.get('work_tab').then(owned => { if (owned === id) return storage.set('work_tab', null); }).catch(console.error);
});
// Service-worker restarts can lose alarms on older browsers. Check the durable
// running state on every load; initial installation and user stops remain idle.
legacyInstallation.then(legacy=>{if(legacy)return;return updater.bootstrap().then(repairPlatformHealth).then(()=>chrome.alarms.create('crowd_node_monitor',{periodInMinutes:.5})).then(()=>trace.event('worker_started')).then(()=>agent.repairDelivery()).then(()=>agent.tick()).then(()=>localTests.run()).then(repairDiagnostics).then(()=>recovery.run()).then(()=>localTests.run()).then(reportDiagnostics);}).catch(console.error);
