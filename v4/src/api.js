(function (root) {
  'use strict';
  class CrowdAPI {
    constructor(config, storage, fetcher = (...args) => root.fetch(...args)) {
      this.config = config; this.storage = storage; this.fetcher = fetcher;
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
      const data = await this.request(signup ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password', {email, password});
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
      let s = await this.storage.get('session');
      if (!s?.refresh_token) throw new Error('login_required');
      if (s.expires_at < Date.now() + 60000) {
        s = await this.request('/auth/v1/token?grant_type=refresh_token', {refresh_token: s.refresh_token}, null, signal);
        await this.storage.set('session', {...s, expires_at: Date.now() + s.expires_in * 1000});
      }
      return s;
    }
    async rpc(name, params = {}, signal) {
      const s = await this.session(signal);
      return this.request('/rest/v1/rpc/crowd_v4_' + name, params, s.access_token, signal);
    }
    async logout() {
      const s = await this.storage.get('session');
      try { if (s) await this.request('/auth/v1/logout', {}, s.access_token); }
      finally { await this.storage.set('session', null); }
    }
  }
  root.CrowdAPI = CrowdAPI;
})(globalThis);
