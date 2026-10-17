'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
for(const file of ['core','agent'])vm.runInThisContext(fs.readFileSync('v4/src/'+file+'.js','utf8'));
const C=CrowdCore,id='a'.repeat(24),author='b'.repeat(24);
async function scenario(reject=false,gate=null){
 let now=Date.now(),state,expanded=0,delivered=false;const calls=[],parent=crypto.randomUUID();
 const task={id:1,query:'餐厅',anchor_terms:['餐厅'],target:1,received:0,lease_token:crypto.randomUUID(),lease_until:new Date(now+1200000).toISOString()};
 const comment=(id,text)=>({key:'comment-1',comment_id:id,parent_key:null,text,original_length:text.length,truncated:false,like_count:null,author_display:'甲',is_reply:false});
 const record=()=>({schema_version:4,standard:{platform:'xiaohongshu',note_id:id,url:C.HOST+'/explore/'+id,title:'餐厅',captured_at:new Date(now).toISOString(),published_at:null,author_display:'作者',like_count:1,collect_count:null,comment_count:3,view_count:null},extra:{author:{id:author,url:C.HOST+'/user/profile/'+author},author_opinion_quotes:[],comments:{items:[comment(expanded?'new':'old',expanded?'后来内容':'原来内容')],coverage:'visible_loaded_only',complete:false,captured_count:1,loaded_count:1,omitted_count:0,truncated:false,more_available:expanded===0}},evidence:{text:'好吃',original_length:2,truncated:false,parser_version:C.VERSION,source:'rendered_public_dom'}});
 state={...C.initial(),enabled:true,consent:C.CONSENT,profiles:true,phase:'note',task,note_id:id,note_url:C.HOST+'/explore/'+id,loaded_at:now-100000,dwell_ms:45000,scrolls:2,last_tick:now};
 const runtime={splitCapture:true,storage:{get:async()=>structuredClone(state),set:async(k,v)=>state=structuredClone(v)},now:()=>now,random:()=>0,uuid:crypto.randomUUID,schedule:async()=>{},cancel:async()=>{},close:async()=>{},open:async url=>{calls.push('open_profile');assert.equal(delivered,true);assert.equal(url,C.HOST+'/user/profile/'+author+'?xsec_token=local-only');},probe:async action=>{
  calls.push(action);if(action==='comments'){assert.equal(delivered,true,'base must be acknowledged before any expansion');expanded++;return gate?{ready:false,gate}:{ready:true};}
  if(action==='profile')return {ready:true,profile:{author_id:author}};
  return {ready:true,record:record(),author_navigation:C.HOST+'/user/profile/'+author+'?xsec_token=local-only'};
 }};
 const api={rpc:async(name,p)=>{
  calls.push(name);
  if(name==='guard')return {version:1,observations:1,ttl_ms:600000,paused:false,allowed:true,reason:null,wait_ms:0,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:1,comment:expanded,scroll:2}};
  if(name==='submit'){assert.equal(JSON.stringify(p.p_record).includes('local-only'),false);if(reject)return {error:'unrelated_note'};delivered=true;return {request:p.p_request,inserted:true,duplicate:false,task_received:1,gate:'received'};}
  if(name==='observe'){assert.equal(JSON.stringify(p).includes('local-only'),false);assert.equal(delivered,true);if(p.p_kind==='note'){assert.deepEqual(p.p_data.extra.comments.items.map(x=>x.comment_id),['old','new']);assert.equal(p.p_data.evidence.text,'好吃');}return {request:p.p_request,gate:'observed'};}
  if(name==='profile_claim')return {allowed:true,url:C.HOST+'/user/profile/'+author,token:parent};
  if(name==='finish')return {status:'complete',received:1};
  throw new Error('unexpected '+name);
 }};
 let i=0;
 while(i++<15){await new CrowdAgent(runtime,api).tick();now+=30000;
  if(!state.enabled || reject&&state.rejected.length || !state.enrichment&&calls.includes('open_profile')&&!state.outbox.length)break;}
 if(reject){assert.equal(expanded,0);assert.equal(state.rejected[0].reason,'unrelated_note');assert.equal(state.enrichment,null);}
 else if(gate){assert.equal(delivered,true);assert.equal(state.enabled,false);assert.equal(state.last_error,gate);assert.equal(calls.includes('open_profile'),false);}
 else {assert.equal(calls.filter(x=>x==='submit').length,1);assert.equal(calls.filter(x=>x==='observe').length,2);assert.equal(state.received,1);assert.equal(state.outbox.length,0);}
}
async function recheck(){
 const now=Date.now(),request=crypto.randomUUID(),record={standard:{captured_at:new Date(now).toISOString()},evidence:{text:'原文不可改'}};
 let state={...C.initial(),enabled:true,consent:C.CONSENT,task:{id:1,lease_token:'lease'},next_at:now+600000,rejected:[{request,task:1,record,reason:'unrelated_note'}]},submitted=0;
 const runtime={storage:{get:async()=>structuredClone(state),set:async(k,v)=>state=structuredClone(v)},now:()=>now,schedule:async()=>{}};
 const api={rpc:async(name,p)=>{
  if(name==='guard')return {version:1,relevance_revision:1,ttl_ms:600000,paused:false,allowed:false,reason:null,wait_ms:0,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:0,comment:0,scroll:0}};
  assert.equal(name,'submit');assert.equal(p.p_request,request);assert.deepEqual(p.p_record,record);submitted++;return {error:'unrelated_note'};
 }};
 await new CrowdAgent(runtime,api).tick();await new CrowdAgent(runtime,api).tick();
 assert.equal(submitted,1);assert.equal(state.rejected.length,1);assert.equal(state.rejected[0].relevance_revision,1);
}
(async()=>{await recheck();await scenario();await scenario(true);await scenario(false,'captcha');
 console.log('PASS observation agent: base before comments, unrelated rejection skips expansions, virtualized comments merged across restart, separate receipts and profile budget grant, captcha stops supplements without losing base');
})().catch(e=>{console.error(e);process.exitCode=1;});
