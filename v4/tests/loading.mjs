// Real Chromium document lifecycle with the manifest injection phase modeled.
// This is not an installed-extension or real-platform acceptance test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const tools=process.env.CROWD_TEST_TOOLS;
const {chromium}=await import(pathToFileURL(tools+'/node_modules/playwright/index.mjs'));
const executable=process.env.CROWD_CHROMIUM || await (await import(pathToFileURL(tools+'/node_modules/@sparticuz/chromium/build/index.js'))).default.executablePath();
const browser=await chromium.launch({executablePath:executable,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const root=path.resolve('v4'), manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
const source=manifest.content_scripts[0].js.map(file=>fs.readFileSync(path.join(root,file),'utf8')).join('\n');
const id='abcdef0123456789abcdef01';
try {
 const page=await browser.newPage();let release;
 const held=new Promise(resolve=>release=resolve);
 await page.addInitScript(({source,phase})=>{
   const listeners=[];globalThis.readySignals=0;
   globalThis.chrome={runtime:{id:'fixture',onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:async()=>{readySignals++;}}};
   globalThis.fixtureProbe=action=>{let reply=null;for(const fn of listeners)fn({type:'crowd_probe',action},{id:'fixture'},v=>reply=v);return reply;};
   const inject=()=>{(0,eval)(source);};
   if(phase==='document_start')inject();
   else document.addEventListener('DOMContentLoaded',inject,{once:true});
 },{source,phase:manifest.content_scripts[0].run_at});
 await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.hostname==='fixture-script.test'){await held;return route.fulfill({contentType:'application/javascript',body:'void 0;'});}
   if(url.hostname!=='www.xiaohongshu.com')return route.abort();
   await route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><body><a href="/explore/${id}">测试餐厅</a><script src="https://fixture-script.test/parser.js"></script></body></html>`});
 });
 try {
   await page.goto('https://www.xiaohongshu.com/search_result?keyword=测试餐厅',{waitUntil:'commit'});
   await page.locator('a').waitFor({state:'visible'});
   assert.equal(await page.evaluate(()=>document.readyState),'loading','fixture blocks parsing after useful public DOM is rendered');
   const probe=await page.evaluate(()=>fixtureProbe('search'));
   assert.ok(probe?.ready,'rendered search must be reachable before DOMContentLoaded; document_end leaves no receiver');
   assert.equal(probe.links.length,1);
   const diag=await page.evaluate(()=>fixtureProbe('diagnostics'));
   assert.equal(diag.page.document,'loading');assert.equal(diag.page.links,1);
   await page.locator('body').evaluate(el=>el.insertAdjacentHTML('beforeend','<div class="captcha">验证</div>'));
   assert.equal((await page.evaluate(()=>fixtureProbe('search'))).gate,'captcha','early bridge must still stop at a visible gate');
   await page.locator('.captcha').evaluate(el=>el.remove());
   release();await page.waitForLoadState('domcontentloaded');
   assert.equal(await page.evaluate(()=>readySignals),2,'notify initial bridge and parsed document once each');
   console.log('PASS Chromium parser-blocked document: early receiver reads visible search, reports loading and respects gates without reloading');
 } finally {release();await page.close();}
} finally {await browser.close();}
