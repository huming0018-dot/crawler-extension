'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
for(const name of ['core','agent'])vm.runInThisContext(fs.readFileSync((process.env.CROWD_TEST_SOURCE||'v4/src')+'/'+name+'.js','utf8'));
(async()=>{
 let now=Date.now(),opens=0,probes=0,searches=0;
 let state={...CrowdCore.initial(),enabled:true,consent:CrowdCore.CONSENT};
 const task={id:1,query:'测试餐厅',lease_token:'test',lease_until:new Date(now+1200000).toISOString(),received:0,target:2};
 const runtime={storage:{get:async()=>structuredClone(state),set:async(_,value)=>state=structuredClone(value)},now:()=>now,
   schedule:async()=>{},cancel:async()=>{},open:async()=>{opens++;throw Error('cancelled');},
   probe:async()=>{probes++;return {ready:false,reason:'page_loading'};}};
 const api={rpc:async(name,params)=>{
   if(name==='claim')return {task};
   assert.equal(name,'guard');if(params.p_action==='search')searches++;
   return {version:1,ttl_ms:600000,paused:false,allowed:true,reason:null,wait_ms:0,gap_ms:30000,
     caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:searches,detail:0,comment:0,scroll:0}};
 }};
 await new CrowdAgent(runtime,api).tick(); // Worker disappears immediately after navigation was issued.
 now+=30000;await new CrowdAgent(runtime,api).tick();
 assert.equal(opens,1,'worker restart must not reopen the just-issued search');
 assert.equal(searches,1,'one search admission survives a worker restart');assert.equal(probes,1);
 assert.equal(state.phase,'search');assert.ok(state.page_deadline>now);
 // Both Chrome startup and an alarm gap must finish the already-admitted
 // attempt, even when its document never became accessible to the extension.
 for(const recover of [false,true]){
  state={...CrowdCore.initial(),enabled:true,consent:CrowdCore.CONSENT};opens=probes=searches=0;
  await new CrowdAgent(runtime,api).tick();
  now+=121000;await new CrowdAgent(runtime,api).tick(recover);
  assert.equal(opens,1,'long wake must not reopen');assert.equal(searches,1,'long wake must not re-admit');
  assert.equal(probes,1);assert.equal(state.enabled,false);assert.equal(state.last_error,'page_loading');
  assert.equal(state.phase,'search');assert.equal(state.page_failures,1);
  now+=300000;await new CrowdAgent(runtime,api).tick(true);
  assert.equal(opens,1);assert.equal(searches,1,'paused worker remains stopped');
 }
 for(const response of [{ready:false,reopen:true},...['page_loading','page_timeout','content_unavailable','probe_timeout','navigation_uncommitted'].map(reason=>({ready:false,reason}))]){
  state={...CrowdCore.initial(),enabled:true,consent:CrowdCore.CONSENT};opens=probes=searches=0;
  await new CrowdAgent(runtime,api).tick();
  runtime.probe=async()=>response;
  // Keep the worker alive: this separately covers the old three-failure loop.
  now+=121000;state.last_tick=now;state.rejected=[{request:'preserve-evidence'}];
  await new CrowdAgent(runtime,api).tick();
  assert.equal(state.enabled,false);assert.equal(state.rejected[0].request,'preserve-evidence');
  now+=300000;await new CrowdAgent(runtime,api).tick();assert.equal(searches,1);assert.equal(opens,1);
 }
 console.log('PASS navigation checkpoint: worker loss after opening resumes probing without reopening or spending another search');
})().catch(e=>{console.error(e);process.exitCode=1;});
