const {chromium}=require('/Users/hubowen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),assert=require('node:assert/strict');
(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crowd-onboard-actual-')),extension=path.join(dir,'extension');fs.mkdirSync(extension);cp.execFileSync('unzip',['-q',process.argv[2],'-d',extension]);const m=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json')));m.permissions=m.permissions.filter(x=>x!=='nativeMessaging');fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify(m));
 const context=await chromium.launchPersistentContext(path.join(dir,'profile'),{executablePath:'/Users/hubowen/.cache/puppeteer/chrome/mac_arm-154.0.8037.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--disable-background-networking'],offline:true});
 try{const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host;const page=await context.newPage();await page.goto(`chrome-extension://${id}/src/controller.html`);await page.waitForFunction(()=>typeof current!=='undefined'&&!!current);const before=await page.evaluate(()=>({session:current.session,invited:current.invited,welcome:document.querySelector('#welcome').textContent,consentVisible:!document.querySelector('#consent_section').hidden}));
 let result;
 if(process.argv[3]==='fixed'){
 assert.equal(before.session,false);assert.equal(before.invited,false);assert.equal(before.consentVisible,false);assert.match(before.welcome,/邀请/);
 const direct=await page.evaluate(()=>chrome.runtime.sendMessage({type:'consent'}));assert.equal(direct.error,'invite_required');const start=await page.evaluate(()=>chrome.runtime.sendMessage({type:'start'}));assert.equal(start.error,'invite_required');
 const cases=[];
 for(const [name,seed,expected] of [
  ['stale-anonymous',{'agent:signed-out':{last_error:'backend_login_required',outbox:[],rejected:[]},pending_invite:'a'.repeat(64)},'invited'],
  ['pre-enroll-secret',{install_secret:'fixture-secret-before-enroll'},'invited'],
  ['original-owner',{'agent:00000000-0000-4000-8000-000000000001':{outbox:[{request:'original-local'}]}},'identity_recovery_required']
 ]){
  await page.evaluate(async seed=>{await chrome.storage.local.set(seed);await refresh();},seed);
  const view=await page.evaluate(()=>({entry:current.entry_state,welcome:document.querySelector('#welcome').textContent,consentVisible:!document.querySelector('#consent_section').hidden,invitationVisible:!document.querySelector('#invitation').hidden}));assert.equal(view.entry,expected);
  if(expected==='invited'){assert.match(view.welcome,/邀请已接续/);assert.equal(view.consentVisible,true);}else{assert.match(view.welcome,/原参与身份/);assert.equal(view.consentVisible,false);assert.equal(view.invitationVisible,false);const r=await page.evaluate(()=>chrome.runtime.sendMessage({type:'join',consent:'crowd-public-v4'}));assert.equal(r.error,'identity_recovery_required');}
  const preserved=await page.evaluate(async keys=>{const v=await chrome.storage.local.get(keys);return v;},Object.keys(seed));assert.deepEqual(preserved,seed);cases.push({name,...view,preserved:true});
 }
 result={before,direct,start,cases};
 }else{await page.locator('#agree').check();await page.locator('#consent').click();await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('中台参与会话需要恢复'));result={before,message:await page.locator('#message').textContent(),fields:await page.locator('#status').textContent()};assert.match(result.fields,/中台账户未登录/);assert.match(result.fields,/参与状态尚未报名/);}
 // The actual packaged worker and controller run unchanged. Only nativeMessaging
 // permission is removed from this isolated copy, preventing access to a real helper.
 const final=await page.evaluate(async()=>{const d=await chrome.storage.local.get(null);return {session:!!d.session,install_secret_present:!!d.install_secret,agentScopes:Object.keys(d).filter(k=>k.startsWith('agent:')).map(k=>k==='agent:signed-out'?'signed-out':'registered'),pending_invite:!!d.pending_invite};});
 result={version:m.version,mode:process.argv[3]||'repro',...result,final,boundary:'isolated real extension Chrome; temp profile; browser offline; nativeMessaging permission removed only in disposable manifest; no actual enrollment or platform access'};fs.writeFileSync(process.argv[4]||process.argv[2]+'.onboard.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await context.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
