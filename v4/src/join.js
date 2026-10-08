/* Invitation and device helpers; shared by the portal and installed clients. */
(function (root) {
  'use strict';
  function platform(nav = navigator) {
    const ua = nav.userAgent || '', os = nav.userAgentData?.platform || nav.platform || '';
    if (/HarmonyOS|OpenHarmony/i.test(ua)) return 'harmony';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(os) && nav.maxTouchPoints > 1)) return 'ios';
    if (/Win/i.test(os + ua)) return 'windows';
    if (/Mac/i.test(os + ua)) return 'macos';
    return 'unsupported';
  }
  function invite(value, portal) {
    value = String(value || '').trim();
    if (/^[a-f0-9]{64}$/.test(value)) return value;
    try {
      const u = new URL(value);
      if (!((u.protocol === 'foodcrowd:' && u.host === 'join') || (u.origin === new URL(portal).origin && u.pathname === '/crowd'))) throw new Error();
      const token = new URLSearchParams(u.hash.slice(1)).get('invite');
      if (/^[a-f0-9]{64}$/.test(token || '')) return token;
    } catch (_) {}
    throw new Error('invalid_invite');
  }
  function secret() { return [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join(''); }
  async function join(api, storage, value, os) {
    const token = invite(value, api.config.portal);
    let password = await storage.get('install_secret');
    if (!password) { password = secret(); await storage.set('install_secret', password); }
    const account = await api.enroll({ invite: token, install_secret: password, consent: CrowdCore.CONSENT, platform: os || api.config.platform || platform() });
    await api.login(account.email, 'Cr4!' + password);
    await storage.set('pending_invite', null);
  }
  async function download(release, progress = () => {}) {
    const base = new URL(release.url);
    const fetchBytes = async url => {
      const u = new URL(url, base); if (u.origin !== location.origin || !u.pathname.startsWith('/crowd/releases/')) throw new Error('invalid_download');
      const response = await fetch(u, {cache: 'no-store', credentials: 'omit'}); if (!response.ok) throw new Error('download_unavailable'); return response;
    };
    const descriptor = await (await fetchBytes(base.href + '.json')).json();
    if (descriptor.sha256 !== release.sha256 || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > 768*1024*1024 || !Array.isArray(descriptor.parts) || descriptor.parts.length < 1 || descriptor.parts.length > 32 || !/^crowd-[a-z0-9.-]+\.(zip|exe|dmg)$/.test(descriptor.file) || descriptor.file !== base.pathname.split('/').pop()) throw new Error('invalid_download');
    const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    const chunks = []; let received = 0;
    for (const part of descriptor.parts) {
      if (typeof part.url !== 'string' || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > 24*1024*1024 || !/^[a-f0-9]{64}$/.test(part.sha256 || '')) throw new Error('invalid_download');
      const bytes = await (await fetchBytes(part.url)).arrayBuffer();
      if (bytes.byteLength !== part.bytes || await digest(bytes) !== part.sha256) throw new Error('download_integrity');
      chunks.push(bytes); received += bytes.byteLength; progress(Math.floor(received * 100 / descriptor.bytes));
    }
    const file = new Blob(chunks, {type: descriptor.file.endsWith('.zip') ? 'application/zip' : 'application/octet-stream'});
    if (file.size !== descriptor.bytes || await digest(await file.arrayBuffer()) !== descriptor.sha256) throw new Error('download_integrity');
    const url = URL.createObjectURL(file), a = document.createElement('a'); a.href = url; a.download = descriptor.file; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  root.CrowdJoin = { platform, invite, secret, join, download };
})(globalThis);
