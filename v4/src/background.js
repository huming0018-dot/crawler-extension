/* Windows/macOS Chrome & Edge MV3. No automatic start on installation. */
if (typeof importScripts === 'function') importScripts('config.js', 'core.js', 'api.js', 'agent.js', 'join.js');
const storage = CrowdCore.accountStorage({
  async get(key) { return (await chrome.storage.local.get(key))[key]; },
  async set(key, value) { await chrome.storage.local.set({[key]: value}); }
});
if (chrome.storage.local.setAccessLevel) chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}).catch(console.error);
async function probeTab(id, action) {
  let timer;
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(id, {type: 'crowd_probe', action}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probe_timeout')), 2000); })
    ]);
    return {response, status: response ? 'ok' : 'no_receiver'};
  } catch (e) { return {response: null, status: e.message === 'probe_timeout' ? 'timed_out' : 'no_receiver'}; }
  finally { clearTimeout(timer); }
}
const runtime = {
  storage, now: Date.now, random: Math.random, uuid: () => crypto.randomUUID(),
  // Durable phase deadlines live in agent.next_at; one repeating alarm repairs
  // missed ticks after sleep without bypassing cooldowns or daily quotas.
  async schedule() {
    const alarm = await chrome.alarms.get('crowd_tick');
    if (alarm?.periodInMinutes !== .5) await chrome.alarms.create('crowd_tick', {periodInMinutes: .5});
  },
  cancel: () => chrome.alarms.clear('crowd_tick'),
  async open(url) {
    CrowdCore.navigationURL(url);
    await clearNavigation();
    const id = await storage.get('work_tab');
    if (id) { try {
      const tab = await chrome.tabs.get(id);
      // Persisted IDs can point at another tab after a browser restart.
      CrowdCore.navigationURL(tab.pendingUrl || tab.url);
      await chrome.tabs.update(id, {url, active: false}); return;
    } catch (_) {} }
    const [window] = await chrome.windows.getAll({windowTypes: ['normal']});
    const tab = window ? await chrome.tabs.create({url, windowId: window.id, active: false}) :
      (await chrome.windows.create({url, type: 'normal', state: 'minimized', focused: false})).tabs[0];
    await storage.set('work_tab', tab.id);
  },
  async probe(action) {
    const id = await storage.get('work_tab');
    if (!id) return {ready: false, reopen: true};
    try {
      const tab = await chrome.tabs.get(id);
      if (tab.discarded) return {ready: false, reopen: true};
      // Rendered DOM can be ready while images/iframes keep the tab loading.
      const probe = await probeTab(id, action);
      return probe.response || {ready: false, reason: probe.status === 'timed_out' ? 'probe_timeout' : tab.status === 'loading' ? 'page_loading' : 'content_unavailable'};
    } catch (_) { return {ready: false, reopen: true}; }
  },
  async close() {
    const id = await storage.get('work_tab');
    if (id) { try { await chrome.tabs.remove(id); } catch (_) {} await storage.set('work_tab', null); }
  }
};
const api = new CrowdAPI(CROWD_CONFIG, storage), agent = new CrowdAgent(runtime, api);
let diagnosticReport;
const diagnosticKey = (id, suffix) => 'diagnostics:' + id + ':' + suffix;
const diagnosticErrors = ['page_timeout','page_loading','content_unavailable','probe_timeout','page_mismatch','wrong_note','login_required','captcha','rate_limit','approval_required','consent_required','user_stopped','logged_out','system_suspended','lease_lost','daily_quota','review_local_rejections','backend_unavailable','control_unavailable','global_pause','action_budget','action_gap','session_rest','known_note','note_busy','invalid_receipt'];
const navigationErrors = ['ERR_NAME_NOT_RESOLVED','ERR_INTERNET_DISCONNECTED','ERR_CONNECTION_TIMED_OUT','ERR_TIMED_OUT','ERR_CONNECTION_RESET','ERR_CONNECTION_REFUSED','ERR_CONNECTION_CLOSED','ERR_ADDRESS_UNREACHABLE','ERR_NETWORK_CHANGED','ERR_TUNNEL_CONNECTION_FAILED','ERR_PROXY_CONNECTION_FAILED','ERR_CERT_AUTHORITY_INVALID','ERR_CERT_DATE_INVALID','ERR_SSL_PROTOCOL_ERROR','ERR_BLOCKED_BY_CLIENT','ERR_BLOCKED_BY_ADMINISTRATOR','ERR_ABORTED'];
let navigationQueue = Promise.resolve();
async function clearNavigation() {
  await navigationQueue;
  const settings = await diagnosticSettings();
  if (settings.id) await storage.set(diagnosticKey(settings.id, 'navigation'), null);
}
// Only the collector's main frame, only during opt-in; no URL is persisted.
for (const [event, stage] of Object.entries({onBeforeNavigate:'started',onCommitted:'committed',onDOMContentLoaded:'dom_ready',onCompleted:'complete',onErrorOccurred:'failed'})) {
  chrome.webNavigation?.[event]?.addListener(details => {
    if (details.frameId !== 0) return;
    navigationQueue = navigationQueue.then(async () => {
      const settings = await diagnosticSettings();
      if (!settings.enabled || details.tabId !== await storage.get('work_tab')) return;
      try { const u = new URL(details.url); if (u.protocol !== 'https:' || !['www.xiaohongshu.com','m.xiaohongshu.com'].includes(u.hostname)) return; } catch (_) { return; }
      const code = String(details.error || '').replace(/^net::/, '');
      const key = diagnosticKey(settings.id, 'navigation'), previous = await storage.get(key);
      if (!Number.isFinite(details.timeStamp) || (previous?.at > details.timeStamp)) return;
      const current = await diagnosticSettings();
      if (!current.enabled || current.id !== settings.id || current.revision !== settings.revision) return;
      await storage.set(key, {stage, error: stage === 'failed' ? (navigationErrors.includes(code) ? code : 'OTHER') : null,
        at: details.timeStamp, revision: settings.revision, tab: details.tabId});
    }).catch(console.error);
  }, {url: [{schemes:['https'],hostEquals:'www.xiaohongshu.com'}, {schemes:['https'],hostEquals:'m.xiaohongshu.com'}]});
}
async function diagnosticSettings() {
  const session = await storage.get('session');
  if (!session?.user?.id) return {enabled: false};
  const id = session.user.id;
  return {id, enabled: await storage.get(diagnosticKey(id, 'enabled')) === true,
    pending_clear: await storage.get(diagnosticKey(id, 'clear')) === true,
    pending_enable: await storage.get(diagnosticKey(id, 'enable')) === true,
    revision: await storage.get(diagnosticKey(id, 'revision')) || 0,
    ...await storage.get(diagnosticKey(id, 'status'))};
}
async function repairDiagnostics() {
  const settings = await diagnosticSettings(), alarm = await chrome.alarms.get('crowd_diagnostics');
  if (settings.enabled || settings.pending_clear) {
    if (alarm?.periodInMinutes !== 1) await chrome.alarms.create('crowd_diagnostics', {periodInMinutes: 1});
  } else if (alarm) await chrome.alarms.clear('crowd_diagnostics');
}
async function reportDiagnostics() {
  if (diagnosticReport) return diagnosticReport;
  diagnosticReport = (async () => {
    const settings = await diagnosticSettings();
    if (!settings.id || (!settings.enabled && !settings.pending_clear)) return;
    const controller = new AbortController(); let timer;
    try {
      await Promise.race([new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('diagnostic_timeout')); }, 3000); }), (async () => {
        if (settings.pending_enable) {
          await api.rpc('diagnostics', {p_action: 'enable', p_revision: settings.revision}, controller.signal);
          if ((await diagnosticSettings()).revision === settings.revision) await storage.set(diagnosticKey(settings.id, 'enable'), false);
        }
        let snapshot = null;
        if (settings.enabled) {
          const s = await agent.read(), id = await storage.get('work_tab');
          let tab = null, page = null, tabStatus = 'missing', probeStatus = 'unknown';
          try {
            if (id) {
              tab = await chrome.tabs.get(id);
              tabStatus = tab.discarded ? 'discarded' : tab.status === 'loading' ? 'loading' : 'complete';
              if (tabStatus !== 'discarded') {
                // A disconnected content script is recorded, never fixed by bypassing policy.
                const result = await probeTab(id, 'diagnostics');
                probeStatus = result.status;
                page = result.response?.page || null;
                if (!page && tabStatus === 'complete') tabStatus = 'no_content';
              }
            }
          } catch (_) { tabStatus = tab ? (tab.status === 'loading' ? 'loading' : 'no_content') : 'missing'; }
          const number = (value, max) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0;
          const oneOf = (value, options, fallback) => options.includes(value) ? value : fallback;
          const savedNavigation = await storage.get(diagnosticKey(settings.id, 'navigation'));
          const navigation = savedNavigation?.revision === settings.revision && savedNavigation?.tab === id ? savedNavigation : null;
          snapshot = {version: CrowdCore.VERSION, enabled: s.enabled === true,
            nav_stage: navigation?.stage || 'unknown', nav_error: navigation?.error || null,
            nav_age_s: navigation ? Math.min(86400, Math.max(0, Math.floor((Date.now() - navigation.at) / 1000))) : null,
            probe_status: probeStatus,
            phase: oneOf(s.phase, ['idle','search','search_done','note','reopen_note'], 'idle'),
            error: s.last_error ? oneOf(s.last_error, diagnosticErrors, 'unexpected_error') : null,
            task_id: Number.isSafeInteger(s.task?.id) ? s.task.id : null,
            queued: number(s.outbox.length, 99999), rejected: number(s.rejected.length, 99999),
            page_kind: oneOf(page?.kind, ['search','note','other'], tab ? 'unknown' : 'missing'), tab_status: tabStatus,
            document: oneOf(page?.document, ['loading','interactive','complete'], 'unknown'),
            gate: oneOf(page?.gate, ['login_required','captcha','rate_limit'], null),
            links: number(page?.links, 500), search_note_links: number(page?.search_note_links, 500), body_chars: number(page?.body_chars, 24000),
            visible: typeof page?.visible === 'boolean' ? page.visible : null};
        }
        if (controller.signal.aborted) throw new Error('diagnostic_timeout');
        const result = await api.rpc('diagnostics', {p_action: settings.enabled ? 'report' : 'disable', p_revision: settings.revision, p_state: snapshot}, controller.signal);
        if ((await diagnosticSettings()).revision !== settings.revision) return;
        await storage.set(diagnosticKey(settings.id, 'status'), {sent_at: settings.enabled ? Date.parse(result.saved_at) : null, error: null});
        if (!settings.enabled) { await storage.set(diagnosticKey(settings.id, 'clear'), false); await repairDiagnostics(); }
      })()]);
    } catch (_) {
      if ((await diagnosticSettings()).revision === settings.revision) await storage.set(diagnosticKey(settings.id, 'status'), {error: 'unavailable'});
    } finally { clearTimeout(timer); }
  })().finally(() => { diagnosticReport = null; });
  return diagnosticReport;
}
async function setDiagnostics(enabled) {
  await diagnosticReport;
  const settings = await diagnosticSettings(); if (!settings.id) throw new Error('login_required');
  // Server revisions reject delayed reports/control requests after opt-out.
  await storage.set(diagnosticKey(settings.id, 'revision'), Math.max(Date.now(), settings.revision + 1));
  await storage.set(diagnosticKey(settings.id, 'enabled'), enabled);
  await clearNavigation();
  await storage.set(diagnosticKey(settings.id, 'enable'), enabled);
  await storage.set(diagnosticKey(settings.id, 'clear'), !enabled);
  await repairDiagnostics(); await reportDiagnostics();
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'page_ready') {
    storage.get('work_tab').then(id => { if (id === sender.tab?.id) return agent.tick(); }).catch(console.error); return;
  }
  const allowed = [chrome.runtime.getURL('src/controller.html')];
  if (!allowed.includes(sender.url) || sender.tab?.url?.startsWith(CrowdCore.HOST)) return;
  (async () => {
    switch (message.type) {
      case 'state': { const settings = await diagnosticSettings(); return {agent: await agent.read(), session: !!(await storage.get('session')), invited: !!await storage.get('pending_invite'), diagnostics: {...settings, id: undefined}, status: await api.rpc('status').catch(e => ({error: e.message}))}; }
      case 'diagnostics': {
        if (typeof message.enabled !== 'boolean') throw new Error('invalid_request');
        await setDiagnostics(message.enabled); return {};
      }
      case 'inspect_work_page': {
        const id = await storage.get('work_tab'); if (!id) throw new Error('work_page_missing');
        const tab = await chrome.tabs.update(id, {active: true}); await chrome.windows.update(tab.windowId, {focused: true}); return {};
      }
      case 'receive_invite': await storage.set('pending_invite', CrowdJoin.invite(message.invite, CROWD_CONFIG.portal)); return {};
      case 'join': {
        if (message.consent !== CrowdCore.CONSENT) throw new Error('consent_required');
        await agent.stop(); const generation = agent.generation;
        await CrowdJoin.join(api, storage, await storage.get('pending_invite'));
        if (generation !== agent.generation) throw new Error('cancelled');
        const s = await agent.read(); s.consent = CrowdCore.CONSENT; await agent.save(s);
        if (generation !== agent.generation) throw new Error('cancelled');
        await agent.start(); return {};
      }
      case 'login': await agent.stop(); return api.login(message.email, message.password, message.signup);
      case 'consent': {
        await agent.stop(); await api.rpc('register', {p_consent: CrowdCore.CONSENT});
        const s = await agent.read(); s.consent = CrowdCore.CONSENT; await agent.save(s); return {};
      }
      case 'start': await agent.start(); return {};
      case 'stop': await agent.stop(); return {};
      case 'logout': {
        await agent.stop('logged_out');
        const settings = await diagnosticSettings();
        if (settings.enabled || settings.pending_clear) await setDiagnostics(false);
        await api.logout(); await repairDiagnostics(); return {};
      }
      case 'export': { const s = await agent.read(); return {outbox: s.outbox, rejected: s.rejected}; }
      case 'open_login': await agent.stop('login_required'); await chrome.tabs.create({url: CrowdCore.HOST, active: true}); return {};
      default: throw new Error('unknown_command');
    }
  })().then(data => reply({ok: true, data}), e => reply({ok: false, error: e.message}));
  return true;
});
chrome.runtime.onMessageExternal?.addListener((message, sender, reply) => {
  try {
    const u = new URL(sender.url), portal = new URL(CROWD_CONFIG.portal);
    if (u.origin !== portal.origin || u.pathname !== '/crowd' || message.type !== 'connect') return;
    const value = CrowdJoin.invite(message.invite, CROWD_CONFIG.portal);
    storage.set('pending_invite', value).then(() => chrome.tabs.create({url: chrome.runtime.getURL('src/controller.html'), active: true}))
      .then(() => reply({ok: true}), () => reply({ok: false}));
    return true;
  } catch (_) { return; }
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'crowd_tick') agent.tick().catch(console.error);
  if (alarm.name === 'crowd_diagnostics') reportDiagnostics().catch(console.error);
});
chrome.runtime.onStartup.addListener(async () => { await agent.tick(true); await repairDiagnostics(); await reportDiagnostics(); });
chrome.runtime.onInstalled.addListener((details = {reason: 'install'}) => {
  (async () => {
    // Also hand off a trial when replacing an unjoined development copy.
    // Never overwrite an existing invitation, consent or participant identity.
    const handoff = /^[a-f0-9]{64}$/.test(CROWD_CONFIG.trialInvite || '') && !await storage.get('pending_invite') && !await storage.get('session');
    if (handoff) await storage.set('pending_invite', CROWD_CONFIG.trialInvite);
    if (details.reason === 'install' || handoff) await chrome.runtime.openOptionsPage?.();
    await agent.tick(true);
    await repairDiagnostics();
  })().catch(console.error);
});
chrome.tabs.onRemoved.addListener(id => {
  storage.get('work_tab').then(owned => { if (owned === id) return storage.set('work_tab', null); }).catch(console.error);
});
// Service-worker restarts can lose alarms on older browsers. Check the durable
// running state on every load; initial installation and user stops remain idle.
agent.tick().then(repairDiagnostics).then(reportDiagnostics).catch(console.error);
