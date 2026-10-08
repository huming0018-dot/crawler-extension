'use strict';
// node crowd_extension/tests/check.cjs; dependencies only for development, never shipped.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const root = path.resolve(__dirname, '../..');
for (const file of ['core', 'agent', 'api']) vm.runInThisContext(fs.readFileSync(path.join(root,'v4/src',file+'.js'),'utf8'));
const C = CrowdCore;
const id = 'abcdef0123456789abcdef01';
function record(note=id) { return {schema_version:4, standard:{platform:'xiaohongshu', note_id:note,url:C.HOST+'/explore/'+note,title:'测试餐厅 推荐',captured_at:new Date().toISOString(),published_at:null,author_display:null,like_count:null,collect_count:null,comment_count:null},extra:{author_opinion_quotes:['测试餐厅清蒸鱼好吃，服务也很好。'],custom:'保留非标字段'},evidence:{text:'测试餐厅清蒸鱼好吃，服务也很好。',original_length:19,truncated:false,source:'rendered_public_dom',parser_version:'4.0.0',selector:'#detail-desc'}}; }
async function agentChecks() {
 let state={}, now=Date.now(), opened=[], uploads=[], scheduled=[];
 const storage={get:async k=>structuredClone(state[k]),set:async(k,v)=>{state[k]=structuredClone(v);}};
 const task={id:1,query:'测试餐厅',received:0,target:1,lease_token:randomUUID(),lease_until:new Date(now+1200000).toISOString()};
 const api={rpc:async(name,p)=>{
  if(name==='guard')return {version:1,ttl_ms:600000,paused:false,allowed:true,reason:null,wait_ms:0,gap_ms:30000,caps:{search:30,detail:60,comment:120,scroll:120},counts:{search:0,detail:0,comment:0,scroll:0},session_count:0};
  if(name==='status')return {participant:{status:'approved'}};
  if(name==='claim')return {task:structuredClone(task)};
  if(name==='submit'){uploads.push(p);return {inserted:true,duplicate:false,task_received:1,request:p.p_request,gate:'received'};}
  if(name==='finish')return {status:'complete'};
 }};
 let gate=null;
 const runtime={storage,now:()=>now,random:()=>0,uuid:randomUUID,schedule:async n=>scheduled.push(n),cancel:async()=>{},close:async()=>{},open:async url=>opened.push(url),probe:async action=> gate ? {gate,ready:false}: action==='search'?{ready:true,links:[C.HOST+'/explore/'+id+'?xsec_token=local-only']}: action==='note'?{ready:true,record:record()}:{ready:true}};
 let a=new CrowdAgent(runtime,api);
 await assert.rejects(a.start(),/consent_required/); assert.equal(opened.length,0);
 state.agent={...C.initial(),consent:C.CONSENT}; await a.start(); await a.tick();
 state.agent.last_error='page_timeout';
 for(let n=0;n<10 && state.agent.phase!=='note';n++){now+=45000; await a.tick();}
 assert.equal((await a.read()).phase,'note'); assert.equal(uploads.length,0);
 assert.equal(state.agent.last_error,null,'successful page probes clear recovered errors');
 now+=30000; await a.tick(); assert.equal(uploads.length,0,'first note cannot skip dwell');
 now+=30000; await a.tick(); assert.equal(uploads.length,0);
 // Simulate service worker termination by rebuilding the agent from persisted storage.
 a=new CrowdAgent(runtime,api); now+=30000; await a.tick(); assert.equal(state.agent.outbox.length,1);
 state.agent.next_at=now+600000; await a.tick(); assert.equal(uploads.length,1,'outbox flushes during cooldown'); assert.equal(state.agent.outbox.length,0);
 assert.equal(uploads[0].p_record.standard.url.includes('xsec_token'),false);
 state.agent={...C.initial(),enabled:true,consent:C.CONSENT,task:structuredClone(task),phase:'note',page_deadline:now+60000,note_id:id,loaded_at:now-100000,scrolls:2,dwell_ms:45000};
 gate='rate_limit';await a.tick();assert.equal(state.agent.enabled,false);assert.equal(uploads.length,1);
 // A stopped operation must not upload or resurrect enabled=true after an await.
 gate=null;state.agent.enabled=true;state.agent.next_at=0;state.agent.pending_risk=null;
 let release;const waiting=new Promise(resolve=>release=resolve); runtime.probe=async()=>{await waiting;return {ready:true,record:record()};};
 const tick=a.tick();await new Promise(r=>setImmediate(r));const stop=a.stop();release();await Promise.all([tick,stop]);assert.equal(state.agent.enabled,false);assert.equal(state.agent.outbox.length,0);
 state.agent.note_url=C.HOST+'/explore/'+id;state.agent.next_at=0;await a.start();await a.tick();assert.equal(state.agent.phase,'note');assert.equal(state.agent.loaded_at,null,'restart must reload and restart dwell');assert.equal(opened.at(-1),state.agent.note_url);
 await a.stop();state.agent.enabled=true;state.agent.phase='idle';state.agent.task=null;state.agent.day=new Date(now+8*3600000).toISOString().slice(0,10);state.agent.visits=60;state.agent.next_at=0;
 const previousOpens=opened.length;await a.tick();assert.equal(opened.length,previousOpens,'daily browsing budget stops navigation');
 state.agent.consent=null;await a.tick();assert.equal(state.agent.enabled,false);assert.equal(state.agent.last_error,'consent_required');
 // A delayed alarm after sleep must reload the page instead of counting sleep as dwell.
 const wakeOpens=opened.length,wakeUploads=uploads.length;
 state.agent={...C.initial(),enabled:true,consent:C.CONSENT,task:{...task,lease_until:new Date(now+1200000).toISOString()},phase:'note',note_url:C.HOST+'/explore/'+id,note_id:id,loaded_at:now-3600000,scrolls:2,dwell_ms:45000,page_deadline:now-1000,last_tick:now-3600000};
 runtime.probe=async action=>action==='note'?{ready:true,record:record()}:{ready:true};
 await a.tick();assert.equal(state.agent.phase,'note');assert.equal(state.agent.loaded_at,null);assert.equal(state.agent.scrolls,0);assert.equal(opened.length,wakeOpens+1);assert.equal(uploads.length,wakeUploads);
 now+=30000;await a.tick();assert.equal(state.agent.loaded_at,now);assert.equal(state.agent.outbox.length,0,'sleep never supplies the required note dwell');
 // Recovery does not discard evidence, change its receipt or retry before backoff.
 const receipt=randomUUID(),retry=now+300000;
 state.agent.outbox=[{request:receipt,task:task.id,lease:task.lease_token,record:record(),retry_at:retry}];state.agent.next_at=retry;
 await a.tick(true);assert.equal(state.agent.outbox[0].request,receipt);assert.equal(state.agent.outbox[0].retry_at,retry);assert.equal(state.agent.next_at,retry);assert.equal(uploads.length,wakeUploads);
 state.agent.outbox=[];state.agent.phase='search';state.agent.next_at=retry;
 const beforeCooldown=opened.length;await a.tick(true);assert.equal(opened.length,beforeCooldown);assert.equal(state.agent.next_at,retry,'browser startup never bypasses a cooldown');
 state.agent.phase='note';state.agent.next_at=0;state.agent.last_tick=now;state.agent.page_deadline=now+60000;
 runtime.probe=async()=>({ready:false,reopen:true});await a.tick();assert.equal(state.agent.phase,'reopen_note','discarded or missing work tab is reopened');
 for(const reason of ['user_stopped','captcha','rate_limit','logged_out']) {
  state.agent.enabled=false;state.agent.last_error=reason;
  const before=opened.length;await a.tick(true);assert.equal(state.agent.enabled,false);assert.equal(state.agent.last_error,reason);assert.equal(opened.length,before);
 }
  console.log('PASS agent recovery: awake reload resets dwell, receipt/backoff retained, cooldown retained, discarded page restored, stopped/blocked states never auto-enable');
 // An expired lease plus a temporary quota block must retain the same proof.
 let quotaState={agent:{...C.initial(),enabled:true,consent:C.CONSENT,outbox:[{request:receipt,task:task.id,lease:task.lease_token,record:record()}]}};
 const quotaRuntime={...runtime,storage:{get:async k=>structuredClone(quotaState[k]),set:async(k,v)=>quotaState[k]=structuredClone(v)}};
 const quotaAgent=new CrowdAgent(quotaRuntime,{rpc:async name=>name==='submit'?{error:'lease_expired'}:{error:'daily_quota'}});
 await quotaAgent.tick();
 assert.equal(quotaState.agent.outbox.length,1,'quota during renewal must not reject recoverable evidence');
 assert.equal(quotaState.agent.outbox[0].request,receipt);assert.equal(quotaState.agent.rejected.length,0);
 assert.ok(quotaState.agent.outbox[0].retry_at>now);
 // Repeated unavailable pages must eventually pause instead of retrying forever.
 let brokenState={agent:{...C.initial(),enabled:true,consent:C.CONSENT}};
 const brokenRuntime={...runtime,storage:{get:async k=>structuredClone(brokenState[k]),set:async(k,v)=>brokenState[k]=structuredClone(v)},probe:async()=>({ready:false})};
 const broken=new CrowdAgent(brokenRuntime,api);
 for(let attempt=0;attempt<3;attempt++){
  brokenState.agent.next_at=0;await broken.tick(); // Opens a fresh search.
  brokenState.agent.next_at=0;brokenState.agent.page_deadline=now-1;await broken.tick();
 }
 assert.equal(brokenState.agent.enabled,false,'three page failures pause automatic navigation');
 assert.equal(brokenState.agent.last_error,'page_timeout');
 const brokenOpens=opened.length;await broken.tick(true);assert.equal(opened.length,brokenOpens);
 await broken.start();assert.equal(brokenState.agent.page_failures,0,'explicit resume resets the failure budget');
 for(const reason of ['page_loading','content_unavailable','probe_timeout']) {
  brokenRuntime.probe=async()=>({ready:false,reason});await broken.start();
  for(let attempt=0;attempt<3;attempt++){brokenState.agent.next_at=0;await broken.tick();brokenState.agent.next_at=0;brokenState.agent.page_deadline=now-1;await broken.tick();}
  assert.equal(brokenState.agent.enabled,false);assert.equal(brokenState.agent.last_error,reason);
 }
 brokenRuntime.probe=async()=>({ready:true,links:[C.HOST+'/explore/'+id],keyword:'其他餐厅'});
 brokenState.agent.phase='idle';
 await broken.start();brokenState.agent.next_at=0;await broken.tick();brokenState.agent.next_at=0;await broken.tick();
 assert.equal(brokenState.agent.enabled,false);assert.equal(brokenState.agent.last_error,'page_mismatch');assert.equal(brokenState.agent.outbox.length,0);
 console.log('PASS lifecycle failure paths: quota retains evidence; repeated page failures pause until explicit resume');
 // Authentication failures in refresh cannot leak an anon bearer into RPCs.
 const fetches=[];const st={get:async()=>({refresh_token:'refresh',expires_at:0}),set:async()=>{}};
 const client=new CrowdAPI({url:'https://test.supabase.co',key:'sb_publishable_test'},st,async(url,options)=>{fetches.push({url,options});return {ok:false,status:401,json:async()=>({message:'expired'})};});
 await assert.rejects(client.rpc('claim'),e=>e.message==='backend_login_required'&&e.status===401);assert.equal(fetches.length,1);assert.equal(fetches[0].options.headers.Authorization,undefined);
 const scoped=C.accountStorage(storage); state.session={user:{id:'a'}};await scoped.set('agent',{secret:'a'});state.session={user:{id:'b'}};assert.equal(await scoped.get('agent'),undefined);state.session={user:{id:'a'}};assert.equal((await scoped.get('agent')).secret,'a');
  assert.throws(()=>C.noteURL('https://www.xiaohongshu.com.evil.test/explore/'+id));
  assert.equal(C.noteURL('https://m.xiaohongshu.com/discovery/item/'+id+'?xsec_token=local-only').url,C.HOST+'/explore/'+id);
  assert.equal(C.noteURL('/search_result/'+id+'?xsec_token=local-only').url,C.HOST+'/explore/'+id);
  assert.equal(C.navigationURL(C.HOST+'/search_result/'+id+'?xsec_token=local-only'),C.HOST+'/search_result/'+id+'?xsec_token=local-only');
  for (const value of ['/search_result/?keyword=其他词','/search_result/not-a-note','/search_result/'+id+'/private']) assert.throws(()=>C.noteURL(value));
  assert.equal(C.navigationURL('https://m.xiaohongshu.com/explore/'+id),'https://m.xiaohongshu.com/explore/'+id);
  for (const url of ['https://m.xiaohongshu.com.evil.test/explore/','https://user@m.xiaohongshu.com/explore/','http://m.xiaohongshu.com/explore/','https://m.xiaohongshu.com:8443/explore/']) assert.throws(()=>C.noteURL(url+id));
 console.log('PASS agent: automatic cycle, first dwell, worker restart, cooldown upload, rate stop, cancellation, auth refresh, account isolation');
}
async function databaseChecks() {
 const pg=require(process.env.CROWD_TEST_TOOLS+'/node_modules/pg');
 const pool=new pg.Pool({connectionString:process.env.CROWD_TEST_DATABASE_URL,max:4});
 try {
  const existing=(await pool.query("select to_regclass('auth.users') as users,to_regnamespace('crowd_v4') as crowd")).rows[0];
  assert.equal(existing.users,null,'Refuse any existing auth database: this check needs an empty disposable database');
  assert.equal(existing.crowd,null,'Refuse an existing crowd schema');
  await pool.query(`do $$ begin
   if not exists(select from pg_roles where rolname='anon') then create role anon;end if;
   if not exists(select from pg_roles where rolname='authenticated') then create role authenticated;end if;
   if not exists(select from pg_roles where rolname='service_role') then create role service_role;end if;
  end $$;create schema auth;create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
  grant usage on schema auth to authenticated,service_role;grant execute on function auth.uid(),auth.role() to authenticated,service_role;`);
  await pool.query(fs.readFileSync(path.join(process.env.CROWD_MIGRATIONS_DIR,'20261006145016_crowd_v4.sql'),'utf8'));
  await pool.query(fs.readFileSync(path.join(process.env.CROWD_MIGRATIONS_DIR,'20261006145030_crowd_v4_invites.sql'),'utf8'));
  const users=[randomUUID(),randomUUID()];for(const user of users)await pool.query('insert into auth.users(id)values($1)',[user]);
  async function call(user,name,params=[],role='authenticated') {
   const client=await pool.connect();try{await client.query('begin');await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)",[user||'',role]);
    const r=await client.query(`select public.crowd_v4_${name}(${params.map((_,i)=>'$'+(i+1)).join(',')}) as value`,params);
    await client.query('commit');return r.rows[0].value;
   } catch(e){await client.query('rollback');throw e;}finally{client.release();}
  }
  const admin=(action,p)=>call(null,'admin',[action,p],'service_role');
  await assert.rejects(call(users[0],'claim',[null]),/approval_required/);
  for(const u of users){await call(u,'register',[C.CONSENT]);await admin('approve',{user_id:u,quota_day:100});}
  await assert.rejects(call(users[0],'admin',['approve',{user_id:users[0]}]),/permission denied/);
  await assert.rejects(call(null,'status',[],'anon'),/permission denied/);
  const makeTask=async(key,target=20)=>admin('publish',{source_key:key,query:'测试餐厅',store_name:'测试餐厅',anchor_terms:['测试餐厅'],target});
  await makeTask('one');await makeTask('two');
  const [one,two]=await Promise.all(users.map(u=>call(u,'claim',[null])));assert.notEqual(one.task.id,two.task.id,'concurrent claims must be exclusive');
  const request=randomUUID(),rec=record();
  for(const [change,expected] of [
   [r=>r.standard.url='https://www.xiaohongshu.com.evil.test/explore/'+id,'invalid_record'],
   [r=>delete r.standard.like_count,'invalid_record'],
   [r=>r.standard.like_count='12','invalid_record'],
   [r=>r.standard.like_count=-1,'invalid_record'],
   [r=>r.standard.like_count=2147483648,'invalid_record'],
   [r=>r.extra.author_opinion_quotes=['这句话不存在于公开正文'],'invalid_record'],
   [r=>r.evidence.source='private_api','invalid_record'],
   [r=>r.standard.captured_at='2099-01-01T00:00:00Z','invalid_timestamp'],
   [r=>{r.standard.title='其他店铺';r.evidence.text='另一家餐厅的无关笔记内容。';r.extra.author_opinion_quotes=[];},'unrelated_note']
  ]) { const r=structuredClone(rec);change(r);assert.equal((await call(users[0],'submit',[randomUUID(),one.task.id,one.task.lease_token,r])).error,expected); }
  await pool.query("update crowd_v4.tasks set lease_until=now()-interval '1 minute' where id=$1",[one.task.id]);
  assert.equal((await call(users[0],'submit',[randomUUID(),one.task.id,one.task.lease_token,rec])).error,'lease_expired');
  const renewed=await call(users[0],'claim',[one.task.id]);assert.equal(renewed.task.id,one.task.id);assert.equal(renewed.task.lease_token,one.task.lease_token);
  const receipt=await call(users[0],'submit',[request,one.task.id,one.task.lease_token,rec]);assert.equal(receipt.inserted,true);assert.equal(receipt.gate,'received');
  const reviewQueue=await admin('list',{kind:'proofs'});assert.equal(reviewQueue.length,1);assert.equal(reviewQueue[0].note_id,id);
  assert.equal((await admin('list',{kind:'participants'})).length,2);
  const duplicate=await call(users[1],'submit',[randomUUID(),two.task.id,two.task.lease_token,rec]);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.inserted,false);assert.equal(duplicate.task_received,0);
  let status=await call(users[0],'status');assert.equal(status.verified,0);assert.equal(status.reward_fen,0);
  assert.equal((await call(users[1],'submit',[randomUUID(),one.task.id,one.task.lease_token,rec])).error,'lease_lost');
  await call(users[0],'finish',[one.task.id,one.task.lease_token]);
  assert.deepEqual(await call(users[0],'submit',[request,one.task.id,one.task.lease_token,rec]),receipt,'receipt must survive closed task');
  assert.equal((await call(users[0],'submit',[request,one.task.id,one.task.lease_token,{...rec,extra:{different:true}}])).error,'request_reused');
  const proof=(await pool.query('select id from crowd_v4.proofs')).rows[0];
  await assert.rejects(admin('review',{proof_id:proof.id,decision:'verified',reason:'足够长的审核理由',quote:rec.evidence.text}),/strict_evidence_gate/);
  const review=async(proof_id)=>admin('review',{proof_id,decision:'verified',reason:'已独立检查公开原帖堂食证据',quote:rec.evidence.text,public_visible:true,relevant:true,personal_experience:true,source_checked_at:new Date().toISOString()});
  await review(proof.id);await review(proof.id);assert.equal((await call(users[0],'status')).verified,1);
  // Real submission + review path to 100, not a synthetic counter update.
  let lease;
  for(let i=1;i<100;i++){
   if(!lease||i%20===1){if(lease)await call(users[0],'finish',[lease.id,lease.lease_token]);await makeTask('reward-'+i,20);lease=(await call(users[0],'claim',[null])).task;}
   const r=record(i.toString(16).padStart(24,'0'));
   const result=await call(users[0],'submit',[randomUUID(),lease.id,lease.lease_token,r]);assert.equal(result.inserted,true);
   const p=(await pool.query('select id from crowd_v4.proofs where note_id=$1',[r.standard.note_id])).rows[0];await review(p.id);
   if(i===98){status=await call(users[0],'status');assert.equal(status.verified,99);assert.equal(status.reward_fen,0);assert.equal(status.remainder,99);}
  }
  status=await call(users[0],'status');assert.equal(status.verified,100);assert.equal(status.reward_fen,10);assert.equal(status.remainder,0);
  assert.equal((await admin('list',{kind:'rewards'})).length,1);
  const exported=await admin('export',{after_id:0});assert.equal(exported.length,100);
  const firstExport=await admin('export',{after_id:0,through_id:proof.id});assert.equal(firstExport.length,1);
  assert.equal(firstExport[0].store_name,'测试餐厅');assert.equal(firstExport[0].verified_quote,rec.evidence.text);
  assert.equal((await admin('export',{after_id:proof.id})).length,99);
  assert.deepEqual(await admin('export',{after_id:proof.id,through_id:proof.id}),[]);
  await admin('pay',{user_id:users[0],batch_no:1,reference:'TEST-PAYMENT'});await admin('pay',{user_id:users[0],batch_no:1,reference:'TEST-PAYMENT'});
  await assert.rejects(admin('pay',{user_id:users[0],batch_no:1,reference:'CHANGED'}),/payment_not_found_or_conflict/);
  assert.equal((await call(users[0],'status')).paid_fen,10);
  const invitation=(action,payload)=>call(null,'invite',[action,payload],'service_role');
  const tokenHash='a'.repeat(64),deviceHash='b'.repeat(64),otherDevice='c'.repeat(64);
  await assert.rejects(call(users[0],'invite',['check',{token_hash:tokenHash}]),/permission denied/);
  await invitation('create',{token_hash:tokenHash,max_people:1,quota_day:7,expires_at:new Date(Date.now()+86400000).toISOString()});
  const allocations=await Promise.allSettled([deviceHash,otherDevice].map(device_hash=>invitation('reserve',{token_hash:tokenHash,device_hash,platform:'android'})));
  assert.equal(allocations.filter(x=>x.status==='fulfilled').length,1,'cohort capacity must remain atomic');
  const winner=allocations.findIndex(x=>x.status==='fulfilled'),winnerHash=[deviceHash,otherDevice][winner],allocation=allocations[winner].value;
  assert.deepEqual(await invitation('reserve',{token_hash:tokenHash,device_hash:winnerHash,platform:'android'}),allocation,'retry uses the original reserved identity');
  await assert.rejects(invitation('complete',{token_hash:tokenHash,device_hash:winnerHash,consent:C.CONSENT}),/account_not_ready/);
  await pool.query('insert into auth.users(id)values($1)',[allocation.user_id]);
  await assert.rejects(invitation('complete',{token_hash:tokenHash,device_hash:winnerHash,consent:'wrong'}),/consent_required/);
  await invitation('complete',{token_hash:tokenHash,device_hash:winnerHash,consent:C.CONSENT});
  assert.equal((await call(allocation.user_id,'status')).participant.status,'approved');
  assert.equal((await call(allocation.user_id,'status')).participant.quota_day,7);
  await admin('suspend',{user_id:allocation.user_id});
  await invitation('complete',{token_hash:tokenHash,device_hash:winnerHash,consent:C.CONSENT});
  assert.equal((await call(allocation.user_id,'status')).participant.status,'suspended','invite replay cannot restore suspended access');
  await invitation('revoke',{token_hash:tokenHash});await assert.rejects(invitation('check',{token_hash:tokenHash}),/invite_expired/);
  const oldHash='d'.repeat(64);await invitation('create',{token_hash:oldHash,max_people:1,expires_at:new Date(Date.now()+10000).toISOString()});
  await pool.query("update crowd_v4.invites set expires_at=now()-interval '1 second' where token_hash=$1",[oldHash]);
  await assert.rejects(invitation('reserve',{token_hash:oldHash,device_hash:otherDevice,platform:'android'}),/invite_expired/);
  assert.equal((await invitation('list',{})).some(row=>'token_hash' in row),false);
  console.log('PASS invitations: service-only, atomic cohort cap, interrupted registration identity, consent, automatic approval, suspension preserved, expiry/revocation');
  console.log('PASS PostgreSQL: migration, roles, concurrent leases, renewal, malformed proofs, global dedupe, identity, receipts, strict evidence, filtered export, 99/100 rewards, immutable payment');
 }finally{await pool.end();}
}
(async()=>{await agentChecks();if(process.env.CROWD_TEST_DATABASE_URL)await databaseChecks();else console.log('SKIP database (set CROWD_TEST_DATABASE_URL for an empty disposable database)');})().catch(e=>{console.error(e);process.exitCode=1});
