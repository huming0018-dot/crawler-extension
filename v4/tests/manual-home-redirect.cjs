'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=process.argv[2]||path.join(__dirname,'../src/work-tabs.js');
const core=process.argv[3]||path.join(__dirname,'../src/core.js');
vm.runInThisContext(fs.readFileSync(core,'utf8'));vm.runInThisContext(fs.readFileSync(source,'utf8'));
async function fixture(url){
 let marker={},data={},sequence=0,reads=0,created=0,binds=0;
 const chrome={storage:{session:{get:async k=>({[k]:marker[k]}),set:async v=>Object.assign(marker,v)}},windows:{create:async()=>{created++;return {id:9,tabs:[{id:8,windowId:9}]};},get:async()=>({id:9,type:'normal',state:'minimized',tabs:[{id:8,windowId:9,url:CrowdCore.HOST+'/'}]})},tabs:{get:async()=>{reads++;return {id:8,url,status:'complete'};},sendMessage:async(_,m)=>{if(m.type==='crowd_session_probe')return {platform:'xiaohongshu',status:'authenticated',principal_id:'a'.repeat(24)};assert.equal(m.type,'crowd_bind');binds++;return {document:'current-document'};}}};
 const storage={get:async k=>structuredClone(data[k]),set:async(k,v)=>{data[k]=structuredClone(v);}};
 const make=()=>new CrowdWorkTabs({chrome,storage,owner:async()=>'original-owner',uuid:()=>`random-${++sequence}`,probe:async()=>({response:{token:null,document:'current-document'}})});
 const tabs=make();await tabs.open(CrowdCore.HOST+'/','verify-original',{verificationHome:true});
 return {tabs,data,stale:()=>{marker.crowd_work_session='new-browser';return make();},counts:()=>({reads,created,binds})};
}
(async()=>{
 for(const url of [CrowdCore.HOST+'/',CrowdCore.HOST+'/explore']){
  const f=await fixture(url),p=await f.tabs.verificationProbe('verify-original',async value=>value.status==='authenticated'&&value.principal_id==='a'.repeat(24));
  assert.equal(p.status,'authenticated');assert.equal(f.counts().created,1);assert.equal(f.counts().binds,1);assert.equal(f.data['work_tabs:original-owner']['verify-original'].document,'current-document');
 }
 for(const url of [CrowdCore.HOST+'/explore?keyword=x',CrowdCore.HOST+'/explore#x',CrowdCore.HOST+'/explore/',CrowdCore.HOST+'/explore/'+'a'.repeat(24),CrowdCore.HOST+'/search_result?keyword=x','https://www.xiaohongshu.com.evil.example/explore','https://fake@www.xiaohongshu.com/explore','http://www.xiaohongshu.com/explore','https://www.xiaohongshu.com:8443/explore']){
  const f=await fixture(url);await assert.rejects(f.tabs.verificationProbe('verify-original',async()=>true),/pool_recovery_required/);assert.equal(f.counts().binds,0);
 }
 const f=await fixture(CrowdCore.HOST+'/explore'),before=f.counts().reads;
 await assert.rejects(f.stale().verificationProbe('verify-original',async()=>true),/pool_recovery_required/);assert.equal(f.counts().reads,before,'stale browser tab ID must not be read');
 console.log('PASS owned manual home redirect and binding; 9 off-route denials; stale session rejects before tab access');
})().catch(e=>{console.error(e);process.exitCode=1;});
