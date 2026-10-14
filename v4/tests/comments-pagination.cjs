const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),crypto=require('crypto');

async function simulate(stuck=false){
 const context=vm.createContext({console,TextEncoder});vm.runInContext(fs.readFileSync('v4/src/core.js','utf8'),context);
 let source=fs.readFileSync('v4/src/agent.js','utf8');
 vm.runInContext(source,context);let now=Date.now(),actions=0;const comments=()=>{const n=actions>=2&&!stuck?39:31;return {items:Array.from({length:n},(_,i)=>({key:'comment-'+i,comment_id:String(i),text:'c',original_length:1,is_reply:false,truncated:false})),loading:false,truncated:false,more_available:false,progress:{top:stuck?(actions%2?100:200):100,height:700,at_end:true,end_marker:n===39,expand_count:0,empty:false},captured_count:n};};
 const record=()=>({standard:{platform:'xiaohongshu',note_id:'a'.repeat(24),comment_count:39},extra:{comments:comments()}});
 const runtime={now:()=>now,uuid:crypto.randomUUID,probe:async action=>{if(action==='comments'){actions++;return {ready:true};}return {ready:true,record:record()};}};
 const agent=new context.CrowdAgent(runtime,{});agent.save=async()=>{};agent.admit=async()=>true;
 const state={profiles:false,notes_in_session:0,outbox:[],task:{id:10,lease_token:'fixture',lease_until:new Date(now+1200000).toISOString(),comments_capture:true},enrichment:{stage:'comments',repair:true,parent:crypto.randomUUID(),record:record(),last:null,stalls:0,rounds:0}};
 for(let i=0;i<20&&state.enrichment;i++){await agent.enrich(state,()=>{},undefined);now+=1001;}
 return {actions,phase:state.phase,summary:state.outbox[0]?.record.summary};
}
(async()=>{const after=await simulate();assert.equal(after.actions,3);assert.equal(after.summary.captured_count,39);assert.equal(after.summary.complete,true);const stuckResult=await simulate(true);assert.equal(stuckResult.actions,3);assert.equal(stuckResult.summary.complete,false);assert.equal(stuckResult.summary.capture_reason,'loaded_stall');console.log('PASS comment pagination: 31/39 queues complete capture; moving scroll without new content stops partial');})().catch(e=>{console.error(e);process.exit(1)});
