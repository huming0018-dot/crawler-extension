/* Original-account recovery. Observes existing pages; never copies login credentials. */
(function(root){
 'use strict';
 const HOLD=new Set(['login_required','identity_verification_required','platform_identity_changed']);
 const WAIT=new Set(['session_rest','action_gap','global_pause']);
 const BACKEND=new Set(['backend_login_required','backend_permission_denied']);
 class Session {
  constructor(runtime){this.r=runtime;this.revision=0;this.active=null;this.tail=Promise.resolve();}
  async record(owner){
   const saved=await this.r.storage.get('participant-session:'+owner);if(saved)return saved;
   const s=await this.r.agent.read(),bound=(await this.r.health.read(owner)).xiaohongshu?.expected_ref;
   // 62's first search can stop at its initial login gate before any platform
   // identity/content exists. This is pending initial authorization, not proof
   // of a previous account. Any prior evidence or uncertain operation disallows it.
   const initialLogin=!bound&&s.consent===root.CrowdCore.CONSENT&&s.last_error==='login_required'&&s.task&&Number.isFinite(Date.parse(s.task.lease_until))&&['idle','search'].includes(s.phase)&&!s.received&&!s.note_id&&!s.note_url&&!s.enrichment&&!s.test_run&&!s.sdk_unknown&&!s.sdk_pending&&!s.risk_report&&![s.outbox,s.rejected,s.history,s.seen,s.candidates,s.work_slots].some(a=>a?.length)&&!BACKEND.has(s.delivery_error);
   return {desired_running:s.enabled===true||!!initialLogin,pending:!!initialLogin,reason:initialLogin?'login_required':null,recovered_at:null,initial_login:!!initialLogin};
  }
  async save(owner,value){if(owner!==await this.r.owner())throw Error('cancelled');await this.r.storage.set('participant-session:'+owner,value);}
  async intent(enabled){
   const revision=++this.revision,owner=await this.r.owner();if(!owner)return;
   const job=this.tail.catch(()=>{}).then(async()=>{if(revision!==this.revision||owner!==await this.r.owner())return;const p=await this.record(owner);await this.save(owner,{...p,desired_running:enabled,pending:enabled?p.pending:false,reason:enabled?p.reason:null,recovered_at:null});});this.tail=job;await job;
  }
  async status(){
   const owner=await this.r.owner();if(!owner)return {status:'not_checked',desired_running:false,pending:false};
   const p=await this.record(owner),h=(await this.r.health.publicState()).xiaohongshu,s=await this.r.agent.read(),page=s.verification_page,now=this.r.now();
   let verification_wait_status=null;
   const openedAt=Number.isSafeInteger(page?.opened_at)&&page.opened_at>0&&page.opened_at<=now?page.opened_at:null;
   if(page?.stage==='opened'){
    const checkedAt=Number.isSafeInteger(h.checked_at)&&h.checked_at>0&&h.checked_at<=now?h.checked_at:null;
    const fresh=openedAt!==null&&checkedAt!==null&&checkedAt>=openedAt&&now-checkedAt<=120000;
    const known=fresh&&['login_required','platform_identity_changed','captcha','rate_limit'].includes(h.reason)?h.reason:null;
    const stopped=['test_completed','user_stopped','logged_out','test_partial','test_expired','test_quota'].includes(s.last_error)||s.pilot_waiting===true||s.pilot_phase==='awaiting_acceptance'||!s.enabled&&p.pending!==true;
    verification_wait_status=known||(openedAt!==null&&now-openedAt<120000&&!stopped?'checking':'not_verified');
   }
   return {...h,verification_stage:page?.stage||null,verification_opened_at:openedAt,verification_wait_status,verification_manual:page?.manual===true,verification_error:page?.reason||null,task_closure:s.task_closure?.stage||null,desired_running:p.desired_running===true,pending:p.pending===true,reason:p.reason||h.reason||null,platform_reason:h.reason||null,recovered_at:p.recovered_at||null,initial_confirmed_at:p.initial_confirmed_at||null,wait_until:p.wait_until||null,initial_login:p.initial_login===true};
  }
  reason(entry){return entry?.reason || (entry?.status==='authenticated'&&entry.expected_ref&&entry.expected_ref===entry.observed_ref?null:'identity_verification_required');}
  async require(){const h=await this.r.health.check();const reason=this.reason(h.xiaohongshu);if(reason)throw Error(reason);return h.xiaohongshu;}
  async start(){await this.intent(true);return this.check(true,true);}
  async openLogin(){
   while(this.active)await this.active.catch(()=>{});await this.tail;
   const owner=await this.r.owner(),revision=this.revision;if(!owner)throw Error('backend_login_required');
   const valid=async()=>owner===await this.r.owner()&&revision===this.revision;
   const job=(async()=>{const result=await this.r.recoverPage(valid,{manual:true});if(await valid()){const h=await this.r.health.check(true);if(result.opened&&!result.confirmed&&!this.reason(h.xiaohongshu))await this.r.recoverPage(valid,{confirm:true});}return result;})();
   this.active=job;try{return await job;}finally{if(this.active===job)this.active=null;}
  }
  async check(force=false,explicit=false){
   while(this.active){await this.active.catch(()=>{});if(!force&&!explicit)return;}
   const job=this.inspect(force,explicit);this.active=job;
   try{return await job;}finally{if(this.active===job)this.active=null;}
  }
  async inspect(force,explicit){
   await this.tail;const owner=await this.r.owner(),revision=this.revision;if(!owner)return;
   const valid=async()=>owner===await this.r.owner()&&revision===this.revision;
   let p=await this.record(owner);
   // Persist the inherited running/first-login intent before a source actor can pause.
   if(!await this.r.storage.get('participant-session:'+owner))await this.save(owner,p);
   let s=await this.r.agent.read();if(!await valid())return;
   // A known manual page from a prior Chrome generation cannot supply current DOM proof.
   // Reuse the original recovery metadata path, never adopt/read the stale tab ID.
   const manual=s.verification_page,bound=manual?.manual===true&&['opened','confirmed'].includes(manual.stage)?(await this.r.health.read(owner)).xiaohongshu?.expected_ref:null;
   if(this.r.verificationCurrent&&this.r.recoverPage&&manual?.manual===true&&['opened','confirmed'].includes(manual.stage)&&/^[a-f0-9]{64}$/.test(bound||'')&&manual.expected_ref===bound&&s.last_error!=='user_stopped'&&!this.r.agent.active&&!this.r.agent.stopping&&!this.r.agent.maintenance&&!this.r.agent.recoveryUnsafe(s)){
    let current=null;try{current=await this.r.verificationCurrent(manual.slot);}catch(_){}if(!await valid())return;
    if(current===false){await this.r.recoverPage(valid,{manual:true});if(!await valid())return;s=await this.r.agent.read();}
   }
   // Explicit extra-one permission is the only automatic wake from completed acceptance.
   // A prior user stop, unsafe queue or account mismatch never enters this path.
   if(this.r.supplement&&['test_completed','control_unavailable'].includes(s.last_error)&&s.pilot_waiting===true&&s.pilot_phase==='awaiting_acceptance'&&s.received===2&&!s.task&&!this.r.agent.recoveryUnsafe(s)){
    const resumed=await this.r.supplement(valid);if(!await valid())return;
    s=await this.r.agent.read();if(resumed){p={...p,desired_running:true,pending:false,reason:null};await this.save(owner,p);}
   }
   if(this.r.reconcile&&p.desired_running&&(s.acceptance_reconcile||s.task?.target>0&&s.task.received>=s.task.target)){
    try{await this.r.reconcile(valid);if(!await valid())return;s=await this.r.agent.read();}
    catch(error){if(!await valid()||error.message==='cancelled')return;const reason=error.status===401?'backend_login_required':error.status===403?'backend_permission_denied':error.message;await this.save(owner,{...p,pending:false,reason});await this.r.stop(reason,{keepPage:true,drain:!BACKEND.has(reason),expectedOwner:owner});return;}
    if(s.acceptance_reconcile)return;
   }
   // Completed acceptance has no source work; an OTA's absent receiver must not block cloud parking.
   if(s.enabled&&(s.pilot_waiting||s.pilot_check_pending||s.pilot_phase==='awaiting_acceptance'&&s.last_error==='daily_quota')){
    const h=await this.r.health.check(force);if(!await valid())return;
    if(s.verification_page?.manual&&s.verification_page.stage==='opened'&&!this.reason(h.xiaohongshu)&&this.r.recoverPage)await this.r.recoverPage(valid,{confirm:true});
    const notice=h.xiaohongshu?.reason;
    await this.r.indicate?.({reason:['login_required','captcha','rate_limit','platform_identity_changed'].includes(notice)?notice:s.last_error,pending:false,desired_running:p.desired_running});return;
   }
   // A stopped manual page still needs confirmation after the person logs in.
   // Capture the existing binding before observation; never promote a newly learned account.
   const manualExpected=s.verification_page?.manual===true&&s.verification_page.stage==='opened'?(await this.r.health.read(owner)).xiaohongshu?.expected_ref:null;
   let h=await this.r.health.check(force);if(!await valid())return;
   s=await this.r.agent.read();if(!await valid())return;
   let reason=this.reason(h.xiaohongshu);
   if(manualExpected&&s.verification_page?.manual===true&&s.verification_page.stage==='opened'&&s.verification_page.expected_ref===manualExpected&&h.xiaohongshu?.expected_ref===manualExpected&&!reason&&this.r.recoverPage&&!this.r.agent.active&&!this.r.agent.stopping&&!this.r.agent.maintenance&&!this.r.agent.recoveryUnsafe(s)){
    await this.r.recoverPage(valid,{confirm:true});if(!await valid())return;
    s=await this.r.agent.read();if(!await valid())return;
   }
   const stoppedWait=explicit&&s.last_error==='user_stopped'&&s.first_login_page?.stage==='waiting'&&WAIT.has(s.first_login_page.reason);
   const waiting=p.initial_login&&p.bootstrap_started&&p.desired_running&&s.first_login_page?.task_id===s.task?.id&&['admitting','waiting'].includes(s.first_login_page?.stage)&&(WAIT.has(s.last_error)||stoppedWait)&&!BACKEND.has(s.delivery_error);
   if(waiting&&this.r.bootstrap){
    if(['captcha','rate_limit','platform_identity_changed'].includes(reason)){
     await this.save(owner,{...p,pending:false,reason,wait_until:null});
     if(await valid())await this.r.stop(reason,{keepPage:true,drain:true,expectedOwner:owner});return;
    }
    try{
     const result=await this.r.bootstrap(valid,true,stoppedWait);if(!await valid())return;
     await this.save(owner,{...p,pending:!result?.pilot_waiting,reason:result?.pilot_waiting?'test_completed':result?.waiting?result.reason:'identity_verification_required',wait_until:result?.retry_at||null});
     await this.r.indicate?.({reason:result?.pilot_waiting?'test_completed':result?.waiting?result.reason:'identity_verification_required',pending:!result?.pilot_waiting,desired_running:true});
    }catch(error){
     if(!await valid()||error.message==='cancelled')return;
     const failed=error.status===401?'backend_login_required':error.status===403?'backend_permission_denied':error.message;
     await this.save(owner,{...p,pending:false,reason:failed,wait_until:null});await this.r.stop(failed,{keepPage:true,drain:!BACKEND.has(failed),expectedOwner:owner});
    }
    return;
   }
   const hardTerminal=!!(s.first_login_page&&s.first_login_page.stage!=='opened')||!!s.test_run||s.sdk_unknown||['sending','unknown'].includes(s.sdk_pending?.status)||['sending','unknown'].includes(s.risk_report?.state);
   const terminal=hardTerminal||BACKEND.has(s.last_error)||BACKEND.has(s.delivery_error);
   const recoveryCandidate=this.r.recoverPage&&!terminal&&p.desired_running&&s.pilot_phase==='active'&&h.xiaohongshu?.expected_ref&&
    !['captcha','rate_limit','platform_identity_changed','login_required'].includes(reason)&&
    (!!s.verification_page&&s.verification_page.stage!=='confirmed'||s.verification_page?.manual||['unknown','no_page'].includes(h.xiaohongshu?.status)||await this.r.verificationNeeded?.());
   if(recoveryCandidate){
    try{
     const result=await this.r.recoverPage(valid);if(!await valid())return;
     p={...p,pending:true,reason:result?.waiting?result.reason:'identity_verification_required',wait_until:result?.retry_at||null};await this.save(owner,p);
     if(result?.waiting){await this.r.indicate?.({reason:p.reason,pending:true,desired_running:true});return;}
     h=await this.r.health.check(true);if(!await valid())return;reason=this.reason(h.xiaohongshu);
     if(!reason&&!result?.confirmed){await this.r.recoverPage(valid,{confirm:true});if(!await valid())return;}
     s=await this.r.agent.read();
    }catch(error){
     if(!await valid()||error.message==='cancelled')return;
     const failed=error.status===401?'backend_login_required':error.status===403?'backend_permission_denied':error.message;
     await this.save(owner,{...p,pending:false,reason:failed,wait_until:null});await this.r.stop(failed,{keepPage:true,drain:!BACKEND.has(failed),expectedOwner:owner});
     await this.r.indicate?.({reason:failed,pending:false,desired_running:p.desired_running});return;
    }
   }
   const activationWait=!terminal&&p.desired_running&&!s.enabled&&WAIT.has(s.last_error)&&s.control?.reason===s.last_error&&Number.isFinite(s.next_at);
   if(activationWait){
    p={...p,pending:true,reason:s.last_error,wait_until:s.next_at};await this.save(owner,p);
    if(!reason&&this.r.now()<s.next_at){await this.r.indicate?.({reason:s.last_error,pending:true,desired_running:true});return;}
   }
   // A source-gate failure can reach the actor before this DOM observer.
   if(p.desired_running&&HOLD.has(s.last_error)&&!s.enabled&&!terminal)p={...p,pending:true,reason:s.last_error};
   if(!explicit&&(terminal||!s.enabled&&!HOLD.has(s.last_error)&&!activationWait&&!recoveryCandidate)){
    if(p.pending){p={...p,pending:false,reason:s.last_error||s.delivery_error||null};await this.save(owner,p);}
    await this.r.indicate?.({reason:s.last_error||reason,pending:false,desired_running:p.desired_running});return;
   }
   if(reason){
    const freshPage=p.initial_login&&!p.bootstrap_started&&!h.xiaohongshu?.expected_ref&&['unknown','no_page'].includes(h.xiaohongshu?.status);
    if(freshPage&&p.desired_running&&!terminal&&this.r.bootstrap){
     p={...p,bootstrap_started:true,pending:true,reason:'identity_verification_required'};await this.save(owner,p);
     try{if(await valid()){const result=await this.r.bootstrap(valid);if(await valid()&&(result?.waiting||result?.pilot_waiting))await this.save(owner,{...p,pending:!result.pilot_waiting,reason:result.pilot_waiting?'test_completed':result.reason,wait_until:result.retry_at||null});}}
     catch(error){
      if(!await valid()||error.message==='cancelled')return;
      const failed=error.status===401?'backend_login_required':error.status===403?'backend_permission_denied':error.message;
      await this.save(owner,{...p,pending:false,reason:failed});
      await this.r.stop(failed,{keepPage:true,drain:!BACKEND.has(failed),expectedOwner:owner});
     }
     return;
    }
    if(p.desired_running&&(s.enabled||p.pending||explicit)){
     p={...p,pending:HOLD.has(reason),reason,recovered_at:null,wait_until:null};await this.save(owner,p);
     if(!await valid())return;
     if(s.enabled||s.last_error!==reason)await this.r.stop(reason,{keepPage:true,drain:!BACKEND.has(s.delivery_error),expectedOwner:owner});
    }
    await this.r.indicate?.({reason,pending:p.pending,desired_running:p.desired_running});return;
   }
   if(!explicit&&(!p.desired_running||!p.pending||(!HOLD.has(p.reason)||!HOLD.has(s.last_error))&&!activationWait&&!recoveryCandidate)){await this.r.indicate?.({reason:null,pending:false,desired_running:p.desired_running,recovered_at:p.recovered_at});return;}
   if(!await valid())return;
   try{
    if(hardTerminal)throw Error(s.last_error||'pool_recovery_required');
    // Expired or absent lease proof requires an explicit task reconciliation.
    if(!explicit&&!p.initial_login&&s.task&&!(Date.parse(s.task.lease_until)>this.r.now()))throw Error('lease_lost');
    if(p.pending)await this.r.rebind?.(valid);
    if(!await valid())return;
    await this.r.start(false,{valid,resumePlatform:p.pending===true,resumeInitial:p.initial_login===true});
    if(!await valid())return;
    s=await this.r.agent.read();
    const resumed=s.enabled===true&&(!s.last_error||HOLD.has(s.last_error));
    const waitingStart=!s.enabled&&WAIT.has(s.last_error)&&s.control?.reason===s.last_error&&Number.isFinite(s.next_at),pending=!s.enabled&&(HOLD.has(s.last_error)||waitingStart);
    await this.save(owner,{...p,pending,reason:s.last_error||null,wait_until:waitingStart?s.next_at:null,recovered_at:resumed&&p.pending&&!p.initial_login?this.r.now():null,initial_confirmed_at:resumed&&p.initial_login?this.r.now():p.initial_confirmed_at||null,initial_login:resumed?false:p.initial_login});
    await this.r.indicate?.({reason:s.last_error,pending,desired_running:true,recovered_at:resumed&&p.pending&&!p.initial_login?this.r.now():null});
   }catch(error){
    if(!await valid()||error.message==='cancelled')return;
    const reason=error.status===401?'backend_login_required':error.status===403?'backend_permission_denied':error.message;
    const resume=HOLD.has(reason);await this.save(owner,{...p,pending:resume,reason,recovered_at:null});
    await this.r.stop(reason,{keepPage:true,drain:!BACKEND.has(reason),expectedOwner:owner});
    await this.r.indicate?.({reason,pending:resume,desired_running:true});
    if(explicit)throw Error(reason);
   }
  }
 }
 root.CrowdParticipantSession=Session;
})(globalThis);
