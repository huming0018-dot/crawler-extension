/* Explicit local opt-in; consumes one signed upgrade per participant. No external command bridge. */
(function(root){
 'use strict';
 class CrowdLocalTest {
  constructor({storage,id,version,owner,agent,start,isBusy,riskCheck=async()=>false}){Object.assign(this,{storage,id,version,owner,agent,start,isBusy,riskCheck});this.active=null;this.generation=0;this.writes=Promise.resolve();}
  write(owner,generation,change){const key='local-test-update:'+owner;const next=this.writes.catch(()=>{}).then(async()=>{if(generation!==this.generation || owner!==await this.owner())return;const prior=await this.storage.get(key)||{};await this.storage.set(key,change(prior));});this.writes=next;return next;}
  allowed(){return this.id==='ipccepibnkcfpikgebdaanimocdappfk';}
  async status(){const owner=await this.owner();return this.allowed()&&owner?(await this.storage.get('local-test-update:'+owner)||{enabled:false}):{enabled:false};}
  async settings(enabled){
   if(!this.allowed() || typeof enabled!=='boolean')throw Error('invalid_request');
   const generation=++this.generation;
   if(!enabled && this.starting)this.agent.stop('user_stopped',{drain:true}).catch(()=>{});
   const owner=await this.owner();if(!owner)throw Error('backend_login_required');
   if(generation!==this.generation || owner!==await this.owner())throw Error('cancelled');
   await this.write(owner,generation,prior=>({...prior,enabled,baseline:this.version}));
  }
  async cancel(){const generation=++this.generation,owner=await this.owner();if(owner)await this.write(owner,generation,prior=>({...prior,enabled:false}));}
  async run(){if(!this.active)this.active=this.perform().finally(()=>{this.active=null;});return this.active;}
  async perform(){
   if(!this.allowed()||this.agent.stopping||this.agent.stopActive)return;
   const generation=this.generation,owner=await this.owner();if(!owner)return;
   const key='local-test-update:'+owner,prefs=await this.storage.get(key),ticket=await this.storage.get('local_update_verified');
   if(!prefs?.enabled || prefs.baseline===this.version || ticket?.version!==this.version || !/^[a-f0-9]{64}$/.test(ticket.digest))return;
   const consumed=this.version+':'+ticket.digest;if(prefs.consumed===consumed)return;
   let s=await this.agent.read();
   if(s.last_error==='user_stopped')return;
   if(await this.riskCheck(s,owner,async()=>generation===this.generation&&owner===await this.owner()&&(await this.status()).enabled===true))return;
   s=await this.agent.read();
   if(s.pending_risk || ['rate_limit','captcha'].includes(s.last_error))return;
   const scoped=s.consent===CrowdCore.CONSENT && !s.pending_risk && s.test_run?.task_ids?.includes(s.task?.id) && JSON.stringify(s.task.acceptance_task_ids)===JSON.stringify(s.test_run.task_ids);
   const receivedSlots=(s.work_slots||[]).filter(slot=>slot.request && slot.base_received===true && slot.task===s.task?.id && slot.enrichment?.parent===slot.request);
   const validPages=s.outbox?.every(item=>receivedSlots.some(slot=>item.parent===slot.request &&
     (item.kind==='comments' && item.task===slot.task && item.record?.summary?.complete===false && item.record.summary.capture_reason==='interrupted' ||
      item.kind==='note' && item.record?.standard?.note_id===slot.note_id)));
   if(scoped && !s.enabled && s.last_error==='pool_recovery_required' && s.delivery_enabled===true && s.outbox?.length && receivedSlots.length && validPages && !await this.isBusy()) {
    try {for(const item of s.outbox)if(item.kind==='note')CrowdCore.validate(item.record);}catch(_){return;}
    if(generation!==this.generation || owner!==await this.owner())return;
    await this.agent.stop('update_recovery',{drain:true,expectedOwner:owner});
    s=await this.agent.read();
   }
   // Updating an existing bounded run is not a request to start another batch.
   if(s.enabled && ['waiting','active'].includes(s.test_run?.state)) {
    if(generation!==this.generation || owner!==await this.owner())return;
    await this.write(owner,generation,prior=>({...prior,consumed}));return;
   }
   if(!s.enabled && !s.outbox?.length && s.work_slots?.length &&
      s.work_slots.every(slot=>!slot.request || slot.base_received===true) && !await this.isBusy()) {
    if(generation!==this.generation || owner!==await this.owner())return;
    await this.agent.stop('update_recovery',{drain:true,expectedOwner:owner,stoppedCheckpoint:true});
    s=await this.agent.read();
   }
   // A signed opted-in upgrade can repair the old oversized optional-note hold.
   if(!s.enabled && s.last_error==='test_expired' && s.delivery_error==='review_local_rejections' && s.outbox?.length &&
      s.outbox.every(item=>item.kind==='comments' && item.record?.summary?.complete===false && item.record.summary.capture_reason==='interrupted')) {
    const failed=s.rejected?.find(item=>item.kind==='note' && item.reason==='invalid_comments' && item.record?.extra?.comments?.items?.length>50 && s.outbox.every(page=>page.parent===item.parent));
    if(failed) {
     try {CrowdCore.validate(this.agent.legacyCommentNote(failed.record));}
     catch(_){return;}
     if(generation!==this.generation || owner!==await this.owner())return;
     await this.agent.stop('update_recovery',{drain:true,keepPage:true,expectedOwner:owner});
     s=await this.agent.read();
    }
   }
   // Old evidence is never discarded or turned into another participant's trial.
   if(s.enabled || s.outbox?.length || s.work_slots?.length || s.note || s.note_id || s.note_url || s.enrichment || s.reopen || ['note','reopen_note','enrich'].includes(s.phase) || await this.isBusy())return;
   if(generation!==this.generation || owner!==await this.owner())return;
   const beforeStart=await this.agent.read();
   if(this.agent.stopping||this.agent.stopActive||await this.isBusy())return;
   await this.write(owner,generation,prior=>({...prior,consumed}));
   if(generation!==this.generation || owner!==await this.owner())return;
   this.starting=true;
   try {await this.start(async()=>generation===this.generation && owner===await this.owner());}catch(e){
    const after=await this.agent.read();
    const retry=['executor_busy','update_in_progress'].includes(e.message)&&!after.enabled&&!after.outbox?.length&&after.test_run?.id===beforeStart.test_run?.id&&after.test_run?.state===beforeStart.test_run?.state;
    await this.write(owner,generation,prior=>({...prior,error:e.message,...(retry&&prior.consumed===consumed?{consumed:prefs.consumed||null}:{} )}));
   }finally{this.starting=false;}
  }
 }
 root.CrowdLocalTest=CrowdLocalTest;
})(globalThis);
