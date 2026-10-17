'use strict';
// Installed extension end-to-end, isolated source pages and synthetic backend receipts.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const puppeteer=require(process.env.CROWD_PUPPETEER_MODULE),extension=path.resolve(process.env.CROWD_TEST_EXTENSION);
const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'))),creator='d'.repeat(24),ids=['a'.repeat(24),'b'.repeat(24)];
let browser,proxy,site;const result={version:manifest.version,scope:'Actual installed Chrome extension; local HTTPS source fixtures and synthetic receipts; no platform accounts',requests:[],runs:[]};
(async()=>{try{
 const https=require('node:https'),http=require('node:http'),net=require('node:net'),cp=require('node:child_process');
 const cert=fs.mkdtempSync(path.join(os.tmpdir(),'crowd-kol-cert-'));
 cp.execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(cert,'key.pem'),'-out',path.join(cert,'cert.pem'),'-days','1','-subj','/CN=www.xiaohongshu.com'],{stdio:'ignore'});
 site=https.createServer({key:fs.readFileSync(path.join(cert,'key.pem')),cert:fs.readFileSync(path.join(cert,'cert.pem'))},(req,res)=>{
  const u=new URL(req.url,'https://'+req.headers.host);result.requests.push({host:u.hostname,path:u.pathname,has_local_locator:u.searchParams.get('xsec_token')==='LOCAL_LOCATOR_ONLY'});
  let body;
  if(u.hostname==='www.xiaohongshu.com')body=u.pathname.includes('/user/profile/')?'<div class="user-info"><span class="user-name">作者</span><div class="user-interactions"><div>粉丝<span class="count">12</span></div></div></div>'+ids.map(id=>`<section class="note-item"><a href="https://www.xiaohongshu.com/explore/${id}?xsec_token=LOCAL_DETAIL_ONLY">内容</a></section>`).join(''):
    `<section class="note-container"><h1 id="detail-title">隔离笔记</h1><div id="detail-desc">实际页面DOM正文。</div><div class="author-wrapper"><a href="https://www.xiaohongshu.com/user/profile/${creator}"><span class="username">作者</span></a></div></section>`;
  else if(u.hostname==='space.bilibili.com')body='<div class="upinfo"><span class="nickname">UP主</span><span id="n-fs">100</span></div>'+['BV1xx411c7mD','BV1xx411c7mE'].map(id=>`<div class="bili-video-card"><a href="https://www.bilibili.com/video/${id}">视频</a></div>`).join('');
  else body='<h1 class="video-title">隔离公开视频</h1><div class="basic-desc-info">实际视频介绍原文。</div><div class="up-info"><a href="https://space.bilibili.com/123">UP主</a></div><span class="view-text">1.2万</span>';
  const navigation=u.hostname==='www.xiaohongshu.com'?`<nav><a href="https://www.xiaohongshu.com/user/profile/${'e'.repeat(24)}">我</a></nav>`:'<header class="bili-header"><a class="header-avatar-wrap" href="https://space.bilibili.com/999"><img alt="头像" style="width:24px;height:24px"></a></header>';
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html><body>'+navigation+body+'</body></html>');
 });await new Promise(r=>site.listen(0,'127.0.0.1',r));
 proxy=http.createServer((req,res)=>{res.writeHead(403);res.end();});
 proxy.on('connect',(req,socket,head)=>{
  if(!['www.xiaohongshu.com:443','space.bilibili.com:443','www.bilibili.com:443'].includes(req.url)){socket.destroy();return;}
  const upstream=net.connect(site.address().port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
 });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 browser=await puppeteer.launch({executablePath:process.env.CROWD_CHROME_BIN,headless:false,pipe:true,protocolTimeout:15000,userDataDir:fs.mkdtempSync(path.join(os.tmpdir(),'crowd-kol-engine-')),ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--proxy-server=http://127.0.0.1:${proxy.address().port}`,'--ignore-certificate-errors']});
 const worker=await(await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith(manifest.background.service_worker))).worker();
 const ordinary=await browser.newPage();await ordinary.goto('data:text/html,<title>User work</title>Do not steal focus');
 await worker.evaluate(async()=>{
  await chrome.storage.local.set({session:{user:{id:'kol-fixture'}},updater_enabled:false});
  globalThis.fixture={offset:0,received:[],profiles:[],guards:[],requests:[],finish:0,legacyFinishes:0,platform:'xiaohongshu',lost:false,receipts:{}};
  kol.r.now=()=>Date.now()+fixture.offset;
  api.rpc=async(name,p={})=>{
   if(name==='status')return {participant:{status:'approved'}};
   if(name==='progress')return {tasks:[],ratings:[]};
   if(name==='finish'){fixture.legacyFinishes++;return {status:'open',received:0};}
   if(name!=='kol')throw Error('unexpected fixture RPC '+name);
   const action=p.p_action,v=p.p_payload;fixture.requests.push({action,payload:v});
   const xhs=fixture.platform==='xiaohongshu',tid=xhs?'target-xhs':'target-bili';
   if(action==='list')return {targets:[],tasks:[],contents:[],capabilities:{platforms:['xiaohongshu','bilibili'],max_items:10,max_comments:20}};
   if(action==='upsert')return {target:{id:tid,platform:fixture.platform,target_id:xhs?'d'.repeat(24):'123'}};
   if(action==='start')return {};
   if(action==='session_changed'){fixture.principal_ref=v.principal_ref;return {credential_epoch:2};}
   if(action==='claim')return {task:fixture.finish?null:{id:'task-'+fixture.platform,target_ref:tid,platform:fixture.platform,target_kind:'creator',target_id:xhs?'d'.repeat(24):'123',url:xhs?'https://www.xiaohongshu.com/user/profile/'+'d'.repeat(24):'https://space.bilibili.com/123',max_items:2,known_ids:[],refresh_ids:[],lease_token:'lease-'+fixture.platform,credential_epoch:2,principal_ref:fixture.principal_ref,principal_verification:'rendered_account_navigation',execution_protocol:1,executor_id:v.executor_id,checkpoint:{revision:0,candidate_ids:[],processed_ids:[],scrolls:0},comment_limit:0,include_replies:false,window_days:30}};
   if(action==='checkpoint')return {checkpoint:{revision:v.expected_revision+1}};
   if(action==='action_settle')return {settled:true};
   if(action==='guard'){fixture.guards.push(v.action);if(v.action==='detail'&&fixture.guards.filter(x=>x==='detail').length>2)throw Error('detail_budget_exceeded');return {allowed:true,reason:null,wait_ms:0,version:1,paused:false,ttl_ms:600000,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},admission_id:'grant-'+fixture.guards.length};}
   if(action==='profile'||action==='submit'){
    let r=fixture.receipts[v.request];if(!r){r={gate:'received',request:v.request,task:v.task,source_kind:'rendered_public_dom',reward_eligible:false,...(action==='profile'?{kind:'profile'}:{content_id:v.record.standard.note_id})};fixture.receipts[v.request]=r;(action==='profile'?fixture.profiles:fixture.received).push(v);}
    if(action==='submit'&&!fixture.lost){fixture.lost=true;throw Error('ack_lost');}return r;
   }
   if(action==='finish'){fixture.finish++;return {};}
   throw Error('unexpected kol action '+action);
  };
 });
 for(const platform of ['xiaohongshu','bilibili']){
  await worker.evaluate(async platform=>{await kol.stop();await storage.set('kol:kol-fixture',CrowdKOL.initial());Object.assign(fixture,{platform,received:[],profiles:[],guards:[],requests:[],finish:0,lost:false,receipts:{}});},platform);
  const panel=await browser.newPage();await panel.goto('chrome-extension://licijehcpohikchlnkbpjdjdfkcocndg/src/controller.html');
  const command=message=>panel.evaluate(message=>chrome.runtime.sendMessage(message),message);
  const original=platform==='xiaohongshu'?'https://www.xiaohongshu.com/user/profile/'+creator+'?xsec_token=LOCAL_LOCATOR_ONLY':'https://space.bilibili.com/123';
  assert.equal((await command({type:'kol_open_session',platform})).ok,true);
  let verified;for(let retry=0;retry<30;retry++){verified=await command({type:'kol_session_changed',platform});if(verified.ok)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(verified.ok,true,JSON.stringify(verified));
  await worker.evaluate(async()=>{const s=await agent.read();s.task={id:7,lease_token:'legacy-lease'};s.consent=CrowdCore.CONSENT;await agent.save(s);});
  assert.equal((await command({type:'kol_upsert',payload:{url:original}})).ok,true);assert.equal((await command({type:'kol_start'})).ok,true);
  assert.equal(await worker.evaluate(async()=>!(await agent.read()).task),true,'old lease released before KOL');
  await ordinary.bringToFront();const active=await worker.evaluate(async()=>(await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0].id);
  const phases=[];
  for(let i=0;i<45;i++){
   const s=await worker.evaluate(async()=>{await kol.active;const old=await kol.read();fixture.offset+=Math.max(31000,(old.next_at||0)-kol.r.now()+1,(old.outbox[0]?.retry_at||0)-kol.r.now()+1);await kol.tick();const state=await kol.read();return {phase:state.phase,error:state.last_error,received:fixture.received.length,profiles:fixture.profiles.length,finish:fixture.finish,task:!!state.task,active:(await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0]?.id};});
   phases.push(s);assert.equal(s.active,active);assert.ok(!s.error||s.error==='ack_lost',JSON.stringify(s));if(s.finish&&!s.task)break;await new Promise(r=>setTimeout(r,180));
  }
  const done=await worker.evaluate(async()=>({received:fixture.received.length,profiles:fixture.profiles.length,finish:fixture.finish,guards:fixture.guards,requests:fixture.requests,workTab:await storage.get('work_tab'),outbox:(await kol.read()).outbox.length}));
  assert.equal(done.received,2);assert.equal(done.profiles,1);assert.equal(done.finish,1);assert.equal(done.outbox,0);assert.equal(done.workTab,null);assert.equal(done.guards.filter(x=>x==='detail').length,2);
  assert.equal(JSON.stringify(done.requests).includes('LOCAL_'),false,'navigation tokens never leave in RPC');
  assert.equal(await worker.evaluate(async platform=>{await verifyKOLPrincipal({platform,principal_ref:fixture.principal_ref});return true;},platform),true,'bound identity stays usable after work tab closes');
  const submits=done.requests.filter(x=>x.action==='submit');assert.equal(submits.length,3);assert.equal(submits[0].payload.request,submits[1].payload.request);
  if(process.env.CROWD_TEST_HEALTH==='1'){
   const sessionTab=await worker.evaluate(async platform=>await storage.get('kol-session-tab:kol-fixture:'+platform),platform),sessionTarget=await browser.waitForTarget(async target=>target.type()==='page'&&target.url()===(platform==='xiaohongshu'?'https://www.xiaohongshu.com/':'https://www.bilibili.com/'));
   const sessionPage=await sessionTarget.page();
   const healthBefore=await worker.evaluate(async platform=>{await monitorPlatformHealth(true);const s=await kol.read();s.enabled=true;s.delivery_enabled=true;s.phase='open';s.task={id:'health-task',platform,principal_ref:fixture.principal_ref,target_kind:'content',target_id:'a'.repeat(24),url:'https://www.xiaohongshu.com/explore/'+'a'.repeat(24)};s.checkpoint_revision=7;s.candidates=[{id:'a'.repeat(24),url:s.task.url}];s.outbox=[{...fixture.received[0],delivery_attempts:0}];await kol.save(s,'kol-fixture');return {requests:fixture.requests.length,source:fixture.guards.length};},platform);
   await sessionPage.evaluate(platform=>{document.querySelector(platform==='xiaohongshu'?'nav':'.bili-header')?.remove();document.body.insertAdjacentHTML('afterbegin',platform==='xiaohongshu'?'<nav><button>登录</button></nav>':'<header class="bili-header"><div class="header-login-entry">登录</div></header>');},platform);
   const paused=await worker.evaluate(async()=>{await monitorPlatformHealth(true);const s=await kol.read();return {enabled:s.enabled,outbox:s.outbox.length,phase:s.phase,error:s.last_error,badge:await chrome.action.getBadgeText({}),guards:fixture.guards.length};});
   assert.equal(paused.enabled,false);assert.equal(paused.outbox,1);assert.equal(paused.error,'login_required');assert.equal(paused.badge,'登录');assert.equal(paused.guards,healthBefore.source);
   await worker.evaluate(async()=>{fixture.offset+=61000;await kol.tick();});assert.equal(await worker.evaluate(async()=>(await kol.read()).outbox.length),0,'platform logout does not stop lawful evidence delivery');
   await sessionPage.reload();await sessionPage.waitForSelector(platform==='xiaohongshu'?'nav a':'.header-avatar-wrap');
   const restored=await worker.evaluate(async platform=>{await monitorPlatformHealth(true);const s=await kol.read();return {health:(await platformHealth.publicState())[platform],enabled:s.enabled};},platform);
   assert.equal(restored.health.status,'authenticated');assert.equal(restored.health.recovered,true);assert.equal(restored.enabled,false,'same account recovery never silently starts');
   const rebound=await command({type:'kol_session_changed',platform});assert.equal(rebound.ok,true);assert.equal(rebound.data.same_platform_account,true);
   assert.equal(await worker.evaluate(async()=>{const s=await kol.read();return s.task?.id==='health-task'&&s.checkpoint_revision===7&&s.candidates.length===1&&!s.enabled;}),true,'same account explicit check retains task and checkpoint');
   await command({type:'kol_stop'});await worker.evaluate(async()=>monitorPlatformHealth(true));assert.equal(await worker.evaluate(async()=>(await kol.read()).enabled),false,'manual stop survives healthy observation');
   await sessionPage.evaluate(platform=>{document.querySelector(platform==='xiaohongshu'?'nav a':'.header-avatar-wrap').href=platform==='xiaohongshu'?'https://www.xiaohongshu.com/user/profile/'+'f'.repeat(24):'https://space.bilibili.com/888';},platform);
   const changed=await worker.evaluate(async platform=>{await monitorPlatformHealth(true);let reason;try{await platformHealth.require(platform);}catch(e){reason=e.message;}return {health:(await platformHealth.publicState())[platform],reason};},platform);
   assert.equal(changed.health.status,'account_changed');assert.equal(changed.reason,'platform_identity_changed');
   await sessionPage.reload();await sessionPage.waitForSelector(platform==='xiaohongshu'?'nav a':'.header-avatar-wrap');await worker.evaluate(async()=>monitorPlatformHealth(true));
   assert.equal((await worker.evaluate(async()=>(await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0].id)),active,'health monitoring keeps user foreground');
   await sessionPage.close();const ordinaryLogin=await browser.newPage();await ordinaryLogin.goto(platform==='xiaohongshu'?'https://www.xiaohongshu.com/':'https://www.bilibili.com/');await ordinaryLogin.waitForSelector(platform==='xiaohongshu'?'nav a':'.header-avatar-wrap');await ordinary.bringToFront();
   assert.equal(await worker.evaluate(async platform=>{await monitorPlatformHealth(true);await verifyKOLPrincipal({platform,principal_ref:fixture.principal_ref});return true;},platform),true,'same-account login in another existing tab supports principal verification');
   assert.equal(await worker.evaluate(async platform=>{try{await verifyKOLPrincipal({platform,principal_ref:'0'.repeat(64)});}catch(e){return e.message;}return null;},platform),'platform_identity_changed','ordinary-page fallback never accepts a different bound principal');
   const ordinaryRebind=await command({type:'kol_session_changed',platform});assert.equal(ordinaryRebind.ok,true);assert.equal(ordinaryRebind.data.same_platform_account,true);await ordinaryLogin.close();
   result.runs.push({platform,health:'PASS',logout_badge:paused.badge,delivery_preserved:true,same_account_checkpoint_retained:true,manual_stop_stays_stopped:true,account_change_blocked:true,ordinary_login_tab_verified:true});
  }
  result.runs.push({platform,received:done.received,profiles:done.profiles,finish:done.finish,outbox:done.outbox,workTab:done.workTab,detail_attempts:2,phases});await panel.close();
 }
 assert.equal(await worker.evaluate(()=>fixture.legacyFinishes),2);
 assert.ok(result.requests.some(r=>r.has_local_locator),'XHS owner-scoped locator used on actual navigation');assert.equal(await ordinary.title(),'User work');result.result='PASS';
}catch(e){result.result='FAIL';result.error=e.stack;process.exitCode=1;}finally{if(browser)await browser.close();proxy?.close();site?.close();if(process.env.CROWD_TEST_RESULT)fs.writeFileSync(process.env.CROWD_TEST_RESULT,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}})();
