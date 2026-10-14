'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const context=vm.createContext({console,Date,Set,Promise});
for(const f of ['updater.js','node-monitor.js'])vm.runInContext(fs.readFileSync('v4/src/'+f,'utf8'),context);
const account='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(){
 let settings={id:account,enabled:true,revision:1},response={status:'pending_reload',version:'4.2.68'},reloads=0;
 const data={},messages=[],rpc=[];
 const storage={get:async k=>structuredClone(data[k]),set:async(k,v)=>{data[k]=structuredClone(v);}};
 const monitor=new context.CrowdNodeMonitor({storage,settings:async()=>settings,state:async()=>({}),uuid:()=>crypto.randomUUID(),version:'4.2.67',api:{rpc:async(name,p)=>{rpc.push({name,p:structuredClone(p)});if(name==='node_register')return {schema:'crowd-node-v1',registered:true,installation_id:p.p_installation};return {schema:'crowd-step-events-v1',accepted:p.p_events.map(x=>x.event_id),duplicates:[]};}}});
 const reportOTA=async fields=>{if(!settings.enabled||!settings.id)return false;return (await monitor.event('ota',fields))===true;};
 const chrome={runtime:{sendNativeMessage:async(_,m)=>{messages.push(m);return response;},reload:()=>reloads++},alarms:{create:async()=>{},clear:async()=>{},get:async()=>null}};
 const make=(version='4.2.67',report=reportOTA)=>new context.CrowdUpdater({chrome,storage,agent:{},version,releaseHash:async()=>'a'.repeat(64),reportOTA:report});
 return {data,messages,rpc,monitor,make,chrome,get rows(){return data['node-monitor:'+account]?.rows||[];},get reloads(){return reloads;},set response(x){response=x;},set settings(x){settings=x;}};
}
(async()=>{
 let f=fixture();await f.make().check();
 assert.deepEqual(f.rows.map(x=>x.status),['started','waiting']);assert.equal(f.reloads,1);
 assert(f.rows.every(x=>x.step==='ota'&&x.run_id===null));assert(!f.rows.some(x=>x.status==='completed'),'pending reload is not application');
 const exact=f.rows.map(x=>x.event_id);await f.monitor.flush();assert.equal(f.rows.length,0);assert.deepEqual(f.rpc.at(-1).p.p_events.map(x=>x.event_id),exact,'same durable events sent and acknowledged');
 f.response={status:'applied',version:'4.2.68'};await f.make('4.2.68').bootstrap();assert.deepEqual(f.rows.map(x=>x.status),['completed']);
 await f.make('4.2.68').bootstrap();assert.equal(f.rows.length,1,'applied version emitted once across worker restarts');
 f=fixture();f.response={status:'ready',version:'4.2.67'};await f.make().bootstrap();assert.equal(f.rows.length,0,'ready handshake is not signed application');
 f.response={status:'applied',version:'4.2.68'};await f.make().bootstrap();assert.equal(f.rows.length,0,'other disk version is not this loaded worker');
 f=fixture();f.settings={id:account,enabled:false,revision:2};await f.make().check();assert.equal(f.rows.length,0);assert.equal(f.reloads,1,'opt-out has no effect on update');
 f.response={status:'applied',version:'4.2.68'};await f.make('4.2.68').bootstrap();assert(!f.data.updater_telemetry_applied,'opt-out does not consume applied telemetry marker');
 f.settings={id:account,enabled:true,revision:3};await f.make('4.2.68').bootstrap();assert.equal(f.rows.length,1,'later explicit opt-in can record actual applied status');
 f=fixture();f.settings={id:null,enabled:true,revision:2};await f.make().check();assert.equal(f.rows.length,0,'signed-out has no diagnostics');
 f=fixture();f.response={status:'error',error:'invalid_signature',url:'https://private',cookie:'secret'};await f.make().check();assert.deepEqual(f.rows.map(x=>x.status),['started','failed']);assert.equal(f.rows.at(-1).error_code,'unexpected_error');assert(!JSON.stringify(f.rows).includes('private'));assert(!JSON.stringify(f.rows).includes('secret'));
 f=fixture();f.response={status:'error',error:'busy'};await f.make().check();assert.deepEqual(f.rows.map(x=>x.status),['started','waiting']);assert.equal(f.reloads,0);
 f=fixture();await f.make('4.2.67',async()=>{throw Error('telemetry failure');}).check();assert.equal(f.reloads,1);assert.equal(f.data.updater_status.state,'pending_reload','diagnostics failure cannot fail update');
 f=fixture();f.response={status:'pending_reload',version:'4.2.68',poll_status:'pending_reload'};const updater=f.make();await updater.status();updater.pollAt=0;await updater.status();assert.equal(f.rows.length,1,'unchanged poll result does not flood queue');
 f=fixture();f.data.updater_enabled=false;await f.make().check();assert.equal(f.rows.length,0);assert.equal(f.messages.length,0,'OTA opt-out does not invoke host');
 // Check the real participant callback rather than only the fixture callback.
 const source=fs.readFileSync('v4/src/participant-background.js','utf8');const match=source.match(/reportOTA:(async fields=>\{[\s\S]+?\n\}),isBusy:/);assert(match);
 let enabled=false,recorded=0,flushes=0;
 const callback=vm.runInNewContext('('+match[1]+')',{diagnosticSettings:async()=>({enabled,id:account}),nodeMonitor:{event:async(step,fields)=>{assert.equal(step,'ota');assert.deepEqual(Object.keys(fields),['status']);recorded++;return true;}},queueNodeFlush:()=>flushes++});
 await callback({status:'started'});assert.equal(recorded,0);enabled=true;assert.equal(await callback({status:'started'}),true);assert.equal(recorded,1);assert.equal(flushes,1);
 console.log('PASS OTA telemetry: durable ACK, restart application, ready/mismatch exclusion, opt-in/signed-out, bounded fixed fields, busy/failure, failure isolation, poll dedup, real participant wiring');
})().catch(error=>{console.error(error);process.exitCode=1});
