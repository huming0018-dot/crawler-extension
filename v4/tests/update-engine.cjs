'use strict';
// Real native messaging in isolated Chrome user-data dir; no participant profile.
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const puppeteer=require(process.env.CROWD_PUPPETEER_MODULE);
const root=path.resolve(process.env.CROWD_UPDATE_FIXTURE),fixture=JSON.parse(fs.readFileSync(path.join(root,'fixture.json'))),profile=path.join(root,'browser-profile');
const manifest=JSON.parse(fs.readFileSync(path.join(fixture.directory,'manifest.json'))),host='com.crowd.v4.updater';
fs.mkdirSync(path.join(profile,'NativeMessagingHosts'),{recursive:true});fs.writeFileSync(path.join(profile,'NativeMessagingHosts',host+'.json'),JSON.stringify({name:host,description:'isolated updater test',path:path.join(fixture.helper,'crowd-v4-updater'),type:'stdio',allowed_origins:['chrome-extension://licijehcpohikchlnkbpjdjdfkcocndg/']}));
let browser;const result={scope:'Real installed extension and native host; synthetic local identity/evidence; signed fixture channel',started_at:new Date().toISOString()};
(async()=>{try{
 browser=await puppeteer.launch({executablePath:process.env.CROWD_CHROME_BIN,headless:false,pipe:true,userDataDir:profile,protocolTimeout:15000,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${fixture.directory}`,`--load-extension=${fixture.directory}`,'--host-resolver-rules=MAP *.supabase.co ~NOTFOUND']});
 const developerPage=await browser.newPage();await developerPage.goto('chrome://extensions/');
 result.developerMode=await developerPage.evaluate(()=>{const manager=document.querySelector('extensions-manager');const toolbar=manager.shadowRoot.querySelector('extensions-toolbar');const toggle=toolbar.shadowRoot.querySelector('cr-toggle');if(!toggle.checked)toggle.click();return toggle.checked;});assert.equal(result.developerMode,true);await developerPage.close();
 const pid=browser.process().pid,tab=await browser.newPage();await tab.goto('data:text/html,<title>Preserve this tab</title>browser stays open');
 const worker=await(await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith(manifest.background.service_worker))).worker();
 result.native=await worker.evaluate(()=>chrome.runtime.sendNativeMessage('com.crowd.v4.updater',{action:'status',version:CrowdCore.VERSION}));assert.ok(['ready','rolled_back'].includes(result.native.status));
 await worker.evaluate(async()=>{await chrome.alarms.clear('crowd_update');await chrome.storage.local.set({session:{user:{id:'fixture-participant'}},pending_invite:'fixture-kept','agent:fixture-participant':{...CrowdCore.initial(),enabled:false,consent:CrowdCore.CONSENT,outbox:[{request:'original-evidence',record:{unchanged:true}}],rejected:[{request:'old-rejection',reason:'unrelated_note'}],next_at:Date.now()+600000}});});
 const saved=await worker.evaluate(()=>chrome.storage.local.get(['session','pending_invite','agent:fixture-participant']));
 await worker.evaluate(()=>updater.check()).catch(e=>{if(!/Target closed|context|Session closed|Protocol error/i.test(e.message))throw e;});
 const until=Date.now()+25000;let next;
 while(Date.now()<until){const target=browser.targets().find(t=>t.type()==='service_worker'&&t.url().endsWith('background_v4_2_1.js'));if(target){try{next=await target.worker();if(await next.evaluate(()=>CrowdCore.VERSION)==='4.2.1')break;}catch{}}await new Promise(r=>setTimeout(r,200));}
 assert.ok(next,'new worker did not load');
 const stateFile=path.join(fixture.helper,'state.json');
 while(Date.now()<until && JSON.parse(fs.readFileSync(stateFile)).loaded_version!=='4.2.1')await new Promise(r=>setTimeout(r,200));
 result.nativeState=JSON.parse(fs.readFileSync(stateFile));assert.equal(result.nativeState.loaded_version,'4.2.1');assert.equal(result.nativeState.status,'applied');
 const after=await next.evaluate(()=>chrome.storage.local.get(['session','pending_invite','agent:fixture-participant']));assert.deepEqual(after,saved,'identity and evidence must survive byte-for-byte');assert.equal(browser.process().pid,pid);assert.equal(await tab.title(),'Preserve this tab');
 result.loadedVersion=await next.evaluate(()=>CrowdCore.VERSION);
 const cp=require('child_process'),broken=path.join(root,'broken.zip');
 cp.execFileSync('python3',['-c',`import json,zipfile,hashlib,sys
with zipfile.ZipFile(sys.argv[1]) as z:files={n:z.read(n) for n in z.namelist()}
m=json.loads(files['manifest.json']);old=m['background']['service_worker'];new=old.replace('4_2_1','4_2_2');m['version']='4.2.2';m['background']['service_worker']=new;files['manifest.json']=json.dumps(m).encode();files[new]=files.pop(old).replace(b'4.2.1',b'4.2.2');files['src/background.js']=b'this is deliberately invalid javascript {'
r=json.loads(files.pop('release.json'));r['version']='4.2.2';r['worker']=new;r['files']={n:hashlib.sha256(b).hexdigest() for n,b in files.items()};files['release.json']=json.dumps(r).encode()
with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:
 for n,b in files.items():
  i=zipfile.ZipInfo(n);i.create_system=3;i.external_attr=0o100644<<16;i.compress_type=zipfile.ZIP_DEFLATED;z.writestr(i,b)
`,fixture.new,broken]);
 cp.execFileSync(process.execPath,['v4/updater/publish.cjs',fixture.private_key,broken,require('url').pathToFileURL(broken).href,'5',fixture.channel]);
 await next.evaluate(()=>updater.check()).catch(()=>{});
 const rollbackUntil=Date.now()+20000;let rollbackWorker;
 while(Date.now()<rollbackUntil){const state=JSON.parse(fs.readFileSync(stateFile));if(state.status==='rolled_back'&&state.failed_sequence===5){for(const t of browser.targets().filter(t=>t.type()==='service_worker'&&t.url().endsWith('background_v4_2_1.js'))){try{const w=await t.worker();if(await w.evaluate(()=>CrowdCore.VERSION)==='4.2.1')rollbackWorker=w;}catch{}}if(rollbackWorker)break;}await new Promise(r=>setTimeout(r,200));}
 assert.ok(rollbackWorker,'broken release did not roll back and reload old worker');
 assert.deepEqual(await rollbackWorker.evaluate(()=>chrome.storage.local.get(['session','pending_invite','agent:fixture-participant'])),saved);
 assert.equal(browser.process().pid,pid);assert.equal(await tab.title(),'Preserve this tab');
 result.brokenReleaseRolledBack=true;result.identityPreserved=true;result.evidencePreserved=true;result.browserNotRestarted=true;result.result='PASS';
}catch(e){if(browser){result.targets=browser.targets().map(t=>({type:t.type(),url:t.url()}));try{const p=await browser.newPage();await p.goto('chrome://extensions/');result.extensionErrors=await p.evaluate(()=>new Promise(resolve=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},items=>resolve(items.filter(i=>i.id==='licijehcpohikchlnkbpjdjdfkcocndg').map(i=>({state:i.state,runtimeErrors:i.runtimeErrors,manifestErrors:i.manifestErrors}))))));}catch{}}result.result='FAIL';result.error=e.message;process.exitCode=1;}finally{if(browser)await browser.close();result.finished_at=new Date().toISOString();fs.writeFileSync(path.join(root,'browser-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}})();
