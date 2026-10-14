'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
for(const file of ['core','work-tabs'])vm.runInThisContext(fs.readFileSync('v4/src/'+file+'.js','utf8'));
(async()=>{
 let owner='one',seq=0,created=0,removed=[],data={},session={},tabs=new Map();
 const chrome={storage:{session:{get:async key=>({[key]:session[key]}),set:async value=>Object.assign(session,value)}},windows:{getAll:async()=>[{id:1}]},tabs:{
  create:async({url})=>{const tab={id:++seq,url,status:'complete',document:crypto.randomUUID(),token:null};tabs.set(tab.id,tab);created++;return {...tab};},
  get:async id=>{if(!tabs.has(id))throw Error('missing');return {...tabs.get(id)};},
  update:async(id,{url})=>Object.assign(tabs.get(id),{url,document:crypto.randomUUID(),token:null}),
  sendMessage:async(id,m)=>{const tab=tabs.get(id);tab.token=m.token;return {bound:true,document:tab.document};},remove:async id=>{removed.push(id);tabs.delete(id);}
 }};
 chrome.windows.create=async({url})=>({id:++seq,tabs:[await chrome.tabs.create({url})]});
 const storage={get:async key=>structuredClone(data[key]),set:async(key,value)=>data[key]=structuredClone(value)};
 const probe=async(id,action)=>({response:action==='ownership'?{token:tabs.get(id).token,document:tabs.get(id).document}:{ready:true}});
 const make=()=>new CrowdWorkTabs({chrome,storage,owner:async()=>owner,probe,uuid:crypto.randomUUID});
 const w=make(),urls=['a','b'].map(x=>CrowdCore.HOST+'/explore/'+x.repeat(24));
 await Promise.all([w.open(urls[0],'a'),w.open(urls[1],'b')]);assert.equal(created,2);assert.equal(new Set(Object.values(data['work_tabs:one']).map(e=>e.session)).size,1);
 const pending=data['work_tabs:one'].a.tab;tabs.get(pending).status='loading';tabs.get(pending).url=undefined;assert.equal((await w.read('note_ready','a')).reason,'page_loading');await assert.rejects(()=>make().read('note_ready','a'),/pool_recovery_required/);tabs.get(pending).url=urls[0];tabs.get(pending).status='complete';
 await w.read('note_ready','a');await w.read('note_ready','b');
 const restart=make();assert.equal((await restart.read('note_ready','a')).ready,true,'worker restart keeps bound document');
 const a=data['work_tabs:one'].a.tab,originalURL=tabs.get(a).url;tabs.get(a).url=CrowdCore.HOST+'/explore/'+'c'.repeat(24);
 await assert.rejects(()=>restart.open(urls[1],'a'),/pool_recovery_required/);assert.equal(tabs.get(a).url,CrowdCore.HOST+'/explore/'+'c'.repeat(24),'profile navigation cannot overwrite a user-taken SPA page');tabs.get(a).url=originalURL;
 const document=tabs.get(a).document;tabs.get(a).document=crypto.randomUUID();await assert.rejects(()=>restart.open(urls[1],'a'),/pool_recovery_required/);tabs.get(a).document=document;
 const b=data['work_tabs:one'].b.tab;tabs.get(b).token='unowned';tabs.get(b).document=crypto.randomUUID();
 await assert.rejects(()=>restart.read('note_ready','b'),/pool_recovery_required/);assert.equal(tabs.get(b).token,'unowned','cannot rebind unowned same-URL document');
 await restart.close('b');assert.equal(removed.includes(b),false);assert.equal(data['work_tabs:one'].b.state,'retired');assert.equal(data['work_tabs:one'].b.retired_reason,'close_identity');
 owner='two';await make().close();assert.equal(removed.length,0,'new owner cannot close old owner slots');
 owner=null;await make().close();assert.equal(removed.length,0,'signed-out stop is a no-op');
 owner='one';session={};await assert.rejects(()=>make().read('note_ready','a'),/pool_recovery_required/);assert.equal(created,2,'browser restart never adopts stale tab ID');
 data['work_tabs:one'].c={session:session.crowd_work_session,state:'opening',tab:null,url:urls[0]};await assert.rejects(()=>make().open(urls[0],'c'),/pool_recovery_required/);assert.equal(created,2,'unrecorded creation cannot create again');
 const beforeRemoved=[...removed];await make().close('a');await make().close('b');
 assert.deepEqual(removed,beforeRemoved,'retiring an old browser session never touches reused user tab IDs');
 assert.equal(data['work_tabs:one'].a,undefined);assert.equal(data['work_tabs:one'].b,undefined);
 await make().close('c');assert.equal(data['work_tabs:one'].c.state,'retired','uncertain creation retired without touching a tab');
 console.log('PASS owned work tabs: two direct navigations, one browser session, bound worker recovery, same-URL ownership mismatch retained, owner/signed-out isolation, stale tab IDs and uncertain creation refuse duplication');
})().catch(error=>{console.error(error);process.exitCode=1;});
