/* Fixed native protocol; no scripts/paths/URLs are accepted from a message. */
(function(root){
 'use strict';
 class CrowdUpdater {
  constructor({chrome,storage,agent,version,releaseHash,isBusy=()=>false}) {Object.assign(this,{chrome,storage,agent,version,releaseHash,isBusy});this.active=null;}
  async send(action) {
   const message={action,version:this.version};if(action==='ack')message.release_sha256=await this.releaseHash();
   const result=await this.chrome.runtime.sendNativeMessage('com.crowd.v4.updater',message);
   if(!result || typeof result.status!=='string')throw Error('invalid_response');
   if(result.status==='error')throw Error(['invalid_signature','hash_mismatch','permission_change','replayed_release','recovery_required','handshake_mismatch','version_mismatch','busy'].includes(result.error)?result.error:'update_failed');
   return result;
  }
  async status() {return {enabled:await this.storage.get('updater_enabled')!==false,...await this.storage.get('updater_status'),busy:!!this.active};}
  async setEnabled(enabled) {
   if(typeof enabled!=='boolean')throw Error('invalid_request');
   if(this.active)throw Error('update_in_progress');
   await this.storage.set('updater_enabled',enabled);if(enabled)await this.bootstrap();else await this.chrome.alarms.clear('crowd_update');
  }
  async recoverMismatch(error) {
   if(!['version_mismatch','handshake_mismatch'].includes(error))return false;
   try {const r=await this.send('status');if(r.status==='rolled_back'&&/^4\.\d+\.\d+$/.test(r.version)&&r.version!==this.version){this.chrome.runtime.reload();return true;}}catch(_){}
   return false;
  }
  async bootstrap() {
   if(!this.chrome.runtime.sendNativeMessage)return;
   try {
    const r=await this.send('ack');await this.storage.set('updater_status',{state:r.status,version:this.version,checked_at:Date.now()});
    if(await this.storage.get('updater_enabled')!==false){
     const alarm=await this.chrome.alarms.get('crowd_update');
     if(!alarm)await this.chrome.alarms.create('crowd_update',{delayInMinutes:1,periodInMinutes:60});
    }
   }catch(e){if(!await this.recoverMismatch(e.message))await this.storage.set('updater_status',{state:'helper_unavailable',version:this.version});}
  }
  async check() {
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
   }catch(e){if(!await this.recoverMismatch(e.message))await this.storage.set('updater_status',{state:'error',error:e.message,version:this.version,checked_at:Date.now()});}
  }
 }
 root.CrowdUpdater=CrowdUpdater;
})(globalThis);
