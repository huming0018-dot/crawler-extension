'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{webcrypto}=require('node:crypto');
const src=path.resolve('v4/src');
async function fixture(seed={}){
 const data=structuredClone(seed),calls=[],writes=[],alarms=new Map(),listeners={},tabs=[];
 const chrome={runtime:{id:'licijehcpohikchlnkbpjdjdfkcocndg',getURL:x=>'chrome-extension://licijehcpohikchlnkbpjdjdfkcocndg/'+x,openOptionsPage:async()=>{},onMessage:{addListener:fn=>listeners.message=fn},onMessageExternal:{addListener:fn=>listeners.external=fn},onStartup:{addListener:fn=>listeners.startup=fn},onInstalled:{addListener:fn=>listeners.install=fn}},storage:{local:{get:async key=>({[key]:structuredClone(data[key])}),set:async values=>{writes.push(Object.keys(values));Object.assign(data,structuredClone(values));},setAccessLevel:async()=>{}}},alarms:{get:async key=>alarms.get(key),create:async(key,value)=>alarms.set(key,value),clear:async key=>alarms.delete(key),onAlarm:{addListener:fn=>listeners.alarm=fn}},tabs:{onRemoved:{addListener:()=>{}},create:async value=>{tabs.push(value);return {id:1};}},windows:{},webNavigation:{}};
 const context=vm.createContext({chrome,console,URL,Date,Math,performance,AbortController,crypto:webcrypto,TextEncoder,setTimeout:(fn,ms)=>{const h=setTimeout(fn,ms);h.unref();return h;},clearTimeout,fetch:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>({participant:{status:'approved'}})};}});
 context.importScripts=(...names)=>{for(const name of names)if(name==='config.js')context.CROWD_CONFIG={url:'https://fixture.supabase.co',key:'sb_publishable_test',portal:'https://portal.example.test'};else vm.runInContext(fs.readFileSync(path.join(src,name),'utf8'),context);};
 vm.runInContext(fs.readFileSync(path.join(src,'participant-background.js'),'utf8'),context);await new Promise(r=>setImmediate(r));
 const command=message=>new Promise(resolve=>listeners.message(message,{id:chrome.runtime.id,url:chrome.runtime.getURL('src/controller.html')},resolve));
 return {data,calls,writes,tabs,listeners,command,context};
}
(async()=>{
 for(const seed of [{},{pending_invite:'fixture-invite'}]){
  const f=await fixture(seed),r=await f.command({type:'state'});assert.equal(r.ok,true);assert.equal(r.data.session,false);assert.equal(r.data.status.error,undefined);assert.equal(r.data.progress,null);assert.equal(f.calls.length,0,'first use never sends authenticated status or progress');
 }
 const legacy={participant_id:'P-FIXTURE1',device_salt:'local-private-salt',agreed_at:'fixture',active_task:{id:27},proof_queue:[{submission_id:'legacy-stable-id',items:[{kind:'rating',score:4}]}],kw_state_27:{'3':{accepted:3}},rating_state_27:{'3':{rating:4}},deadLetter:[{submission_id:'old-failed'}],collector_running:true};
 const f=await fixture(legacy),r=await f.command({type:'state'});assert.equal(r.data.legacy_installation,true);assert.equal(r.data.status.error,'legacy_migration_required');assert.doesNotMatch(JSON.stringify(r),/P-FIXTURE|local-private-salt|legacy-stable-id/);
 for(const type of ['join','login','start','rating','consent','logout','export','update_check','open_login','receive_invite']){const value=await f.command({type,consent:'crowd-public-v4'});assert.equal(value.ok,false);assert.equal(value.error,'legacy_migration_required');}
 await f.listeners.startup();f.listeners.install({reason:'update'});for(const name of ['crowd_tick','crowd_upload','crowd_update','crowd_node_monitor'])await f.listeners.alarm({name});
 await new Promise(r=>setImmediate(r));assert.deepEqual(f.data,legacy,'no legacy values or extra metadata are rewritten');assert.equal(f.writes.length,0);assert.equal(f.calls.length,0);assert.equal(f.tabs.length,0);
 const session={user:{id:'00000000-0000-4000-8000-000000000001'},access_token:'private-access',refresh_token:'private-refresh',expires_at:Date.now()+3600000};
 const coexist=await fixture({...legacy,session});const held=await coexist.command({type:'state'});assert.equal(held.data.status.error,'legacy_migration_required');assert.deepEqual(coexist.data,{...legacy,session});assert.equal(coexist.writes.length,0);assert.equal(coexist.calls.length,0);
 const v4=await fixture({session});const s=await v4.command({type:'state'});assert.equal(s.data.session,true);assert.equal(s.data.legacy_installation,false);assert.equal(s.data.status.participant.status,'approved');assert.equal(v4.calls.filter(c=>c.url.endsWith('_status')).length,1);assert.equal(v4.calls.filter(c=>c.url.endsWith('_progress')).length,1);assert.doesNotMatch(JSON.stringify(s),/private-access|private-refresh/);
 console.log('PASS real participant worker: fresh/invited state zero RPC; v4 authenticated state; legacy identity/queue/rating preserved byte-for-byte, no network/tabs/mutations through startup, alarms or commands');
})().catch(e=>{console.error(e);process.exitCode=1;});
