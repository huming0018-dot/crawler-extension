(function(root){
 'use strict';
 const stages=['worker_started','admission_requested','admission_allowed','admission_denied','open_requested','tab_created','tab_reused','update_accepted','update_failed','nav_started','nav_committed','nav_dom_ready','nav_complete','nav_failed','probe_ready','probe_missing','probe_timeout','navigation_timeout','submit_requested','submit_accepted','submit_rejected','submit_failed'];
 class CrowdTrace {
  constructor({storage,settings,uuid,now=Date.now}){Object.assign(this,{storage,settings,uuid,now});this.queue=Promise.resolve();}
  event(stage,{start=false,id=null}={}) {
   if(!stages.includes(stage))return Promise.resolve();
   this.queue=this.queue.then(async()=>{
    const s=await this.settings();if(!s.enabled||!s.id)return;
    const key='diagnostics:'+s.id+':trace',now=Math.floor(this.now()/1000);
    const old=await this.storage.get(key),rows=old?.revision===s.revision?old.rows.filter(r=>r.at>=now-86400&&r.at<=now):[];
    const current=old?.revision===s.revision?old.current:null;
    const value={id:id||(!start&&current)||this.uuid(),stage,at:now};
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id))return;
    const check=await this.settings();if(!check.enabled||check.id!==s.id||check.revision!==s.revision)return;
    const last=rows.at(-1);if(last?.id===value.id&&last.stage===stage)return;
    await this.storage.set(key,{revision:s.revision,current:id?current:value.id,rows:[...rows,value].slice(-24)});
   }).catch(()=>{});return this.queue;
  }
  async snapshot(){await this.queue;const s=await this.settings();if(!s.enabled||!s.id)return [];const v=await this.storage.get('diagnostics:'+s.id+':trace');const now=Math.floor(this.now()/1000);return v?.revision===s.revision?v.rows.filter(r=>r.at>=now-86400&&r.at<=now):[];}
  async clear(id){await this.queue;if(id)await this.storage.set('diagnostics:'+id+':trace',null);}
 }
 root.CrowdTrace=CrowdTrace;
})(globalThis);
