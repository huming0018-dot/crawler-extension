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
      const generation = this.generation;
      await this.active?.catch(() => {});
      if (generation !== this.generation) throw new Error('cancelled');
      // Hold the same single-writer lock while status IO is pending.
      if (this.active) return this.start();
      this.active = this.activate(generation).finally(() => { this.active = null; });
      return this.active;
    }
    async activate(generation) {
      const s = await this.read();
      if (s.consent !== C.CONSENT) throw new Error('consent_required');
      const status = await this.api.rpc('status');
      if (generation !== this.generation) throw new Error('cancelled');
      if (status.participant?.status !== 'approved') throw new Error('approval_required');
      if (s.phase === 'note') s.phase = 'reopen_note';
      if (s.phase === 'search') { s.phase = 'idle'; s.search_round = 0; }
      s.enabled = true; s.last_error = null; s.page_failures = 0; s.control_checked = 0; s.last_tick = this.r.now();
      // Continuing never clears a durable deadline or a pending risk report.
      await this.save(s); await this.r.schedule(this.r.now() + 1000);
    }
    async stop(reason = 'user_stopped') {
      this.generation++; this.controller?.abort();
      // Wait for the single writer before persisting the stop; prevent stale saves.
      await this.active?.catch(() => {});
      const s = await this.read(); s.enabled = false; s.last_error = reason;
      await this.save(s); await this.r.cancel(); await this.r.close();
    }
    async tick(recover = false) {
      this.recover ||= recover;
      if (this.active) return this.active;
      this.controller = new AbortController();
      const gen = this.generation;
      const alive = () => { if (gen !== this.generation || this.controller.signal.aborted) throw new Error('cancelled'); };
      this.active = this.step(alive, this.controller.signal).finally(() => { this.active = null; });
      return this.active;
    }
    async step(alive, signal) {
      let s = await this.read(); const recover = this.recover; this.recover = false;
      if (!s.enabled) return;
      if (s.consent !== C.CONSENT) { s.enabled = false; s.last_error = 'consent_required'; await this.save(s); await this.r.cancel(); return; }
      const now = this.r.now();
      const day = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
      if (s.day !== day) { s.day = day; s.visits = 0; }
      try {
        alive();
        // Restore active work, never a stopped/blocked participant. A long
        // suspension must restart dwell; wake detection is an alarm-gap heuristic.
        if (recover || (s.last_tick != null && now - s.last_tick > 120000)) {
          if (s.phase === 'note') { s.phase = 'reopen_note'; s.loaded_at = null; s.scrolls = 0; }
          else if (s.phase === 'search') { s.phase = 'idle'; s.search_round = 0; }
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
        // Delivery runs even during collection cooldown. One stable UUID per record.
        if (s.outbox.length) {
          const item = s.outbox[0];
          if ((item.retry_at || 0) > now) { await this.r.schedule(item.retry_at); return; }
          const receipt = C.receipt(await this.api.rpc('submit', {p_request: item.request, p_task: item.task,
            p_lease: item.lease, p_record: item.record}, signal), item.request);
          alive();
          if (receipt.error === 'daily_quota') {
            item.retry_at = C.quotaRetry(receipt, now); s.last_error = 'daily_quota'; await this.save(s); await this.r.schedule(item.retry_at); return;
          } else if (receipt.error === 'lease_expired') {
            const renewed = await this.api.rpc('claim', {p_task: item.task}, signal); alive();
            if (renewed.error === 'daily_quota') {
              item.retry_at = C.quotaRetry(renewed, now); s.last_error = 'daily_quota';
              await this.save(s); await this.r.schedule(item.retry_at); return;
            }
            if (renewed.error) throw new Error(renewed.error);
            if (renewed.task?.id === item.task) { item.lease = renewed.task.lease_token; s.task = renewed.task; }
            else { s.rejected.push({...item, reason: 'lease_lost'}); s.outbox.shift(); s.task = null; s.phase = 'idle'; }
          } else {
            s.outbox.shift();
            if (receipt.error) s.rejected.push({...item, reason: receipt.error});
            else {
              s.last_error = null;
              s.received += receipt.inserted ? 1 : 0;
              s.history = [...new Set([...s.history, item.record.standard.note_id])].slice(-2000);
              if (s.task?.id === item.task) { s.task.received = receipt.task_received; if (receipt.inserted && s.task.remaining_today != null) s.task.remaining_today--; }
            }
          }
          // Failed records remain exportable; bounded by stopping, never by deleting evidence.
          if (s.rejected.length >= 20) throw new Error('review_local_rejections');
          await this.save(s); await this.r.schedule(now + 30000); return;
        }
        if (s.pending_risk || !s.control || this.r.now() >= s.control_expires || this.r.now() < s.control_checked) {
          s.last_error = 'control_unavailable'; await this.save(s); return;
        }
        if (s.control.paused || ['captcha','rate_limit','session_rest'].includes(s.control.reason) && now < s.control_checked + s.control.wait_ms) {
          s.last_error = s.control.reason || 'global_pause'; await this.save(s); return;
        }
        if (s.next_at > now) { await this.r.schedule(s.next_at); return; }
        if (s.visits >= 60) { s.next_at = now + 3600000; await this.save(s); await this.r.schedule(s.next_at); return; }
        if (!s.task || Date.parse(s.task.lease_until) < now + 180000) {
          const claimed = await this.api.rpc('claim', {p_task: s.task?.id || null}, signal); alive();
          if (claimed.error === 'daily_quota') { s.next_at = C.quotaRetry(claimed, now); s.last_error = 'daily_quota'; await this.save(s); await this.r.schedule(s.next_at); return; }
          if (claimed.error) throw new Error(claimed.error);
          if (!claimed.task) { s.task = null; s.phase = 'idle'; s.next_at = now + 300000; }
          else { if (s.task?.id !== claimed.task.id) { s.phase = 'idle'; s.seen = []; s.candidates = []; } s.task = claimed.task; }
        }
        if (!s.task) { await this.save(s); await this.r.schedule(s.next_at); return; }
        if (s.task.received >= s.task.target || (s.phase === 'search_done' && !s.candidates.length)) {
          const finished = await this.api.rpc('finish', {p_task: s.task.id, p_lease: s.task.lease_token}, signal); alive();
          if (finished.error) s.last_error = finished.error;
          s.task = null; s.phase = 'idle'; s.next_at = now + 60000;
        } else if (s.task.remaining_today === 0) {
          s.next_at = now + 3600000;
        } else if (s.phase === 'idle') {
          if (!await this.admit(s, 'search', alive, signal)) return;
          await this.r.open(C.HOST + '/search_result?keyword=' + encodeURIComponent(s.task.query) + '&source=web_search_result_notes'); alive();
          s.phase = 'search'; s.page_deadline = now + 120000; s.next_at = now + 30000;
        } else if (s.phase === 'search') {
          const page = await this.r.probe('search'); alive();
          const normalize = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
          if ('keyword' in page && normalize(page.keyword) !== normalize(s.task.query)) throw new Error('page_mismatch');
          this.checkPage(page, s, now);
          if (page.ready) {
            const found = new Map(s.candidates.map(url => [C.noteURL(url).id, url]));
            for (const url of page.links) { try { const note = C.noteURL(url); if (!s.seen.includes(note.id) && !s.history.includes(note.id)) found.set(note.id, note.navigation); } catch (_) {} }
            s.candidates = [...found.values()].slice(0, 80);
            s.search_round = (s.search_round || 0) + 1;
            if (s.search_round < 3) { if (!await this.admit(s, 'scroll', alive, signal)) { s.search_round--; await this.save(s); return; } await this.r.probe('scroll'); alive(); s.next_at = now + C.between(30000, 45000, this.r.random); }
            else { s.search_round = 0; s.phase = 'search_done'; s.next_at = now + 30000; }
          }
        } else if (s.phase === 'search_done') {
          const url = s.candidates[0]; const id = C.noteURL(url).id;
          if (!await this.admit(s, 'detail', alive, signal, id)) {
            if (['known_note','note_busy'].includes(s.last_error)) { s.candidates.shift(); s.seen.push(id); await this.save(s); }
            return;
          }
          s.candidates.shift();
          // Mark before navigation: crashes cannot create infinite note loops.
          s.seen.push(id); s.visits++; s.note_id = id; s.note_url = url; s.phase = 'note'; s.loaded_at = null; s.scrolls = 0; s.comment_rounds = 0;
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
            await this.r.open(s.note_url); alive(); s.phase = 'note'; s.loaded_at = null; s.scrolls = 0; s.comment_rounds = 0;
            s.page_deadline = now + 180000; s.next_at = now + 30000;
          }
        } else if (s.phase === 'note') {
          const page = await this.r.probe('note'); alive(); this.checkPage(page, s, now);
          if (page.ready) {
            if (page.record.standard.note_id !== s.note_id) throw new Error('wrong_note');
            if (s.loaded_at === null) s.loaded_at = now;
            if (now - s.loaded_at < s.dwell_ms || s.scrolls < 2) {
              if (!await this.admit(s, 'scroll', alive, signal)) return;
              await this.r.probe('scroll'); alive(); s.scrolls++; s.next_at = now + C.between(30000, 45000, this.r.random);
            } else if (page.record.extra.comments && !page.record.extra.comments.truncated && (s.comment_rounds || 0) < 4) {
              // A bounded public-page expansion; never click like, compose, or post controls.
              if (!await this.admit(s, 'comment', alive, signal)) return;
              const progress = await this.r.probe('comments'); alive(); this.checkPage(progress, s, now);
              s.comment_rounds = (s.comment_rounds || 0) + 1;
              s.next_at = now + 30000;
            } else {
              C.validate(page.record);
              s.outbox.push({request: this.r.uuid(), task: s.task.id, lease: s.task.lease_token, record: page.record});
              s.page_failures = 0;
              s.phase = 'search_done'; s.notes_in_session++; s.note_url = null; s.note_id = null; s.loaded_at = null;
              s.next_at = now + (s.notes_in_session % 8 === 0 ? C.between(300000, 600000, this.r.random) : C.between(30000, 60000, this.r.random));
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
          err.message === 'login_required' ? 'login' :
          ['page_loading','probe_timeout'].includes(err.message) ? 'page_transport' :
          ['page_timeout','content_unavailable','wrong_note','invalid_content','invalid_comments','invalid_count','page_mismatch'].includes(err.message) ? 'page_contract' : 'backend';
        const pageFailure = ['page_timeout', 'page_loading', 'content_unavailable', 'probe_timeout', 'wrong_note', 'invalid_content', 'invalid_comments', 'invalid_count'].includes(err.message);
        if (pageFailure) {
          s.page_failures = (s.page_failures || 0) + 1;
          if (s.page_failures >= 3) {
            s.enabled = false; await this.save(s); await this.r.cancel(); return;
          }
        }
        if (['captcha', 'rate_limit', 'login_required', 'page_mismatch', 'approval_required', 'consent_required', 'review_local_rejections'].includes(err.message) || err.status === 401 || err.status === 403) {
          s.enabled = false; await this.save(s); await this.r.cancel(); return;
        }
        if (pageFailure || err.message === 'wrong_note') {
          s.phase = 'idle'; s.candidates = []; s.task = null;
        }
        s.next_at = Math.max(s.next_at, now + (pageFailure ? 60000 * 2 ** (s.page_failures - 1) : 60000));
        if (s.outbox.length) { const item = s.outbox[0]; item.retries = (item.retries || 0) + 1; item.retry_at = now + Math.min(900000, 60000 * 2 ** Math.min(item.retries - 1, 4)); s.next_at = item.retry_at; }
        await this.save(s); await this.r.schedule(s.next_at);
      }
    }
    checkPage(page, s, now) {
      if (page.gate) throw new Error(page.gate);
      if (page.ready) s.last_error = null;
      if (page.reopen) { s.phase = s.phase === 'note' ? 'reopen_note' : 'idle'; s.search_round = 0; s.next_at = now + 30000; return; }
      if (!page.ready) { if (now > s.page_deadline) throw new Error(['page_loading','content_unavailable','probe_timeout'].includes(page.reason) ? page.reason : 'page_timeout'); s.next_at = now + 30000; }
    }
  }
  root.CrowdAgent = CrowdAgent;
})(globalThis);
