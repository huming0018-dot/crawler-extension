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
 assert.equal(x.calls.find(c=>c.action==='finish').payload.reason,'partial','visible homepage is not full coverage');
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
 x=setup();const normalRPC=x.api.rpc;x.api.rpc=async(name,payload)=>{const result=await normalRPC(name,payload);if(payload.p_action==='guard')result.gap_ms=1;return result;};
 await x.agent.start();x.advance();await x.agent.tick();assert.equal(x.opens.length,0);assert.equal(x.data['kol:owner'].last_error,'control_unavailable');
 assert.throws(()=>K.validateRecord(record(ids[0]),{...task,target_id:'e'.repeat(24)},ids[0]),/author_mismatch/);
 x=setup({principal_ref:'f'.repeat(64)});x.runtime.verifyPrincipal=async()=>{throw new Error('platform_identity_changed');};
 await x.agent.start();x.advance();await x.agent.tick();assert.equal(x.opens.length,0);assert.equal(x.calls.filter(c=>c.action==='guard').length,0);assert.equal(x.data['kol:owner'].enabled,false);assert.equal(x.data['kol:owner'].last_error,'platform_identity_changed');
 // A pending start owns the single writer, and user stop wins its late response.
 x=setup();let release;const original=x.api.rpc;x.api.rpc=async(name,payload)=>payload.p_action==='start'?new Promise(resolve=>release=resolve):original(name,payload);
 const starting=x.agent.start({target_id:'target-1'});await new Promise(r=>setImmediate(r));
 const stopping=x.agent.stop();await new Promise(r=>setImmediate(r));release({});
 const outcomes=await Promise.allSettled([starting,stopping]);assert.equal(outcomes[0].status,'rejected');assert.equal(x.data['kol:owner'].enabled,false);
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
 // Backend-account changes never deliver an old owner's outbox as the new owner.
 x=setup();x.data['kol:owner']={...K.initial(),delivery_enabled:true,outbox:[{request:'old',record:record(ids[0])}]};x.data.session.user.id='new';await x.agent.tick();assert.equal(x.calls.length,0);assert.equal(x.data['kol:owner'].outbox.length,1);
 console.log('PASS KOL: two-attempt cap, creator binding, stable ACK retry, stop/start locking, staged-record drain, expired lease pause, owner isolation, canonical platform URLs');
})().catch(e=>{console.error(e);process.exitCode=1;});
