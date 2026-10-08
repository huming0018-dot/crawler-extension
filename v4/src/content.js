/* Only rendered public content. Never intercept private APIs, cookies or network. */
(function (root) {
  'use strict';
  const C = root.CrowdCore;
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const first = selectors => [...document.querySelectorAll(selectors)].find(visible);
  const text = el => el?.innerText?.trim() || '';
  const postFirst = selectors => [...document.querySelectorAll(selectors)].find(el => visible(el) && !el.closest('.comments-container, .comments-list, .comment-list, .comment-item'));
  const noteBody = () => postFirst('#detail-desc, .note-detail .note-text, .note-container .note-text, .note-scroller .desc, .note-content .desc');
  const noteLinks = () => {
    // Prefer each result card's own links (crawler-extension v1.0.0 pattern).
    const cards = [...document.querySelectorAll('section.note-item, div.note-item')];
    const selectors = 'a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="/search_result/"]';
    const links = cards.length ? cards.flatMap(card => [...card.querySelectorAll(selectors)]) : [...document.querySelectorAll(selectors)];
    return links.filter(a => {
    if (!visible(a)) return false;
    try { C.noteURL(a.href); return true; } catch (_) { return false; }
    });
  };
  function gate() {
    if (first('[class*="captcha"], [id*="captcha"], iframe[src*="captcha"], [class*="verify-slider"]')) return 'captcha';
    const modal = first('[role="dialog"], .error-page, .error-container, .login-container, .login-modal');
    const message = text(modal);
    if (/访问频繁|操作频繁|请求过于频繁|稍后再试|访问受限/.test(message)) return 'rate_limit';
    if (first('.login-container input, .login-modal input, input[placeholder*="手机号"]') || /登录后查看|请先登录/.test(message)) return 'login_required';
    return null;
  }
  function parseCount(label) {
    const value = label.replace(/,/g, '').trim();
    const m = value.match(/^(?:(?:阅读|浏览|观看|点赞|收藏|评论|共)\s*)?(\d+(?:\.\d+)?)\s*([万wWkK千]?)\+?\s*(?:次(?:浏览|阅读|观看)?|条(?:评论)?|浏览|阅读|观看|点赞|收藏|评论)?$/);
    if (!m) return null;
    const valueNumber = Math.round(Number(m[1]) * ({万: 10000, w: 10000, W: 10000, k: 1000, K: 1000, 千: 1000}[m[2]] || 1));
    return Number.isSafeInteger(valueNumber) && valueNumber <= 2147483647 ? valueNumber : null;
  }
  const noteScope = () => noteBody()?.closest('.note-detail, .note-container, #noteContainer') || document;
  const commentPanel = () => [...noteScope().querySelectorAll('.comments-container, .comments-list, .comment-list')].find(visible);
  function expandControl(panel) {
    return [...(panel?.querySelectorAll('.show-more, .show-more-container, .load-more, .more-replies, button') || [])].find(el =>
      visible(el) && !el.disabled && /^(?:展开(?:更多)?|查看更多|加载更多)\s*(?:\d+\s*条)?\s*(?:回复|评论)/.test(text(el)) &&
      (!el.getAttribute('href') || el.getAttribute('href').startsWith('#')));
  }
  function comments(record) {
    const panel = commentPanel();
    const result = {items: [], coverage: 'visible_loaded_only', complete: false, panel_found: !!panel,
      loaded_count: 0, captured_count: 0, omitted_count: 0, truncated: false, more_available: !!expandControl(panel)};
    if (!panel) return result;
    // Own fields only: parent.innerText would incorrectly include all nested replies.
    const selector = panel.querySelector('.comment-item') ? '.comment-item' : '.comment-inner-container';
    const nodes = [...panel.querySelectorAll(selector)].filter(visible);
    result.loaded_count = nodes.length;
    const keys = new Map(nodes.map((node, index) => [node, 'comment-' + (index + 1)]));
    const own = (node, selectors) => [...node.querySelectorAll(selectors)].find(el => visible(el) && el.closest(selector) === node);
    // Keep headroom below the existing client/SQL envelope limits, including long note evidence.
    const budget = Math.min(20000, Math.max(0, 55000 - JSON.stringify(record).length));
    let size = 0;
    for (const node of nodes) {
      const original = text(own(node, '.content .note-text, .content, .comment-content, .comment-text'));
      if (!original) continue;
      const ancestor = node.parentElement?.closest(selector);
      const group = node.closest('.parent-comment');
      const parent = ancestor || (group && group.querySelector(selector) !== node ? group.querySelector(selector) : null);
      const parentKey = keys.get(parent) || null;
      // A reply with a missing/unreadable parent is explicitly unresolved, never attached to another comment.
      const idNode = node.closest('.comment-inner-container');
      const candidateID = node.getAttribute('data-comment-id') || node.id || (idNode && idNode.querySelector(selector) === node ? idNode.id : '') || '';
      const commentID = candidateID.replace(/^comment-/, '');
      const likeLabel = text(own(node, '.like .count, .like-wrapper .count, .like-container .count, .like-count'));
      const item = {key: keys.get(node), comment_id: /^[a-zA-Z0-9_-]{1,80}$/.test(commentID) ? commentID : null,
        parent_key: parentKey, is_reply: !!parent || node.matches('.comment-item-sub, .reply-item') || !!node.closest('.reply-container, .replies'),
        author_display: text(own(node, '.author-wrapper .name, .author .name, .user-name')).slice(0, 100) || null,
        text: original.slice(0, 2000), original_length: original.length, truncated: original.length > 2000,
        like_count: parseCount(likeLabel), like_label: likeLabel.slice(0, 80) || null,
        published_label: text(own(node, '.date, .time')).slice(0, 100) || null};
      if (parentKey && !result.items.some(p => p.key === parentKey)) item.parent_key = null;
      const length = JSON.stringify(item).length;
      if (result.items.length >= 50 || size + length > budget) { result.truncated = true; break; }
      result.items.push(item); size += length;
      result.truncated ||= item.truncated;
    }
    result.captured_count = result.items.length;
    result.omitted_count = nodes.length - result.items.length;
    return result;
  }
  function note() {
    let identity;
    try { identity = C.noteURL(location.href); } catch (_) { return {ready: false}; }
    const body = noteBody();
    const original = text(body); if (original.length < 8) return {ready: false};
    const title = text(first('#detail-title, .note-detail .title, .note-container .title')).slice(0, 300);
    const raw = original.slice(0, 24000);
    const date = text(postFirst('.note-content .date, .note-detail .date, .note-container .date')) || null;
    const dateISO = date?.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    const hashtags = [...new Set([...raw.matchAll(/#([^\s#]{1,60})/g)].map(m => m[1]))];
    const metricSelectors = {
      like_count: '.interact-container .like-wrapper .count',
      collect_count: '.interact-container .collect-wrapper .count',
      comment_count: '.interact-container .chat-wrapper .count',
      view_count: '.interact-container .view-wrapper .count, .interact-container .read-wrapper .count, .note-detail .view-count, .note-container .view-count, #noteContainer .view-count, .note-detail .read-count, .note-container .read-count'
    };
    const metricLabels = Object.fromEntries(Object.entries(metricSelectors).map(([key, selectors]) => {
      const node = postFirst(selectors);
      return [key, text(node).slice(0, 80) || null];
    }));
    const record = {schema_version: 4,
      standard: {platform: 'xiaohongshu', note_id: identity.id, url: identity.url, title,
        captured_at: new Date().toISOString(), published_at: dateISO ? dateISO[1] : null,
        author_display: text(postFirst('.author-wrapper .username, .note-detail .author .name')).slice(0, 100) || null,
        ...Object.fromEntries(Object.entries(metricLabels).map(([key, label]) => [key, parseCount(label || '')]))},
      extra: {hashtags, published_label: date, metric_labels: metricLabels, author_opinion_quotes: raw.split(/\n+/).filter(x => /好吃|难吃|推荐|踩雷|鲜|咸|甜|辣|油腻|服务|排队|价格/.test(x)).slice(0, 30)},
      evidence: {text: raw, original_length: original.length, truncated: original.length > raw.length,
        selector: body.id ? '#' + body.id : '.' + String(body.className).trim().replace(/\s+/g, '.'),
        parser_version: C.VERSION, source: 'rendered_public_dom'}};
    record.extra.comments = comments(record);
    return {ready: true, record};
  }
  function probe(action) {
    // Opt-in diagnostics use categories/counts, never page text or navigation tokens.
    if (action === 'diagnostics') return {ready: true, page: {
      kind: /^\/search_result\/?$/.test(location.pathname) ? 'search' : /^\/(explore|discovery\/item|search_result)\/[a-f0-9]{24}\/?$/i.test(location.pathname) ? 'note' : 'other',
      document: document.readyState, gate: gate(), links: Math.min(noteLinks().length, 500),
      body_chars: Math.min(text(noteBody()).length, 24000), visible: !document.hidden,
      search_note_links: Math.min([...document.querySelectorAll('a[href*="/search_result/"]')].filter(visible).length, 500)
    }};
    const blocked = gate(); if (blocked) return {ready: false, gate: blocked};
    if (action === 'comments') {
      try { C.noteURL(location.href); } catch (_) { return {ready: false}; }
      const panel = commentPanel(), expand = expandControl(panel);
      if (expand) { expand.scrollIntoView({block: 'center'}); expand.click(); }
      else if (panel) {
        const box = panel.scrollHeight > panel.clientHeight && /auto|scroll/.test(getComputedStyle(panel).overflowY) ? panel : first('.note-scroller, .note-detail .scroll-container') || window;
        const viewport = box === window ? {top: 0, bottom: innerHeight} : box.getBoundingClientRect();
        const bounds = panel.getBoundingClientRect();
        if (bounds.top >= viewport.bottom || bounds.bottom <= viewport.top) panel.scrollIntoView({block: 'start'});
        else box.scrollBy({top: Math.round((box === window ? innerHeight : box.clientHeight) * .6), behavior: 'smooth'});
      }
      else (first('.note-scroller, .note-detail .scroll-container') || window).scrollBy({top: Math.round(innerHeight * .6), behavior: 'smooth'});
      return {ready: true};
    }
    if (action === 'scroll') {
      const box = first('.note-scroller, .note-detail .scroll-container');
      (box || window).scrollBy({top: Math.round(innerHeight * C.between(35, 65) / 100), behavior: 'smooth'});
      return {ready: true};
    }
    if (action === 'search') {
      const links = noteLinks().map(a => a.href);
      const keyword = /^\/search_result\/?$/.test(location.pathname) ? new URL(location.href).searchParams.get('keyword') : null;
      return {ready: links.length > 0 || !!first('.search-empty, .empty-page, .no-result'), links, keyword};
    }
    return note();
  }
  root.CrowdPage = {probe};
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (sender.id !== chrome.runtime.id || message.type !== 'crowd_probe') return;
      try { reply(probe(message.action)); } catch (e) { reply({ready: false, error: e.message}); }
    });
    chrome.runtime.sendMessage({type: 'page_ready'}).catch(() => {});
  }
})(globalThis);
