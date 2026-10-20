/* Owned detail tabs. A browser-session marker prevents stale tab-ID adoption. */
(function(root) {
  'use strict';
  class CrowdWorkTabs {
    constructor({chrome,storage,owner,probe,uuid,presentationAllowed=async()=>false,structuredAllowed=async()=>false,observe=null}) {Object.assign(this,{chrome,storage,owner,probe,uuid,presentationAllowed,structuredAllowed,observe});this.pendingRemovals=new Map();this.tail=Promise.resolve();this.presentationJobs=new Map();this.instance=uuid();}
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
        const a=new URL(home?current:root.CrowdCore.navigationURL(current));if(home)return a.href===b.href||a.href===root.CrowdCore.HOST+'/explore';
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
    historicalOpened(entry,session) {
      return entry?.state==='opened' && typeof entry.session==='string' && !!entry.session && entry.session!==session && Number.isInteger(entry.tab) && entry.tab>0 && typeof entry.document==='string' && !!entry.document && typeof entry.token==='string' && !!entry.token;
    }
    open(url,slot,options={}) {
      const scope=Promise.all([this.key(),this.session(),this.presentationAllowed()]).then(values=>({values}),error=>({error}));
      const pending=(this.openTail||Promise.resolve()).catch(()=>{}).then(async()=>{
        const captured=await scope;if(captured.error)throw captured.error;
        const [key,session,running]=captured.values;
        const valid=async()=>{await this.assertKey(key);if((await this.chrome.storage.session.get('crowd_work_session')).crowd_work_session!==session||running&&!await this.presentationAllowed())throw Error('cancelled');};
        await valid();return this.openOwned(url,slot,options,valid);
      });
      this.openTail=pending;return pending;
    }
    createdContainer(entry,tab,session,windowId) {
      // Creation proves only window membership, never permission to read or close content.
      return entry.state==='opened'&&entry.session===session&&entry.instance===this.instance&&entry.document===null&&typeof entry.token==='string'&&!!entry.token&&Number.isSafeInteger(entry.tab)&&entry.tab>0&&entry.tab===tab.id&&Number.isSafeInteger(windowId)&&windowId>0&&entry.created_window===windowId&&tab.windowId===windowId&&tab.status==='loading'&&!tab.discarded&&!tab.frozen&&(tab.url==='about:blank'||tab.url===entry.url)&&(!tab.pendingUrl||tab.pendingUrl===entry.url);
    }
    async ownedWindow(key,session) {
      const current=Object.entries(await this.entries()).filter(([,e])=>e.session===session&&e.state!=='retired');
      if(!current.length)return null;
      const bound=[];
      for(const [slot,e]of current){
        if(e.state!=='opened'||!Number.isSafeInteger(e.tab)||e.tab<1||typeof e.token!=='string'||!e.token)throw this.failure('entry_state');
        if(e.document!==null&&(typeof e.document!=='string'||!e.document)||e.document===null&&e.instance!==this.instance)throw this.failure('close_identity');
        const tab=await this.chrome.tabs.get(e.tab);
        if(this.createdContainer(e,tab,session,tab.windowId)){bound.push([slot,{...e},tab.windowId]);continue;}
        if(e.document===null&&tab.status==='complete'&&!tab.pendingUrl)await this.read('ownership',slot);
        const entry=(await this.entries())[slot],target=await this.target(slot,{verificationObservation:true});
        const proof=(await this.probe(entry.tab,'ownership')).response;
        if(target.pending||typeof entry.document!=='string'||!entry.document||proof?.token!==entry.token||proof?.document!==entry.document)throw this.failure('close_identity');
        bound.push([slot,{...entry},target.tab.windowId]);
      }
      const windowId=bound[0][2],selected=bound.filter(([,e,id])=>id===windowId).map(([slot,e])=>[slot,e]);
      await this.checkWindow(windowId,selected,key,session);return {windowId,selected};
    }
    async checkWindow(windowId,selected,key,session,added=null) {
      await this.assertKey(key);
      if((await this.chrome.storage.session.get('crowd_work_session')).crowd_work_session!==session)throw Error('cancelled');
      const window=await this.chrome.windows.get(windowId,{populate:true}),ids=selected.map(([,e])=>e.tab).concat(added?[added.tab]:[]);
      if(!Number.isSafeInteger(windowId)||windowId<1||window.id!==windowId||window.type!=='normal'||window.incognito||window.state!=='minimized'||!Array.isArray(window.tabs)||new Set(ids).size!==ids.length||window.tabs.length!==ids.length||window.tabs.some(t=>!ids.includes(t.id)||t.windowId!==windowId))throw this.failure('silent_window_unconfirmed');
      const entries=await this.entries();
      for(const [slot,e]of selected){
        const live=entries[slot],tab=window.tabs.find(t=>t.id===e.tab);
        if(!live||['state','session','tab','document','token','url','instance','created_window'].some(k=>live[k]!==e[k]))throw this.failure('close_identity');
        if(this.createdContainer(e,tab,session,windowId))continue;
        const proof=(await this.probe(e.tab,'ownership')).response;
        if(typeof e.document!=='string'||!e.document||tab.discarded||tab.frozen||tab.pendingUrl||tab.status!=='complete'||!this.matches(tab.url,e.url)&&!(e.verification&&slot.startsWith('verify-')&&e.url===root.CrowdCore.HOST+'/'&&(()=>{try{root.CrowdCore.noteURL(tab.url);return true;}catch(_){return false;}})())||proof?.token!==e.token||proof?.document!==e.document)throw this.failure('close_identity');
      }
      if(added){const tab=window.tabs.find(t=>t.id===added.tab);if(!tab||!this.matches(tab.url,added.url)&&!this.matches(tab.pendingUrl,added.url))throw this.failure('silent_window_unconfirmed');}
      await this.assertKey(key);
      if((await this.chrome.storage.session.get('crowd_work_session')).crowd_work_session!==session)throw Error('cancelled');
    }
    async openOwned(url, slot, {verificationHome=false}={},valid=async()=>{}) {
      await valid();
      const home=verificationHome&&slot.startsWith('verify-')&&url===root.CrowdCore.HOST+'/';
      const key=await this.key(),destination=home?url:root.CrowdCore.navigationURL(url),session=await this.session();
      let entry=(await this.entries())[slot];
      if(this.historicalOpened(entry,session)) {
        // OTA invalidates tab IDs. Keep their history without touching the old page.
        await this.write(async entries=>{
          await this.assertKey(key);
          const current=entries[slot];
          if(!current || ['state','session','tab','document','token','url','instance'].some(name=>current[name]!==entry[name]))throw Error('cancelled');
          entries['session-retired-'+this.uuid()]={...current,state:'retired',retired_reason:'browser_session_changed'};
          delete entries[slot];
        },key);
        await this.assertKey(key);entry=null;
      }
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
        await this.assertKey(key);
        if((await this.chrome.storage.session.get('crowd_work_session')).crowd_work_session!==session)throw Error('cancelled');
        const reuse=await this.ownedWindow(key,session);
        await valid();
        entry={url:destination,token:this.uuid(),state:'opening',session,tab:null,instance:this.instance,document:null,...(slot.startsWith('verify-')?{verification:true}:{})};
        // A crash after creation and before saving the ID remains unknown;
        // recovery refuses a second creation under the same admission.
        await this.write(entries=>{entries[slot]=entry;},key);
        await this.assertKey(key);
        // Do not attach a durable capture to an arbitrary temporary automation window.
        if(await this.structuredAllowed()){try{root.CrowdCore.noteURL(destination);const u=new URL(destination);u.searchParams.set('crowd_capture',entry.token);entry.url=u.href;}catch(error){if(error.message!=='invalid_note_url')throw error;}}
        await this.assertKey(key);
        if(reuse)await this.checkWindow(reuse.windowId,reuse.selected,key,session);
        await valid();
        const window=reuse?null:await this.chrome.windows.create({url:entry.url,type:'normal',state:'minimized',focused:false});
        const tab=reuse?await this.chrome.tabs.create({windowId:reuse.windowId,url:entry.url,active:false}):window.tabs?.[0];
        entry={...entry,tab:Number.isSafeInteger(tab?.id)?tab.id:null,created_window:reuse?reuse.windowId:Number.isSafeInteger(window.id)?window.id:null};
        // Save the known creation outcome before visibility confirmation can fail.
        await this.write(entries=>{if(entries[slot]?.token!==entry.token)throw Error('cancelled');entries[slot]=entry;},key);
        {
          const createdWindow=async()=>{
            await this.assertKey(key);
            const current=(await this.entries())[slot],marker=(await this.chrome.storage.session.get('crowd_work_session')).crowd_work_session;
            if(marker!==session||!current||['state','session','tab','token','url','instance','created_window'].some(k=>current[k]!==entry[k]))throw Error('cancelled');
            if(!Number.isSafeInteger(entry.tab)||entry.tab<1||!Number.isSafeInteger(entry.created_window)||entry.created_window<1)throw this.failure('silent_window_unconfirmed');
            if(reuse){await this.checkWindow(reuse.windowId,reuse.selected,key,session,entry);return await this.chrome.windows.get(entry.created_window,{populate:true});}
            const actual=await this.chrome.windows.get(entry.created_window,{populate:true}),only=actual?.tabs?.[0];
            if(actual?.id!==entry.created_window||actual.type!=='normal'||actual.incognito||!Array.isArray(actual.tabs)||actual.tabs.length!==1||only?.id!==entry.tab||only.windowId!==actual.id||!this.matches(only.url,entry.url)&&!this.matches(only.pendingUrl,entry.url))throw this.failure('silent_window_unconfirmed');
            await this.assertKey(key);return actual;
          };
          const actual=await createdWindow();
          if(actual.state!=='minimized'){
            if(reuse)throw this.failure('silent_window_unconfirmed');
            await createdWindow();
            try{await this.chrome.windows.update(entry.created_window,{state:'minimized',focused:false});}catch(_){throw this.failure('silent_window_unconfirmed');}
          }
          const confirmed=await createdWindow();if(confirmed.state!=='minimized')throw this.failure('silent_window_unconfirmed');
        }
      }
      await valid();
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
    async target(slot,{verificationObservation=false}={}) {
      const key=await this.key();
      const entry=(await this.entries())[slot];
      if (!entry || entry.session!==await this.session() || !entry.tab || entry.state!=='opened')throw this.failure('entry_state');
      const tab=await this.chrome.tabs.get(entry.tab).catch(()=>null);
      if(!tab)throw this.failure('tab_missing');
      if(tab.discarded)throw this.failure('tab_discarded');
      // Chrome may omit URL/pendingUrl before host permission applies at commit.
      // Only a newly created, unbound tab in this worker may wait in that state.
      const uncommitted=entry.instance===this.instance && !entry.document && tab.status==='loading' && (!tab.url || tab.url==='about:blank');
      let observedVerification=false;
      if(verificationObservation===true&&slot.startsWith('verify-')&&entry.verification===true&&entry.url===root.CrowdCore.HOST+'/'&&typeof entry.token==='string'&&entry.token&&typeof entry.document==='string'&&entry.document&&tab.status==='complete'&&!tab.pendingUrl&&!tab.frozen){
        try{root.CrowdCore.noteURL(tab.url);observedVerification=true;}catch(_){}
      }
      const pending=!observedVerification&&!this.matches(tab.url,entry.url) && (this.matches(tab.pendingUrl,entry.url) || uncommitted);
      if(!pending && !observedVerification && !this.matches(tab.url,entry.url)){
        if(!tab.url&&entry.document){const metadata=await this.currentMetadata(entry);await this.assertKey(key);if(this.rateLimitURL(metadata?.url)){await this.noteRisk(entry);await this.assertKey(key);throw Error('rate_limit');}}
        // An owned tab redirected to the platform error page is a risk signal, never a new capture document.
        if(this.rateLimitURL(tab.url)){await this.noteRisk(entry);await this.assertKey(key);throw Error('rate_limit');}
        throw this.failure('url_changed');
      }
      await this.assertKey(key);return {entry,tab,pending,verificationObservation:observedVerification};
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
      return Object.values(await this.entries()).some(e=>e.state!=='retired'&&!this.historicalOpened(e,session)&&(e.session!==session||e.state!=='opened'));
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
      const key=await this.key(),{entry,pending,verificationObservation}=await this.target(slot,{verificationObservation:true});
      if(!entry.verification)throw this.failure('verification_slot');if(pending)return {status:'unknown'};
      const proof=(await this.probe(entry.tab,'ownership')).response;if(!proof?.document)return {status:'unknown'};
      if(proof.token&&proof.token!==entry.token)throw this.failure('token_changed');
      if(verificationObservation&&(proof.token!==entry.token||proof.document!==entry.document))throw this.failure('verification_document_changed');
      const page=await this.verificationMessage(entry.tab,{type:'crowd_session_probe'}),after=await this.target(slot,{verificationObservation:true}),second=(await this.probe(entry.tab,'ownership')).response;
      if((verificationObservation||after.verificationObservation)&&(proof.token!==entry.token||proof.document!==entry.document))throw this.failure('verification_document_changed');
      if(after.entry.tab!==entry.tab||after.entry.session!==entry.session||after.entry.token!==entry.token||after.entry.document!==entry.document||proof.document!==second?.document||proof.token!==second?.token)throw this.failure('verification_document_changed');
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
      await this.chrome.tabs.update(entry.tab,{active:true});await this.chrome.windows.update(tab.windowId,{state:'normal',focused:true});
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
    async rebindAfterLogin(valid,acceptVerification=async()=>false) {
      const key=await this.key(),session=await this.session();
      for(const [slot,entry] of Object.entries(await this.entries())) {
        if(!await valid())throw Error('cancelled');
        if(entry.state==='retired'||this.historicalOpened(entry,session))continue;
        const current=await this.target(slot,{verificationObservation:true}),{tab,pending}=current;
        if(pending||tab.pendingUrl||entry.session!==session)throw this.failure('login_page_changed');
        if(current.verificationObservation){
          if(current.entry.token!==entry.token||current.entry.document!==entry.document)throw this.failure('verification_document_changed');
          const page=await this.verificationProbe(slot);
          if(!await valid())throw Error('cancelled');await this.assertKey(key);
          if(page?.platform!=='xiaohongshu'||page.status!=='authenticated'||page.verification!=='rendered_account_navigation'||typeof page.principal_id!=='string'||!/^[a-f0-9]{24}$/i.test(page.principal_id))throw this.failure('login_page_unavailable');
          if(await acceptVerification(page)!==true)throw Error('platform_identity_changed');
          if(!await valid())throw Error('cancelled');await this.assertKey(key);
          continue;
        }
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
    role(slot,entry) {return slot==='search'?'search':entry?.verification===true||slot.startsWith('verify-')?'verification':'other';}
    observeWindow(stage,ownerKey) {try{if(this.observe)Promise.resolve(this.observe(stage,ownerKey.slice('work_tabs:'.length))).catch(()=>{});}catch(_){} }
    async close(slot, expectedOwner = null) {
      if(!await this.owner())return;
      const ownerKey=await this.key();
      if(expectedOwner && ownerKey!=='work_tabs:'+expectedOwner)throw Error('cancelled');
      this.observeWindow(slot?'close_'+this.role(slot,null)+'_requested':'close_all_requested',ownerKey);
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
          this.observeWindow('remove_'+this.role(key,entry)+'_requested',ownerKey);
          await this.assertKey(ownerKey);
          const current=(await this.entries())[key];
          if(!current||['tab','session','token','document','url','state','instance'].some(name=>current[name]!==entry[name]))throw Error('cancelled');
          await this.assertKey(ownerKey);
          const removal={ownerKey,session:entry.session,token:entry.token,document:entry.document,role:this.role(key,entry)};
          this.pendingRemovals.set(entry.tab,removal);
          while(this.pendingRemovals.size>24)this.pendingRemovals.delete(this.pendingRemovals.keys().next().value);
          try{await this.chrome.tabs.remove(entry.tab);}finally{if(this.pendingRemovals.get(entry.tab)===removal)this.pendingRemovals.delete(entry.tab);}
        }
        await this.write(all=>{if(all[key]?.token===entry.token)delete all[key];},ownerKey);
      }
    }
    validNativeDocument(value){return typeof value==='string'&&value.length>0&&value.length<=128&&!/[\u0000-\u001f\u007f]/.test(value);}
    async bridgeWindow(slot,entry,key,nativeDocument=null) {
      await this.assertKey(key);
      const live=await this.entries(),active=Object.entries(live).filter(([,e])=>e.state!=='retired');
      if(active.length!==1||active[0][0]!==slot||JSON.stringify(active[0][1])!==JSON.stringify(entry)||entry.state!=='opened'||entry.verification!==true||entry.url!==root.CrowdCore.HOST+'/'||!entry.token||!entry.document)throw Error('executor_busy');
      const tab=await this.chrome.tabs.get(entry.tab),window=await this.chrome.windows.get(tab.windowId,{populate:true});
      if(tab.status!=='complete'||tab.pendingUrl||tab.discarded||tab.frozen||!this.matches(tab.url,entry.url)||window.type!=='normal'||window.incognito||window.state!=='minimized'||window.focused===true||window.tabs?.length!==1||window.tabs[0].id!==entry.tab||window.tabs[0].windowId!==window.id)throw Error('executor_busy');
      const frame=await this.chrome.webNavigation.getFrame({tabId:entry.tab,frameId:0,...(nativeDocument?{documentId:nativeDocument}:{})});
      if(!frame||frame.errorOccurred||frame.documentLifecycle!=='active'||frame.url!==tab.url||!this.validNativeDocument(frame.documentId)||nativeDocument&&frame.documentId!==nativeDocument)throw Error('executor_busy');
      await this.assertKey(key);return {window:window.id,tab:entry.tab,url:tab.url,native_document:frame.documentId};
    }
    async prepareReloadBridge(context,valid) {
      const key=await this.key();await valid();
      const entries=await this.entries();if(!Object.values(entries).some(e=>e.state!=='retired'))return false;
      const slot=context.slot,entry=entries[slot],session=await this.session();
      if(context.owner!==await this.owner()||!/^4\.\d+\.\d+$/.test(context.target)||context.target===context.from||!entry||entry.session!==session||entry.state!=='opened'||entry.verification!==true||entry.url!==root.CrowdCore.HOST+'/'||typeof entry.token!=='string'||!entry.token||typeof entry.document!=='string'||!entry.document)throw Error('executor_busy');
      const snapshot=await this.bridgeWindow(slot,entry,key);
      const proof=(await this.probe(entry.tab,'ownership')).response;
      if(proof?.token!==entry.token||proof?.document!==entry.document)throw Error('executor_busy');
      await valid();
      if((await this.storage.get('ota-window-bridge:'+context.owner))?.state==='reload_sent')throw Error('executor_busy');
      const prepared_at=Date.now(),bridge={schema:1,state:'prepared',...context,session,entry:{...entry},snapshot,prepared_at,expires_at:prepared_at+120000};
      await this.storage.set('ota-window-bridge:'+context.owner,bridge);
      await valid();const after=await this.bridgeWindow(slot,entry,key,snapshot.native_document);
      if(JSON.stringify(after)!==JSON.stringify(snapshot))throw Error('executor_busy');return true;
    }
    restoreReloadBridge(...args){if(this.bridgeRestore)return this.bridgeRestore;this.bridgeRestore=this.restoreReloadBridgeOwned(...args).finally(()=>{this.bridgeRestore=null;});return this.bridgeRestore;}
    async restoreReloadBridgeOwned(context,version,valid,verify) {
      const key=await this.key(),bridgeKey='ota-window-bridge:'+context.owner,b=await this.storage.get(bridgeKey);
      if(!b)return false;
      if(b.state==='completed'&&b.target===version)return true;
      if(b.schema!==1||b.state!=='prepared'||b.target!==version||b.owner!==context.owner||['installation_id','expected_ref','binding','slot'].some(k=>b[k]!==context[k])||!Number.isSafeInteger(b.prepared_at)||!Number.isSafeInteger(b.expires_at)||b.expires_at!==b.prepared_at+120000||Date.now()>b.expires_at||Date.now()<b.prepared_at)throw Error('executor_busy');
      await valid();
      if((await this.chrome.storage.session.get('crowd_work_session')).crowd_work_session)throw Error('executor_busy');
      const before=await this.bridgeWindow(b.slot,b.entry,key,b.snapshot.native_document);
      if(JSON.stringify(before)!==JSON.stringify(b.snapshot))throw Error('executor_busy');
      // Durable once intent precedes the only page reload; an unknown result is never replayed.
      b.state='reload_sent';b.reload_sent_at=Date.now();await this.storage.set(bridgeKey,b);await valid();
      await this.chrome.tabs.reload(b.entry.tab,{bypassCache:false});
      let page,frame,tab;
      for(let n=0;n<50;n++){
        await valid();if(Date.now()>b.expires_at)throw Error('executor_busy');tab=await this.chrome.tabs.get(b.entry.tab);
        const window=await this.chrome.windows.get(b.snapshot.window,{populate:true});
        if(window.state!=='minimized'||window.focused===true||window.type!=='normal'||window.incognito||window.tabs?.length!==1||window.tabs[0].id!==tab.id||tab.windowId!==window.id)throw Error('executor_busy');
        frame=await this.chrome.webNavigation.getFrame({tabId:tab.id,frameId:0});
        if(tab.status==='complete'&&!tab.pendingUrl&&!tab.discarded&&!tab.frozen&&this.matches(tab.url,b.entry.url)&&frame?.documentLifecycle==='active'&&!frame.errorOccurred&&frame.url===tab.url&&this.validNativeDocument(frame.documentId)&&frame.documentId!==b.snapshot.native_document){
          try{page=await this.chrome.tabs.sendMessage(tab.id,{type:'crowd_session_probe'});}catch(_){}
          if(page?.platform==='xiaohongshu'&&page.status==='unknown'&&page.reason==null)page=null;
          if(page)break;
        }
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      if(!page||!await verify(page,b.expected_ref))throw Error('identity_verification_required');
      await valid();
      const token=this.uuid(),bound=await this.chrome.tabs.sendMessage(tab.id,{type:'crowd_bind',token});
      const proof=(await this.probe(tab.id,'ownership')).response;
      if(typeof bound?.document!=='string'||!bound.document||bound.document===b.entry.document||proof?.document!==bound.document||proof?.token!==token)throw Error('executor_busy');
      const latest=await this.chrome.webNavigation.getFrame({tabId:tab.id,frameId:0,documentId:frame.documentId});
      if(latest?.documentId!==frame.documentId||latest.documentLifecycle!=='active'||latest.errorOccurred||latest.url!==tab.url)throw Error('executor_busy');
      if(!await verify(await this.chrome.tabs.sendMessage(tab.id,{type:'crowd_session_probe'}),b.expected_ref))throw Error('platform_identity_changed');
      await valid();const final=await this.bridgeWindow(b.slot,b.entry,key,frame.documentId);if(final.window!==b.snapshot.window||final.tab!==b.snapshot.tab)throw Error('executor_busy');
      const session=await this.session();
      await this.write(entries=>{if(JSON.stringify(entries[b.slot])!==JSON.stringify(b.entry))throw Error('cancelled');entries[b.slot]={...b.entry,session,instance:this.instance,token,document:bound.document};},key);
      b.state='completed';b.completed_at=Date.now();b.restored_native_document=frame.documentId;await this.storage.set(bridgeKey,b);return true;
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
    async removed(id,info={}) {
      const pending=this.pendingRemovals.get(id);this.pendingRemovals.delete(id);
      const ownerKey=await this.key();
      const matched=[];
      await this.write(entries=>{for(const [slot,entry] of Object.entries(entries))if(entry.tab===id){matched.push({role:this.role(slot,entry),session:entry.session,token:entry.token,document:entry.document});entry.state='missing';}},ownerKey);
      let marker=null;try{marker=(await this.chrome.storage.session.get('crowd_work_session')).crowd_work_session;}catch(_){}
      const own=pending&&pending.ownerKey===ownerKey&&pending.session===marker&&(!matched.length||matched.some(e=>e.token===pending.token&&e.document===pending.document&&e.session===pending.session));
      const roles=new Set(matched.map(e=>e.role));if(own)roles.add(pending.role);
      const kind=info?.isWindowClosing===true?'window':info?.isWindowClosing===false?'tab':'unknown';
      for(const role of roles)this.observeWindow('removed_'+role+'_'+(own&&(!matched.length&&role===pending.role||matched.some(e=>e.role===role&&e.token===pending.token&&e.document===pending.document&&e.session===pending.session))?'own_request':'unattributed')+'_'+kind,ownerKey);
    }
  }
  root.CrowdWorkTabs=CrowdWorkTabs;
})(globalThis);
