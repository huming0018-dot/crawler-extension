/* Bounded, owner-scoped health confirmation; never bypasses a challenge. */
(function(root){
 'use strict';
 class CrowdRecovery {
  constructor({id,owner,storage,agent,api,tabs,prefs,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),busy=()=>false}){Object.assign(this,{id,owner,storage,agent,api,tabs,prefs,now,sleep,busy});this.active=null;this.generation=0;}
  async cancel(){this.generation++;if(this.id==='ipccepibnkcfpikgebdaanimocdappfk')await this.api.rpc('recovery_check',{p_action:'cancel'}).catch(()=>{});}
  run(){if(!this.active)this.active=this.perform().finally(()=>{this.active=null;});return this.active;}
  async perform(){
   if(this.id!=='ipccepibnkcfpikgebdaanimocdappfk'||this.busy()||this.agent.maintenance)return;
   this.agent.maintenance=true;try{return await this.performOwned();}finally{this.agent.maintenance=false;}
  }
  async performOwned(){
   const owner=await this.owner(),generation=this.generation,intent=this.agent.stopIntent||0;
   if(!owner||(await this.prefs()).enabled!==true)return;
   const valid=async()=>generation===this.generation&&owner===await this.owner()&&intent===(this.agent.stopIntent||0)&&(await this.prefs()).enabled===true;
   let s=await this.agent.read();
   if(['sending','unknown'].includes(s.risk_report?.state))return;
   if(s.enabled||s.outbox?.length||s.pending_risk&&s.pending_risk!=='rate_limit')return;
   if(!await valid())return;
   const key='recovery-attempt:'+owner,previous=await this.storage.get(key);
   if(previous?.state==='result_pending'&&['rate_limit','update_recovery',null].includes(s.last_error)){await this.finish(previous,owner,valid);return;}
   if(s.last_error!=='rate_limit')return;
   const grant=await this.api.rpc('recovery_check',{p_action:'claim'});
   if(!await valid()||grant.allowed!==true)return;
   if(!/^[a-f0-9-]{36}$/.test(grant.attempt||'')||!/^[a-f0-9]{24}$/.test(grant.note_id||'')||!Number.isSafeInteger(grant.task_id))throw Error('invalid_receipt');
   // An uncertain creation is not repeated after a worker restart.
   if(previous?.attempt===grant.attempt)return;
   await this.storage.set(key,{attempt:grant.attempt,note_id:grant.note_id,state:'opening',at:this.now()});
   if(!await valid())return;
   const slot='recovery:'+grant.attempt;
   let result='unknown';
   try{
    let url=grant.note_url||'https://www.xiaohongshu.com/explore/'+grant.note_id;
    const owned=this.tabs.entries?await this.tabs.entries():{};
    const saved=[s.note_url,...Object.values(owned).map(v=>v?.url),...(s.work_slots||[]).map(v=>v.url),...(s.candidates||[]),...(s.queue||[]).map(v=>typeof v==='string'?v:v?.url)];
    for(const candidate of saved)try{if(root.CrowdCore.noteURL(candidate).id===grant.note_id){url=candidate;break;}}catch(_){}
    if(root.CrowdCore.noteURL(url).id!==grant.note_id)throw Error('invalid_receipt');
    if(!await valid())return;
    await this.tabs.open(url,slot);
    const deadline=this.now()+45000;
    while(this.now()<deadline&&await valid()){
     const page=await this.tabs.read('note_ready',slot);
     if(['rate_limit','captcha','login_required'].includes(page?.gate)){result=page.gate;break;}
     if(page?.ready&&page.record?.standard?.note_id===grant.note_id&&typeof page.record.evidence?.text==='string'&&page.record.evidence.text.length){result='clear';break;}
     await this.sleep(1000);
    }
   }catch(e){if(['rate_limit','captcha','login_required'].includes(e.message))result=e.message;}
   if(!await valid())return;
   const pending={attempt:grant.attempt,slot,state:'result_pending',result,at:this.now()};
   await this.storage.set(key,pending);
   await this.finish(pending,owner,valid);
  }
  async finish(pending,owner,valid){
   const {attempt,result,slot}=pending,key='recovery-attempt:'+owner;
   const ack=await this.api.rpc('recovery_check',{p_action:'result',p_attempt:attempt,p_result:result});
   if(!await valid()||ack.attempt!==attempt)throw Error('invalid_receipt');
   if(result!=='clear'||ack.recovered!==true)await this.storage.set(key,{attempt,state:'reported',result,at:this.now()});
   if(['captcha','login_required'].includes(result)){
    const current=await this.agent.read();
    if(await valid()&&!current.enabled&&current.last_error==='rate_limit'&&(!current.pending_risk||current.pending_risk==='rate_limit')){current.last_error=result;current.pending_risk=null;await this.agent.save(current);}
    return; // Preserve the challenge page for its owner.
   }
   if(slot)await this.tabs.close(slot,owner).catch(()=>{});
   if(result!=='clear'||ack.recovered!==true){
    if(ack.gate==='waiting'&&Number.isFinite(ack.wait_ms)&&ack.wait_ms>=0){const current=await this.agent.read();if(await valid()&&!current.enabled&&current.last_error==='rate_limit'&&(!current.pending_risk||current.pending_risk==='rate_limit')){current.pending_risk=null;current.next_at=this.now()+Math.min(172800000,ack.wait_ms);await this.agent.save(current);}}
    return;
   }
   const s=await this.agent.read();if(!await valid()||s.enabled||s.outbox?.length||!['rate_limit','update_recovery',null].includes(s.last_error))return;
   const control=await this.agent.control(s,'control',()=>{});
   if(!await valid()||control.paused||control.reason!==null)return;
   const fresh=await this.agent.read();
   if(!await valid()||fresh.enabled||fresh.outbox?.length||!['rate_limit','update_recovery',null].includes(fresh.last_error)||fresh.pending_risk&&fresh.pending_risk!=='rate_limit'||fresh.run_generation!==s.run_generation)return;
   fresh.pending_risk=null;fresh.last_error=null;fresh.next_at=this.now();fresh.control=s.control;fresh.control_checked=s.control_checked;fresh.control_expires=s.control_expires;
   await this.agent.save(fresh);
   await this.agent.stop('update_recovery',{drain:true,expectedOwner:owner,stoppedCheckpoint:true});
   await this.storage.set(key,{attempt,state:'reported',result,at:this.now()});
  }
 }
 root.CrowdRecovery=CrowdRecovery;
})(globalThis);
