/* Owned detail tabs. A browser-session marker prevents stale tab-ID adoption. */
(function(root) {
  'use strict';
  class CrowdWorkTabs {
    constructor({chrome,storage,owner,probe,uuid,presentationAllowed=async()=>false,structuredAllowed=async()=>false}) {Object.assign(this,{chrome,storage,owner,probe,uuid,presentationAllowed,structuredAllowed});this.tail=Promise.resolve();this.presentationJobs=new Map();this.instance=uuid();}
    failure(cause) {this.lastFailure=cause;return Object.assign(Error('pool_recovery_required'),{poolCause:cause});}
    async session() {
      if(this.sessionPromise)return this.sessionPromise;
      this.sessionPromise=this.loadSession();return this.sessionPromise;
    }
    async loadSession() {
      if (!this.chrome.storage.session) throw Error('parallel_unavailable');
      const key='crowd_work_session';
      let value=(await this.chrome.storage.session.get(key))[key];
      if (!value) {value=this.uuid();await this.chrome.storage.session.set({[key]:value});}
      return value;
    }
    async key() {const owner=await this.owner();if(!owner)throw Error('backend_login_required');return 'work_tabs:'+owner;}
    matches(current,expected) {
      try {
        const b=new URL(expected),home=b.href===root.CrowdCore.HOST+'/';
        const a=new URL(home?current:root.CrowdCore.navigationURL(current));if(home)return a.href===b.href;
        try{return root.CrowdCore.noteURL(a.href).id===root.CrowdCore.noteURL(b.href).id;}catch(_){}
        return a.pathname.replace(/\/$/,'')===b.pathname.replace(/\/$/,'') && a.searchParams.get('keyword')===b.searchParams.get('keyword');
      }catch(_){return false;}
    }
    async entries() {return await this.storage.get(await this.key()) || {};}
    async assertKey(expected) {if(await this.key()!==expected)throw Error('cancelled');}
    write(fn,expected) {
      const pending=this.tail.catch(()=>{}).then(async()=>{
        const key=await this.key(),entries=await this.storage.get(key)||{};
        if(expected && key!==expected)throw Error('cancelled');
        const result=await fn(entries);await this.storage.set(key,entries);return result;
      });this.tail=pending;return pending;
    }
    async open(url, slot, {verificationHome=false}={}) {
      const home=verificationHome&&slot.startsWith('verify-')&&url===root.CrowdCore.HOST+'/';
      const key=await this.key(),destination=home?url:root.CrowdCore.navigationURL(url),session=await this.session();
      let entry=(await this.entries())[slot];
      if(entry?.state==='retired') {
        await this.write(entries=>{if(entries[slot]?.token===entry.token)delete entries[slot];},key);entry=null;
      }
      if(entry) {
        if(entry.session!==session || !entry.tab || entry.state!=='opened')throw this.failure('entry_state');
        const {pending}=await this.target(slot);
        const proof=await this.probe(entry.tab,'ownership');
        if(pending || !entry.document || proof?.response?.token!==entry.token || proof?.response?.document!==entry.document)throw Error('pool_recovery_required');
        entry={...entry,url:destination,token:this.uuid(),state:'opening',previous_document:entry.document,document:null,instance:this.instance};
        await this.write(entries=>{entries[slot]=entry;},key);await this.assertKey(key);
        if(await this.structuredAllowed()){try{root.CrowdCore.noteURL(destination);const u=new URL(destination);u.searchParams.set('crowd_capture',entry.token);entry.url=u.href;await this.write(entries=>{entries[slot]=entry;},key);}catch(error){if(error.message!=='invalid_note_url')throw error;}}
        await this.assertKey(key);
        await this.chrome.tabs.update(entry.tab,{url:entry.url,active:false});
      } else {
        entry={url:destination,token:this.uuid(),state:'opening',session,tab:null,instance:this.instance,document:null,...(slot.startsWith('verify-')?{verification:true}:{})};
        // A crash after creation and before saving the ID remains unknown;
        // recovery refuses a second creation under the same admission.
        await this.write(entries=>{entries[slot]=entry;},key);
        await this.assertKey(key);
        // Do not attach a durable capture to an arbitrary temporary automation window.
        if(await this.structuredAllowed()){try{root.CrowdCore.noteURL(destination);const u=new URL(destination);u.searchParams.set('crowd_capture',entry.token);entry.url=u.href;}catch(error){if(error.message!=='invalid_note_url')throw error;}}
        await this.assertKey(key);
        const window=await this.chrome.windows.create({url:entry.url,type:'normal',focused:false});
        const tab=window.tabs[0];
        entry={...entry,tab:tab.id};
      }
      await this.write(entries=>{entries[slot]={...entry,state:'opened'};},key);
    }
    rateLimitURL(value) {
      try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['xiaohongshu.com','www.xiaohongshu.com','m.xiaohongshu.com'].includes(u.hostname)&&u.pathname==='/website-login/error'&&u.searchParams.getAll('error_code').length===1&&u.searchParams.get('error_code')==='300013';}catch(_){return false;}
    }
    async currentMetadata(entry) {
      const tab=await this.chrome.tabs.get(entry.tab).catch(()=>null);
      if(!tab||tab.discarded||tab.status!=='complete'||tab.pendingUrl)return null;
      if(tab.url)return {url:tab.url};
      // Existing webNavigation permission can inspect this already-owned main frame without a new host grant.
      return await this.chrome.webNavigation?.getFrame({tabId:entry.tab,frameId:0}).catch(()=>null);
    }
    async riskEvidence() {
      const key=await this.key(),session=await this.session();
      for(const [slot,entry] of Object.entries(await this.entries())){
        if(entry.session!==session||!entry.tab||!entry.document||!entry.token||!(entry.state==='opened'||entry.state==='retired'&&entry.retired_reason==='url_changed'))continue;
        let note;try{note=root.CrowdCore.noteURL(entry.url).id;}catch(_){continue;}
        const metadata=await this.currentMetadata(entry);await this.assertKey(key);
        const fresh=(await this.entries())[slot];
        if(fresh?.session!==session||fresh?.tab!==entry.tab||fresh?.document!==entry.document||fresh?.token!==entry.token||fresh?.state!==entry.state||fresh?.url!==entry.url)continue;
        if(this.rateLimitURL(metadata?.url))return {slot,note_id:note};
      }
      return null;
    }
    async noteRisk(entry){let note;try{note=root.CrowdCore.noteURL(entry.url).id;}catch(_){return;}try{await this.riskObserved?.({note_id:note,session:entry.session,document:entry.document,at:Date.now()});}catch(_){this.riskCaptureFailed=true;}}
    async target(slot) {
      const key=await this.key();
      const entry=(await this.entries())[slot];
      if (!entry || entry.session!==await this.session() || !entry.tab || entry.state!=='opened')throw this.failure('entry_state');
      const tab=await this.chrome.tabs.get(entry.tab).catch(()=>null);
      if(!tab)throw this.failure('tab_missing');
      if(tab.discarded)throw this.failure('tab_discarded');
      // Chrome may omit URL/pendingUrl before host permission applies at commit.
      // Only a newly created, unbound tab in this worker may wait in that state.
      const uncommitted=entry.instance===this.instance && !entry.document && tab.status==='loading' && (!tab.url || tab.url==='about:blank');
      const pending=!this.matches(tab.url,entry.url) && (this.matches(tab.pendingUrl,entry.url) || uncommitted);
      if(!pending && !this.matches(tab.url,entry.url)){
        if(!tab.url&&entry.document){const metadata=await this.currentMetadata(entry);await this.assertKey(key);if(this.rateLimitURL(metadata?.url)){await this.noteRisk(entry);await this.assertKey(key);throw Error('rate_limit');}}
        // An owned tab redirected to the platform error page is a risk signal, never a new capture document.
        if(this.rateLimitURL(tab.url)){await this.noteRisk(entry);await this.assertKey(key);throw Error('rate_limit');}
        throw this.failure('url_changed');
      }
      await this.assertKey(key);return {entry,tab,pending};
    }
    async read(action,slot,sdk=null) {
      const ownerKey=await this.key();
      const {entry,tab,pending}=await this.target(slot);
      if(pending)return {ready:false,reason:'page_loading'};
      if(tab.frozen)return {ready:false,reason:'page_frozen'};
      const identity=(await this.probe(entry.tab,'ownership')).response;
      if(!identity)return {ready:false,reason:'content_unavailable'};
      if(entry.document) {
        if(identity.token!==entry.token)throw this.failure('token_changed');
        if(identity.document!==entry.document)throw this.failure('document_changed');
      } else {
        if(entry.instance!==this.instance)throw this.failure('unbound_restart');
        if(identity.document===entry.previous_document)return {ready:false,reason:'page_loading'};
        await this.assertKey(ownerKey);
        const bound=await this.chrome.tabs.sendMessage(entry.tab,{type:'crowd_bind',token:entry.token});
        if(!bound?.document)throw this.failure('bind_failed');
        await this.write(entries=>{if(entries[slot]?.token===entry.token)entries[slot].document=bound.document;},ownerKey);
      }
      const currentEntry=(await this.entries())[slot];
      const response=await this.probe(entry.tab,action,sdk?{sdk:{...sdk,binding:{...sdk.binding,document:currentEntry.document,nonce:currentEntry.token},grant:sdk.grant?{...sdk.grant,document:currentEntry.document,nonce:currentEntry.token}:null},token:currentEntry.token,document:currentEntry.document}:null);
      if(sdk){const target=await this.target(slot),proof=(await this.probe(entry.tab,'ownership')).response;if(target.entry.token!==currentEntry.token||proof?.document!==currentEntry.document||proof?.token!==currentEntry.token)throw this.failure('document_changed');}
      if(action==='comments'&&response.response?.needs_visible_page===true&&!entry.presentation){await this.present(slot,entry,ownerKey);return {ready:true};}
      return response.response || {ready:false,reason:tab.status==='loading'?'page_loading':'content_unavailable'};
    }
    async recoveryNeeded() {
      const session=await this.session();
      return Object.values(await this.entries()).some(e=>e.state!=='retired'&&(e.session!==session||e.state!=='opened'));
    }
    async verificationCurrent(slot) {
      const entries=await this.entries(),entry=entries[slot],session=await this.session();
      if(!entry||entry.session!==session)return false;
      const current=entry.state==='retired'&&entry.retired_reason==='adopted_search'?entries.search:entry;
      if(!(current&&current.state==='opened'&&current.session===session&&current.token===entry.token))return false;
      // Only an explicitly missing/discarded owned tab permits replacement.
      // An unknown Chrome error must not turn into another creation attempt.
      let tab;try{tab=await this.chrome.tabs.get(current.tab);}catch(error){
        if(/No tab with id/i.test(String(error?.message||error)))return false;
        throw error;
      }
      return !!tab&&!tab.discarded;
    }
    async verificationMessage(tab,message) {
      let timer;
      try{return await Promise.race([this.chrome.tabs.sendMessage(tab,message),new Promise((_,reject)=>{timer=setTimeout(()=>reject(this.failure('probe_timeout')),1500);})]);}
      finally{clearTimeout(timer);}
    }
    async verificationProbe(slot,accept=async()=>false) {
      if(!slot?.startsWith('verify-'))throw this.failure('verification_slot');
      const key=await this.key(),{entry,pending}=await this.target(slot);
      if(!entry.verification)throw this.failure('verification_slot');if(pending)return {status:'unknown'};
      const proof=(await this.probe(entry.tab,'ownership')).response;if(!proof?.document)return {status:'unknown'};
      if(proof.token&&proof.token!==entry.token)throw this.failure('token_changed');
      const page=await this.verificationMessage(entry.tab,{type:'crowd_session_probe'}),after=await this.target(slot),second=(await this.probe(entry.tab,'ownership')).response;
      if(after.entry.token!==entry.token||after.entry.document!==entry.document||proof.document!==second?.document||proof.token!==second?.token)throw this.failure('verification_document_changed');
      // A persisted newly-created page may outlive its worker before binding.
      // Only this current-browser owned slot and a confirmed original principal
      // can authorize binding; an old browser marker is rejected by target().
      if((!entry.document||entry.document!==proof.document||proof.token!==entry.token)&&await accept(page)){
        await this.assertKey(key);const bound=await this.verificationMessage(entry.tab,{type:'crowd_bind',token:entry.token});
        if(bound?.document!==proof.document)throw this.failure('verification_document_changed');
        await this.write(entries=>{if(entries[slot]?.token!==entry.token||entries[slot]?.document!==entry.document)throw Error('cancelled');entries[slot]={...entry,document:bound.document,instance:this.instance};},key);
      }
      return page;
    }
    async focusVerification(slot) {
      const {entry,tab}=await this.target(slot);if(!entry.verification)throw this.failure('verification_slot');
      await this.chrome.tabs.update(entry.tab,{active:true});await this.chrome.windows.update(tab.windowId,{focused:true});
    }
    async adoptVerification(slot,valid) {
      const key=await this.key();await this.read('ownership',slot);if(!await valid())throw Error('cancelled');
      const entry=(await this.entries())[slot];
      if(!entry?.document||!entry.url.includes('/search_result?'))throw this.failure('verification_not_search');
      await this.write(entries=>{
        if(entries[slot]?.token!==entry.token||entries[slot]?.document!==entry.document)throw Error('cancelled');
        // Retire only metadata. Stale tab IDs from an older browser session are
        // never read, rebound, navigated or closed during recovery.
        for(const [name,old]of Object.entries(entries))if(name!==slot&&old.state!=='retired'){
          if(name==='search')entries['recovery-retired-'+this.uuid()]={...old,state:'retired',retired_reason:'verified_page_replacement'};
          entries[name]={...old,state:'retired',retired_reason:'verified_page_replacement'};
        }
        entries.search={...entry};entries[slot]={...entry,state:'retired',retired_reason:'adopted_search'};
      },key);
    }
    async retireLoginPage(valid) {
      const key=await this.key();if(!await valid())throw Error('cancelled');
      await this.write(entries=>{
        const old=entries.search;if(!old)return;
        entries['login-retired-'+this.uuid()]={...old,state:'retired',retired_reason:'first_login_update'};
        entries.search={...old,state:'retired',retired_reason:'first_login_update'};
      },key);
    }
    async rebindAfterLogin(valid) {
      const key=await this.key(),session=await this.session();
      for(const [slot,entry] of Object.entries(await this.entries())) {
        if(!await valid())throw Error('cancelled');
        if(entry.state==='retired')continue;
        const {tab,pending}=await this.target(slot);
        if(pending||tab.pendingUrl||entry.session!==session)throw this.failure('login_page_changed');
        const proof=(await this.probe(entry.tab,'ownership')).response;
        if(!proof?.document)throw this.failure('login_page_unavailable');
        if(proof.document===entry.document&&proof.token===entry.token)continue;
        // A new document in the same owned tab may lose its token after login.
        // A conflicting token is another capture owner, never ours to overwrite.
        if(proof.token&&proof.token!==entry.token)throw this.failure('token_changed');
        if(!await valid())throw Error('cancelled');await this.assertKey(key);
        const bound=await this.chrome.tabs.sendMessage(entry.tab,{type:'crowd_bind',token:entry.token});
        if(bound?.document!==proof.document)throw this.failure('login_document_changed');
        if(!await valid())throw Error('cancelled');
        await this.write(entries=>{if(entries[slot]?.token!==entry.token||entries[slot]?.document!==entry.document)throw Error('cancelled');entries[slot]={...entry,document:bound.document,instance:this.instance};},key);
      }
    }
    async present(slot,entry,ownerKey) {
      const jobKey=ownerKey+':'+slot;
      if(this.presentationJobs.has(jobKey))return this.presentationJobs.get(jobKey);
      const job=(async()=>{
        if(!await this.presentationAllowed())throw Error('cancelled');
        await this.assertKey(ownerKey);
        const current=await this.target(slot),proof=(await this.probe(entry.tab,'ownership')).response;
        if(current.entry.token!==entry.token||proof?.token!==entry.token||proof?.document!==current.entry.document)throw Error('pool_recovery_required');
        if(current.entry.presentation)return;
        await this.write(entries=>{
          if(entries[slot]?.token!==entry.token)throw Error('cancelled');
          entries[slot].presentation={state:'moving',document:current.entry.document};
        },ownerKey);
        if(!await this.presentationAllowed())throw Error('cancelled');
        await this.assertKey(ownerKey);
        // Persist intent before moving the same bound tab; unknown outcomes are never repeated.
        const window=await this.chrome.windows.create({tabId:entry.tab,type:'normal',focused:false});
        await this.write(entries=>{
          if(entries[slot]?.token!==entry.token)throw Error('cancelled');
          entries[slot].presentation={state:'moved',document:current.entry.document,window:window.id};
        },ownerKey);
      })();
      this.presentationJobs.set(jobKey,job);
      try{return await job;}finally{this.presentationJobs.delete(jobKey);}
    }
    async ready(sender,message) {
      const session=await this.session();
      for(const [slot,entry] of Object.entries(await this.entries())) {
        if(entry.tab!==sender.tab?.id || entry.session!==session || entry.state!=='opened')continue;
        const {pending}=await this.target(slot);if(pending)return null;
        if(!message.token) {
          if(entry.document || entry.instance!==this.instance)continue;
          await this.read('ownership',slot);
        } else if(message.token!==entry.token || entry.document&&message.document!==entry.document)continue;
        try{if(message.target!==root.CrowdCore.noteURL(entry.url).id)continue;}catch(_){continue;}
        return slot;
      }
      return null;
    }
    async close(slot, expectedOwner = null) {
      if(!await this.owner())return;
      const ownerKey=await this.key();
      if(expectedOwner && ownerKey!=='work_tabs:'+expectedOwner)throw Error('cancelled');
      await Promise.allSettled([...this.presentationJobs].filter(([key])=>key.startsWith(ownerKey+':')&&(!slot||key===ownerKey+':'+slot)).map(([,job])=>job));
      await this.assertKey(ownerKey);
      const entries=await this.storage.get(ownerKey)||{},selected=slot ? [[slot,entries[slot]]] : Object.entries(entries);
      for(const [key,entry] of selected) {
        if(!entry)continue;
        const retire=async cause=>{this.lastFailure=cause;await this.write(all=>{if(all[key]?.token===entry.token)all[key]={...all[key],state:'retired',retired_reason:cause};},ownerKey);};
        if(entry.session!==await this.session()) {
          // Browser restart invalidates tab IDs; retire our mapping without touching a user's tab.
          await this.write(all=>{if(all[key]?.token===entry.token)delete all[key];},ownerKey);
          continue;
        }
        if(!entry.tab){await retire('entry_state');continue;}
        const tab=await this.chrome.tabs.get(entry.tab).catch(()=>null);
        if(tab) {
          if(!this.matches(tab.url,entry.url) && !this.matches(tab.pendingUrl,entry.url)){await retire('url_changed');continue;}
          if(entry.document) {
            const proof=(await this.probe(entry.tab,'ownership')).response;
            if(proof?.token!==entry.token || proof?.document!==entry.document){await retire('close_identity');continue;}
          } else if(entry.instance!==this.instance){await retire('unbound_restart');continue;}
          await this.assertKey(ownerKey);await this.chrome.tabs.remove(entry.tab);
        }
        await this.write(all=>{if(all[key]?.token===entry.token)delete all[key];},ownerKey);
      }
    }
    async first(preferred=[]) {
      if(!await this.owner())return null;
      const entries=await this.entries();
      for(const slot of [...new Set([...preferred,...Object.keys(entries)])]) {
        const entry=entries[slot];if(!entry)continue;
        try {const proof=await this.read('ownership',slot);if(proof.token===entry.token)return entry.tab;}catch(_){}
      }
      return null;
    }
    async removed(id) {await this.write(entries=>{for(const entry of Object.values(entries))if(entry.tab===id)entry.state='missing';});}
  }
  root.CrowdWorkTabs=CrowdWorkTabs;
})(globalThis);
