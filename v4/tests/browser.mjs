import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const tools=process.env.CROWD_TEST_TOOLS;
const {chromium:playwright}=await import(pathToFileURL(tools+'/node_modules/playwright/index.mjs'));
const executable=process.env.CROWD_CHROMIUM || await (await import(pathToFileURL(tools+'/node_modules/@sparticuz/chromium/build/index.js'))).default.executablePath();
const browser=await playwright.launch({executablePath:executable,args:['--no-sandbox','--no-zygote','--disable-dev-shm-usage'],headless:true});
const {PGlite}=createRequire(import.meta.url)(path.join(tools,'node_modules/@electric-sql/pglite'));
const db=new PGlite();
const src=path.resolve('v4/src');
const migrations=process.env.CROWD_MIGRATIONS_DIR;
if(!migrations)throw new Error('Set CROWD_MIGRATIONS_DIR to crowd-kol/server/crowd/v4/supabase/migrations');
const id='abcdef0123456789abcdef01';
let note=`<!doctype html><html><body><section class="note-container"><h1 id="detail-title">测试餐厅清蒸鱼</h1><div id="detail-desc">测试餐厅的清蒸鱼真的好吃，价格合理。\n#清蒸鱼 #上海美食\n排队有些长，但服务很好。</div><span class="date">2026-10-05</span></section><div class="interact-container"><span class="like-wrapper"><span class="count">1.2万</span></span></div></body></html>`;
const discussion=`<div class="comments-container"><div class="parent-comment">
<div class="comment-item" data-comment-id="root-1"><span class="author-wrapper"><span class="name">甲</span></span><div class="content">鱼很好吃</div><span class="like"><span class="count">7</span></span><span class="date">昨天</span>
<div class="comment-item comment-item-sub" data-comment-id="reply-1"><span class="author-wrapper"><span class="name">乙</span></span><div class="content">我也觉得不错</div><span class="like"><span class="count">点赞</span></span></div></div>
<button class="show-more" onclick="this.insertAdjacentHTML('beforebegin','<div class=&quot;comment-item comment-item-sub&quot; data-comment-id=&quot;reply-2&quot;><div class=&quot;content&quot;>刚刚展开的回复正文</div></div>');this.remove()">展开1条回复</button>
</div><div class="parent-comment"><div class="comment-item" data-comment-id="root-2"><div class="content">服务很好</div><span class="like"><span class="count">0</span></span></div></div>
<button onclick="globalThis.forbiddenClick=true">回复</button><button onclick="globalThis.forbiddenClick=true">点赞</button>
<div class="comment-item" style="display:none"><div class="content">不可见评论不采集</div></div></div>`;

note=note.replace('</section>',discussion+'</section>').replace('</body>','<div class="interact-container"><span class="view-wrapper"><span class="count">1.3万次浏览</span></span><span class="chat-wrapper"><span class="count">共5条评论</span></span></div></body>');

