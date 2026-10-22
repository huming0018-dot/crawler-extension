'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
for(const file of ['core','agent'])vm.runInThisContext(fs.readFileSync('v4/src/'+file+'.js','utf8'));
const C=CrowdCore;
(async()=>{
 let now=Date.now(),calls=[],state={...C.initial(),timing_version:1,enabled:true,consent:C.CONSENT,phase:'note',wait_kind:'page',next_at:now+30000,fast_note:true,note_id:'a'.repeat(24),loaded_at:null,scrolls:0,page_deadline:now+180000,last_tick:now,
 task:{id:1,query:'餐厅',target:1,received:0,lease_token:'lease',lease_until:new Date(now+1e7).toISOString()}};
 const record={schema_version:4,standard:{platform:'xiaohongshu',note_id:state.note_id,url:C.HOST+'/explore/'+state.note_id,title:'餐厅',captured_at:new Date(now).toISOString(),published_at:null,author_display:null,like_count:null,collect_count:null,comment_count:0},extra:{author_opinion_quotes:[]},evidence:{text:'餐厅正文',original_length:4,truncated:false,parser_version:C.VERSION,source:'rendered_public_dom'}};
 const r={storage:{get:async()=>structuredClone(state),set:async(_,s)=>state=structuredClone(s)},now:()=>now,random:()=>0,uuid:crypto.randomUUID,schedule:async()=>{},cancel:async()=>{},close:async()=>{},probe:async action=>{calls.push(action);return {ready:true,record:structuredClone(record)};}};
 const api={rpc:async(name,p)=>{
  calls.push(name);if(name==='guard')return {version:1,ttl_ms:600000,paused:false,allowed:true,reason:null,wait_ms:0,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:1,comment:0,scroll:0}};
  if(name==='submit'){assert.equal(state.outbox[0].request,p.p_request);return {request:p.p_request,gate:'received',inserted:true,duplicate:false,task_received:1};}throw Error('unexpected');
 }};
 const agent=new CrowdAgent(r,api);await agent.pageReady(state.note_id,null);assert.equal(state.received,1);assert.equal(calls.includes('scroll'),false,'ready body does not require scrolling or dwell');assert.equal(state.data_ready_at,now);
 calls=[];state={...state,phase:'note',wait_kind:'retry',retry_at:now+60000,next_at:now+60000};await agent.pageReady(state.note_id,null);assert.equal(calls.length,0);
 delete state.timing_version;state.wait_kind='page';const deadline=state.next_at;await agent.pageReady(state.note_id,null);assert.equal(calls.length,0);assert.equal(state.next_at,deadline,'legacy wait is conservative');
 // Use the actual account adapter and reuse the same worker across identities.
 let raw={session:{user:{id:'A'}},'agent:A':{...C.initial(),run_generation:0},'agent:B':{...C.initial(),run_generation:0}};
 const account=C.accountStorage({get:async key=>structuredClone(raw[key]),set:async(key,value)=>raw[key]=structuredClone(value)});
 const switched=new CrowdAgent({...r,storage:account,owner:async()=>raw.session?.user?.id},api);
 await switched.stop();raw.session={user:{id:'B'}};const b=await switched.read();b.consent=C.CONSENT;await switched.save(b);assert.equal(raw['agent:B'].consent,C.CONSENT);assert.equal(raw['agent:A'].enabled,false);
 raw.session=null;await switched.stop();assert.equal(raw['agent:signed-out'].enabled,false);
 console.log('PASS fast DOM agent: immediate ready capture without dwell/scroll, retry and conservative legacy deadline retained, same-worker existing-account switch and signed-out stop');
})().catch(error=>{console.error(error);process.exitCode=1;});
