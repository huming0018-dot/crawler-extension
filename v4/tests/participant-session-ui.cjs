'use strict';
const {chromium}=require(process.env.CROWD_PLAYWRIGHT||'/Users/hubowen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const executablePath=process.env.CROWD_CHROME||'/Users/hubowen/.cache/puppeteer/chrome/mac_arm-154.0.8037.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
(async()=>{const browser=await chromium.launch({executablePath,headless:true});try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.calls=[];window.state={consent_scope:'signed-out',session:false,invited:true,agent:{enabled:false,phase:'idle',outbox:[],rejected:[],profiles:false},status:{},updater:{},diagnostics:{},local_test_updates:{},risk_confirmation:{}};
  window.chrome={runtime:{sendMessage:async message=>{calls.push(message);if(message.type==='state')return {ok:true,data:structuredClone(state)};if(message.type==='join'){state.session=true;state.consent_scope='owner-a';state.agent.consent='crowd-public-v4';}return {ok:true,data:{}};}}};
 });
 await page.goto('file://'+path.resolve('v4/src/participant-controller.html'));await page.waitForFunction(()=>window.calls?.some(c=>c.type==='state'));
 assert.equal(await page.locator('#agree').isChecked(),false,'fresh install never defaults consent');await page.locator('#agree').check();await page.evaluate(async()=>{await refresh();await refresh();});assert.equal(await page.locator('#agree').isChecked(),true,'two polls preserve unsubmitted checkbox');await page.locator('#consent').click();await page.waitForFunction(()=>state.session);assert.equal((await page.evaluate(()=>calls.filter(c=>c.type==='join').length)),1);assert.equal(await page.locator('#consent_section').isVisible(),false);
 await page.evaluate(async()=>{state.consent_scope='owner-b';state.agent.consent=null;await refresh();});assert.equal(await page.locator('#agree').isChecked(),false,'identity switch clears unsubmitted approval');await page.locator('#agree').check();await page.evaluate(async()=>{state.consent_scope='signed-out';state.session=false;await refresh();});assert.equal(await page.locator('#agree').isChecked(),false,'logout clears checkbox');
 for(const [platform,enabled,pattern]of [[{pending:true,desired_running:true,reason:'session_rest',wait_until:Date.now()+120000},false,/原任务保留.*自动重新核验/],[{pending:true,desired_running:true,reason:'login_required'},false,/原账号.*自动继续/],[{pending:true,desired_running:true,reason:'platform_identity_changed'},false,/不同.*切回原账号/],[{initial_confirmed_at:1},true,/首次登录已确认/],[{recovered_at:1},true,/原账号登录已恢复/]]){await page.evaluate(async({platform,enabled})=>{state.platform_session=platform;state.session=true;state.agent.enabled=enabled;await refresh();},{platform,enabled});assert.match(await page.locator('#welcome').textContent(),pattern);}
 for(const [status,platform_reason,pattern]of [['logged_out','login_required',/已退出登录/],['challenge','captcha',/本人完成验证/],['account_changed','platform_identity_changed',/账号已改变/]]){
  await page.evaluate(async({status,platform_reason})=>{Object.assign(state.agent,{enabled:true,pilot_waiting:true,pilot_phase:'awaiting_acceptance',last_error:'test_completed'});state.platform_session={status,platform_reason,pending:false,desired_running:true};await refresh();},{status,platform_reason});
  assert.match(await page.locator('#welcome').textContent(),/两条验收已回传/);assert.match(await page.locator('#welcome').textContent(),pattern);assert.match(await page.locator('#status').textContent(),pattern);
 }
 assert.deepEqual(errors,[]);await page.close();
 // Isolated browser fixture: all navigation intercepted; no platform request is sent.
 const dom=await browser.newPage();await dom.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><nav><a href="/user/profile/aaaaaaaaaaaaaaaaaaaaaaaa">我</a></nav>'}));await dom.goto('https://www.xiaohongshu.com/explore');
 await dom.evaluate(()=>{window.receiver=null;window.notifications=[];window.chrome={runtime:{id:'fixture',onMessage:{addListener:f=>window.receiver=f},sendMessage:async m=>notifications.push(m)}};window.CrowdPage={probe:()=>({page:{gate:window.gate||null}})};});
 await dom.addScriptTag({content:fs.readFileSync('v4/src/core.js','utf8')});await dom.addScriptTag({content:fs.readFileSync('v4/src/session-content.js','utf8')});
 const observe=()=>dom.evaluate(()=>new Promise(resolve=>receiver({type:'crowd_session_probe'},{id:'fixture'},resolve)));
 let h=await observe();assert.equal(h.status,'authenticated');assert.equal(h.principal_id,'a'.repeat(24));assert.equal(h.verification,'rendered_account_navigation');
 await dom.evaluate(()=>document.querySelector('nav').innerHTML='<button>登录</button>');assert.equal((await observe()).status,'logged_out');
 await dom.evaluate(()=>{document.querySelector('nav').innerHTML='<a href="/user/profile/bbbbbbbbbbbbbbbbbbbbbbbb">我</a><button>登录</button>';});assert.equal((await observe()).status,'unknown');
 await dom.evaluate(()=>{window.gate='captcha';});assert.equal((await observe()).status,'challenge');await dom.evaluate(()=>{window.gate=null;document.querySelector('nav').innerHTML='<a href="/user/profile/cccccccccccccccccccccccc">不是我的帐号</a>';});assert.equal((await observe()).status,'unknown');
 assert.equal(await dom.evaluate(()=>JSON.stringify(notifications).includes('principal_id')),false,'change notifications contain no principal');await dom.close();
 console.log('PASS isolated actual Chrome UI: two-refresh consent/join; identity/logout resets; initial unchecked; first-login/recovery/changed-account labels; visible DOM principal and logout/challenge ambiguity; no real profile/network');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
