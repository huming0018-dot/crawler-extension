const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),crypto=require('crypto');
const ctx=vm.createContext({TextEncoder,URL,console});for(const f of ['core','structured','agent'])vm.runInContext(fs.readFileSync('v4/src/'+f+'.js','utf8'),ctx);
const id=n=>n.toString(16).padStart(24,'0'),note=id(500),parent=crypto.randomUUID();
function fixture(){
 const graph=new ctx.CrowdStructured.StructuredPages(note);
 const replies=Array.from({length:10},(_,i)=>({id:id(i+2),note_id:note,content:'comment',pictures:i===4?[{url_default:'https://sns-webpic-qc.xhscdn.com/public/comment/image1!nc_n_webp_2',width:8,height:8}]:[]}));
 graph.accept('main','',{cursor:'',has_more:false,comments:[{id:id(1),note_id:note,content:'comment',sub_comment_count:10,sub_comment_has_more:false,sub_comment_cursor:'',sub_comments:replies}]});
 const items=[...graph.items.values()];
 const dom=items.slice(0,6).map((i,n)=>({key:'comment-'+n,comment_id:i.id,parent_comment_id:i.parent,is_reply:i.parent!==null,text:i.text,original_length:7,truncated:false,media:i.pictures.map(p=>({kind:'image',url:p.url_default,width:p.width,height:p.height,alt:null}))}));
 const comments={items:dom,loading:false,media_pending:false,truncated:false,identity_uncertain:false,more_available:true,progress:{at_end:false,end_marker:false,expand_count:1},dom_census:{document:'owned-doc',visible_count:6,skipped_count:0,duplicate_count:0,unresolved_parent_count:0},reply_coverage:{root_count:1,declared_count:10,loaded_count:5,pending_groups:1}};
 const record={standard:{platform:'xiaohongshu',note_id:note,comment_count:11},extra:{comments,field_observations:[],metric_labels:{}},evidence:{text:'body'}};
 return {ready:true,record,structured:{note_id:note,document:'owned-doc',source:'page_response',mode:'passive_hybrid',observer_status:'installed',gate:null,complete:true,main_ended:true,body_dom_match:true,body:{source:'page_hydration',note_id:note,title:'title',text:'body',original_length:4,truncated:false},errors:[],pages:['main:'],items,groups:[{id:id(1),declared:10,captured:10,ended:true}],dom_witness:{note_id:note,comment_ids:dom.map(i=>i.comment_id),matched:true,reported_count:11}}};
}
async function run(change=null,flag=true){
 let now=Date.now(),actions=0,guards=0,page=fixture();if(change)change(page);
 const runtime={experimentalAPIEarlyFinish:flag,localTest:true,now:()=>now,uuid:crypto.randomUUID,probe:async a=>{if(a==='comments'){actions++;return {ready:true};}return page;}};
 const agent=new ctx.CrowdAgent(runtime,{});agent.save=async()=>{};agent.scheduleReceipt=async()=>{};agent.admit=async()=>{guards++;return true;};
 const s={owner_id:'7033ff0c-65d7-4963-b65c-a4ac9e31f03a',enabled:true,test_run:{id:crypto.randomUUID(),state:'active',expires_at:now+600000},profiles:false,notes_in_session:0,outbox:[],rejected:[],task:{id:17,lease_token:'fixture',lease_until:new Date(now+600000).toISOString(),comments_capture:true,structured_capture:true,repair_notes:[{parent,record:{standard:{note_id:note}}}]},enrichment:{stage:'comments',repair:true,parent,record:JSON.parse(JSON.stringify(page.record)),last:null,stalls:0,rounds:0}};
 await agent.enrich(s,()=>{},undefined);return {agent,s,actions,guards};
}
(async()=>{
 const good=await run();assert.equal(good.actions,0);assert.equal(good.guards,0);assert.equal(good.s.enrichment,null);
 const dom=good.s.outbox.find(i=>i.kind==='comments'),api=good.s.outbox.find(i=>i.kind==='structured'&&i.record.kind==='comments');
 assert.equal(dom.record.summary.captured_count,6);assert.equal(dom.record.summary.complete,false);assert.equal(dom.record.summary.visible_complete,false);assert.equal(dom.record.summary.capture_reason,'api_graph_closed_dom_subset');
 assert.equal(api.record.items.length,11);assert.equal(api.record.summary.complete,true);assert.equal(api.record.summary.reward_eligible,false);assert.equal(api.record.summary.image_count,1);
 assert.equal(good.s.comment_partial,true);assert.equal(good.agent.testResult(good.s),'test_comments_partial');assert.equal(good.s.outbox.length,3);
 const first=good.s.outbox[0].request;good.agent.api={rpc:async()=>({request:'wrong',gate:'observed'})};await assert.rejects(()=>good.agent.flushOutbox(good.s,()=>{}),/invalid_receipt/);assert.equal(good.s.outbox[0].request,first);assert.equal(good.s.outbox.length,3);
 const ack=[];good.agent.api={rpc:async(name,p)=>{ack.push(p.p_request);return {request:p.p_request,gate:'observed',run:p.p_data.run,page:p.p_data.page,source:p.p_data.source,reward_eligible:false};}};
 while(good.s.outbox.length)await good.agent.flushOutbox(good.s,()=>{});assert.equal(ack.length,3);assert.equal(ack[0],first);assert.equal(new Set(ack).size,3);assert.equal(good.agent.testResult(good.s),'test_completed');
 const bad=[p=>p.structured.groups[0].ended=false,p=>p.structured.groups[0].captured=9,p=>p.structured.main_ended=false,p=>p.structured.errors=['cursor_stalled'],p=>p.structured.dom_witness.reported_count=12,p=>p.structured.dom_witness.matched=false,p=>p.structured.dom_witness.comment_ids=[],p=>p.structured.dom_witness.comment_ids=[id(999)],p=>p.structured.body_dom_match=false,p=>p.structured.observer_status='waiting',p=>p.structured.document='other-doc',p=>p.structured.note_id=id(999),p=>p.structured.items[10].parent=id(999),p=>p.structured.items[10].id=p.structured.items[9].id,p=>p.structured.groups.push({...p.structured.groups[0]}),p=>p.structured.pages=[],p=>p.structured.body=null,p=>p.structured.complete=false];
 for(const mutate of bad){const r=await run(mutate);assert.ok(r.s.enrichment);assert.equal(r.actions,1);assert.equal(r.guards,1);}
 const off=await run(null,false);assert.ok(off.s.enrichment);assert.equal(off.actions,1);await assert.rejects(()=>run(p=>p.gate='rate_limit'),/rate_limit/);await assert.rejects(()=>run(p=>p.structured.gate='captcha'),/captcha/);
 console.log('PASS 53 actualAgent: API closure zero extra source actions; DOM 6/11 partial; 3 serialized ACK; unknown ACK retained; 18 negative closures, feature-off, risk preserved');
})().catch(e=>{console.error(e);process.exit(1)});
