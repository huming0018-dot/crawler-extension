const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),crypto=require('crypto');
for(const name of ['core','agent'])vm.runInThisContext(fs.readFileSync('v4/src/'+name+'.js','utf8'));
const cases=[];
const row=(id,parent=null)=>({key:'comment-'+id,comment_id:id,parent_comment_id:parent,parent_key:parent?'comment-'+parent:null,is_reply:!!parent,text:'text',original_length:4,truncated:false});
function summary(change={},reported=238){
 const items=Array.from({length:227},(_,i)=>row(String(i+1),i>73?'1':null));
 const comments={items,capture_reason:'loaded_end',truncated:false,identity_uncertain:false,loading:false,media_pending:false,more_available:false,terminal_stable:true,reply_coverage:{root_count:74,declared_count:153,loaded_count:153,pending_groups:0},dom_census:{document:'same-document',visible_count:227,skipped_count:0,duplicate_count:0,unresolved_parent_count:0},progress:{end_marker:true,at_end:true,expand_count:0},...change};
 const s={...CrowdCore.initial(),task:{id:1,comments_capture:true}},e={parent:crypto.randomUUID(),record:{standard:{note_id:'a'.repeat(24),comment_count:reported},extra:{comments}}};
 new CrowdAgent({now:()=>1000,uuid:crypto.randomUUID},{}).queueCommentPages(s,e);
 assert.equal(s.outbox.length,5);assert(s.outbox.every(x=>JSON.stringify(x.record.summary)===JSON.stringify(s.outbox[0].record.summary)));
 return s.outbox[0].record.summary;
}
let result=summary();assert.equal(result.complete,false);assert.equal(result.visible_complete,true);assert.equal(result.count_gap,11);assert.equal(result.count_mismatch,true);cases.push('238_vs227_visible_true_full_false_unchanged_reported');
for(const [name,change]of Object.entries({unstable:{terminal_stable:false},loading:{loading:true},media_pending:{media_pending:true},truncated:{truncated:true},unknown_id:{identity_uncertain:true},more:{more_available:true},skip:{dom_census:{document:'same-document',visible_count:228,skipped_count:1,duplicate_count:0,unresolved_parent_count:0}},duplicate:{dom_census:{document:'same-document',visible_count:227,skipped_count:0,duplicate_count:1,unresolved_parent_count:0}},missing_parent:{dom_census:{document:'same-document',visible_count:227,skipped_count:0,duplicate_count:0,unresolved_parent_count:1}},no_document:{dom_census:{visible_count:227,skipped_count:0,duplicate_count:0,unresolved_parent_count:0}},expand:{progress:{end_marker:true,at_end:true,expand_count:1}},no_end:{progress:{end_marker:false,at_end:true,expand_count:0}}})) {assert.equal(summary(change).visible_complete,false,name);cases.push(name+'_not_visible_complete');}
assert.equal(summary({},null).count_gap,null);assert.equal(summary({},226).count_gap,-1);assert.equal(summary({},227).complete,true);cases.push('unknown_overcount_exact_report_preserved');
async function latency(){
 let now=100000,counts=0,next=0,sourceActions=0;const s={...CrowdCore.initial(),task:{id:1}},r={now:()=>now,storage:{get:async()=>s,set:async()=>{}},sourceHealth:async()=>{},schedule:async()=>{}},api={rpc:async()=>{const admitted=now>=next;if(admitted){counts++;next=now+1000;}const value={version:1,ttl_ms:600000,paused:false,allowed:admitted,reason:admitted?null:'action_gap',wait_ms:admitted?0:next-now,action_wait_ms:Math.max(0,next-now),gap_ms:1000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:0,comment:counts,scroll:0}};now+=420;return value;}};
 const a=new CrowdAgent(r,api);await a.initializeGeneration();
 for(let i=0;i<4;i++){assert(await a.admit(s,'comment',()=>{}));sourceActions++;assert.equal(s.action_not_before,100000+(i+1)*1000);now=s.action_not_before;}
 assert.equal(counts,4);assert.equal(sourceActions,4);cases.push('420ms_RPC_not_added_to_each_server_interval_every_source_action_still_online_guarded');
 now=next-200;assert.equal(await a.admit(s,'comment',()=>{}),false);assert.equal(counts,4);assert.equal(sourceActions,4);cases.push('early_attempt_denied_no_source_action_no_extra_counter');
}
(async()=>{await latency();console.log('PASS coverage and latency '+cases.length+' cases');fs.writeFileSync('COVERAGE_LATENCY_TEST.json',JSON.stringify({pass:true,cases},null,2));})().catch(e=>{console.error(e.stack);process.exitCode=1;});
