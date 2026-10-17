const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict'),path=require('path');
const code=fs.readFileSync(process.argv[2]||path.join(__dirname,'../src/participant-controller.js'),'utf8');
class Element{constructor(id=''){this.id=id;this.children=[];this.textContent='';this.value='';this.checked=false;}append(...x){this.children.push(...x);}replaceChildren(...x){this.children=x;}contains(){return false;}addEventListener(){}setAttribute(){}blur(){}}
function fixture(node,platform){const nodes=new Map(),calls=[],get=id=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id);};
 const data={session:true,legacy_installation:false,node_monitor:node,agent:{enabled:false,phase:'idle',last_error:'test_completed',outbox:[],rejected:[],consent:'CONSENT',test_run:{state:'completed',reason:'test_completed',accepted:[1,2],attempts:2,limit:2,goal:2}},status:{participant:{status:'approved'},received:2,verified:0,reward_fen:0},platform_session:platform,diagnostics:{enabled:true},updater:{enabled:true,state:'current'},parallel_allowed:false};
 const ctx=vm.createContext({console,Date,Set,Map,Promise,Number,Blob,URL,CrowdCore:{VERSION:'4.2.71',CONSENT:'CONSENT'},document:{getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[],hidden:false},chrome:{runtime:{sendMessage:async req=>{calls.push(req);assert.equal(req.type,'state');return {ok:true,data};}}},setInterval(){},setTimeout(){},addEventListener(){}});vm.runInContext(code,ctx);return {nodes,calls,ctx,data};}
const settle=()=>new Promise(r=>setImmediate(r));
function fields(f){const children=f.nodes.get('status').children;return Object.fromEntries(children.reduce((a,x,i)=>{if(i%2===0)a.push([x.textContent,children[i+1].textContent]);return a;},[]));}
(async()=>{
 for(const complete of [false,true]){
  const f=fixture({},{});await settle();await settle();
  Object.assign(f.data.agent,{enabled:true,pilot_waiting:true,pilot_phase:'awaiting_acceptance',received:complete?3:2});
  if(complete)f.data.agent.acceptance_supplement={state:'consumed',extra_limit:1,remaining:0};
  f.data.status.received=complete?3:2;
  await f.nodes.get('refresh').onclick();let v=fields(f);
  if(complete){assert.equal(v['服务端接收'],'3');assert(v['自动执行'].includes('采集已停止'));assert(v['当前阶段'].includes('追加1条'));assert(!f.nodes.get('welcome').textContent.includes('两条'));assert(!v['最早下一步'].includes('启动后自动'));}
  else{assert.equal(v['服务端接收'],'2');assert(v['当前阶段'].includes('两条'));}
  f.data.platform_session={status:'logged_out',reason:'login_required',verification_manual:true,verification_stage:'opened',verification_wait_status:'login_required'};
  await f.nodes.get('refresh').onclick();
  if(complete){assert(f.nodes.get('welcome').textContent.includes('追加1条'));assert(!f.nodes.get('welcome').textContent.includes('两条'));}
  assert(f.calls.every(x=>x.type==='state'));
 }
 console.log('PASS actual controller render: original2 retained; extra1 durable receipt shows3 and stopped; platform warning retains correct batch; refresh is state only');
})().catch(e=>{console.error(e);process.exitCode=1;});
