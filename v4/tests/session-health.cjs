'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const context=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/session-health.js'),'utf8'),context);
const Health=context.CrowdPlatformHealth;
(async()=>{
 let owner='owner-a',now=100000,probes=0,pages={},data={};
 const r={owner:async()=>owner,now:()=>now,storage:{get:async key=>structuredClone(data[key]),set:async(key,value)=>{data[key]=structuredClone(value);}},probe:async()=>{probes++;return pages;}};
 let health=new Health(r);pages={xiaohongshu:{status:'authenticated',principal_ref:'a'.repeat(64)}};
 await health.check();await health.check();assert.equal(probes,1,'at most one DOM scan per minute');
 assert.equal((await health.publicState()).xiaohongshu.status,'authenticated');assert.equal(JSON.stringify(await health.publicState()).includes('aaaa'),false,'public state excludes identity hashes');
 pages={xiaohongshu:{status:'logged_out'}};now+=60001;await health.check();await assert.rejects(()=>health.require('xiaohongshu'),/login_required/);
 health=new Health(r);await assert.rejects(()=>health.require('xiaohongshu'),/login_required/);assert.equal(probes,2,'restart preserves cache/throttle');
 pages={xiaohongshu:{status:'authenticated',principal_ref:'a'.repeat(64)}};now+=60001;await health.check();await health.require('xiaohongshu');assert.equal((await health.publicState()).xiaohongshu.recovered,true);
 pages={};now+=60001;await health.check();await health.require('xiaohongshu');assert.equal((await health.publicState()).xiaohongshu.status,'no_page','ordinary close permits next guarded navigation');
 pages={xiaohongshu:{status:'authenticated',principal_ref:'b'.repeat(64)}};now+=60001;await health.check();await assert.rejects(()=>health.require('xiaohongshu'),/platform_identity_changed/);
 pages={};now+=60001;await health.check();await assert.rejects(()=>health.require('xiaohongshu'),/identity_verification_required/,'closing page never clears a known block');
 await health.confirm('xiaohongshu','b'.repeat(64));pages={xiaohongshu:{status:'authenticated',principal_ref:'b'.repeat(64)}};await health.require('xiaohongshu');
 r.probe=async()=>{throw Error('tab receiver unavailable');};now+=60001;await health.check();assert.equal((await health.publicState()).xiaohongshu.status,'unknown');await assert.rejects(()=>health.require('xiaohongshu'),/identity_verification_required/);
 owner='owner-b';assert.equal((await health.publicState()).xiaohongshu.status,'not_checked');assert.equal(data['platform-health:owner-a'].xiaohongshu.expected_ref,'b'.repeat(64));
 let release;r.probe=()=>new Promise(resolve=>release=resolve);const pending=health.check(true);await new Promise(resolve=>setImmediate(resolve));owner='owner-c';release({xiaohongshu:{status:'logged_out'}});await assert.rejects(()=>pending,/cancelled/);assert.equal(data['platform-health:owner-b'],undefined);
 // A stale monitor cannot stop or overwrite a newly signed-in backend owner.
 for(const file of ['core','agent','kol'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/'+file+'.js'),'utf8'),context);
 let currentOwner='a',releaseRead,cancels=0,rows={'agent:a':{enabled:true,outbox:[],rejected:[]},'agent:b':{enabled:true,outbox:[{request:'b-original'}]},'kol:a':{enabled:true,outbox:[],rejected:[]},'kol:b':{enabled:true,outbox:[{request:'b-original'}]}};
 const storage={get:async key=>key==='session'?{user:{id:currentOwner}}:key==='agent:a'||key==='kol:a'?new Promise(resolve=>releaseRead=()=>resolve(structuredClone(rows[key]))):structuredClone(rows[key]),set:async(key,value)=>{rows[key]=structuredClone(value);}};
 for(const [kind,Agent]of [['agent',context.CrowdAgent],['kol',context.CrowdKOL.Agent]]){
  currentOwner='a';const a=new Agent({storage,now:()=>now,cancel:async()=>{cancels++;},close:async()=>{cancels++;}},{});
  const stopping=kind==='agent'?a.stop('login_required',{keepPage:true,drain:true,expectedOwner:'a'}):a.stop('login_required',true,{keepPage:true,expectedOwner:'a'});
  await new Promise(resolve=>setImmediate(resolve));currentOwner='b';releaseRead();await stopping;assert.equal(rows[kind+':b'].enabled,true);assert.equal(rows[kind+':b'].outbox[0].request,'b-original');assert.equal(cancels,0);
 }
 console.log('PASS platform health: bounded read-only checks, owner isolation, restart, logout/relogin, no-page, explicit account change binding');
})().catch(error=>{console.error(error);process.exitCode=1;});
