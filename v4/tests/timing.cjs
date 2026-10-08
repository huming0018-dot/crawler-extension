'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
for(const f of ['core','agent'])vm.runInThisContext(fs.readFileSync('v4/src/'+f+'.js','utf8'));
const C=CrowdCore;
async function scenario({more=false,total=null,growing=false,deny=false}={}){
 let now=Date.now(),attempts=0,denied=deny,round=0;
 const id='a'.repeat(24),task={id:1,query:'测试餐厅',target:2,received:0,lease_token:crypto.randomUUID(),lease_until:new Date(now+1200000).toISOString()};
 let state={...C.initial(),enabled:true,consent:C.CONSENT,phase:'note',task,note_id:id,note_url:C.HOST+'/explore/'+id,loaded_at:now-100000,dwell_ms:90000,scrolls:2,last_tick:now};
 const record=()=>{const text='测试餐厅这道菜味道不错。';const items=growing?[{key:'comment-1',parent_key:null,text:'内容'+attempts,original_length:3,like_count:null,truncated:false}]:[];
 return {schema_version:4,standard:{platform:'xiaohongshu',note_id:id,url:C.HOST+'/explore/'+id,title:'测试餐厅',captured_at:new Date(now).toISOString(),published_at:null,author_display:null,like_count:null,collect_count:null,comment_count:total},extra:{author_opinion_quotes:[],comments:{items,coverage:'visible_loaded_only',complete:false,captured_count:items.length,truncated:false,more_available:more,panel_found:true}},evidence:{text,original_length:text.length,truncated:false,source:'rendered_public_dom',parser_version:C.VERSION}};};
 const runtime={storage:{get:async()=>structuredClone(state),set:async(k,v)=>state=structuredClone(v)},now:()=>now,random:()=>0,uuid:crypto.randomUUID,schedule:async()=>{},cancel:async()=>{},close:async()=>{},probe:async action=>{if(action==='comments'){attempts++;return {ready:true};}return {ready:true,record:record()};}};
 const api={rpc:async(name,p)=>{assert.equal(name,'guard');const blocked=p.p_action==='comment'&&denied&&attempts===1;
 return {version:1,ttl_ms:600000,paused:false,allowed:!blocked,reason:blocked?'action_gap':null,wait_ms:blocked?40000:0,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:0,comment:attempts,scroll:2}};}};
 while(!state.outbox.length&&round++<12){await new CrowdAgent(runtime,api).tick();
  if(deny&&round===3){assert.equal(state.comment_stalls,1,'admission retries cannot count the same stagnant result twice');assert.equal(attempts,1);denied=false;}
  now=Math.max(now+30000,state.next_at);}
 assert.equal(state.outbox.length,1,'bounded loop must preserve the captured evidence');assert.equal(state.outbox[0].record.extra.comments.complete,false,'early stop never claims full coverage');
 assert.equal(state.outbox[0].record.evidence.text,'测试餐厅这道菜味道不错。');return attempts;
}
(async()=>{
 assert.equal(await scenario({total:0}),0,'explicit zero skips needless expansion');
 assert.equal(await scenario(),1,'unknown total gets a discovery attempt, then stops without progress');
 assert.equal(await scenario({more:true}),2,'visible expansion control gets one grace attempt');
 assert.equal(await scenario({more:true,deny:true}),2,'restart and admission denial preserve stall accounting');
 assert.equal(await scenario({growing:true}),4,'same count with changed contents is progress; original hard cap stays four');
 console.log('PASS timing: zero comments 0 attempts, no progress 1, stalled button 2, real progress up to 4; restart/denial preserves counters and evidence');
})().catch(e=>{console.error(e);process.exitCode=1;});
