import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
const context={TextEncoder,setTimeout,clearTimeout};vm.createContext(context);vm.runInContext(fs.readFileSync(process.argv[2]||new URL('../src/participant-pro.js',import.meta.url),'utf8'),context);
const Pro=context.CrowdParticipantPro;
const owner=randomUUID(),installation=randomUUID();
let tests=0;
const wait=()=>new Promise(r=>setTimeout(r,15));
function fixture(){
 let generation=1,identity=owner,commandBusy=false,claimCalls=0,rpcCalls=[],failMethod=null;
 const values=new Map(),ports=[],events=[];
 const api={storage:{get:async k=>structuredClone(values.get(k)),set:async(k,v)=>values.set(k,structuredClone(v))},owner:async()=>identity,uuid:randomUUID,
 identity:async()=>({subject:identity,installation_id:installation}),scope:async()=>({subject:identity,installation_id:installation,generation}),busy:()=>commandBusy,
 acquire:()=>({}),release:()=>{},intent:async()=>{},event:async(...e)=>events.push(e),principal:async(uid,scope)=>({...scope,matched:true}),
 claim:async()=>{claimCalls++;return {task:{id:21,query:'美食',target:2,received:0}};},
 rpc:async(method,params)=>{rpcCalls.push({method,params});if(failMethod===method)throw Error('offline');return method==='pro_status'?{task:{id:21,source_executor:'mediacrawler_pro',received:2,target:2,status:'complete'}}:{allowed:true};},
 connect:()=>{const port={sent:[],listener:null,disconnecter:null,postMessage(v){this.sent.push(v);if(v.type==='pro_hello')setTimeout(()=>this.emit(state(v,'ready')),0);},onMessage:{addListener(fn){port.listener=fn;}},onDisconnect:{addListener(fn){port.disconnecter=fn;}},disconnect(){this.disconnecter?.();},emit(v){return this.listener(v);}};ports.push(port);return port;}};
 const pro=new Pro(api);
 return {pro,values,ports,events,api,get claimCalls(){return claimCalls;},rpcCalls,set busy(v){commandBusy=v;},set generation(v){generation=v;},set identity(v){identity=v;},set failMethod(v){failMethod=v;}};
}
function state(base,value,extras={}){return {schema:'crowd-participant-native-v1',type:'pro_state',id:randomUUID(),session:base.session,epoch:base.epoch,run_id:null,state:value,phase:'initial',received:null,target:null,pending:0,error:null,...extras};}
function rpc(base,method,params){return {schema:'crowd-participant-native-v1',type:'rpc_request',id:randomUUID(),session:base.session,epoch:base.epoch,method,params};}
async function test(name,fn){await fn();tests++;console.log('PASS',name);}

async function failedKnown(){const f=fixture();await f.pro.start();await wait();const rid=randomUUID();await f.pro.save(owner,{state:'unknown',run_id:rid,error:'participant_protocol_invalid',pending:0});f.pro.closeClean();return {f,rid};}
await test('Disconnected known run Stop reconnects only same old epoch and never launches',async()=>{const {f,rid}=await failedKnown();f.generation=2;await f.pro.stop();const p=f.ports.at(-1),stop=p.sent.find(x=>x.type==='pro_stop');assert.equal(f.ports.length,2);assert.equal(stop.run_id,rid);assert.equal(stop.epoch,1);assert.equal(p.sent.some(x=>x.type==='pro_start'),false);assert.equal(f.claimCalls,1);await f.pro.message(state(stop,'stopped',{run_id:rid}),p);assert.equal(await f.pro.busy(),false);assert.equal((await f.pro.read()).run_id,rid);});
await test('Unknown launch without run remains held and does not reconnect',async()=>{const {f}=await failedKnown();await f.pro.save(owner,{run_id:null});await f.pro.stop();assert.equal(f.ports.length,1);assert.equal(await f.pro.busy(),true);});
await test('Changed installation refuses reconnect and preserves held',async()=>{const {f}=await failedKnown();f.api.identity=async()=>({subject:owner,installation_id:randomUUID()});await f.pro.stop();assert.equal(f.ports.length,1);assert.equal((await f.pro.read()).error,'participant_scope_changed');assert.equal(await f.pro.busy(),true);});
await test('Same owner changing revision during HELLO cannot send delayed stop',async()=>{const {f}=await failedKnown();const connect=f.api.connect;f.api.connect=()=>{const p=connect();const send=p.postMessage;p.postMessage=function(v){if(v.type==='pro_hello')f.pro.revision++;return send.call(p,v);};return p;};await f.pro.stop();assert.equal(f.ports.at(-1).sent.some(x=>x.type==='pro_stop'),false);assert.equal(await f.pro.busy(),true);});
await test('Pending data remains held after typed stopped and cannot be dropped',async()=>{const {f,rid}=await failedKnown();await f.pro.save(owner,{pending:1});await f.pro.stop();const p=f.ports.at(-1),stop=p.sent.find(x=>x.type==='pro_stop');assert.ok(stop);await f.pro.message(state(stop,'stopped',{run_id:rid,pending:1}),p);assert.equal(await f.pro.busy(),true);assert.equal((await f.pro.read()).state,'delivery_unknown');});
console.log(JSON.stringify({passed:tests}));
