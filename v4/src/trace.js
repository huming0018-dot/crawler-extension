(function(root){
 'use strict';
 const stages=['worker_started','admission_requested','admission_allowed','admission_denied','open_requested','tab_created','tab_reused','update_accepted','update_failed','nav_started','nav_committed','nav_dom_ready','nav_complete','nav_failed','probe_ready','probe_missing','probe_timeout','navigation_timeout','submit_requested','submit_accepted','submit_rejected','submit_failed'];
 const windowStages=['close_all_requested',...['search','verification','other'].flatMap(role=>['close_'+role+'_requested','remove_'+role+'_requested',...['own_request','unattributed'].flatMap(origin=>['window','tab','unknown'].map(kind=>'removed_'+role+'_'+origin+'_'+kind))])];
 class CrowdTrace {
  constructor({storage,settings,uuid,now=Date.now}){Object.assign(this,{storage,settings,uuid,now});this.queue=Promise.resolve();}
  event(stage,{start=false,id=null,owner=null}={}) {
   const windowEvent=windowStages.includes(stage);if(!windowEvent&&!stages.includes(stage))return Promise.resolve();
   this.queue=this.queue.then(async()=>{
    const s=await this.settings();if(!s.enabled||!s.id||owner!==null&&s.id!==owner)return;
    const key='diagnostics:'+s.id+':trace',now=Math.floor(this.now()/1000);
    const old=await this.storage.get(key),rows=old?.revision===s.revision?old.rows.filter(r=>r.at>=now-86400&&r.at<=now):[];
    const current=old?.revision===s.revision?old.current:null,windowRows=old?.revision===s.revision?(old.window_rows||[]).filter(r=>r.at>=now-86400&&r.at<=now):[];
    const value={id:id||(!start&&current)||this.uuid(),stage,at:now};
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id))return;
    const check=await this.settings();if(!check.enabled||check.id!==s.id||check.revision!==s.revision)return;
    const last=(windowEvent?windowRows:rows).at(-1);if(last?.id===value.id&&last.stage===stage)return;
    await this.storage.set(key,{revision:s.revision,current:windowEvent?current:id?current:value.id,rows:windowEvent?rows:[...rows,value].slice(-24),window_rows:windowEvent?[...windowRows,value].slice(-24):windowRows});
   }).catch(()=>{});return this.queue;
  }
  async snapshot(){await this.queue;const s=await this.settings();if(!s.enabled||!s.id)return [];const v=await this.storage.get('diagnostics:'+s.id+':trace');const now=Math.floor(this.now()/1000);return v?.revision===s.revision?v.rows.filter(r=>r.at>=now-86400&&r.at<=now):[];}
  async windowSnapshot(){await this.queue;const s=await this.settings();if(!s.enabled||!s.id)return [];const v=await this.storage.get('diagnostics:'+s.id+':trace'),now=Math.floor(this.now()/1000);return v?.revision===s.revision?(v.window_rows||[]).filter(r=>r.at>=now-86400&&r.at<=now):[];}
  async clear(id){await this.queue;if(id)await this.storage.set('diagnostics:'+id+':trace',null);}
 }
 root.CrowdTrace=CrowdTrace;
})(globalThis);
