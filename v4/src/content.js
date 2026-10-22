/* Only rendered public content. Never intercept private APIs, cookies or network. */
(function (root) {
  'use strict';
  const C = root.CrowdCore, platform = C.platform('xiaohongshu');
  let workDocument=null,workToken=null;
  const hybrid=root.CrowdHybrid?.createHybrid({window,document,location});
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const first = selectors => [...document.querySelectorAll(selectors)].find(visible);
  const text = el => el?.innerText?.trim() || '';
  const ownPost = el => visible(el) && !el.closest('.comments-container, .comments-list, .comment-list, .comment-item, .note-item');
  // A comma-separated query returns DOM order, not selector priority. Prefer
  // explicit detail fields before fallbacks, excluding recommendations/comments.
  const postFirst = selectors => {
    const scope = noteScope();
    for (const selector of selectors.split(',')) {
      const node = [...scope.querySelectorAll(selector.trim())].find(ownPost);
      if (node) return node;
    }
  };
  const noteBody = () => postFirst('#detail-desc, .note-detail .note-text, .note-container .note-text, .note-scroller .desc, .note-content .desc, .note-container .desc, #noteContainer .desc');
  const noteLinks = () => {
    // Prefer each result card's own links (crawler-extension v1.0.0 pattern).
    const cards = [...document.querySelectorAll('section.note-item, div.note-item')];
    const selectors = 'a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="/search_result/"]';
    const links = cards.length ? cards.flatMap(card => [...card.querySelectorAll(selectors)]) : [...document.querySelectorAll(selectors)];
    return links.filter(a => {
    if (!visible(a)) return false;
    try { platform.noteURL(a.href); return true; } catch (_) { return false; }
    });
  };
  function gate() {
    if (first('[class*="captcha"], [id*="captcha"], iframe[src*="captcha"], [class*="verify-slider"]')) return 'captcha';
    const modal = first('[role="dialog"], .error-page, .error-container, .login-container, .login-modal');
    const message = text(modal);
    if(/^\/website-login\/error\/?$/.test(location.pathname) && /访问频繁|请求过于频繁|300013/.test(text(document.body)))return 'rate_limit';
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
  function metric(label) {
    const value = parseCount(label || '');
    return {value, label: label || null, status: value === null ? (label ? 'unparsed' : 'not_visible') : /[万wWkK千+]/.test(label) ? 'approximate' : 'exact'};
  }
  function cards() {
    return noteLinks().map(a => {
      const card = a.closest('section.note-item, div.note-item');
      return {url: a.href, title: text(card?.querySelector('.title')).slice(0,300), author_display: text(card?.querySelector('.author .name')).slice(0,100) || null};
    });
  }
  function profile() {
    let p; try { p = platform.profileURL(location.href); } catch (_) { return {ready:false}; }
    const scope = first('.user-info, .user-page .info-part, .user-profile, [data-profile-header]');
    if (!scope) return {ready:false};
    const own = selector => [...scope.querySelectorAll(selector)].find(visible);
    const nickname = text(own('.user-name, .nickname, .username')).slice(0,100);
    if (!nickname) return {ready:false};
    const metrics = {};
    for (const [key,label] of Object.entries({followers:'粉丝',notes:'笔记',likes_collected:'获赞与收藏'})) {
      const row = [...scope.querySelectorAll('.user-interactions > *, .data-info > *, .interaction, [data-profile-metric]')].find(el => visible(el) && text(el).includes(label));
      metrics[key] = metric(text(row?.querySelector('.count, .number, [data-value]')) || null);
    }
    return {ready:true, profile:{author_id:p.id,url:p.url,nickname,public_handle:text(own('.user-redId, .red-id')).replace(/^小红书号[：:\s]*/, '').slice(0,100) || null,
      metrics, notes:cards().slice(0,12).map(card => ({note_id:platform.noteURL(card.url).id,title:card.title})),
      captured_at:new Date().toISOString(),source:'rendered_public_dom',parser_version:C.VERSION}};
  }
  const noteScope = () => {
    const scopes = [...document.querySelectorAll('#noteContainer, .note-detail, .note-container')].filter(ownPost);
    const overlay = scopes.find(el => el.closest('[role="dialog"], .note-detail-mask'));
    if (overlay) return overlay;
    const anchor = [...document.querySelectorAll('#detail-desc, #detail-title')].find(ownPost);
    if (anchor) {
      const owner = scopes.find(el => el.contains(anchor));
      if (owner) return owner;
    }
    // Prefer the visible overlay. Do not fall through to recommendation cards.
    return scopes.at(-1) || document;
  };
  const commentPanel = () => [...noteScope().querySelectorAll('.comments-container, .comments-list, .comment-list, .comments-el')].find(visible);
  function expandControl(panel) {
    return [...(panel?.querySelectorAll('.show-more, .show-more-container, .load-more, .more-replies, button') || [])].find(el =>
      visible(el) && !el.disabled && /^(?:展开(?:更多)?|查看更多|加载更多)\s*(?:\d+\s*条)?\s*(?:回复|评论)/.test(text(el)) &&
      (!el.getAttribute('href') || el.getAttribute('href').startsWith('#')));
  }
  function commentScroller(panel) {
    for(let node=panel;node&&node!==document.body;node=node.parentElement)
      if(node.scrollHeight>node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY))return node;
    return first('.note-scroller, .note-detail .scroll-container') || window;
  }
  function commentImage(img) {
    const kind=img.matches('img.note-content-emoji')?'emoji':'image';
    let url=img.currentSrc || img.src || '';
    // Chrome upgrades this observed public CDN's HTTP markup to HTTPS for rendering.
    if(kind==='image' && url.startsWith('http://sns-webpic-qc.xhscdn.com/'))url=url.replace(/^http:/,'https:');
    return C.commentMediaURL(url,kind)?{kind,url,alt:img.getAttribute('alt')?.slice(0,100)||null}:null;
  }
  function comments(record, full = false) {
    const panel = commentPanel();
    const result = {items: [], coverage: 'visible_loaded_only', complete: false, panel_found: !!panel,
      loaded_count: 0, captured_count: 0, omitted_count: 0, truncated: false, more_available: !!expandControl(panel)};
    if (!panel) return result;
    // Own fields only: parent.innerText would incorrectly include all nested replies.
    const selector = panel.querySelector('.comment-item') ? '.comment-item' : '.comment-inner-container';
    const allNodes=[...panel.querySelectorAll(selector)], nodes=allNodes.filter(visible);
    result.dom_census={document:workDocument,visible_count:nodes.length,hidden_count:allNodes.length-nodes.length,skipped_count:0,duplicate_count:0,unresolved_parent_count:0};
    result.loading=[...panel.querySelectorAll('.loading, .loading-container, .spinner, [aria-busy="true"]')].some(visible);
    result.loaded_count = nodes.length;
    const keys = new Map(nodes.map((node, index) => [node, 'comment-' + (index + 1)])), capturedKeys = new Map();
    const own = (node, selectors) => [...node.querySelectorAll(selectors)].find(el => visible(el) && el.closest(selector) === node);
    // Keep headroom below the existing client/SQL envelope limits, including long note evidence.
    const budget = full ? Infinity : Math.min(20000, Math.max(0, 55000 - JSON.stringify(record).length));
    let size = 0;
    for (const node of nodes) {
      const content=own(node, '.content .note-text, .content, .comment-content, .comment-text');
      const original = text(content);
      const images=full?[...node.querySelectorAll('img.note-content-emoji, .img-box img.inner')].filter(img=>img.closest(selector)===node && visible(img)):[];
      const media=images.map(commentImage).filter(Boolean).slice(0,20);
      for(const img of images)if(!commentImage(img)) {
        const url=img.currentSrc || img.src || '';
        if(!url || /^(?:data:|blob:)/.test(url))result.media_pending=true;
        else result.truncated=true;
      }
      if(images.length>20)result.truncated=true;
      if (!original && !media.length) continue;
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
      if (parentKey && !capturedKeys.has(parentKey)) item.parent_key = null;
      if(media.length){item.media=media;item.content_kind=original?'mixed':'media_only';}
      const length = JSON.stringify(item).length;
      if ((!full && result.items.length >= 50) || size + length > budget) { result.truncated = true; break; }
      result.items.push(item); capturedKeys.set(item.key,item); size += length;
      result.truncated ||= item.truncated;
    }
    result.captured_count = result.items.length;
    result.omitted_count = nodes.length - result.items.length;
    result.identity_uncertain=result.items.some(item=>!item.comment_id);
    const capturedIDs=new Set(result.items.map(item=>item.comment_id));
    result.dom_census.skipped_count=result.omitted_count;
    result.dom_census.duplicate_count=result.items.length-capturedIDs.size;
    const box = commentScroller(panel), bounds = panel.getBoundingClientRect();
    const viewport = box === window ? {top:0,bottom:innerHeight} : box.getBoundingClientRect();
    const scroll = box === window ? document.scrollingElement : box;
    const roots=[...panel.querySelectorAll('.parent-comment > .comment-item')];
    const replyGroups=[...panel.querySelectorAll('.parent-comment')].map(group=>{
      const root=group.querySelector(selector),label=text(root?.querySelector('.reply .count'));
      const declared=/^\d+$/.test(label)?Number(label):label==='回复'?0:null;
      const loaded=[...group.querySelectorAll(selector)].filter(node=>node!==root && visible(node)).length;
      return {root,declared,loaded,expand:!!expandControl(group)};
    }).filter(group=>visible(group.root));
    result.reply_coverage={root_count:replyGroups.length,declared_count:replyGroups.every(group=>group.declared!==null)?replyGroups.reduce((n,group)=>n+group.declared,0):null,
      loaded_count:replyGroups.reduce((n,group)=>n+group.loaded,0),pending_groups:replyGroups.filter(group=>group.declared!==null && group.loaded<group.declared).length,
      loading_groups:replyGroups.filter(group=>group.declared!==null && group.loaded<group.declared && !group.expand).length};
    // Reply controls disappear during their request; their declared count still exposes unfinished loading.
    result.loading ||= result.reply_coverage.loading_groups>0;
    const lastRoot=roots[roots.length-1],lastBounds=lastRoot?.getBoundingClientRect();
    result.progress = {top:Math.round(scroll.scrollTop),height:scroll.scrollHeight,client:scroll.clientHeight,
      page_visible:!document.hidden,last_root_comment_id:lastRoot?.id||null,last_root_vertical_percent:lastBounds?.height?Math.round(Math.max(0,Math.min(lastBounds.bottom,viewport.bottom)-Math.max(lastBounds.top,viewport.top))/lastBounds.height*100):null,
      at_end:scroll.scrollTop+scroll.clientHeight>=scroll.scrollHeight-3 && bounds.bottom<=viewport.bottom+3,
      end_marker:!![...panel.querySelectorAll('.end-container')].find(el=>visible(el)&&/^-?\s*THE END\s*-?$/i.test(text(el))),
      expand_count:[...panel.querySelectorAll('.show-more, .show-more-container, .load-more, .more-replies, button')].filter(el=>visible(el)&&/^(?:展开(?:更多)?|查看更多|加载更多)\s*(?:\d+\s*条)?\s*(?:回复|评论)/.test(text(el))).length,
      empty:!![...panel.querySelectorAll('.empty-container,.empty-comment,.no-comment,.no-comments')].find(el=>visible(el)&&/荒地|暂无评论|没有评论/.test(text(el)))};
    for (const item of result.items) item.parent_comment_id = capturedKeys.get(item.parent_key)?.comment_id || null;
    result.dom_census.unresolved_parent_count=result.items.filter(item=>item.is_reply && (!item.parent_comment_id || !capturedIDs.has(item.parent_comment_id))).length;
    return result;
  }
  function note(fullComments = false) {
    let identity;
    try { identity = platform.noteURL(location.href); } catch (_) { return {ready: false}; }
    const body = noteBody();
    const original = text(body);
    const title = text(postFirst('#detail-title, .note-content .title, .note-detail .title, .note-container .title, #noteContainer .title')).slice(0, 300);
    const media = [...noteScope().querySelectorAll('.note-slider img, .note-content img, .note-video video, video')].some(visible);
    if (!original && !title && !media) return {ready: false};
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
      let node = postFirst(selectors);
      if (!node) {
        // Some layouts render one detached interaction bar beside the detail.
        const detached = [...document.querySelectorAll(selectors)].filter(el => visible(el) && !el.closest('.comment-item, .comments-container, .note-item, .note-detail, .note-container, #noteContainer'));
        if (detached.length === 1) node = detached[0];
      }
      return [key, text(node).slice(0, 80) || null];
    }));
    const authorLink = postFirst('.author-wrapper a[href*="/user/profile/"], .author a[href*="/user/profile/"]');
    let author = null;
    try { const p = platform.profileURL(authorLink?.href); author = {id: p.id, url: p.url}; } catch (_) {}
    const record = {schema_version: 4,
      standard: {platform: platform.id, note_id: identity.id, url: identity.url, title,
        captured_at: new Date().toISOString(), published_at: dateISO ? dateISO[1] : null,
        author_display: text(postFirst('.author-wrapper .username, .author-wrapper .name, .author .name, .author .username')).slice(0, 100) || null,
        ...Object.fromEntries(Object.entries(metricLabels).map(([key, label]) => [key, parseCount(label || '')]))},
      extra: {author, media_present: media, field_observations: Object.fromEntries(Object.entries(metricLabels).map(([key,label]) => [key, metric(label)])), hashtags, published_label: date, metric_labels: metricLabels, author_opinion_quotes: raw.split(/\n+/).filter(x => /好吃|难吃|推荐|踩雷|鲜|咸|甜|辣|油腻|服务|排队|价格/.test(x)).slice(0, 30)},
      evidence: {text: raw, original_length: original.length, truncated: original.length > raw.length,
        selector: body ? (body.id ? '#' + body.id : '.' + String(body.className).trim().replace(/\s+/g, '.')) : null,
        parser_version: C.VERSION, source: 'rendered_public_dom'}};
    record.extra.comments = comments(record,fullComments);
    return {ready: true, record, author_navigation: author ? authorLink.href : null};
  }
  let observed = null;
  function readyNote() {
    const page = note();
    if (!page.ready || document.readyState === 'loading') return {ready:false, reason:'body_pending'};
    const scope = noteScope(), body = noteBody();
    const loading = [...scope.querySelectorAll('[aria-busy="true"], .loading, .skeleton')].some(ownPost);
    const collapsed = [...scope.querySelectorAll('[aria-expanded="false"], .show-more, .expand-text')].some(el => ownPost(el) && /全文|展开|更多/.test(text(el)));
    const style = body && getComputedStyle(body);
    const clipped = body && body.scrollHeight > body.clientHeight+2 &&
      (/hidden|clip/.test(style.overflowY) || Number.parseInt(style.webkitLineClamp)>0);
    const declared = scope.getAttribute?.('data-note-id');
    if (declared && declared !== page.record.standard.note_id) return {ready:false, reason:'body_pending'};
    // A title alone can precede the body. An explicit body node or loaded media
    // distinguishes an empty-body post from a detail which has not rendered yet.
    const loadedMedia = [...scope.querySelectorAll('.note-slider img, .note-content img, .note-video video, video')].some(el => visible(el) &&
      (el.tagName === 'IMG' ? el.complete && el.naturalWidth>0 : el.readyState>=1));
    if (loading || collapsed || clipped || (!page.record.evidence.text && !loadedMedia)) return {ready:false, reason:'body_pending'};
    const fingerprint = JSON.stringify([page.record.standard.note_id,page.record.standard.title,page.record.evidence.text,!!body,page.record.extra.media_present,declared]);
    const now = Date.now();
    if (!observed || observed.fingerprint !== fingerprint || observed.scope !== scope) {
      // A same-document route which still shows the old body is not a new note.
      const stale = observed && (observed.stale || observed.id !== page.record.standard.note_id) &&
        observed.body === page.record.evidence.text && declared !== page.record.standard.note_id;
      observed = {fingerprint,scope,id:page.record.standard.note_id,body:page.record.evidence.text,at:now,stale};
    }
    if (observed.stale || now-observed.at < 300) return {ready:false, reason:'body_pending'};
    page.record.extra.body_observation = {status:page.record.evidence.text ? 'rendered_stable' : 'empty_body',loading:false,collapsed:false};
    return page;
  }
  function findSearchScroller(){
    if(!/^\/search_result\/?$/.test(location.pathname))return {box:null,card_count:0};
    const cards=[...new Set(noteLinks().map(a=>a.closest('section.note-item, div.note-item')).filter(card=>card&&!card.closest('.comments-container, .comments-list, .comment-list, .comment-item, .note-detail, .note-container, #noteContainer, [role="dialog"]')))];
    let box=null;
    for(let node=cards[0]?.parentElement;node;node=node.parentElement){
      if(visible(node)&&node.clientHeight>0&&node.scrollHeight>node.clientHeight+3&&/^(auto|scroll)$/.test(getComputedStyle(node).overflowY)&&cards.every(card=>node.contains(card))){box=node;break;}
    }
    return {box,card_count:cards.length};
  }
  function searchScrollGeometry(){
    const {box,card_count}=findSearchScroller();
    return {container_kind:box?'results_ancestor':'unavailable',card_count,top:box?box.scrollTop:null,height:box?box.scrollHeight:null,client:box?box.clientHeight:null};
  }
  function probe(action, boundWork = false) {
    // Opt-in diagnostics use categories/counts, never page text or navigation tokens.
    if (action === 'diagnostics') return {ready: true, page: {
      kind: /^\/search_result\/?$/.test(location.pathname) ? 'search' : /^\/(explore|discovery\/item|search_result)\/[a-f0-9]{24}\/?$/i.test(location.pathname) ? 'note' : 'other',
      document: document.readyState, gate: gate(), links: Math.min(noteLinks().length, 500),
      body_chars: Math.min(text(noteBody()).length, 24000), visible: !document.hidden,
      search_note_links: Math.min([...document.querySelectorAll('a[href*="/search_result/"]')].filter(visible).length, 500),
      ...(/^\/search_result\/?$/.test(location.pathname)?{search_scroll:searchScrollGeometry()}:{})
    }};
    const blocked = gate(); if (blocked) return {ready: false, gate: blocked};
    if (action === 'note_ready') return readyNote();
    if (action === 'profile') return profile();
    if (action === 'comment_read') return note(true);
    if (action === 'comments') {
      try { platform.noteURL(location.href); } catch (_) { return {ready: false}; }
      const panel = commentPanel(), expand = expandControl(panel);
      const pendingImage=[...(panel?.querySelectorAll('img.note-content-emoji, .img-box img.inner')||[])].find(img=>visible(img) && visible(img.closest('.comment-item, .comment-inner-container')) && !commentImage(img) && (!img.src || /^(?:data:|blob:)/.test(img.src)));
      if(pendingImage){pendingImage.scrollIntoView({block:'center',behavior:'instant'});return {ready:true};}
      if(boundWork&&panel&&!expand&&document.hidden){
        const box=commentScroller(panel),scroll=box===window?document.scrollingElement:box;
        const ended=[...panel.querySelectorAll('.end-container')].some(el=>visible(el)&&/^-?\s*THE END\s*-?$/i.test(text(el)));
        const page=note(true),captured=page.ready?page.record.extra.comments:null;
        const complete=Number.isInteger(page.record?.standard.comment_count)&&captured?.captured_count===page.record.standard.comment_count&&!captured.truncated;
        if(scroll.scrollTop+scroll.clientHeight>=scroll.scrollHeight-3&&!ended&&!complete)return {ready:true,needs_visible_page:true};
      }
      if (expand) { expand.scrollIntoView({block: 'center',behavior:'instant'}); expand.click(); }
      else if (panel) {
        const box = commentScroller(panel);
        const viewport = box === window ? {top: 0, bottom: innerHeight} : box.getBoundingClientRect();
        const bounds = panel.getBoundingClientRect();
        if (bounds.top >= viewport.bottom || bounds.bottom <= viewport.top) panel.scrollIntoView({block: 'start',behavior:'instant'});
        // Background tabs can suspend smooth-scroll animation before the pagination threshold.
        else {
          const scroll=box===window?document.scrollingElement:box;
          const atBottom=scroll.scrollTop+scroll.clientHeight>=scroll.scrollHeight-3;
          const ended=[...panel.querySelectorAll('.end-container')].some(el=>visible(el)&&/^-?\s*THE END\s*-?$/i.test(text(el)));
          // A clamped scroll does not trigger the next page; return upward in this admitted action, downward in the next.
          if(atBottom&&!ended)box.scrollBy({top:-Math.round((box===window?innerHeight:box.clientHeight)*.2),behavior:'instant'});
          else box.scrollTo({top:scroll.scrollHeight,behavior:'instant'});
        }
      }
      else (first('.note-scroller, .note-detail .scroll-container') || window).scrollBy({top: Math.round(innerHeight * .8), behavior: 'instant'});
      return {ready: true};
    }
    if (action === 'scroll') {
      if(/^\/search_result\/?$/.test(location.pathname)){
        const {box}=findSearchScroller();
        if(!box)return {ready:false,reason:'content_unavailable'};
        const before=box.scrollTop;
        // Hidden tabs may suspend smooth animation before the loading threshold.
        box.scrollBy({top:Math.round(box.clientHeight*C.between(35,65)/100),behavior:'instant'});
        const moved=box.scrollTop>before,at_end=box.scrollTop+box.clientHeight>=box.scrollHeight-3;
        return {ready:moved||at_end,...(!moved&&!at_end?{reason:'content_unavailable'}:{}),scroll:{target:'search_container',before,after:box.scrollTop,height:box.scrollHeight,client:box.clientHeight,moved,at_end}};
      }
      const box = first('.note-scroller, .note-detail .scroll-container');
      (box || window).scrollBy({top: Math.round(innerHeight * C.between(35, 65) / 100), behavior: 'smooth'});
      return {ready: true};
    }
    if (action === 'search') {
      const links = noteLinks().map(a => a.href);
      const keyword = /^\/search_result\/?$/.test(location.pathname) ? new URL(location.href).searchParams.get('keyword') : null;
      return {ready: links.length > 0 || !!first('.search-empty, .empty-page, .no-result'), links, cards: cards(), keyword};
    }
    return note();
  }
  // The browser/native transport only needs this uniform page-probe contract.
  function hybridProbe(action,boundWork=false){
    const page=probe(action,boundWork);
    if(page.ready&&page.record){
      const value=hybrid?.snapshot(page.record.standard.note_id,page.record,workDocument);
      if(value){
        page.structured=value;if(value.gate)return {ready:false,gate:value.gate};
        const d=value.observer_diagnostics;
        // A declared reply gap is coverage evidence, not proof of an in-flight request.
        if(action==='comment_read'&&boundWork&&value.observer_status==='installed'&&value.errors.length===0&&d?.matched_requests>0&&d.matched_requests===d.responses){
          const panel=commentPanel();
          if(panel&&page.record.extra.comments)page.record.extra.comments.loading=[...panel.querySelectorAll('.loading, .loading-container, .spinner, [aria-busy="true"]')].some(visible);
        }
      }
    }
    return page;
  }
  root.CrowdPage = {platform: platform.id, capabilities: platform.capabilities, probe:hybridProbe};
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    workDocument=crypto.randomUUID();
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (sender.id !== chrome.runtime.id) return;
      if (message.type === 'crowd_bind') {workToken=message.token;hybrid?.bind(workToken,workDocument);reply({bound:true,document:workDocument});changed();return;}
      if (message.type !== 'crowd_probe') return;
      if (message.action === 'ownership') {reply({token:workToken,document:workDocument});return;}
      if(['sdk_plan','sdk_action'].includes(message.action)){
        const blocked=gate();if(blocked){reply({ready:false,gate:blocked,sdk_status:'blocked'});return;}
        const q=message.sdk;if(!q||message.token!==workToken||message.document!==workDocument||q.binding?.document!==workDocument||q.binding?.nonce!==workToken){reply({ready:false,sdk_status:'unavailable'});return;}
        const plan=hybrid?.sdkPlan();if(!plan){reply({ready:true,sdk_status:message.action==='sdk_action'?'not_sent':'unavailable'});return;}
        if(message.action==='sdk_action'&&JSON.stringify(plan)!==JSON.stringify(q.operation)){reply({ready:false,sdk_status:'stale'});return;}
        hybrid.sdkCommand(q).then(status=>reply({ready:true,sdk_status:status,gate:hybrid.sdkGate(),sdk_plan:status==='available'?plan:null})).catch(()=>reply({ready:false,sdk_status:'unknown'}));return true;
      }

      try { reply(hybridProbe(message.action,!!workToken)); } catch (e) { reply({ready: false, error: e.message}); }
    });
    // Register at document_start: a parser-blocking script must not hide an
    // already rendered search or gate from the worker. Probes decide readiness.
    let timer, observer;
    const notifyUntil = Date.now()+180000;
    const notify = () => {
      timer=null;
      let target = null;
      try { target = platform.noteURL(location.href).id; } catch (_) {}
      if (target && !gate() && !readyNote().ready) {
        if (Date.now()<notifyUntil) changed();
        return;
      }
      chrome.runtime.sendMessage({type:'page_ready',token:workToken,document:workDocument, target, keyword:target ? null : new URL(location.href).searchParams.get('keyword')}).catch(() => {});
    };
    const changed = () => {if(!timer&&Date.now()<notifyUntil)timer=setTimeout(notify,350);};
    notify();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', changed, {once:true});
    changed();
    observer = new MutationObserver(changed);
    observer.observe(document, {childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','aria-busy','aria-expanded','data-note-id']});
    setTimeout(() => {observer.disconnect(); clearTimeout(timer);},180000);
  }
})(globalThis);
