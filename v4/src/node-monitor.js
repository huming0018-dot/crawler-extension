/* Durable, account-bound step telemetry. Collection receipts remain a separate outbox. */
(function(root){
 'use strict';
 const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const STEPS=new Set(['claim','session','navigation','list','detail','comments','media','subtitle','outbox','upload','receipt','stop','ota','telemetry_gap']);
 const STATUS=new Set(['started','completed','waiting','failed','skipped']);
 const ERRORS=new Set(['login_required','backend_login_required','identity_verification_required','platform_identity_changed','captcha','rate_limit','navigation_failed','navigation_uncommitted','page_timeout','page_loading','content_unavailable','probe_timeout','page_mismatch','wrong_note','lease_lost','daily_quota','session_rest','action_gap','global_pause','user_stopped','backend_unavailable','control_unavailable','invalid_receipt','cancelled','unexpected_error']);
 const COUNTS=['contents','comments','replies','media','queued','received','pages','source_actions'];
 const TRACE={worker_started:['session','started'],admission_requested:['session','started'],admission_allowed:['session','completed'],admission_denied:['session','waiting'],open_requested:['navigation','started'],tab_created:['navigation','started'],tab_reused:['navigation','started'],update_accepted:['navigation','started'],update_failed:['navigation','failed'],nav_started:['navigation','started'],nav_committed:['navigation','started'],nav_dom_ready:['navigation','completed'],nav_complete:['navigation','completed'],nav_failed:['navigation','failed'],probe_ready:['detail','completed'],probe_missing:['detail','waiting'],probe_timeout:['detail','failed'],navigation_timeout:['navigation','failed'],submit_requested:['upload','started'],submit_accepted:['receipt','completed'],submit_rejected:['receipt','failed'],submit_failed:['upload','failed']};
 const missing=error=>error?.code==='PGRST202';
 class CrowdNodeMonitor {
  constructor({storage,api,settings,state=async()=>({enabled:false,login_state:'unknown'}),uuid,now=Date.now,version}){
   Object.assign(this,{storage,api,settings,state,uuid,now,version});this.queue=Promise.resolve();this.registered=null;this.registering=null;this.flushing=null;this.legacy=false;
  }
  serial(fn){const next=this.queue.then(fn);this.queue=next.catch(()=>{});return next;}
  async identity(){const s=await this.settings();if(!UUID.test(s.id||''))throw Error('backend_login_required');return s;}
  async same(s){const current=await this.settings();return current.id===s.id&&current.revision===s.revision;}
  key(id){return 'node-monitor:'+id;}
  async record(s){
   let value=await this.storage.get(this.key(s.id));
   if(!value||!UUID.test(value.installation_id||'')){
    value={installation_id:this.uuid(),seq:0,rows:[],run_id:null,dropped:0};
    if(!UUID.test(value.installation_id))throw Error('invalid_installation');
    if(!await this.same(s))throw Error('cancelled');await this.storage.set(this.key(s.id),value);
   }
   return value;
  }
  async register(signal){
   const s=await this.identity();
   const raw=await this.state();
   const p_state={version:this.version,enabled:raw.enabled===true,login_state:['ready','needs_login','verification','unknown'].includes(raw.login_state)?raw.login_state:'unknown'};
   if(/^[0-9a-f]{64}$/.test(raw.release_digest||''))p_state.release_digest=raw.release_digest;
   const signature=JSON.stringify(p_state),age=this.now()-(this.registered?.at||0);
   if(this.registered?.id===s.id&&this.registered.signature===signature&&age>=0&&age<60000)return;
   if(this.registering){await this.registering;return this.register(signal);}
   this.registering=(async()=>{
    const value=await this.serial(()=>this.record(s));
    if(!await this.same(s))throw Error('cancelled');
    try{
     const result=await this.api.rpc('node_register',{p_installation:value.installation_id,p_state},signal);
     if(result?.schema!=='crowd-node-v1'||result.registered!==true||result.installation_id!==value.installation_id)throw Error('invalid_node_registration');
     if(result.max_node_seq!==undefined){
      if(!Number.isSafeInteger(result.max_node_seq)||result.max_node_seq<0)throw Error('invalid_node_registration');
      await this.serial(async()=>{const v=await this.record(s);if(await this.same(s))await this.storage.set(this.key(s.id),{...v,seq:Math.max(v.seq,result.max_node_seq)});});
     }
     if(!await this.same(s))throw Error('cancelled');this.legacy=false;this.registered={id:s.id,signature,at:this.now()};
    }catch(error){
     // Only a confirmed absent RPC permits compatibility. Timeouts may have reached the server.
     if(missing(error)&&await this.same(s)){this.legacy=true;this.registered={id:s.id,signature,at:this.now()};return;}
     throw error;
    }
   })().finally(()=>{this.registering=null;});return this.registering;
  }
  async claim(taskId=null,signal,metrics=null){
   const s=await this.identity();await this.register(signal);
   if(!await this.same(s))throw Error('cancelled');
   if(this.legacy)return this.api.rpc('claim',{p_task:taskId},signal,metrics);
   const value=await this.serial(()=>this.record(s));
   const result=await this.api.rpc('node_claim',{p_installation:value.installation_id,p_task:taskId},signal,metrics);
   if(!await this.same(s))throw Error('cancelled');
   if(result?.task){
    const run=result.node_run;
    if(!run||!UUID.test(run.run_id||'')||run.installation_id!==value.installation_id||String(run.task_id)!==String(result.task.id))throw Error('invalid_node_run');
    result.task.node_run={...run};
    await this.serial(async()=>{const current=await this.record(s);if(!await this.same(s))throw Error('cancelled');await this.storage.set(this.key(s.id),{...current,run_id:run.run_id});});
   }
   await this.event('claim',{status:result?.task?'completed':result?.error?'waiting':'skipped'});
   return result;
  }
  event(step,fields={}){
   if(TRACE[step]){const mapped=TRACE[step];step=mapped[0];fields={...fields,status:mapped[1]};}
   if(!STEPS.has(step))return Promise.resolve();
   const captured=this.settings();
   return this.serial(async()=>{
    const s=await captured;if(!UUID.test(s.id||'')||!await this.same(s))return;
    const value=await this.record(s);
    if(!s.enabled){if(value.rows.length)await this.storage.set(this.key(s.id),{...value,rows:[]});return;}
    const at=Math.floor(this.now());if(!Number.isSafeInteger(at)||at<0||at>4102444800000)return;
    const row={event_id:this.uuid(),node_seq:value.seq+1,run_id:value.run_id||null,step,status:STATUS.has(fields.status)?fields.status:'completed',at_ms:at,duration_ms:null,error_code:null};
    // An in-flight task from an older build has no server run binding until its next claim.
    if(!row.run_id&&!['claim','session','stop','ota','telemetry_gap'].includes(row.step)){row.step='telemetry_gap';row.status='skipped';}
    if(!UUID.test(row.event_id)||!Number.isSafeInteger(row.node_seq))return;
    if(Number.isSafeInteger(fields.duration_ms)&&fields.duration_ms>=0&&fields.duration_ms<=86400000)row.duration_ms=fields.duration_ms;
    if(fields.error_code)row.error_code=ERRORS.has(fields.error_code)?fields.error_code:'unexpected_error';
    const counts={};for(const name of COUNTS)if(Number.isSafeInteger(fields.counts?.[name])&&fields.counts[name]>=0&&fields.counts[name]<=100000)counts[name]=fields.counts[name];
    if(Object.keys(counts).length)row.counts=counts;
    let rows=[...value.rows,row],dropped=value.dropped||0;
    if(rows.length>1000){
     dropped+=value.rows.length-998;row.node_seq++;
     rows=[...value.rows.slice(-998),{event_id:this.uuid(),node_seq:value.seq+1,run_id:row.run_id,step:'telemetry_gap',status:'skipped',at_ms:at,duration_ms:null,error_code:null},row];
    }
    if(!await this.same(s))return;await this.storage.set(this.key(s.id),{...value,seq:row.node_seq,rows,dropped});return true;
   }).catch(()=>{});
  }
  async flush(signal){
   if(this.flushing)return this.flushing;
   this.flushing=(async()=>{
    const s=await this.identity();
    if(!s.enabled){
     await this.serial(async()=>{const v=await this.record(s);if(await this.same(s))await this.storage.set(this.key(s.id),{...v,rows:[]});});
     await this.register(signal).catch(()=>{});return;
    }
    await this.register(signal);
    if(this.legacy)return;
    const value=await this.serial(()=>this.record(s)),rows=value.rows.slice(0,50);
    if(!rows.length||!await this.same(s))return;
    try{
     const ack=await this.api.rpc('step_events',{p_installation:value.installation_id,p_events:rows},signal);
     if(ack?.schema!=='crowd-step-events-v1'||!Array.isArray(ack.accepted)||!Array.isArray(ack.duplicates))throw Error('invalid_telemetry_ack');
     const discarded=ack.discarded||[];
     if(!Array.isArray(discarded)||(discarded.length&&ack.discard_reason!=='sequence_not_retained'))throw Error('invalid_telemetry_ack');
     const sent=new Set(rows.map(x=>x.event_id)),ids=[...ack.accepted,...ack.duplicates,...discarded];
     if(ids.some(id=>!sent.has(id)))throw Error('invalid_telemetry_ack');
     await this.serial(async()=>{
      const v=await this.record(s);if(!await this.same(s))return;const accepted=new Set(ids);
      await this.storage.set(this.key(s.id),{...v,rows:ack.diagnostics_enabled===false?[]:v.rows.filter(x=>!accepted.has(x.event_id)),dropped:(v.dropped||0)+discarded.length,last_sent_at:this.now(),last_error:null});
     });
     if(discarded.length&&await this.same(s))await this.event('telemetry_gap',{status:'skipped'});
    }catch(error){
     await this.serial(async()=>{const v=await this.record(s);if(await this.same(s))await this.storage.set(this.key(s.id),{...v,last_error:'telemetry_unavailable'});});
     // Retain exact event IDs after unknown writes. Never retry by creating new events.
    }
   })().finally(()=>{this.flushing=null;});return this.flushing;
  }
  async snapshot(){
   const s=await this.settings();if(!UUID.test(s.id||''))return {state:'signed_out',queued:0};
   const v=await this.serial(()=>this.record(s));
   return {state:this.legacy?'backend_upgrade_required':s.enabled?'enabled':'disabled',queued:v.rows.length,dropped:v.dropped||0,last_sent_at:v.last_sent_at||null,error:v.last_error||null};
  }
 }
 root.CrowdNodeMonitor=CrowdNodeMonitor;
})(globalThis);
