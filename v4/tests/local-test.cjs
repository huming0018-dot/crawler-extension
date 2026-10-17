'use strict';
const assert=require('node:assert/strict');require('../src/local-test.js');require('../src/updater.js');
const ID='ipccepibnkcfpikgebdaanimocdappfk',digest='a'.repeat(64);
function fixture(){
 const values=new Map();let owner='A',starts=0,stops=0,busy=false,state={enabled:false,outbox:[],work_slots:[]},gate=async()=>true;
 const storage={get:async k=>values.get(k),set:async(k,v)=>values.set(k,v)};
 const make=version=>new CrowdLocalTest({storage,id:ID,version,owner:async()=>owner,agent:{read:async()=>state,stop:async()=>{stops++;state.interrupted=[...(state.interrupted||[]),...state.work_slots];state.work_slots=[];}},isBusy:async()=>busy,start:async valid=>{await gate();if(await valid())starts++;}});
 return {values,storage,make,get starts(){return starts;},get stops(){return stops;},get current(){return state;},owner:v=>owner=v,state:v=>state=v,busy:v=>busy=v,gate:v=>gate=v};
}
(async()=>{
 let f=fixture(),old=f.make('4.2.13');await old.settings(true);f.values.set('local_update_verified',{version:'4.2.13',digest});await old.run();assert.equal(f.starts,0);
 let next=f.make('4.2.14');f.values.set('local_update_verified',{version:'4.2.14',digest});await Promise.all([next.run(),next.run()]);assert.equal(f.starts,1);await f.make('4.2.14').run();assert.equal(f.starts,1);
 f=fixture();await f.make('4.2.13').settings(true);next=f.make('4.2.14');f.values.set('local_update_verified',{version:'4.2.14',digest});const uuid='keep-original';f.state({outbox:[{request:uuid}],work_slots:[]});await next.run();assert.equal(f.starts,0);assert.equal(f.values.get('local-test-update:A').consumed,undefined);f.state({outbox:[],work_slots:[]});await next.run();assert.equal(f.starts,1);
 f=fixture();await f.make('4.2.13').settings(true);next=f.make('4.2.14');f.values.set('local_update_verified',{version:'4.2.14',digest});f.owner('B');await next.run();assert.equal(f.starts,0);f.owner('A');await next.cancel();await next.run();assert.equal(f.starts,0);assert.equal(f.values.get('local-test-update:A').enabled,false);
 f=fixture();await f.make('4.2.13').settings(true);next=f.make('4.2.14');f.values.set('local_update_verified',{version:'4.2.14',digest});let release,entered;const waiting=new Promise(r=>entered=r);f.gate(()=>{entered();return new Promise(r=>release=r);});const run=next.run();await waiting;await next.cancel();release();await run;assert.equal(f.starts,0);
 f=fixture();next=f.make('4.2.14');const realSet=f.storage.set;let delayed,started;const pause=new Promise(r=>started=r);f.storage.set=async(k,v)=>{if(v.enabled===true){started();await new Promise(r=>delayed=r);}return realSet(k,v);};const setting=next.settings(true);await pause;const stopping=next.cancel();delayed();await Promise.all([setting,stopping]);assert.equal(f.values.get('local-test-update:A').enabled,false);
 f=fixture();await f.make('4.2.13').settings(true);next=f.make('4.2.14');f.values.set('local_update_verified',{version:'4.2.14',digest:'bad'});await next.run();assert.equal(f.starts,0);
 f=fixture();await f.make('4.2.13').settings(true);next=f.make('4.2.14');f.values.set('local_update_verified',{version:'4.2.14',digest});
 const checkpoint={id:'old',request:'already-received',base_received:true};f.state({enabled:false,outbox:[],work_slots:[checkpoint]});await next.run();
 assert.equal(f.stops,1);assert.equal(f.starts,1);assert.deepEqual(f.current.interrupted,[checkpoint],'old receipt and attempt remain recorded');
 for(const condition of [{enabled:false,outbox:[],work_slots:[{request:'unknown'}]},{enabled:false,outbox:[{request:'pending'}],work_slots:[checkpoint]},{enabled:true,outbox:[],work_slots:[checkpoint]}]) {
  f=fixture();await f.make('4.2.13').settings(true);next=f.make('4.2.14');f.values.set('local_update_verified',{version:'4.2.14',digest});f.state(condition);await next.run();assert.equal(f.stops,0);assert.equal(f.starts,0);assert.deepEqual(f.current,condition);
 }
 // Handshake records a ticket only from the separate host, exact loaded version and digest.
 const alarms=new Map(),calls=[];f=fixture();let reply={status:'applied',version:'4.2.14',profile:'local-test',release_sha256:digest,protocol:2};
 const chrome={runtime:{id:ID,sendNativeMessage:async(host,m)=>{calls.push([host,m.action]);if(m.action==='settings')return {status:'configured'};return reply;}},alarms:{get:async n=>alarms.get(n),create:async(n,v)=>alarms.set(n,v),clear:async n=>alarms.delete(n)}};
 let updater=new CrowdUpdater({chrome,storage:f.storage,agent:{read:async()=>({})},version:'4.2.14',releaseHash:async()=>digest});await updater.bootstrap();assert.deepEqual(f.values.get('local_update_verified'),{version:'4.2.14',digest});assert(calls.every(([host])=>host==='com.crowd.v4.local_test_updater'));
 reply={...reply,status:'rolled_back'};await updater.bootstrap();assert.equal(f.values.get('local_update_verified'),null);
 reply={...reply,status:'ready'};await updater.bootstrap();assert.equal(f.values.get('local_update_verified'),null);assert.equal(f.values.get('local_updater_ready').version,'4.2.14');
 f.values.set('local_update_verified',{version:'4.2.14',digest});f.values.set('local_updater_ready',{version:'4.2.14',digest});reply={status:'pending_reload',version:'4.2.15'};chrome.runtime.reload=()=>{};await updater.bootstrap();assert.equal(f.values.get('local_update_verified'),null);assert.equal(f.values.get('local_updater_ready'),null);
 chrome.runtime.sendNativeMessage=async()=>{throw Error('Specified native messaging host not found.');};await updater.bootstrap();assert(alarms.has('crowd_update_bootstrap'));assert.equal(f.values.get('local_update_verified'),null);chrome.runtime.sendNativeMessage=async()=>({status:'configured'});await updater.setEnabled(false);assert(!alarms.has('crowd_update_bootstrap'));
 console.log('PASS local test entry: signed ticket, exactly once, owner, pending UUID, Stop races, rollback, host routing, helper reconnect');
})().catch(e=>{console.error(e);process.exitCode=1;});
