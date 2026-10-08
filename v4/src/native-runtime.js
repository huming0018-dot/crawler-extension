/* Tiny JSON bridge shared by Android, WKWebView and ArkWeb. Only the bundled UI has it. */
(function (root) {
  if (!root.CrowdHost && !root.webkit?.messageHandlers?.crowd) return;
  const waiting = new Map();
  root.CrowdBridgeReply = (id, reply) => {
    const entry = waiting.get(id); if (!entry) return;
    waiting.delete(id); clearTimeout(entry.timer);
    reply.ok ? entry.resolve(reply.data) : entry.reject(new Error(reply.error));
  };
  function call(method, params = {}) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('native_timeout')); }, 20000);
      waiting.set(id, {resolve, reject, timer});
      const data = JSON.stringify({id, method, params});
      if (root.CrowdHost) root.CrowdHost.postMessage(data); else root.webkit.messageHandlers.crowd.postMessage(data);
    });
  }
  const storage = CrowdCore.accountStorage({get: key => call('get', {key}), set: (key, value) => call('set', {key, value})});
  const api = new CrowdAPI(CROWD_CONFIG, storage);
  let collectionAllowed = true;
  const agent = new CrowdAgent({storage, now: Date.now, random: Math.random, uuid: () => crypto.randomUUID(),
    schedule: when => call('schedule', {when}), cancel: () => call('cancel'),
    open: url => call('open', {url: CrowdCore.navigationURL(url)}), probe: action => call('probe', {action}), close: () => call('close')}, api);
  root.CrowdNative = {
    async receiveInvite(value) { await initialized; await storage.set('pending_invite', CrowdJoin.invite(value, CROWD_CONFIG.portal)); root.dispatchEvent(new Event('crowd_invite')); },
    async wake() {
      const s = await agent.read();
      if (!collectionAllowed && !s.outbox.length) { await this.suspend(); return; }
      await agent.tick();
      if (!(await agent.read()).enabled) await call('end');
    },
    async background() {
      const s = await agent.read();
      const mode = await call('background', {pending: s.outbox.length});
      collectionAllowed = mode.collect_allowed;
      if (!collectionAllowed && !s.outbox.length) await this.suspend();
    },
    async suspend() { await agent.stop('system_suspended'); await call('end'); },
    download: text => call('export', {text}),
    async command(type, args) {
      try {
        await initialized;
        let data = {};
        switch (type) {
          case 'state': data = {agent: await agent.read(), session: !!await storage.get('session'), invited: !!await storage.get('pending_invite'), status: await api.rpc('status').catch(e => ({error: e.message}))}; break;
          case 'receive_invite': await root.CrowdNative.receiveInvite(args.invite); break;
          case 'join': {
            if (args.consent !== CrowdCore.CONSENT) throw new Error('consent_required');
            await agent.stop(); const generation = agent.generation;
            await CrowdJoin.join(api, storage, await storage.get('pending_invite'));
            if (generation !== agent.generation) throw new Error('cancelled');
            const s = await agent.read(); s.consent = CrowdCore.CONSENT; await agent.save(s);
            if (generation !== agent.generation) throw new Error('cancelled');
            await call('begin', {baseline: s.notes_in_session}); collectionAllowed = true;
            if (generation !== agent.generation) { await call('end'); throw new Error('cancelled'); }
            try { await agent.start(); } catch (e) { await call('end'); throw e; } break;
          }
          case 'login': await agent.stop(); data = await api.login(args.email, args.password, args.signup); break;
          case 'consent': {
            await agent.stop(); await api.rpc('register', {p_consent: CrowdCore.CONSENT});
            const s = await agent.read(); s.consent = CrowdCore.CONSENT; await agent.save(s); break;
          }
          case 'start': { const generation = agent.generation; await call('begin', {baseline: (await agent.read()).notes_in_session}); collectionAllowed = true; try { if (generation !== agent.generation) throw new Error('cancelled'); await agent.start(); } catch (e) { await call('end'); throw e; } break; }
          case 'stop': await agent.stop(); await call('end'); break;
          case 'logout': await agent.stop('logged_out'); await call('end'); await api.logout(); break;
          case 'open_login': await agent.stop('login_required'); await call('showBrowser'); break;
          case 'export': { const s = await agent.read(); data = {outbox: s.outbox, rejected: s.rejected}; break; }
          default: throw new Error('unknown_command');
        }
        return {ok: true, data};
      } catch (e) { return {ok: false, error: e.message}; }
    }
  };
  const initialized = agent.stop('system_suspended');
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) initialized.then(() => root.CrowdNative.background()).catch(() => root.CrowdNative.suspend());
  });
  // A destroyed process resumes only after an explicit user start; checkpoints survive.
})(globalThis);
