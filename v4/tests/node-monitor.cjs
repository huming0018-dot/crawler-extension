'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const context=vm.createContext({console,Date,Set,Promise});
vm.runInContext(fs.readFileSync('v4/src/node-monitor.js','utf8'),context);
const account='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',run='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const plain=x=>JSON.parse(JSON.stringify(x));
function fixture(){
 let settings={id:account,enabled:true,revision:1},now=1800000000000,state={enabled:true,login_state:'ready'};
 const data={},calls=[];let handler=async(name,p)=>{
  if(name==='node_register')return {schema:'crowd-node-v1',installation_id:p.p_installation,registered:true,diagnostics_enabled:settings.enabled};
  if(name==='node_claim')return {task:{id:42,lease_token:'existing'},node_run:{run_id:run,installation_id:p.p_installation,task_id:42}};
  if(name==='step_events')return {schema:'crowd-step-events-v1',accepted:p.p_events.map(e=>e.event_id),duplicates:[],diagnostics_enabled:settings.enabled};
  if(name==='claim')return {task:null};
  throw Error('unexpected RPC');
 };
 const storage={get:async k=>data[k]===undefined?undefined:structuredClone(data[k]),set:async(k,v)=>{data[k]=structuredClone(v);}};
 const api={rpc:async(name,p,...rest)=>{calls.push({name,p:plain(p),rest});return handler(name,p,...rest);}};
 const make=()=>new context.CrowdNodeMonitor({storage,api,settings:async()=>settings,state:async()=>state,uuid:()=>crypto.randomUUID(),now:()=>now,version:'4.2.60'});
 return {data,calls,make,get settings(){return settings;},set settings(v){settings=v;},set handler(v){handler=v;},get handler(){return handler;},set now(v){now=v;},set state(v){state=v;}};
}
(async()=>{
 let f=fixture(),m=f.make();const first=await m.claim();
 assert.equal(first.task.node_run.run_id,run);assert.equal(first.task.lease_token,'existing');
 assert.deepEqual(f.calls.map(x=>x.name),['node_register','node_claim']);
 await m.claim();assert.equal(f.calls.filter(x=>x.name==='node_register').length,1);assert.equal(f.calls.filter(x=>x.name==='claim').length,0);
 await m.event('comments',{status:'completed',duration_ms:15,counts:{comments:10,token:'secret'},cookie:'secret',url:'secret',error_code:'secret'});
 const key='node-monitor:'+account;
 assert(!JSON.stringify(f.data[key]).includes('secret'));assert.equal(f.data[key].rows.at(-1).error_code,'unexpected_error');
 const ids=f.data[key].rows.map(x=>x.event_id),seq=f.data[key].seq,install=f.data[key].installation_id;
 const normal=f.handler;f.handler=async(name,p)=>{if(name==='step_events')throw Error('network may have written');return normal(name,p);};
 await m.flush();assert.deepEqual(f.data[key].rows.map(x=>x.event_id),ids);assert.equal(f.data[key].last_error,'telemetry_unavailable');
 m=f.make();f.handler=normal;await m.flush();assert.equal(f.data[key].rows.length,0);assert.equal(f.data[key].installation_id,install);assert.equal(f.data[key].seq,seq);
 await m.event('receipt',{counts:{received:1}});const retained=f.data[key].rows[0].event_id;
 f.handler=async(name,p)=>name==='step_events'?{schema:'crowd-step-events-v1',accepted:[crypto.randomUUID()],duplicates:[],diagnostics_enabled:true}:normal(name,p);
 await m.flush();assert.equal(f.data[key].rows[0].event_id,retained,'foreign ACK cannot evict telemetry');
 f.handler=normal;f.settings={...f.settings,enabled:false,revision:2};await m.flush();assert.equal(f.data[key].rows.length,0);
 await m.claim();assert.equal(f.calls.at(-1).name,'node_claim','opt-out must not disable task claim');await m.event('detail');assert.equal(f.data[key].rows.length,0);
 f=fixture();m=f.make();f.handler=async()=>{throw Object.assign(Error('missing RPC'),{code:'PGRST202'});};
 const fallback=f.handler;f.handler=async(name,p)=>name==='claim'?{task:null}:fallback(name,p);await m.claim();
 assert.deepEqual(f.calls.map(x=>x.name),['node_register','claim']);assert.equal((await m.snapshot()).state,'backend_upgrade_required');
 f=fixture();m=f.make();const n=f.handler;f.handler=async(name,p)=>name==='node_claim'?Promise.reject(Error('timeout unknown')):n(name,p);
 await assert.rejects(m.claim(),/timeout unknown/);assert(!f.calls.some(x=>x.name==='claim'),'unknown claim must not call legacy claim');
 f=fixture();m=f.make();for(let i=0;i<1030;i++)await m.event('comments',{counts:{pages:i}});
 assert.equal(f.data[key].rows.length,1000);assert(f.data[key].rows.some(x=>x.step==='telemetry_gap'));assert(f.data[key].dropped>0);
 assert.equal(new Set(f.data[key].rows.map(x=>x.node_seq)).size,1000);assert.equal(new Set(f.data[key].rows.map(x=>x.event_id)).size,1000);
 const before=f.data[key].rows.length;await m.event('https://private');assert.equal(f.data[key].rows.length,before);
 // Events recorded while a batch is in flight must survive its ACK.
 f=fixture();m=f.make();await m.claim();let send,release;const sent=new Promise(r=>send=r),hold=new Promise(r=>release=r),old=f.handler;
 f.handler=async(name,p)=>{if(name==='step_events'){send();await hold;}return old(name,p);};
 const flush=m.flush();await sent;await m.event('comments',{counts:{comments:2}});const pendingId=f.data[key].rows.at(-1).event_id;release();await flush;
 assert.equal(f.data[key].rows.length,1);assert.equal(f.data[key].rows[0].event_id,pendingId);
 // Account switches during a network response cannot leak a run into the new account.
 f=fixture();m=f.make();const original=f.handler;f.handler=async(name,p)=>{const result=await original(name,p);if(name==='node_claim')f.settings={...f.settings,id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'};return result;};
 await assert.rejects(m.claim(),/cancelled/);assert.equal(f.data[key].run_id,null);assert(!f.data['node-monitor:'+f.settings.id]);
 // A paused/expired login state must replace a previous ready registration.
 f=fixture();m=f.make();await m.register();f.state={enabled:false,login_state:'needs_login'};await m.register();
 assert.equal(f.calls.filter(x=>x.name==='node_register').length,2);assert.equal(f.calls.at(-1).p.p_state.login_state,'needs_login');
 f.now=1800000061000;await m.register();assert.equal(f.calls.filter(x=>x.name==='node_register').length,3,'idle heartbeat refreshes even unchanged state');
 f.settings={...f.settings,enabled:false};f.now=1800000122000;await m.flush();assert.equal(f.calls.at(-1).name,'node_register','diagnostics opt-out still reports necessary execution registration');
 // Capture identity before the storage queue: queued old-account events must be discarded.
 f=fixture();m=f.make();let unblock;await m.register();m.queue=new Promise(r=>unblock=r);
 const queued=m.event('session',{status:'failed',error_code:'login_required'});
 f.settings={...f.settings,id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'};unblock();await queued;
 assert.equal(f.data[key].rows.length,0);assert(!f.data['node-monitor:'+f.settings.id]);
 f=fixture();m=f.make();await m.event('navigation',{status:'started'});assert.equal(f.data[key].rows[0].step,'telemetry_gap','upgraded unbound active task cannot poison all telemetry writes');
 f.settings={...f.settings,enabled:false,revision:2};f.handler=async()=>{throw Error('registration offline');};await m.flush();
 assert.equal(f.data[key].rows.length,0,'opt-out erases local logs even while registration is offline');
 f=fixture();m=f.make();let backend=f.handler;
 f.handler=async(name,p)=>{const v=await backend(name,p);return name==='node_register'?{...v,max_node_seq:500}:v;};
 await m.register();await m.event('session');assert.equal(f.data[key].rows[0].node_seq,501);
 f.handler=async(name,p)=>name==='step_events'?{schema:'crowd-step-events-v1',accepted:[],duplicates:[],discarded:p.p_events.map(x=>x.event_id),discard_reason:'sequence_not_retained',diagnostics_enabled:true}:backend(name,p);
 await m.flush();assert.equal(f.data[key].rows.length,1);assert.equal(f.data[key].rows[0].step,'telemetry_gap');assert.equal(f.data[key].dropped,1);
 // Only the three explicit server-wait reasons are added; arbitrary strings remain redacted.
 f=fixture();m=f.make();await m.claim();
 for(const reason of ['session_rest','action_gap','global_pause'])await m.event('session',{status:'waiting',error_code:reason});
 assert.deepEqual(f.data[key].rows.slice(-3).map(x=>x.error_code),['session_rest','action_gap','global_pause']);
 await m.event('session',{status:'waiting',error_code:'unknown server text'});assert.equal(f.data[key].rows.at(-1).error_code,'unexpected_error');
 await m.flush();assert.equal(f.data[key].rows.length,0);assert.deepEqual(f.calls.find(x=>x.name==='step_events').p.p_events.filter(x=>x.error_code&&x.error_code!=='unexpected_error').map(x=>x.error_code),['session_rest','action_gap','global_pause']);
 console.log('PASS node monitor: one claim, durable same-ID retry, opt-out, bounded gap, safe payload, concurrent ACK and account switch');
})().catch(error=>{console.error(error);process.exitCode=1;});
