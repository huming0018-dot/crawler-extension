'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=process.argv[2]||path.resolve(__dirname,'..');
for(const name of ['core','work-tabs'])vm.runInThisContext(fs.readFileSync(path.join(source,'src',name+'.js'),'utf8'));
async function main(){
 let data={},session={},seq=0,creates=[],updates=[],windows=[],fail=false;
 const tabs=new Map(),storage={get:async k=>structuredClone(data[k]),set:async(k,v)=>data[k]=structuredClone(v)};
 const chrome={storage:{session:{get:async k=>({[k]:session[k]}),set:async v=>Object.assign(session,v)}},tabs:{
  get:async id=>({...tabs.get(id)}),update:async(id,v)=>{updates.push({id,...v});const t=tabs.get(id);if(v.url)Object.assign(t,{url:v.url,document:crypto.randomUUID(),token:null});return {...t};},
  sendMessage:async(id,m)=>{const t=tabs.get(id);t.token=m.token;return {document:t.document};}
 },windows:{
  create:async options=>{creates.push({...options});if(fail)throw Error('creation_outcome_unknown');const id=++seq;if(options.tabId)return {id,tabs:[tabs.get(options.tabId)]};const tab={id:++seq,windowId:id,url:options.url,status:'complete',document:crypto.randomUUID(),token:null};tabs.set(tab.id,tab);return {id,tabs:[tab]};},
  get:async id=>({id,type:'normal',state:'minimized',incognito:false,tabs:[...tabs.values()].filter(v=>v.windowId===id)}),
  update:async(id,options)=>{windows.push({id,...options});return {id,...options};}
 }};
 const probe=async id=>({response:{token:tabs.get(id).token,document:tabs.get(id).document}});
 const w=new CrowdWorkTabs({chrome,storage,owner:async()=>'original',probe,uuid:crypto.randomUUID,presentationAllowed:async()=>true});
 const url=CrowdCore.HOST+'/explore/'+'a'.repeat(24);
 await w.open(url,'search');assert.equal(creates[0].state,'minimized','automatic source window must be minimized');assert.equal(creates[0].focused,false);assert.equal(creates[0].type,'normal');
 await w.read('ownership','search');await w.open(url,'search');assert.equal(creates.length,1,'same slot must reuse the existing tab');assert.equal(updates.at(-1).active,false);
 await w.open(CrowdCore.HOST+'/','verify-manual',{verificationHome:true});await w.focusVerification('verify-manual');assert.equal(windows.at(-1).state,'normal','explicit manual verification must restore the window');assert.equal(windows.at(-1).focused,true);assert.equal(updates.at(-1).active,true);
 await w.read('ownership','search');const entry=data['work_tabs:original'].search;await w.present('search',entry,'work_tabs:original');assert.equal(creates.at(-1).tabId,entry.tab);assert.equal(creates.at(-1).focused,false);assert.equal(creates.at(-1).state,undefined,'required visible comments presentation retains existing behavior');
 fail=true;const n=creates.length;await assert.rejects(()=>w.open(url,'uncertain'),/creation_outcome_unknown/);assert.equal(creates.length,n+1);await assert.rejects(()=>w.open(url,'uncertain'),/pool_recovery_required/);assert.equal(creates.length,n+1,'unknown creation must never be retried');
 console.log('PASS silent source creation, same-slot reuse, explicit manual restore, comment presentation, unknown creation not retried');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
