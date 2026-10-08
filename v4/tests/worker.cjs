'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const src=path.resolve(__dirname,'../src'); let listener, installed, startup, alarmListener, accesses=[],fetches=[],optionsOpened=0, alarm=null,diagnosticAlarm=null, windows=[{id:1}],tabInfo={status:'complete'},createdTabs=[],createdWindows=[],probeReply={ready:false},diagnosticsOffline=false;const data={}; const navListeners={};
const chrome={webNavigation:Object.fromEntries(['onBeforeNavigate','onCommitted','onDOMContentLoaded','onCompleted','onErrorOccurred'].map(name=>[name,{addListener:fn=>navListeners[name]=fn}])),runtime:{id:'test-extension',getURL:x=>'chrome-extension://test-extension/'+x,
 openOptionsPage:async()=>{optionsOpened++;},
 onMessage:{addListener:fn=>listener=fn},onStartup:{addListener:fn=>startup=fn},onInstalled:{addListener:fn=>installed=fn}},
 storage:{local:{get:async key=>({[key]:structuredClone(data[key])}),set:async value=>Object.assign(data,structuredClone(value)),setAccessLevel:async value=>accesses.push(value.accessLevel)}},
 alarms:{get:async name=>name==='crowd_diagnostics'?diagnosticAlarm:alarm,create:async(name,info)=>{if(name==='crowd_diagnostics')diagnosticAlarm={name,...info};else alarm={name,...info};},clear:async name=>{if(name==='crowd_diagnostics')diagnosticAlarm=null;else alarm=null;},onAlarm:{addListener:fn=>alarmListener=fn}},
 windows:{getAll:async()=>windows,update:async(id,info)=>{createdWindows.push({id,...info});},create:async info=>{createdWindows.push(info);return {tabs:[{id:77}]};}},
 tabs:{onRemoved:{addListener:()=>{}},get:async()=>tabInfo,create:async info=>{createdTabs.push(info);return {id:77};},update:async(id,info)=>{createdTabs.push({id,...info});return {windowId:1};},sendMessage:async()=>{if(probeReply instanceof Error)throw probeReply;return await (typeof probeReply === 'function' ? probeReply() : probeReply);},remove:async()=>{}}};
const context=vm.createContext({chrome,console,URL,Date,Math,AbortController,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,
 fetch:async(url,options)=>{fetches.push({url,options});if(url.endsWith('crowd_v4_guard'))return {ok:true,json:async()=>({version:1,ttl_ms:600000,paused:false,allowed:true,reason:null,wait_ms:0,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:0,comment:0,scroll:0},session_count:0})};if(url.endsWith('crowd_v4_diagnostics')){if(diagnosticsOffline)throw new Error('offline');return {ok:true,json:async()=>({saved_at:new Date().toISOString()})};}return {ok:true,json:async()=>({participant:{status:'approved'}})};}});
