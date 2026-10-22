'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
for(const file of['core','agent'])vm.runInThisContext(fs.readFileSync('v4/src/'+file+'.js','utf8'));
async function fixture({cap=240,taskCap=240,taskIDs=[13,14],runIDs=[13,14],taskID=13,detail=60,gap=2000}={}){
 const s={...CrowdCore.initial(),task:{id:taskID,daily_comment_cap:taskCap,acceptance_task_ids:taskIDs},test_run:{state:'active',task_ids:runIDs}},a=new CrowdAgent({now:()=>1791795600000},{rpc:async()=>({version:1,ttl_ms:600000,paused:false,allowed:true,reason:null,wait_ms:0,gap_ms:gap,caps:{search:30,detail,comment:cap,scroll:120},counts:{search:7,detail:28,comment:96,scroll:0}})});await a.control(s,'control',()=>{});return s;
}
(async()=>{
 assert.equal((await fixture()).control.caps.comment,240);
 assert.equal((await fixture({cap:320,taskCap:320})).control.caps.comment,320);
 for(const args of[{taskCap:120},{taskCap:null},{taskIDs:[14,13]},{runIDs:[13]},{runIDs:null},{taskID:99},{cap:321},{cap:320,taskCap:241},{detail:61},{gap:999}])await assert.rejects(fixture(args),/control_unavailable/,JSON.stringify(args));
 assert.equal((await fixture({cap:120,taskCap:null,taskIDs:null,runIDs:null})).control.caps.comment,120);
 console.log('PASS actual control cap240/320 only exact explicit task budget+bound ordered IDs; default120 unchanged; wrong/missing IDs/321/unconfigured241/detail61/gap999 rejected');
})().catch(e=>{console.error(e);process.exit(1);});
