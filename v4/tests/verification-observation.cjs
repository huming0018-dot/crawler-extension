const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict'),path=require('path');
const HERE=__dirname,source=path.join(HERE,'../src');
function fixture({age=600000,error='test_completed',enabled=false,pending=false,healthReason=null,healthAge=1000,openedAt,stage='opened'}={}){
 const now=1792238000000,owner='fixture-owner',page={stage,manual:true,slot:'fixture-original',opened_at:openedAt===undefined?now-age:openedAt};
 const state={enabled,last_error:error,phase:'idle',task:{id:1,received:2,target:2},outbox:[],test_run:{state:'completed',limit:2,attempts:2,accepted:[1,2]},verification_page:page};
 const data={['participant-session:'+owner]:{desired_running:enabled,pending},['platform-health:'+owner]:{xiaohongshu:{status:healthReason==='login_required'?'logged_out':'unknown',reason:healthReason,checked_at:now-healthAge}}};
 let writes=0,probes=0,actions=0;const storage={get:async k=>data[k],set:async()=>{writes++;throw Error('unexpected_write');}};
 const context=vm.createContext({console,Date,Set,Promise,Number,CrowdCore:{CONSENT:'fixture'}});
 vm.runInContext(fs.readFileSync(path.join(source,'session-health.js'),'utf8'),context);
 const health=new context.CrowdPlatformHealth({storage,owner:async()=>owner,now:()=>now,probe:async()=>{probes++;throw Error('unexpected_probe');}});
 vm.runInContext(fs.readFileSync(path.join(source,'participant-session.js'),'utf8'),context);
 const session=new context.CrowdParticipantSession({storage,health,owner:async()=>owner,now:()=>now,agent:{read:async()=>state},recoverPage:async()=>{actions++;throw Error('unexpected_action');},start:async()=>{actions++;throw Error('unexpected_start');}});
 return {session,state,hash:()=>JSON.stringify([data,state]),counts:()=>({writes,probes,actions})};
}
async function run(){
 let f=fixture(),before=f.hash(),s=await f.session.status();console.log(JSON.stringify({case:'stopped_old_opened',stage:s.verification_stage,wait:s.verification_wait_status}));assert.equal(s.verification_wait_status,'not_verified');assert.equal(s.verification_stage,'opened');assert.equal(f.hash(),before);assert.deepEqual(f.counts(),{writes:0,probes:0,actions:0});
 const cases=[
  [{age:1000,error:null,enabled:true,pending:true},'checking'],
  [{age:120000,error:null,enabled:true,pending:true},'not_verified'],
  [{age:1000,error:'user_stopped'},'not_verified'],
  [{age:1000,healthReason:'login_required'},'login_required'],
  [{age:5000,healthReason:'platform_identity_changed'},'platform_identity_changed'],
  [{age:5000,healthReason:'captcha'},'captcha'],
  [{age:5000,healthReason:'rate_limit'},'rate_limit'],
  [{age:1000,healthReason:'login_required',healthAge:-1},'not_verified'],
  [{age:5000,healthReason:'login_required',healthAge:6000},'not_verified'],
  [{openedAt:true},'not_verified'],[{openedAt:1792238000001},'not_verified'],
  [{openedAt:NaN},'not_verified'],[{stage:'confirmed'},null]
 ];
 for(const [input,expected]of cases){f=fixture(input);before=f.hash();s=await f.session.status();assert.equal(s.verification_wait_status,expected,JSON.stringify(input));assert.equal(f.hash(),before);assert.deepEqual(f.counts(),{writes:0,probes:0,actions:0});}
 console.log('PASS actual Session.status + original Health.publicState 14 cases: bounded read-only observation, stop/unknown/known/stale/future/type; zero probe/write/start');
}
module.exports={fixture};if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
