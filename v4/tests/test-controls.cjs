'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('v4/src/controller.html','utf8'),elements=new Map();
function element(id=''){return {id,hidden:false,disabled:false,checked:false,value:'',textContent:'',children:[],append(...items){this.children.push(...items);},replaceChildren(){this.children=[];},contains(){return false;},addEventListener(){},setAttribute(){}};}
for(const [,id] of html.matchAll(/id="([^"]+)"/g))elements.set(id,element(id));
const buttons=[...html.matchAll(/<button[^>]*id="([^"]+)"/g)].map(([,id])=>elements.get(id));
const commands=[];let data;
const context=vm.createContext({document:{hidden:false,getElementById:id=>{assert.ok(elements.has(id),id);return elements.get(id);},querySelectorAll:()=>buttons,createElement:()=>element()},chrome:{runtime:{sendMessage:async message=>{
 commands.push(message);if(message.type==='stop')data.agent.enabled=false;if(message.type==='parallelism')data.parallel_requested=message.value;
 return {ok:true,data:structuredClone(data)};
}}},setInterval(){},addEventListener(){},Date,Map,console});
vm.runInContext(fs.readFileSync('v4/src/core.js','utf8'),context);
data={agent:{...context.CrowdCore.initial(),parallelism:1,consent:context.CrowdCore.CONSENT},session:true,parallel_allowed:true,status:{participant:{status:'approved'}}};
vm.runInContext(fs.readFileSync('v4/src/controller.js','utf8'),context);
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
(async()=>{
 await settle();assert.equal(commands.filter(c=>c.type==='state').length,1,'initial render requests state only once');assert.equal(elements.get('parallelism').disabled,false,'initial successful action must unlock immediately');assert.equal(elements.get('consent_section').hidden,true);
 data.local_test=true;data.local_test_updates={enabled:false};await elements.get('refresh').onclick();elements.get('local_test_updates').checked=true;await elements.get('local_test_updates').onchange();assert.equal(commands.at(-2).type,'local_test_updates');assert.equal(commands.at(-2).enabled,true,'capture opt-in before render resets the checkbox');
 for(const [id,type] of [['auto_update','update_settings'],['diagnostics','diagnostics'],['profiles','profiles']]) {
  data.updater={enabled:false};data.diagnostics={enabled:false};data.agent.profiles=false;await elements.get('refresh').onclick();
  elements.get(id).checked=true;await elements.get(id).onchange();assert.equal(commands.at(-2).type,type);assert.equal(commands.at(-2).enabled,true,id+' captures new value before render');
  data.updater={enabled:true};data.diagnostics={enabled:true};data.agent.profiles=true;await elements.get('refresh').onclick();
  elements.get(id).checked=false;await elements.get(id).onchange();assert.equal(commands.at(-2).enabled,false,id+' preserves explicit disable');
 }
 data.agent.enabled=true;data.agent.phase='note';await elements.get('refresh').onclick();assert.equal(elements.get('parallelism').disabled,false,'running collector accepts a pending preference');
 elements.get('parallelism').value='2';await elements.get('parallelism').onchange();assert.equal(commands.at(-2).value,2,'render does not erase selected value before sending');
 assert.equal(elements.get('parallelism').value,'2');assert.match(elements.get('parallel_hint').textContent,/已保存 2 篇.*当前 1 篇.*当前页面/);
 await elements.get('stop').onclick();assert.equal(elements.get('parallelism').disabled,false,'Stop does not require a 10-second poll');
 data.agent.outbox=[{request:'preserved'}];data.agent.work_slots=[{id:'owned'}];await elements.get('refresh').onclick();assert.match(elements.get('parallel_hint').textContent,/1 条待回传.*1 个工作页/);assert.equal(elements.get('parallelism').disabled,false);
 data.agent.test_run={state:'active',attempts:1,accepted:[]};await elements.get('refresh').onclick();assert.equal(elements.get('test_start').disabled,true);assert.match(elements.get('test_status').textContent,/详情尝试 1\/4，有效新回执 0\/2/);
 data.agent.test_run={state:'active',attempts:3,limit:8,goal:4,accepted:[{}]};await elements.get('refresh').onclick();assert.match(elements.get('test_status').textContent,/详情尝试 3\/8，有效新回执 1\/4/);
 for(const state of ['waiting','active']) {
  data.agent.test_run={state,expires_at:Date.now()-1,attempts:1,accepted:[]};data.agent.enabled=false;
  await elements.get('refresh').onclick();assert.equal(elements.get('test_start').disabled,false);assert.match(elements.get('test_status').textContent,/上次测试已过期/);
  data.agent.enabled=true;await elements.get('refresh').onclick();assert.equal(elements.get('test_start').disabled,true,'active executor must stop before replacing expired batch');
 }
 data.agent.enabled=false;
 data.agent.test_run={state:'complete' ,attempts:2,accepted:[{},{}],reason:'test_completed'};await elements.get('refresh').onclick();assert.equal(elements.get('test_start').disabled,false);assert.match(elements.get('test_status').textContent,/已自动停止/);
 console.log('PASS controller UI: immediate initial/Stop unlock, active pending preference captured, exact queue/page wait reasons, consent hidden after enrollment, bounded batch progress');
})().catch(error=>{console.error(error);process.exitCode=1;});
