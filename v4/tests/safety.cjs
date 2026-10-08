'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
for(const file of ['core','agent'])vm.runInThisContext(fs.readFileSync('v4/src/'+file+'.js','utf8'));
(async()=>{
 let now=Date.now(),state={agent:{...CrowdCore.initial(),enabled:true,consent:CrowdCore.CONSENT}},actions=[],requests=[],offline=false,paused=false,version=1,deny=false;
 const task={id:1,query:'测试餐厅',target:2,received:0,lease_token:crypto.randomUUID(),lease_until:new Date(now+1e8).toISOString()};
 const policy=()=>({version,ttl_ms:600000,paused,allowed:!deny&&!paused,reason:paused?'global_pause':deny?'action_budget':null,wait_ms:deny?60000:0,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:0,comment:0,scroll:0},session_count:0});
 const runtime={storage:{get:async k=>structuredClone(state[k]),set:async(k,v)=>state[k]=structuredClone(v)},now:()=>now,random:()=>0,uuid:crypto.randomUUID,schedule:async()=>{},cancel:async()=>{},close:async()=>{},open:async()=>actions.push('open'),probe:async action=>{actions.push(action);return {gate:'rate_limit'};}};
 const api={rpc:async(name,p)=>{requests.push([name,p?.p_action]);if(name==='status')return {participant:{status:'approved'}};if(name==='guard'){if(offline)throw new Error('offline');return policy();}if(name==='claim')return {task};if(name==='submit')return {inserted:false,duplicate:true,task_received:0,request:p.p_request,gate:'received'};}};
 let agent=new CrowdAgent(runtime,api);
 await agent.tick();assert.equal(actions.length,1);
 now+=45000;await agent.tick();assert.equal(state.agent.last_error,'rate_limit');assert.equal(state.agent.enabled,false);
 const deadline=state.agent.next_at,before=actions.length;
 await agent.start();await agent.tick(true);assert.equal(state.agent.next_at,deadline);assert.equal(actions.length,before,'Continue and wake preserve the hard deadline');
 agent=new CrowdAgent(runtime,api);await agent.start();await agent.tick();assert.equal(actions.length,before,'worker reconstruction preserves the deadline');
 // Even an interrupted offline risk report is durably retried before collection.
 state.agent={...CrowdCore.initial(),enabled:true,consent:CrowdCore.CONSENT,pending_risk:'rate_limit'};offline=true;
 await agent.tick();assert.equal(actions.length,before);assert.equal(state.agent.pending_risk,'rate_limit');
 offline=false;await agent.start();await agent.tick();assert.ok(requests.some(([name,action])=>name==='guard'&&action==='rate_limit'));assert.equal(state.agent.pending_risk,null);
 // Active task + long wait cannot suppress control refresh or lock global pause on.
 state.agent.next_at=now+1e7;paused=true;now+=300001;await agent.tick();assert.equal(state.agent.control.paused,true);
 paused=false;version++;now+=300001;await agent.tick();assert.equal(state.agent.control.paused,false);
 // Expired/invalid control allows delivery of queued evidence, never new page access.
 const marker=actions.length;offline=true;now+=600001;state.agent.next_at=0;
 state.agent.outbox=[{request:crypto.randomUUID(),task:1,lease:task.lease_token,record:{standard:{note_id:'a'.repeat(24)}}}];
 await agent.tick();assert.equal(state.agent.outbox.length,0);await agent.tick();assert.equal(actions.length,marker);assert.equal(state.agent.last_error,'control_unavailable');
 offline=false;version=0;state.agent.control_checked=0;await agent.tick();assert.equal(actions.length,marker);
 // Denial must not consume the candidate or perform its navigation.
 version=3;deny=true;state.agent={...CrowdCore.initial(),enabled:true,consent:CrowdCore.CONSENT,task,phase:'search_done',candidates:['https://www.xiaohongshu.com/explore/'+'a'.repeat(24)]};
 await agent.tick();assert.equal(state.agent.candidates.length,1);assert.equal(actions.length,marker);assert.equal(state.agent.last_error,'action_budget');
 await agent.stop();const stopped=requests.length;now+=600001;await agent.tick(true);assert.equal(requests.length,stopped,'explicit stop stops task/control network IO');
 console.log('PASS safety lifecycle: Continue/restart/wake retain cooldown, interrupted risk report fails closed, cached tasks cannot suppress pause/resume, expired policy still flushes evidence, budget denial retains candidate, user stop is final');
})().catch(e=>{console.error(e);process.exitCode=1;});
