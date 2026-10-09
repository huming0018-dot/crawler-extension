import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.CROWD_TEST_TOOLS+'/node_modules/playwright/index.mjs'));
const browser=await chromium.launch({executablePath:process.env.CROWD_CHROMIUM,headless:true});
try{
 const page=await browser.newPage({viewport:{width:1050,height:900}});const failures=[];page.on('pageerror',e=>failures.push(e.message));
 await page.route('https://crowd-fixture.test/**',r=>{const p=new URL(r.request().url()).pathname;const file=path.resolve('v4',p.slice(1));if(!file.startsWith(path.resolve('v4')+path.sep))return r.abort();r.fulfill({body:fs.readFileSync(file),contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'text/html'});});
 await page.addInitScript(()=>{
   const calls=[];globalThis.testCalls=calls;const targets=[];
   globalThis.chrome={runtime:{sendMessage:async m=>{
    calls.push(m);
    if(m.type==='state')return {ok:true,data:{session:true,agent:{enabled:false,outbox:[],rejected:[],phase:'idle'},status:{participant:{status:'approved'}},updater:{enabled:true,state:'ready'},diagnostics:{}}};
    if(m.type==='kol_state')return {ok:true,data:{local:{enabled:false,phase:'idle',outbox:2,rejected:1},remote:{targets,tasks:[{id:'recover-task',released_at:'2026-10-09T00:00:00Z',state:'running'}],contents:[{platform:'bilibili',content_id:'BV1xx411c7mD',url:'https://www.bilibili.com/video/BV1xx411c7mD',title:'<img src=x onerror=alert(1)>',body:'测试原文 undefined new Set([])',metrics:{like_count:null},version:1}],capabilities:{include_replies:true}}}};
    if(m.type==='kol_upsert'){targets.push({id:'fixture-target',target_id:'123',target_kind:'creator',url:'https://space.bilibili.com/123',label:m.payload.label,group:m.payload.group,platform:'bilibili',status:'active'});return {ok:true,data:{target:targets.at(-1)}};}
    if(m.type==='kol_rpc')return {ok:true,data:{versions:[{version:1,record:{extra:{media_refs:[{url:'https://i0.hdslb.com/public.jpg',kind:'image'},{url:'https://i0.hdslb.com/signed.jpg?token=fixture',kind:'image'}]}}}],snapshots:[],comments:[]}};
    return {ok:true,data:{}};
   }}};
 });
 await page.goto('https://crowd-fixture.test/src/controller.html');await page.locator('#kol_contents article').waitFor();
 assert.equal(await page.locator('#kol_contents img').count(),0,'source text never becomes HTML');
 assert.ok((await page.locator('#kol_status').innerText()).includes('2'),'numeric pending count visible');
 await page.locator('#kol_url').fill('https://space.bilibili.com/123');await page.locator('#kol_label').fill('测试作者');await page.locator('#kol_group').fill('研究');await page.locator('#kol_add button').click();await page.locator('#kol_targets article').waitFor();
 await page.locator('#kol_targets button').filter({hasText:'按当前设置采集'}).click();
 const start=await page.evaluate(()=>testCalls.find(x=>x.type==='kol_start'));assert.equal(start.payload.max_items,2);assert.equal(start.payload.comment_limit,0);assert.equal(start.payload.target_id,'fixture-target');
 await page.locator('#kol_section details summary').filter({hasText:'批量导入'}).click();
 await page.locator('#kol_csv').setInputFiles({name:'watchlist.csv',mimeType:'text/csv',buffer:Buffer.from('platform,profile_url,display_name,group\nbilibili,https://space.bilibili.com/456,"作者,乙",组A\nbilibili,https://space.bilibili.com/456,重复,组A\n')});
 await page.waitForFunction(()=>document.querySelector('#kol_preview').textContent.includes('重复'));
 assert.equal(await page.locator('#kol_preview p').count(),2);
 await page.locator('#kol_import').click();const calls=await page.evaluate(()=>testCalls);assert.equal(calls.filter(x=>x.type==='kol_upsert').length,2,'only valid preview rows submitted');
 await page.getByRole('button',{name:'停止并安全释放给另一设备',exact:true}).click();await page.locator('#kol_tasks').locator('xpath=ancestor::details[1]').locator('summary').first().click();await page.getByRole('button',{name:'从检查点恢复到本设备',exact:true}).click();await page.getByRole('button',{name:'重试待回传（最多3次）',exact:true}).click();
 const recoveryCalls=await page.evaluate(()=>testCalls);assert.ok(recoveryCalls.some(x=>x.type==='kol_release'));assert.ok(recoveryCalls.some(x=>x.type==='kol_recover'&&x.task==='recover-task'));assert.ok(recoveryCalls.some(x=>x.type==='kol_retry_delivery'));
 page.on('dialog',dialog=>dialog.accept(dialog.type()==='prompt'?'fixture-authorization':undefined));
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出授权媒体任务',exact:true}).click();const download=await downloadPromise;const manifest=JSON.parse(fs.readFileSync(await download.path(),'utf8'));assert.equal(manifest.authorization_ref,'fixture-authorization');assert.equal(manifest.assets.length,1);assert.equal(manifest.assets[0].url,'https://i0.hdslb.com/public.jpg');
 assert.deepEqual(failures,[]);
 if(process.env.CROWD_UI_SCREENSHOT)await page.locator('#kol_section').screenshot({path:process.env.CROWD_UI_SCREENSHOT});
 console.log('PASS controller in Chromium: save/start, 2-attempt config, CSV duplicate preview/import, numeric queues, source HTML inert');
}finally{await browser.close();}
