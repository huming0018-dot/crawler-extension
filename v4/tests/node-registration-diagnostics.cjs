const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict'),crypto=require('crypto'),path=require('path');
const HERE=__dirname,src=fs.readFileSync(path.join(HERE,'../src/node-monitor.js'),'utf8');
function fixture(enabled=true){
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',installation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',ctx=vm.createContext({Date,Set,Promise});vm.runInContext(src,ctx);
 let now=Date.now(),settings={id,revision:1,enabled};const data={};
 data['node-monitor:'+id]={installation_id:installation,seq:340,rows:[],run_id:null,dropped:0};
 const calls=[];let response=async(n,p)=>({schema:'crowd-node-v1',registered:true,installation_id:p.p_installation,max_node_seq:340});
 const storage={get:async k=>data[k],set:async(k,v)=>data[k]=v};
 const state={enabled:false,login_state:'unknown',last_error:'test_completed',outbox:[],server_received:2};
 const monitor=new ctx.CrowdNodeMonitor({storage,api:{rpc:async(n,p)=>{calls.push({n,p});return response(n,p);}},settings:async()=>settings,state:async()=>state,uuid:()=>crypto.randomUUID(),now:()=>now,version:'4.2.71'});
 return {monitor,calls,state,data,id,installation,setNow:v=>now=v,now:()=>now,setResponse:v=>response=v,setSettings:v=>settings=v};
}
(async()=>{
 const missingFixture=fixture();const unavailable=Error('missing RPC');unavailable.code='PGRST202';missingFixture.setResponse(async()=>{throw unavailable});await missingFixture.monitor.register();const missingSnapshot=await missingFixture.monitor.snapshot();console.log(JSON.stringify({case:'missing_node_register_rpc',state:missingSnapshot.state,last_registered_at:missingSnapshot.last_registered_at,registration_error:missingSnapshot.registration_error}));assert.equal(missingSnapshot.last_registered_at,null,'a missing node_register RPC cannot count as an actual registration confirmation');

 for(const opted of [true,false]){
  const f=fixture(opted);await f.monitor.flush();await f.monitor.flush();assert.equal(f.calls.length,1);f.setNow(f.now()+61000);await f.monitor.flush();assert.equal(f.calls.length,2);assert(f.calls.every(c=>c.n==='node_register'&&c.p.p_installation===f.installation&&c.p.p_state.enabled===false));assert.equal(f.state.server_received,2);assert.equal(f.state.last_error,'test_completed');assert.equal(f.data['node-monitor:'+f.id].seq,340);assert.equal(f.data['node-monitor:'+f.id].rows.length,0);
  const snap=await f.monitor.snapshot();assert.equal(snap.installation_id,f.installation);assert.equal(snap.last_registered_at,f.now());assert.equal(snap.registration_error,null);
 }
 const f=fixture();const err=Error('SYNTHETIC_SECRET_URL');f.setResponse(async()=>{throw err;});await assert.rejects(f.monitor.register(),e=>e===err);assert.equal((await f.monitor.snapshot()).registration_error,'node_register_unavailable');assert(!JSON.stringify(await f.monitor.snapshot()).includes('SYNTHETIC_SECRET'));
 f.setSettings({id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',enabled:true,revision:2});const changed=await f.monitor.snapshot();assert.equal(changed.last_registered_at,null);assert.equal(changed.registration_error,null);
 console.log('PASS stopped/approved/old2/outbox0 register heartbeats diagnostics-on/off; fixed safe error/context isolation; 0claim/capture/source');
})().catch(e=>{console.error(e);process.exitCode=1;});
