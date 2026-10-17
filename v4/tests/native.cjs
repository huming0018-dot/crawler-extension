'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
let clock=Date.now(),state={},calls=[],release,enter;const blocked=new Promise(r=>release=r),entered=new Promise(r=>enter=r);
let waiting=true;const task={id:1,query:'测试餐厅',received:0,target:1,lease_token:crypto.randomUUID(),lease_until:new Date(clock+1200000).toISOString()};
const context=vm.createContext({console,URL,URLSearchParams,Uint8Array,Event,AbortController,Math,setTimeout,clearTimeout,crypto:crypto.webcrypto,
 Date:class extends Date { static now(){return clock;} },document:{addEventListener:()=>{},hidden:false},dispatchEvent:()=>{},
 CROWD_CONFIG:{url:'https://test.supabase.co',key:'sb_publishable_test',portal:'https://crowd.example.test',platform:'android'},
 fetch:async(url,options)=>{
  let body;if(url.endsWith('/api/crowd/enroll')){enter();if(waiting)await blocked;body={email:'test@crowd.invalid',joined:true};}
  else if(url.includes('grant_type=password'))body={user:{id:'test-user'},refresh_token:'TEST_REFRESH',access_token:'TEST_ACCESS',expires_in:3600};
  else if(url.endsWith('_status'))body={participant:{status:'approved'}};
  else if(url.endsWith('_guard'))body={version:1,ttl_ms:600000,paused:false,allowed:true,reason:null,wait_ms:0,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:0,comment:0,scroll:0},session_count:0};
  else if(url.endsWith('_claim'))body={task};else body={};
  return {ok:true,json:async()=>body};
 }});
context.CrowdHost={postMessage:text=>{const {id,method,params:p}=JSON.parse(text);calls.push(method);let data=null;
 if(method==='get')data=state[p.key]??null;if(method==='set')state[p.key]=structuredClone(p.value);
 if(method==='probe')data={ready:false,gate:'captcha'};
 if(method==='background')data={collect_allowed:true};
 queueMicrotask(()=>context.CrowdBridgeReply(id,{ok:true,data}));
}};
for(const name of ['core','api','agent','join','native-runtime'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src',name+'.js'),'utf8'),context);
(async()=>{
 const native=context.CrowdNative,C=context.CrowdCore;let result=await native.command('state',{});assert.equal(result.data.agent.enabled,false);assert.equal(calls.includes('begin'),false);
 await native.receiveInvite('foodcrowd://join#invite='+'a'.repeat(64));assert.equal((await native.command('state',{})).data.invited,true);assert.equal(calls.includes('begin'),false);
 assert.equal((await native.command('join',{consent:'wrong'})).error,'consent_required');
 const joining=native.command('join',{consent:C.CONSENT});await entered;await native.command('stop',{});release();result=await joining;
 assert.equal(result.ok,false);assert.equal(result.error,'cancelled');assert.equal(calls.includes('begin'),false,'stop during enrollment must prevent later automatic start');
 assert.equal((await native.command('state',{})).data.agent.enabled,false);
 waiting=false;await native.receiveInvite('a'.repeat(64));assert.equal((await native.command('join',{consent:C.CONSENT})).ok,true);
 assert.equal((await native.command('state',{})).data.agent.enabled,true);await native.wake();clock+=31000;await native.wake();
 result=await native.command('state',{});assert.equal(result.data.agent.last_error,'captcha');assert.equal(result.data.agent.enabled,false);assert.ok(calls.lastIndexOf('end')>calls.lastIndexOf('probe'),'platform gate must also end the native background batch');
 assert.equal(JSON.stringify(result).includes('TEST_ACCESS'),false);assert.equal(JSON.stringify(result).includes(state.install_secret),false);
 console.log('PASS native bridge: no silent start, invitation handoff, explicit consent, stop during registration, one-click start, captcha ends batch, no credential exposure');
})().catch(e=>{console.error(e);process.exitCode=1;});
