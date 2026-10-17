/* Low-frequency observation of existing DOM pages. Never navigates or resumes work. */
(function(root){
  'use strict';
  const platforms=['xiaohongshu','bilibili'];
  class Health {
    constructor(runtime){this.r=runtime;this.active=null;}
    async read(owner){owner=owner||await this.r.owner();return owner?await this.r.storage.get('platform-health:'+owner)||{}:{};}
    async check(force=false){
      if(this.active)return this.active;
      this.active=this.observe(force).finally(()=>{this.active=null;});return this.active;
    }
    async observe(force){
      const owner=await this.r.owner();if(!owner)return {};
      const state=await this.read(owner),now=this.r.now();
      if(!force&&state.checked_at&&now>=state.checked_at&&now-state.checked_at<60000)return state;
      let pages;try{pages=await this.r.probe();}catch(_){pages={xiaohongshu:{status:'unknown'},bilibili:{status:'unknown'}};}if(owner!==await this.r.owner())throw Error('cancelled');
      for(const platform of platforms){
        const old=state[platform]||{},page=pages[platform]||{status:'no_page'};
        const next={...old,status:page.status,checked_at:now,reason:null};
        if(page.status==='authenticated'&&page.principal_ref){
          next.observed_ref=page.principal_ref;
          next.expected_ref=old.expected_ref||page.principal_ref;
          if(next.expected_ref!==page.principal_ref){next.status='account_changed';next.reason='platform_identity_changed';}
          else{next.observed_at=now;next.recovered=!!old.reason||old.recovered===true;}
        }else if(page.status==='logged_out')next.reason='login_required';
        else if(page.status==='challenge')next.reason=['captcha','rate_limit'].includes(page.reason)?page.reason:'captcha';
        else if(old.reason||page.status!=='no_page'&&old.expected_ref)next.reason='identity_verification_required';
        state[platform]=next;
      }
      state.checked_at=now;
      if(owner!==await this.r.owner())throw Error('cancelled');
      await this.r.storage.set('platform-health:'+owner,state);return state;
    }
    async confirm(platform,principal_ref){
      if(!platforms.includes(platform)||!/^[a-f0-9]{64}$/.test(principal_ref))throw Error('identity_verification_required');
      while(this.active)await this.active.catch(()=>{});
      this.active=this.bind(platform,principal_ref).finally(()=>{this.active=null;});return this.active;
    }
    async bind(platform,principal_ref){
      const owner=await this.r.owner();if(!owner)throw Error('backend_login_required');
      const state=await this.read(owner),now=this.r.now();state[platform]={status:'authenticated',expected_ref:principal_ref,observed_ref:principal_ref,checked_at:now,observed_at:now,reason:null,recovered:true};state.checked_at=0;
      if(owner!==await this.r.owner())throw Error('cancelled');await this.r.storage.set('platform-health:'+owner,state);return state;
    }
    async require(platform){const state=await this.check(),entry=state[platform];if(entry?.reason)throw Error(entry.reason);return entry;}
    async publicState(){const state=await this.read();return Object.fromEntries(platforms.map(platform=>{const p=state[platform]||{};return [platform,{status:p.status||'not_checked',reason:p.reason||null,checked_at:p.checked_at||null,observed_at:p.observed_at||null,recovered:p.recovered===true}];}));}
  }
  root.CrowdPlatformHealth=Health;
})(globalThis);
