'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
for(const file of ['core','agent'])vm.runInThisContext(fs.readFileSync('v4/src/'+file+'.js','utf8'));
(async()=>{
 let now=Date.now(),opened=[],requests=[],finishReply={},probeReply={ready:true,links:[]};
 const id='a'.repeat(24),other='b'.repeat(24),url=x=>CrowdCore.HOST+'/explore/'+x;
 let task={id:1,query:'测试餐厅',received:0,target:5,lease_token:crypto.randomUUID(),lease_until:new Date(now+1e7).toISOString(),known_note_ids:[id]};
 let state;
 const reset=extra=>state={...CrowdCore.initial(),enabled:true,consent:CrowdCore.CONSENT,task:structuredClone(task),...extra};
 const policy={version:1,ttl_ms:600000,paused:false,allowed:true,reason:null,wait_ms:0,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:0,comment:0,scroll:0}};
 const runtime={storage:{get:async()=>structuredClone(state),set:async(k,v)=>state=structuredClone(v)},now:()=>now,random:()=>0,uuid:crypto.randomUUID,schedule:async()=>{},cancel:async()=>{},close:async()=>{},open:async u=>opened.push(u),probe:async()=>probeReply};
 const api={rpc:async(name,p)=>{requests.push([name,p]);if(name==='guard')return policy;if(name==='claim')return {task:structuredClone(task)};if(name==='finish')return finishReply;throw Error(name);}};
 reset({phase:'search',search_round:2});probeReply={ready:true,links:[url(id),url(other)]};await new CrowdAgent(runtime,api).tick();
 assert.deepEqual(state.candidates,[url(other)],'known notes are filtered before detail/guard roundtrips');
 // A bounded task should not spend two extra scroll admissions once enough
 // distinct, unknown candidates exist. Duplicates and known IDs cannot count.
 reset({phase:'search',task:{...task,target:2,known_note_ids:[id]}});
 probeReply={ready:true,links:[url(id),url(other),url(other),url('c'.repeat(24))]};requests=[];
 await new CrowdAgent(runtime,api).tick();assert.equal(state.phase,'search_done');
 assert.equal(state.candidates.length,2);assert.ok(!requests.some(([n,p])=>n==='guard'&&p.p_action==='scroll'));
 reset({phase:'search',task:{...task,target:2,known_note_ids:[id]}});
 probeReply={ready:true,links:[url(id),url(other),url(other)]};requests=[];
 await new CrowdAgent(runtime,api).tick();assert.equal(state.phase,'search');
 assert.ok(requests.some(([n,p])=>n==='guard'&&p.p_action==='scroll'),'insufficient candidates still expand within the existing budget');
 reset({phase:'search',task:{...task,target:1,anchor_terms:['测试餐厅'],known_note_ids:[]}});
 probeReply={ready:true,links:[url(other)],cards:[{url:url(other),title:'其他餐厅'}]};requests=[];
 await new CrowdAgent(runtime,api).tick();assert.equal(state.phase,'search','unrelated titles do not satisfy the early-stop target');
 reset({task:{...task,platform:'not-installed'}});const openCount=opened.length;requests=[];
 await new CrowdAgent(runtime,api).tick();assert.equal(state.enabled,false);assert.equal(state.last_error,'unsupported_platform');assert.equal(opened.length,openCount);
 assert.ok(!requests.some(([n,p])=>n==='guard'&&p.p_action==='search'),'unknown platform must stop before charging or opening a search');
 assert.equal(CrowdCore.taskPlatform(task).id,'xiaohongshu');
 assert.throws(()=>CrowdCore.taskPlatform({...task,platform:null}),/unsupported_platform/);
 const special='鱼 & 虾/#';assert.equal(new URL(CrowdCore.platform().searchURL(special)).searchParams.get('keyword'),special);
 // Finishing must retain the lease on a malformed response; otherwise we might lose the retry.
 reset({phase:'search_done'});await new CrowdAgent(runtime,api).tick();assert.equal(state.task.id,1);assert.equal(state.last_error,'backend_unavailable');
 now=state.next_at+1;finishReply={status:'open',received:0};await new CrowdAgent(runtime,api).tick();assert.equal(state.task,null);
 // Same task+token renewal continues an in-progress search. A NEW lease resets all page state.
 reset({phase:'search',search_round:1,seen:[id],candidates:[url(other)]});state.task.lease_until=new Date(now+100).toISOString();
 probeReply={ready:false};await new CrowdAgent(runtime,api).tick();assert.equal(state.phase,'search');assert.equal(state.search_round,1);assert.deepEqual(state.seen,[id]);
 reset({phase:'search',search_round:2,seen:[id],candidates:[url(other)],note_url:url(id),note_id:id});state.task.lease_until=new Date(now+100).toISOString();
 task.lease_token=crypto.randomUUID();await new CrowdAgent(runtime,api).tick();assert.equal(state.search_round,0);assert.deepEqual(state.seen,[]);assert.equal(state.note_url,null);
 // A transient navigation failure must not forget previously visited notes or search-round count reset.
 reset({phase:'search',search_round:2,seen:[id],page_deadline:now-1});probeReply={ready:false,reason:'page_loading'};
 await new CrowdAgent(runtime,api).tick();assert.equal(state.enabled,false);assert.equal(state.phase,'search');assert.equal(state.search_round,2);assert.deepEqual(state.seen,[id]);assert.equal(state.task.id,1);
 // Waiting for task retry does not send new page requests, and Stop remains authoritative.
 const agent=new CrowdAgent(runtime,api);await agent.stop();const count=requests.length;now+=1e6;await agent.tick(true);assert.equal(requests.length,count);
 console.log('PASS scheduling client: known-note prefilter, malformed finish retains lease, same lease preserves progress, new token resets stale page, transport retry retains seen notes, Stop survives wake');
})().catch(e=>{console.error(e);process.exitCode=1;});
