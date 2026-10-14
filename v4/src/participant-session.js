/* Original-account recovery. Observes existing pages; never copies login credentials. */
(function(root){
 'use strict';
 const HOLD=new Set(['login_required','identity_verification_required','platform_identity_changed']);
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
  async status(){const owner=await this.r.owner();if(!owner)return {status:'not_checked',desired_running:false,pending:false};const p=await this.record(owner),h=(await this.r.health.publicState()).xiaohongshu;return {...h,desired_running:p.desired_running===true,pending:p.pending===true,reason:p.reason||h.reason||null,recovered_at:p.recovered_at||null,initial_confirmed_at:p.initial_confirmed_at||null,initial_login:p.initial_login===true};}
  reason(entry){return entry?.reason || (entry?.status==='authenticated'&&entry.expected_ref&&entry.expected_ref===entry.observed_ref?null:'identity_verification_required');}
  async require(){const h=await this.r.health.check();const reason=this.reason(h.xiaohongshu);if(reason)throw Error(reason);return h.xiaohongshu;}
  async start(){await this.intent(true);return this.check(true,true);}
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
   const h=await this.r.health.check(force);if(!await valid())return;
   let s=await this.r.agent.read();if(!await valid())return;
   const reason=this.reason(h.xiaohongshu);
   const hardTerminal=!!(s.first_login_page&&s.first_login_page.stage!=='opened')||!!s.test_run||s.sdk_unknown||['sending','unknown'].includes(s.sdk_pending?.status)||['sending','unknown'].includes(s.risk_report?.state);
   const terminal=hardTerminal||BACKEND.has(s.last_error)||BACKEND.has(s.delivery_error);
   // A source-gate failure can reach the actor before this DOM observer.
   if(p.desired_running&&HOLD.has(s.last_error)&&!s.enabled&&!terminal)p={...p,pending:true,reason:s.last_error};
   if(!explicit&&(terminal||!s.enabled&&!HOLD.has(s.last_error))){
    if(p.pending){p={...p,pending:false,reason:s.last_error||s.delivery_error||null};await this.save(owner,p);}
    await this.r.indicate?.({reason:s.last_error||reason,pending:false,desired_running:p.desired_running});return;
   }
   if(reason){
    const freshPage=p.initial_login&&!p.bootstrap_started&&!h.xiaohongshu?.expected_ref&&['unknown','no_page'].includes(h.xiaohongshu?.status);
    if(freshPage&&p.desired_running&&!terminal&&this.r.bootstrap){
     p={...p,bootstrap_started:true,pending:true,reason:'identity_verification_required'};await this.save(owner,p);
     try{if(await valid())await this.r.bootstrap(valid);}
     catch(error){
      if(!await valid()||error.message==='cancelled')return;
      const failed=error.status===401?'backend_login_required':error.status===403?'backend_permission_denied':error.message;
      await this.save(owner,{...p,pending:false,reason:failed});
      await this.r.stop(failed,{keepPage:true,drain:!BACKEND.has(failed),expectedOwner:owner});
     }
     return;
    }
    if(p.desired_running&&(s.enabled||p.pending||explicit)){
     p={...p,pending:HOLD.has(reason),reason,recovered_at:null};await this.save(owner,p);
     if(!await valid())return;
     if(s.enabled||s.last_error!==reason)await this.r.stop(reason,{keepPage:true,drain:!BACKEND.has(s.delivery_error),expectedOwner:owner});
    }
    await this.r.indicate?.({reason,pending:p.pending,desired_running:p.desired_running});return;
   }
   if(!explicit&&(!p.desired_running||!p.pending||!HOLD.has(p.reason)||!HOLD.has(s.last_error))){await this.r.indicate?.({reason:null,pending:false,desired_running:p.desired_running,recovered_at:p.recovered_at});return;}
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
    await this.save(owner,{...p,pending:!s.enabled&&HOLD.has(s.last_error),reason:s.last_error||null,recovered_at:resumed&&p.pending&&!p.initial_login?this.r.now():null,initial_confirmed_at:resumed&&p.initial_login?this.r.now():p.initial_confirmed_at||null,initial_login:resumed?false:p.initial_login});
    await this.r.indicate?.({reason:s.last_error,pending:!s.enabled&&HOLD.has(s.last_error),desired_running:true,recovered_at:resumed&&p.pending&&!p.initial_login?this.r.now():null});
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
