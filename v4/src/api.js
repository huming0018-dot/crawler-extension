(function (root) {
  'use strict';
  class CrowdAPI {
    constructor(config, storage, fetcher = (...args) => root.fetch(...args)) {
      this.config = config; this.storage = storage; this.fetcher = fetcher;
      this.authRevision = 0; this.refreshing = null;
      const u = new URL(config.url);
      if (u.protocol !== 'https:' || !u.hostname.endsWith('.supabase.co')) throw new Error('invalid_backend');
      if (!config.key || config.key.startsWith('sb_secret_')) throw new Error('public_key_required');
    }
    async request(path, body, token, signal) {
      const timeout = new AbortController();
      const abort = () => timeout.abort();
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
      const timer = setTimeout(abort, 20000);
      try {
        const response = await this.fetcher(this.config.url + path, {method: 'POST', signal: timeout.signal,
          headers: {apikey: this.config.key, 'Content-Type': 'application/json',
            ...(token ? {Authorization: 'Bearer ' + token} : {})}, body: JSON.stringify(body)});
        const data = await response.json();
        if (!response.ok) {
          const err = new Error(data.msg || data.message || data.error_description || 'http_' + response.status);
          err.status = response.status; err.code = data.code; throw err;
        }
        return data;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    async login(email, password, signup = false) {
      const revision = ++this.authRevision;
      const data = await this.request(signup ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password', {email, password});
      if (revision !== this.authRevision) throw new Error('cancelled');
      if (!data.access_token) return {confirmation_required: true};
      await this.storage.set('session', {...data, expires_at: Date.now() + data.expires_in * 1000});
      return {confirmation_required: false};
    }
    async enroll(payload) {
      let portal; try { portal = new URL(this.config.portal); } catch (_) { throw new Error('portal_not_configured'); }
      if (portal.protocol !== 'https:' || portal.username || portal.password || portal.pathname !== '/' || portal.search || portal.hash) throw new Error('portal_not_configured');
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
      try {
        const runtime = root.chrome?.runtime;
        const extension = /^[a-p]{32}$/.test(runtime?.id || '') && runtime.getURL?.('') === 'chrome-extension://' + runtime.id + '/';
        // Installed extensions call the same invitation service directly;
        // their origin must also be accepted by its server-side configuration.
        const endpoint = extension ? this.config.url + '/functions/v1/crowd-access/enroll' : portal.origin + '/api/crowd/enroll';
        const response = await this.fetcher(endpoint, {method: 'POST', credentials: 'omit', signal: controller.signal,
          headers: {'Content-Type': 'application/json', ...(extension ? {apikey: this.config.key} : {})},
          body: JSON.stringify(extension ? {...payload, client: 'extension', extension_id: runtime.id} : payload)});
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'backend_unavailable');
        return data;
      } finally { clearTimeout(timer); }
    }
    async session(signal) {
      const revision = this.authRevision;
      let s = await this.storage.get('session');
      if (signal?.aborted || revision !== this.authRevision) throw new Error('cancelled');
      if (!s?.refresh_token) throw Object.assign(new Error('backend_login_required'), {status: 401});
      if (!s.access_token || !Number.isFinite(s.expires_at) || s.expires_at < Date.now() + 60000) {
        // Status, collection and diagnostics share this API in the worker.
        // Refresh once; cancelling one caller must not consume the token and
        // lose the new session for all other callers.
        if (!this.refreshing || this.refreshing.revision !== revision) {
          const entry = {revision};
          entry.promise = (async () => {
            let next;
            try { next = await this.request('/auth/v1/token?grant_type=refresh_token', {refresh_token: s.refresh_token}); }
            catch (error) {
              if ([400,401].includes(error.status)) { error.message = 'backend_login_required'; error.status = 401; }
              throw error;
            }
            const current = await this.storage.get('session');
            if (revision !== this.authRevision || current?.refresh_token !== s.refresh_token) throw new Error('cancelled');
            if (!next.access_token || !next.refresh_token || !Number.isFinite(next.expires_in) || next.expires_in <= 0 ||
                (s.user?.id && next.user?.id !== s.user.id)) throw new Error('backend_unavailable');
            next = {...next, expires_at: Date.now() + next.expires_in * 1000};
            await this.storage.set('session', next); return next;
          })().finally(() => { if (this.refreshing === entry) this.refreshing = null; });
          this.refreshing = entry;
        }
        s = await this.refreshing.promise;
      }
      if (signal?.aborted || revision !== this.authRevision) throw new Error('cancelled');
      return s;
    }
    async rpc(name, params = {}, signal) {
      const s = await this.session(signal);
      try { return await this.request('/rest/v1/rpc/crowd_v4_' + name, params, s.access_token, signal); }
      catch (error) { if (error.status === 401 || error.message === 'login_required') error.message = 'backend_login_required'; throw error; }
    }
    async logout() {
      ++this.authRevision;
      const s = await this.storage.get('session');
      await this.storage.set('session', null);
      if (s) await this.request('/auth/v1/logout', {}, s.access_token);
    }
  }
  root.CrowdAPI = CrowdAPI;
})(globalThis);
