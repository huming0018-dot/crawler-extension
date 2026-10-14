'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const c=vm.createContext({console});vm.runInContext(fs.readFileSync('v4/src/updater.js','utf8'),c);
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));};
function fixture(enabled,id){
 const data={updater_enabled:enabled,updater_protocol:2},messages=[],alarms=new Map();let host=enabled,release,entered;
 const gate=new Promise(r=>entered=r);let pause=true,fail=false;
 const chrome={runtime:{id,sendNativeMessage:async(_,m)=>{
  messages.push(m);if(m.action==='settings'){
   if(fail) return {status:'error',error:'busy'};
   host=m.enabled;if(pause){pause=false;entered();await new Promise(r=>release=r);}
   return {status:'configured',protocol:2};
  }
  return {status:'ready',protocol:2,version:'4.2.15'};
 }},alarms:{get:async k=>alarms.get(k),create:async(k,v)=>alarms.set(k,v),clear:async k=>alarms.delete(k)}};
 const storage={get:async k=>data[k],set:async(k,v)=>{data[k]=v;}};
 const updater=new c.CrowdUpdater({chrome,storage,agent:{read:async()=>({work_slots:[]})},version:'4.2.15',releaseHash:async()=>'a'.repeat(64)});
 return {updater,data,messages,alarms,gate,release:()=>release(),host:()=>host,fail:v=>fail=v,unpause:()=>pause=false};
}
(async()=>{
 const local=fixture(true,'ipccepibnkcfpikgebdaanimocdappfk');local.unpause();local.alarms.set('crowd_update',{periodInMinutes:60});
 await local.updater.bootstrap();assert.equal(local.alarms.get('crowd_update').periodInMinutes,1,'original local test identity migrates the existing hourly alarm');
 const alarm=local.alarms.get('crowd_update');await local.updater.bootstrap();assert.equal(local.alarms.get('crowd_update'),alarm,'bootstrap does not postpone an already correct alarm');
 await local.updater.setEnabled(false);assert.equal(local.alarms.has('crowd_update'),false);
 await local.updater.setEnabled(true);assert.equal(local.alarms.get('crowd_update').periodInMinutes,1);
 const formal=fixture(true,'formal');formal.unpause();await formal.updater.bootstrap();assert.equal(formal.alarms.get('crowd_update').periodInMinutes,60,'formal release polling remains hourly');
 for(const enabled of [true,false]){
  const f=fixture(!enabled),setting=f.updater.setEnabled(enabled);await f.gate;
  const bootstrap=f.updater.bootstrap();await settle();
  assert.equal(f.messages.filter(m=>m.action==='settings').length,1,'bootstrap cannot write a stale preference during settings IO');
  f.release();await Promise.all([setting,bootstrap]);assert.equal(f.data.updater_enabled,enabled);assert.equal(f.host(),enabled);
 }
 const failed=fixture(false);failed.unpause();failed.fail(true);await assert.rejects(failed.updater.setEnabled(true),/busy/);
 assert.equal(failed.data.updater_enabled,false,'failed native write never claims enabled');
 failed.fail(false);await failed.updater.setEnabled(true);assert.equal(failed.data.updater_enabled,true);assert.equal(failed.host(),true,'failed queue does not poison next setting');
 const disabled=fixture(false);assert.equal((await disabled.updater.check()).blocked,'update_disabled');
 assert.equal(disabled.data.updater_status.error,'update_disabled');assert.equal(disabled.messages.length,0);
 const busy=fixture(true),unknown={request:'original-unknown',outbox:['keep']};busy.updater.agent.read=async()=>({work_slots:[unknown]});busy.updater.isBusy=async()=>true;
 const alarmCheck=busy.updater.check(),manualCheck=busy.updater.check();
 for(const result of await Promise.all([alarmCheck,manualCheck]))assert.equal(result.blocked,'executor_busy','manual caller joining an alarm gets the same blocked reason');
 assert.equal(busy.messages.length,0);assert.equal(busy.data.updater_status.error,'executor_busy');assert.deepEqual(unknown,{request:'original-unknown',outbox:['keep']});
 const afterActive=fixture(true);let checks=0;afterActive.updater.isBusy=async()=>++checks===2;
 assert.equal((await afterActive.updater.check()).blocked,'executor_busy','recheck after active collector has the same explicit outcome');assert.equal(afterActive.messages.length,0);
 const missing=fixture(true);missing.updater.chrome.runtime.sendNativeMessage=null;
 assert.equal((await missing.updater.check()).blocked,'helper_unavailable');assert.equal(missing.messages.length,0);
 console.log('PASS updater preferences: bootstrap/settings serialization, enable/disable, failed native write, recovery');
})().catch(e=>{console.error(e);process.exitCode=1;});
