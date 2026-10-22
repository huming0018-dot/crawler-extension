'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('v4/src/participant-background.js','utf8'),begin=source.indexOf('let indicatedPlatformSession=null;'),end=source.indexOf('async function repairPlatformHealth()',begin);assert(begin>=0&&end>begin);
const events=[],titles=[];let owner='first';
const context=vm.createContext({runtime:{owner:async()=>owner},nodeMonitor:{event:async(...args)=>events.push(structuredClone(args))},queueNodeFlush:()=>{},chrome:{action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async v=>titles.push(v.title)}}});
vm.runInContext(source.slice(begin,end),context);
(async()=>{
 await context.indicatePlatformSession({reason:'test_completed',pending:false});await context.indicatePlatformSession({reason:'test_completed',pending:false});
 assert.equal(events.length,1);assert.deepEqual(events[0],['session',{status:'waiting',error_code:null}]);
 for(const reason of ['session_rest','action_gap','global_pause','login_required','captcha','rate_limit','platform_identity_changed']){
  await context.indicatePlatformSession({reason,pending:false});assert.equal(events.at(-1)[1].status,'waiting');assert.equal(events.at(-1)[1].error_code,reason);
 }
 assert.match(titles.at(-1),/切回原账号/);owner='second';await context.indicatePlatformSession({reason:'platform_identity_changed',pending:false});assert.equal(events.length,9,'identity switch has a distinct event boundary');
 const saveBegin=source.indexOf('const saveAgent=agent.save.bind(agent);'),saveEnd=source.indexOf('api.rpc=async',saveBegin);
 context.agent={save:async()=>{}};vm.runInContext(source.slice(saveBegin,saveEnd),context);events.length=0;
 await context.agent.save({enabled:true,phase:'enrich',last_error:'daily_quota',outbox:[],received:2});events.length=0;
 await context.agent.save({enabled:true,phase:'enrich',last_error:'test_completed',outbox:[],received:2});assert.equal(events.length,1);assert.equal(events[0][1].error_code,null);
 await context.agent.save({enabled:true,phase:'enrich',last_error:'test_completed',outbox:[],received:2});assert.equal(events.length,1,'save repeats dedupe');
 await context.agent.save({enabled:false,phase:'enrich',last_error:'test_completed',outbox:[],received:2});assert.equal(events.at(-1)[1].error_code,null);
 console.log('PASS actual background status events: normal completion has no error, real reasons preserved, dedupe and owner boundary');
})().catch(e=>{console.error(e);process.exitCode=1;});
