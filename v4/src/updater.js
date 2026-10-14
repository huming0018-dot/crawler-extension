/* Fixed native protocol; no scripts/paths/URLs are accepted from a message. */
(function(root){
 'use strict';
 class CrowdUpdater {
  constructor({chrome,storage,agent,version,releaseHash,isBusy=()=>false,reportOTA=async()=>false}) {Object.assign(this,{chrome,storage,agent,version,releaseHash,isBusy,reportOTA});this.active=null;this.updatePeriod=60;}
  async telemetry(status) {
   // Diagnostics failure cannot change signed update or restart behavior.
   try {return await this.reportOTA({status,error_code:status==='failed'?'unexpected_error':null});}catch(_){return false;}
  }
  async applied(r) {
   try {
    if(r.status!=='applied'||r.version!==this.version)return;
    if(await this.storage.get('updater_telemetry_applied')===this.version)return;
    if(await this.telemetry('completed'))await this.storage.set('updater_telemetry_applied',this.version);
   }catch(_){}
  }
  async send(action, extra={}) {
   const message={action,version:this.version,...extra};if(action==='ack')message.release_sha256=await this.releaseHash();
   const host='com.crowd.v4.updater';
   const result=await this.chrome.runtime.sendNativeMessage(host,message);
   if(!result || typeof result.status!=='string')throw Error('invalid_response');
   if(result.status==='error')throw Error(['invalid_signature','hash_mismatch','permission_change','replayed_release','recovery_required','handshake_mismatch','version_mismatch','busy'].includes(result.error)?result.error:'update_failed');
   return result;
  }
  async status() {
   const saved=await this.storage.get('updater_status')||{};
   let poll=await this.storage.get('updater_poll')||{};
   if(this.chrome.runtime.sendNativeMessage && !this.active && (!this.pollAt || Date.now()-this.pollAt>=60000)){
    this.pollAt=Date.now();
    try{const r=await this.send('status');
     if(poll.poll_status!==r.poll_status){
      if(r.poll_status==='error')await this.telemetry('failed');
      else if(['downloaded','pending_reload'].includes(r.poll_status))await this.telemetry('waiting');
     }
     poll={};
     if(Number.isFinite(r.last_poll_at)&&r.last_poll_at>0&&r.last_poll_at<=Date.now()/1000+60)poll.last_poll_at=r.last_poll_at;
     if(['current','downloaded','pending_reload','error'].includes(r.poll_status))poll.poll_status=r.poll_status;
     if(typeof r.poll_error==='string')poll.poll_error=['invalid_signature','hash_mismatch','permission_change','replayed_release','recovery_required','busy','operation_failed','invalid_manifest','invalid_url','wrong_extension'].includes(r.poll_error)?r.poll_error:'update_failed';
     await this.storage.set('updater_poll',poll);
    }catch(e){poll={...poll,poll_query_error:['busy','invalid_response'].includes(e.message)?e.message:'helper_unavailable'};await this.storage.set('updater_poll',poll);}
   }
   return {system_ota:await this.storage.get('updater_protocol')===2,enabled:await this.storage.get('updater_enabled')!==false,...saved,...poll,poll_stale:await this.storage.get('updater_enabled')!==false&&Number.isFinite(poll.last_poll_at)&&Date.now()/1000-poll.last_poll_at>7200,busy:!!this.active};
  }
  serializePreferences(work) {
   const next=(this.preferenceTail||Promise.resolve()).catch(()=>{}).then(work);
   this.preferenceTail=next;return next;
  }
  async setEnabled(enabled) {
   if(typeof enabled!=='boolean')throw Error('invalid_request');
   if(this.active)throw Error('update_in_progress');
   return this.serializePreferences(async()=>{
    if(await this.isBusy())throw Error('executor_busy');
    if(await this.storage.get('updater_protocol')===2)await this.send('settings',{enabled});
    await this.storage.set('updater_enabled',enabled);
    if(enabled)await this.initialize();else {await this.chrome.alarms.clear('crowd_update');await this.chrome.alarms.clear('crowd_update_bootstrap');}
   });
  }
  async recoverMismatch(error) {
   if(!['version_mismatch','handshake_mismatch'].includes(error))return false;
   try {const r=await this.send('status');if(['rolled_back','pending_reload'].includes(r.status)&&/^4\.\d+\.\d+$/.test(r.version)&&r.version!==this.version){await this.telemetry(r.status==='rolled_back'?'failed':'waiting');await this.reloadSettled();return true;}}catch(_){}
   return false;
  }
  async reloadSettled() {
   // Stop remains available during updates; persist it before replacing the worker.
   for(;;){
    if(this.agent.updateStopFailed)throw Error('executor_busy');
    const stop=this.agent.pendingStop||this.agent.stopActive,write=this.agent.writeTail;
    try {await stop;await write;}catch(_){throw Error('executor_busy');}
    if(this.agent.updateStopFailed)throw Error('executor_busy');
    if(!this.agent.pendingStop && !this.agent.stopActive && write===this.agent.writeTail)break;
   }
   this.chrome.runtime.reload();
  }
  async bootstrap() {
   if(this.bootstrapping)return this.bootstrapping;
   this.bootstrapping=this.serializePreferences(()=>this.initialize()).finally(()=>{this.bootstrapping=null;});return this.bootstrapping;
  }
  async initialize() {
   if(!this.chrome.runtime.sendNativeMessage)return;
   await this.storage.set('local_update_verified',null);
   await this.storage.set('local_updater_ready',null);
   try {
    const r=await this.send('ack');
    if(r.status==='pending_reload'&&r.version!==this.version){await this.telemetry('waiting');await this.reloadSettled();return;}
    await this.applied(r);
    await this.storage.set('updater_protocol',r.protocol===2?2:1);
    if(r.protocol===2)await this.send('settings',{enabled:await this.storage.get('updater_enabled')!==false});
    await this.storage.set('updater_status',{state:r.status,version:this.version,checked_at:Date.now()});
    await this.chrome.alarms.clear('crowd_update_bootstrap');
    if(await this.storage.get('updater_enabled')!==false){
     const alarm=await this.chrome.alarms.get('crowd_update');
     if(!alarm || alarm.periodInMinutes!==this.updatePeriod)await this.chrome.alarms.create('crowd_update',{delayInMinutes:1,periodInMinutes:this.updatePeriod});
    }
   }catch(e){if(!await this.recoverMismatch(e.message)){
    await this.telemetry(e.message==='busy'?'waiting':'failed');
    await this.storage.set('local_update_verified',null);
    await this.storage.set('local_updater_ready',null);
    await this.storage.set('updater_status',{state:e.message==='busy'?'checking':'helper_unavailable',error:e.message,version:this.version});
    if(await this.storage.get('updater_enabled')!==false)await this.chrome.alarms.create('crowd_update_bootstrap',{delayInMinutes:1,periodInMinutes:1});
    if(e.message==='busy')await this.chrome.alarms.create('crowd_update',{delayInMinutes:1,periodInMinutes:this.updatePeriod});
   }}
  }
  async check() {
   if(this.active)return this.active;
   this.active=this.serializePreferences(()=>this.perform()).finally(()=>{this.active=null;this.agent.maintenance=false;});return this.active;
  }
  async perform() {
   const blocked=async error=>{if(error!=='update_disabled')await this.telemetry(error==='executor_busy'?'waiting':'failed');await this.storage.set('updater_status',{state:'error',error,version:this.version,checked_at:Date.now()});return {blocked:error};};
   if(await this.storage.get('updater_enabled')===false)return blocked('update_disabled');
   if(!this.chrome.runtime.sendNativeMessage)return blocked('helper_unavailable');
   if(await this.isBusy()){await this.chrome.alarms.create('crowd_update',{delayInMinutes:1,periodInMinutes:this.updatePeriod});return blocked('executor_busy');}
   this.agent.maintenance=true;
   await this.agent.active?.catch(()=>{});
   await this.agent.writeTail?.catch(()=>{});
   if(await this.isBusy()){await this.chrome.alarms.create('crowd_update',{delayInMinutes:1,periodInMinutes:this.updatePeriod});return blocked('executor_busy');}
   try {
    await this.storage.set('updater_status',{state:'checking',version:this.version,checked_at:Date.now()});
    await this.telemetry('started');
    const r=await this.send('apply');
    await this.storage.set('updater_status',{state:r.status,version:this.version,target:r.version,checked_at:Date.now()});
    if(r.status==='pending_reload') {
     await this.telemetry('waiting');
     // Evidence/session/consent/stop state stay in extension storage. Reload self only.
     await this.reloadSettled();
    }
   }catch(e){if(!await this.recoverMismatch(e.message)){
    await this.telemetry(e.message==='busy'?'waiting':'failed');
    await this.storage.set('updater_status',{state:'error',error:e.message,version:this.version,checked_at:Date.now()});
    // The OS poll may briefly own the host lock. Do not collide again at the
    // same hourly boundary or postpone a prepared update for another hour.
    if(e.message==='busy')await this.chrome.alarms.create('crowd_update',{delayInMinutes:1,periodInMinutes:this.updatePeriod});
   }}
  }
 }
 root.CrowdUpdater=CrowdUpdater;
})(globalThis);
