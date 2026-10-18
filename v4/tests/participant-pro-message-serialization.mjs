import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const SRC=process.argv[2]||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src');
const source=fs.readFileSync(path.join(SRC,'participant-pro.js'),'utf8');
const background=fs.readFileSync(path.join(SRC,'participant-background.js'),'utf8');
const binding=background.slice(background.indexOf('async function proIdentity(){'),background.indexOf('const proManualLogin='));
assert.ok(binding.includes('agent.maintenance=lock')&&binding.includes('proBusy(lock)'));
const turn=()=>new Promise(r=>setTimeout(r,5));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function frame(b,state,extra={}){return {schema:'crowd-participant-native-v1',type:'pro_state',id:randomUUID(),session:b.session,epoch:b.epoch,run_id:randomUUID(),state,phase:'local_status',received:0,target:2,pending:0,error:null,...extra};}
async function fixture(){
 const owner=randomUUID(),installation=randomUUID(),rows=new Map(),ports=[],events=[],calls=[];
 let subject=owner,rpcHook=null,ownerHook=null;
 const storage={get:async k=>structuredClone(rows.get(k)),set:async(k,v)=>rows.set(k,structuredClone(v))};
 const agent={generation:15,generationOwner:owner,active:false,maintenance:null,poolJobs:new Set(),initializeGeneration:async()=>{},recoveryUnsafe:s=>!!s.unsafe};
 rows.set('agent',{owner_id:owner,consent:'consent',outbox:[]});rows.set('node-monitor:'+owner,{installation_id:installation});
 const port={sent:[],disconnected:false,postMessage(v){this.sent.push(v);if(v.type==='pro_hello')setTimeout(()=>this.emit(frame(v,'ready')),0);},onMessage:{addListener(fn){port.listener=fn;}},onDisconnect:{addListener(fn){port.disconnecter=fn;}},disconnect(){this.disconnected=true;this.disconnecter?.();},emit(v){return this.listener(v);}};
 const context={TextEncoder,setTimeout,clearTimeout,crypto:{randomUUID},storage,agent,pendingCommands:0,
  runtime:{owner:async()=>{if(ownerHook)await ownerHook();return subject;},leaseScope:async()=> 'a'.repeat(64)},
  CrowdCore:{CONSENT:'consent'},participantSession:{active:false,intent:async()=>{}},platformHealth:{active:false,read:async()=>({xiaohongshu:{expected_ref:'a'.repeat(64)}})},
  nodeMonitor:{register:async()=>assert.fail('unexpected register'),claim:async()=>({task:{id:29,query:'brand',received:0,target:2}}),event:async(...e)=>events.push(e)},queueNodeFlush:()=>{},
  originalRPC:async(method,params)=>{calls.push(method);if(rpcHook)await rpcHook(method);return method==='pro_status'?{task:{id:29,received:2,target:2,status:'complete',source_executor:'mediacrawler_pro'}}:{allowed:true};},
  chrome:{runtime:{connectNative:()=>{ports.push(port);return port;}}}};
 vm.createContext(context);vm.runInContext(source,context);vm.runInContext(binding,context);const pro=vm.runInContext('proParticipant',context);
 await pro.start();await turn();const base=port.sent.find(v=>v.type==='pro_start');assert.ok(base);
 return {pro,port,agent,rows,events,calls,context,base,owner,installation,set rpcHook(v){rpcHook=v;},set subject(v){subject=v;},set ownerHook(v){ownerHook=v;},
  rpc(){return {schema:'crowd-participant-native-v1',type:'rpc_request',id:randomUUID(),session:base.session,epoch:base.epoch,method:'pro_guard',params:{p_task:29,p_lease:randomUUID(),p_action:'control',p_note:null,p_installation_id:installation}};}};
}
let tests=0;async function test(name,body){await body();console.log('PASS',name);tests++;}
await test('actual BG maintenance serializes running behind reverse RPC without losing port',async()=>{
 const f=await fixture(),entered=deferred(),release=deferred();f.rpcHook=async()=>{entered.resolve();await release.promise;};
 f.port.emit(f.rpc());await entered.promise;assert.ok(f.agent.maintenance);f.port.emit(frame(f.base,'running'));await turn();
 assert.equal(f.pro.port,f.port,'valid state while own RPC holds maintenance must not disconnect');
 release.resolve();await turn();await turn();assert.equal((await f.pro.read()).state,'running');assert.equal(f.agent.maintenance,null);assert.equal(f.port.sent.filter(v=>v.type==='rpc_result').length,1);
});
await test('Stop during reverse RPC discards queued running and preserves explicit stop',async()=>{
 const f=await fixture(),entered=deferred(),release=deferred();f.rpcHook=async()=>{entered.resolve();await release.promise;};
 f.port.emit(f.rpc());await entered.promise;f.port.emit(frame(f.base,'running'));await f.pro.stop();release.resolve();await turn();await turn();
 assert.equal((await f.pro.read()).desired_running,false);assert.notEqual((await f.pro.read()).state,'running');assert.equal(f.port.sent.filter(v=>v.type==='pro_stop').length,1);
 f.port.emit(frame(f.base,'stopped'));await turn();assert.equal((await f.pro.read()).state,'stopped');assert.equal(await f.pro.busy(),false);
});
await test('Stop during state identity await cannot overwrite stopped',async()=>{
 const f=await fixture(),entered=deferred(),release=deferred();let once=true;f.ownerHook=async()=>{if(once){once=false;entered.resolve();await release.promise;}};
 f.port.emit(frame(f.base,'running'));await entered.promise;await f.pro.stop();release.resolve();await turn();await turn();assert.equal((await f.pro.read()).desired_running,false);assert.notEqual((await f.pro.read()).state,'running');
});
await test('owner switch while queued blocks late state and no new task RPC',async()=>{
 const f=await fixture(),entered=deferred(),release=deferred();f.rpcHook=async()=>{entered.resolve();await release.promise;};f.port.emit(f.rpc());await entered.promise;f.port.emit(frame(f.base,'running'));f.subject=randomUUID();release.resolve();await turn();await turn();assert.equal(f.calls.length,1);assert.notEqual(f.rows.get('participant-pro:'+f.owner).state,'running');
});
await test('true malformed frame still fails closed',async()=>{const f=await fixture();f.port.emit({...frame(f.base,'running'),extra:true});await turn();assert.equal(f.pro.port,null);assert.equal((await f.pro.read()).error,'participant_protocol_invalid');});
await test('complete remains authoritative status and clean terminal',async()=>{const f=await fixture();f.port.emit(frame(f.base,'complete',{phase:'finish',received:2}));await turn();await turn();assert.deepEqual(f.calls,['pro_status']);assert.equal((await f.pro.read()).state,'complete');assert.equal((await f.pro.read()).desired_running,false);assert.equal(await f.pro.busy(),false);});
await test('queued frames do not deadlock consecutive reverse RPC replies',async()=>{const f=await fixture();f.port.emit(f.rpc());f.port.emit(frame(f.base,'running'));f.port.emit(f.rpc());await turn();await turn();assert.equal(f.port.sent.filter(v=>v.type==='rpc_result').length,2);assert.equal(f.pro.port,f.port);});
await test('known actor denial retains fixed writer code',async()=>{const f=await fixture();f.agent.active=true;f.port.emit(frame(f.base,'running'));await turn();assert.equal(f.pro.port,null);assert.equal((await f.pro.read()).error,'participant_writer_busy');});
await test('unknown thrown message is never exposed',async()=>{const f=await fixture();let first=true;f.ownerHook=async()=>{if(first){first=false;throw Error('private-runtime-details');}};f.port.emit(frame(f.base,'running'));await turn();f.ownerHook=null;assert.equal(f.pro.port,null);assert.equal((await f.pro.read()).error,'participant_protocol_invalid');});
console.log(JSON.stringify({tests,actual_background_binding:true,actual_io:false}));
