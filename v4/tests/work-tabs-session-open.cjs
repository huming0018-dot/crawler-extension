'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=path.resolve(process.argv[2]||path.join(__dirname,'../src'));
for(const n of ['core','work-tabs'])vm.runInThisContext(fs.readFileSync(path.join(source,n+'.js'),'utf8'));
function fixture(change={}){
 let owner='same-owner',n=100,created=0,oldActions=0,hook=null;
 const old={url:CrowdCore.HOST+'/search_result?keyword=original',session:'old-ota-session',tab:12,document:'old-document',token:'old-token',state:'opened',...change};
 const business={received:7,outbox:[{request:'unchanged'}],rejected:[{note_id:'old'}],cursor:'original'};
 const data={'work_tabs:same-owner':{search:structuredClone(old)},'agent:same-owner':structuredClone(business)};
 const session={crowd_work_session:'current-session'},tabs=new Map();
 const storage={get:async key=>{if(hook)await hook(key);return structuredClone(data[key]);},set:async(key,value)=>{data[key]=structuredClone(value);}};
 const act=id=>{if(id===12){oldActions++;throw Error('old tab must never be touched');}};
 const chrome={storage:{session:{get:async key=>({[key]:session[key]}),set:async o=>Object.assign(session,o)}},tabs:{get:async id=>{act(id);return tabs.get(id)},update:async id=>{act(id)},remove:async id=>{act(id)},sendMessage:async id=>{act(id)}},windows:{get:async id=>({id,type:'normal',state:'minimized',incognito:false,tabs:[...tabs.values()].filter(t=>t.windowId===id)}),create:async({url})=>{created++;const wid=++n,tab={id:++n,windowId:wid,url,status:'complete'};tabs.set(tab.id,tab);return {id:wid,tabs:[tab]};}}};
 const probe=async id=>{act(id);return {response:{token:'not-current',document:'not-current'}};};
 const w=new CrowdWorkTabs({chrome,storage,owner:async()=>owner,probe,uuid:crypto.randomUUID});
 return {w,old,business,data,setOwner:x=>owner=x,setHook:x=>hook=x,get created(){return created},get oldActions(){return oldActions}};
}
(async()=>{
 const f=fixture();await f.w.open(f.old.url,'search');assert.equal(f.created,1);assert.equal(f.oldActions,0);const entries=f.data['work_tabs:same-owner'];assert.equal(entries.search.session,'current-session');assert.equal(entries.search.state,'opened');assert.notEqual(entries.search.tab,12);const archived=Object.values(entries).filter(e=>e.retired_reason==='browser_session_changed');assert.equal(archived.length,1);assert.deepEqual(archived[0],{...f.old,state:'retired',retired_reason:'browser_session_changed'});assert.deepEqual(f.data['agent:same-owner'],f.business);
 for(const changed of [{state:'opening'},{state:'missing'},{state:'unknown'},{document:null},{document:''},{token:null},{token:''},{session:null},{session:''},{tab:null},{tab:0}]){const x=fixture(changed);await assert.rejects(()=>x.w.open(x.old.url,'search'),/pool_recovery_required/);assert.equal(x.created,0);assert.equal(x.oldActions,0);assert.deepEqual(x.data['work_tabs:same-owner'],{search:x.old});}
 const current=fixture({session:'current-session'});await assert.rejects(()=>current.w.open(current.old.url,'search'),/old tab must never be touched|pool_recovery_required/);assert.equal(current.created,0);assert.equal(Object.keys(current.data['work_tabs:same-owner']).length,1);
 const switched=fixture();let reads=0;switched.setHook(async key=>{if(key==='work_tabs:same-owner'&&++reads===2)switched.setOwner('other-owner')});await assert.rejects(()=>switched.w.open(switched.old.url,'search'),/cancelled/);assert.equal(switched.created,0);assert.equal(switched.oldActions,0);assert.deepEqual(switched.data['work_tabs:same-owner'],{search:switched.old});
 const parallel=fixture();const results=await Promise.allSettled([parallel.w.open(parallel.old.url,'search'),parallel.w.open(parallel.old.url,'search')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(parallel.created,1);assert.equal(parallel.oldActions,0);assert.equal(Object.values(parallel.data['work_tabs:same-owner']).filter(e=>e.retired_reason==='browser_session_changed').length,1);
 console.log('PASS stale opened mapping metadata-only replacement; 11 uncertain-shape rejects; current conflict; owner cancellation; concurrent single creation; business unchanged');
})().catch(e=>{console.error(e);process.exitCode=1});
