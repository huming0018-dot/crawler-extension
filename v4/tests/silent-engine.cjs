'use strict';
// Actual installed extension and browser focus; fixture pages/receipts only.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const puppeteer=require(process.env.CROWD_PUPPETEER_MODULE),extension=path.resolve(process.env.CROWD_TEST_EXTENSION);
const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'))),ids=['a'.repeat(24),'b'.repeat(24)];
let browser,proxy,site;const result={version:manifest.version,scope:'Real Chrome extension, synthetic pages and API receipts, no production identity',started_at:new Date().toISOString(),requests:[]};
(async()=>{try{
 const https=require('node:https'),http=require('node:http'),net=require('node:net'),cp=require('node:child_process');
 const cert=fs.mkdtempSync(path.join(os.tmpdir(),'crowd-fixture-cert-'));
 cp.execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(cert,'key.pem'),'-out',path.join(cert,'cert.pem'),'-days','1','-subj','/CN=www.xiaohongshu.com'],{stdio:'ignore'});
 site=https.createServer({key:fs.readFileSync(path.join(cert,'key.pem')),cert:fs.readFileSync(path.join(cert,'cert.pem'))},(req,res)=>{
  const u=new URL(req.url,'https://www.xiaohongshu.com');result.requests.push({path:u.pathname});
  const body=u.pathname==='/search_result'?'<html><body>'+ids.map(id=>'<section class="note-item"><a class="title" href="https://www.xiaohongshu.com/explore/'+id+'">测试餐厅</a><span class="name">测试作者</span></section>').join('')+'</body></html>':
   '<html><body><section class="note-container"><h1 id="detail-title">测试餐厅清蒸鱼</h1><div id="detail-desc">测试餐厅的清蒸鱼好吃，服务态度很好。此页为隔离测试样本。</div><span class="date">2026-10-09</span></section></body></html>';
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(body);
 });await new Promise(r=>site.listen(0,'127.0.0.1',r));
 proxy=http.createServer((req,res)=>{res.writeHead(403);res.end();});
 proxy.on('connect',(req,socket,head)=>{
  if(req.url!=='www.xiaohongshu.com:443'){socket.destroy();return;}
  const upstream=net.connect(site.address().port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
 });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 browser=await puppeteer.launch({executablePath:process.env.CROWD_CHROME_BIN,headless:false,pipe:true,protocolTimeout:15000,userDataDir:fs.mkdtempSync(path.join(os.tmpdir(),'crowd-silent-')),ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--proxy-server=http://127.0.0.1:${proxy.address().port}`,'--ignore-certificate-errors']});
 const worker=await(await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith(manifest.background.service_worker))).worker();
 const ordinary=await browser.newPage();await ordinary.goto('data:text/html,<title>User work</title>Preserve my work');
 const panel=await browser.newPage();await panel.goto('chrome-extension://licijehcpohikchlnkbpjdjdfkcocndg/src/controller.html');await panel.close();
 await ordinary.bringToFront();
 await worker.evaluate(async()=>{
  await chrome.storage.local.set({session:{user:{id:'silent-fixture'}}});
  globalThis.fixture={received:[],ratings:[],finish:0,offset:0,offline:false};
  runtime.now=()=>Date.now()+fixture.offset;
  api.rpc=async(name,p={})=>{
   const now=runtime.now();
   if(name==='status')return {participant:{status:'approved'},received:fixture.received.length,verified:0,remainder:0,reward_fen:0};
   if(name==='progress')return {tasks:[{id:1,query:'测试餐厅',target:2,received:fixture.received.length,own_received:fixture.received.length}],ratings:[{proof_id:1,subject:'测试餐厅',title:'已收到的笔记',note_id:'a'.repeat(24),score:fixture.ratings[0]?.p_score??null,reason:fixture.ratings[0]?.p_reason??null}]};
   if(name==='guard')return {version:1,ttl_ms:600000,paused:false,allowed:true,reason:null,wait_ms:0,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:0,comment:0,scroll:0}};
   if(name==='claim')return {task:fixture.finish?null:{id:1,query:'测试餐厅',anchor_terms:['测试餐厅'],target:2,received:fixture.received.length,lease_token:'fixture',lease_until:new Date(now+1200000).toISOString()}};
   if(name==='submit'){if(fixture.offline)throw Error('fixture offline');fixture.received.push(p);return {request:p.p_request,inserted:true,duplicate:false,task_received:fixture.received.length,gate:'received'};}
   if(name==='finish'){fixture.finish++;return {status:'complete',received:fixture.received.length};}
   if(name==='rating'){fixture.ratings.push(p);return {request:p.p_request,gate:'rated',inserted:true};}
   throw Error('unexpected fixture call '+name);
  };
  await agent.save({...CrowdCore.initial(),consent:CrowdCore.CONSENT});await agent.start();
 });
 const active=await worker.evaluate(async()=>{const t=(await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0];return t.id;});
 result.phases=[];
 for(let i=0;i<30;i++){
  const state=await worker.evaluate(async()=>{await agent.active;let s=await agent.read();fixture.offset+=Math.max(30000,(s.next_at||0)-runtime.now()+1);s.last_tick=runtime.now();if(s.phase==='note')s.dwell_ms=0;await agent.save(s);await agent.tick();s=await agent.read();return {phase:s.phase,error:s.last_error,received:fixture.received.length,finish:fixture.finish,task:!!s.task,active:(await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0]?.id};});
  state.page=await worker.evaluate(async()=>{const id=await storage.get('work_tab');return id?{probe:await probeTab(id,'diagnostics'),frame:await navigationDocument(id,await chrome.tabs.get(id))}:null;});
  result.phases.push(state);assert.equal(state.active,active,'background collection must not steal the active tab');assert.equal(state.error,null);
  if(state.finish && !state.task)break;
  await new Promise(r=>setTimeout(r,200));
 }
 result.silent=await worker.evaluate(async()=>({received:fixture.received.length,finish:fixture.finish,workTab:await storage.get('work_tab'),outbox:(await agent.read()).outbox.length}));
 assert.equal(result.silent.received,2);assert.equal(result.silent.finish,1);assert.equal(result.silent.workTab,null);assert.equal(result.silent.outbox,0);assert.equal(await ordinary.title(),'User work');
 // The optional original rating is entered through the real controller UI.
 const ui=await browser.newPage();await ui.goto('chrome-extension://licijehcpohikchlnkbpjdjdfkcocndg/src/controller.html');
 await ui.waitForSelector('#ratings_section:not([hidden])');await ui.$eval('#ratings_section',e=>e.open=true);
 await ui.select('#ratings_list select','5');await ui.type('#ratings_list textarea','本人吃过这里的清蒸鱼');await ui.click('#ratings_list button');
 await new Promise(r=>setTimeout(r,300));result.rating=await worker.evaluate(()=>fixture.ratings[0]);assert.equal(result.rating.p_score,5);assert.equal(result.rating.p_reason,'本人吃过这里的清蒸鱼');
 result.result='PASS';
}catch(e){result.result='FAIL';result.error=e.stack;process.exitCode=1;}finally{if(browser)await browser.close();proxy?.close();site?.close();result.finished_at=new Date().toISOString();if(process.env.CROWD_TEST_RESULT)fs.writeFileSync(process.env.CROWD_TEST_RESULT,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}})();
