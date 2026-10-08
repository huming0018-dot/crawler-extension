/* One contract for desktop and native containers. No page receives credentials. */
(function (root) {
  'use strict';
  const VERSION = '4.1.0', CONSENT = 'crowd-public-v4';
  const HOST = 'https://www.xiaohongshu.com';
  const publicOrigin = u => u.protocol === 'https:' && ['www.xiaohongshu.com', 'm.xiaohongshu.com'].includes(u.hostname) && !u.username && !u.password && !u.port;
  function noteURL(value) {
    const u = new URL(value, HOST);
    if (!publicOrigin(u)) throw new Error('unsupported_origin');
    const match = u.pathname.match(/^\/(?:explore|discovery\/item|search_result)\/([a-f0-9]{24})\/?$/i);
    if (!match) throw new Error('invalid_note_url');
    return {id: match[1].toLowerCase(), url: HOST + '/explore/' + match[1].toLowerCase(), navigation: u.href};
  }
  function profileURL(value) {
    const u = new URL(value, HOST), match = u.pathname.match(/^\/user\/profile\/([a-f0-9]{24})\/?$/i);
    if (!publicOrigin(u) || !match) throw new Error('invalid_profile_url');
    return {id: match[1].toLowerCase(), url: HOST + '/user/profile/' + match[1].toLowerCase(), navigation: u.href};
  }
  function navigationURL(value) {
    const u = new URL(value);
    if (!publicOrigin(u) || !(/^\/user\/profile\/[a-f0-9]{24}\/?$/i.test(u.pathname) || /^\/search_result\/?$/.test(u.pathname) || /^\/(explore|discovery\/item|search_result)\/[a-f0-9]{24}\/?$/i.test(u.pathname)))
      throw new Error('unsupported_navigation');
    return u.href;
  }
  const between = (min, max, random = Math.random) => Math.floor(min + random() * (max - min + 1));
  const initial = () => ({version: 4, enabled: false, consent: null, phase: 'idle', task: null,
    candidates: [], seen: [], history: [], day: null, visits: 0, outbox: [], rejected: [], next_at: 0, received: 0, last_error: null, last_tick: null, notes_in_session: 0, page_failures: 0});
  function validate(record) {
    if (!record || record.schema_version !== 4) throw new Error('schema_version');
    const s = record.standard, e = record.evidence;
    if (!s || s.platform !== 'xiaohongshu' || noteURL(s.url).id !== s.note_id) throw new Error('invalid_identity');
    if (s.url !== noteURL(s.url).url) throw new Error('noncanonical_url');
    if (typeof s.title !== 'string' || s.title.length > 300 || typeof e?.text !== 'string' || e.text.length > 24000 || (!e.text.length && !s.title.length && record.extra?.media_present !== true))
      throw new Error('invalid_content');
    if (!Number.isFinite(Date.parse(s.captured_at))) throw new Error('invalid_timestamp');
    for (const key of ['published_at', 'author_display', 'like_count', 'collect_count', 'comment_count']) {
      if (!(key in s)) throw new Error('missing_standard_field');
    }
    for (const key of ['like_count', 'collect_count', 'comment_count', ...('view_count' in s ? ['view_count'] : [])]) {
      if (s[key] !== null && (!Number.isSafeInteger(s[key]) || s[key] < 0 || s[key] > 2147483647)) throw new Error('invalid_count');
    }
    if (s.author_display !== null && (typeof s.author_display !== 'string' || s.author_display.length > 100)) throw new Error('invalid_author');
    if (s.published_at !== null && (typeof s.published_at !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(s.published_at))) throw new Error('invalid_published_date');
    if (!Number.isSafeInteger(e.original_length) || e.original_length < e.text.length || typeof e.truncated !== 'boolean' || e.source !== 'rendered_public_dom' || !/^4\.\d+\.\d+$/.test(e.parser_version)) throw new Error('invalid_evidence');
    if (typeof record.extra !== 'object' || record.extra === null || Array.isArray(record.extra)) throw new Error('invalid_extra');
    if (!Array.isArray(record.extra.author_opinion_quotes) || record.extra.author_opinion_quotes.some(q => typeof q !== 'string' || !e.text.includes(q))) throw new Error('invalid_quotes');
    const comments = record.extra.comments;
    if (comments !== undefined) {
      if (!comments || !Array.isArray(comments.items) || comments.items.length > 50 || comments.coverage !== 'visible_loaded_only' || comments.complete !== false || comments.captured_count !== comments.items.length || typeof comments.truncated !== 'boolean') throw new Error('invalid_comments');
      const keys = new Set();
      for (const item of comments.items) {
        if (!/^comment-[1-9][0-9]*$/.test(item.key) || keys.has(item.key) || (item.parent_key !== null && !keys.has(item.parent_key)) ||
          typeof item.text !== 'string' || !item.text.length || item.text.length > 2000 || !Number.isSafeInteger(item.original_length) || item.original_length < item.text.length || item.truncated !== (item.original_length > item.text.length) ||
          (item.like_count !== null && (!Number.isSafeInteger(item.like_count) || item.like_count < 0 || item.like_count > 2147483647))) throw new Error('invalid_comments');
        keys.add(item.key);
      }
    }
    if (JSON.stringify(record).length > 60000) throw new Error('record_too_large');
    return record;
  }
  function receipt(value, request) {
    // A transport success is not an ingestion receipt. Unknown shapes stay queued.
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_receipt');
    if (value.error) {
      const known = ['daily_quota','lease_expired','lease_lost','task_full','invalid_envelope','request_reused',
        'invalid_record','invalid_published_date','invalid_timestamp','unrelated_note'];
      if (typeof value.error !== 'string' || !known.includes(value.error)) throw new Error('invalid_receipt');
    } else if (value.request !== request || value.gate !== 'received' || typeof value.inserted !== 'boolean' ||
      value.duplicate !== !value.inserted || !Number.isSafeInteger(value.task_received) || value.task_received < 0) {
      throw new Error('invalid_receipt');
    }
    return value;
  }
  function quotaRetry(value, now) {
    // Prefer server-relative time so a drifting device clock cannot cause a hot loop.
    if (Number.isSafeInteger(value.retry_after_ms) && value.retry_after_ms > 0 && value.retry_after_ms <= 86400000)
      return now + Math.max(30000, value.retry_after_ms);
    const at = Date.parse(value.reset_at);
    return Number.isFinite(at) && at > now && at <= now + 86400000 ? Math.max(now + 30000, at) : now + 3600000;
  }
  function accountStorage(raw) {
    async function keyFor(key) { return key === 'agent' ? 'agent:' + ((await raw.get('session'))?.user?.id || 'signed-out') : key; }
    return {async get(key) { return raw.get(await keyFor(key)); }, async set(key, value) { return raw.set(await keyFor(key), value); }};
  }
  root.CrowdCore = {VERSION, CONSENT, HOST, profileURL, noteURL, navigationURL, between, initial, validate, receipt, quotaRetry, accountStorage};
})(globalThis);
