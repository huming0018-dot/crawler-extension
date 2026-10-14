/* Two detail slots in the existing agent; account admission and outbox stay shared. */
(function(root) {
  'use strict';
  const C=root.CrowdCore,P=root.CrowdAgent.prototype;
  P.poolBusy=function(s) {return !!s.work_slots?.length;};
  P.poolProbe=function(slot,s) {
    this.assertTest(s);
    this.poolJobs ||= new Map();this.poolResults ||= new Map();
    if(this.poolJobs.has(slot.id))return;
    const generation=this.generation,nonce=slot.nonce;
    const job=this.r.probe('note_ready',slot.id).then(page=>({page}),error=>({error:error.message}));
    this.poolJobs.set(slot.id,job);
    job.then(result=>{
      if(this.generation!==generation)return;
      this.poolResults.set(slot.id,{...result,nonce});this.poolWake=true;
    }).finally(()=>{
      if(this.poolJobs.get(slot.id)===job)this.poolJobs.delete(slot.id);
      if(this.generation===generation && !this.active)this.tick().catch(()=>{});
    });
  };
  P.parallelStep=async function(s,alive,signal) {
    const now=this.r.now(),slotLimit=s.task?.structured_capture?1:2;s.work_slots ||= [];
    if(!await this.r.poolAllowed?.())throw Error('parallel_unavailable');alive();
    // A changed lease must not move unfinished work into a new task.
    for(const slot of s.work_slots)if(slot.task!==s.task.id || slot.lease!==s.task.lease_token)throw Error('pool_recovery_required');
    s.pool_version=1;s.phase='parallel';
    this.poolWake=false;
    for(const slot of [...s.work_slots]) {
      const ready=this.poolReadySlots?.get(slot.id);this.poolReadySlots?.delete(slot.id);
      const readWake=ready?.generation===this.generation && ready.target===slot.note_id && now>=(s.retry_at||0);
      if(slot.phase==='unknown')throw Error('pool_recovery_required');
      if(slot.phase==='opening') {
        // A worker restart only probes an existing, persisted owned tab.
        this.assertTest(s);const page=await this.r.probe('note_ready',slot.id);alive();
        slot.phase='note';this.poolResults ||= new Map();this.poolResults.set(slot.id,{page,nonce:slot.nonce});
      }
      if(slot.phase==='note') {
        const result=this.poolResults?.get(slot.id);
        if(result) {
          this.poolResults.delete(slot.id);
          if(result.nonce!==slot.nonce)continue;
          if(result.error)throw Error(result.error);
          const page=result.page;
          if(page.gate)throw Error(page.gate);
          if(page.ready) {
            if(page.record?.standard?.note_id!==slot.note_id)throw Error('wrong_note');
            await this.r.sourceHealth?.(s.task.platform||'xiaohongshu');alive();
            C.validate(page.record);slot.data_ready_at=now;
            page.record.extra.discovery={method:'task_search',candidate:s.card_meta?.[slot.note_id]||null};
            const repair=slot.repair;const request=repair?repair.parent:this.r.uuid();slot.request=request;
            if(!repair)s.outbox.push({request,task:s.task.id,lease:s.task.lease_token,record:page.record,test_run_id:slot.test_run_id || null});
            else {slot.base_received=true;const current=page.record;page.record=JSON.parse(JSON.stringify(repair.record));page.record.extra.comments=current.extra.comments;page.record.standard.comment_count=current.standard.comment_count;}
            slot.enrichment={structured:page.structured||null,parent:request,author_navigation:page.author_navigation||null,record:JSON.parse(JSON.stringify(page.record)),stage:'comments',repair:!!repair,rounds:0,stalls:0,last:null};
            slot.phase='enrich';slot.next_at=now;
            await this.save(s);alive();
            // Send each durable result immediately, without waiting for the other page.
            if(s.outbox.length)await this.flushOutbox(s,alive,signal);
          } else if(now>=slot.page_deadline) {
            slot.phase='unknown';slot.failure=page.reason||'page_timeout';
            await this.save(s);throw Error('pool_recovery_required');
          } else {slot.next_at=now+1000;slot.wait_kind='page';}
        } else if(now>=(slot.next_at||0) || readWake) {
          slot.next_at=now+1000;this.poolProbe(slot,s);
        }
      }
      // Give the vacant detail slot the next account-wide admission before optional comments.
      const inflight=s.work_slots.filter(item=>!item.base_received).length;
      const nextDetail=s.work_slots.length<slotLimit && s.candidates.length &&
        (s.task.repair_only || Math.min(s.task.target-s.task.received-inflight,(s.task.remaining_today ?? s.task.target)-inflight,this.testRemaining(s))>0);
      if(slot.phase==='enrich' && slot.base_received && (now>=(slot.next_at||0) || readWake) && !s.outbox.length && !nextDetail) {
        await this.enrich(s,alive,signal,slot);alive();
        await this.save(s);alive();
        if(s.outbox.length)await this.flushOutbox(s,alive,signal);
      }
      if(slot.phase==='done' && !s.outbox.some(item=>item.request===slot.request || item.parent===slot.request)) {
        await this.r.closeSlot(slot.id);alive();
        s.work_slots=s.work_slots.filter(item=>item.id!==slot.id);await this.save(s);
      }
    }
    if(s.outbox.length)return;
    const inflight=s.work_slots.filter(slot=>!slot.base_received).length;
    const remaining=s.task.repair_only?s.candidates.length:Math.min(Math.min(s.task.target-s.task.received,s.task.remaining_today ?? s.task.target)-inflight,this.testRemaining(s));
    if(remaining>0 && s.work_slots.length<slotLimit && s.candidates.length && now>= (s.action_not_before||0) && now>=(s.retry_at||0)) {
      const url=s.candidates[0],id=C.taskPlatform(s.task).noteURL(url).id;
      const repair=s.task.repair_notes?.find(n=>n.record.standard.note_id===id && !s.repaired?.includes(n.parent));
      if(s.task.repair_only && !repair)throw Error('pool_recovery_required');
      if(!await this.admit(s,'detail',alive,signal,id)) {
        if(['known_note','note_busy'].includes(s.last_error)){s.candidates.shift();s.seen.push(id);await this.save(s);}
      } else {
        s.candidates.shift();s.seen.push(id);s.visits++;
        const slot={id:this.r.uuid(),nonce:this.r.uuid(),task:s.task.id,lease:s.task.lease_token,note_id:id,note_url:url,repair,phase:'opening',page_deadline:this.r.now()+180000,next_at:0};
        if(s.test_run?.state==='active' && !repair){s.test_run.attempts++;slot.test_run_id=s.test_run.id;}
        s.work_slots.push(slot);await this.save(s);alive();
        this.assertTest(s);await this.r.open(url,false,slot.id);alive();
        slot.phase='note';await this.save(s);alive();this.poolProbe(slot,s);
        // Admission remains account-wide. The server may add further jitter.
        if(s.control.action_wait_ms==null)s.action_not_before=Math.max(s.action_not_before||0,this.r.now()+s.control.gap_ms);
      }
    }
    if(!s.work_slots.length && (!s.candidates.length || !s.task.repair_only && (s.task.received>=s.task.target || s.task.remaining_today===0 || s.test_run && this.testRemaining(s)===0))) {
      s.phase='search_done';s.next_at=now;s.wait_kind=null;
    } else {
      const current=this.r.now(), deadlines=[];
      const detailPending=remaining>0 && s.work_slots.length<slotLimit && s.candidates.length;
      if(detailPending)deadlines.push(Math.max(current+250,s.action_not_before||0,s.retry_at||0));
      // Preserve the actor's readiness/admission deadline; a pool must not add another one-second wait.
      for(const slot of s.work_slots)if(slot.phase==='enrich' && !detailPending || slot.phase==='note')deadlines.push(Math.max(current+(slot.phase==='enrich'?250:1000),slot.next_at||0));
      s.next_at=deadlines.length?Math.min(...deadlines):current+30000;
    }
    await this.save(s);await this.schedule(s,s.next_at);
    return s.phase==='search_done' || this.poolWake;
  };
})(globalThis);
