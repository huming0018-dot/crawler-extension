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
const {f}=await failedKnown();let identities=0,foreignClosed=0;const foreign=randomUUID(),foreignSession=randomUUID();f.api.identity=async()=>{identities++;if(identities===1){f.identity=foreign;f.pro.binding={subject:foreign,installation_id:installation,session:foreignSession,epoch:2};f.pro.port={disconnect(){foreignClosed++;}};return {subject:owner,installation_id:installation};}return {subject:owner,installation_id:installation};};await f.pro.stop();console.log(JSON.stringify({foreign_port_closed:foreignClosed,remaining_port:f.pro.port!==null}));assert.equal(foreignClosed,0,'old Stop failure must not close a replacement owner/session port');
