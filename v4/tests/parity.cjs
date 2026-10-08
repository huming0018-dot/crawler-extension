'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
for(const file of ['core','agent'])vm.runInThisContext(fs.readFileSync('v4/src/'+file+'.js','utf8'));
(async()=>{
 let now=Date.now(),state={...CrowdCore.initial(),enabled:true,delivery_enabled:true,consent:CrowdCore.CONSENT},alarm=false,requests=[],offline=true;
 const runtime={storage:{get:async()=>structuredClone(state),set:async(_,v)=>state=structuredClone(v)},now:()=>now,uuid:crypto.randomUUID,
  schedule:async()=>{},cancel:async()=>{},close:async()=>{},scheduleDelivery:async()=>{alarm=true;},cancelDelivery:async()=>{alarm=false;},
  open:async()=>{throw Error('stopped collection opened a page');},probe:async()=>{throw Error('stopped collection read a page');}};
 const api={rpc:async(name,p)=>{requests.push([name,p]);assert.ok(['submit','rating'].includes(name),'delivery cannot request control/tasks');
  if(offline)throw Error('offline');if(name==='rating')return {request:p.p_request,gate:'rated',inserted:true};
  return {request:p.p_request,gate:'received',inserted:true,duplicate:false,task_received:1};}};
 const agent=new CrowdAgent(runtime,api),request=crypto.randomUUID();
 state.outbox=[{request,task:1,lease:'kept',record:{standard:{note_id:'a'.repeat(24)}}}];
 await agent.stop('user_stopped',{drain:true});assert.equal(alarm,true);assert.equal(state.enabled,false);
 await agent.tick(false,true);assert.equal(state.outbox[0].request,request);assert.ok(state.outbox[0].retry_at>now);
 const count=requests.length;await new CrowdAgent(runtime,api).tick(false,true);assert.equal(requests.length,count,'worker restart respects the same retry deadline');
 now=state.outbox[0].retry_at+1;offline=false;await agent.tick(false,true);
 assert.equal(state.outbox.length,0);assert.equal(state.enabled,false);assert.equal(state.last_error,'user_stopped');assert.equal(alarm,false);
 assert.equal(requests[0][1].p_request,requests[1][1].p_request,'retry retains the original receipt identity');
 await agent.queueRating(1,5,'确实吃过这里的清蒸鱼');const ratingId=state.outbox[0].request;
 await assert.rejects(agent.queueRating(1,5,'确实吃过这里的清蒸鱼'),/rating_queued/);
 await agent.tick(false,true);assert.equal(requests.at(-1)[1].p_request,ratingId);assert.equal(state.outbox.length,0);assert.equal(state.enabled,false);
 await assert.rejects(agent.queueRating(1,0,'确实吃过这里的清蒸鱼'),/invalid_rating/);
 await agent.queueRating(2,4,'本人实际用餐后的评价');await agent.stop('logged_out');const before=requests.length;
 await agent.tick(false,true);assert.equal(requests.length,before);assert.equal(state.outbox.length,1);assert.equal(alarm,false);
 state.delivery_enabled=true;state.consent=null;alarm=true;await agent.tick(false,true);
 assert.equal(requests.length,before);assert.equal(state.delivery_enabled,false);assert.equal(alarm,false,'consent withdrawal also cancels delivery');
 console.log('PASS Kimi parity: stop only collection, offline queue survives worker restart, retry UUID stable, optional rating queued, logout stops delivery');
})().catch(e=>{console.error(e);process.exitCode=1;});
