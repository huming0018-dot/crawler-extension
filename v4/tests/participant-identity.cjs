'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{webcrypto}=require('node:crypto');
const src=path.resolve('v4/src');
async function fixture(seed={}){
 const data=structuredClone(seed),calls=[],writes=[],alarms=new Map(),listeners={},tabs=[];
 const chrome={runtime:{id:'licijehcpohikchlnkbpjdjdfkcocndg',getURL:x=>'chrome-extension://licijehcpohikchlnkbpjdjdfkcocndg/'+x,openOptionsPage:async()=>{},onMessage:{addListener:fn=>listeners.message=fn},onMessageExternal:{addListener:fn=>listeners.external=fn},onStartup:{addListener:fn=>listeners.startup=fn},onInstalled:{addListener:fn=>listeners.install=fn}},storage:{local:{get:async key=>key===null?structuredClone(data):({[key]:structuredClone(data[key])}),set:async values=>{writes.push(Object.keys(values));Object.assign(data,structuredClone(values));},setAccessLevel:async()=>{}}},alarms:{get:async key=>alarms.get(key),create:async(key,value)=>alarms.set(key,value),clear:async key=>alarms.delete(key),onAlarm:{addListener:fn=>listeners.alarm=fn}},tabs:{onRemoved:{addListener:()=>{}},create:async value=>{tabs.push(value);return {id:1};}},windows:{},webNavigation:{}};
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
 for(const seed of [{},{install_secret:'preserve-secret'},{'agent:signed-out':{last_error:'backend_login_required',outbox:[],rejected:[]}}]){
  const f=await fixture(seed),before=structuredClone(f.data);for(const type of ['consent','start','test_start','join']){const r=await f.command({type,consent:'crowd-public-v4'});assert.equal(r.error,'invite_required');}assert.equal(f.calls.length,0);assert.deepEqual(f.data,before,'anonymous denied before stop or register');
 }
 for(const seed of [{'agent:00000000-0000-4000-8000-000000000001':{outbox:[]}},{'agent:signed-out':{outbox:[{request:'original'}]}},{'agent:signed-out':{task:{id:19}}},...['note_id','note_url','sdk_unknown','risk_report','pending_observation_batch'].map(key=>({'agent:signed-out':{[key]:'retained'}}))]){
  const f=await fixture({...seed,pending_invite:'a'.repeat(64)}),before=structuredClone(f.data);const r=await f.command({type:'state'});assert.equal(r.data.entry_state,'identity_recovery_required');for(const type of ['consent','start','join'])assert.equal((await f.command({type,consent:'crowd-public-v4'})).error,'identity_recovery_required');assert.equal(f.calls.length,0);assert.deepEqual(f.data,before);
 }
 const legacy={participant_id:'P-FIXTURE1',device_salt:'local-private-salt',agreed_at:'fixture',active_task:{id:27},proof_queue:[{submission_id:'legacy-stable-id',items:[{kind:'rating',score:4}]}],kw_state_27:{'3':{accepted:3}},rating_state_27:{'3':{rating:4}},deadLetter:[{submission_id:'old-failed'}],collector_running:true};
 const f=await fixture(legacy),r=await f.command({type:'state'});assert.equal(r.data.legacy_installation,true);assert.equal(r.data.status.error,'legacy_migration_required');assert.doesNotMatch(JSON.stringify(r),/P-FIXTURE|local-private-salt|legacy-stable-id/);
 for(const type of ['join','login','start','rating','consent','logout','export','update_check','open_login','receive_invite']){const value=await f.command({type,consent:'crowd-public-v4'});assert.equal(value.ok,false);assert.equal(value.error,'legacy_migration_required');}
 await f.listeners.startup();f.listeners.install({reason:'update'});for(const name of ['crowd_tick','crowd_upload','crowd_update','crowd_node_monitor'])await f.listeners.alarm({name});
 await new Promise(r=>setImmediate(r));assert.deepEqual(f.data,legacy,'no legacy values or extra metadata are rewritten');assert.equal(f.writes.length,0);assert.equal(f.calls.length,0);assert.equal(f.tabs.length,0);
 const session={user:{id:'00000000-0000-4000-8000-000000000001'},access_token:'private-access',refresh_token:'private-refresh',expires_at:Date.now()+3600000};
 const coexist=await fixture({...legacy,session});const held=await coexist.command({type:'state'});assert.equal(held.data.status.error,'legacy_migration_required');assert.deepEqual(coexist.data,{...legacy,session});assert.equal(coexist.writes.length,0);assert.equal(coexist.calls.length,0);
 const v4=await fixture({session});const s=await v4.command({type:'state'});assert.equal(s.data.session,true);assert.equal(s.data.legacy_installation,false);assert.equal(s.data.status.participant.status,'approved');assert.equal(v4.calls.filter(c=>c.url.endsWith('_status')).length,1);assert.equal(v4.calls.filter(c=>c.url.endsWith('_progress')).length,1);assert.doesNotMatch(JSON.stringify(s),/private-access|private-refresh/);
 for(const mode of ['network','confirmation','missing-session','complete']){
  const f=await fixture({pending_invite:'a'.repeat(64),install_secret:'original-secret'}),original=structuredClone(f.data);let enrolls=0;
  const api={config:{portal:'https://portal.example.test',platform:'macos'},enroll:async p=>{enrolls++;assert.equal(p.install_secret,'original-secret');return {email:'fixture@example.invalid'};},login:async()=>{if(mode==='network')throw Error('network_failed');if(mode==='complete')f.data.session={user:{id:'fixture',email:'fixture@example.invalid'},access_token:'fixture-access',refresh_token:'fixture-refresh',expires_at:Date.now()+3600000};return {confirmation_required:mode==='confirmation'};}};
  const storage={get:async k=>f.data[k],set:async(k,v)=>f.data[k]=v};
  if(mode==='complete'){await f.context.CrowdJoin.join(api,storage,'a'.repeat(64));assert.equal(f.data.pending_invite,null);assert.equal(f.data.install_secret,'original-secret');}
  else {await assert.rejects(f.context.CrowdJoin.join(api,storage,'a'.repeat(64)),mode==='network'?/network_failed/:/backend_unavailable/);assert.deepEqual(f.data,original);}
  assert.equal(enrolls,1);
 }
 console.log('PASS real participant worker: fresh/invited state zero RPC; v4 authenticated state; legacy identity/queue/rating preserved byte-for-byte, no network/tabs/mutations through startup, alarms or commands');
})().catch(e=>{console.error(e);process.exitCode=1;});
