'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const src=path.resolve(process.env.CROWD_TEST_SOURCE||'v4/src');
function fixture({blank=false,pending=true,updateFails=false}={}) {
 const url='https://www.xiaohongshu.com/search_result?keyword=test',data={work_tab:7},calls={create:0,update:0,guard:0};
 const event={addListener(){}};
 const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:event,onMessageExternal:event,onInstalled:event,onStartup:event},
 storage:{local:{get:async k=>({[k]:data[k]}),set:async v=>Object.assign(data,structuredClone(v)),setAccessLevel:async()=>{}}},
 alarms:{get:async()=>null,create:async()=>{},clear:async()=>{},onAlarm:event},
 webNavigation:{getFrame:async()=>({url:blank?'about:blank':url}),...Object.fromEntries(['onBeforeNavigate','onCommitted','onDOMContentLoaded','onCompleted','onErrorOccurred'].map(k=>[k,event]))},
 windows:{getAll:async()=>[{id:1}]},tabs:{onRemoved:event,get:async()=>({id:7,url:blank?undefined:url,pendingUrl:blank&&pending?url:undefined,status:blank?'loading':'complete'}),
 create:async()=>{calls.create++;return {id:8};},update:async()=>{calls.update++;if(updateFails)throw Error('raw private browser error');return {};},sendMessage:async()=>{throw Error('no receiver');},remove:async()=>{}}};
 const c=vm.createContext({chrome,console,URL,Date,Math,AbortController,setTimeout,clearTimeout,crypto:require('node:crypto').webcrypto,fetch:async()=>{throw Error('unexpected network');}});
 c.importScripts=(...names)=>{for(const name of names){if(name==='config.js')c.CROWD_CONFIG={url:'https://example.supabase.co',key:'sb_publishable_test'};else vm.runInContext(fs.readFileSync(path.join(src,name),'utf8'),c);}};
 vm.runInContext(fs.readFileSync(path.join(src,'background.js'),'utf8'),c);
 return {c,data,calls,run:s=>vm.runInContext(s,c)};
}
(async()=>{
 const failures=[];const test=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);console.error('FAIL '+name+': '+e.message);}};
 await test('navigation API failure is not swallowed or retried in another tab',async()=>{
  const f=fixture({updateFails:true});await assert.rejects(f.run("runtime.open('https://www.xiaohongshu.com/search_result?keyword=test')"),/^Error: navigation_failed$/);
  assert.equal(f.calls.update,1);assert.equal(f.calls.create,0);assert.equal(f.data.work_tab,7);
 });
 await test('new-tab navigation failure preserves the owned blank page without a second attempt',async()=>{
  const f=fixture({blank:true,pending:false,updateFails:true});await assert.rejects(f.run("runtime.open('https://www.xiaohongshu.com/search_result?keyword=test')"),/^Error: navigation_failed$/);
  assert.equal(f.calls.update,1);assert.equal(f.calls.create,1);assert.equal(f.data.work_tab,8);
 });
 await test('blank pending document is distinguished from loaded-page receiver failure',async()=>{
  for(const pending of [true,false]){const f=fixture({blank:true,pending});assert.equal((await f.run('runtime.probe("search")')).reason,'navigation_uncommitted');}
  const f=fixture();assert.equal((await f.run('runtime.probe("search")')).reason,'content_unavailable');
 });
 await test('uncommitted navigation deadline pauses once, preserving task and rejected evidence',async()=>{
  const f=fixture({blank:true});await new Promise(r=>setImmediate(r));
  await f.run(`api.rpc=async name=>{if(name!=='guard')throw Error('unexpected '+name);return {version:1,ttl_ms:600000,paused:false,allowed:true,reason:null,wait_ms:0,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:1,detail:0,comment:0,scroll:0}}};
   storage.set('agent',{...CrowdCore.initial(),enabled:true,consent:CrowdCore.CONSENT,phase:'search',last_tick:Date.now(),page_deadline:Date.now()-1,task:{id:1,query:'test',lease_until:new Date(Date.now()+1200000).toISOString(),received:0,target:2},rejected:[{request:'keep-original',reason:'unrelated_note'}]});`);
  await f.run('agent.tick()');const s=await f.run('agent.read()');assert.equal(s.enabled,false);assert.equal(s.last_error,'navigation_uncommitted');assert.equal(s.task.id,1);assert.equal(s.rejected[0].request,'keep-original');
  await f.run('agent.tick(true)');assert.equal(f.calls.update,0);assert.equal(f.calls.create,0);assert.equal((await f.run('agent.read()')).enabled,false);
 });
 if(failures.length){process.exitCode=1;console.error(failures.length+' regression(s) failed');}
})().catch(e=>{console.error(e);process.exitCode=1;});
