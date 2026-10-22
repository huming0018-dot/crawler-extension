'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
vm.runInThisContext(fs.readFileSync('v4/src/api.js','utf8'));
const config={url:'https://test.supabase.co',key:'sb_publishable_test'};
const expired=()=>({user:{id:'one'},access_token:'old-access',refresh_token:'old-refresh',expires_at:0});
const response=(data,status=200)=>({ok:status===200,status,json:async()=>data});
const barrier=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(){
 let saved=expired(),refreshes=0,rpcs=0;
 const entered=barrier(),release=barrier();
 const api=new CrowdAPI(config,{get:async()=>structuredClone(saved),set:async(k,v)=>saved=structuredClone(v)},async(url,options)=>{
  if(url.includes('grant_type=refresh_token')){refreshes++;entered.resolve();await release.promise;return response({user:{id:'one'},access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});}
  if(url.endsWith('/logout'))return response({});
  if(url.includes('grant_type=password'))return response({user:{id:'two'},access_token:'two-access',refresh_token:'two-refresh',expires_in:3600});
  rpcs++;assert.equal(options.headers.Authorization,'Bearer new-access');return response({ok:true});
 });
 return {api,entered,release,state:()=>saved,counts:()=>({refreshes,rpcs})};
}
(async()=>{
 const f=await fixture(),abort=new AbortController();
 const results=Promise.allSettled([f.api.rpc('status',{},abort.signal),f.api.rpc('guard'),f.api.rpc('diagnostics')]);
 await f.entered.promise;abort.abort();f.release.resolve();
 const settled=await results;
 assert.equal(settled[0].reason.message,'cancelled');assert.equal(settled[1].status,'fulfilled');assert.equal(settled[2].status,'fulfilled');
 assert.deepEqual(f.counts(),{refreshes:1,rpcs:2});assert.equal(f.state().refresh_token,'new-refresh');
 for(const action of ['logout','login']){
  const g=await fixture(),pending=g.api.rpc('status').catch(e=>e);
  await g.entered.promise;
  if(action==='logout')await g.api.logout();else await g.api.login('two@example.test','test-password');
  g.release.resolve();assert.equal((await pending).message,'cancelled');
  assert.equal(g.state()?.user?.id,action==='logout'?undefined:'two');assert.equal(g.counts().rpcs,0);
 }
 const missing=new CrowdAPI(config,{get:async()=>null});await assert.rejects(missing.rpc('status'),/backend_login_required/);
 for(const status of [400,401]){
  const api=new CrowdAPI(config,{get:async()=>expired()},async()=>response({message:'expired'},status));
  await assert.rejects(api.rpc('status'),e=>e.message==='backend_login_required'&&e.status===401);
 }
 const valid={...expired(),expires_at:Date.now()+3600000};
 const unauthorized=new CrowdAPI(config,{get:async()=>valid},async()=>response({message:'JWT expired'},401));
 await assert.rejects(unauthorized.rpc('status'),/backend_login_required/);
 console.log('PASS auth: one refresh across status/collection/diagnostics, caller cancellation, logout/login cannot resurrect prior identity, backend/platform errors separated');
})().catch(e=>{console.error(e);process.exitCode=1;});
