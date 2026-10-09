'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const context=vm.createContext({URL,AbortController,console});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/kol.js'),'utf8'),context);const K=context.CrowdKOL;
const ids=['a'.repeat(24),'b'.repeat(24),'c'.repeat(24)],creator='d'.repeat(24);
const task={id:'task-1',target_ref:'target-1',lease_token:'lease-1',credential_epoch:1,platform:'xiaohongshu',target_kind:'creator',target_id:creator,url:'https://www.xiaohongshu.com/user/profile/'+creator,max_items:2,known_ids:[],comment_limit:0,include_replies:false};
const record=id=>({schema_version:4,standard:{platform:'xiaohongshu',note_id:id,url:'https://www.xiaohongshu.com/explore/'+id,title:'公开标题',captured_at:new Date().toISOString(),like_count:null,collect_count:null,comment_count:null,view_count:null},extra:{author:{id:creator,url:task.url},media_present:false},evidence:{text:'公开正文',source:'rendered_public_dom'}});
function setup(overrides={}){
 const data={session:{user:{id:'owner'}}},calls=[],opens=[];let now=Date.now(),counter=0,finished=false,loseACK=false;
 const storage={get:async key=>structuredClone(data[key]),set:async(key,value)=>{data[key]=structuredClone(value);}};
 const runtime={storage,now:()=>now,uuid:()=> 'request-'+(++counter),schedule:async()=>{},cancel:async()=>{},close:async()=>{},open:async url=>opens.push(url),probe:async input=>input.action==='discover'?{ready:true,creator_id:creator,links:ids.map(id=>'https://www.xiaohongshu.com/explore/'+id)}:{ready:true,record:record(K.targetURL(opens.at(-1)).id)}};
 const api={rpc:async(name,{p_action:action,p_payload:payload})=>{
   calls.push({action,payload:structuredClone(payload)});
   if(action==='claim')return {task:finished?null:structuredClone({...task,...overrides})};
   if(action==='guard')return {allowed:true,reason:null,wait_ms:0,version:1,paused:false,ttl_ms:600000,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},admission_id:'admission-'+calls.length};
   if(action==='checkpoint')return {checkpoint:{revision:payload.expected_revision+1}};
   if(action==='action_settle')return {settled:true};
   if(action==='submit'){
    if(loseACK){loseACK=false;throw new Error('lost_ack');}
    return {request:payload.request,task:payload.task,content_id:payload.record.standard.note_id,gate:'received',source_kind:'rendered_public_dom',reward_eligible:false};
   }
   if(action==='finish'){finished=true;return {task};}return {};
 }};
 return {agent:new K.Agent(runtime,api),data,calls,opens,runtime,api,advance:()=>now+=61000,lose:()=>loseACK=true};
}
(async()=>{
 assert.equal(K.targetURL('https://space.bilibili.com/123/video').url,'https://space.bilibili.com/123');
 assert.equal(K.targetURL('https://www.bilibili.com/video/BV1xx411c7mD?token=omit').navigation,'https://www.bilibili.com/video/BV1xx411c7mD');
 for(const url of ['http://www.bilibili.com/video/BV1xx411c7mD','https://evil.test/video/BV1xx411c7mD','https://u:p@www.xiaohongshu.com/explore/'+ids[0]])assert.throws(()=>K.targetURL(url));
 let x=setup();await x.agent.start();x.lose();
 for(let i=0;i<20;i++){x.advance();await x.agent.tick();}
 assert.equal(x.calls.filter(c=>c.action==='guard'&&c.payload.action==='detail').length,2,'strict task detail attempts');
 assert.equal(x.calls.filter(c=>c.action==='guard'&&c.payload.action==='search').length,1);
 assert.equal(x.calls.filter(c=>c.action==='guard'&&c.payload.action==='comment').length,0,'default zero comments never expands');
 assert.equal(x.opens.length,3);assert.equal(x.data['kol:owner'].outbox.length,0);assert.equal(x.data['kol:owner'].received,2);
 const submitted=x.calls.filter(c=>c.action==='submit');assert.equal(submitted.length,3);assert.equal(submitted[0].payload.request,submitted[1].payload.request,'lost ACK must replay same request');
 assert.equal(x.calls.find(c=>c.action==='finish').payload.reason,'observed_only','visible creator observation is not full source coverage');assert.equal(x.data['kol:owner'].coverage.status,'partial');
 x=setup({known_ids:[ids[0],ids[1]],refresh_ids:[ids[1]],max_items:2});await x.agent.start();
 for(let i=0;i<20;i++){x.advance();await x.agent.tick();}
 assert.equal(K.targetURL(x.opens[1]).id,ids[1],'server-authorized stale metric refresh gets a bounded attempt');
 assert.equal(K.targetURL(x.opens[2]).id,ids[2],'known non-refresh note is skipped');
 x=setup();x.runtime.probe=async()=>({ready:true,creator_id:creator,links:[]});await x.agent.start();
 for(let i=0;i<20;i++){x.advance();await x.agent.tick();}
 assert.equal(x.calls.filter(c=>c.action==='guard'&&c.payload.action==='scroll').length,3,'discovery scroll budget bounded');
 assert.equal(x.calls.filter(c=>c.action==='guard'&&c.payload.action==='detail').length,0);
 x=setup();const validProbe=x.runtime.probe;
 x.runtime.probe=async input=>{const page=await validProbe(input);if(page.record?.standard.note_id===ids[0])page.record.standard.note_id=ids[2];return page;};
 await x.agent.start();for(let i=0;i<20;i++){x.advance();await x.agent.tick();}
 assert.equal(x.calls.filter(c=>c.action==='guard'&&c.payload.action==='detail').length,2);assert.equal(x.data['kol:owner'].received,1,'failed detail consumes its attempt without adding replacement');
 x=setup();const brokenProbe=x.runtime.probe;x.runtime.probe=async input=>{const page=await brokenProbe(input);if(page.record)page.record.standard.like_count='malformed';return page;};await x.agent.start();for(let i=0;i<15;i++){x.advance();await x.agent.tick();}assert.equal(x.data['kol:owner'].last_error,'parser_paused');assert.equal(x.data['kol:owner'].parser_failures.xiaohongshu.paused,true);await x.agent.resumeParser('xiaohongshu');assert.equal(x.data['kol:owner'].parser_failures.xiaohongshu,undefined);assert.equal(x.data['kol:owner'].enabled,false);
 x=setup({max_items:1});const sameProbe=x.runtime.probe;x.runtime.probe=async input=>{const page=await sameProbe(input);if(page.record)page.record.standard.like_count='malformed';return page;};await x.agent.start();for(let i=0;i<5;i++){x.advance();await x.agent.tick();}let repeated=x.data['kol:owner'];repeated.enabled=true;repeated.phase='detail';repeated.current_id=ids[0];repeated.deadline=x.runtime.now()+120000;repeated.next_at=0;await x.agent.tick();assert.equal(x.data['kol:owner'].parser_failures.xiaohongshu.counts.invalid_count,1,'same content retry is one failing sample');assert.equal(x.data['kol:owner'].parser_failures.xiaohongshu.paused,false);
 x=setup({execution_protocol:1,target_kind:'content',target_id:ids[0],url:'https://www.xiaohongshu.com/explore/'+ids[0],max_items:1});x.runtime.probe=async()=>({ready:false,unavailable:'source_private'});await x.agent.start();for(let i=0;i<8;i++){x.advance();await x.agent.tick();}assert.equal(x.calls.find(c=>c.action==='finish').payload.detail_reason,'source_private');assert.equal(x.calls.filter(c=>c.action==='submit').length,0);
 x=setup();const normalRPC=x.api.rpc;x.api.rpc=async(name,payload)=>{const result=await normalRPC(name,payload);if(payload.p_action==='guard')result.gap_ms=1;return result;};
 await x.agent.start();x.advance();await x.agent.tick();assert.equal(x.opens.length,0);assert.equal(x.data['kol:owner'].last_error,'control_unavailable');
 assert.throws(()=>K.validateRecord(record(ids[0]),{...task,target_id:'e'.repeat(24)},ids[0]),/author_mismatch/);
 x=setup();x.runtime.sourceHealth=async()=>{throw Error('login_required');};await x.agent.start();x.advance();await x.agent.tick();assert.equal(x.calls.filter(c=>c.action==='guard').length,0,'health gate stops source before budget admission');assert.equal(x.data['kol:owner'].enabled,false);
 x=setup({execution_protocol:1});await x.agent.start();x.advance();await x.agent.tick();await x.agent.stop('rate_limit',true,{keepPage:true});assert.equal(x.data['kol:owner'].pending_risk.risk_type,'rate_limit');assert.ok(x.data['kol:owner'].pending_risk.executor_id);
 x=setup({principal_ref:'f'.repeat(64)});x.runtime.verifyPrincipal=async()=>{throw new Error('platform_identity_changed');};
 await x.agent.start();x.advance();await x.agent.tick();assert.equal(x.opens.length,0);assert.equal(x.calls.filter(c=>c.action==='guard').length,0);assert.equal(x.data['kol:owner'].enabled,false);assert.equal(x.data['kol:owner'].last_error,'platform_identity_changed');
 // Restored deep-page candidates survive the first rediscovery checkpoint.
 x=setup({execution_protocol:1,checkpoint:{revision:1,candidate_ids:[ids[1]],processed_ids:[],scrolls:1},max_discovery_scrolls:10});let pages=0;
 const baseProbe=x.runtime.probe;x.runtime.probe=async input=>input.action==='discover'?{ready:true,creator_id:creator,links:['https://www.xiaohongshu.com/explore/'+ids[pages++?1:0]]}:baseProbe(input);
 await x.agent.start();for(let i=0;i<24;i++){x.advance();await x.agent.tick();}
 const firstCP=x.calls.find(c=>c.action==='checkpoint');assert.ok(firstCP.payload.candidate_ids.includes(ids[1]));assert.equal(firstCP.payload.scrolls,1);assert.equal(x.data['kol:owner'].received,2);assert.ok(x.calls.filter(c=>c.action==='guard').every(c=>c.payload.request&&c.payload.executor_id));
 // Attempt count is persisted before sending; killed writers cannot retry forever.
 x=setup();x.data['kol:owner']={...K.initial(),delivery_enabled:true,outbox:[{request:'stable-delivery',task:task.id,lease:task.lease_token,admission_id:'g',record:record(ids[0]),delivery_attempts:0}]};let sends=0;
 x.api.rpc=async()=>{sends++;x.agent.generation++;throw Error('worker_stopped_after_send');};
 for(let n=0;n<4;n++){x.agent=new K.Agent(x.runtime,x.api);while(x.data['kol:owner'].outbox[0].retry_at>x.runtime.now())x.advance();await x.agent.tick().catch(()=>{});const count=sends;await x.agent.tick().catch(()=>{});assert.equal(sends,count,'crash retry respects durable backoff');}
 assert.equal(sends,3);assert.equal(x.data['kol:owner'].outbox[0].delivery_attempts,3);assert.equal(x.data['kol:owner'].outbox[0].request,'stable-delivery');
 x=setup();x.data['kol:owner']={...K.initial(),delivery_enabled:true,outbox:[{request:'old-unknown',record:record(ids[0]),retries:1}]};await x.agent.tick();assert.equal(x.calls.length,0);assert.equal(x.data['kol:owner'].last_error,'unknown_delivery_history');
 const merged=K.mergeComments({items:[{key:'a',comment_id:'1',text:'first',parent_key:null}]},{items:[{key:'z',comment_id:'1',text:'first',parent_key:null},{key:'b',comment_id:'2',text:'reply',parent_key:'z'}]},20);
 const imageSamples=K.mergeComments(null,{items:[{key:'a',text:'',parent_key:null,content_type:'image'},{key:'b',text:'',parent_key:null,content_type:'image'}]},20);assert.equal(imageSamples.items.length,2,'unknown image identity preserves both samples');
 assert.equal(merged.items.length,2);assert.equal(merged.items[1].parent_key,merged.items[0].key);assert.equal(merged.complete,false);
 x=setup({execution_protocol:1,max_items:1,comment_limit:3,max_comment_pages:5});let commentPage=0;const commentsProbe=x.runtime.probe;
 x.runtime.probe=async input=>{if(input.action==='comments')return {ready:true};const page=await commentsProbe(input);if(input.action==='detail'){commentPage++;page.record.extra.comments={items:[{key:'same-page-key',comment_id:String(commentPage),text:'page '+commentPage,parent_key:null}],complete:false};}return page;};
 await x.agent.start();for(let i=0;i<22;i++){x.advance();await x.agent.tick();}const paged=x.calls.find(c=>c.action==='submit');assert.equal(paged.payload.record.extra.comments.items.length,3);assert.equal(x.calls.filter(c=>c.action==='guard'&&c.payload.action==='comment').length,2);assert.equal(paged.payload.record.extra.comments.complete,false);
 const fortyOne=Array.from({length:41},(_,i)=>(i+100).toString(16).padStart(24,'0'));x=setup({known_ids:fortyOne.slice(0,40),max_items:1});const fortyProbe=x.runtime.probe;
 x.runtime.probe=async input=>input.action==='discover'?{ready:true,creator_id:creator,links:fortyOne.map(id=>'https://www.xiaohongshu.com/explore/'+id)}:fortyProbe(input);
 await x.agent.start();for(let i=0;i<12;i++){x.advance();await x.agent.tick();}assert.equal(K.targetURL(x.opens[1]).id,fortyOne[40]);assert.equal(x.data['kol:owner'].received,1);
 x=setup({max_items:1,window_days:1,created_at:'2026-10-10T00:00:00Z',scan_from:'2026-10-01T12:00:00Z',scan_until:'2026-10-10T00:00:00Z'});const scanProbe=x.runtime.probe;x.runtime.probe=async input=>{const page=await scanProbe(input);if(page.record)page.record.standard.published_at='2026-10-01';return page;};
 await x.agent.start();for(let i=0;i<12;i++){x.advance();await x.agent.tick();}assert.equal(x.data['kol:owner'].received,1,'server scan_from and date precision override local window arithmetic');
 // A pending start owns the single writer, and user stop wins its late response.
 x=setup();let release;const original=x.api.rpc;x.api.rpc=async(name,payload)=>payload.p_action==='start'?new Promise(resolve=>release=resolve):original(name,payload);
 const starting=x.agent.start({target_id:'target-1'});await new Promise(r=>setImmediate(r));
 const stopping=x.agent.stop();await new Promise(r=>setImmediate(r));release({});
 const outcomes=await Promise.allSettled([starting,stopping]);assert.equal(outcomes[0].status,'rejected');assert.equal(x.data['kol:owner'].enabled,false);
 x=setup();let releaseRecover;const recoverRPC=x.api.rpc;x.api.rpc=async(name,payload)=>payload.p_action==='recover'?new Promise(resolve=>releaseRecover=()=>resolve({task:{id:'recover-task',executor_id:payload.p_payload.executor_id}})):recoverRPC(name,payload);
 const recovering=x.agent.recover('recover-task');await new Promise(r=>setImmediate(r));const recoveryStop=x.agent.stop();releaseRecover();const recoveryResults=await Promise.allSettled([recovering,recoveryStop]);assert.equal(recoveryResults[0].status,'rejected');assert.equal(x.data['kol:owner'].enabled,false);
 x=setup();x.data['kol:owner']={...K.initial(),outbox:[{request:'keep-stable',record:record(ids[0]),delivery_attempts:3}]};const stopBeforeInsert=x.agent.stop.bind(x.agent);let insertedStart=false;
 x.agent.stop=async(...args)=>{await stopBeforeInsert(...args);await x.agent.start();insertedStart=x.data['kol:owner'].enabled;};await x.agent.retryDelivery();assert.equal(insertedStart,true);assert.equal(x.data['kol:owner'].enabled,false);assert.equal(x.data['kol:owner'].outbox[0].request,'keep-stable');assert.equal(x.data['kol:owner'].outbox[0].delivery_attempts,0);
 x=setup();x.data['kol:owner']={...K.initial(),enabled:true,task:{...task,execution_protocol:1},phase:'detail',unsettled:[{admission_id:'existing',action:'detail'}],current_id:ids[0]};for(const reason of ['login_required','user_login','session_login']){await x.agent.stop(reason,true,{keepPage:true});assert.equal(x.data['kol:owner'].phase,'detail');assert.equal(x.data['kol:owner'].unsettled[0].admission_id,'existing','login help keeps already-admitted page cursor');}
 // Stop preserves a durably captured record, then drains without source navigation.
 x=setup();x.data['kol:owner']={...K.initial(),enabled:true,delivery_enabled:true,task,phase:'comments',pending_record:{request:'stable',task:task.id,lease:task.lease_token,admission_id:'a',record:record(ids[0])}};
 await x.agent.stop();assert.equal(x.data['kol:owner'].outbox.length,1);x.advance();await x.agent.tick();assert.equal(x.data['kol:owner'].outbox.length,0);assert.equal(x.opens.length,0);
 // A challenge while expanding comments keeps the already captured base and stops source work.
 x=setup({comment_limit:2,include_replies:true});const realProbe=x.runtime.probe;
 x.runtime.probe=async input=>input.action==='comments'?{ready:false,gate:'captcha'}:realProbe(input);
 await x.agent.start();for(let i=0;i<12;i++){x.advance();await x.agent.tick();}
 assert.equal(x.data['kol:owner'].enabled,false);assert.equal(x.data['kol:owner'].pending_record,null);assert.equal(x.data['kol:owner'].outbox.length,0);assert.equal(x.data['kol:owner'].received,1);
 assert.equal(x.calls.filter(c=>c.action==='guard'&&c.payload.action==='detail').length,1);
 assert.equal(x.calls.find(c=>c.action==='finish').payload.risk_type,'captcha');
 // An expired lease pauses and drops only the execution cursor, preserving evidence.
 x=setup();const rpc=x.api.rpc;x.api.rpc=async(name,payload)=>payload.p_action==='guard'?{allowed:false,reason:'lease_expired',wait_ms:0}:rpc(name,payload);
 await x.agent.start();x.advance();await x.agent.tick();assert.equal(x.data['kol:owner'].enabled,false);assert.equal(x.data['kol:owner'].task,null);assert.equal(x.data['kol:owner'].last_error,'lease_expired');
 x=setup({execution_protocol:1});const expiryRPC=x.api.rpc;x.api.rpc=async(name,payload)=>payload.p_action==='guard'?{allowed:false,reason:'lease_expired',wait_ms:0}:payload.p_action==='release'?{released:true}:expiryRPC(name,payload);
 await x.agent.start();x.advance();await x.agent.tick();assert.equal(x.data['kol:owner'].task.id,task.id,'protocol1 expired lease keeps original task for safe release');await x.agent.release();assert.equal(x.data['kol:owner'].task,null);
 // Backend-account changes never deliver an old owner's outbox as the new owner.
 x=setup();x.data['kol:owner']={...K.initial(),delivery_enabled:true,outbox:[{request:'old',record:record(ids[0])}]};x.data.session.user.id='new';await x.agent.tick();assert.equal(x.calls.length,0);assert.equal(x.data['kol:owner'].outbox.length,1);
 console.log('PASS KOL: two-attempt cap, creator binding, stable ACK retry, stop/start locking, staged-record drain, expired lease pause, owner isolation, canonical platform URLs');
})().catch(e=>{console.error(e);process.exitCode=1;});
