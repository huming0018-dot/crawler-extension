'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
for(const name of ['api','core','agent'])vm.runInThisContext(fs.readFileSync('v4/src/'+name+'.js','utf8'));
const config={url:'https://fixture.supabase.co',key:'sb_publishable_test'};
const initial=()=>({user:{id:'one'},access_token:'old-access',refresh_token:'old-refresh',expires_at:Date.now()+3600000});
const response=(data,status=200)=>({ok:status===200,status,json:async()=>data});
const barrier=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(mode='ok'){
 let saved=initial();const calls=[],first=barrier(),later=barrier();
 const api=new CrowdAPI(config,{get:async()=>structuredClone(saved),set:async(_,v)=>saved=structuredClone(v)},async(url,options)=>{
  calls.push({url,body:options.body,token:options.headers.Authorization});
  if(url.includes('grant_type=refresh_token'))return response({user:{id:'one'},access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});
  if(url.includes('grant_type=password'))return response({user:{id:'two'},access_token:'two-access',refresh_token:'two-refresh',expires_in:3600});
  if(mode==='offline')throw Error('network unknown');
  if(mode==='business')return response({message:'login_required',code:'PT401'},401);
  if(mode==='permission')return response({message:'permission denied',code:'42501'},403);
  if(options.headers.Authorization==='Bearer old-access'){
   if(mode==='late' && url.endsWith('_status')){first.resolve();await later.promise;}
   return response({message:'JWT expired',code:'PGRST301'},401);
  }
  if(mode==='twice')return response({message:'JWT invalid',code:'PGRST303'},401);
  return response({request:JSON.parse(options.body).p_request,gate:'received'});
 });
 return {api,calls,first,later,state:()=>saved};
}
(async()=>{
 let f=fixture();const params={p_request:'same-request-id',p_record:{text:'same-content'}};
 const result=await f.api.rpc('submit',params);assert.equal(result.request,params.p_request);
 assert.equal(f.calls.length,3);assert.equal(f.calls[0].body,f.calls[2].body);assert.equal(f.calls[2].token,'Bearer new-access');
 f=fixture();await Promise.all([f.api.rpc('claim'),f.api.rpc('status'),f.api.rpc('guard')]);
 assert.equal(f.calls.filter(c=>c.url.includes('grant_type=refresh')).length,1,'concurrent JWT rejection shares one refresh');
 f=fixture('late');const delayed=f.api.rpc('status');await f.first.promise;await f.api.rpc('claim');f.later.resolve();await delayed;
 assert.equal(f.calls.filter(c=>c.url.includes('grant_type=refresh')).length,1,'late old-token rejection reuses fresh access');
 for(const mode of ['offline','business','permission','twice']){
  f=fixture(mode);await assert.rejects(f.api.rpc('submit',params),e=>e.message===({offline:'network unknown',business:'backend_login_required',permission:'backend_permission_denied',twice:'backend_login_required'})[mode]);
  assert.equal(f.calls.length,mode==='twice'?3:1,mode+' must not blindly replay');
  assert.equal(f.state().user.id,'one');
 }
 f=fixture('late');const prior=f.api.rpc('status').catch(e=>e);await f.first.promise;await f.api.login('two@example.test','fixture');f.later.resolve();assert.equal((await prior).message,'cancelled');assert.equal(f.state().user.id,'two');assert.equal(f.calls.filter(c=>c.url.includes('grant_type=refresh')).length,0);
 // The real actor keeps note/rating IDs and stops delivery on a permission denial.
 for(const status of [401,403]){
  let state={...CrowdCore.initial(),consent:CrowdCore.CONSENT,enabled:true,delivery_enabled:true,outbox:[{request:'stable-rating',kind:'rating',proof:12,score:4,reason:'这是足够长的真实评价'}]};
  const runtime={now:Date.now,storage:{get:async()=>structuredClone(state),set:async(_,v)=>state=structuredClone(v)},cancel:async()=>{},cancelDelivery:async()=>{},scheduleDelivery:async()=>{throw Error('delivery must stay stopped');}};
  const agent=new CrowdAgent(runtime,{rpc:async()=>{throw Object.assign(Error('denied'),{status});}});
  await agent.step(()=>{},null,true);assert.equal(state.enabled,false);assert.equal(state.delivery_enabled,false);assert.equal(state.outbox[0].request,'stable-rating');assert.equal(state.outbox[0].reason,'这是足够长的真实评价');assert.equal(state.delivery_error,status===403?'backend_permission_denied':'backend_login_required');
 }
 // Actual test-batch cleanup must not re-enable delivery after auth failure.
 for(const status of [401,403])for(const hasOutbox of [false,true]){
  const now=Date.now(),day=new Date(now+8*3600000).toISOString().slice(0,10);
  let state={...CrowdCore.initial(),consent:CrowdCore.CONSENT,enabled:true,delivery_enabled:true,day,assignment_refresh:true,test_run:{id:'run',state:'active',day,expires_at:now+60000,accepted:[],attempts:0,limit:2},outbox:hasOutbox?[{request:'stable-test-rating',kind:'rating',proof:12,score:4,reason:'这是足够长的真实评价'}]:[]},closes=0,calls=0;
  const runtime={now:()=>now,storage:{get:async key=>key==='agent'?structuredClone(state):undefined,set:async(_,v)=>state=structuredClone(v)},cancel:async()=>{},cancelDelivery:async()=>{},scheduleDelivery:async()=>{},close:async()=>{closes++;}};
  const agent=new CrowdAgent(runtime,{rpc:async()=>{calls++;throw Object.assign(Error('denied'),{status});}});
  await agent.tick();await agent.stopActive;
  assert.equal(state.enabled,false);assert.equal(state.delivery_enabled,false);assert.equal(state.delivery_error,status===403?'backend_permission_denied':'backend_login_required');assert.equal(state.test_run.state,'stopped');assert.equal(closes,0,'auth failure keeps existing page');
  assert.equal(state.outbox.length,hasOutbox?1:0);if(hasOutbox)assert.equal(state.outbox[0].request,'stable-test-rating');
  await agent.tick(false,true);assert.equal(calls,1,'later upload alarm must not retry');
 }
 // Ordinary completion retains the original drain policy.
 {let saved;const agent=new CrowdAgent({now:Date.now,storage:{get:async()=>undefined,set:async(_,v)=>saved=v}},{});await agent.endTest({test_run:{state:'active'},outbox:[]},'test_completed');assert.equal(saved.delivery_enabled,true);assert.equal(agent.testStop.drain,true);}
 console.log('PASS auth recovery: definitive JWT rejection single retry; concurrent and delayed refresh; stable write ID; no network/business/403 retry; account switch cancellation; 401/403 preserve real actor outbox');
})().catch(e=>{console.error(e);process.exitCode=1;});
