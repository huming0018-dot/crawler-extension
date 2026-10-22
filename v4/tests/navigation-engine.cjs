'use strict';
// Installed-extension regression; held document response, no platform traffic.
// Requires a built extension and existing Puppeteer/Chrome for Testing tooling.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const puppeteer=require(process.env.CROWD_PUPPETEER_MODULE);
const extension=path.resolve(process.env.CROWD_TEST_EXTENSION);
const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json')));
const result={version:manifest.version,started_at:new Date().toISOString(),scope:'Real extension engine, intercepted document, seeded expired deadline, no production identity'};
let browser;
(async()=>{try{
 browser=await puppeteer.launch({executablePath:process.env.CROWD_CHROME_BIN,headless:false,pipe:true,protocolTimeout:15000,userDataDir:fs.mkdtempSync(path.join(os.tmpdir(),'crowd-navigation-engine-')),ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 await browser.newPage();
 const w=await(await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith(manifest.background.service_worker))).worker();
 const known=new Set(browser.targets());
 const id=await w.evaluate(async()=>{const [win]=await chrome.windows.getAll({windowTypes:['normal']});const tab=await chrome.tabs.create({url:'about:blank',windowId:win.id,active:false});await storage.set('work_tab',tab.id);return tab.id;});
 const page=await(await browser.waitForTarget(t=>t.type()==='page'&&!known.has(t))).page();
 await page.setRequestInterception(true);let held;const requested=new Promise(resolve=>page.on('request',q=>{if(q.isNavigationRequest()){held=q;resolve();}else q.abort().catch(()=>{});}));
 await w.evaluate(id=>chrome.tabs.update(id,{url:'https://www.xiaohongshu.com/search_result?keyword=test',active:false}),id);await requested;
 result.before=await w.evaluate(async()=>({probe:await runtime.probe('search'),frame:typeof navigationDocument==='function'?await navigationDocument(await storage.get('work_tab'),await chrome.tabs.get(await storage.get('work_tab'))):null}));
 result.documentUrl=page.url();
 await w.evaluate(async()=>{const now=Date.now();await agent.save({...CrowdCore.initial(),enabled:true,consent:CrowdCore.CONSENT,phase:'search',last_tick:now-121000,page_deadline:now-1,
  control:{version:1,paused:false,allowed:true,reason:null,wait_ms:0},control_checked:now,control_expires:now+600000,
  task:{id:1,query:'test',lease_until:new Date(now+1200000).toISOString(),received:0,target:2},rejected:[{request:'original-proof',reason:'unrelated_note'}]});globalThis.reopens=0;globalThis.searchAdmissions=0;runtime.open=async()=>{reopens++;throw Error('unexpected_reopen');};api.rpc=async(name,p)=>{if(name==='guard'&&p.p_action==='search')searchAdmissions++;throw Error('unexpected_backend_call');};await agent.tick(true);});
 result.after=await w.evaluate(async()=>{const s=await agent.read();return {reopens,searchAdmissions,enabled:s.enabled,error:s.last_error,phase:s.phase,retained:s.rejected[0]?.request,alarm:!!await chrome.alarms.get('crowd_tick'),tab:await storage.get('work_tab')};});
 assert.equal(result.documentUrl,'about:blank');assert.ok(['navigation_uncommitted','page_loading'].includes(result.before.probe.reason));assert.ok(['blank','unavailable'].includes(result.before.frame.document_kind));assert.equal(result.before.frame.pending_kind,'platform');
 assert.equal(result.after.enabled,false);assert.equal(result.after.error,result.before.probe.reason);assert.equal(result.after.reopens,0);assert.equal(result.after.searchAdmissions,0);assert.equal(result.after.retained,'original-proof');assert.equal(result.after.alarm,false);assert.equal(result.after.tab,id);
 await held.respond({status:200,contentType:'text/html',body:'<html><body><a href="/explore/abcdef0123456789abcdef01">test</a></body></html>'});await page.waitForSelector('a');
 result.released=await w.evaluate(async()=>({probe:await runtime.probe('search'),enabled:(await agent.read()).enabled}));assert.equal(result.released.probe.ready,true);assert.equal(result.released.enabled,false,'late document must not auto-resume');
 result.result='PASS';
}catch(e){result.result='FAIL';result.error=e.message;process.exitCode=1;}finally{if(browser)await browser.close();result.finished_at=new Date().toISOString();if(process.env.CROWD_TEST_RESULT)fs.writeFileSync(process.env.CROWD_TEST_RESULT,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}})();
