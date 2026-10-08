/* Fixed native protocol; no scripts/paths/URLs are accepted from a message. */
(function(root){
 'use strict';
 class CrowdUpdater {
  constructor({chrome,storage,agent,version,releaseHash,isBusy=()=>false}) {Object.assign(this,{chrome,storage,agent,version,releaseHash,isBusy});this.active=null;}
  async send(action, extra={}) {
   const message={action,version:this.version,...extra};if(action==='ack')message.release_sha256=await this.releaseHash();
   const result=await this.chrome.runtime.sendNativeMessage('com.crowd.v4.updater',message);
   if(!result || typeof result.status!=='string')throw Error('invalid_response');
   if(result.status==='error')throw Error(['invalid_signature','hash_mismatch','permission_change','replayed_release','recovery_required','handshake_mismatch','version_mismatch','busy'].includes(result.error)?result.error:'update_failed');
   return result;
  }
  async status() {return {system_ota:await this.storage.get('updater_protocol')===2,enabled:await this.storage.get('updater_enabled')!==false,...await this.storage.get('updater_status'),busy:!!this.active};}
  async setEnabled(enabled) {
   if(typeof enabled!=='boolean')throw Error('invalid_request');
   if(this.active)throw Error('update_in_progress');
   await this.bootstrapping;
   if(await this.storage.get('updater_protocol')===2)await this.send('settings',{enabled});
   await this.storage.set('updater_enabled',enabled);if(enabled)await this.bootstrap();else await this.chrome.alarms.clear('crowd_update');
  }
  async recoverMismatch(error) {
   if(!['version_mismatch','handshake_mismatch'].includes(error))return false;
   try {const r=await this.send('status');if(['rolled_back','pending_reload'].includes(r.status)&&/^4\.\d+\.\d+$/.test(r.version)&&r.version!==this.version){this.chrome.runtime.reload();return true;}}catch(_){}
   return false;
  }
  async bootstrap() {
   if(this.bootstrapping)return this.bootstrapping;
   this.bootstrapping=this.initialize().finally(()=>{this.bootstrapping=null;});return this.bootstrapping;
  }
  async initialize() {
   if(!this.chrome.runtime.sendNativeMessage)return;
   try {
    const r=await this.send('ack');
    if(r.status==='pending_reload'&&r.version!==this.version){this.chrome.runtime.reload();return;}
    await this.storage.set('updater_protocol',r.protocol===2?2:1);
    if(r.protocol===2)await this.send('settings',{enabled:await this.storage.get('updater_enabled')!==false});
    await this.storage.set('updater_status',{state:r.status,version:this.version,checked_at:Date.now()});
    if(await this.storage.get('updater_enabled')!==false){
     const alarm=await this.chrome.alarms.get('crowd_update');
     if(!alarm)await this.chrome.alarms.create('crowd_update',{delayInMinutes:1,periodInMinutes:60});
    }
   }catch(e){if(!await this.recoverMismatch(e.message)){
    await this.storage.set('updater_status',{state:e.message==='busy'?'checking':'helper_unavailable',error:e.message,version:this.version});
    if(e.message==='busy')await this.chrome.alarms.create('crowd_update',{delayInMinutes:1,periodInMinutes:60});
   }}
  }
  async check() {
   await this.bootstrapping;
   if(this.active)return this.active;
   this.active=this.perform().finally(()=>{this.active=null;this.agent.maintenance=false;});return this.active;
  }
  async perform() {
   if(await this.storage.get('updater_enabled')===false || !this.chrome.runtime.sendNativeMessage)return;
   if(this.isBusy()){await this.chrome.alarms.create('crowd_update',{delayInMinutes:1,periodInMinutes:60});return;}
   this.agent.maintenance=true;
   await this.agent.active?.catch(()=>{});
   try {
    await this.storage.set('updater_status',{state:'checking',version:this.version,checked_at:Date.now()});
    const r=await this.send('apply');
    await this.storage.set('updater_status',{state:r.status,version:this.version,target:r.version,checked_at:Date.now()});
    if(r.status==='pending_reload') {
     // Evidence/session/consent/stop state stay in extension storage. Reload self only.
     this.chrome.runtime.reload();
    }
   }catch(e){if(!await this.recoverMismatch(e.message)){
    await this.storage.set('updater_status',{state:'error',error:e.message,version:this.version,checked_at:Date.now()});
    // The OS poll may briefly own the host lock. Do not collide again at the
    // same hourly boundary or postpone a prepared update for another hour.
    if(e.message==='busy')await this.chrome.alarms.create('crowd_update',{delayInMinutes:1,periodInMinutes:60});
   }}
  }
 }
 root.CrowdUpdater=CrowdUpdater;
})(globalThis);
