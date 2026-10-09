/* Alarm driven: each transition is durable; no long timers in a service worker. */
(function (root) {
  'use strict';
  const C = root.CrowdCore;
  class CrowdAgent {
    constructor(runtime, api) { this.r = runtime; this.api = api; this.active = null; this.generation = 0; this.recover = false; }
    async read() { return {...C.initial(), ...await this.r.storage.get('agent')}; }
    async save(s) { await this.r.storage.set('agent', s); }
    async control(s, action, alive, signal, note = null) {
      const before = this.r.now();
      let value;
      try { value = await this.api.rpc('guard', {p_action: action, p_task: s.task?.id || null, p_note: note}, signal); }
      catch (error) { if (error.status === 401 || error.status === 403) throw error; throw new Error('control_unavailable'); }
      alive();
      if (value?.error) throw new Error(value.error);
      // A broken/older backend cannot silently disable limits. No offline page actions.
      const caps = {search:30, detail:60, comment:120, scroll:120};
      if (!value || !Number.isSafeInteger(value.version) || value.version < 1 ||
        !Number.isSafeInteger(value.ttl_ms) || value.ttl_ms < 1 || value.ttl_ms > 600000 ||
        typeof value.paused !== 'boolean' || typeof value.allowed !== 'boolean' || (value.allowed && (value.paused || value.reason !== null)) ||
        !Number.isFinite(value.wait_ms) || value.wait_ms < 0 || value.wait_ms > 172800000 ||
        !Number.isFinite(value.gap_ms) || value.gap_ms < 30000 ||
        Object.entries(caps).some(([key,max]) => !Number.isInteger(value.caps?.[key]) || value.caps[key] < 1 || value.caps[key] > max || !Number.isInteger(value.counts?.[key]) || value.counts[key] < 0) ||
        (s.control && value.version < s.control.version) || this.r.now() - before > 30000 || this.r.now() < before)
        throw new Error('control_unavailable');
      s.control = value; s.control_checked = this.r.now(); s.control_expires = before + value.ttl_ms;
      s.control_error = false;
      if (['captcha','rate_limit'].includes(action)) s.pending_risk = null;
      return value;
    }
    async admit(s, action, alive, signal, note = null) {
      await this.r.sourceHealth?.(s.task?.platform||'xiaohongshu');alive();
      const value = await this.control(s, action, alive, signal, note);
      if (!value.allowed || value.paused) {
        s.last_error = value.reason || 'control_unavailable';
        s.next_at = this.r.now() + Math.max(30000, value.wait_ms);
        await this.save(s); await this.r.schedule(s.next_at); return false;
      }
      // The server has already charged this attempt, even if open/probe later fails.
      s.last_error = null; await this.save(s); alive(); return true;
    }
    async start() {
      if (this.maintenance) throw new Error('update_in_progress');
      const generation = this.generation;
      await this.active?.catch(() => {});
      if (this.maintenance) throw new Error('update_in_progress');
      if (generation !== this.generation) throw new Error('cancelled');
      // Hold the same single-writer lock while status IO is pending.
      if (this.active) return this.start();
      this.active = this.activate(generation).finally(() => { this.active = null; });
      return this.active;
    }
    async activate(generation) {
      const s = await this.read();
      if (s.consent !== C.CONSENT) throw new Error('consent_required');
      await this.r.sourceHealth?.(s.task?.platform||'xiaohongshu');if(generation!==this.generation)throw new Error('cancelled');
      const status = await this.api.rpc('status');
      if (generation !== this.generation) throw new Error('cancelled');
      if (status.participant?.status !== 'approved') throw new Error('approval_required');
      if (s.enrichment) s.enrichment.stage='done';
      if (s.phase === 'note') s.phase = 'reopen_note';
      if (s.phase === 'search') { s.phase = 'idle'; s.search_round = 0; }
      s.enabled = true; s.delivery_enabled = true; s.delivery_error = null; s.last_error = null; s.page_failures = 0; s.control_checked = 0; s.last_tick = this.r.now();
      // Continuing never clears a durable deadline or a pending risk report.
      await this.save(s); await this.r.schedule(this.r.now() + 1000);
    }
    async stop(reason = 'user_stopped', {keepPage = false, drain = false, expectedOwner = null} = {}) {
      if(expectedOwner&&expectedOwner!==(await this.r.storage.get('session'))?.user?.id)return;
      this.generation++; this.controller?.abort();
      // Wait for the single writer before persisting the stop; prevent stale saves.
      await this.active?.catch(() => {});
      if(expectedOwner&&expectedOwner!==(await this.r.storage.get('session'))?.user?.id)return;
      const s = expectedOwner?{...C.initial(),...await this.r.storage.get('agent:'+expectedOwner)}:await this.read(); s.enabled = false; s.delivery_enabled = drain; s.last_error = reason;
      if(['captcha','rate_limit'].includes(reason)){s.pending_risk=reason;s.next_at=Math.max(s.next_at,this.r.now()+(reason==='rate_limit'?86400000:1800000));}
      if(expectedOwner)await this.r.storage.set('agent:'+expectedOwner,s);else await this.save(s);
      if(expectedOwner&&expectedOwner!==(await this.r.storage.get('session'))?.user?.id)return;
      await this.r.cancel(); if (!keepPage) await this.r.close(); await this.repairDelivery();
    }
    async tick(recover = false, deliveryOnly = false) {
      if (this.maintenance) return;
      this.recover ||= recover;
      if (this.active) return this.active;
      this.controller = new AbortController();
      const gen = this.generation;
      const alive = () => { if (gen !== this.generation || this.controller.signal.aborted) throw new Error('cancelled'); };
      this.active = this.step(alive, this.controller.signal, deliveryOnly).finally(() => { this.active = null; });
      return this.active;
    }
    async step(alive, signal, deliveryOnly = false) {
      let s = await this.read(); const recover = this.recover; this.recover = false;
      if (!s.enabled && !(deliveryOnly && s.delivery_enabled && s.outbox.length)) return;
      if (s.consent !== C.CONSENT) { s.enabled = false; s.delivery_enabled = false; s.last_error = 'consent_required'; await this.save(s); await this.r.cancel(); await this.r.cancelDelivery?.(); return; }
      if (deliveryOnly) {
        const stoppedReason = !s.enabled ? s.last_error : null;
        try {
          alive();
          if (s.outbox.length) { await this.flushOutbox(s, alive, signal); s.delivery_error = null; await this.save(s); }
        } catch (error) {
          alive();
          const auth = error.status === 401 || error.status === 403;
          s.delivery_error = auth ? 'backend_login_required' : error.message === 'review_local_rejections' ? error.message : 'backend_unavailable';
          if (auth || error.message === 'review_local_rejections') { s.delivery_enabled = false; s.enabled = false; await this.r.cancel(); }
          if (s.outbox.length) {
            const item = s.outbox[0]; item.retries = (item.retries || 0) + 1;
            item.retry_at = this.r.now() + Math.min(900000, 60000 * 2 ** Math.min(item.retries - 1, 4));
          }
          await this.save(s);
        }
        if (stoppedReason) { s.last_error = stoppedReason; await this.save(s); }
        await this.repairDelivery(); return;
      }
      await this.repairDelivery();
      const now = this.r.now();
      const day = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
      if (s.day !== day) { s.day = day; s.visits = 0; }
      try {
        alive();
        // Restore active work, never a stopped/blocked participant. A long
        // suspension must restart dwell; wake detection is an alarm-gap heuristic.
        if (recover || (s.last_tick != null && now - s.last_tick > 120000)) {
          if (s.enrichment) { s.enrichment.stage = 'done'; }
          if (s.phase === 'note') { s.phase = 'reopen_note'; s.loaded_at = null; s.scrolls = 0; }
          // An admitted search survives suspension. Probe its existing page and
          // original deadline; resetting to idle would charge and navigate again.
          // Keep persisted cooldowns, quota waits and evidence retry deadlines.
        }
        s.last_tick = now; await this.save(s); alive();
        // Repair a cleared alarm before network IO can suspend this worker.
        await this.r.schedule(Math.max(s.next_at, now + 30000)); alive();
        // Independent of task caching and collection waits. Explicit user stop still cancels work.
        if (s.pending_risk || !s.control || now >= (s.control_checked || 0) + 300000 || now < s.control_checked) {
          try { await this.control(s, s.pending_risk || 'control', alive, signal); }
          catch (error) { alive(); s.control_error = true; if (error.status === 401 || error.status === 403) throw error; }
          await this.save(s);
        }
        // Recheck only a rules-revision change, once, with the original evidence and UUID.
        const revision=s.control?.relevance_revision || 0;
        const retry=s.rejected.findIndex(item=>item.reason==='unrelated_note' && !item.kind && item.task===s.task?.id &&
          (item.relevance_revision || 0)<revision && now-Date.parse(item.record?.standard?.captured_at)<86400000);
        if(!s.outbox.length && retry>=0){
          const item=s.rejected.splice(retry,1)[0];item.relevance_revision=revision;item.lease=s.task.lease_token;
          s.outbox.push(item);await this.save(s);alive();
        }
        // Delivery runs even during collection cooldown. One stable UUID per record.
        if (s.outbox.length) { await this.flushOutbox(s, alive, signal); return; }
        if (s.pending_risk || !s.control || this.r.now() >= s.control_expires || this.r.now() < s.control_checked) {
          s.last_error = 'control_unavailable'; await this.save(s); return;
        }
        if (s.control.paused || ['captcha','rate_limit','session_rest'].includes(s.control.reason) && now < s.control_checked + s.control.wait_ms) {
          s.last_error = s.control.reason || 'global_pause'; await this.save(s); return;
        }
        if (s.next_at > now) { await this.r.schedule(s.next_at); return; }
        if (s.visits >= 60) { s.next_at = now + 3600000; await this.save(s); await this.r.schedule(s.next_at); return; }
        if (s.enrichment) {
          await this.enrich(s, alive, signal); await this.save(s); await this.r.schedule(Math.max(s.next_at,now+30000)); return;
        }
        if (!s.task || Date.parse(s.task.lease_until) < now + 180000) {
          const claimed = await this.api.rpc('claim', {p_task: s.task?.id || null}, signal); alive();
          if (claimed.error === 'daily_quota') { s.next_at = C.quotaRetry(claimed, now); s.last_error = 'daily_quota'; await this.save(s); await this.r.schedule(s.next_at); return; }
          if (claimed.error) throw new Error(claimed.error);
          if (!claimed.task) { s.task = null; s.phase = 'idle'; s.next_at = now + 300000; }
          else {
            if (s.task?.id !== claimed.task.id || s.task?.lease_token !== claimed.task.lease_token) {
              s.phase = 'idle'; s.seen = []; s.candidates = []; s.search_round = 0;
              s.note_url = null; s.note_id = null;
            }
            s.task = claimed.task;
          }
        }
        if (!s.task) { await this.save(s); await this.r.schedule(s.next_at); return; }
        const platform = C.taskPlatform(s.task);
        if (s.task.received >= s.task.target || (s.phase === 'search_done' && !s.candidates.length)) {
          const finished = await this.api.rpc('finish', {p_task: s.task.id, p_lease: s.task.lease_token}, signal); alive();
          if (!finished || (finished.error && finished.error !== 'lease_lost') ||
            (!finished.error && (!['open','complete','exhausted','closed'].includes(finished.status) || !Number.isSafeInteger(finished.received) || finished.received < 0))) throw new Error('backend_unavailable');
          s.last_error = finished.error || null;
          s.task = null; s.phase = 'idle'; s.next_at = now + 60000; await this.r.close();
        } else if (s.task.remaining_today === 0) {
          s.next_at = now + 3600000;
        } else if (s.phase === 'idle') {
          if (!await this.admit(s, 'search', alive, signal)) return;
          // One alarm interval for initial search loading; never auto-reopen it.
          s.phase = 'search'; s.page_deadline = this.r.now() + 30000; s.next_at = s.page_deadline;
          // Persist before navigation: a worker restart after tabs.update must
          // resume probing instead of opening/charging the same search again.
          await this.save(s); alive();
          await this.r.open(platform.searchURL(s.task.query)); alive();
        } else if (s.phase === 'search') {
          const page = await this.r.probe('search'); alive();
          const normalize = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
          if ('keyword' in page && normalize(page.keyword) !== normalize(s.task.query)) throw new Error('page_mismatch');
          this.checkPage(page, s, now);
          if (page.ready) {
            const known = new Set(Array.isArray(s.task.known_note_ids) ? s.task.known_note_ids : []);
            const found = new Map(s.candidates.map(url => [platform.noteURL(url).id, url]).filter(([id]) => !known.has(id)));
            for (const url of page.links) { try { const note = platform.noteURL(url); if (!known.has(note.id) && !s.seen.includes(note.id) && !s.history.includes(note.id)) found.set(note.id, note.navigation); } catch (_) {} }
            s.card_meta ||= {};
            for (const card of page.cards || []) { try { s.card_meta[platform.noteURL(card.url).id] = {title:card.title,author_display:card.author_display}; } catch (_) {} }
            const normalizeTerm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu,'');
            const score = url => (s.task.anchor_terms || []).filter(term => normalizeTerm(s.card_meta[platform.noteURL(url).id]?.title).includes(normalizeTerm(term))).length;
            s.candidates = [...found.values()].sort((a,b) => score(b)-score(a)).slice(0, 80);
            s.card_meta = Object.fromEntries(s.candidates.map(url => {const id=platform.noteURL(url).id;return [id,s.card_meta[id] || {}];}));
            s.search_round = (s.search_round || 0) + 1;
            // Stop expanding once enough unseen candidates exist for this task.
            // This saves page actions for small trials without changing server gaps.
            const needed = Math.max(1, s.task.target - s.task.received);
            const matching = s.task.anchor_terms?.length ? s.candidates.filter(url => score(url) > 0).length : s.candidates.length;
            if (s.search_round < 3 && matching < needed) { if (!await this.admit(s, 'scroll', alive, signal)) { s.search_round--; await this.save(s); return; } await this.r.probe('scroll'); alive(); s.next_at = now + C.between(30000, 45000, this.r.random); }
            else { s.search_round = 0; s.phase = 'search_done'; s.next_at = now + 30000; }
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
          s.dwell_ms = C.between(45000, 90000, this.r.random); s.page_deadline = now + 180000;
          s.next_at = now + 30000; await this.save(s);
          await this.r.open(url); alive();
        } else if (s.phase === 'reopen_note') {
          if (!s.note_url) { s.phase = 'idle'; s.next_at = now + 30000; }
          else {
            if (!await this.admit(s, 'detail', alive, signal, s.note_id)) {
              if (['known_note','note_busy'].includes(s.last_error)) { s.phase = 'search_done'; s.note_url = null; s.note_id = null; await this.save(s); }
              return;
            }
            await this.r.open(s.note_url); alive(); s.phase = 'note'; s.loaded_at = null; s.scrolls = 0; s.comment_rounds = 0; s.comment_snapshot = null; s.comment_stalls = 0;
            s.page_deadline = now + 180000; s.next_at = now + 30000;
          }
        } else if (s.phase === 'note') {
          const page = await this.r.probe('note'); alive(); this.checkPage(page, s, now);await this.r.sourceHealth?.(s.task?.platform||'xiaohongshu');alive();
          if (page.ready) {
            if (page.record.standard.note_id !== s.note_id) throw new Error('wrong_note');
            if (s.loaded_at === null) s.loaded_at = now;
            if (now - s.loaded_at < s.dwell_ms || s.scrolls < 2) {
              if (!await this.admit(s, 'scroll', alive, signal)) return;
              await this.r.probe('scroll'); alive(); s.scrolls++; s.next_at = now + C.between(30000, 45000, this.r.random);
            } else if (this.r.splitCapture && s.control.observations === 1) {
              C.validate(page.record);
              page.record.extra.discovery = {method:'task_search',candidate:s.card_meta?.[s.note_id] || null};
              const request = this.r.uuid();
              s.outbox.push({request,task:s.task.id,lease:s.task.lease_token,record:page.record});
              s.enrichment = {parent:request,author_navigation:page.author_navigation || null,record:JSON.parse(JSON.stringify(page.record)),stage:'comments',rounds:0,stalls:0,last:null};
              s.phase = 'enrich'; s.next_at = now+30000;
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
                const progress = await this.r.probe('comments'); alive(); this.checkPage(progress, s, now);
              } else {
                C.validate(page.record);
                s.outbox.push({request: this.r.uuid(), task: s.task.id, lease: s.task.lease_token, record: page.record});
                s.page_failures = 0;
                s.phase = 'search_done'; s.notes_in_session++; s.note_url = null; s.note_id = null; s.loaded_at = null;
                s.next_at = now + (s.notes_in_session % 8 === 0 ? C.between(300000, 600000, this.r.random) : C.between(30000, 60000, this.r.random));
              }
            }
          }
        }
        await this.save(s); await this.r.schedule(Math.max(s.next_at, now + 30000));
      } catch (err) {
        if (err.message === 'cancelled' || signal.aborted) return;
        alive(); s.last_error = err.message;
        if (['captcha','rate_limit'].includes(err.message)) {
          // Persist before IO. If reporting fails, the next start must report before any action.
          s.pending_risk = err.message;
          s.next_at = Math.max(s.next_at, now + (err.message === 'rate_limit' ? 86400000 : 1800000));
          await this.save(s);
          try { await this.control(s, err.message, alive, signal); } catch (_) { alive(); }
        }
        s.failure_kind = ['captcha','rate_limit'].includes(err.message) ? 'platform_gate' :
          ['login_required','identity_verification_required','platform_identity_changed'].includes(err.message) ? 'platform_login' :
          ['navigation_failed','navigation_uncommitted','page_loading','probe_timeout'].includes(err.message) ? 'page_transport' :
          ['page_timeout','content_unavailable','wrong_note','invalid_content','invalid_comments','invalid_count','page_mismatch'].includes(err.message) ? 'page_contract' : 'backend';
        const pageFailure = ['page_timeout', 'page_loading', 'content_unavailable', 'probe_timeout', 'wrong_note', 'invalid_content', 'invalid_comments', 'invalid_count'].includes(err.message);
        if (pageFailure) {
          s.page_failures = (s.page_failures || 0) + 1;
          if (s.page_failures >= 3) {
            s.enabled = false; await this.save(s); await this.r.cancel(); return;
          }
        }
        if (err.message==='navigation_uncommitted') await this.r.trace?.('navigation_timeout');
        if (['identity_verification_required','platform_identity_changed','navigation_failed', 'navigation_uncommitted', 'page_loading', 'page_timeout', 'content_unavailable', 'probe_timeout', 'captcha', 'rate_limit', 'login_required', 'backend_login_required', 'page_mismatch', 'approval_required', 'consent_required', 'review_local_rejections', 'unsupported_platform'].includes(err.message) || err.status === 401 || err.status === 403) {
          s.enabled = false; await this.save(s); await this.r.cancel(); return;
        }
        if (pageFailure || err.message === 'wrong_note') {
          s.phase = 'idle'; s.search_round = 0; s.candidates = []; s.note_url = null; s.note_id = null;
        }
        s.next_at = Math.max(s.next_at, now + (pageFailure ? 60000 * 2 ** (s.page_failures - 1) : 60000));
        if (s.outbox.length) { const item = s.outbox[0]; item.retries = (item.retries || 0) + 1; item.retry_at = now + Math.min(900000, 60000 * 2 ** Math.min(item.retries - 1, 4)); s.next_at = item.retry_at; }
        await this.save(s); await this.r.schedule(s.next_at);
      }
    }
    async scheduleReceipt(s, at) {
      if (s.enabled) await this.r.schedule(at);
      else await this.r.scheduleDelivery?.();
    }
    async queueRating(proof, score, reason) {
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
      if (s.consent === C.CONSENT && (s.enabled || s.delivery_enabled) && s.outbox.length) await this.r.scheduleDelivery?.();
      else await this.r.cancelDelivery?.();
    }
    async flushOutbox(s, alive, signal) {
      const now = this.r.now();
      const item = s.outbox[0];
      if ((item.retry_at || 0) > now) { await this.scheduleReceipt(s, item.retry_at); return; }
      if (item.kind === 'rating') {
        const receipt=await this.api.rpc('rating',{p_request:item.request,p_proof:item.proof,p_score:item.score,p_reason:item.rating_reason},signal);alive();
        if(receipt?.request!==item.request || !['rated','rejected'].includes(receipt.gate) ||
          (receipt.gate==='rated' && typeof receipt.inserted!=='boolean') ||
          (receipt.gate==='rejected' && !['invalid_rating','invalid_anchor','already_rated','request_reused'].includes(receipt.error)))throw new Error('invalid_receipt');
        if(receipt.gate==='rejected')s.rejected.push({...item,reason:receipt.error});
        s.outbox.shift();if(s.rejected.length>=20)throw new Error('review_local_rejections');await this.save(s);await this.scheduleReceipt(s,now+30000);return;
      }
      if (item.kind) {
        const receipt = await this.api.rpc('observe', {p_request:item.request,p_parent:item.parent,p_kind:item.kind,p_data:item.record}, signal); alive();
        if (!receipt || receipt.request !== item.request || !['observed','rejected'].includes(receipt.gate)) throw new Error('invalid_receipt');
        if (receipt.gate === 'rejected') s.rejected.push({...item,reason:receipt.error || 'invalid_record'});
        s.outbox.shift(); if(s.rejected.length>=20)throw new Error('review_local_rejections'); await this.save(s); await this.scheduleReceipt(s, now+30000); return;
      }
      const receipt = C.receipt(await this.api.rpc('submit', {p_request: item.request, p_task: item.task,
        p_lease: item.lease, p_record: item.record}, signal), item.request);
      alive();
      if (receipt.error === 'daily_quota') {
        item.retry_at = C.quotaRetry(receipt, now); s.last_error = 'daily_quota'; await this.save(s); await this.scheduleReceipt(s, item.retry_at); return;
      } else if (receipt.error === 'lease_expired') {
        const renewed = await this.api.rpc('claim', {p_task: item.task}, signal); alive();
        if (renewed.error === 'daily_quota') {
          item.retry_at = C.quotaRetry(renewed, now); s.last_error = 'daily_quota';
          await this.save(s); await this.scheduleReceipt(s, item.retry_at); return;
        }
        if (renewed.error) throw new Error(renewed.error);
        if (renewed.task?.id === item.task) { item.lease = renewed.task.lease_token; s.task = renewed.task; }
        else { s.rejected.push({...item, reason: 'lease_lost'}); s.outbox.shift(); s.task = null; s.phase = 'idle'; }
      } else {
        s.outbox.shift();
        if (receipt.error) {
          s.rejected.push({...item, reason: receipt.error,relevance_revision:s.control?.relevance_revision || 0});
          if (s.enrichment?.parent === item.request) { s.enrichment = null; s.phase = 'search_done'; }
        }
        else {
          s.last_error = null;
          s.received += receipt.inserted ? 1 : 0;
          s.history = [...new Set([...s.history, item.record.standard.note_id])].slice(-2000);
          if (s.task?.id === item.task) { s.task.received = receipt.task_received; if (receipt.inserted && s.task.remaining_today != null) s.task.remaining_today--; }
        }
      }
      // Failed records remain exportable; bounded by stopping, never by deleting evidence.
      if (s.rejected.length >= 20) throw new Error('review_local_rejections');
      await this.save(s); await this.scheduleReceipt(s, now + 30000); return;
    }
    mergeComments(previous, current) {
      if (!current) return previous;
      if (!previous) return JSON.parse(JSON.stringify(current));
      const result = JSON.parse(JSON.stringify(previous));
      const identity = item => item.comment_id ? 'id:'+item.comment_id : JSON.stringify([item.author_display,item.text,item.published_label,item.is_reply]);
      const seen = new Map(result.items.map(item => [identity(item),item]));
      const remap = new Map();
      for (const item of current.items) {
        let known = seen.get(identity(item));
        if (!known) {
          if (result.items.length >= 50 || JSON.stringify(result).length + JSON.stringify(item).length > 20000) {result.truncated=true;break;}
          known = {...item,key:'comment-'+(result.items.length+1),parent_key:remap.get(item.parent_key) || null};
          result.items.push(known); seen.set(identity(item),known);
        } else { const key=known.key,parent=known.parent_key; Object.assign(known,item,{key,parent_key:remap.get(item.parent_key) || parent}); }
        remap.set(item.key,known.key);
      }
      result.captured_count=result.items.length; result.complete=false;
      result.identity_method='platform_id_or_content_fingerprint';result.identity_uncertain=result.items.some(item=>!item.comment_id);
      result.loaded_count=Math.max(previous.loaded_count || 0,current.loaded_count || 0,result.items.length);
      result.omitted_count=Math.max(previous.omitted_count || 0,current.omitted_count || 0);
      result.more_available=current.more_available; result.truncated ||= current.truncated;
      return result;
    }
    async enrich(s, alive, signal) {
      const e=s.enrichment, now=this.r.now(), platform=C.platform(e.record.standard.platform);
      const queueNote = () => {
        if(e.note_queued)return;
        const comments=e.record.extra.comments;
        if(comments){
          while(JSON.stringify(e.record).length>55000 && comments.items.length){comments.items.pop();comments.truncated=true;comments.omitted_count=(comments.omitted_count||0)+1;}
          comments.captured_count=comments.items.length;
          C.validate(e.record);s.outbox.push({request:this.r.uuid(),parent:e.parent,kind:'note',record:JSON.parse(JSON.stringify(e.record))});
        }
        e.note_queued=true;
      };
      const finish = () => {queueNote();s.enrichment=null;s.phase='search_done';s.note_url=null;s.note_id=null;s.loaded_at=null;s.notes_in_session++;s.next_at=now+30000;};
      if (Date.parse(s.task?.lease_until || '') < now+60000) e.stage='done';
      if (e.stage==='comments') {
        const page=await this.r.probe('note');alive();
        if(page.gate)throw new Error(page.gate);
        if(!page.ready || page.record.standard.note_id!==e.record.standard.note_id){e.stage='done';}
        else {
          for(const key of ['like_count','collect_count','comment_count','view_count','captured_at']) {
            if(key in page.record.standard)e.record.standard[key]=page.record.standard[key];
          }
          e.record.extra.field_observations=page.record.extra.field_observations;
          e.record.extra.metric_labels=page.record.extra.metric_labels;
          e.record.extra.comments=this.mergeComments(e.record.extra.comments,page.record.extra.comments);
          // Keep the immutable base text/title; only supplement visible observations.
          const comments=e.record.extra.comments;
          const signature=JSON.stringify(comments?.items.map(item=>[item.comment_id,item.text]) || []);
          if(e.last!==null){e.stalls=signature===e.last?e.stalls+1:0;e.last=null;}
          const empty=page.record.standard.comment_count===0 && !comments?.items.length && !comments?.more_available;
          if(!comments || comments.truncated || empty || e.rounds>=4 || e.stalls >= (comments.more_available?2:1)) {
            queueNote();
            e.stage='profile';s.next_at=now+30000;
          } else {
            if(!await this.admit(s,'comment',alive,signal))return;
            e.last=signature;e.rounds++;s.next_at=this.r.now()+30000;await this.save(s);alive();
            const progress=await this.r.probe('comments');alive();if(progress.gate)throw new Error(progress.gate);
          }
        }
      } else if(e.stage==='profile') {
        if(!s.profiles || !e.record.extra.author?.id){finish();return;}
        await this.r.sourceHealth?.(e.record.standard.platform);alive();
        const grant=await this.api.rpc('profile_claim',{p_parent:e.parent},signal);alive();
        if(!grant || typeof grant.allowed!=='boolean')throw new Error('invalid_receipt');
        if(!grant.allowed){finish();return;} // Optional work never holds the base task through cooldown/cache/quota.
        const p=platform.profileURL(grant.url);
        if(p.id!==e.record.extra.author.id)throw new Error('wrong_note');
        e.stage='profile_read';e.deadline=now+120000;e.profile_grant=grant.token;s.next_at=now+30000;await this.save(s);alive();
        const destination=e.author_navigation && platform.profileURL(e.author_navigation).id===p.id ? e.author_navigation : p.url;
        await this.r.open(destination);alive();
      } else if(e.stage==='profile_read') {
        if(!s.profiles){finish();return;}
        const page=await this.r.probe('profile');alive();if(page.gate)throw new Error(page.gate);
        if(page.ready && page.profile?.author_id===e.record.extra.author.id){
          s.outbox.push({request:this.r.uuid(),parent:e.parent,kind:'profile',record:{...page.profile,grant:e.profile_grant}});finish();
        } else if(now>=e.deadline)finish();else s.next_at=now+30000;
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
      if (!page.ready) { if (now >= s.page_deadline) throw new Error(['navigation_uncommitted','page_loading','content_unavailable','probe_timeout'].includes(page.reason) ? page.reason : 'page_timeout'); s.next_at = now + 30000; }
    }
  }
  root.CrowdAgent = CrowdAgent;
})(globalThis);
