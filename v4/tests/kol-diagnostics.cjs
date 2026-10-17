'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('v4/src/background.js','utf8');
const context=vm.createContext({Date});
vm.runInContext(fs.readFileSync("v4/src/kol.js","utf8"),context);
vm.runInContext(source.match(/const diagnosticErrors = .*;/)[0],context);
vm.runInContext(source.slice(source.indexOf('function kolDiagnosticState('),source.indexOf('async function diagnosticSettings()')),context);
context.input={...context.CrowdKOL.initial(),enabled:true,phase:'discovery_scroll',task:{platform:'bilibili',url:'PRIVATE_URL'},outbox:[{record:'PRIVATE_BODY'}],rejected:[],received:2,attempts:2,checkpoint_revision:3,next_at:Infinity,last_error:'PRIVATE_TOKEN',delivery_enabled:false};
const result=JSON.parse(vm.runInContext('JSON.stringify(kolDiagnosticState(input))',context));
assert.equal(result.platform,'bilibili');assert.equal(result.queued,1);assert.equal(result.error,'unexpected_error');assert.equal(result.next_in_s,0);assert.equal(result.delivery_paused,true);assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
for(const error of ['delivery_retry_limit','platform_identity_changed','old_executor_required','checkpoint_gap','lease_expired','source_not_found','source_private','source_deleted','parser_paused','invalid_overlap_window','incomplete_window_outside_authorization','scan_window_blocked']){context.input.last_error=error;assert.equal(vm.runInContext('kolDiagnosticState(input).error',context),error);}
assert.equal(result.phase,'discovery_scroll');
const calls=[],events=[];
Object.assign(context,{api:{rpc:async(...args)=>{calls.push(args);return {allowed:true,gate:'received'};}},trace:{event:async(...args)=>events.push(args)}});
vm.runInContext(source.slice(source.indexOf('const originalRPC='),source.indexOf('let pendingCommands=0;')),context);
(async()=>{
 await context.api.rpc('kol',{p_action:'guard',p_payload:{action:'detail'}});
 await context.api.rpc('kol',{p_action:'submit',p_payload:{request:'00000000-0000-4000-8000-000000000001',record:'PRIVATE_BODY'}});
 assert.deepEqual(events.map(x=>x[0]),['admission_requested','admission_allowed','submit_requested','submit_accepted']);
 assert.equal(events[2][1].id,'00000000-0000-4000-8000-000000000001');
 assert.equal(JSON.stringify(events).includes('PRIVATE_'),false);
 console.log('PASS KOL opt-in snapshot whitelist and admission/receipt trace integration');
})().catch(e=>{console.error(e);process.exitCode=1;});