context.importScripts=(...names)=>{for(const name of names){if(name==='config.js')context.CROWD_CONFIG={url:'https://test.supabase.co',key:'sb_publishable_test'};else vm.runInContext(fs.readFileSync(path.join(src,name),'utf8'),context);}};
vm.runInContext(fs.readFileSync(path.join(src,'background.js'),'utf8'),context);
(async()=>{
 installed();await new Promise(r=>setImmediate(r));assert.equal(fetches.length,0,'installation must not start collection');assert.deepEqual(accesses,['TRUSTED_CONTEXTS']);
 assert.equal(optionsOpened,1);
 context.CROWD_CONFIG.trialInvite='a'.repeat(64);installed();await new Promise(r=>setImmediate(r));
 assert.equal(data.pending_invite,'a'.repeat(64));assert.equal(fetches.length,0,'trial handoff does not consent or register');
 data.pending_invite='b'.repeat(64);installed({reason:'update'});await new Promise(r=>setImmediate(r));
 assert.equal(data.pending_invite,'b'.repeat(64),'update must never overwrite an existing invitation');assert.equal(optionsOpened,2);
 delete data.pending_invite;installed({reason:'update'});await new Promise(r=>setImmediate(r));
 assert.equal(data.pending_invite,'a'.repeat(64),'unjoined development copy also receives the trial invitation');assert.equal(optionsOpened,3);assert.equal(fetches.length,0);
 let leaked=false;const result=listener({type:'state'},{id:chrome.runtime.id,url:'https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01',tab:{id:77,url:'https://www.xiaohongshu.com/'}},()=>leaked=true);assert.equal(result,undefined);assert.equal(leaked,false);
 const state=await new Promise(resolve=>listener({type:'state'},{id:chrome.runtime.id,url:chrome.runtime.getURL('src/controller.html')},resolve));assert.equal(state.ok,true);assert.equal(state.data.session,false);assert.equal(state.data.agent.enabled,false);
 // The returned UI status never contains session tokens.
 data.session={user:{id:'one'},access_token:'USER_ACCESS',refresh_token:'USER_REFRESH',expires_at:Date.now()+3600000};
 const signed=await new Promise(resolve=>listener({type:'state'},{id:chrome.runtime.id,url:chrome.runtime.getURL('src/controller.html')},resolve));
 assert.equal(JSON.stringify(signed).includes('USER_ACCESS'),false);assert.equal(fetches[0].options.headers.Authorization,'Bearer USER_ACCESS');
 // Browser restart repairs an absent repeating alarm without bypassing cooldown.
 const deadline=Date.now()+3600000;
 data['agent:one']={...context.CrowdCore.initial(),enabled:true,consent:context.CrowdCore.CONSENT,next_at:deadline,phase:'search'};
 await startup();assert.equal(alarm.periodInMinutes,.5);assert.equal(data['agent:one'].enabled,true);assert.equal(data['agent:one'].next_at,deadline);
 alarm=null;await vm.runInContext('agent.tick()',context);assert.equal(alarm.periodInMinutes,.5,'worker load/tick repairs cleared alarms');
 const url='https://www.xiaohongshu.com/explore/abcdef0123456789abcdef01';
 delete data.work_tab;await vm.runInContext('runtime.open('+JSON.stringify(url)+')',context);
 assert.equal(createdTabs.at(-1).active,false);assert.equal(createdTabs.at(-1).windowId,1);
 windows=[];delete data.work_tab;await vm.runInContext('runtime.open('+JSON.stringify(url)+')',context);
 assert.equal(createdWindows.at(-1).state,'minimized');assert.equal(createdWindows.at(-1).focused,false);
 tabInfo={status:'complete',url:'https://example.test/personal'};
 const beforeForeign=createdTabs.length;
 await vm.runInContext('runtime.open('+JSON.stringify(url)+')',context);
 assert.equal(createdTabs.length,beforeForeign,'a stale tab ID must not navigate an unrelated user tab');
 assert.equal(createdWindows.at(-1).state,'minimized');
 tabInfo={discarded:true};assert.equal((await vm.runInContext('runtime.probe("note")',context)).reopen,true);
 tabInfo={status:'loading'};probeReply={ready:true,links:[url]};
 assert.equal((await vm.runInContext('runtime.probe("search")',context)).ready,true,'loading subresources must not block rendered DOM');
 probeReply=new Error('Receiving end does not exist');
 assert.notEqual((await vm.runInContext('runtime.probe("search")',context)).reopen,true,'wait for initial script injection without restarting navigation');
 tabInfo={status:'complete'};
 assert.notEqual((await vm.runInContext('runtime.probe("search")',context)).reopen,true,'an existing page with no receiver must reach the deadline, not enter an endless reopen loop');
 for(const reason of ['user_stopped','captcha','rate_limit','logged_out']) {
  data['agent:one']={...context.CrowdCore.initial(),consent:context.CrowdCore.CONSENT,enabled:false,last_error:reason};alarm=null;
  const before=fetches.length;await startup();assert.equal(fetches.length,before);assert.equal(alarm,null);assert.equal(data['agent:one'].last_error,reason);
 }
 const command=message=>new Promise(resolve=>listener(message,{id:chrome.runtime.id,url:chrome.runtime.getURL('src/controller.html')},resolve));
 const navEvent={tabId:77,frameId:0,url:url+'?xsec_token=PRIVATE_URL_TOKEN',timeStamp:Date.now()};
 const nav=async(name,extra={})=>{navListeners[name]({...navEvent,...extra});await vm.runInContext('navigationQueue',context);};
 await nav('onErrorOccurred',{error:'net::ERR_NAME_NOT_RESOLVED'});
 assert.equal(data['diagnostics:one:navigation'] ?? null,null,'no navigation telemetry before opt-in');
 probeReply=()=>new Promise(()=>{});
 assert.equal((await vm.runInContext('runtime.probe("search")',context)).reason,'probe_timeout','hung message must release the agent lock');
 assert.equal(fetches.filter(f=>f.url.endsWith('crowd_v4_diagnostics')).length,0,'no diagnostics before explicit opt-in');
 tabInfo={status:'complete',url:url+'?xsec_token=PRIVATE_URL_TOKEN'};
 probeReply={ready:true,page:{kind:'note',document:'complete',gate:null,links:2,search_note_links:3,body_chars:200,visible:false,text:'PRIVATE_NOTE',url:'PRIVATE_URL_TOKEN',cookie:'PRIVATE_COOKIE'}};
 assert.equal((await command({type:'diagnostics',enabled:true})).ok,true);
 assert.equal(diagnosticAlarm.periodInMinutes,1);
 const reports=fetches.filter(f=>f.url.endsWith('crowd_v4_diagnostics')).map(f=>JSON.parse(f.options.body));
 assert.equal(reports[0].p_action,'enable');assert.equal(reports[1].p_action,'report');
 assert.equal(reports[1].p_state.enabled,false,'enabling diagnostics never starts a stopped collector');
 assert.equal(reports[1].p_state.error,'logged_out');assert.equal(reports[1].p_state.body_chars,200);
 assert.equal(JSON.stringify(reports).includes('PRIVATE_'),false,'page secrets/text/URLs must not be reported');
 assert.equal(JSON.stringify(reports).includes('USER_ACCESS'),false);
 await nav('onErrorOccurred',{error:'net::ERR_NAME_NOT_RESOLVED'});
 assert.equal(data['diagnostics:one:navigation'].error,'ERR_NAME_NOT_RESOLVED');
 const saved=JSON.stringify(data['diagnostics:one:navigation']);
 for(const extra of [{tabId:99},{frameId:1},{url:'https://example.test/private'},{timeStamp:navEvent.timeStamp-1}]) await nav('onCompleted',extra);
 assert.equal(JSON.stringify(data['diagnostics:one:navigation']),saved,'other tabs, frames, origins and stale events ignored');
 await vm.runInContext('reportDiagnostics()',context);
 let navReport=JSON.parse(fetches.at(-1).options.body).p_state;
 assert.equal(navReport.nav_error,'ERR_NAME_NOT_RESOLVED');assert.equal(navReport.nav_stage,'failed');assert.equal(navReport.probe_status,'ok');
 assert.equal(JSON.stringify(navReport).includes('PRIVATE_'),false);
 await nav('onErrorOccurred',{error:'PRIVATE_URL_TOKEN raw arbitrary error'});
 assert.equal(data['diagnostics:one:navigation'].error,'OTHER');
 await nav('onCompleted',{timeStamp:navEvent.timeStamp+1});
 assert.equal(data['diagnostics:one:navigation'].error,null,'successful navigation clears previous error');
 probeReply=new Error('Receiving end does not exist');tabInfo={status:'loading'};
 assert.equal((await vm.runInContext('runtime.probe("search")',context)).reason,'page_loading');
 tabInfo={status:'complete'};
 assert.equal((await vm.runInContext('runtime.probe("search")',context)).reason,'content_unavailable');
 await vm.runInContext('reportDiagnostics()',context);
 assert.equal(JSON.parse(fetches.at(-1).options.body).p_state.probe_status,'no_receiver');
 probeReply={ready:true,page:{kind:'note',document:'complete',body_chars:200}};

 tabInfo={status:'loading'};await vm.runInContext('reportDiagnostics()',context);
 const loadingReport=JSON.parse(fetches.at(-1).options.body).p_state;
 assert.equal(loadingReport.tab_status,'loading');assert.equal(loadingReport.body_chars,200,'diagnostics probe DOM even while loading');
 tabInfo={status:'complete'};
 assert.equal((await command({type:'diagnostics',enabled:false})).ok,true);assert.equal(diagnosticAlarm,null);
 assert.equal(JSON.parse(fetches.at(-1).options.body).p_action,'disable');
 assert.equal(JSON.parse(fetches.at(-1).options.body).p_state,null);
 assert.equal(data['diagnostics:one:navigation'],null,'opt-out clears local navigation snapshot');
 await nav('onErrorOccurred',{error:'net::ERR_CONNECTION_RESET'});assert.equal(data['diagnostics:one:navigation'],null);
 diagnosticsOffline=true;await command({type:'diagnostics',enabled:true});
 assert.equal(data['agent:one'].enabled,false,'telemetry failure never changes collector state');
 const diagState=await command({type:'state'});assert.equal(diagState.data.diagnostics.error,'unavailable');
 await command({type:'diagnostics',enabled:false});assert.ok(diagnosticAlarm,'offline opt-out retries clearing without sending snapshots');
 diagnosticsOffline=false;await vm.runInContext('reportDiagnostics()',context);assert.equal(diagnosticAlarm,null);
 assert.equal(JSON.parse(fetches.at(-1).options.body).p_action,'disable');
 assert.equal((await command({type:'inspect_work_page'})).ok,true);
 assert.equal(createdTabs.at(-1).active,true,'work page focus requires the explicit controller command');
 await command({type:'diagnostics',enabled:true});
 assert.equal((await command({type:'logout'})).ok,true);
 assert.equal(diagnosticAlarm,null,'logout clears the diagnostic alarm');
 assert.equal(data.session,null);
 const lastDiagnostic=fetches.filter(f=>f.url.endsWith('crowd_v4_diagnostics')).at(-1);
 assert.equal(JSON.parse(lastDiagnostic.options.body).p_action,'disable','logout clears the latest cloud snapshot before dropping research identity');
 delete data.session;const beforeNoSession=fetches.length;await vm.runInContext('reportDiagnostics()',context);assert.equal(fetches.length,beforeNoSession,'signed-out identities send nothing');
 // Firefox event pages load background.scripts and have neither importScripts nor setAccessLevel.
 const manifest=JSON.parse(fs.readFileSync(path.join(src,'../manifest.json')));
 assert.equal(manifest.content_scripts[0].run_at,'document_end','page probe must be installed before subresource load completion');
 const firefox={...chrome,runtime:{...chrome.runtime,getURL:x=>'moz-extension://test-extension/'+x},storage:{local:{get:async()=>({}),set:async()=>{}}}};
 const page=vm.createContext({chrome:firefox,console,URL,Date,Math,AbortController,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,fetch:()=>{throw new Error('Unexpected anonymous request');}});
 for(const file of manifest.background.scripts) {
  if(file==='src/config.js') page.CROWD_CONFIG={url:'https://test.supabase.co',key:'sb_publishable_test'};
  else vm.runInContext(fs.readFileSync(path.join(src,'../',file),'utf8'),page);
 }
 const idle=await new Promise(resolve=>listener({type:'state'},{id:firefox.runtime.id,url:firefox.runtime.getURL('src/controller.html')},resolve));
 assert.equal(idle.ok,true);assert.equal(idle.data.agent.enabled,false);
 console.log('PASS Firefox event-page source adapter: dependency order, capability checks, idle state without anonymous network access');
 console.log('PASS MV3 source adapter: no auto-start, trusted storage, content-page command denial, authenticated RPC, no UI token exposure');
 console.log('PASS desktop recovery: periodic alarm repair, startup cooldown preserved, inactive tab/minimized window, discarded page recovery, stopped/blocked states stay stopped');
 console.log('PASS diagnostics: explicit opt-in, scalar allowlist, one-minute heartbeat, paused collection unchanged, offline isolation, opt-out/clear retry, no anonymous reports');
 console.log('LIMIT: Chrome API mock; native extension-engine installation remains an acceptance item');
})().catch(e=>{console.error(e);process.exitCode=1});
