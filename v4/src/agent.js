/* Alarm driven: each transition is durable; no long timers in a service worker. */
(function (root) {
  'use strict';
  const C = root.CrowdCore;
  class CrowdAgent {
    constructor(runtime, api) { this.r = runtime; this.api = api; this.active = null; this.generation = 0; this.recover = false; }
    async read() {
      await this.initializeGeneration();
      const owner=await this.r.owner?.();
      const s = {...C.initial(), ...await this.r.storage.get('agent')};
      if(this.r.owner && owner!==await this.r.owner())throw Error('cancelled');
      if(this.r.owner)s.owner_id=owner;
      // Old next_at remains authoritative. Only new navigations create a page wait.
      if (s.timing_version !== 1) {s.timing_version=1;s.wait_kind='legacy';s.retry_at=0;s.action_not_before=0;}
      s.run_generation = this.generation;
      return s;
    }
    async initializeGeneration() {
      const owner=this.r.owner ? await this.r.owner() : 'standalone';
      if(this.generationOwner!==owner || !this.initializing) {
        this.generationOwner=owner;
        this.initializing=(async()=>{
          const s=await this.r.storage.get('agent');
          if(this.r.owner && owner!==await this.r.owner())throw Error('cancelled');
          this.generation=Math.max(this.generation,s?.run_generation||0);
        })();
      }
      await this.initializing;
    }
    async save(s, stopping = false) {
      await this.initializeGeneration();
      const snapshot=JSON.parse(JSON.stringify(s));snapshot.run_generation ??= this.generation;
      if(this.r.owner && !Object.hasOwn(snapshot,'owner_id'))snapshot.owner_id=await this.r.owner();
      const pending=(this.writeTail||Promise.resolve()).catch(()=>{}).then(async()=>{
        if((this.stopping && !stopping) || snapshot.run_generation!==this.generation)throw Error('cancelled');
        if(this.r.owner && snapshot.owner_id!==await this.r.owner())throw Error('cancelled');
        await this.r.storage.set('agent',snapshot);
      });this.writeTail=pending;return pending;
    }
    async pageReady(target, keyword) {
      const s = await this.read();
      if (!s.enabled || s.wait_kind !== 'page' || s.last_error && !['page_loading','body_pending','content_unavailable','probe_timeout'].includes(s.last_error)) return;
      if (s.phase === 'search' ? keyword !== s.task?.query : target !== s.note_id) return;
      this.readyPending = {generation:this.generation,target,keyword};
      if (this.active) return;
      return this.tick();
    }
    supplementGrant(value) {
      const g=value?.acceptance_supplement,keys=['schema','id','task_id','installation_id','baseline_received','extra_limit','remaining','expires_at'];
      const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
      return g&&typeof g==='object'&&!Array.isArray(g)&&Object.keys(g).length===keys.length&&keys.every(k=>Object.hasOwn(g,k))&&g.schema==='crowd-acceptance-extra1-v1'&&uuid(g.id)&&[19,20].includes(g.task_id)&&uuid(g.installation_id)&&g.baseline_received===2&&g.extra_limit===1&&g.remaining===1&&typeof g.expires_at==='string'&&Number.isFinite(Date.parse(g.expires_at))&&Date.parse(g.expires_at)>this.r.now()?g:null;
    }
    async acceptSupplement(s,value,alive) {
      const g=this.supplementGrant(value);if(!g||value.pilot_phase!=='awaiting_acceptance'||value.reason!==null||value.allowed!==true||value.paused!==false||(!['test_completed','control_unavailable'].includes(s.last_error)||s.pilot_waiting!==true)||s.pilot_phase!=='awaiting_acceptance'||s.received!==2||s.task||this.recoveryUnsafe(s)||s.acceptance_supplement?.id===g.id)return false;
      const owner=await this.r.owner?.(),node=await this.r.storage.get('node-monitor:'+owner),expected=await this.r.expectedPrincipal?.();alive();
      if(!owner||owner!==s.owner_id||node?.installation_id!==g.installation_id||!/^[a-f0-9]{64}$/.test(expected||''))return false;
      const health=await this.r.sourceHealth?.('xiaohongshu');alive();
      if(Date.parse(g.expires_at)<=this.r.now()||(await this.r.storage.get('node-monitor:'+owner))?.installation_id!==g.installation_id||owner!==await this.r.owner?.()||expected!==await this.r.expectedPrincipal?.()||health?.status!=='authenticated'||health.expected_ref!==expected||health.observed_ref!==expected||!Number.isSafeInteger(health.checked_at)||this.r.now()<health.checked_at||this.r.now()-health.checked_at>120000)return false;
      if(!this.r.retireSupplementPage)return false;
      await this.r.retireSupplementPage(async()=>{alive();return owner===await this.r.owner?.()&&!this.stopping&&!this.maintenance;});alive();
      s.acceptance_supplement={...g,state:'admitted',baseline_history:[...s.history],admitted_at:this.r.now()};
      s.enabled=true;s.delivery_enabled=true;s.pilot_waiting=false;delete s.pilot_check_pending;s.assignment_refresh=true;s.next_at=this.r.now();s.wait_kind=null;s.last_error=null;return true;
    }
    async checkAcceptanceSupplement(valid) {
      await this.initializeGeneration();if(this.active||this.stopping||this.maintenance)return false;
      const generation=this.generation,stop=this.stopIntent||0;
      const alive=()=>{if(generation!==this.generation||stop!==(this.stopIntent||0))throw Error('cancelled');};
      this.active=(async()=>{
        const s=await this.read();if(!await valid())return false;
        if(s.consent!==C.CONSENT||(!['test_completed','control_unavailable'].includes(s.last_error)||s.pilot_waiting!==true)||s.pilot_phase!=='awaiting_acceptance'||s.received!==2||s.task||this.recoveryUnsafe(s)||s.acceptance_supplement?.state==='consumed')return false;
        if(Number.isFinite(s.supplement_checked_at)&&this.r.now()>=s.supplement_checked_at&&this.r.now()-s.supplement_checked_at<60000)return false;
        s.supplement_checked_at=this.r.now();await this.save(s);alive();
        try{await this.control(s,'control',alive);alive();if(!await valid())return false;await this.save(s);if(s.acceptance_supplement?.state==='admitted')await this.schedule(s,this.r.now()+1000);return s.acceptance_supplement?.state==='admitted';}
        catch(error){alive();return false;}
      })().finally(()=>{this.active=null;});return this.active;
    }
    async parkPilot(s, value, alive = ()=>{}) {
      if(value?.error!=='test_completed'||value.pilot_phase!=='awaiting_acceptance')return false;
      s.pilot_phase='awaiting_acceptance';s.pilot_waiting=true;delete s.pilot_check_pending;
      s.pilot_checked_at=this.r.now();s.last_error='test_completed';s.next_at=this.r.now()+60000;
      s.wait_kind='action';s.control=null;s.control_expires=0;
      await this.save(s);alive();if(s.enabled)await this.schedule(s,s.next_at);return true;
    }
    recoveryUnsafe(s) {
      return !!(s.test_run||s.outbox?.length||s.work_slots?.length||s.pending_batch||s.pending_observation_batch||s.enrichment?.sdk_pending||s.sdk_pending||s.sdk_unknown||s.risk_report||s.pending_risk||['backend_login_required','backend_permission_denied'].includes(s.delivery_error));
    }
    async finishAcknowledgedTask(s, alive = ()=>{}, signal) {
      const t=s.task;
      if(!this.r.recoveryPages||!t||this.recoveryUnsafe(s)||!(t.target>0&&t.received>=t.target)||t.comments_capture===true||t.structured_capture===true||t.repair_only||t.repair_notes?.length)return false;
      let mark=s.task_closure;
      if(mark&&mark.stage!=='acknowledged'&&(mark.task_id!==t.id||mark.lease!==t.lease_token))throw Error('task_reconciliation_required');
      if(mark?.stage==='pending'&&this.r.now()<mark.retry_at)return false;
      if(!mark||mark.stage==='acknowledged'){
        const snapshot={};for(const key of ['task','phase','enrichment','note_id','note_url','candidates','seen','search_round','api_capture_ledger'])snapshot[key]=s[key]??null;
        mark=s.task_closure={stage:'pending',task_id:t.id,lease:t.lease_token,snapshot,created_at:this.r.now()};
      }
      // finish is idempotent for this exact owner/task/lease. An unknown reply may
      // retry only this closure; it never creates a new assignment or source action.
      mark.retry_at=this.r.now()+60000;await this.save(s);alive();
      let result;try{result=await this.api.rpc('finish',{p_task:t.id,p_lease:t.lease_token},signal);alive();}
      catch(error){alive();if(error.status===401||error.status===403)throw error;mark.error='finish_unknown';await this.save(s);return false;}
      if(result?.status!=='complete'||!Number.isSafeInteger(result.received)||result.received<t.target||result.error){mark.error=result?.error==='lease_lost'?'lease_lost':'task_reconciliation_required';await this.save(s);return false;}
      const archived={...mark.snapshot,closed_at:this.r.now(),receipt:{status:result.status,received:result.received,available_at:result.available_at??null},enrichment_result:mark.snapshot.enrichment?'partial_archived':'not_requested'};
      s.task_archives||=[];const previous=s.task_archives.find(a=>a.task?.id===t.id&&a.task?.lease_token===t.lease_token);
      if(previous){for(const key of Object.keys(mark.snapshot))if(JSON.stringify(previous[key])!==JSON.stringify(mark.snapshot[key]))throw Error('task_archive_conflict');}
      else s.task_archives.push(archived);
      s.task_closure={stage:'acknowledged',task_id:t.id,lease:t.lease_token,received:result.received,closed_at:this.r.now()};
      s.task=null;s.enrichment=null;s.note_id=null;s.note_url=null;s.phase='idle';s.candidates=[];s.seen=[];s.search_round=0;delete s.platform_resume_task;
      await this.save(s);alive();return true;
    }
    async reconcileCompletedTask(valid) {
      await this.initializeGeneration();if(this.active||this.stopping||this.maintenance)return false;
      const generation=this.generation,stop=this.stopIntent||0,alive=()=>{if(generation!==this.generation||stop!==(this.stopIntent||0))throw Error('cancelled');};
      const check=async()=>{alive();if(!await valid())throw Error('cancelled');};
      this.active=(async()=>{
        const s=await this.read();await check();
        if(s.consent!==C.CONSENT||this.recoveryUnsafe(s)||['backend_login_required','backend_permission_denied','captcha','rate_limit','user_stopped'].includes(s.last_error))return false;
        const full=s.task?.target>0&&s.task.received>=s.task.target&&!s.task.comments_capture&&!s.task.structured_capture&&!s.task.repair_only&&!s.task.repair_notes?.length;
        if(!full&&!s.acceptance_reconcile)return false;
        if(s.acceptance_reconcile_at&&this.r.now()<s.acceptance_reconcile_at+60000)return false;
        s.acceptance_reconcile=true;s.acceptance_reconcile_at=this.r.now();s.enabled=false;await this.save(s);await check();
        const status=await this.api.rpc('status');await check();if(status.participant?.status!=='approved')throw Error('approval_required');
        if(full){await this.finishAcknowledgedTask(s,alive);await check();if(s.task)return false;}
        const control=await this.control(s,'control',alive);await check();
        if(control.reason==='test_completed'&&control.pilot_phase==='awaiting_acceptance'){
          s.enabled=true;s.delivery_enabled=true;s.acceptance_reconcile=false;await this.save(s);await this.schedule(s,this.r.now()+60000);return true;
        }
        if(control.pilot_phase==='active'&&!control.paused&&!control.reason){s.acceptance_reconcile=false;s.enabled=false;s.last_error='identity_verification_required';await this.save(s);return true;}
        await this.save(s);return false;
      })().finally(()=>{this.active=null;});return this.active;
    }
    async recoverLoginPage(valid,{manual=false,confirm=false}={}) {
      await this.initializeGeneration();if(this.active||this.stopping||this.maintenance)throw Error('executor_busy');
      const generation=this.generation,stopIntent=this.stopIntent||0,owner=this.generationOwner;
      const check=async()=>{if(generation!==this.generation||stopIntent!==(this.stopIntent||0)||owner!==(await this.r.owner?.()||'standalone')||!await valid())throw Error('cancelled');};
      const alive=()=>{if(generation!==this.generation||stopIntent!==(this.stopIntent||0))throw Error('cancelled');};
      this.controller=new AbortController();const signal=this.controller.signal;
      this.active=(async()=>{
        const s=await this.read();await check();
        if(s.consent!==C.CONSENT)throw Error('consent_required');
        if(this.recoveryUnsafe(s))throw Error('task_reconciliation_required');
        const expected=await this.r.expectedPrincipal?.();if(!/^[a-f0-9]{64}$/.test(expected||''))throw Error('identity_verification_required');
        let m=s.verification_page;
        if(confirm){
          if(!m||m.stage!=='opened'||m.expected_ref!==expected)throw Error('verification_page_unknown');
          const page=await this.r.verifyPage(m.slot);await check();
          if(page?.status!=='authenticated'||page.principal_ref!==expected)throw Error(page?.status==='authenticated'?'platform_identity_changed':page?.reason||'identity_verification_required');
          if(!m.manual){
            if(!s.task||s.task.id!==m.task_id||s.task.lease_token!==m.lease||Date.parse(s.task.lease_until)<=this.r.now())throw Error('lease_lost');
            await this.r.adoptVerification(m.slot,valid);await check();s.phase='search';s.page_deadline=this.r.now()+180000;s.wait_kind='page';s.next_at=this.r.now()+1000;s.assignment_refresh=false;
          }
          m.stage='confirmed';m.confirmed_at=this.r.now();await this.save(s);return {confirmed:true,manual:m.manual};
        }
        // Only known opened/confirmed pages can advance generations; an unknown
        // creation still needs reconciliation and must never open a second page.
        if(m&&['opened','confirmed'].includes(m.stage)&&this.r.verificationCurrent&&!await this.r.verificationCurrent(m.slot)){
          await check();if(m.expected_ref!==expected)throw Error('platform_identity_changed');
          s.verification_history||=[];s.verification_history.push({...m,retired_at:this.r.now(),retired_reason:'browser_generation_changed'});m=null;
        }
        if(m?.stage==='confirmed'&&m.manual&&!manual){
          // A manually opened home page is not a task search. Preserve its proof
          // and allocate a separately admitted page only after the experiment starts.
          s.verification_history||=[];s.verification_history.push(m);m=null;
        }
        if(m){
          if(m.expected_ref!==expected)throw Error('platform_identity_changed');
          if(['opened','confirmed'].includes(m.stage)){if(manual)await this.r.focusVerification?.(m.slot);return {opened:true,confirmed:m.stage==='confirmed',manual:m.manual};}
          if(['claiming','admitting','opening'].includes(m.stage))throw Error('verification_page_unknown');
          if(m.stage==='blocked')throw Error(m.reason||'verification_page_unknown');
          if(m.retry_at>this.r.now())return {waiting:true,reason:m.reason,retry_at:m.retry_at};
        }
        if(!manual&&s.pilot_phase!=='active')return {waiting:true,reason:'test_completed'};
        if(!manual){s.enabled=false;s.last_error='identity_verification_required';await this.save(s);await check();}
        if(!m){m=s.verification_page={stage:'intent',slot:'verify-'+this.r.uuid(),manual,expected_ref:expected,created_at:this.r.now()};await this.save(s);await check();}
        const status=await this.api.rpc('status',{},signal);await check();if(status.participant?.status!=='approved')throw Error('approval_required');
        const control=await this.control(s,'control',alive,signal);await check();await this.save(s);
        const wait=async value=>{m.stage='waiting';m.reason=value.reason;m.retry_at=this.r.now()+Math.max(1000,value.wait_ms||60000);await this.save(s);return {waiting:true,reason:m.reason,retry_at:m.retry_at};};
        if(manual){
          if(control.reason&&!['test_completed','daily_quota','task_full','session_rest','action_gap','global_pause'].includes(control.reason))throw Error(control.reason);
        }else{
          if(control.pilot_phase!=='active')return await wait({reason:control.reason||'test_completed',wait_ms:60000});
          if(control.paused||control.reason)return await wait(control);
          if(s.task&&s.task.received>=s.task.target){await this.finishAcknowledgedTask(s,alive,signal);await check();}
          if(s.task&&(s.enrichment||s.note_id||s.note_url||!['idle','search'].includes(s.phase)||s.task.received>0||Date.parse(s.task.lease_until)<=this.r.now()))throw Error('task_reconciliation_required');
          if(!s.task){
            if(s.enrichment||s.note_id||s.note_url||!['idle','search'].includes(s.phase))throw Error('task_reconciliation_required');
            m.stage='claiming';await this.save(s);await check();
            const claimed=await this.api.rpc('claim',{p_task:null},signal);await check();
            if(await this.parkPilot(s,claimed,alive)){m.stage='waiting';m.reason='test_completed';m.retry_at=this.r.now()+60000;await this.save(s);return {waiting:true,reason:m.reason,retry_at:m.retry_at};}
            if(claimed?.error){m.stage='blocked';m.reason=claimed.error;await this.save(s);throw Error(claimed.error);}
            if(!claimed?.task){m.stage='waiting';m.reason='no_task';m.retry_at=this.r.now()+60000;await this.save(s);return {waiting:true,reason:m.reason,retry_at:m.retry_at};}
            const t=claimed.task;m.claimed_task=t;await this.save(s);await check();
            if(!Number.isSafeInteger(t.id)||!t.lease_token||!(Date.parse(t.lease_until)>this.r.now())||t.received!==0||!(t.target>0)||C.taskPlatform(t).id!=='xiaohongshu'||typeof t.query!=='string'||!t.query.trim())throw Error('task_reconciliation_required');
            s.task=t;s.assignment_refresh=false;await this.save(s);await check();
          }
          m.task_id=s.task.id;m.lease=s.task.lease_token;m.stage='admitting';await this.save(s);await check();
          const admission=await this.control(s,'search',alive,signal);await check();
          if(!admission.allowed||admission.paused){if(['session_rest','action_gap','global_pause','test_completed','daily_quota','task_full'].includes(admission.reason))return await wait(admission);m.stage='blocked';m.reason=admission.reason||'control_unavailable';await this.save(s);throw Error(m.reason);}
        }
        m.stage='opening';delete m.reason;delete m.retry_at;await this.save(s);await check();
        await this.r.openVerification(manual?C.HOST+'/':C.taskPlatform(s.task).searchURL(s.task.query),m.slot,manual,valid);await check();
        m.stage='opened';m.opened_at=this.r.now();await this.save(s);return {opened:true,manual};
      })().finally(()=>{this.active=null;});return this.active;
    }
    async control(s, action, alive, signal, note = null) {
      const before = this.r.now();
      let value;const metrics=this.r.localTest===true&&s.test_run?.state==='active'?{}:null;
      try { value = await this.api.rpc('guard', {p_action: action, p_task: s.task?.id || null, p_note: note}, signal,metrics); }
      catch (error) { if (error.status === 401 || error.status === 403) throw error; throw new Error('control_unavailable'); }
      finally{
        if(metrics){
          metrics.control_total_ms=Math.max(0,this.r.now()-before);
          const bucket=action==='control'?'control':'source',all=s.test_run.api_timing ||= {version:1},summary=all[bucket] ||= {calls:0,stages:{}};
          if(summary.calls<10000){summary.calls++;
            for(const key of ['session_read_ms','session_ms','refresh_ms','fetch_ms','json_ms','request_ms','rpc_ms','trace_before_ms','trace_after_ms','wrapper_ms','control_total_ms']){
              const value=metrics[key];if(!Number.isSafeInteger(value)||value<0||value>1000000)continue;
              const stage=summary.stages[key] ||= {count:0,sum_ms:0,max_ms:0};stage.count++;stage.sum_ms+=value;stage.max_ms=Math.max(stage.max_ms,value);
            }
          }
        }
      }
      alive();
      if(['awaiting_acceptance','active','closed'].includes(value?.pilot_phase))s.pilot_phase=value.pilot_phase;
      const terminal=value?.pilot_phase==='closed' && ['control','search','detail','comment','scroll'].includes(action)?'user_stopped':value?.error || (value?.allowed===false ? value.reason : null);
      if(['task_full','daily_quota','test_completed','user_stopped'].includes(terminal)) {
        if(await this.parkPilot(s,{error:terminal,pilot_phase:value.pilot_phase},alive))return {...value,allowed:false,paused:false,reason:terminal};
        s.last_error=terminal;
        if(terminal==='task_full') {s.assignment_refresh=true;s.next_at=this.r.now()+1000;}
        else if(terminal==='daily_quota') {s.assignment_refresh=true;s.next_at=C.quotaRetry(value,this.r.now());}
        else {s.delivery_enabled=s.delivery_enabled||s.enabled;s.enabled=false;await this.r.cancel();}
        s.wait_kind=terminal==='daily_quota'?'budget':'action';s.control=null;s.control_expires=0;
        await this.save(s);alive();if(!s.enabled)await this.repairDelivery();return {...value,allowed:false,paused:false,reason:terminal};
      }
      if (value?.error) throw new Error(value.error);
      // A broken/older backend cannot silently disable limits. No offline page actions.
      const scoped=s.test_run?.task_ids?.includes(s.task?.id) && JSON.stringify(s.task.acceptance_task_ids)===JSON.stringify(s.test_run.task_ids);
      const configuredCap=s.task?.daily_comment_cap, configuredGap=s.task?.action_gap_milliseconds;
      const ids=s.task?.acceptance_task_ids;
      const controlRefresh=this.r.localTest===true&&action==='control'&&Array.isArray(ids)&&ids.length>=1&&ids.length<=4&&new Set(ids).size===ids.length&&ids.every(id=>Number.isSafeInteger(id)&&id>0)&&ids.includes(s.task.id);
      const extendedComments=(scoped||controlRefresh) && Number.isSafeInteger(configuredCap) && configuredCap>=1 && configuredCap<=1000;
      const minimumGap=(scoped||controlRefresh) && Number.isSafeInteger(configuredGap) && configuredGap>=250 && configuredGap<=30000?configuredGap:1000;
      const caps = {search:30, detail:60, comment:extendedComments?Math.max(120,configuredCap):120, scroll:120};
      if (!value || !Number.isSafeInteger(value.version) || value.version < 1 ||
        !Number.isSafeInteger(value.ttl_ms) || value.ttl_ms < 1 || value.ttl_ms > 600000 ||
        typeof value.paused !== 'boolean' || typeof value.allowed !== 'boolean' || (value.allowed && (value.paused || value.reason !== null)) ||
        !Number.isFinite(value.wait_ms) || value.wait_ms < 0 || value.wait_ms > 172800000 ||
        !Number.isFinite(value.gap_ms) || value.gap_ms < minimumGap || value.gap_ms > 3600000 ||
        (value.action_wait_ms != null && (!Number.isFinite(value.action_wait_ms) || value.action_wait_ms < 0 || value.action_wait_ms > 172800000)) ||
        Object.entries(caps).some(([key,max]) => !Number.isInteger(value.caps?.[key]) || value.caps[key] < 1 || value.caps[key] > max || !Number.isInteger(value.counts?.[key]) || value.counts[key] < 0) ||
        (s.control && value.version < s.control.version) || this.r.now() - before > 30000 || this.r.now() < before)
        throw new Error('control_unavailable');
      const idleRepair=this.r.localTest===true && scoped && s.enabled && s.task?.repair_only && ['waiting','active'].includes(s.test_run?.state) && s.phase==='idle' &&
        !s.outbox.length && !s.work_slots?.length && !s.enrichment && ['search','detail','comment'].every(key=>value.counts[key]<value.caps[key]);
      // A current server-clear retires a stale lab action wait; source risk waits remain.
      if((this.r.localTest === true || ['action_gap','session_rest','global_pause'].includes(s.last_error)) && (s.wait_kind === 'action' || idleRepair) && !s.pending_risk && !['captcha','rate_limit'].includes(s.last_error) && value.reason === null && !value.paused) {
        s.next_at=this.r.now();s.action_not_before=0;s.wait_kind=null;s.last_error=null;if(idleRepair)s.retry_at=0;
      }
      // The next attempt remains server-admitted; do not add its RPC latency to the server's interval again.
      if(value.action_wait_ms != null && value.allowed) s.action_not_before=Math.max(this.r.now(),before+value.action_wait_ms);
      // Action guards may return the legacy default; only control refreshes task rules.
      if(action!=='control') value.relevance_revision=Math.max(value.relevance_revision||0,s.task?.relevance_revision||0,s.control_task===s.task?.id?s.control?.relevance_revision||0:0);
      if(this.r.localTest===true&&value.recovery_enabled===true&&value.reason==='rate_limit'&&Number.isSafeInteger(value.recovery_wait_ms)&&value.recovery_wait_ms>=0&&value.recovery_wait_ms<=172800000){s.next_at=this.r.now()+value.recovery_wait_ms;}
      if((s.pilot_waiting===true||s.pilot_check_pending===true) && action==='control' && value.pilot_phase==='active' && value.reason===null && !value.paused && !s.pending_risk) {
        s.pilot_waiting=false;delete s.pilot_check_pending;s.assignment_refresh=true;s.next_at=this.r.now();s.wait_kind=null;s.last_error=null;
      }
      if(action==='control')await this.acceptSupplement(s,value,alive);
      s.control = value; s.control_task=s.task?.id || null; s.control_checked = this.r.now(); s.control_expires = before + value.ttl_ms;
      s.control_error = false;
      if (['captcha','rate_limit'].includes(action)) s.pending_risk = null;
      return value;
    }
    assertTest(s) {
      if(s.test_run && ['waiting','active'].includes(s.test_run.state) && this.r.now()>=s.test_run.expires_at) throw Error('test_expired');
    }
    async admit(s, action, alive, signal, note = null) {
      this.assertTest(s);
      this.assertTest(s);await this.r.sourceHealth?.(s.task?.platform||'xiaohongshu');alive();
      const value = await this.control(s, action, alive, signal, note);
      this.assertTest(s);
      if(['task_full','daily_quota','test_completed','user_stopped'].includes(value.reason)) {if(s.enabled)await this.schedule(s,s.next_at);return false;}
      if (!value.allowed || value.paused) {
        s.last_error = value.reason || 'control_unavailable';
        s.next_at = this.r.now() + Math.max(1000, value.wait_ms);
        s.wait_kind = 'action'; s.action_not_before = s.next_at;
        await this.save(s); await this.schedule(s,s.next_at); return false;
      }
      // The server has already charged this attempt, even if open/probe later fails.
      s.last_error = null; await this.save(s); alive(); return true;
    }
    async preferences() {
      const owner = await this.r.owner?.() || 'standalone';
      const value = await this.r.storage.get('agent-settings:' + owner);
      return value?.owner === owner && [1,2].includes(value.parallelism) ? value : null;
    }
    async requestParallelism(value) {
      await this.initializeGeneration();const owner=this.generationOwner,generation=this.generation;
      if (![1,2].includes(value) || value === 2 && !await this.r.poolAllowed?.()) throw Error('parallel_unavailable');
      if(generation!==this.generation || owner!==(await this.r.owner?.() || 'standalone'))throw Error('cancelled');
      await this.r.storage.set('agent-settings:' + owner, {owner,parallelism:value});
      // Preference IO never rewrites the actor's live state or its evidence queue.
      if (!this.active && !this.stopping && !this.maintenance) {
        this.active = (async()=>{const s=await this.read();await this.applyPreferences(s);})().finally(()=>{this.active=null;});
        await this.active;
      }
    }
    async applyPreferences(s) {
      if (s.outbox.length || s.work_slots?.length || s.enrichment || s.enabled && !['idle','search_done'].includes(s.phase)) return;
      const value=await this.preferences();
      if (value && value.parallelism !== (s.parallelism || 1)) {
        if (value.parallelism === 2 && !await this.r.poolAllowed?.()) return;
        s.parallelism=value.parallelism;await this.save(s);
      }
    }
    async schedule(s, at, replace = false) {
      if(s.test_run && ['waiting','active'].includes(s.test_run.state)) at=Math.min(at,s.test_run.expires_at);
      if(s.wait_kind==='action') {
        const now=this.r.now(),recheck=(s.control_checked||now)+30000;
        at=Math.min(at,recheck>now?recheck:now+30000);
      }
      return this.r.schedule(at,replace);
    }
    testGoal(s) {return s.test_run?.goal ?? 2;}
    claimTask(s) {return (s.acceptance_supplement?.state==='admitted'?s.acceptance_supplement.task_id:null) || s.task?.id || s.test_run?.task_ids?.find(id=>!s.test_run.finished_tasks?.includes(id)) || null;}
    bindBatch(s,task,expected=null) {
      if(!s.test_run)return true;
      const ids=task?.acceptance_task_ids;
      if(ids!=null) {
        if(!Array.isArray(ids) || ids.length<1 || ids.length>4 || new Set(ids).size!==ids.length || ids.some(id=>!Number.isSafeInteger(id)||id<1) || !ids.includes(task.id))return false;
        s.test_run.task_ids ||= ids.slice();
      }
      const valid=!s.test_run.task_ids || !!task && JSON.stringify(ids)===JSON.stringify(s.test_run.task_ids) && s.test_run.task_ids.includes(task.id) && !s.test_run.finished_tasks?.includes(task.id) && (expected===null || task.id===expected);
      if(valid&&s.test_run.state==='active'&&s.test_run.goal===0&&!task?.repair_only&&!s.test_run.finished_tasks?.length)return false;
      if(valid&&s.test_run.state==='active'&&s.test_run.goal===0&&s.test_run.finished_tasks?.length&&!task?.repair_only&&Number.isInteger(task?.acceptance_goal)&&task.acceptance_goal>=1&&task.acceptance_goal<=4){
        if(s.outbox.length||s.work_slots?.length||s.enrichment)return false;
        if(s.test_run.attempts+task.acceptance_goal*2>8||s.test_run.accepted.length+task.acceptance_goal>4)return false;
        s.test_run.goal=s.test_run.accepted.length+task.acceptance_goal;s.test_run.limit=s.test_run.attempts+task.acceptance_goal*2;
      }
      return valid;
    }
    batchContinues(s) {return s.test_run?.state==='active' && s.test_run.task_ids?.length>1 && (s.test_run.goal===0 ? s.test_run.task_ids.some(id=>id!==s.task?.id && !s.test_run.finished_tasks?.includes(id)) : s.test_run.accepted.length<this.testGoal(s));}
    testResult(s) {
      const completeAPI=this.r.experimentalAPIEarlyFinish===true && this.r.localTest===true &&
        s.owner_id==='7033ff0c-65d7-4963-b65c-a4ac9e31f03a' && s.enabled===true && s.test_run?.state==='active' && !!s.test_run.id && !s.outbox?.length &&
        s.task?.structured_capture===true && Date.parse(s.task.lease_until)>this.r.now() && !s.pending_risk && !s.control?.paused &&
        !['sending','unknown'].includes(s.risk_report?.state) &&
        !['captcha','rate_limit','login_required','backend_login_required'].includes(s.last_error) &&
        !s.comment_validation_failed && !!s.comment_coverage?.length && s.comment_coverage.every(c=>c.complete ||
          c.capture_reason==='api_graph_closed_dom_subset' && s.api_capture_ledger?.some(l=>
            l.parent===c.parent && l.owner===s.owner_id && l.test===s.test_run.id && l.task===s.task?.id &&
            l.note===c.note_id && l.lease===s.task?.lease_token && this.experimentalLedgerComplete(l)));
      return s.comment_failures || s.comment_partial&&!completeAPI || s.structured_partial ||
        (s.task?.repair_notes||[]).some(n=>!s.repaired?.includes(n.parent))?'test_comments_partial':'test_completed';
    }
    experimentalLedgerComplete(l) {
      const uuid=v=>typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
      if(!l || !uuid(l.run) || !uuid(l.parent) || !uuid(l.body_request) || !uuid(l.body_run) ||
        l.confirmed_parent!==l.parent || !l.body_ack || !Array.isArray(l.pages) || l.pages.length<1 || l.pages.length>200)return false;
      const b=l.body_ack;
      if(b.request!==l.body_request || b.run!==l.body_run || b.page!==0 || b.source!=='page_hydration' ||
        b.note!==l.note || b.parent!==l.parent || b.task!==l.task || b.lease!==l.lease || b.reward_eligible!==false)return false;
      return new Set(l.pages.map(p=>p.request)).size===l.pages.length && new Set(l.pages.map(p=>p.page)).size===l.pages.length &&
        l.pages.every(p=>uuid(p.request) && p.total===l.pages.length && Number.isInteger(p.page) && p.page>=0 && p.page<l.pages.length &&
          p.acked_request===p.request && p.acked_run===l.run && p.acked_page===p.page && p.acked_source==='page_response' &&
          p.acked_parent===l.parent && p.acked_note===l.note && p.acked_task===l.task && p.acked_lease===l.lease && p.acked_reward_eligible===false);
    }
    acknowledgeExperimentalAPI(s,item,receipt) {
      if(this.r.experimentalAPIEarlyFinish!==true || item.kind!=='structured' || receipt?.gate!=='observed')return;
      const l=s.api_capture_ledger?.find(l=>l.parent===item.parent && l.owner===s.owner_id && l.test===s.test_run?.id &&
        l.task===item.task && l.lease===item.lease && l.note===item.record.note_id);
      if(!l)return;
      if(item.record.kind==='body' && l.body_request===item.request && l.body_run===receipt.run) {
        l.body_ack={request:receipt.request,run:receipt.run,page:receipt.page,source:receipt.source,reward_eligible:receipt.reward_eligible,
          parent:item.parent,note:item.record.note_id,task:item.task,lease:item.lease};
      }
      if(item.record.kind==='comments' && item.record.run===l.run) {
        const p=l.pages.find(p=>p.request===item.request && p.page===item.record.page && p.total===item.record.total);
        if(p){Object.assign(p,{acked_request:receipt.request,acked_run:receipt.run,acked_page:receipt.page,acked_source:receipt.source,
          acked_reward_eligible:receipt.reward_eligible,acked_parent:item.parent,acked_note:item.record.note_id,acked_task:item.task,acked_lease:item.lease});
          // The existing receiver checks the accepted original parent proof before returning observed.
          l.confirmed_parent=item.parent;}
      }
      l.complete=this.experimentalLedgerComplete(l);
    }
    testRemaining(s) {
      if (!s.test_run || !['waiting','active'].includes(s.test_run.state)) return s.test_run ? 0 : Infinity;
      const inflight = (s.work_slots || []).filter(slot => slot.phase !== 'done' && !slot.base_received).length;
      return s.test_run.state === 'waiting' ? 0 : Math.max(0, Math.min(s.test_run.limit-s.test_run.attempts, this.testGoal(s)-s.test_run.accepted.length-inflight));
    }
    async endTest(s, reason, {drain = true} = {}) {
      s.test_run.state=reason==='test_completed'?'complete':'stopped';
      s.test_run.reason=reason;s.test_run.ended_at=this.r.now();
      s.enabled=false;s.delivery_enabled=drain;s.last_error=reason;
      if(!drain)s.delivery_error=reason;
      await this.save(s);
      // Stop waits for the writer. Defer cleanup until tick releases that writer.
      this.testStop={generation:this.generation,reason,drain,keepPage:!drain};
    }
    async start(test = false, {valid = async()=>true, resumePlatform = false, resumeInitial = false} = {}) {
      const stopIntent=this.stopIntent || 0,requested=valid;
      valid=async()=>stopIntent===(this.stopIntent || 0) && await requested();
      test = test || this.r.localTest === true;
      await this.initializeGeneration();
      if(!await valid())throw Error('cancelled');
      const owner=this.generationOwner,generation=this.generation;
      if (test && !await this.r.poolAllowed?.()) throw Error('parallel_unavailable');
      if(generation!==this.generation || owner!==(await this.r.owner?.() || 'standalone'))throw Error('cancelled');
      if(this.stopping)throw Error('executor_busy');
      if (this.maintenance) throw new Error('update_in_progress');
      await this.active?.catch(() => {});
      if (this.maintenance) throw new Error('update_in_progress');
      if (generation !== this.generation || owner!==(await this.r.owner?.() || 'standalone')) throw new Error('cancelled');
      // Hold the same single-writer lock while status IO is pending.
      if (this.active) return this.start(test,{valid,resumePlatform,resumeInitial});
      const prior = await this.read();
      if(['sending','unknown'].includes(prior.sdk_pending?.status))throw Error('sdk_unknown');
      if(prior.sdk_unknown===true)throw Error('sdk_unknown');
      if(['sending','unknown'].includes(prior.risk_report?.state))throw Error('risk_report_unknown');
      if (generation !== this.generation || !await valid()) throw Error('cancelled');
      if (this.maintenance) throw Error('update_in_progress');
      if (this.stopping) throw Error('executor_busy');
      if (this.active) return this.start(test,{valid,resumePlatform,resumeInitial});
      if (test && prior.test_run && ['waiting','active'].includes(prior.test_run.state) && this.r.now() >= prior.test_run.expires_at) {
        // An explicit new test retires expired work before opening its new boundary.
        // Stop preserves original delivery UUIDs; no old page is reopened here.
        await this.stop('test_expired',{drain:true,restart:true});
        if(!await valid())throw Error('cancelled');
        return this.start(test,{valid,resumePlatform,resumeInitial});
      }
      this.active = this.activate(generation,test,valid,resumePlatform,resumeInitial).finally(() => { this.active = null;const stop=this.testStop;this.testStop=null;if(stop?.generation===this.generation)this.stop(stop.reason,{drain:stop.drain!==false,keepPage:stop.keepPage===true}).catch(()=>{}); });
      return this.active;
    }
    async activate(generation, test = false, valid = async()=>true, resumePlatform = false, resumeInitial = false) {
      const s = await this.read();
      if (s.consent !== C.CONSENT) throw new Error('consent_required');
      if(s.test_run && ['waiting','active'].includes(s.test_run.state) && this.r.now()>=s.test_run.expires_at){await this.endTest(s,'test_expired');return;}
      await this.r.sourceHealth?.(s.task?.platform||'xiaohongshu');if(generation!==this.generation || !await valid())throw new Error('cancelled');
      const status = await this.api.rpc('status');
      if (generation !== this.generation || !await valid()) throw new Error('cancelled');
      if (status.participant?.status !== 'approved') throw new Error('approval_required');
      // Refresh risk policy before allocating an automatic or explicit new batch.
      const validOwner=()=>{if(generation!==this.generation)throw Error('cancelled');};
      const admission=await this.control(s,'control',validOwner);
      if(generation!==this.generation || this.generationOwner!==(await this.r.owner?.() || 'standalone') || !await valid())throw Error('cancelled');
      if(admission.paused || admission.reason!==null){
        const parking=['task_full','daily_quota'].includes(admission.reason) || admission.reason==='test_completed'&&admission.pilot_phase==='awaiting_acceptance';
        s.enabled=parking;s.last_error=admission.reason||'control_unavailable';
        if(parking){s.delivery_enabled=true;await this.save(s);await this.schedule(s,s.next_at);}
        else{s.next_at=Math.max(s.next_at||0,this.r.now()+admission.wait_ms);if(['session_rest','action_gap','global_pause'].includes(s.last_error)){s.wait_kind='action';s.action_not_before=s.next_at;}await this.save(s);}
        return;
      }

      // Every explicit resume reconciles the assignment after durable deliveries.
      s.assignment_refresh = true;
      if(resumePlatform&&s.task){
        const empty=resumeInitial&&!s.received&&!s.note_id&&!s.note_url&&!s.enrichment&&!s.sdk_pending&&!s.sdk_unknown&&!s.risk_report&&['idle','search'].includes(s.phase)&&![s.outbox,s.rejected,s.history,s.seen,s.candidates,s.work_slots].some(a=>a?.length);
        s.platform_resume_task={id:s.task.id,lease:s.task.lease_token,allow_renewal:empty===true};
      }else delete s.platform_resume_task;
      if (test) {
        if (!s.test_run || !['waiting','active'].includes(s.test_run.state)) {
          s.comment_failures=0;s.comment_partial=false;s.structured_partial=false;s.comment_coverage=[];s.repaired=[];s.api_capture_ledger=[];s.comment_validation_failed=false;s.test_run={id:this.r.uuid(),limit:4,attempts:0,accepted:[],state:'waiting',created_at:this.r.now(),expires_at:Math.min(this.r.now()+900000,Math.floor((this.r.now()+8*3600000)/86400000)*86400000+86400000-8*3600000),day:new Date(this.r.now()+8*3600000).toISOString().slice(0,10)};
        }
        // Adding a test boundary must not restart a running page or change its UUID.
        if (s.enabled) {await this.save(s);await this.schedule(s,this.r.now()+1000);return;}
      } else if (s.test_run && !['waiting','active'].includes(s.test_run.state)) {
        // A completed/stopped bounded run never silently becomes unlimited.
        throw Error('test_new_run_required');
      }
      if (!resumePlatform) {
        // Continue retains the original enrichment checkpoint; enrich validates
        // its lease and page before performing the next action.
        if (s.phase === 'note') s.phase = 'reopen_note';
        if (s.phase === 'search') { s.phase = 'idle'; s.search_round = 0; }
      } else {
        // The same verified page resumes its checkpoint, never a second search/detail admission.
        if(['search','note','reopen_note'].includes(s.phase))s.page_deadline=this.r.now()+180000;
        if(s.phase==='note'){s.loaded_at=this.r.now();s.scrolls=0;}
      }
      s.enabled = true; s.delivery_enabled = true; s.delivery_error = null; s.last_error = null; s.page_failures = 0; s.control_checked = 0; s.last_tick = this.r.now();
      // Continuing never clears a durable deadline or a pending risk report.
      await this.save(s); await this.schedule(s,this.r.now() + 1000);
    }
    async bootstrapLoginPage(valid, resumeKnownWait = false, resumeStoppedWait = false) {
      await this.initializeGeneration();
      if(this.active||this.stopping||this.maintenance)throw Error('executor_busy');
      const generation=this.generation,stopIntent=this.stopIntent||0;
      const alive=()=>{if(generation!==this.generation||stopIntent!==(this.stopIntent||0))throw Error('cancelled');};
      const check=async()=>{alive();if(!await valid())throw Error('cancelled');};
      this.controller=new AbortController();const signal=this.controller.signal;
      this.active=(async()=>{
        const s=await this.read();await check();
        const waits=new Set(['session_rest','action_gap','global_pause']),mark=s.first_login_page;
        const stoppedWait=resumeStoppedWait&&s.last_error==='user_stopped'&&mark?.stage==='waiting'&&waits.has(mark.reason);
        const retry=resumeKnownWait&&mark?.task_id===s.task?.id&&['admitting','waiting'].includes(mark?.stage)&&(waits.has(s.last_error)||stoppedWait);
        if(s.consent!==C.CONSENT||s.enabled||!s.task||(!retry&&(!['login_required','identity_verification_required'].includes(s.last_error)||mark))||s.received||s.note_id||s.note_url||s.enrichment||s.test_run||s.sdk_unknown||s.sdk_pending||s.risk_report||s.pending_risk||!['idle','search'].includes(s.phase)||[s.outbox,s.rejected,s.history,s.seen,s.candidates,s.work_slots].some(a=>a?.length))throw Error('pool_recovery_required');
        const wait=async admission=>{
          if(!waits.has(admission.reason)||!Number.isFinite(admission.wait_ms)||admission.wait_ms<0)throw Error(admission.reason||'control_unavailable');
          const retry_at=this.r.now()+Math.max(1000,admission.wait_ms);
          s.first_login_page={stage:'waiting',task_id:s.task.id,reason:admission.reason,retry_at};
          s.enabled=false;s.last_error=admission.reason;s.next_at=Math.max(s.next_at||0,retry_at);s.wait_kind='action';s.action_not_before=s.next_at;
          await this.save(s);await check();return {waiting:true,reason:admission.reason,retry_at};
        };
        if(retry){
          // Only the explicit Continue restores intent after a user stop. The known deadline still applies.
          if(stoppedWait){s.last_error=mark.reason;await this.save(s);await check();}
          if(mark.stage==='waiting'&&Number.isFinite(mark.retry_at)&&mark.retry_at>this.r.now())return {waiting:true,reason:s.last_error,retry_at:mark.retry_at};
          // A 63 definite refusal did not persist its guard reply. Read control
          // again; never treat the old control snapshot as a source receipt.
          s.first_login_page={stage:'checking_wait',task_id:s.task.id};await this.save(s);await check();
          const current=await this.control(s,'control',alive,signal);await check();
          if(current.reason||current.paused)return wait(current);
          // control's allowed=false is expected: only search can grant a visit.
        }
        // Durable intent precedes any RPC/navigation; a crashed or unknown attempt never repeats.
        s.first_login_page={stage:'claiming',task_id:s.task.id};await this.save(s);await check();
        const status=await this.api.rpc('status',{},signal);await check();
        if(status.participant?.status!=='approved')throw Error('approval_required');
        const claimed=await this.api.rpc('claim',{p_task:s.task.id},signal);await check();
        if(claimed.error==='test_completed'&&claimed.pilot_phase==='awaiting_acceptance'){s.enabled=true;await this.parkPilot(s,claimed,alive);return {pilot_waiting:true};}
        if(claimed.error)throw Error(claimed.error);
        const task=claimed.task;
        if(task?.id!==s.task.id||task.query!==s.task.query||task.platform!==s.task.platform||task.received!==0)throw Error('lease_lost');
        s.task=task;s.first_login_page.stage='admitting';await this.save(s);await check();
        const admission=await this.control(s,'search',alive,signal);await check();
        if(!admission.allowed||admission.paused||admission.reason)return wait(admission);
        s.first_login_page.stage='opening';await this.save(s);await check();
        // Retire metadata only. An old tab ID from another browser session is never touched.
        await this.r.retireLoginPage(valid);await check();
        await this.r.open(C.taskPlatform(task).searchURL(task.query));await check();
        s.phase='search';s.search_round=0;s.page_deadline=this.r.now()+180000;s.next_at=this.r.now()+1000;s.wait_kind='page';
        s.enabled=false;s.last_error='identity_verification_required';s.first_login_page.stage='opened';
        await this.save(s);return;
      })().finally(()=>{this.active=null;});
      return this.active;
    }
    async stop(reason = 'user_stopped', options = {}) {
      if(!options.restart && !options.stoppedCheckpoint)this.stopIntent=(this.stopIntent || 0)+1;
      if(this.stopActive)return this.stopActive;
      this.stopActive=this.performStop(reason,options).finally(()=>{this.stopping=false;this.stopActive=null;});return this.stopActive;
    }
    async performStop(reason, {keepPage = false, drain = false, expectedOwner = null, stoppedCheckpoint = false} = {}) {
      const stopOwner=expectedOwner || await this.r.owner?.() || (await this.r.storage.get('session'))?.user?.id;
      const sameOwner=async()=>!stopOwner || stopOwner===(await this.r.owner?.() || (await this.r.storage.get('session'))?.user?.id);
      if(!await sameOwner())return;
      if(stoppedCheckpoint) {
        const checkpoint=await this.read();
        if(!await sameOwner())return;
        if(checkpoint.enabled || checkpoint.outbox?.length || checkpoint.work_slots?.some(slot=>slot.request && slot.base_received!==true) || this.active || this.poolJobs?.size)return;
      }
      this.stopping=true;await this.initializeGeneration();
      this.generation++; this.controller?.abort();this.readyPending=null;this.poolWake=false;this.poolResults?.clear();
      await this.writeTail?.catch(()=>{});
      if(!await sameOwner())return;
      const s = expectedOwner?{...C.initial(),...await this.r.storage.get('agent:'+expectedOwner)}:await this.read(); s.enabled = false; s.delivery_enabled = drain; s.last_error = reason;
      if(s.test_run && ['waiting','active'].includes(s.test_run.state)) {s.test_run.state='stopped';s.test_run.reason=reason;s.test_run.ended_at=this.r.now();}
      s.run_generation=this.generation;
      if(['captcha','rate_limit'].includes(reason)){s.pending_risk=reason;s.next_at=Math.max(s.next_at,this.r.now()+(reason==='rate_limit'?86400000:1800000));}
      // Optional supplements must never prevent the durable stop.
      if(expectedOwner)await this.r.storage.set('agent:'+expectedOwner,s);else await this.save(s,true);
      for(const slot of [...(s.work_slots||[]),...(this.r.localTest===true && s.enrichment?[{enrichment:s.enrichment}]:[])]) {
        const e=slot.enrichment;
        if(e?.record?.extra?.comments && !e.note_queued)this.queueCommentPages(s,e,'interrupted');
        if(e&&!e.structured_queued)this.queueStructuredPages(s,e,'interrupted');
        if(e?.record?.extra?.comments && !e.note_queued && !e.repair) {
          const item={kind:'note',request:this.r.uuid(),parent:e.parent,record:JSON.parse(JSON.stringify(e.record))};
          try {
            item.record=this.legacyCommentNote(item.record);
            C.validate(item.record);s.outbox.push(item);
          } catch(error) {s.rejected.push({...item,reason:error.message||'invalid_record'});}
          e.note_queued=true;
        }
      }
      if(expectedOwner)await this.r.storage.set('agent:'+expectedOwner,s);else await this.save(s,true);
      // A worker lost during cancellation must restart into the durable stop.
      await this.active?.catch(() => {});
      await Promise.allSettled([...(this.poolJobs?.values()||[])]);
      if(!await sameOwner())return;
      try {
        await this.r.cancel();
        if(!await sameOwner())return;
        if (!keepPage) {
          try {await this.r.close(stopOwner||expectedOwner);}catch(error){
            // A lost page must not retain live work or block its already durable outbox.
            if(await sameOwner()) {
              const failed=await this.read();failed.pool_cleanup_error=error.poolCause||'unknown';await this.save(failed,true);
            }
          }
          if(!await sameOwner())return;
          const settled=await this.read();
          if(!await sameOwner())return;
          if(this.r.localTest===true && settled.enrichment?.note_queued) {
            settled.enrichment=null;
            if(settled.phase==='enrich')settled.phase='search_done';
            await this.save(settled,true);
          }
          if(settled.work_slots?.length) {
            settled.interrupted ||= [];
            for(const slot of settled.work_slots)settled.interrupted.push({task:slot.task,note_id:slot.note_id||slot.enrichment?.record?.standard?.note_id,attempt:slot.id,request:slot.request||null,reason,action_consumed:true,outcome:slot.base_received?'base_received_supplement_stopped':slot.request?'delivery_unknown':'confirmed_abandoned'});
            settled.work_slots=[];if(settled.phase==='parallel')settled.phase='search_done';
            await this.save(settled,true);
          }
          if(settled.test_run && ['note','reopen_note','search'].includes(settled.phase)) {
            if(settled.note_id){settled.interrupted ||= [];settled.interrupted.push({task:settled.task?.id,note_id:settled.note_id,test_run_id:settled.note_test_run || null,reason,action_consumed:true,outcome:'confirmed_abandoned'});}
            // Closed, unsubmitted test pages are retired, never reopened outside the next batch's cap.
            settled.phase=settled.task && settled.candidates.length?'search_done':'idle';
            settled.note_id=null;settled.note_url=null;settled.note_test_run=null;settled.wait_kind=null;
            await this.save(settled,true);
          }
        }
      }
      finally {try {
        if(await sameOwner())await this.repairDelivery();
      }finally{this.stopping=false;}}
    }
    async tick(recover = false, deliveryOnly = false) {
      if (this.maintenance || this.stopping) return;
      await this.initializeGeneration();
      if(this.stopping)return;
      this.recover ||= recover;
      if (this.active) return this.active;
      this.controller = new AbortController();
      const gen = this.generation;
      const alive = () => { if (gen !== this.generation || this.controller.signal.aborted) throw new Error('cancelled'); };
      this.active = (async () => {
        // Drain ready local transitions under the same writer; never recurse into tick().
        for (let turns = 0; turns < 4; turns++) {
          this.poolWake=false;
          if (!await this.step(alive, this.controller.signal, deliveryOnly)) break;
        }
      })().finally(() => {
        this.active = null;
        const stop=this.testStop;this.testStop=null;
        if(stop?.generation===this.generation){this.stop(stop.reason,{drain:stop.drain!==false,keepPage:stop.keepPage===true}).catch(()=>{});return;}
        if(this.poolWake && !this.stopping){this.poolWake=false;this.tick().catch(()=>{});}
        if (this.readyPending?.generation === this.generation) {
          const pending = this.readyPending; this.readyPending = null;
          this.pageReady(pending.target,pending.keyword).catch(() => {});
        }
      });
      return this.active;
    }
    async step(alive, signal, deliveryOnly = false) {
      let s = await this.read(); const recover = this.recover; this.recover = false;
      const ready = this.readyPending; this.readyPending = null;
      if(!deliveryOnly&&(s.sdk_unknown===true||['sending','unknown'].includes(s.sdk_pending?.status))){s.sdk_unknown=true;if(s.test_run)await this.endTest(s,'sdk_unknown');else{s.enabled=false;s.last_error='sdk_unknown';await this.save(s);await this.r.cancel();}return;}
      if(!deliveryOnly&&['sending','unknown'].includes(s.risk_report?.state)){if(s.enabled){s.enabled=false;await this.save(s);}return;}
      if (!s.enabled && !(deliveryOnly && s.delivery_enabled && s.outbox.length)) return;
      if (s.consent !== C.CONSENT) { s.enabled = false; s.delivery_enabled = false; s.last_error = 'consent_required'; await this.save(s); await this.r.cancel(); await this.r.cancelDelivery?.(); return; }
      if (deliveryOnly) {
        const stoppedReason = !s.enabled ? s.last_error : null;
        let continueDelivery=false;
        try {
          alive();
          if (s.outbox.length) { continueDelivery=await this.flushOutbox(s, alive, signal); s.delivery_error = null; await this.save(s); }
        } catch (error) {
          alive();
          const auth = error.status === 401, permission = error.status === 403;
          s.delivery_error = auth ? 'backend_login_required' : permission ? 'backend_permission_denied' : error.message === 'review_local_rejections' ? error.message : 'backend_unavailable';
          if (auth || permission || error.message === 'review_local_rejections') { s.delivery_enabled = false; s.enabled = false; await this.r.cancel(); }
          if (s.outbox.length) {
            const item = s.outbox[0]; item.retries = (item.retries || 0) + 1;
            item.retry_at = this.r.now() + Math.min(900000, 60000 * 2 ** Math.min(item.retries - 1, 4));
          }
          await this.save(s);
        }
        if (stoppedReason) { s.last_error = stoppedReason; await this.save(s); }
        await this.repairDelivery(); return continueDelivery;
      }
      await this.repairDelivery();
      const now = this.r.now();
      const day = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
      if (s.day !== day) { s.day = day; s.visits = 0; }
      try {
        alive();
        if(s.test_run && ['waiting','active'].includes(s.test_run.state) && (now>=s.test_run.expires_at || day!==s.test_run.day)) {await this.endTest(s,'test_expired');return;}
        if(this.r.recoveryPages&&s.pilot_waiting&&s.pilot_phase==='awaiting_acceptance'&&s.last_error==='test_completed')await this.finishAcknowledgedTask(s,alive,signal);
        // A known pilot acceptance boundary needs cloud status, never a live platform page or a new claim.
        if(s.pilot_waiting||s.pilot_check_pending||s.pilot_phase==='awaiting_acceptance'&&s.last_error==='daily_quota'){
          if(!s.pilot_waiting)s.pilot_check_pending=true;
          if(!Number.isFinite(s.pilot_checked_at)||now<s.pilot_checked_at||now>=s.pilot_checked_at+60000){
            s.pilot_checked_at=now;await this.save(s);alive();
            try{await this.control(s,'control',alive,signal);}catch(error){
              alive();if(error.status===401||error.status===403)throw error;
              s.control_error=true;s.last_error='control_unavailable';
            }
            await this.save(s);alive();
          }
          if(!s.enabled)return;
          if(s.pilot_waiting||s.pilot_check_pending){
            if(s.outbox.length)await this.flushOutbox(s,alive,signal);
            await this.save(s);await this.schedule(s,this.r.now()+60000);return;
          }
          // Let the outer session check verify the original account before any armed source work.
          await this.schedule(s,this.r.now()+1000);return;
        }
        if(s.assignment_refresh && s.outbox.length)return await this.flushOutbox(s,alive,signal);
        if(s.assignment_refresh && s.last_error==='daily_quota' && s.next_at>now){await this.schedule(s,s.next_at);return;}
        if(s.assignment_refresh) {
          if(s.test_run?.task_ids && !this.claimTask(s)){await this.endTest(s,'test_partial');return;}
          const requested=this.claimTask(s),bound=!!s.test_run?.task_ids;
          const claimed=await this.api.rpc('claim',{p_task:requested},signal);alive();
          if(await this.parkPilot(s,claimed,alive))return;
          if(claimed.error==='daily_quota') {if(s.test_run){await this.endTest(s,'test_quota');return;}s.next_at=C.quotaRetry(claimed,now);s.last_error='daily_quota';await this.save(s);await this.schedule(s,s.next_at);return;}
          if(claimed.error)throw Error(claimed.error);
          let task=claimed.task;
          if(s.acceptance_supplement?.state==='admitted'){
            const g=this.supplementGrant(claimed),a=s.acceptance_supplement;
            if(!g||['schema','id','task_id','installation_id','baseline_received','extra_limit','expires_at'].some(k=>g[k]!==a[k])||task?.id!==g.task_id||task.received!==2||task.target!==3||task.remaining_today!==1||!['xiaohongshu','xhs',undefined].includes(task.platform))throw Error('task_reconciliation_required');
          }
          const resumed=s.platform_resume_task;
          if(resumed){
            if(task?.id!==resumed.id||task?.query!==s.task?.query||task?.platform!==s.task?.platform)throw Error('lease_lost');
            if(task.lease_token!==resumed.lease&&!resumed.allow_renewal)throw Error('pool_recovery_required');
          }
          if(!task && s.task && !s.test_run?.task_ids) {
            if(s.work_slots?.length || s.enrichment || ['note','reopen_note'].includes(s.phase))throw Error('pool_recovery_required');
            const fresh=await this.api.rpc('claim',{p_task:null},signal);alive();
            if(await this.parkPilot(s,fresh,alive))return;
            if(fresh.error==='daily_quota') {if(s.test_run){await this.endTest(s,'test_quota');return;}s.next_at=C.quotaRetry(fresh,now);s.last_error='daily_quota';await this.save(s);await this.schedule(s,s.next_at);return;}
            if(fresh.error)throw Error(fresh.error);task=fresh.task;
          }
          if(!this.bindBatch(s,task,bound?requested:null)){await this.endTest(s,'test_no_task');return;}
          if(s.task?.id!==task?.id || s.task?.lease_token!==task?.lease_token || s.task?.query!==task?.query || s.task?.platform!==task?.platform) {
            if(s.work_slots?.length || s.enrichment || ['note','reopen_note'].includes(s.phase))throw Error('pool_recovery_required');
            if(!resumed&&s.acceptance_supplement?.state!=='admitted'){s.phase='idle';s.seen=[];s.candidates=[];s.search_round=0;s.note_url=null;s.note_id=null;}
          } else if(task) {
            if(task.received<s.task.received)throw Error('backend_unavailable');
            const known=new Set(task.known_note_ids || []);
            s.candidates=s.candidates.filter(url=>!known.has(C.taskPlatform(task).noteURL(url).id) || task.repair_notes?.some(n=>n.record.standard.note_id===C.taskPlatform(task).noteURL(url).id));
          }
          s.task=task || null;s.assignment_refresh=false;delete s.platform_resume_task;
          if(s.test_run?.state==='waiting' && task?.repair_only){
            if(s.outbox.length || s.work_slots?.length || s.enrichment)throw Error('pool_recovery_required');
            s.test_run.goal=0;s.test_run.limit=0;s.phase='idle';s.seen=[];s.candidates=[];s.search_round=0;s.note_url=null;s.note_id=null;
          }
          else if(s.test_run?.state==='waiting' && Number.isInteger(task?.acceptance_goal) && task.acceptance_goal>=1 && task.acceptance_goal<=4){s.test_run.goal=task.acceptance_goal;s.test_run.limit=task.acceptance_goal*2;}await this.save(s);
          // Re-enter the normal terminal/quota checks with the refreshed snapshot.
          return true;
        }
        // Local upgrades must also retire an older unlimited run, before optional visits.
        if(this.r.localTest === true && !s.assignment_refresh && s.task && !s.task.repair_only && (!s.test_run || !s.outbox.length && !s.work_slots?.length && !s.enrichment) &&
          (s.task.received>=s.task.target && !this.batchContinues(s) || s.task.remaining_today===0 || s.test_run?.accepted.length===this.testGoal(s))) {
          s.test_run ||= {id:this.r.uuid(),limit:4,attempts:0,accepted:[],state:'waiting',created_at:now,expires_at:now,day};
          await this.endTest(s,s.test_run.accepted.length===this.testGoal(s)?this.testResult(s):'test_quota');
          if(!s.outbox.some(item=>!item.kind) && s.task.received>=s.task.target && Date.parse(s.task.lease_until)>=now+60000) {
            try {
              const finished=await this.api.rpc('finish',{p_task:s.task.id,p_lease:s.task.lease_token},signal);alive();
              if(!finished || finished.error || !['open','complete','exhausted','closed'].includes(finished.status) || !Number.isSafeInteger(finished.received) || finished.received<0)throw Error('backend_unavailable');
              s.task=null;
            } catch(error) {alive();s.test_run.finish_error=error.message || 'backend_unavailable';}
            await this.save(s);
          }
          return;
        }
        // Restore active work, never a stopped/blocked participant. A long
        // suspension must restart dwell; wake detection is an alarm-gap heuristic.
        if (recover || (s.last_tick != null && now - s.last_tick > 120000)) {
          if(this.r.localTest === true && s.wait_kind === 'action')s.control_checked=0;
          // Keep comment/profile checkpoints; enrich rechecks page, lease and action gates.
          // Elapsed sleep is not evidence that comments ended.
          if (s.phase === 'note') { s.phase = 'reopen_note'; s.loaded_at = null; s.scrolls = 0; }
          // An admitted search survives suspension. Probe its existing page and
          // original deadline; resetting to idle would charge and navigate again.
          // Keep persisted cooldowns, quota waits and evidence retry deadlines.
        }
        s.last_tick = now; await this.save(s); alive();
        // Repair a cleared alarm before network IO can suspend this worker.
        await this.schedule(s,Math.max(s.next_at, now + 30000)); alive();
        // Independent of task caching and collection waits. Explicit user stop still cancels work.
        const controlInterval=s.wait_kind==='action' || s.task?.repair_only && s.phase==='idle'?30000:300000;
        if (s.pending_risk || !s.control || now >= (s.control_checked || 0) + controlInterval || now < s.control_checked) {
          try { await this.control(s, s.pending_risk || 'control', alive, signal); }
          catch (error) { alive(); s.control_error = true; if (error.status === 401 || error.status === 403) throw error; }
          await this.save(s);
          if(!s.enabled)return;
          if(s.assignment_refresh)return true;
          if(s.pilot_waiting===true){if(s.outbox.length)await this.flushOutbox(s,alive,signal);s.last_error='test_completed';await this.save(s);await this.schedule(s,s.next_at);return;}
        }
        // New batches keep old rejects exportable; retries need complete evidence, never a hidden recrawl.
        const revision=s.control_task===s.task?.id?s.control?.relevance_revision||0:s.task?.relevance_revision||0;
        const retry=s.rejected.findIndex(item=>item.reason==='unrelated_note' && !item.kind && item.task===s.task?.id &&
          (!s.test_run || item.test_run_id===s.test_run.id) &&
          !s.task.comments_capture &&
          (item.relevance_revision || 0)<revision && now-Date.parse(item.record?.standard?.captured_at)<86400000);
        if(!s.outbox.length && retry>=0){
          const item=s.rejected.splice(retry,1)[0];item.relevance_revision=revision;item.lease=s.task.lease_token;
          s.outbox.push(item);await this.save(s);alive();
        }
        // Delivery runs even during collection cooldown. One stable UUID per record.
        if (s.outbox.length) return await this.flushOutbox(s, alive, signal);
        if(s.test_run?.state==='active' && s.note_test_run===s.test_run.id && s.phase==='reopen_note') {await this.endTest(s,'test_partial');return;}
        await this.applyPreferences(s);alive();
        if(s.test_run?.state==='waiting' && !s.work_slots?.length && !s.enrichment && ['idle','search_done'].includes(s.phase)) {
          s.test_run.state='active';s.test_run.started_at=now;await this.save(s);
        }
        if(s.test_run?.state==='active' && !this.batchContinues(s) && this.testRemaining(s)===0 && (!s.task?.repair_only || s.phase==='search_done' && !s.candidates.length) && !s.work_slots?.length && !s.enrichment && ['idle','search_done','parallel'].includes(s.phase)) {
          await this.endTest(s,s.test_run.accepted.length===this.testGoal(s)?this.testResult(s):'test_partial');
          // Only a filled task is finished; a two-note test must not exhaust a larger task.
          if(s.task?.received>=s.task?.target && Date.parse(s.task.lease_until)>=now+60000) {
            try {
              const finished=await this.api.rpc('finish',{p_task:s.task.id,p_lease:s.task.lease_token},signal);alive();
              if(!finished || finished.error || !['open','complete','exhausted','closed'].includes(finished.status) || !Number.isSafeInteger(finished.received) || finished.received<0)throw Error('backend_unavailable');
              s.task=null;s.phase='idle';
            } catch(error) {alive();s.test_run.finish_error=error.message || 'backend_unavailable';}
            await this.save(s);
          }
          return;
        }
        if (s.pending_risk || !s.control || this.r.now() >= s.control_expires || this.r.now() < s.control_checked) {
          s.last_error = 'control_unavailable'; await this.save(s); return;
        }
        if (s.control.paused || ['captcha','rate_limit','session_rest'].includes(s.control.reason) && now < s.control_checked + s.control.wait_ms) {
          s.last_error = s.control.reason || 'global_pause'; await this.save(s); return;
        }
        const pageWake = s.wait_kind === 'page' && ready?.generation === this.generation &&
          now >= (s.retry_at || 0) &&
          (s.phase === 'search' ? ready.keyword === s.task?.query : ready.target === s.note_id);
        if (s.next_at > now && !pageWake && !s.work_slots?.length) { await this.schedule(s,s.next_at); return; }
        if (s.visits >= 60) { s.next_at = now + 3600000; s.wait_kind = 'budget'; await this.save(s); await this.schedule(s,s.next_at); return; }
        if (s.enrichment) {
          await this.enrich(s, alive, signal); await this.save(s); alive();
          if (s.outbox.length) await this.flushOutbox(s, alive, signal);
          await this.schedule(s,s.next_at);
          return !s.outbox.length && s.next_at <= this.r.now();
        }
        if (!s.task || Date.parse(s.task.lease_until) < now + 180000) {
          if(s.test_run?.task_ids && !this.claimTask(s)){await this.endTest(s,'test_partial');return;}
          const requested=this.claimTask(s),bound=!!s.test_run?.task_ids;
          const claimed = await this.api.rpc('claim', {p_task: requested}, signal); alive();
          if(await this.parkPilot(s,claimed,alive))return;
          if (claimed.error === 'daily_quota') { if(s.test_run){await this.endTest(s,'test_quota');return;} s.next_at = C.quotaRetry(claimed, now); s.last_error = 'daily_quota'; await this.save(s); await this.schedule(s,s.next_at); return; }
          if (claimed.error) throw new Error(claimed.error);
          if(!this.bindBatch(s,claimed.task,bound?requested:null)){await this.endTest(s,'test_no_task');return;}
          if (!claimed.task) { s.task = null; s.phase = 'idle'; s.next_at = now + 300000; }
          else {
            if (s.task?.id !== claimed.task.id || s.task?.lease_token !== claimed.task.lease_token) {
              if(s.work_slots?.length)throw Error('pool_recovery_required');
              s.phase = 'idle'; s.seen = []; s.candidates = []; s.search_round = 0;
              s.note_url = null; s.note_id = null;
            }
            s.task = claimed.task;
          }
        }
        if (!s.task) { if(s.test_run){await this.endTest(s,'test_no_task');return;} await this.save(s); await this.schedule(s,s.next_at); return; }
        const platform = C.taskPlatform(s.task);
        if(s.work_slots?.length || s.parallelism===2 && ['search_done','parallel'].includes(s.phase) &&
          (s.task.repair_only || s.task.received<s.task.target && s.task.remaining_today!==0) && s.candidates.length) {
          if(!this.parallelStep)throw Error('parallel_unavailable');
          if(!s.work_slots?.length && s.phase==='search_done'){await this.r.closeLegacy?.();alive();}
          return await this.parallelStep(s,alive,signal);
        }
        if (!s.task.repair_only && s.task.received >= s.task.target || (s.phase === 'search_done' && !s.candidates.length)) {
          const continueBatch=this.batchContinues(s),finishedTask=s.task.id;
          const finished = await this.api.rpc('finish', {p_task: s.task.id, p_lease: s.task.lease_token}, signal); alive();
          if (!finished || (finished.error && finished.error !== 'lease_lost') ||
            (!finished.error && (!['open','complete','exhausted','closed'].includes(finished.status) || !Number.isSafeInteger(finished.received) || finished.received < 0))) throw new Error('backend_unavailable');
          s.last_error = finished.error || null;
          if(continueBatch) {
            if(finished.error || finished.status!=='complete'){await this.endTest(s,'test_partial');return;}
            s.test_run.finished_tasks ||= [];if(!s.test_run.finished_tasks.includes(finishedTask))s.test_run.finished_tasks.push(finishedTask);
          }
          s.task = null; s.phase = 'idle'; s.next_at = now + (continueBatch?1000:60000); await this.r.close();
        } else if (s.task.remaining_today === 0 && !s.task.repair_only) {
          if(s.test_run){await this.endTest(s,'test_quota');return;}
          s.next_at = now + 3600000;
        } else if (s.phase === 'idle') {
          if (!await this.admit(s, 'search', alive, signal)) return;
          // One alarm interval for initial search loading; never auto-reopen it.
          s.phase = 'search'; s.page_deadline = this.r.now() + 30000; s.next_at = this.r.now()+1000; s.wait_kind = 'page';
          // Persist before navigation: a worker restart after tabs.update must
          // resume probing instead of opening/charging the same search again.
          await this.save(s); alive();
          // The pre-admission heartbeat can precede this new deadline. Re-arm
          // once so a slow guard does not cost another full alarm interval.
          await this.schedule(s,s.next_at, true); alive();
          if(s.test_run?.state==='active' && !s.test_run.first_source_at_ms){s.test_run.first_source_at_ms=this.r.now();await this.save(s);alive();}
          this.assertTest(s);await this.r.open(platform.searchURL(s.task.query)); alive();
        } else if (s.phase === 'search') {
          this.assertTest(s);const page=await this.r.probe('search'); alive();
          const normalize = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
          if ('keyword' in page && normalize(page.keyword) !== normalize(s.task.query)) throw new Error('page_mismatch');
          this.checkPage(page, s, now);
          if (page.ready) {
            s.data_ready_at = this.r.now();
            const repairs=new Set((s.task.repair_notes||[]).filter(n=>!s.repaired?.includes(n.parent)).map(n=>n.record.standard.note_id));
            const known = new Set((s.task.known_note_ids||[]).filter(id=>!repairs.has(id)));
            const found = new Map(s.candidates.map(url => [platform.noteURL(url).id, url]).filter(([id]) => !known.has(id)));
            for (const url of page.links) { try { const note = platform.noteURL(url); if (!known.has(note.id) && !s.seen.includes(note.id) && (!s.history.includes(note.id) || repairs.has(note.id))) found.set(note.id, note.navigation); } catch (_) {} }
            s.card_meta ||= {};
            for (const card of page.cards || []) { try { s.card_meta[platform.noteURL(card.url).id] = {title:card.title,author_display:card.author_display}; } catch (_) {} }
            const normalizeTerm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu,'');
            const score = url => (s.task.anchor_terms || []).filter(term => normalizeTerm(s.card_meta[platform.noteURL(url).id]?.title).includes(normalizeTerm(term))).length;
            s.candidates = [...found.values()].filter(url=>!s.task.repair_only || repairs.has(platform.noteURL(url).id)).sort((a,b) => (repairs.has(platform.noteURL(b).id)?10000:score(b))-(repairs.has(platform.noteURL(a).id)?10000:score(a))).slice(0, 80);
            s.card_meta = Object.fromEntries(s.candidates.map(url => {const id=platform.noteURL(url).id;return [id,s.card_meta[id] || {}];}));
            s.search_round = (s.search_round || 0) + 1;
            // Stop expanding once enough unseen candidates exist for this task.
            // This saves page actions for small trials without changing server gaps.
            const needed = s.task.repair_only?repairs.size:Math.max(1, Math.min(s.task.target - s.task.received,this.testRemaining(s)));
            if (s.search_round < 3 && s.candidates.length < needed) { if (!await this.admit(s, 'scroll', alive, signal)) { s.search_round--; await this.save(s); return; } this.assertTest(s);await this.r.probe('scroll'); alive(); s.next_at = now + C.between(30000, 45000, this.r.random); }
            else { s.search_round = 0; s.phase = 'search_done'; s.next_at = now; s.wait_kind = null; }
          }
        } else if (s.phase === 'search_done') {
          const url = s.candidates[0]; const id = platform.noteURL(url).id;
          if (!await this.admit(s, 'detail', alive, signal, id)) {
            if (['known_note','note_busy'].includes(s.last_error)) { s.candidates.shift(); s.seen.push(id); await this.save(s); }
            return;
          }
          s.candidates.shift();
          // Mark before navigation: crashes cannot create infinite note loops.
          s.seen.push(id); s.visits++; s.note_id = id; s.note_url = url; s.phase = 'note'; s.loaded_at = null; s.scrolls = 0; s.comment_rounds = 0; s.comment_snapshot = null; s.comment_stalls = 0;
          s.note_repair=s.task.repair_notes?.find(n=>n.record.standard.note_id===id && !s.repaired?.includes(n.parent)) || null;
          s.note_test_run=null;
          if(s.test_run?.state==='active' && !s.note_repair){s.test_run.attempts++;s.note_test_run=s.test_run.id;}
          s.dwell_ms = C.between(45000, 90000, this.r.random); s.page_deadline = now + 180000;
          s.next_at = now + (this.r.fastCapture===true?1000:30000); s.wait_kind = 'page'; s.fast_note = this.r.fastCapture === true; await this.save(s);
          this.assertTest(s);await this.r.open(url); alive();
        } else if (s.phase === 'reopen_note') {
          if (!s.note_url) { s.phase = 'idle'; s.next_at = now + 30000; }
          else {
            if (!await this.admit(s, 'detail', alive, signal, s.note_id)) {
              if (['known_note','note_busy'].includes(s.last_error)) { s.phase = 'search_done'; s.note_url = null; s.note_id = null; await this.save(s); }
              return;
            }
            this.assertTest(s);await this.r.open(s.note_url); alive(); s.phase = 'note'; s.loaded_at = null; s.scrolls = 0; s.comment_rounds = 0; s.comment_snapshot = null; s.comment_stalls = 0;
            s.page_deadline = now + 180000; s.next_at = now + (this.r.fastCapture===true?1000:30000); s.wait_kind = 'page'; s.fast_note = this.r.fastCapture === true;
          }
        } else if (s.phase === 'note') {
          this.assertTest(s);const page=await this.r.probe(s.fast_note ? 'note_ready' : 'note'); alive(); this.checkPage(page, s, now);this.assertTest(s);await this.r.sourceHealth?.(s.task?.platform||'xiaohongshu');alive();
          if (page.ready) {
            if (page.record.standard.note_id !== s.note_id) throw new Error('wrong_note');
            s.data_ready_at = this.r.now();
            if (s.loaded_at === null) s.loaded_at = now;
            if (!s.fast_note && (now - s.loaded_at < s.dwell_ms || s.scrolls < 2)) {
              if (!await this.admit(s, 'scroll', alive, signal)) return;
              this.assertTest(s);await this.r.probe('scroll'); alive(); s.scrolls++; s.next_at = now + C.between(30000, 45000, this.r.random);
            } else if (this.r.splitCapture && s.control.observations === 1) {
              C.validate(page.record);
              page.record.extra.discovery = {method:'task_search',candidate:s.card_meta?.[s.note_id] || null};
              const repair=s.note_repair,request = repair?repair.parent:this.r.uuid();
              if(!repair)s.outbox.push({request,task:s.task.id,lease:s.task.lease_token,record:page.record,test_run_id:s.note_test_run || null});
              else {const current=page.record;page.record=JSON.parse(JSON.stringify(repair.record));page.record.extra.comments=current.extra.comments;page.record.standard.comment_count=current.standard.comment_count;}
              s.enrichment = {structured:page.structured||null,repair:!!repair,parent:request,author_navigation:page.author_navigation || null,record:JSON.parse(JSON.stringify(page.record)),stage:'comments',rounds:0,stalls:0,last:null};
              s.phase = 'enrich'; s.next_at = now; s.wait_kind = null;
            } else {
              const comments = page.record.extra.comments;
              // Compare actual loaded content, not just item count: virtual lists
              // and reply updates can change text without increasing the count.
              const snapshot = comments ? JSON.stringify(comments.items.map(item => [item.comment_id || item.key, item.parent_key, item.text])) : null;
              if (s.comment_snapshot != null) {
                s.comment_stalls = snapshot === s.comment_snapshot ? (s.comment_stalls || 0) + 1 : 0;
                s.comment_snapshot = null; // Consume each attempted expansion once, even if admission is denied.
              }
              const empty = comments && page.record.standard.comment_count === 0 && !comments.items.length && !comments.more_available;
              const stalled = (s.comment_stalls || 0) >= (comments?.more_available ? 2 : 1);
              if (comments && !comments.truncated && !empty && !stalled && (s.comment_rounds || 0) < 4) {
                if (!await this.admit(s, 'comment', alive, signal)) return;
                s.comment_snapshot = snapshot;
                // Persist before the DOM action so worker restart cannot repeat an uncounted expansion.
                s.comment_rounds = (s.comment_rounds || 0) + 1;
                s.next_at = this.r.now() + 30000; await this.save(s); alive();
                this.assertTest(s);const progress=await this.r.probe('comments'); alive(); this.checkPage(progress, s, now);
              } else {
                C.validate(page.record);
                s.outbox.push({request: this.r.uuid(), task: s.task.id, lease: s.task.lease_token, record: page.record,test_run_id:s.note_test_run || null});
                s.page_failures = 0;
                s.phase = 'search_done'; s.notes_in_session++; s.note_url = null; s.note_id = null; s.loaded_at = null;
                s.next_at = now + (s.notes_in_session % 8 === 0 ? C.between(300000, 600000, this.r.random) : C.between(30000, 60000, this.r.random));
              }
            }
          }
        }
        await this.save(s); alive();
        // The durable outbox is the crash boundary, not a reason to delay its first send.
        if (s.outbox.length) await this.flushOutbox(s, alive, signal);
        await this.schedule(s,Math.max(s.next_at, now + 30000));
        return !s.outbox.length && ['enrich','search_done'].includes(s.phase) && s.next_at <= this.r.now();
      } catch (err) {
        if (err.message === 'cancelled' || signal.aborted) return;
        alive(); s.last_error = err.message;
        if(err.message==='pool_recovery_required')s.pool_failure=err.poolCause||'unknown';
        if (['captcha','rate_limit'].includes(err.message)) {
          // Persist before IO. If reporting fails, the next start must report before any action.
          s.pending_risk = err.message;
          s.next_at = Math.max(s.next_at, now + (err.message === 'rate_limit' ? 86400000 : 1800000));
          await this.save(s);
          if(!['sending','unknown'].includes(s.risk_report?.state)){
            s.risk_report={kind:err.message,source:'source_gate',state:'sending',at:this.r.now()};await this.save(s);
            try{const reported=await this.control(s,err.message,alive,signal);s.risk_report.state=reported.reason===err.message?'acknowledged':'unknown';}
            catch(_){alive();s.risk_report.state='unknown';}
            if(s.risk_report.state==='unknown')s.pending_risk=err.message;await this.save(s);
          }
        }
        s.failure_kind = ['captcha','rate_limit'].includes(err.message) ? 'platform_gate' :
          ['login_required','identity_verification_required','platform_identity_changed'].includes(err.message) ? 'platform_login' :
          ['sdk_unknown','navigation_failed','navigation_uncommitted','page_loading','probe_timeout'].includes(err.message) ? 'page_transport' :
          ['page_timeout','content_unavailable','wrong_note','invalid_content','invalid_comments','invalid_count','page_mismatch'].includes(err.message) ? 'page_contract' : 'backend';
        const pageFailure = ['page_timeout', 'page_loading', 'content_unavailable', 'probe_timeout', 'wrong_note', 'invalid_content', 'invalid_comments', 'invalid_count'].includes(err.message);
        if (pageFailure) {
          s.page_failures = (s.page_failures || 0) + 1;
          if (s.page_failures >= 3) {
            if(s.test_run){await this.endTest(s,err.message);return;}
            s.enabled = false; await this.save(s); await this.r.cancel(); return;
          }
        }
        if (err.message==='navigation_uncommitted') await this.r.trace?.('navigation_timeout');
        if (s.platform_resume_task&&err.message==='lease_lost') {s.enabled=false;await this.save(s);await this.r.cancel();return;}
        if (['sdk_unknown','test_expired','parallel_unavailable','pool_recovery_required','identity_verification_required','platform_identity_changed','navigation_failed', 'navigation_uncommitted', 'page_loading', 'page_timeout', 'content_unavailable', 'probe_timeout', 'captcha', 'rate_limit', 'login_required', 'backend_login_required', 'page_mismatch', 'approval_required', 'consent_required', 'review_local_rejections', 'unsupported_platform'].includes(err.message) || err.status === 401 || err.status === 403) {
          const backendError=err.status===401?'backend_login_required':err.status===403?'backend_permission_denied':null;
          if(s.test_run){await this.endTest(s,backendError||err.message,{drain:!backendError});return;}
          if(backendError)s.last_error=backendError;
          if(err.status===401 || err.status===403){s.delivery_enabled=false;s.delivery_error=err.status===403?'backend_permission_denied':'backend_login_required';await this.r.cancelDelivery?.();}
          s.enabled = false; await this.save(s); await this.r.cancel(); return;
        }
        if (pageFailure || err.message === 'wrong_note') {
          s.phase = 'idle'; s.search_round = 0; s.candidates = []; s.note_url = null; s.note_id = null;
        }
        s.next_at = Math.max(s.next_at, now + (pageFailure ? 60000 * 2 ** (s.page_failures - 1) : 60000));
        s.retry_at = s.next_at; s.wait_kind = 'retry';
        if (s.outbox.length) { const item = s.outbox[0]; item.retries = (item.retries || 0) + 1; item.retry_at = now + Math.min(900000, 60000 * 2 ** Math.min(item.retries - 1, 4)); s.next_at = item.retry_at; }
        await this.save(s); await this.schedule(s,s.next_at);
      }
    }
    async scheduleReceipt(s, at) {
      if (s.enabled) await this.schedule(s,at);
      else await this.r.scheduleDelivery?.(at);
    }
    async queueRating(proof, score, reason) {
      await this.initializeGeneration();
      if (this.maintenance) throw new Error('update_in_progress');
      if (!Number.isSafeInteger(proof) || proof < 1 || !Number.isInteger(score) || score < 1 || score > 5 ||
        typeof reason !== 'string' || reason.length > 200 || reason.replace(/[\s\p{P}\p{S}]/gu,'').length < 8) throw new Error('invalid_rating');
      const generation = this.generation;
      await this.active?.catch(()=>{});
      if (generation !== this.generation) throw new Error('cancelled');
      if (this.maintenance) throw new Error('update_in_progress');
      if (this.active) return this.queueRating(proof, score, reason);
      this.active = (async()=>{
        const s=await this.read(); if(s.consent!==C.CONSENT)throw new Error('consent_required');
        if(s.outbox.some(i=>i.kind==='rating'&&i.proof===proof))throw new Error('rating_queued');
        if(s.outbox.length>=100)throw new Error('queue_full');
        s.outbox.push({kind:'rating',request:this.r.uuid(),proof,score,rating_reason:reason});
        s.delivery_enabled=true;await this.save(s);await this.repairDelivery();
      })().finally(()=>{this.active=null;});
      return this.active;
    }
    async repairDelivery() {
      const s = await this.read();
      if (s.consent === C.CONSENT && (s.enabled || s.delivery_enabled) && s.outbox.length) await this.r.scheduleDelivery?.(Math.max(this.r.now()+1000,s.outbox[0].retry_at||0));
      else await this.r.cancelDelivery?.();
    }
    readyDeliveryContinuation(s) {
      const next=s.outbox[0];
      return this.r.fastDelivery===true && !this.maintenance && !this.stopping &&
        (s.enabled===true || s.delivery_enabled===true) && !!next && ['comments','structured'].includes(next.kind) &&
        (next.retry_at||0)<=this.r.now() && !['backend_login_required','backend_permission_denied','review_local_rejections'].includes(s.delivery_error);
    }
    captureScope(s) {
      if(this.r.localTest===true && s.owner_id==='7033ff0c-65d7-4963-b65c-a4ac9e31f03a' && s.test_run?.state==='active')return s.test_run.id;
      const run=s.task?.node_run;
      return this.r.siteSDK===true && s.task?.capabilities?.site_sdk_v1===true && run?.task_id===s.task.id &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(run?.run_id||'') ? run.run_id : null;
    }
    captureMetrics(s) {return s.test_run || (s.sdk_metrics ||= {});}
    batchAllowed(s) {
      return this.r.batchObservations===true && (this.r.localTest===true && s.owner_id==='7033ff0c-65d7-4963-b65c-a4ac9e31f03a' ||
        s.task?.capabilities?.batch_observe_v1===true && Date.parse(s.task.lease_until)>this.r.now()) && s.batch_endpoint_unavailable!==true;
    }
    observationBatch(s) {
      if(!this.batchAllowed(s))return null;
      const first=s.outbox[0];
      if(!first || !['comments','structured'].includes(first.kind) || first.kind==='structured' &&
        (first.record?.kind!=='comments' || first.record?.source!=='page_response'))return null;
      if(this.r.localTest!==true && (s.task?.id!==first.task || s.task?.lease_token!==first.lease))return null;
      const pending=s.pending_observation_batch;
      if(pending) {
        if(pending.owner!==s.owner_id || pending.kind!==first.kind || pending.parent!==first.parent || pending.task!==first.task || pending.lease!==first.lease ||
          !Array.isArray(pending.rows) || pending.rows.length<2 || pending.rows.length>4 || pending.rows.some((p,i)=>
            s.outbox[i]?.request!==p.request || s.outbox[i]?.kind!==first.kind || s.outbox[i]?.parent!==first.parent ||
            s.outbox[i]?.task!==first.task || s.outbox[i]?.lease!==first.lease || (s.outbox[i]?.retry_at||0)>this.r.now() || JSON.stringify(s.outbox[i]?.record)!==p.snapshot))throw Error('invalid_receipt');
        return s.outbox.slice(0,pending.rows.length);
      }
      const rows=[];let bytes=0;
      for(const item of s.outbox.slice(0,4)) {
        if(item.kind!==first.kind || item.parent!==first.parent || item.task!==first.task || item.lease!==first.lease ||
          item.record?.run!==first.record.run || item.record?.total!==first.record.total || item.record?.page!==first.record.page+rows.length ||
          item.kind==='structured' && (item.record.kind!=='comments' || item.record.source!=='page_response') || (item.retry_at||0)>this.r.now())break;
        const size=new TextEncoder().encode(JSON.stringify({request:item.request,data:item.record})).length;
        if(bytes+size>400000)break;
        bytes+=size;rows.push(item);
      }
      return rows.length>=2?rows:null;
    }
    async flushObservationBatch(s,alive,signal,rows) {
      const first=rows[0];
      s.pending_observation_batch ||= {owner:s.owner_id,kind:first.kind,parent:first.parent,task:first.task,lease:first.lease,
        rows:rows.map(i=>({request:i.request,snapshot:JSON.stringify(i.record)}))};
      await this.save(s);alive();
      const result=await this.api.rpc('batch_observe',{p_parent:first.parent,p_task:first.task,p_lease:first.lease,p_kind:first.kind,
        p_pages:rows.map(i=>({request:i.request,data:i.record}))},signal);alive();
      if(!result || typeof result.halted!=='boolean' || !Array.isArray(result.receipts) || result.receipts.length<1 || result.receipts.length>rows.length ||
        Object.keys(result).some(k=>!['receipts','halted'].includes(k)) || !result.halted && result.receipts.length!==rows.length)throw Error('invalid_receipt');
      // Validate the whole returned prefix before changing any queue or ACK ledger.
      for(const [index,receipt] of result.receipts.entries()) {
        const item=rows[index],last=index===result.receipts.length-1;
        if(!receipt || receipt.request!==item.request || receipt.gate!==(result.halted && last?'rejected':'observed') ||
          receipt.gate==='observed' && (receipt.run!==item.record.run || receipt.page!==item.record.page || item.kind==='structured' &&
            (receipt.source!==item.record.source || receipt.reward_eligible!==false)))throw Error('invalid_receipt');
      }
      for(const [index,receipt] of result.receipts.entries()) {
        const item=rows[index];
        if(receipt.gate==='rejected') {
          s.rejected.push({...item,reason:receipt.error||'invalid_record'});
          if(item.kind==='structured')s.structured_partial=true;else s.comment_failures=(s.comment_failures||0)+1;
        } else if(item.kind==='structured')this.acknowledgeExperimentalAPI(s,item,receipt);
        else if(item.record.page===item.record.total-1 && s.task?.repair_notes?.some(n=>n.parent===item.parent)) {
          s.repaired ||= [];if(!s.repaired.includes(item.parent))s.repaired.push(item.parent);
        }
      }
      s.outbox.splice(0,result.receipts.length);delete s.pending_observation_batch;
      await this.save(s);alive();
      if(result.receipts.some(receipt=>receipt.gate==='rejected')&&s.rejected.length>=20)throw Error('review_local_rejections');
      await this.scheduleReceipt(s,this.r.now()+(result.halted?1000:250));
      return !result.halted && this.readyDeliveryContinuation(s);
    }
    async flushOutbox(s, alive, signal) {
      const now = this.r.now();
      const item = s.outbox[0];
      if ((item.retry_at || 0) > now) { await this.scheduleReceipt(s, item.retry_at); return; }
      // Rollback preserves each original UUID and public record.
      if(s.pending_observation_batch && !this.batchAllowed(s)) {
        delete s.pending_observation_batch;await this.save(s);alive();
      }
      const batch=this.observationBatch(s);
      if(batch) {
        try{return await this.flushObservationBatch(s,alive,signal,batch);}
        catch(error) {
          // PGRST202 is a definite missing RPC, before execution. Unknown network or
          // malformed ACK outcomes retain the original batch and are never retried here.
          if(error.code!=='PGRST202')throw error;
          s.batch_endpoint_unavailable=true;delete s.pending_observation_batch;await this.save(s);alive();
        }
      }
      if(item.kind==='structured') {
        const receipt=await this.api.rpc('structured_observe',{p_request:item.request,p_parent:item.parent,p_task:item.task,p_lease:item.lease,p_data:item.record},signal);alive();
        if(!receipt || receipt.request!==item.request || !['observed','rejected'].includes(receipt.gate) || receipt.gate==='observed'&&(receipt.run!==item.record.run||receipt.page!==item.record.page||receipt.source!==item.record.source||receipt.reward_eligible!==false))throw Error('invalid_receipt');
        if(receipt.gate==='rejected'){s.rejected.push({...item,reason:receipt.error||'invalid_record'});if(this.r.experimentalAPIEarlyFinish===true)s.structured_partial=true;}
        else this.acknowledgeExperimentalAPI(s,item,receipt);
        s.outbox.shift();await this.save(s);if(receipt.gate==='rejected'&&s.rejected.length>=20)throw Error('review_local_rejections');await this.scheduleReceipt(s,this.r.fastCapture===true&&receipt.gate==='observed'?this.r.now()+250:now+1000);return receipt.gate==='observed' && this.readyDeliveryContinuation(s);
      }
      if (item.kind === 'rating') {
        const receipt=await this.api.rpc('rating',{p_request:item.request,p_proof:item.proof,p_score:item.score,p_reason:item.rating_reason},signal);alive();
        if(receipt?.request!==item.request || !['rated','rejected'].includes(receipt.gate) ||
          (receipt.gate==='rated' && typeof receipt.inserted!=='boolean') ||
          (receipt.gate==='rejected' && !['invalid_rating','invalid_anchor','already_rated','request_reused'].includes(receipt.error)))throw new Error('invalid_receipt');
        if(receipt.gate==='rejected')s.rejected.push({...item,reason:receipt.error});
        s.outbox.shift();if(receipt.gate==='rejected' && s.rejected.length>=20)throw new Error('review_local_rejections');await this.save(s);await this.scheduleReceipt(s,now+30000);return;
      }
      if (item.kind) {
        const receipt = await this.api.rpc(item.kind==='comments'?'comments_observe':'observe', item.kind==='comments'?{p_request:item.request,p_parent:item.parent,p_task:item.task,p_lease:item.lease,p_data:item.record}:{p_request:item.request,p_parent:item.parent,p_kind:item.kind,p_data:item.record}, signal); alive();
        if (!receipt || receipt.request !== item.request || !['observed','rejected'].includes(receipt.gate)) throw new Error('invalid_receipt');
        if (receipt.gate === 'rejected') {s.rejected.push({...item,reason:receipt.error || 'invalid_record'});if(item.kind==='comments')s.comment_failures=(s.comment_failures||0)+1;}
        if(item.kind==='comments' && receipt.gate==='observed' && item.record.page===item.record.total-1 && s.task?.repair_notes?.some(n=>n.parent===item.parent)){s.repaired ||= [];if(!s.repaired.includes(item.parent))s.repaired.push(item.parent);}
        s.outbox.shift(); if(receipt.gate==='rejected' && s.rejected.length>=20)throw new Error('review_local_rejections'); await this.save(s); await this.scheduleReceipt(s,this.r.fastCapture===true&&item.kind==='comments'&&receipt.gate==='observed'?this.r.now()+250:now+(item.kind==='comments'&&receipt.gate==='observed'?1000:30000)); return item.kind==='comments' && receipt.gate==='observed' && this.readyDeliveryContinuation(s);
      }
      const receipt = C.receipt(await this.api.rpc('submit', {p_request: item.request, p_task: item.task,
        p_lease: item.lease, p_record: item.record}, signal), item.request);
      alive();
      if(s.acceptance_supplement?.state==='admitted'&&!receipt.error&&receipt.inserted===true&&(item.task!==s.acceptance_supplement.task_id||receipt.task_received!==3||s.acceptance_supplement.baseline_history.includes(item.record.standard.note_id)))throw Error('invalid_receipt');
      if (receipt.error === 'daily_quota') {
        item.retry_at = C.quotaRetry(receipt, now); s.last_error = 'daily_quota'; await this.save(s); await this.scheduleReceipt(s, item.retry_at); return;
      } else if (receipt.error === 'lease_expired') {
        const renewed = await this.api.rpc('claim', {p_task: item.task}, signal); alive();
        if(await this.parkPilot(s,renewed,alive)){item.retry_at=s.next_at;await this.save(s);await this.scheduleReceipt(s,item.retry_at);return;}
        if (renewed.error === 'daily_quota') {
          item.retry_at = C.quotaRetry(renewed, now); s.last_error = 'daily_quota';
          await this.save(s); await this.scheduleReceipt(s, item.retry_at); return;
        }
        if (renewed.error) throw new Error(renewed.error);
        if (renewed.task?.id === item.task) { item.lease = renewed.task.lease_token; s.task = renewed.task; }
        else { s.rejected.push({...item, reason: 'lease_lost'}); s.outbox.shift(); s.task = null; s.phase = 'idle'; }
      } else {
        s.outbox.shift();
        const slot=s.work_slots?.find(slot=>slot.request===item.request);
        if(slot){if(receipt.error){slot.phase='done';slot.enrichment=null;}else slot.base_received=true;}
        if (receipt.error) {
          s.rejected.push({...item, reason: receipt.error,relevance_revision:Math.max(item.relevance_revision||0,s.task?.id===item.task?s.task.relevance_revision||0:0,s.control_task===item.task?s.control?.relevance_revision||0:0)});
          if (s.enrichment?.parent === item.request) { s.enrichment = null; s.phase = 'search_done'; }
        }
        else {
          s.last_error = null;
          s.accepted_parents=[...(s.accepted_parents||[]).filter(p=>p.parent!==item.request),
            {parent:item.request,owner:s.owner_id,task:item.task,lease:item.lease,note:item.record.standard.note_id}].slice(-200);
          s.received += receipt.inserted ? 1 : 0;
          if(s.test_run && item.test_run_id===s.test_run.id && receipt.inserted && !receipt.duplicate && !s.test_run.accepted.some(a=>a.request===item.request || a.note_id===item.record.standard.note_id)) {
            s.test_run.accepted.push({request:item.request,note_id:item.record.standard.note_id});
          }
          s.history = [...new Set([...s.history, item.record.standard.note_id])].slice(-2000);
          if (s.task?.id === item.task) {
            const newlyReceived=Math.max(0,receipt.task_received-s.task.received);
            s.task.received=Math.max(s.task.received,receipt.task_received);
            if(s.task.remaining_today!=null)s.task.remaining_today=Math.max(0,s.task.remaining_today-newlyReceived);
          }
        }
      }
      const supplement=s.acceptance_supplement;
      if(supplement?.state==='admitted'&&!receipt.error&&receipt.inserted===true&&receipt.duplicate!==true&&item.task===supplement.task_id&&!supplement.baseline_history.includes(item.record.standard.note_id)){
        supplement.state='consumed';supplement.remaining=0;supplement.request=item.request;supplement.consumed_at=this.r.now();
        await this.parkPilot(s,{error:'test_completed',pilot_phase:'awaiting_acceptance'},alive);
      }
      // Failed records remain exportable; bounded by stopping, never by deleting evidence.
      if (receipt.error && s.rejected.length >= 20) throw new Error('review_local_rejections');
      await this.save(s); await this.scheduleReceipt(s, now + 30000); return;
    }
    saveStructuredDiagnostic(s,e,value) {
      const diag=value.observer_diagnostics;
      const counts=['fetch_calls','xhr_calls','matched_requests','responses','parse_failures','wrong_note','invalid_picture','invalid_page','page_budget','response_failed'];
      const flags=['fetch_hook_current','xhr_hook_current','marker_retained'];
      const errorKinds=['unknown_parent','cursor_out_of_order','cursor_stalled','page_conflict','root_metadata_conflict','item_conflict','page_budget','invalid_page','response_failed','late_binding','csp_or_install_blocked','body_unavailable'];
      if(!diag || typeof diag!=='object' || Array.isArray(diag) || Object.keys(diag).length!==counts.length+flags.length ||
        Object.keys(diag).some(key=>!counts.includes(key)&&!flags.includes(key)) ||
        counts.some(key=>!Number.isInteger(diag[key]) || diag[key]<0 || diag[key]>10000) || flags.some(key=>typeof diag[key]!=='boolean') ||
        !/^[a-f0-9]{24}$/.test(value.note_id) || !Number.isSafeInteger(s.task.id) || s.task.id<=0 || !['installed','waiting','csp_or_not_installed'].includes(value.observer_status) ||
        !Array.isArray(value.errors) || value.errors.length>12 || value.errors.some(error=>!errorKinds.includes(error)))return;
      const at=this.r.now();if(!Number.isSafeInteger(at)||at<0||at>8640000000000000)return;
      const owner=s.owner_id||this.generationOwner||'standalone';
      const oldRows=Array.isArray(s.structured_diagnostics)?s.structured_diagnostics:[];
      const allowedRow=['owner_id','task_id','note_id','observer_status','captured_at','errors','counts'];
      const safeRows=oldRows.filter(row=>row&&typeof row==='object'&&Object.keys(row).length===allowedRow.length&&Object.keys(row).every(key=>allowedRow.includes(key))&&
        row.owner_id===owner&&Number.isSafeInteger(row.task_id)&&row.task_id>0&&/^[a-f0-9]{24}$/.test(row.note_id)&&['installed','waiting','csp_or_not_installed'].includes(row.observer_status)&&
        typeof row.captured_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.captured_at)&&
        Array.isArray(row.errors)&&row.errors.length<=12&&row.errors.every(error=>errorKinds.includes(error))&&row.counts&&typeof row.counts==='object'&&Object.keys(row.counts).length===counts.length+flags.length&&
        counts.every(key=>Number.isInteger(row.counts[key])&&row.counts[key]>=0&&row.counts[key]<=10000)&&flags.every(key=>typeof row.counts[key]==='boolean'));
      s.structured_diagnostics=[...safeRows.slice(-1),
        {owner_id:owner,task_id:s.task.id,note_id:value.note_id,observer_status:value.observer_status,captured_at:new Date(at).toISOString(),
          errors:[...value.errors],counts:Object.fromEntries([...counts,...flags].map(key=>[key,diag[key]]))}];
    }
    queueStructuredPages(s,e,reason=null) {
      if(!s.task?.structured_capture || e.structured_queued)return;
      const value=e.structured;
      if(!value || value.note_id!==e.record.standard.note_id){s.structured_partial=true;return;}
      if(reason || value.complete!==true || value.mode!=='passive_hybrid' || value.observer_status!=='installed' || !value.pages?.length ||
         value.dom_witness.reported_count!==null && value.dom_witness.reported_count!==value.items.length)s.structured_partial=true;
      this.saveStructuredDiagnostic(s,e,value);
      if(value.body?.source==='page_hydration')s.outbox.push({kind:'structured',request:this.r.uuid(),parent:e.parent,task:s.task.id,lease:s.task.lease_token,
        record:{kind:'body',source:'page_hydration',run:this.r.uuid(),page:0,total:1,note_id:value.note_id,body:value.body,summary:{reward_eligible:false,body_dom_match:value.body_dom_match===true,observer_status:value.observer_status}}});
      if(value.mode==='passive_hybrid' && (value.pages.length || value.observer_status==='installed')){
        const hasPages=value.pages.length>0,items=hasPages?value.items:[];
        const summary={reward_eligible:false,source:'page_response',mode:value.mode,observer_status:value.observer_status,
          captured_count:items.length,root_count:items.filter(i=>i.parent===null).length,reply_count:items.filter(i=>i.parent!==null).length,
          image_count:items.reduce((n,i)=>n+i.pictures.length,0),groups:hasPages?value.groups:[],main_ended:hasPages&&value.main_ended===true,
          api_complete:hasPages&&!reason&&value.complete===true,complete:hasPages&&!reason&&value.complete===true&&(value.dom_witness.reported_count===null||value.dom_witness.reported_count===items.length),
          reported_count:value.dom_witness.reported_count,count_gap:value.dom_witness.reported_count===null?null:value.dom_witness.reported_count-items.length,
          dom_matched:value.dom_witness.matched===true,errors:value.errors,capture_reason:reason||'hybrid_finished'};
        const chunks=[];let chunk=[],bytes=0;for(const item of items){const size=new TextEncoder().encode(JSON.stringify(item)).length;if(chunk.length&&(chunk.length>=50||bytes+size>120000)){chunks.push(chunk);chunk=[];bytes=0;}chunk.push(item);bytes+=size;}
        if(chunk.length||!chunks.length)chunks.push(chunk);const run=this.r.uuid();
        chunks.forEach((items,page)=>s.outbox.push({kind:'structured',request:this.r.uuid(),parent:e.parent,task:s.task.id,lease:s.task.lease_token,
          record:{kind:'comments',source:'page_response',run,page,total:chunks.length,note_id:value.note_id,items,summary}}));
      }
      if(e.api_early_finish===true && this.r.experimentalAPIEarlyFinish===true) {
        const rows=s.outbox.filter(i=>i.kind==='structured' && i.parent===e.parent),bodyRow=rows.find(i=>i.record.kind==='body'),pages=rows.filter(i=>i.record.kind==='comments');
        if(bodyRow && pages.length>0 && pages.every(i=>i.record.summary.complete===true)) {
          s.api_capture_ledger ||= [];
          s.api_capture_ledger=[...s.api_capture_ledger.filter(l=>l.parent!==e.parent).slice(-3),
            {owner:s.owner_id,test:s.test_run?.id||null,task:s.task.id,lease:s.task.lease_token,parent:e.parent,note:value.note_id,run:pages[0].record.run,
              body_request:bodyRow.request,body_run:bodyRow.record.run,body_ack:null,confirmed_parent:null,complete:false,
              pages:pages.map(i=>({request:i.request,page:i.record.page,total:i.record.total}))}];
        }
      }
      e.structured_queued=true;
    }
    queueCommentPages(s,e,reason=null) {
      const comments=e.record?.extra?.comments;
      if(!s.task?.comments_capture || !comments || e.capture_queued)return;
      const summary={captured_count:comments.items.length,reported_count:e.record.standard.comment_count,
        timing:e.timings?{...e.timings,elapsed_ms:Math.max(0,this.r.now()-e.timings.started_at_ms)}:null,
        capture_reason:reason || comments.capture_reason || 'interrupted',progress:comments.progress || null,loading:comments.loading===true,media_pending:comments.media_pending===true,image_count:comments.items.reduce((n,i)=>n+(i.media||[]).filter(m=>m.kind==='image').length,0),
        complete:!reason && ['loaded_end','visible_empty'].includes(comments.capture_reason) && !comments.truncated && !comments.media_pending && !comments.identity_uncertain &&
          (e.record.standard.comment_count===null ? comments.progress?.end_marker===true || comments.progress?.empty===true : e.record.standard.comment_count===comments.items.length)};
      const census=comments.dom_census;
      summary.dom_item_count=Number.isSafeInteger(census?.visible_count)?census.visible_count:null;
      summary.dom_skipped_count=Number.isSafeInteger(census?.skipped_count)?census.skipped_count:null;
      summary.terminal_stable=comments.terminal_stable===true;
      summary.root_count=comments.reply_coverage?.root_count ?? null;
      summary.declared_reply_count=comments.reply_coverage?.declared_count ?? null;
      summary.observed_reply_count=comments.reply_coverage?.loaded_count ?? null;
      summary.visible_complete=!reason && summary.terminal_stable && typeof census?.document==='string' &&
        census.visible_count===comments.items.length && census.skipped_count===0 && census.duplicate_count===0 && census.unresolved_parent_count===0 &&
        !comments.truncated && !comments.media_pending && !comments.identity_uncertain && !comments.loading && !comments.more_available &&
        comments.reply_coverage?.pending_groups===0 && summary.declared_reply_count!==null && summary.observed_reply_count===summary.declared_reply_count && summary.root_count+summary.observed_reply_count===summary.captured_count &&
        comments.progress?.expand_count===0 && (comments.progress?.end_marker===true && comments.progress?.at_end===true || comments.progress?.empty===true);
      summary.count_gap=Number.isSafeInteger(summary.reported_count)?summary.reported_count-summary.captured_count:null;
      summary.count_mismatch=summary.count_gap!==null && summary.count_gap!==0;
      s.comment_coverage ||= [];
      s.comment_coverage=[...s.comment_coverage.filter(item=>item.parent!==e.parent),{parent:e.parent,note_id:e.record.standard.note_id,reported:summary.reported_count,captured:summary.captured_count,visible_complete:summary.visible_complete,complete:summary.complete,count_gap:summary.count_gap,capture_reason:summary.capture_reason}].slice(-4);
      if(!summary.complete)s.comment_partial=true;
      const chunks=[];let chunk=[],bytes=0;
      for(const item of comments.items){
        const size=new TextEncoder().encode(JSON.stringify(item)).length;
        if(chunk.length && (chunk.length>=50 || bytes+size>120000)){chunks.push(chunk);chunk=[];bytes=0;}
        chunk.push(item);bytes+=size;
      }
      if(chunk.length || !chunks.length)chunks.push(chunk);
      const run=e.capture_run ||= this.r.uuid();
      chunks.forEach((items,page)=>s.outbox.push({request:this.r.uuid(),parent:e.parent,kind:'comments',task:s.task.id,lease:s.task.lease_token,
        record:{run,page,total:chunks.length,items,summary}}));
      e.capture_queued=true;
    }
    legacyCommentNote(original) {
      const record=JSON.parse(JSON.stringify(original)), projected=record.extra.comments;
      if(!projected)return record;
      const omitted=projected.items.filter(item=>!item.text).length;
      projected.items=projected.items.filter(item=>item.text);
      projected.omitted_count=(projected.omitted_count||0)+omitted;
      projected.truncated ||= omitted>0;
      while(projected.items.length>50 || JSON.stringify(record).length>55000 && projected.items.length){projected.items.pop();projected.truncated=true;projected.omitted_count++;}
      projected.captured_count=projected.items.length;
      const oldKeys=new Map(projected.items.map(item=>[item.key,item.comment_id]));
      projected.items.sort((a,b)=>Number(a.is_reply)-Number(b.is_reply));
      const keys=new Map(projected.items.map((item,i)=>[item.comment_id,'comment-'+(i+1)]));
      for(const [i,item] of projected.items.entries()){item.parent_key=keys.get(item.parent_comment_id||oldKeys.get(item.parent_key))||null;item.key='comment-'+(i+1);}
      return record;
    }
    mergeComments(previous, current, full = false) {
      if (!current) return previous;
      if (!previous) return JSON.parse(JSON.stringify(current));
      const result = JSON.parse(JSON.stringify(previous));
      const identity = item => item.comment_id ? 'id:'+item.comment_id : JSON.stringify([item.author_display,item.text,item.published_label,item.is_reply]);
      const seen = new Map(result.items.map(item => [identity(item),item]));
      const remap = new Map();
      let nextKey=Math.max(0,...result.items.map(item=>Number(item.key.replace('comment-',''))));
      for (const item of current.items) {
        let known = seen.get(identity(item));
        if (!known) {
          if (!full && (result.items.length >= 50 || JSON.stringify(result).length + JSON.stringify(item).length > 20000)) {result.truncated=true;break;}
          known = {...item,key:'comment-'+(++nextKey),parent_key:remap.get(item.parent_key) || null};
          result.items.push(known); seen.set(identity(item),known);
        } else { const key=known.key,parent=known.parent_key; Object.assign(known,item,{key,parent_key:remap.get(item.parent_key) || parent}); }
        remap.set(item.key,known.key);
      }
      result.captured_count=result.items.length; result.complete=false;
      result.identity_method='platform_id_or_content_fingerprint';result.identity_uncertain=result.items.some(item=>!item.comment_id);
      result.loaded_count=Math.max(previous.loaded_count || 0,current.loaded_count || 0,result.items.length);
      result.omitted_count=Math.max(previous.omitted_count || 0,current.omitted_count || 0);
      result.loading=current.loading===true;result.media_pending=current.media_pending===true;
      result.dom_census=current.dom_census;
      result.reply_coverage=current.reply_coverage;
      result.more_available=current.more_available;result.progress=current.progress; result.truncated ||= current.truncated;
      return result;
    }
    experimentalAPIComplete(s,e,page) {
      // Offline-only experiment: preserve partial DOM receipts and the existing final ACK barrier.
      if(this.r.experimentalAPIEarlyFinish!==true || this.r.localTest!==true ||
        s.owner_id!=='7033ff0c-65d7-4963-b65c-a4ac9e31f03a' || s.enabled!==true || s.test_run?.state!=='active' ||
        !s.test_run.id || !s.task?.structured_capture || !s.task?.comments_capture ||
        !Number.isFinite(Date.parse(s.task.lease_until)) || Date.parse(s.task.lease_until)<this.r.now()+60000 || s.pending_risk || s.control?.paused ||
        ['sending','unknown'].includes(s.risk_report?.state) ||
        ['captcha','rate_limit','login_required','backend_login_required'].includes(s.last_error))return false;
      const v=page.structured,comments=page.record?.extra?.comments,note=e.record.standard.note_id;
      const parentBound=e.repair?s.task.repair_notes?.some(p=>p.parent===e.parent && p.record?.standard?.note_id===note):s.test_run.accepted?.some(p=>p.request===e.parent && p.note_id===note);
      if(!parentBound)return false;
      if(['captcha','rate_limit'].includes(v?.gate))throw new Error(v.gate);
      if(!v || v.note_id!==note || page.record.standard.note_id!==note || v.source!=='page_response' ||
        v.mode!=='passive_hybrid' || v.observer_status!=='installed' || v.gate || v.complete!==true ||
        v.main_ended!==true || v.body_dom_match!==true || !v.body || !Array.isArray(v.errors) || v.errors.length ||
        !Array.isArray(v.pages) || !v.pages.length || !Array.isArray(v.items) || !v.items.length || !Array.isArray(v.groups) ||
        typeof v.document!=='string' || !v.document || v.document!==comments?.dom_census?.document ||
        v.dom_witness?.note_id!==note || v.dom_witness.matched!==true || !v.dom_witness.comment_ids?.length ||
        !Number.isSafeInteger(v.dom_witness.reported_count) || v.dom_witness.reported_count!==v.items.length ||
        page.record.standard.comment_count!==v.items.length)return false;
      const ids=new Map();for(const item of v.items){
        if(!item || !/^[a-f0-9]{24}$/.test(item.id||'') || ids.has(item.id) || !Array.isArray(item.pictures))return false;
        ids.set(item.id,item);
      }
      const roots=v.items.filter(i=>i.parent===null),groups=new Map();
      for(const g of v.groups){
        if(!g || groups.has(g.id) || ids.get(g.id)?.parent!==null || g.ended!==true ||
          !Number.isSafeInteger(g.declared) || g.declared<0 || g.captured!==g.declared ||
          v.items.filter(i=>i.parent===g.id).length!==g.declared)return false;
        groups.set(g.id,g);
      }
      return groups.size===roots.length && roots.every(i=>groups.has(i.id)) &&
        v.items.every(i=>i.parent===null || groups.has(i.parent)) &&
        v.dom_witness.comment_ids.every(id=>ids.has(id)) &&
        comments.items.length>0 && comments.items.every(i=>ids.has(i.comment_id));
    }
    async enrich(s, alive, signal, slot = null) {
      const state=slot||s,e=state.enrichment, now=this.r.now(), platform=C.platform(e.record.standard.platform);
      const queueNote = () => {
        if(e.note_queued)return;
        const comments=e.record.extra.comments;
        this.queueCommentPages(s,e);this.queueStructuredPages(s,e);
        if(comments){
          if(e.repair){e.note_queued=true;return;}
          const record=this.legacyCommentNote(e.record);
          try {C.validate(record);s.outbox.push({request:this.r.uuid(),parent:e.parent,kind:'note',record});}
          catch(error){s.rejected.push({request:this.r.uuid(),parent:e.parent,kind:'note',record,reason:error.message});s.comment_partial=true;s.comment_validation_failed=true;}
        }
        e.note_queued=true;
      };
      const finish = () => {queueNote();state.enrichment=null;state.phase=slot?'done':'search_done';state.note_url=null;state.note_id=null;state.loaded_at=null;s.notes_in_session++;state.next_at=now;};
      if (Date.parse(s.task?.lease_until || '') < now+60000) e.stage='done';
      if (e.stage==='comments') {
        if(s.sdk_unknown===true)throw Error('sdk_unknown');
        if(e.sdk_pending?.status==='sending'||e.sdk_pending?.status==='unknown')throw Error('sdk_unknown');
        this.assertTest(s);e.timings ||= {started_at_ms:this.r.now(),reads:0,read_ms:0,guards:0,guard_ms:0,actions:0,action_ms:0};
        const readAt=this.r.now();const page=await this.r.probe('comment_read',slot?.id);alive();
        e.timings.reads++;e.timings.read_ms+=Math.max(0,this.r.now()-readAt);
        if(page.gate)throw new Error(page.gate);
        if(!page.ready || page.record.standard.note_id!==e.record.standard.note_id){e.stage='done';}
        else {
          for(const key of ['like_count','collect_count','comment_count','view_count','captured_at']) {
            if(key in page.record.standard)e.record.standard[key]=page.record.standard[key];
          }
          if(page.structured)e.structured=JSON.parse(JSON.stringify(page.structured));
          if(this.captureScope(s)&&Array.isArray(e.structured?.items)){const rows=e.structured.items;this.captureMetrics(s).sdk_progress={captured:rows.length,reported:page.record.standard.comment_count,roots:rows.filter(i=>i.parent===null).length,replies:rows.filter(i=>i.parent!==null).length};}
          e.record.extra.field_observations=page.record.extra.field_observations;
          e.record.extra.metric_labels=page.record.extra.metric_labels;
          e.record.extra.comments=this.mergeComments(e.record.extra.comments,page.record.extra.comments,true);
          if(e.record.extra.comments.items.length>10000){e.record.extra.comments.truncated=true;e.record.extra.comments.capture_reason='storage_limit';}
          // Keep the immutable base text/title; only supplement visible observations.
          const comments=e.record.extra.comments;
          if(e.sdk_pending?.status==='accepted'&&e.structured?.pages?.join('|')!==e.sdk_observed_pages){e.sdk_observed_pages=e.structured.pages.join('|');e.last=null;e.observed_signature=null;e.stalls=0;}
          if(this.experimentalAPIComplete(s,e,page)) {
            e.api_early_finish=true;
            comments.capture_reason='api_graph_closed_dom_subset';
            comments.complete=false;comments.terminal_stable=false;
            queueNote();
            if(!s.profiles || !e.record.extra.author?.id)finish();
            else {e.stage='profile';state.next_at=now;}
            return;
          }
          if(e.sdk_pending?.status==='accepted'&&e.structured?.main_ended===true&&Array.isArray(e.structured.groups)&&e.structured.groups.every(g=>g.ended===true)&&!e.structured.errors?.length){
            comments.complete=false;comments.terminal_stable=false;comments.capture_reason=e.structured.items?.length!==page.record.standard.comment_count?'api_counter_mismatch':'api_coverage_partial';s.structured_partial=true;s.comment_partial=true;if(s.test_run)s.test_run.sdk_stop_reason=comments.capture_reason;finish();return;
          }
          // Scroll movement alone is not newly loaded comment content.
          const signature=JSON.stringify([comments?.items.map(item=>[item.comment_id,item.is_reply,item.parent_comment_id,item.text,item.media]),comments?.dom_census,comments?.reply_coverage,comments?.media_pending,comments?.more_available,comments?.progress && {height:comments.progress.height,end_marker:comments.progress.end_marker,expand_count:comments.progress.expand_count,empty:comments.progress.empty}]);
          if(e.last!==null){
            // Wait for DOM loading/stability before counting a stalled expansion.
            if(e.observed_signature!==signature){e.observed_signature=signature;e.stable_at=this.r.now();}
            if(this.r.now()<(e.read_deadline||0) && (comments?.loading || signature===e.last && this.r.now()-(e.stable_at||0)<1000)) {state.next_at=this.r.now()+1000;return;}
            if(comments?.loading){e.record.extra.comments.capture_reason='loading_timeout';finish();return;}
            const top=comments?.progress?.top,forward=Number.isFinite(top) && top>(e.scroll_peak ?? Infinity) && comments?.progress?.at_end===false;
            // Long loaded replies need several scrolls before the next page. A bottom bounce cannot reset this high-water mark.
            e.stalls=signature===e.last && !forward?e.stalls+1:0;
            if(Number.isFinite(top))e.scroll_peak=signature===e.last?Math.max(e.scroll_peak ?? top,top):top;e.last=null;e.observed_signature=null;
          }
          const empty=(comments?.progress?.empty || page.record.standard.comment_count===0) && !comments?.items.length && !comments?.more_available;
          const exhausted=comments?.progress?.end_marker===true || Number.isInteger(page.record.standard.comment_count) && comments?.items.length===page.record.standard.comment_count;
          const ended=comments?.progress?.at_end && exhausted && !comments.more_available && !comments.loading && !comments.media_pending && e.stalls>=1;
          // Confirm a terminal DOM without spending another source action on an already exhausted page.
          if(comments && !comments.truncated && (empty || comments.progress?.at_end && comments.progress?.end_marker && !comments.more_available && !comments.loading && !comments.media_pending) && e.stalls<1) {
            e.last=signature;e.observed_signature=signature;e.stable_at=this.r.now();e.read_deadline=this.r.now()+20000;state.next_at=this.r.now()+1000;return;
          }
          if(!comments || comments.truncated || empty || ended || e.stalls>=3) {
            if(comments)comments.terminal_stable=ended || empty && e.stalls>=1;
            if(comments)comments.capture_reason=empty?'visible_empty':comments.truncated?'text_truncated':ended?'loaded_end':'loaded_stall';
            queueNote();
            if (!s.profiles || !e.record.extra.author?.id) finish();
            else { e.stage='profile'; state.next_at=now; }
          } else {
            if(slot && now<(s.action_not_before||0)){state.next_at=s.action_not_before;return;}
            let sdkPlan=null,leaseScope=null;
            if(this.captureScope(s)&&s.enabled===true&&s.task?.structured_capture===true&&s.task?.comments_capture===true&&!s.pending_risk&&!s.control?.paused&&!['sending','unknown'].includes(s.risk_report?.state)&&Number.isFinite(Date.parse(s.task.lease_until))&&Date.parse(s.task.lease_until)>this.r.now()+60000&&(e.repair?s.task.repair_notes?.some(p=>p.parent===e.parent&&p.record?.standard?.note_id===e.record.standard.note_id):s.test_run?.accepted?.some(p=>p.request===e.parent&&p.note_id===e.record.standard.note_id)||s.accepted_parents?.some(p=>p.parent===e.parent&&p.owner===s.owner_id&&p.task===s.task.id&&p.lease===s.task.lease_token&&p.note===e.record.standard.note_id))&&e.structured?.body_dom_match===true&&e.structured?.observer_status==='installed'&&!e.structured?.gate&&!e.structured?.errors?.length&&await this.r.sdkAllowed?.(s)){
              leaseScope=await this.r.leaseScope?.(s.task.lease_token);alive();const plan=await this.r.probe('sdk_plan',slot?.id,{type:'plan',id:this.r.uuid(),binding:{owner:s.owner_id,test:this.captureScope(s),note:e.record.standard.note_id,generation:this.generation,lease:leaseScope}});alive();
              if(plan.gate)throw Error(plan.gate);
              if(plan.sdk_status==='wait'){e.sdk_wait_deadline ||= this.r.now()+20000;if(this.r.now()>=e.sdk_wait_deadline)throw Error('page_timeout');state.next_at=this.r.now()+1000;return;}
              e.sdk_wait_deadline=null;if(plan.sdk_status==='available')sdkPlan=plan.sdk_plan;
            }
            const guardAt=this.r.now(), admitted=await this.admit(s,'comment',alive,signal);
            e.timings.guards++;e.timings.guard_ms+=Math.max(0,this.r.now()-guardAt);if(!admitted)return;
            e.last=signature;if(Number.isFinite(comments?.progress?.top))e.scroll_peak=Math.max(e.scroll_peak ?? comments.progress.top,comments.progress.top);e.observed_signature=null;e.read_deadline=this.r.now()+20000;e.rounds++;state.next_at=Math.max(this.r.now()+250,s.action_not_before||0);await this.save(s);alive();
            this.assertTest(s);const actionAt=this.r.now();let progress;
            if(sdkPlan){
              const id=this.r.uuid(),binding={owner:s.owner_id,test:this.captureScope(s),note:e.record.standard.note_id,generation:this.generation,lease:leaseScope};
              this.captureMetrics(s).sdk_timing ||= {attempts:0,accepted:0,fallbacks:0,dom_actions:0};this.captureMetrics(s).sdk_timing.attempts++;s.sdk_pending={id,status:'sending'};
              e.sdk_pending={id,status:'sending',operation:sdkPlan,owner:s.owner_id,test:this.captureScope(s),lease:s.task.lease_token};await this.save(s);alive();this.assertTest(s);
              progress=await this.r.probe('sdk_action',slot?.id,{type:'action',id,binding,operation:sdkPlan,grant:{...binding,...sdkPlan,id,allowed:true,expires:this.r.now()+10000}});alive();
              if(progress.gate){e.sdk_pending.status='risk';s.sdk_pending.status='risk';await this.save(s);throw Error(progress.gate);}
              if(['not_sent','stale'].includes(progress.sdk_status)){e.sdk_pending.status='not_sent';s.sdk_pending.status='not_sent';e.last=null;e.observed_signature=null;e.stalls=0;state.next_at=Math.max(this.r.now()+1000,s.action_not_before||0);await this.save(s);return;}
              if(progress.sdk_status!=='accepted'){e.sdk_pending.status='unknown';s.sdk_pending.status='unknown';s.sdk_unknown=true;await this.save(s);throw Error('sdk_unknown');}
              e.sdk_pending.status='accepted';s.sdk_pending.status='accepted';this.captureMetrics(s).sdk_timing.accepted++;await this.save(s);alive();
            }else {if(this.captureScope(s)){this.captureMetrics(s).sdk_timing ||= {attempts:0,accepted:0,fallbacks:0,dom_actions:0};this.captureMetrics(s).sdk_timing.fallbacks++;this.captureMetrics(s).sdk_timing.dom_actions++;}progress=await this.r.probe('comments',slot?.id);}alive();
            e.timings.actions++;e.timings.action_ms+=Math.max(0,this.r.now()-actionAt);if(progress.gate)throw new Error(progress.gate);
          }
        }
      } else if(e.stage==='profile') {
        if(!s.profiles || !e.record.extra.author?.id){finish();return;}
        this.assertTest(s);await this.r.sourceHealth?.(e.record.standard.platform);alive();
        this.assertTest(s);const grant=await this.api.rpc('profile_claim',{p_parent:e.parent},signal);alive();
        if(!grant || typeof grant.allowed!=='boolean')throw new Error('invalid_receipt');
        if(!grant.allowed){
          if(grant.reason==='action_gap' && Number.isFinite(grant.wait_ms) && grant.wait_ms>=0 && grant.wait_ms<=60000){state.next_at=this.r.now()+Math.max(1000,grant.wait_ms);return;}
          finish();return; // Optional work never holds the base task through cooldown/cache/quota.
        }
        const p=platform.profileURL(grant.url);
        if(p.id!==e.record.extra.author.id)throw new Error('wrong_note');
        e.stage='profile_read';e.deadline=now+120000;e.profile_grant=grant.token;state.next_at=this.r.now()+1000;await this.save(s);alive();
        const destination=e.author_navigation && platform.profileURL(e.author_navigation).id===p.id ? e.author_navigation : p.url;
        this.assertTest(s);await this.r.open(destination,false,slot?.id);alive();
      } else if(e.stage==='profile_read') {
        if(!s.profiles){finish();return;}
        this.assertTest(s);const page=await this.r.probe('profile',slot?.id);alive();if(page.gate)throw new Error(page.gate);
        if(page.ready && page.profile?.author_id===e.record.extra.author.id){
          s.outbox.push({request:this.r.uuid(),parent:e.parent,kind:'profile',record:{...page.profile,grant:e.profile_grant}});finish();
        } else if(now>=e.deadline)finish();else state.next_at=now+30000;
      } else finish();
    }
    checkPage(page, s, now) {
      now = Math.max(now, this.r.now());
      if (page.gate) throw new Error(page.gate);
      if (page.ready) s.last_error = null;
      if (page.reopen) {
        if (s.phase === 'search') throw new Error('navigation_failed');
        s.phase = 'reopen_note'; s.search_round = 0; s.next_at = now + 30000; return;
      }
      if (!page.ready) { if (now >= s.page_deadline) throw new Error(['navigation_uncommitted','page_loading','content_unavailable','probe_timeout'].includes(page.reason) ? page.reason : 'page_timeout'); s.next_at = now + (s.phase==='search'||s.fast_note?1000:30000); }
    }
  }
  root.CrowdAgent = CrowdAgent;
})(globalThis);
