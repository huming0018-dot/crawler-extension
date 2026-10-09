/* Explicit KOL tasks use their own RPC/outbox. They never enter reward proofs. */
(function(root) {
  'use strict';
  function targetURL(value) {
    if(typeof value!=='string'||value.length>2048)throw new Error('unsupported_navigation');
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) throw new Error('unsupported_navigation');
    let match, platform, kind, id, url;
    if (['www.xiaohongshu.com','m.xiaohongshu.com'].includes(u.hostname)) {
      platform = 'xiaohongshu';
      if ((match=u.pathname.match(/^\/user\/profile\/([a-f0-9]{24})\/?$/i))) {kind='creator';id=match[1].toLowerCase();url='https://www.xiaohongshu.com/user/profile/'+id;}
      else if ((match=u.pathname.match(/^\/(?:explore|discovery\/item|search_result)\/([a-f0-9]{24})\/?$/i))) {kind='content';id=match[1].toLowerCase();url='https://www.xiaohongshu.com/explore/'+id;}
    } else if (u.hostname==='space.bilibili.com' && (match=u.pathname.match(/^\/(\d{1,20})(?:\/(?:video|upload\/video))?\/?$/))) {
      platform='bilibili';kind='creator';id=match[1];url='https://space.bilibili.com/'+id;
    } else if (u.hostname==='www.bilibili.com' && (match=u.pathname.match(/^\/video\/(BV[A-Za-z0-9]{10})\/?$/))) {
      platform='bilibili';kind='content';id=match[1];url='https://www.bilibili.com/video/'+id;
    }
    if (!url) throw new Error('unsupported_navigation');
    // Access parameters stay only in local navigation state, never in evidence.
    return {platform,kind,id,url,navigation:platform==='xiaohongshu'?u.href:kind==='creator'?url+'/video':url};
  }
  function validateRecord(record, task, expected) {
    const s=record?.standard, e=record?.evidence, identity=targetURL(s?.url);
    if (record.schema_version!==4 || identity.kind!=='content' || identity.platform!==task.platform || s.note_id!==expected || identity.id!==expected || identity.url!==s.url) throw new Error('wrong_note');
    if (typeof s.title!=='string' || s.title.length>300 || typeof e?.text!=='string' || e.text.length>24000 || (!s.title && !e.text && record.extra?.media_present!==true)) throw new Error('invalid_content');
    if (e.source!=='rendered_public_dom' || !Number.isFinite(Date.parse(s.captured_at)) || JSON.stringify(record).length>60000) throw new Error('invalid_content');
    if (task.target_kind==='creator' && record.extra?.author?.id!==task.target_id) throw new Error('author_mismatch');
    for (const key of ['like_count','collect_count','comment_count','view_count']) if (s[key]!==null && (!Number.isSafeInteger(s[key]) || s[key]<0 || s[key]>2147483647)) throw new Error('invalid_count');
    return record;
  }
  const initial=()=>({enabled:false,delivery_enabled:false,phase:'idle',task:null,outbox:[],rejected:[],next_at:0,last_error:null,received:0,candidates:[],attempts:0});
  function mergeComments(previous,incoming,limit){
    const items=[],seen=new Map();
    let sampleIndex=0;for(const sample of [previous,incoming]){sampleIndex++;const keys=new Map();for(const item of sample?.items||[]){
      const parent=item.parent_key?keys.get(item.parent_key):null;if(item.parent_key&&!parent)continue;
      const identity=item.comment_id?'id:'+item.comment_id:item.content_type==='image'?'image-sample:'+sampleIndex+':'+item.key:'sample:'+item.text+'\n'+(parent||'');
      if(seen.has(identity)){keys.set(item.key,seen.get(identity));continue;}if(items.length>=limit)continue;
      const key='comment-'+(items.length+1);keys.set(item.key,key);seen.set(identity,key);items.push({...item,key,parent_key:parent||null,author_display:null});
    }}return {...(incoming||previous||{}),items,captured_count:items.length,complete:false,coverage:'visible_loaded_only'};
  }
  class Agent {
    constructor(runtime,api) {this.r=runtime;this.api=api;this.active=null;this.generation=0;}
    async owner() {return (await this.r.storage.get('session'))?.user?.id || null;}
    async read(owner) {owner=owner||await this.owner();return {...initial(),...await this.r.storage.get('kol:'+ (owner||'signed-out'))};}
    async save(s,owner) {if (!owner) throw new Error('backend_login_required');await this.r.storage.set('kol:'+owner,s);}
    async rpc(action,payload={},signal) {const r=await this.api.rpc('kol',{p_action:action,p_payload:payload},signal);if(r?.error)throw new Error(r.error);return r;}
    async executor(){let id=await this.r.storage.get('kol-executor');if(!id){id=this.r.uuid();await this.r.storage.set('kol-executor',id);}return id;}
    checkpointPayload(s,executor_id){const pending=[...(s.candidate_backlog||[]),...(s.candidates||[]).map(x=>x.id)];if(s.pending_record||['detail','comments','comment_read'].includes(s.phase))pending.push(s.current_id);
      return {task:s.task.id,lease:s.task.lease_token,executor_id,expected_revision:s.checkpoint_revision||0,candidate_ids:[...new Set(pending.filter(id=>id&&!(s.processed_ids||[]).includes(id)))].slice(0,100),processed_ids:[...new Set(s.processed_ids||[])],scrolls:Math.max(s.resume_scrolls||0,s.discovery_scrolls||0),coverage:'partial'};}
    async stoppedMutation(reason,drain,mutate){
      const generation=this.generation+1,owner=await this.owner();await this.stop(reason,drain,{keepPage:reason==='manual_delivery_retry'});
      while(this.active)await this.active.catch(()=>{});
      if(generation!==this.generation)throw new Error('cancelled');
      this.controller=new AbortController();const signal=this.controller.signal;
      this.active=(async()=>{const alive=async()=>{if(signal.aborted||generation!==this.generation||owner!==await this.owner())throw new Error('cancelled');};
        await alive();const s=await this.read(owner),executor_id=await this.executor();await alive();s.enabled=false;await this.save(s,owner);await alive();return mutate(s,owner,executor_id,alive,signal);
      })().finally(()=>{this.active=null;});return this.active;
    }
    async recover(task){return this.stoppedMutation('recovering',true,async(s,owner,executor_id,alive,signal)=>{
      if(s.outbox.length||s.pending_record)throw new Error('pending_identity_delivery');
      const r=await this.rpc('recover',{task,executor_id},signal);await alive();
      if(!r.task||r.task.id!==task||r.task.executor_id!==executor_id)throw new Error('invalid_receipt');
      s.task=null;s.phase='idle';s.enabled=true;s.delivery_enabled=true;s.last_error=null;await this.save(s,owner);await alive();await this.r.schedule();return r;
    });}
    async release(){return this.stoppedMutation('releasing',true,async(s,owner,executor_id,alive,signal)=>{
      if(!s.task||s.task.execution_protocol!==1)throw new Error('recovery_not_supported');if(s.outbox.length||s.pending_record)throw new Error('outbox_not_drained');if(s.pending_guard||(s.unsettled||[]).length)throw new Error('source_outcome_unknown');
      s.pending_checkpoint||=this.checkpointPayload(s,executor_id);await this.save(s,owner);await alive();const cp=await this.rpc('checkpoint',s.pending_checkpoint,signal);await alive();
      if(!Number.isInteger(cp.checkpoint?.revision))throw new Error('invalid_checkpoint');s.checkpoint_revision=cp.checkpoint.revision;s.pending_checkpoint=null;await this.save(s,owner);await alive();
      const r=await this.rpc('release',{task:s.task.id,lease:s.task.lease_token,executor_id,checkpoint_revision:s.checkpoint_revision,outbox_drained:true},signal);await alive();if(r.released!==true)throw new Error('invalid_receipt');
      s.task=null;s.phase='idle';s.last_error='executor_released';await this.save(s,owner);return r;
    });}
    async retryDelivery(){return this.stoppedMutation('manual_delivery_retry',false,async(s,owner,executor_id,alive)=>{
      if(s.outbox[0]){s.outbox[0].delivery_attempts=0;s.outbox[0].retries=0;s.outbox[0].retry_at=0;}s.delivery_enabled=true;s.last_error=null;await this.save(s,owner);await alive();await this.r.schedule();
    });}
    async resumeParser(platform){if(!['xiaohongshu','bilibili'].includes(platform))throw new Error('unsupported_platform');return this.stoppedMutation('parser_reviewed',true,async(s,owner)=>{s.parser_failures||={};delete s.parser_failures[platform];s.last_error=null;await this.save(s,owner);});}
    async start(payload) {
      const generation=this.generation;await this.active?.catch(()=>{});
      if(generation!==this.generation)throw new Error('cancelled');
      if(this.active)return this.start(payload);
      this.controller=new AbortController();
      this.active=this.activate(payload,generation,this.controller.signal).finally(()=>{this.active=null;});return this.active;
    }
    async activate(payload,generation,signal){
      const owner=await this.owner();if(!owner)throw new Error('backend_login_required');
      const alive=async()=>{if(generation!==this.generation||signal.aborted||owner!==await this.owner())throw new Error('cancelled');};
      const s=await this.read(owner);if(s.outbox.length && s.last_error==='backend_login_required')throw new Error('pending_identity_delivery');
      if(s.pending_risk){await this.rpc('finish',s.pending_risk,signal);await alive();s.pending_risk=null;s.task=null;s.phase='idle';s.candidates=[];}
      let platform=s.task?.platform;
      if(payload?.target_id){const created=await this.rpc('start',payload,signal);platform=created.task?.platform||platform;}
      if(platform)await this.r.sourceHealth?.(platform);
      await alive();s.enabled=true;s.delivery_enabled=true;s.last_error=null;await this.save(s,owner);await alive();await this.r.schedule();
    }
    async stop(reason='user_stopped',drain=true,{keepPage=false,expectedOwner=null}={}) {
      if(expectedOwner&&expectedOwner!==await this.owner())return;
      this.generation++;this.controller?.abort();await this.active?.catch(()=>{});
      const owner=await this.owner();if(!owner||expectedOwner&&owner!==expectedOwner)return;const s=await this.read(owner);s.enabled=false;s.delivery_enabled=drain;s.last_error=reason;
      if(s.pending_record)this.queueRecord(s);
      else if(keepPage){/* Keep the admitted page and cursor for explicit same-account continuation. */}
      else if(s.phase==='detail')s.phase='resume_detail';
      else if(['discover','discovery_scroll'].includes(s.phase))s.phase='resume_listing';
      if(s.task&&['captcha','rate_limit'].includes(reason))s.pending_risk={task:s.task.id,lease:s.task.lease_token,...(s.task.execution_protocol===1?{executor_id:await this.executor()}:{}),reason:'risk_paused',risk_type:reason};
      await this.save(s,owner);if(expectedOwner&&owner!==await this.owner())return;if(drain&&s.outbox.length)await this.r.schedule();else await this.r.cancel();if(!keepPage)await this.r.close();
    }
    async tick() {
      if(this.active)return this.active;
      this.controller=new AbortController();const generation=this.generation;
      this.active=this.step(generation,this.controller.signal).finally(()=>{this.active=null;});return this.active;
    }
    async step(generation,signal) {
      const owner=await this.owner();if(!owner)return;const s=await this.read(owner);
      if(!s.enabled && !(s.delivery_enabled&&s.outbox.length))return;
      const alive=async()=>{if(signal.aborted||generation!==this.generation||owner!==await this.owner())throw new Error('cancelled');};
      const save=async()=>{await alive();await this.save(s,owner);};
      const call=async(action,payload)=>{await alive();const r=await this.rpc(action,{...payload,...(s.task?.execution_protocol===1&&action==='finish'?{executor_id}:{})},signal);await alive();return r;};
      const executor_id=await this.executor();await alive();
      const protocol=()=>s.task?.execution_protocol===1;
      const settle=async(action,outcome='observed',failure_reason)=>{if(!protocol())return;for(const entry of [...(s.unsettled||[])].filter(x=>x.action===action)){
        await call('action_settle',{task:s.task.id,lease:s.task.lease_token,executor_id,admission_id:entry.admission_id,outcome,...(failure_reason?{failure_reason}:{})});s.unsettled=s.unsettled.filter(x=>x.admission_id!==entry.admission_id);await save();
      }};
      const checkpoint=async()=>{if(!protocol())return;s.pending_checkpoint||=this.checkpointPayload(s,executor_id);await save();const r=await call('checkpoint',s.pending_checkpoint);s.checkpoint_revision=r.checkpoint?.revision??r.revision;if(!Number.isInteger(s.checkpoint_revision))throw new Error('invalid_checkpoint');s.pending_checkpoint=null;await save();};
      const verifyPrincipal=async()=>{await this.r.sourceHealth?.(s.task.platform);await alive();if(s.task.principal_ref){if(!this.r.verifyPrincipal)throw new Error('identity_verification_required');await this.r.verifyPrincipal(s.task);await alive();}};
      const admit=async(action,content_id)=>{
        await this.r.sourceHealth?.(s.task.platform);await alive();
        if(s.parser_failures?.[s.task.platform]?.paused)throw new Error('parser_paused');
        await verifyPrincipal();
        if(protocol()&&(s.unsettled||[]).length&&!s.pending_record)throw new Error('source_outcome_unknown');
        if(protocol()&&!s.pending_guard){s.pending_guard={request:this.r.uuid(),action,content_id};await save();}
        const r=await call('guard',{task:s.task.id,lease:s.task.lease_token,action,...(content_id?{content_id}: {}),...(protocol()?{executor_id,request:s.pending_guard.request}:{})});
        if(r.replay)throw new Error('source_outcome_unknown');
        if(protocol()){s.pending_guard=null;if(r.allowed)(s.unsettled||=[]).push({admission_id:r.admission_id,action});await save();}
        if(typeof r?.allowed!=='boolean'||!Number.isFinite(r.wait_ms)||r.wait_ms<0||r.wait_ms>172800000)throw new Error('control_unavailable');
        if(!r.allowed){
          s.next_at=this.r.now()+Math.max(30000,r.wait_ms);s.last_error=r.reason||'control_unavailable';
          if(['source_outcome_unknown','lease_expired','target_paused','global_pause','captcha','rate_limit','executor_released','content_already_received','old_executor_required'].includes(r.reason)){s.enabled=false;}
          if(r.reason==='lease_expired'&&!protocol()){s.task=null;s.phase='idle';s.candidates=[];}
          if(r.reason==='task_budget'&&action!=='comment')s.phase='finish';
          if(['known_note','note_busy'].includes(r.reason)&&s.phase==='next')s.candidates.shift();
          await save();return null;
        }
        const caps={search:30,detail:60,comment:120,scroll:120};
        if(typeof r.admission_id!=='string'||!Number.isInteger(r.version)||r.version<1||r.paused!==false||r.reason!==null||
          !Number.isInteger(r.ttl_ms)||r.ttl_ms<1||r.ttl_ms>600000||!Number.isFinite(r.gap_ms)||r.gap_ms<30000||
          Object.entries(caps).some(([key,max])=>!Number.isInteger(r.caps?.[key])||r.caps[key]<1||r.caps[key]>max))throw new Error('control_unavailable');
        return r;
      };
      try {
        await this.r.schedule();
        if(s.pending_checkpoint&&s.task)await checkpoint();
        if(s.outbox.length&&s.delivery_enabled){
          const item=s.outbox[0];if(!Number.isInteger(item.delivery_attempts)||item.delivery_attempts<0){s.delivery_enabled=false;s.enabled=false;s.last_error='unknown_delivery_history';await save();return;}if(item.delivery_attempts>=3){s.delivery_enabled=false;s.enabled=false;s.last_error='delivery_retry_limit';await save();return;}if((item.retry_at||0)>this.r.now())return;
          item.delivery_attempts=(item.delivery_attempts||0)+1;item.retry_at=this.r.now()+60000*2**(item.delivery_attempts-1);await save();
          const {retry_at,retries,delivery_attempts,kind,...payload}=item,r=await call(kind==='profile'?'profile':'submit',payload);
          if(r.request!==item.request||r.gate!=='received'||r.task!==item.task||r.source_kind!=='rendered_public_dom'||r.reward_eligible!==false||
            (kind==='profile'?r.kind!=='profile':r.content_id!==item.record.standard.note_id))throw new Error('invalid_receipt');
          s.outbox.shift();if(kind!=='profile'){s.received++;s.task_received=(s.task_received||0)+1;(s.processed_ids||=[]).push(item.record.standard.note_id);s.unsettled=(s.unsettled||[]).filter(x=>x.admission_id!==item.admission_id);}s.last_error=null;s.next_at=this.r.now()+30000;await save();if(s.task&&protocol())await checkpoint();return;
        }
        if(!s.enabled)return;
        if(s.next_at>this.r.now())return;
        if(!s.task){
          const r=await call('claim',{executor_id});if(!r.task){s.phase='idle';s.last_error=r.reason||null;if(['source_outcome_unknown','old_executor_required','legacy_executor_required','explicit_recovery_required','lease_expired_requires_release'].includes(r.reason))s.enabled=false;s.next_at=this.r.now()+60000;await save();return;}
          const t=r.task,identity=targetURL(t.url);
          if(identity.platform!==t.platform||identity.kind!==t.target_kind||identity.id!==t.target_id||!Number.isInteger(t.max_items)||t.max_items<1||t.max_items>10||!Number.isInteger(t.comment_limit)||t.comment_limit<0||t.comment_limit>20)throw new Error('invalid_task');
          s.task=t;s.phase='open';s.attempts=t.attempts?.detail||0;s.task_received=t.received||0;s.candidates=[];s.discovered=[];s.discovery_round=0;s.discovery_scrolls=0;s.profile_queued=false;s.source_failure=null;
          s.checkpoint_revision=t.checkpoint?.revision||0;s.processed_ids=t.checkpoint?.processed_ids||[];s.candidate_backlog=t.checkpoint?.candidate_ids||[];s.resume_scrolls=t.checkpoint?.scrolls||0;s.scroll_attempts=t.attempts?.scroll||0;s.discovery_stalls=0;s.unsettled=[];s.pending_guard=null;
          s.coverage={status:'partial',reason:'visible_loaded_only',scanned_pages:0,outside_window:0};s.last_error=null;await save();
        }
        const t=s.task;
        if(Number.isFinite(Date.parse(t.lease_until))&&Date.parse(t.lease_until)>this.r.now()&&Date.parse(t.lease_until)<this.r.now()+120000){
          const renewed=await call('claim',{executor_id});
          if(renewed.task?.id!==t.id||renewed.task.credential_epoch!==t.credential_epoch)throw new Error('lease_expired');
          s.task={...t,...renewed.task};await save();return;
        }
        if(s.phase==='resume_listing'){if((s.unsettled||[]).length)throw new Error('source_outcome_unknown');s.resume_scrolls=s.discovery_scrolls||0;s.discovery_scrolls=0;s.phase='open';await save();return;}
        if(s.phase==='resume_detail'){
          if(s.attempts>=t.max_items){s.phase='finish';await save();return;}
          const grant=await admit('detail',s.current_id);if(!grant)return;
          s.attempts++;s.admission_id=grant.admission_id;s.phase='detail';s.deadline=this.r.now()+120000;s.next_at=this.r.now()+30000;
          await save();await alive();await this.r.open(s.current);await alive();return;
        }
        if(s.phase==='open'){
          const grant=await admit(t.target_kind==='creator'?'search':'detail',t.target_kind==='content'?t.target_id:null);if(!grant)return;
          s.phase=t.target_kind==='creator'?'discover':'detail';s.current=t.url;s.current_id=t.target_kind==='content'?t.target_id:null;s.admission_id=grant.admission_id;
          if(t.target_kind==='content')s.attempts++;
          s.deadline=this.r.now()+120000;s.next_at=this.r.now()+30000;await save();await alive();
          const locator=this.r.locator?await this.r.locator(t):targetURL(t.url).navigation;await alive();await this.r.open(locator);await alive();return;
        }
        if(s.phase==='discover'){
          const page=await this.r.probe({action:'discover',task:t});await alive();this.checkPage(page,s);
          if(!page.ready){s.next_at=this.r.now()+30000;await save();return;}
          const fingerprint=(page.links||[]).map(url=>{try{return targetURL(url).id;}catch{return '';}}).join(',');
          if(s.awaiting_listing&&fingerprint===s.last_listing&&!page.pagination?.end_observed&&this.r.now()<s.deadline){s.next_at=this.r.now()+30000;await save();return;}
          s.awaiting_listing=false;s.last_listing=fingerprint;
          await verifyPrincipal();
          await settle('search');await settle('scroll');
          if(page.creator_id!==t.target_id)throw new Error('author_mismatch');
          const known=new Set(t.known_ids||[]),refresh=new Set((t.refresh_ids||[]).slice(0,1)),seen=new Set((s.discovered||[]).map(x=>x.id));
          const added=(page.links||[]).flatMap(url=>{try{const x=targetURL(url);if(x.kind!=='content'||x.platform!==t.platform||seen.has(x.id))return [];seen.add(x.id);return [{id:x.id,url:x.navigation}];}catch{return [];}});
          s.discovered=[...(s.discovered||[]),...added].slice(-500);
          s.candidates=s.discovered.filter(x=>!(s.processed_ids||[]).includes(x.id)&&(!known.has(x.id)||refresh.has(x.id)||(s.candidate_backlog||[]).includes(x.id))).sort((a,b)=>Number(refresh.has(b.id))-Number(refresh.has(a.id)));
          s.discovery_round++;s.coverage={...s.coverage,scanned_pages:s.discovery_round};
          if(page.profile&&!s.profile_queued){
            const {notes,...profile}=page.profile;s.outbox.push({kind:'profile',request:this.r.uuid(),task:t.id,lease:t.lease_token,admission_id:s.admission_id,profile,delivery_attempts:0});s.profile_queued=true;
          }
          const scrollCap=Number.isInteger(t.max_discovery_scrolls)?Math.min(30,t.max_discovery_scrolls):3;
          const same=added.length===0;s.discovery_stalls=same?(s.discovery_stalls||0)+1:0;
          s.phase=(s.discovery_scrolls<(s.resume_scrolls||0)||s.candidates.length<t.max_items-s.attempts)&&(s.scroll_attempts||0)<scrollCap&&!page.pagination?.end_observed&&s.discovery_stalls<4?'discovery_scroll':'next';
          s.coverage.reason=page.pagination?.end_observed?'dom_end_observed':s.discovery_stalls>=3?'dom_stalled':s.discovery_scrolls>=scrollCap?'discovery_budget':'visible_loaded_only';s.next_at=this.r.now()+30000;await save();await checkpoint();return;
        }
        if(s.phase==='discovery_scroll'){
          const grant=await admit('scroll');if(!grant)return;
          s.discovery_scrolls++;s.scroll_attempts=(s.scroll_attempts||0)+1;s.awaiting_listing=true;s.phase='discover';s.deadline=this.r.now()+60000;s.next_at=this.r.now()+30000;await save();
          const result=await this.r.probe({action:'listing_scroll',task:t});await alive();if(result?.gate)throw new Error(result.gate);return;
        }
        if(s.phase==='next'){
          if(s.attempts>=t.max_items||!s.candidates.length){s.phase='finish';await save();return;}
          const next=s.candidates[0],grant=await admit('detail',next.id);if(!grant)return;
          s.candidates.shift();s.attempts++;s.current=next.url;s.current_id=next.id;s.admission_id=grant.admission_id;s.phase='detail';s.deadline=this.r.now()+120000;s.next_at=this.r.now()+30000;await save();await alive();await this.r.open(next.url);await alive();return;
        }
        if(s.phase==='detail'){
          const page=await this.r.probe({action:'detail',task:t});await alive();this.checkPage(page,s);
          if(!page.ready){s.next_at=this.r.now()+30000;await save();return;}
          await verifyPrincipal();
          const record=validateRecord(page.record,t,s.current_id);
          const published=Date.parse(record.standard.published_at),days=Number.isInteger(t.window_days)?t.window_days:30;
          const taskDay=new Date((Date.parse(t.created_at)||this.r.now())+8*3600000).toISOString().slice(0,10);
          const scanFrom=Date.parse(t.scan_from),scanUntil=Date.parse(t.scan_until),dateOnly=/^\d{4}-\d{2}-\d{2}$/.test(record.standard.published_at||'');
          const outside=Number.isFinite(published)&&(Number.isFinite(scanFrom)?published+(dateOnly?86400000:0)<=scanFrom||Number.isFinite(scanUntil)&&published>scanUntil:published<Date.parse(taskDay)-days*86400000);
          if(outside){await settle('detail','failed');s.candidate_backlog=(s.candidate_backlog||[]).filter(id=>id!==s.current_id);s.coverage.outside_window++;s.phase=t.target_kind==='creator'?'next':'finish';s.next_at=this.r.now()+30000;await save();return;}
          s.pending_record={request:this.r.uuid(),task:t.id,lease:t.lease_token,admission_id:s.admission_id,record};
          s.comment_pages=0;s.comment_stalls=0;
          if(t.comment_limit>0)s.phase='comments';
          else this.queueRecord(s);
          s.last_error=null;s.next_at=this.r.now()+30000;await save();return;
        }
        if(s.phase==='comments'){
          const grant=await admit('comment',s.current_id);
          if(!grant){this.queueRecord(s);await save();return;}
          s.phase='comment_read';s.deadline=this.r.now()+60000;s.next_at=this.r.now()+30000;await save();
          const result=await this.r.probe({action:'comments',task:t});await alive();if(result?.gate)throw new Error(result.gate);return;
        }
        if(s.phase==='comment_read'){
          const page=await this.r.probe({action:'detail',task:t});await alive();this.checkPage(page,s);
          if(page.ready){await verifyPrincipal();await settle('comment');const record=validateRecord(page.record,t,s.current_id),old=s.pending_record.record.extra.comments;
            record.extra.comments=mergeComments(old,record.extra.comments,t.comment_limit);s.comment_pages++;s.comment_stalls=record.extra.comments.items.length===(old?.items?.length||0)?s.comment_stalls+1:0;s.pending_record.record=record;
            const cap=Number.isInteger(t.max_comment_pages)?Math.min(5,t.max_comment_pages):3;
            if(record.extra.comments.items.length<t.comment_limit&&s.comment_pages<cap&&s.comment_stalls<2&&!page.pagination?.end_observed){s.phase='comments';s.next_at=this.r.now()+30000;await save();return;}
          }
          else if(this.r.now()<s.deadline){s.next_at=this.r.now()+30000;await save();return;}
          this.queueRecord(s);s.next_at=this.r.now()+30000;await save();return;
        }
        if(s.phase==='finish'){
          const rejected=s.rejected.some(x=>x.task===t.id),reason=s.source_failure?'error':t.target_kind==='creator'&&!rejected?'observed_only':s.task_received>=1&&!rejected?'completed':'partial';
          await checkpoint();await call('finish',{task:t.id,lease:t.lease_token,reason,...(s.source_failure?{detail_reason:s.source_failure}:{})});s.task=null;s.source_failure=null;s.phase='idle';s.next_at=this.r.now()+60000;await save();await this.r.close();
        }
      }catch(error){
        if(error.message==='cancelled'||signal.aborted)return;await alive();s.last_error=error.message;
        if(s.pending_record)this.queueRecord(s);
        const sourceFailure=['source_not_found','source_private','source_deleted'].includes(error.message)?error.message:null;
        if(sourceFailure)s.source_failure=sourceFailure;
        if(sourceFailure||['captcha','rate_limit','login_required','author_mismatch','navigation_failed','page_timeout','invalid_content','wrong_note','invalid_count'].includes(error.message)){
          try{await settle('search','failed',sourceFailure);await settle('scroll','failed',sourceFailure);await settle('comment','failed',sourceFailure);if(!(s.unsettled||[]).some(entry=>entry.action==='detail'&&s.outbox.some(item=>item.admission_id===entry.admission_id)))await settle('detail','failed',sourceFailure);}catch(_){s.last_error='source_outcome_unknown';}
        }
        if(s.task&&['invalid_content','invalid_count'].includes(error.message)){s.parser_failures||={};const failures=s.parser_failures[s.task.platform]||={counts:{},paused:false};failures.content_ids||={};const ids=failures.content_ids[error.message]||=[],id=s.current_id||s.task.target_id;if(id&&!ids.includes(id)&&ids.length<2)ids.push(id);failures.counts[error.message]=ids.length;if(ids.length>=2){failures.paused=true;s.enabled=false;s.last_error='parser_paused';}}
        if(s.outbox.length){const item=s.outbox[0];item.retry_at=this.r.now()+Math.min(900000,60000*2**Math.min((item.delivery_attempts||1)-1,4));}
        if(s.outbox[0]?.delivery_attempts>=3){s.enabled=false;s.delivery_enabled=false;s.last_error='delivery_retry_limit';}
        if(['invalid_record','invalid_comments','invalid_profile','invalid_metrics','invalid_author','invalid_envelope','invalid_timestamp','invalid_published_date','credential_material','outside_window','request_reused','target_mismatch','admission_expired','admission_missing','admission_used','task_missing'].includes(error.message)&&s.outbox.length){
          s.rejected.push({...s.outbox.shift(),reason:error.message});s.enabled=false;s.delivery_enabled=false;
        }
        if(['parser_paused','source_outcome_unknown','checkpoint_conflict','checkpoint_gap','checkpoint_regression','invalid_checkpoint','old_executor_required','executor_released','identity_verification_required','platform_identity_changed','captcha','rate_limit','login_required','backend_login_required','author_mismatch','navigation_uncommitted','navigation_failed','invalid_task','control_unavailable','admission_expired','invalid_record','request_reused','target_mismatch','lease_expired'].includes(error.message)||[401,403].includes(error.status)){
          s.enabled=false;
          if(error.message==='lease_expired'&&!protocol()){s.task=null;s.phase='idle';s.candidates=[];}
          if(['backend_login_required','admission_expired','invalid_record','request_reused','target_mismatch'].includes(error.message)||[401,403].includes(error.status))s.delivery_enabled=false;
          if(s.task&&['captcha','rate_limit','login_required'].includes(error.message)){
            s.pending_risk={task:s.task.id,lease:s.task.lease_token,...(protocol()?{executor_id}:{}),reason:error.message==='login_required'?'auth_required':'risk_paused',...(error.message==='login_required'?{}:{risk_type:error.message})};
            await save();try{await call('finish',s.pending_risk);s.pending_risk=null;s.task=null;s.phase='idle';s.candidates=[];}catch(_){}
          }
        }else if((sourceFailure||['page_timeout','invalid_content','wrong_note','invalid_count'].includes(error.message))&&!s.outbox.length){
          s.candidate_backlog=(s.candidate_backlog||[]).filter(id=>id!==s.current_id);
          s.rejected.push({task:s.task?.id,content_id:s.current_id,reason:error.message});s.phase='next';
        }
        s.next_at=this.r.now()+60000;await save();if(!s.enabled&&!s.outbox.length)await this.r.cancel();
      }
    }
    queueRecord(s){if(s.pending_record){s.outbox.push({...s.pending_record,delivery_attempts:0});s.pending_record=null;}s.phase=s.task?.target_kind==='creator'?'next':'finish';}
    checkPage(page,s){if(page?.gate)throw new Error(page.gate);if(['source_not_found','source_private','source_deleted'].includes(page?.unavailable))throw new Error(page.unavailable);if(!page?.ready&&this.r.now()>=s.deadline)throw new Error(page?.reason==='navigation_uncommitted'?'navigation_uncommitted':'page_timeout');}
  }
  root.CrowdKOL={Agent,targetURL,validateRecord,initial,mergeComments};
})(globalThis);