try {
 const page=await browser.newPage();
 // Reproduce a rendered page whose image request never completes: readyState
 // stays interactive, but search, diagnostics and CAPTCHA detection must work.
 const loading=await browser.newPage();let releaseImage;
 const heldImage=new Promise(resolve=>releaseImage=resolve);
 await loading.route('https://resources.example.test/slow.png',async route=>{
  await heldImage;await route.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=','base64')});
 });
 await loading.route('https://www.xiaohongshu.com/**',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:`<img src="https://resources.example.test/slow.png"><a href="/explore/${id}">公开笔记</a>`}));
 try {
  await loading.goto('https://www.xiaohongshu.com/search_result?keyword=测试餐厅',{waitUntil:'domcontentloaded'});
  for(const name of ['core','content'])await loading.addScriptTag({content:fs.readFileSync(path.join(src,name+'.js'),'utf8')});
  assert.equal(await loading.evaluate(()=>document.readyState),'interactive');
  assert.equal((await loading.evaluate(()=>CrowdPage.probe('search'))).ready,true);
  const diagnostic=await loading.evaluate(()=>CrowdPage.probe('diagnostics'));
  assert.equal(diagnostic.page.document,'interactive');assert.equal(diagnostic.page.links,1);
  await loading.locator('body').evaluate(el=>el.insertAdjacentHTML('beforeend','<div class="captcha">验证码</div>'));
  assert.equal((await loading.evaluate(()=>CrowdPage.probe('search'))).gate,'captcha');
 } finally {releaseImage();}
 await loading.waitForLoadState('load');await loading.close();
 console.log('PASS Chromium loading regression: hung image does not block rendered search/diagnostics or CAPTCHA pause');
 await page.route('https://*.xiaohongshu.com/**',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:new URL(route.request().url()).pathname==='/search_result'?`<a href="/search_result/${id}?xsec_token=navigation-only">测试餐厅清蒸鱼</a><a href="/search_result/?keyword=其他词">相关搜索</a><a href="https://evil.example.test/search_result/${id}">外站</a>`:note}));
 await page.goto('https://www.xiaohongshu.com/search_result?keyword=测试餐厅');
 async function inject(){for(const name of ['core','content'])await page.addScriptTag({content:fs.readFileSync(path.join(src,name+'.js'),'utf8')});}
 await inject();let search=await page.evaluate(()=>CrowdPage.probe('search'));assert.equal(search.ready,true);assert.equal(search.links.length,1);
 const searchDiag=await page.evaluate(()=>CrowdPage.probe('diagnostics'));
 assert.equal(searchDiag.page.kind,'search');assert.equal(searchDiag.page.links,1);assert.equal(JSON.stringify(searchDiag).includes('navigation-only'),false);
 assert.equal(search.keyword,'测试餐厅');
 await page.locator('body').evaluate((el,id)=>el.innerHTML=`<section class="note-item"><a href="/search_result/${id}?xsec_token=local">当前卡片</a><a href="/search_result/${id}?xsec_token=local">重复封面</a></section><a href="/explore/111111111111111111111111">卡片外推荐</a>`,id);
 const scoped=await page.evaluate(()=>CrowdPage.probe('search'));
 assert.equal(scoped.links.length,2);assert.ok(scoped.links.every(x=>x.includes(id)),'recommendations outside cards must not enter this task');
 await page.goto(search.links[0]);await inject();let result=await page.evaluate(()=>CrowdPage.probe('note'));
 assert.equal(result.ready,true);assert.equal(result.record.standard.note_id,id);assert.equal(result.record.standard.url.includes('xsec_token'),false);
 assert.equal(result.record.standard.like_count,12000);assert.equal(result.record.standard.collect_count,null);assert.equal(result.record.extra.hashtags[0],'清蒸鱼');assert.ok(result.record.extra.author_opinion_quotes.every(q=>result.record.evidence.text.includes(q)));

 assert.equal(result.record.standard.view_count,13000);assert.equal(result.record.standard.comment_count,5);
 assert.equal(result.record.extra.metric_labels.view_count,'1.3万次浏览');
 let cm=result.record.extra.comments;assert.equal(cm.captured_count,3);assert.equal(cm.complete,false);
 assert.equal(cm.items[0].text,'鱼很好吃');assert.equal(cm.items[0].like_count,7);
 assert.equal(cm.items[1].parent_key,cm.items[0].key);assert.equal(cm.items[1].like_count,null);
 assert.equal(cm.items[2].parent_key,null);assert.equal(cm.items[2].like_count,0);assert.equal(cm.items[2].author_display,null);
 await page.evaluate(()=>CrowdPage.probe('comments'));
 const expanded=await page.evaluate(()=>CrowdPage.probe('note'));
 assert.equal(expanded.record.extra.comments.captured_count,4);assert.equal(expanded.record.extra.comments.items[2].text,'刚刚展开的回复正文');
 assert.equal(expanded.record.extra.comments.items[2].parent_key,'comment-1');
 assert.equal(await page.evaluate(()=>globalThis.forbiddenClick),undefined,'never click like or compose reply');
 assert.equal(await page.evaluate(()=>!!CrowdCore.validate(CrowdPage.probe('note').record)),true);
 const limits=await browser.newPage();await limits.route('**/*',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:note}));await limits.goto('https://www.xiaohongshu.com/explore/'+id);
 for(const name of ['core','content'])await limits.addScriptTag({content:fs.readFileSync(path.join(src,name+'.js'),'utf8')});
 await limits.locator('.comments-container').evaluate(el=>{el.innerHTML=Array.from({length:70},(_,i)=>`<div class="comment-item"><div class="content">评论${i}</div></div>`).join('');});
 let limited=await limits.evaluate(()=>CrowdPage.probe('note').record);assert.equal(limited.extra.comments.items.length,50);assert.equal(limited.extra.comments.omitted_count,20);assert.equal(limited.extra.comments.truncated,true);
 await limits.locator('.comments-container').evaluate(el=>{el.style.cssText='height:120px;overflow-y:auto';el.scrollBy=function(options){this.scrollTop+=options.top;};el.scrollIntoView({block:'start'});});
 await limits.evaluate(()=>CrowdPage.probe('comments'));const scroll1=await limits.locator('.comments-container').evaluate(el=>el.scrollTop);
 await limits.evaluate(()=>CrowdPage.probe('comments'));assert.ok(await limits.locator('.comments-container').evaluate(el=>el.scrollTop)>scroll1,'successive rounds advance the comment scroller');
 await limits.locator('.comments-container').evaluate(el=>el.style.cssText='');
 await limits.locator('.comments-container').evaluate(el=>{el.innerHTML='<div class="comment-item"><div class="content">'+ '长'.repeat(3000)+'</div></div>';});
 limited=await limits.evaluate(()=>CrowdPage.probe('note').record);assert.equal(limited.extra.comments.items[0].text.length,2000);assert.equal(limited.extra.comments.items[0].truncated,true);
 await limits.locator('.view-wrapper').evaluate(el=>el.remove());
 await limits.locator('.note-container > .date').evaluate(el=>el.remove());
 limited=await limits.evaluate(()=>CrowdPage.probe('note').record);assert.equal(limited.standard.view_count,null);assert.equal(limited.standard.published_at,null);
 await limits.locator('#detail-desc').evaluate(el=>el.innerText='推荐'+ '字'.repeat(23998));
 await limits.locator('.comments-container').evaluate(el=>{el.innerHTML=Array.from({length:70},()=>'<div class="comment-item"><div class="content">'+ '长'.repeat(2000)+'</div></div>').join('');});
 limited=await limits.evaluate(()=>CrowdPage.probe('note').record);assert.ok(JSON.stringify(limited).length<60000);assert.equal(await limits.evaluate(()=>!!CrowdCore.validate(CrowdPage.probe('note').record)),true);

 // Author identity is taken from the current note, never a recommendation card.
 await limits.locator('.note-container').evaluate(el=>el.insertAdjacentHTML('afterbegin','<div class="author-wrapper"><a href="/user/profile/bbbbbbbbbbbbbbbbbbbbbbbb?xsec_token=local"><span class="username">作者甲</span></a></div>'));
 const identified=await limits.evaluate(()=>CrowdPage.probe('note').record);
 assert.equal(identified.extra.author.id,'b'.repeat(24));assert.equal(identified.extra.author.url.includes('?'),false);
 assert.equal(identified.standard.author_display,'作者甲');assert.equal(identified.extra.field_observations.like_count.status,'approximate');
 await limits.locator('#detail-desc').evaluate(el=>el.innerText='好吃');
 assert.equal((await limits.evaluate(()=>CrowdPage.probe('note'))).ready,true,'short text is not a load timeout');
 const profilePage=await browser.newPage();
 await profilePage.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<div class="user-info"><h1 class="user-name">作者甲</h1><span class="user-redId">小红书号：public123</span><div class="user-interactions"><div><span class="count">1.2万</span><span>粉丝</span></div><div><span class="count">23</span><span>笔记</span></div></div></div><section class="note-item"><a href="/explore/'+id+'?xsec_token=never-upload"><span class="title">公开笔记</span></a></section>'}));
 await profilePage.goto('https://www.xiaohongshu.com/user/profile/'+'b'.repeat(24));
 for(const name of ['core','content'])await profilePage.addScriptTag({content:fs.readFileSync(path.join(src,name+'.js'),'utf8')});
 const profile=await profilePage.evaluate(()=>CrowdPage.probe('profile'));
 assert.equal(profile.ready,true);assert.equal(profile.profile.metrics.followers.status,'approximate');assert.equal(profile.profile.metrics.followers.value,12000);assert.equal(profile.profile.metrics.notes.value,23);assert.equal(profile.profile.metrics.likes_collected.value,null);
 assert.equal(profile.profile.public_handle,'public123');assert.equal(JSON.stringify(profile).includes('never-upload'),false);
 await profilePage.close();

 await limits.locator('#detail-desc').evaluate(el=>el.remove());
 await limits.locator('.comments-container .content').first().evaluate(el=>el.classList.add('note-text'));
 const titleOnly=await limits.evaluate(()=>CrowdPage.probe('note'));assert.equal(titleOnly.ready,true,'title-only note is loaded');assert.equal(titleOnly.record.evidence.text,'','comments cannot replace missing note evidence');
 await limits.locator('body').evaluate(el=>el.insertAdjacentHTML('beforeend','<div class="captcha">验证</div>'));
 assert.equal((await limits.evaluate(()=>CrowdPage.probe('comments'))).gate,'captcha');await limits.close();
 console.log('PASS engagement: public view count, own comment fields, parent/reply links, read-only expansion, hidden/missing values, truncation and envelope budget');
 const noteDiag=await page.evaluate(()=>CrowdPage.probe('diagnostics'));
 assert.equal(noteDiag.page.kind,'note');assert.ok(noteDiag.page.body_chars>=8);assert.equal(JSON.stringify(noteDiag).includes('测试餐厅'),false);
 // Ordinary note discussion about "频繁" must not accidentally trigger rate-limit detection.
 await page.locator('#detail-desc').evaluate(el=>el.innerText+=' 我频繁来吃饭。');assert.equal((await page.evaluate(()=>CrowdPage.probe('note'))).gate,undefined);
 await page.locator('body').evaluate(el=>el.insertAdjacentHTML('beforeend','<div class="error-page">访问频繁，请稍后再试</div>'));
 assert.equal((await page.evaluate(()=>CrowdPage.probe('note'))).gate,'rate_limit');
 await page.locator('.error-page').evaluate(el=>el.innerHTML='<div class="captcha">验证码</div>');assert.equal((await page.evaluate(()=>CrowdPage.probe('note'))).gate,'captcha');
 await page.locator('.error-page').evaluate(el=>el.innerHTML='<div class="login-modal"><input placeholder="手机号"></div>');assert.equal((await page.evaluate(()=>CrowdPage.probe('note'))).gate,'login_required');
 await page.locator('.error-page').evaluate(el=>el.remove());
 await page.goto('https://m.xiaohongshu.com/discovery/item/'+id+'?xsec_token=navigation-only');await inject();
 const mobile=await page.evaluate(()=>CrowdPage.probe('note'));
 assert.equal(mobile.ready,true);assert.equal(mobile.record.standard.url,'https://www.xiaohongshu.com/explore/'+id);
 assert.equal(mobile.record.evidence.text,result.record.evidence.text);
 // Drive the actual shared agent through real navigation + DOM probes, then reload its runtime.
 for(const name of ['core','agent'])await page.addScriptTag({content:fs.readFileSync(path.join(src,name+'.js'),'utf8')});
 let clock=Date.now(),state={},uploads=[],lostAck=true;
 const host=await browser.newPage();
 await host.route('https://www.xiaohongshu.com/**',route=>route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:new URL(route.request().url()).pathname==='/search_result'?`<a href="/search_result/${id}?xsec_token=navigation-only">测试餐厅</a>`:note}));
 const vm=await import('node:vm');
 const context=vm.createContext({console,AbortController,URL,Date,Math,setTimeout,clearTimeout});
 for(const name of ['core','agent'])vm.runInContext(fs.readFileSync(path.join(src,name+'.js'),'utf8'),context);
 const runtime={splitCapture:true,storage:{get:async k=>structuredClone(state[k]),set:async(k,v)=>state[k]=structuredClone(v)},now:()=>clock,random:()=>0,uuid:()=>crypto.randomUUID(),schedule:async()=>{},cancel:async()=>{},close:async()=>{},open:async url=>{
  await host.goto(url);for(const name of ['core','content'])await host.addScriptTag({content:fs.readFileSync(path.join(src,name+'.js'),'utf8')});
 },probe:async action=>host.evaluate(action=>CrowdPage.probe(action),action)};
 const user=crypto.randomUUID();
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
  grant usage on schema auth to authenticated;grant execute on function auth.uid(),auth.role() to authenticated;`);
 for(const suffix of ['20261006145016_crowd_v4.sql','_crowd_v4_diagnostics.sql','_crowd_v4_navigation_diagnostics.sql','_crowd_v4_view_count.sql','_crowd_v4_safety.sql','_crowd_v4_receipt_recovery.sql','_crowd_v4_task_scheduling.sql','_crowd_v4_observations.sql','_crowd_v4_relevance_aliases.sql']) await db.exec(fs.readFileSync(path.join(migrations,fs.readdirSync(migrations).find(n=>n.endsWith(suffix))),'utf8'));
 await db.query('insert into auth.users values($1)',[user]);
 await db.query("insert into crowd_v4.participants(user_id,status,consent,quota_day) values($1,'approved','crowd-public-v4',2)",[user]);
 await db.exec(`insert into crowd_v4.tasks(source_key,query,store_name,anchor_terms,target) values('fixture','测试餐厅','测试餐厅','["测试餐厅"]',1)`);
 await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[user]);
 await db.exec('set role authenticated');
 let serverClock=clock;
 const api={rpc:async(name,p={})=>{
  // Accelerated test clock: advance only the private fixture's safety timestamps.
  const elapsed=clock-serverClock;serverClock=clock;
  if(elapsed){await db.exec('reset role');await db.query("update crowd_v4.safety set next_action=next_action-$1*interval '1 millisecond',session_started=session_started-$1*interval '1 millisecond',cooldown_until=cooldown_until-$1*interval '1 millisecond'",[elapsed]);await db.exec('set role authenticated');}

  const statements={guard:['select public.crowd_v4_guard($1,$2,$3) as result',[p.p_action,p.p_task??null,p.p_note??null]],status:['select public.crowd_v4_status() as result',[]],
   claim:['select public.crowd_v4_claim($1) as result',[p.p_task??null]],
   submit:['select public.crowd_v4_submit($1,$2,$3,$4::jsonb) as result',[p.p_request,p.p_task,p.p_lease,JSON.stringify(p.p_record)]],
   finish:['select public.crowd_v4_finish($1,$2) as result',[p.p_task,p.p_lease]],observe:['select public.crowd_v4_observe($1,$2,$3,$4) as result',[p.p_request,p.p_parent,p.p_kind,p.p_data]]};
  if(name==='submit' && lostAck) {
   const bad=structuredClone(p.p_record);bad.standard.view_count=-1;
   assert.equal((await db.query('select public.crowd_v4_submit($1,$2,$3,$4::jsonb) as result',[crypto.randomUUID(),p.p_task,p.p_lease,JSON.stringify(bad)])).rows[0].result.error,'invalid_record');
   assert.throws(()=>context.CrowdCore.validate(bad),/invalid_count/);
   const wrongParent=structuredClone(p.p_record);wrongParent.extra.comments.items[1].parent_key='comment-999';
   assert.throws(()=>context.CrowdCore.validate(wrongParent),/invalid_comments/);
  }
  const result=(await db.query(...statements[name])).rows[0].result;
  if(name==='submit'){uploads.push(p);if(lostAck){lostAck=false;throw new Error('fixture_lost_ack');}}
  return result;
 }};
 state.agent={...context.CrowdCore.initial(),consent:context.CrowdCore.CONSENT};let agent=new context.CrowdAgent(runtime,api);await agent.start();
 for(let i=0;i<22;i++){await agent.tick();clock+=45000;if(i===5)agent=new context.CrowdAgent(runtime,api);}
 assert.equal(uploads.length,2);assert.equal(uploads[0].p_request,uploads[1].p_request);
 assert.equal(uploads[0].p_record.extra.hashtags.length,2);assert.equal(state.agent.received,1);
 await db.exec('reset role');
 const stored=(await db.query('select record from crowd_v4.proofs')).rows;
 assert.equal(stored.length,1,'real SQL receipt replay must not duplicate evidence');
 assert.equal(stored[0].record.standard.url,'https://www.xiaohongshu.com/explore/'+id);
 assert.equal(stored[0].record.evidence.text,result.record.evidence.text);
 assert.deepEqual(stored[0].record.extra.hashtags,['清蒸鱼','上海美食']);
 assert.equal(stored[0].record.standard.view_count,13000);assert.equal(stored[0].record.extra.comments.items.length,3,'base is sent before expansion');
 const supplemental=(await db.query("select data from crowd_observation.snapshots where kind='note'")).rows;assert.equal(supplemental.length,1);assert.equal(supplemental[0].data.extra.comments.items.length,4);assert.equal(supplemental[0].data.extra.comments.items[3].parent_key,'comment-1');
 console.log('PASS Chromium + PostgreSQL: search_result detail route, real SQL claim/submit/finish, standard/extra/evidence stored once after lost acknowledgement');
 // Actual extension controller DOM with a fixed Chrome command fixture.
 const controller=await browser.newPage();
 await controller.route('https://controller.example.test/**',route=>{
  const file=new URL(route.request().url()).pathname.slice(1);
  if(!['controller.html','controller.css','config.js','core.js','api.js','agent.js','join.js','native-runtime.js','controller.js'].includes(file))return route.abort();
  return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript',body:file==='config.js'?'globalThis.CROWD_CONFIG={};':fs.readFileSync(path.join(src,file),'utf8')});
 });
 await controller.addInitScript(()=>{
  globalThis.commands=[];let enabled=false,session=true;
  globalThis.chrome={runtime:{sendMessage:async message=>{
   commands.push(message);
   if(message.type==='state')return {ok:true,data:{session,invited:true,agent:{enabled:false,phase:'idle',outbox:[],rejected:[{reason:'unrelated_note',record:{evidence:{text:'PRIVATE_EVIDENCE_MUST_NOT_APPEAR'}}}],last_error:'page_timeout'},status:{participant:{status:'approved'}},diagnostics:{enabled,sent_at:enabled?Date.now():null}}};
   if(message.type==='diagnostics'){await new Promise(r=>setTimeout(r,50));enabled=message.enabled;}
   if(message.type==='logout')session=false;
   return {ok:true,data:{}};
  }}};
 });
 await controller.goto('https://controller.example.test/controller.html');
 await controller.waitForFunction(()=>!document.getElementById('diagnostics').disabled);
 assert.equal(await controller.locator('#diagnostics').isChecked(),false);
 assert.ok((await controller.locator('#status').textContent()).includes('unrelated_note'),'rejection reason remains visible independently of transient last_error');
 assert.equal((await controller.locator('body').textContent()).includes('PRIVATE_EVIDENCE_MUST_NOT_APPEAR'),false);
 await controller.locator('#diagnostics').check();
 await controller.waitForFunction(()=>document.getElementById('diagnostics_status').textContent.includes('最近诊断送达'));
 await controller.waitForFunction(()=>!document.getElementById('diagnostics').disabled);
 await controller.locator('#inspect_work_page').click();
 await controller.waitForFunction(()=>commands.some(c=>c.type==='inspect_work_page')&&!document.getElementById('diagnostics').disabled);
 await controller.locator('#diagnostics').uncheck();
 await controller.waitForFunction(()=>document.getElementById('diagnostics_status').textContent==='诊断未开启。');
 assert.equal(await controller.evaluate(()=>commands.some(c=>c.type==='start')),false,'diagnostics controls never start collection');
 await controller.waitForFunction(()=>!document.getElementById('consent').disabled);
 assert.equal(await controller.locator('#consent').textContent(),'同意并继续');
 await controller.locator('#agree').check();await controller.locator('#consent').click();
 await controller.waitForFunction(()=>commands.some(c=>c.type==='start'));
 assert.equal(await controller.evaluate(()=>commands.some(c=>c.type==='join')),false,'an existing session resumes without allocating a new installation');
 await controller.locator('details:has(#logout) > summary').click();await controller.locator('#logout').click();
 await controller.waitForFunction(()=>document.getElementById('diagnostics').disabled);
 console.log('PASS extension controller DOM: diagnostics default off, opt-in/out status, explicit inspect command, signed-out control disabled, no silent start, existing session resumes without reenrollment');
 console.log('PASS Chromium: real DOM, automatic search/navigation/dwell/extraction/upload, reconstructed agent, standard/extra/null fields, gate detection');
 console.log('LIMIT: fixtures, not live Xiaohongshu or Windows/macOS/iOS/Harmony hardware acceptance');
}finally{await db.close();await browser.close();}
