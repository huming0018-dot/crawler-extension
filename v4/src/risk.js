/* Historical risk evidence only pauses/reports; it never adopts a tab or authorizes a source action. */
(function(root){
 'use strict';
 const LOCAL='ipccepibnkcfpikgebdaanimocdappfk',OWNER='7033ff0c-65d7-4963-b65c-a4ac9e31f03a',NOTE='6aad055800000000110325cb';
 class CrowdRisk {
  constructor({id,version,storage,owner,agent,tabs,now=Date.now}){Object.assign(this,{id,version,storage,owner,agent,tabs,now});this.active=null;this.writes=Promise.resolve();this.ledgerWrites=Promise.resolve();}
  allowed(owner){return this.id===LOCAL&&owner===OWNER;}
  key(owner){return 'risk-snapshot:'+owner;}
  async bound(note,sameSession=false,expected=null){
   const session=sameSession?await this.tabs.session():null;
   for(const entry of Object.values(await this.tabs.entries()))try{
    if(entry.document&&entry.token&&entry.session&&(!expected||entry.document===expected.document&&entry.session===expected.session)&&(!sameSession||entry.session===session)&&root.CrowdCore.noteURL(entry.url).id===note)return {session:entry.session,document:entry.document};
   }catch(_){}
   return null;
  }
  async valid(snapshot,state,owner){
   const shape=this.allowed(owner)&&snapshot?.schema===1&&snapshot.gate==='rate_limit'&&snapshot.code===300013&&snapshot.owner===owner&&snapshot.task_id===state.task?.id&&snapshot.run_id===state.test_run?.id&&/^[a-f0-9]{24}$/.test(snapshot.note_id||'')&&typeof snapshot.session==='string'&&!!snapshot.session&&typeof snapshot.document==='string'&&!!snapshot.document&&['observed_navigation','observed_metadata','operator_confirmation'].includes(snapshot.source)&&/^4\.2\.\d+$/.test(snapshot.source_version||'')&&Number(snapshot.source_version.split('.')[2])>=52&&Number(snapshot.source_version.split('.')[2])<=Number(this.version.split('.')[2])&&Number.isSafeInteger(snapshot.at)&&snapshot.at<=this.now()&&this.now()-snapshot.at<=3600000;
   return shape&&await this.bound(snapshot.note_id,false,snapshot)!==null;
  }
  async verified(){const ticket=await this.storage.get('local_update_verified');return ticket?.version===this.version&&/^[a-f0-9]{64}$/.test(ticket.digest||'');}
  async eligible(state,owner){
   return this.allowed(owner)&&!state.enabled&&state.consent===root.CrowdCore.CONSENT&&!state.outbox?.length&&state.last_error==='pool_recovery_required'&&state.pool_failure==='url_changed'&&state.task?.id===17&&state.test_run?.state==='stopped'&&typeof state.test_run.id==='string'&&Number.isSafeInteger(state.test_run.ended_at)&&state.test_run.ended_at<=this.now()&&this.now()-state.test_run.ended_at<=86400000&&await this.bound(NOTE)!==null&&await this.verified();
  }
  async status(){const owner=await this.owner(),state=await this.agent.read();return {can_confirm:await this.eligible(state,owner),source:state.risk_report?.source||null,state:state.risk_report?.state||null};}
  record(...args){const next=this.ledgerWrites.catch(()=>{}).then(()=>this.performRecord(...args));this.ledgerWrites=next;return next;}
  async performRecord(state,owner,note,binding,source,at=this.now(),intent=this.agent.stopIntent||0){
   if(!this.allowed(owner)||!state.task?.id||typeof state.test_run?.id!=='string'||state.last_error==='user_stopped')return null;
   const snapshot={schema:1,gate:'rate_limit',code:300013,owner,task_id:state.task.id,run_id:state.test_run.id,note_id:note,session:binding.session,document:binding.document,source,source_version:this.version,at,state:'pending'};
   const prior=await this.storage.get(this.key(owner));
   if(prior?.run_id===snapshot.run_id&&prior?.note_id===note&&['pending','sending','unknown','acknowledged'].includes(prior.state))return prior;
   const fresh=await this.agent.read(),currentBinding=await this.bound(note,false,binding);
   if(owner!==await this.owner()||(this.agent.stopIntent||0)!==intent||fresh.last_error==='user_stopped'||fresh.test_run?.id!==state.test_run.id||fresh.task?.id!==state.task.id||currentBinding?.session!==binding.session||currentBinding?.document!==binding.document)return null;
   await this.storage.set(this.key(owner),snapshot);return snapshot;
  }
  captureNavigation(details){
   const at=Math.floor(details.timeStamp),intent=this.agent.stopIntent||0;
   if(!Number.isSafeInteger(at)||at>this.now()||this.now()-at>3600000)return Promise.resolve();
   const next=this.writes.catch(()=>{}).then(async()=>{
    if(details.frameId!==0||!this.tabs.rateLimitURL(details.url))return;
    const owner=await this.owner();if(!this.allowed(owner))return;
    const state=await this.agent.read(),since=state.test_run?.first_source_at_ms??state.test_run?.created_at;if(!Number.isSafeInteger(since)||at<since||state.last_error==='user_stopped')return;
    const session=await this.tabs.session(),entries=await this.tabs.entries();
    for(const entry of Object.values(entries))try{
     if(entry.tab!==details.tabId||entry.session!==session||!(entry.state==='opened'||entry.state==='retired'&&entry.retired_reason==='url_changed')||!entry.document||!entry.token)continue;
     const note=root.CrowdCore.noteURL(entry.url).id;
     if(!state.work_slots?.some(slot=>slot.note_id===note&&slot.task===state.task?.id)&&!state.interrupted?.some(item=>item.note_id===note&&item.task===state.task?.id))continue;
     await this.record(state,owner,note,{session:entry.session,document:entry.document},'observed_navigation',at,intent);return;
    }catch(_){}
   });this.writes=next;return next;
  }
  async captureMetadata(evidence){
   const owner=await this.owner(),state=await this.agent.read();if(!this.allowed(owner)||state.last_error==='user_stopped')return;
   const binding=await this.bound(evidence.note_id,true,evidence);
   if(binding?.session!==evidence.session||binding?.document!==evidence.document)return;
   await this.record(state,owner,evidence.note_id,binding,'observed_metadata',evidence.at);
  }
  async preflight(state,owner,valid){
   if(!this.allowed(owner))return false;await this.writes;
   const snapshot=await this.storage.get(this.key(owner));
   if(snapshot&&await this.valid(snapshot,state,owner)&&snapshot.state!=='acknowledged'){
    if(!await this.verified())return true;
    await this.report(snapshot,owner,valid);return true;
   }
   if(state.last_error!=='pool_recovery_required'||![state.pool_failure,state.pool_cleanup_error].includes('url_changed'))return false;
   if(this.agent.active||this.agent.maintenance||this.agent.stopping||this.agent.stopActive||!await valid())return true;
   let evidence;try{evidence=await this.tabs.riskEvidence();}catch(_){return true;}
   if(!evidence||!await valid())return true;
   const entry=(await this.tabs.entries())[evidence.slot],binding=entry?await this.bound(evidence.note_id,true,entry):null;if(!binding)return true;
   const recorded=await this.record(state,owner,evidence.note_id,binding,'observed_metadata');if(recorded)await this.report(recorded,owner,valid);return true;
  }
  async confirm(confirmed){
   if(confirmed!==true)throw Error('risk_confirmation_required');
   const owner=await this.owner(),state=await this.agent.read();if(!await this.eligible(state,owner))throw Error('risk_confirmation_unavailable');
   const binding=await this.bound(NOTE),snapshot=await this.record(state,owner,NOTE,binding,'operator_confirmation');
   const run=state.test_run.id,valid=async()=>owner===await this.owner()&&(await this.agent.read()).test_run?.id===run;
   await this.report(snapshot,owner,valid);return {reported:(await this.storage.get(this.key(owner)))?.state==='acknowledged',source:snapshot.source};
  }
  report(snapshot,owner,valid){if(!this.active)this.active=this.performReport(snapshot,owner,valid).finally(()=>{this.active=null;});return this.active;}
  async performReport(snapshot,owner,valid){
   const state=await this.agent.read();if(['sending','unknown'].includes(state.risk_report?.state))return;if(!snapshot||!await this.valid(snapshot,state,owner)||!await valid()||state.last_error==='user_stopped'||['sending','unknown','acknowledged'].includes(snapshot.state))return;
   if(this.agent.active||this.agent.maintenance||this.agent.stopping||this.agent.stopActive)return;
   // A risk already acknowledged by the normal actor is not reported a second time after reload.
   if(state.control?.reason==='rate_limit'&&state.control_checked>=snapshot.at&&!state.control_error){snapshot.state='acknowledged';await this.storage.set(this.key(owner),snapshot);return;}
   const intent=this.agent.stopIntent||0;this.agent.maintenance=true;
   try{
    await this.agent.stop('rate_limit',{keepPage:true,drain:true,expectedOwner:owner});
    let s=await this.agent.read();if(!await valid()||(this.agent.stopIntent||0)!==intent+1||s.last_error!=='rate_limit')return;
    snapshot.state='sending';await this.storage.set(this.key(owner),snapshot);
    s.failure_kind='platform_gate';s.risk_report={kind:'rate_limit',source:snapshot.source,state:'sending',at:this.now()};await this.agent.save(s);
    const generation=this.agent.generation,alive=()=>{if(generation!==this.agent.generation||(this.agent.stopIntent||0)!==intent+1)throw Error('cancelled');};
    try{const value=await this.agent.control(s,'rate_limit',alive);alive();if(value.reason!=='rate_limit')throw Error('invalid_risk_receipt');if(!await valid())return;s.risk_report.state='acknowledged';}
    catch(_){s.risk_report.state='unknown';s.pending_risk='rate_limit';}
    if(!await valid()||generation!==this.agent.generation||(this.agent.stopIntent||0)!==intent+1)return;
    snapshot.state=s.risk_report.state;await this.agent.save(s);await this.storage.set(this.key(owner),snapshot);
   }finally{this.agent.maintenance=false;}
  }
 }
 root.CrowdRisk=CrowdRisk;
})(globalThis);
