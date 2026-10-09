'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=process.env.CROWD_TEST_SOURCE||'v4/src';
for(const name of ['core','agent'])vm.runInThisContext(fs.readFileSync(path.join(source,name+'.js'),'utf8'));
// Exercise the real schedule method together with idle -> admission -> open.
const background=fs.readFileSync(path.join(source,'background.js'),'utf8');
const start=background.indexOf('  async schedule('),end=background.indexOf('\n  cancel:',start);
assert.ok(start>=0&&end>start);
(async()=>{
 for(const delay of [0,1000,25000]){
  let now=Date.now(),alarm=null,opens=0,searches=0,probes=0;
  let state={...CrowdCore.initial(),enabled:true,consent:CrowdCore.CONSENT,rejected:[{request:'retained-proof'}]};
  const chrome={alarms:{get:async()=>alarm,create:async(_,v)=>{alarm={...v,scheduledTime:v.when};}}};
  const schedule=vm.runInNewContext('({'+background.slice(start,end).trim()+'}).schedule',{chrome,Date:{now:()=>now},Math,Number});
  const runtime={storage:{get:async()=>structuredClone(state),set:async(_,s)=>state=structuredClone(s)},now:()=>now,
   schedule,cancel:async()=>{alarm=null;},open:async()=>{opens++;},probe:async()=>{probes++;return {ready:false,reason:'page_loading'};}};
  const api={rpc:async(name,p)=>{
   if(name==='claim')return {task:{id:1,query:'fixture',lease_token:'test',lease_until:new Date(now+1200000).toISOString(),received:0,target:2}};
   assert.equal(name,'guard');if(p.p_action==='search'){searches++;now+=delay;}
   return {version:1,ttl_ms:600000,paused:false,allowed:true,reason:null,wait_ms:0,gap_ms:30000,
    caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:searches,detail:0,comment:0,scroll:0}};
  }};
  const agent=new CrowdAgent(runtime,api);await agent.tick();
  const openedAt=now;
  assert.equal(opens,1);assert.equal(searches,1);assert.equal(state.page_deadline,openedAt+30000);
  assert.equal(alarm.scheduledTime,state.page_deadline,'slow admission must replace the earlier pre-admission heartbeat');
  now+=29000;await agent.tick();
  assert.equal(probes,0);assert.equal(alarm.scheduledTime,state.page_deadline,'early page events must not postpone this new deadline');
  now=alarm.scheduledTime;alarm.scheduledTime+=30000;await agent.tick();
  assert.equal(probes,1);assert.equal(state.enabled,false);assert.equal(state.last_error,'page_loading');assert.equal(alarm,null);
  assert.equal(now-openedAt,30000);assert.equal(state.rejected[0].request,'retained-proof');
  now+=60000;await agent.tick(true);assert.equal(opens,1);assert.equal(searches,1);assert.equal(probes,1);
 }
 console.log('PASS initial search: 0/1/25s guard delay, one deadline wake, no early-event postponement or repeated admission');
})().catch(e=>{console.error(e);process.exitCode=1;});
