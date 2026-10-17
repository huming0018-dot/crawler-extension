const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict'),path=require('path');
const code=fs.readFileSync(path.join(__dirname,'../src/participant-controller.js'),'utf8');
class Element{constructor(id=''){this.id=id;this.children=[];this.textContent='';this.value='';this.checked=false;}append(...x){this.children.push(...x);}replaceChildren(...x){this.children=x;}contains(){return false;}addEventListener(){}setAttribute(){}blur(){}}
function fixture(node,platform){const nodes=new Map(),calls=[],get=id=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id);};
 const data={session:true,legacy_installation:false,node_monitor:node,agent:{enabled:false,phase:'idle',last_error:'test_completed',outbox:[],rejected:[],consent:'CONSENT',test_run:{state:'completed',reason:'test_completed',accepted:[1,2],attempts:2,limit:2,goal:2}},status:{participant:{status:'approved'},received:2,verified:0,reward_fen:0},platform_session:platform,diagnostics:{enabled:true},updater:{enabled:true,state:'current'},parallel_allowed:false};
 const ctx=vm.createContext({console,Date,Set,Map,Promise,Number,Blob,URL,CrowdCore:{VERSION:'4.2.71',CONSENT:'CONSENT'},document:{getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[],hidden:false},chrome:{runtime:{sendMessage:async req=>{calls.push(req);assert.equal(req.type,'state');return {ok:true,data};}}},setInterval(){},setTimeout(){},addEventListener(){}});vm.runInContext(code,ctx);return {nodes,calls,ctx,data};}
const settle=()=>new Promise(r=>setImmediate(r));
function fields(f){const children=f.nodes.get('status').children;return Object.fromEntries(children.reduce((a,x,i)=>{if(i%2===0)a.push([x.textContent,children[i+1].textContent]);return a;},[]));}
(async()=>{
 const id='6a88f8fd-c41d-4e5e-ab24-efc2c622d575';let f=fixture({state:'enabled',installation_id:id,last_registered_at:Date.now()-1000,registration_error:null});await settle();await settle();let v=fields(f);assert.equal(v['本设备安装编号'],id);assert(v['设备连接诊断'].includes('不代表平台登录或新采集回执'));assert.equal(v['自动执行'],'已停止');assert.equal(v['服务端接收'],'2');assert(f.nodes.get('test_status').textContent.includes('已完成'));await f.nodes.get('refresh').onclick();assert(f.calls.every(c=>c.type==='state'));
 f=fixture({installation_id:'<script>SYNTHETIC_SECRET</script>',last_registered_at:Date.now()+100000,registration_error:'SYNTHETIC_SECRET'});await settle();await settle();v=fields(f);assert(v['本设备安装编号'].includes('尚未确认'));assert.equal(v['最近设备登记确认'],'本次插件运行尚未确认');assert(!JSON.stringify(v).includes('SYNTHETIC_SECRET'));
 f=fixture({installation_id:id,last_registered_at:true,registration_error:'node_register_unavailable'});await settle();await settle();v=fields(f);assert.equal(v['最近设备登记确认'],'本次插件运行尚未确认');assert(v['设备连接诊断'].includes('暂未确认'));assert(f.calls.every(c=>c.type==='state'));
 for(const [received,verified,expected] of [[2,0,true],[0,0,false],[true,0,false],['2',0,false],[-1,0,false],[2,false,false],[2,'0',false],[2,undefined,false],[2,1,false]]){
  const q=fixture({},{});q.data.status.received=received;q.data.status.verified=verified;await settle();await settle();await q.nodes.get('refresh').onclick();const note=fields(q)['接收与核验说明'];assert.equal(typeof note==='string',expected);if(expected){assert(note.includes('分别统计'));assert(note.includes('不等于已判无效'));assert(!/本批|尚待|[1-9]/.test(note));}assert(q.calls.every(c=>c.type==='state'));
 }
 const model=require('./verification-observation.cjs');
 const examples=[
  [{},/尚未核验/],
  [{age:1000,error:null,enabled:true,pending:true},/最多2分钟/],
  [{age:1000,healthReason:'login_required'},/需要登录/],
  [{age:5000,healthReason:'platform_identity_changed'},/账号.*不同/],
  [{age:5000,healthReason:'captcha'},/本人处理验证/],
  [{age:5000,healthReason:'rate_limit'},/限流/]
 ];
 for(const [input,pattern] of examples){const m=model.fixture(input),before=m.hash(),platform=await m.session.status();const page=fixture({},platform);await settle();await settle();const view=fields(page);assert.match(view['页面连接'],pattern);if(platform.verification_wait_status!=='checking')assert(!view['页面连接'].includes('正在'));assert.equal(m.hash(),before);assert.deepEqual(m.counts(),{writes:0,probes:0,actions:0});assert(page.calls.every(c=>c.type==='state'));}
 console.log('PASS full actual controller VM: original stopped/2old/approved retained; node ID/time/safe error visible; existing refresh only state; invalid/future values withheld');
})().catch(e=>{console.error(e);process.exitCode=1;});
