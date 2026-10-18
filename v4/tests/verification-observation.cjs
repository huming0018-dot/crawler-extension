'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const SRC=process.argv[2]?path.resolve(process.argv[2]):path.join(__dirname,'candidate/v4/src');for(const n of ['core','work-tabs'])vm.runInThisContext(fs.readFileSync(path.join(SRC,n+'.js'),'utf8'));
function fixture(change={}){
 let owner='owner',probeCalls=0,binds=0,oldCalls=0;
 const entry={url:CrowdCore.HOST+'/',verification:true,session:'current-session',state:'opened',tab:5,token:'bound-token',document:'bound-doc',...change.entry};
 const data={'work_tabs:owner':{'verify-original':entry},'agent:owner':{received:7,outbox:[],history:['old','new'],cursor:14}};
 const tab={id:5,url:CrowdCore.HOST+'/explore/'+'a'.repeat(24),status:'complete',...change.tab};let page={platform:'xiaohongshu',status:'authenticated',principal_id:'a'.repeat(24),verification:'rendered_account_navigation'},proof={token:'bound-token',document:'bound-doc',...change.proof};
 const clone=v=>structuredClone(v),storage={get:async key=>clone(data[key]),set:async(key,v)=>data[key]=clone(v)};
 const chrome={storage:{session:{get:async key=>({[key]:'current-session'}),set:async()=>{throw Error('no marker write')}}},tabs:{get:async id=>{if(id!==5){oldCalls++;throw Error('old tab touched')}return clone(tab)},remove:async()=>{throw Error('no tab close')},update:async()=>{throw Error('no tab update')},sendMessage:async(id,m)=>{assert.equal(id,5);if(m.type==='crowd_bind'){binds++;return {document:proof.document}}assert.equal(m.type,'crowd_session_probe');if(change.during)change.during({tab,proof,data});return clone({...page,...change.page})}}};
 const w=new CrowdWorkTabs({chrome,storage,owner:async()=>owner,probe:async id=>{assert.equal(id,5);probeCalls++;if(change.second&&probeCalls===2)Object.assign(proof,change.second);return {response:clone(proof)}},uuid:randomUUID});
 return {w,data,tab,entry,proof,get binds(){return binds},get oldCalls(){return oldCalls},setOwner:x=>owner=x};
}
(async()=>{
 let f=fixture(),before=structuredClone(f.data);assert.equal((await f.w.verificationProbe('verify-original',async p=>p.principal_id==='a'.repeat(24))).status,'authenticated');assert.equal(f.binds,0);assert.deepEqual(f.data,before);
 await assert.rejects(()=>f.w.target('verify-original'),e=>e.poolCause==='url_changed');await assert.rejects(()=>f.w.read('note_ready','verify-original'),e=>e.poolCause==='url_changed');await f.w.close('verify-original');assert.equal(f.data['work_tabs:owner']['verify-original'].retired_reason,'url_changed');
 for(const change of [{entry:{verification:false}},{entry:{url:CrowdCore.HOST+'/search_result?keyword=original'}},{entry:{session:'old-session'}},{entry:{document:null}},{entry:{token:''}},{tab:{status:'loading'}},{tab:{pendingUrl:CrowdCore.HOST+'/explore/'+'b'.repeat(24)}},{tab:{url:'https://evil.invalid/explore/'+'a'.repeat(24)}},{tab:{url:CrowdCore.HOST+'/login'}},{tab:{url:CrowdCore.HOST+'/user/profile/'+'a'.repeat(24)}},{proof:{token:'foreign'}},{proof:{document:'foreign-doc'}},{second:{document:'changed'}},{second:{token:'changed'}},{during:({tab})=>tab.url=CrowdCore.HOST+'/login'}]){f=fixture(change);await assert.rejects(()=>f.w.verificationProbe('verify-original',async()=>true));assert.equal(f.binds,0);}
 f=fixture({tab:{url:CrowdCore.HOST+'/website-login/error?error_code=300013'}});await assert.rejects(()=>f.w.verificationProbe('verify-original',async()=>true),/rate_limit/);
 // HOME at first probe cannot acquire a new document by racing SPA to a note.
 f=fixture({tab:{url:CrowdCore.HOST+'/'},proof:{document:'foreign-doc',token:null},during:({tab})=>tab.url=CrowdCore.HOST+'/explore/'+'a'.repeat(24)});before=structuredClone(f.data);await assert.rejects(()=>f.w.verificationProbe('verify-original',async()=>true),e=>e.poolCause==='verification_document_changed');assert.equal(f.binds,0);assert.deepEqual(f.data,before);
 f=fixture({tab:{url:CrowdCore.HOST+'/'},during:({tab})=>tab.url=CrowdCore.HOST+'/explore/'+'a'.repeat(24)});assert.equal((await f.w.verificationProbe('verify-original',async()=>true)).status,'authenticated');assert.equal(f.binds,0);
 // Same verified document may sit beside historical complete pointers without creating a recovery loop.
 f=fixture();f.data['work_tabs:owner']['verify-old']={...f.entry,session:'old-session',tab:99,token:'old-token',document:'old-doc'};before=structuredClone(f.data);assert.equal(await f.w.recoveryNeeded(),false);await f.w.rebindAfterLogin(async()=>true,async page=>page.principal_id==='a'.repeat(24));assert.equal(f.oldCalls,0);assert.equal(f.binds,0);assert.deepEqual(f.data,before);
 for(const shape of [{state:'opening'},{document:null},{token:''},{tab:null},{session:''}]){f=fixture();f.data['work_tabs:owner']['verify-old']={...f.entry,session:'old-session',tab:99,token:'old-token',document:'old-doc',...shape};assert.equal(await f.w.recoveryNeeded(),true);await assert.rejects(()=>f.w.rebindAfterLogin(async()=>true,async page=>page.principal_id==='a'.repeat(24)));assert.equal(f.oldCalls,0);}
 for(const page of [{status:'unknown'},{status:'logged_out'},{status:'challenge'},{verification:'other'},{principal_id:'bad'}]){f=fixture({page});await assert.rejects(()=>f.w.rebindAfterLogin(async()=>true,async page=>page.principal_id==='a'.repeat(24)));assert.equal(f.binds,0);}
 f=fixture();await assert.rejects(()=>f.w.rebindAfterLogin(async()=>true),/platform_identity_changed/);assert.equal(f.binds,0);
 const background=fs.readFileSync(path.join(SRC,'participant-background.js'),'utf8'),start=background.indexOf('rebind:')+7,end=background.indexOf(',reconcile:',start),expr=background.slice(start,end);
 const normText=background.slice(background.indexOf('async function normalizeSessionPage'),background.indexOf('async function probePlatformSessions'));
 for(const mode of ['same','other-principal','owner-race','expected-race','no-expected']){
  f=fixture({page:mode==='other-principal'?{principal_id:'b'.repeat(24)}:{}});before=structuredClone(f.data);let owner='owner',reads=0;const crypto=require('node:crypto'),hash=v=>crypto.createHash('sha256').update(v).digest('hex'),expected=hash('owner\nxiaohongshu\n'+'a'.repeat(24));
  const runtime={owner:async()=>owner,leaseScope:async value=>{if(mode==='owner-race')owner='foreign-owner';return hash(value)}};
  const platformHealth={read:async()=>({xiaohongshu:{expected_ref:mode==='no-expected'?null:mode==='expected-race'&&++reads===2?'b'.repeat(64):expected}})};
  const normalize=new Function('runtime','return ('+normText.trim()+')')(runtime),rebind=new Function('workTabs','runtime','platformHealth','normalizeSessionPage','return ('+expr+')')(f.w,runtime,platformHealth,normalize);
  if(mode==='same')await rebind(async()=>true);else await assert.rejects(()=>rebind(async()=>true),/platform_identity_changed/);
  assert.equal(f.binds,0);assert.deepEqual(f.data,before);
 }
 f=fixture();await assert.rejects(()=>f.w.rebindAfterLogin(async()=>false),/cancelled/);assert.equal(f.binds,0);
 console.log('PASS bound home→note verification double proof; default target/read/close strict;15 invalid/race cases; riskURL; current+historical recovery/rebind;5 unknown refusals; no old tab IO/business writes');
})().catch(e=>{console.error(e);process.exitCode=1});
