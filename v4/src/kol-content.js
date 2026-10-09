/* Public rendered DOM only. No platform API, cookies, private state or media downloads. */
(function(root){
  'use strict';
  const K=root.CrowdKOL,C=root.CrowdCore;
  const visible=el=>!!el&&(el.offsetWidth||el.offsetHeight||el.getClientRects().length)&&getComputedStyle(el).visibility!=='hidden';
  const first=(selectors,scope=document)=>[...scope.querySelectorAll(selectors)].find(visible);
  const text=el=>el?.innerText?.trim()||'';
  const metric=label=>{
    const m=String(label||'').replace(/,/g,'').match(/^(\d+(?:\.\d+)?)\s*([万亿wWkK]?)\+?$/);
    const n=m?Math.round(Number(m[1])*({万:10000,亿:100000000,w:10000,W:10000,k:1000,K:1000}[m[2]]||1)):null;
    const value=Number.isSafeInteger(n)&&n>=0&&n<=2147483647?n:null;
    return {value,label:label||null,status:value===null?'not_visible':/[万亿wWkK+]/.test(label)?'approximate':'exact'};
  };
  function gate(){
    if(first('[class*="captcha"], [id*="captcha"], .geetest_panel, .bili-mini-login'))return first('.bili-mini-login')?'login_required':'captcha';
    const msg=text(first('[role="dialog"], .error-container, .error-panel, .login-modal'));
    if(/访问频繁|请求频繁|访问受限|请求被拦截/.test(msg))return 'rate_limit';
    if(/登录后查看|请先登录/.test(msg))return 'login_required';return null;
  }
  function stripComments(record,task){
    const comments=record.extra.comments;
    const limit=Number.isInteger(task.comment_limit)?Math.min(20,Math.max(0,task.comment_limit)):0;
    if(!limit){delete record.extra.comments;record.extra.comment_status='not_requested';return;}
    if(!comments){record.extra.comment_status='not_visible';return;}
    // Replies require explicit opt-in and a real parent in the sample.
    const kept=[];
    for(const item of comments.items||[]){
      if(kept.length>=limit)break;
      if(item.is_reply&&(!task.include_replies||!item.parent_key||!kept.some(p=>p.key===item.parent_key)))continue;
      kept.push({...item,author_display:null});
    }
    record.extra.comments={...comments,items:kept,captured_count:kept.length,complete:false,coverage:'visible_loaded_only',truncated:comments.truncated||kept.length<(comments.items||[]).length};
    record.extra.comment_status='visible_sample';record.extra.replies_status=task.include_replies?'visible_loaded_only':'not_requested';
  }
  function principal(platform){
    const host=location.hostname;
    if(platform==='xiaohongshu'&&!['www.xiaohongshu.com','m.xiaohongshu.com'].includes(host)||platform==='bilibili'&&!['www.bilibili.com','space.bilibili.com'].includes(host))return {ready:false,reason:'identity_verification_required'};
    const selectors=platform==='xiaohongshu'?'nav a[href], [role="navigation"] a[href], .side-bar a[href], .sidebar a[href], .channel-list a[href]':'.bili-header .header-avatar-wrap a[href], .bili-header a.header-avatar-wrap[href], .bili-header .header-avatar a[href], .international-header .header-avatar-wrap a[href]';
    const ids=new Set();
    for(const a of document.querySelectorAll(selectors)){
      if(!visible(a))continue;
      if(platform==='xiaohongshu'&&!/^(我|我的|我的主页|个人主页)$/.test(text(a)))continue;
      try{const p=K.targetURL(a.href);if(p.platform===platform&&p.kind==='creator')ids.add(p.id);}catch(_){}
    }
    return ids.size===1?{ready:true,platform,principal_id:[...ids][0],verification:'rendered_account_navigation'}:{ready:false,platform,reason:'identity_verification_required'};
  }
  function discover(identity){
    let ready=false,profile=null;
    if(identity.platform==='xiaohongshu'){const page=root.CrowdPage?.probe('profile');if(page?.gate)return page;ready=page?.ready===true;profile=page?.profile;}
    else ready=!!first('.upinfo, .h-basic, .space-header, .space-header__info, .nickname, [data-kol-profile]');
    if(!ready)return {ready:false};
    const selectors=identity.platform==='xiaohongshu'?'section.note-item a[href], .note-item a[href]':'.bili-video-card a[href], .small-item a[href], .bili-cover-card a[href], .video-list a[href], [data-kol-video] a[href]';
    const links=[];
    for(const a of document.querySelectorAll(selectors)){
      if(!visible(a))continue;
      try{const parsed=K.targetURL(a.href);if(parsed.platform===identity.platform&&parsed.kind==='content'&&!links.includes(parsed.navigation))links.push(parsed.navigation);}catch(_){}
      if(links.length>=40)break;
    }
    if(identity.platform==='bilibili'){
      const read=(selector)=>metric(text(first(selector)));
      profile={author_id:identity.id,url:identity.url,nickname:text(first('.nickname, #h-name, .upinfo-detail__name, [data-kol-name]')).slice(0,100)||null,public_handle:null,
        metrics:{followers:read('#n-fs, .fans-count, [data-kol-followers]'),notes:read('#n-video .n-num, .nav-tab--video .nav-tab__num, [data-kol-posts]'),likes_collected:{value:null,label:null,status:'not_visible'}},captured_at:new Date().toISOString(),source:'rendered_public_dom',parser_version:C.VERSION};
    }
    return {ready:true,creator_id:identity.id,links,profile,coverage:'visible_loaded_only',complete:false};
  }
  function bilibili(identity){
    const title=text(first('h1.video-title, .video-title h1, h1[data-title]'));
    const body=first('.basic-desc-info, .video-desc-container .desc-info-text, .video-desc-container .desc-info, [data-kol-description]');
    const original=text(body);
    if(!title&&!original)return {ready:false};
    const authorLink=first('.up-info-container a[href*="space.bilibili.com"], .up-info a[href*="space.bilibili.com"], .up-panel-container a[href*="space.bilibili.com"], [data-kol-author][href]');
    let author=null;try{const p=K.targetURL(authorLink.href);if(p.kind==='creator')author={id:p.id,url:'https://space.bilibili.com/'+p.id};}catch(_){}
    const selectors={like_count:'.video-like .video-like-info, .video-like-info',collect_count:'.video-fav .video-fav-info, .video-fav-info',comment_count:'.total-reply, .reply-header .total',view_count:'.view-text, .video-info-detail .view'};
    const observations=Object.fromEntries(Object.entries(selectors).map(([k,selector])=>[k,metric(text(first(selector)).replace(/(?:播放|弹幕|评论).*$/,'' ).trim())]));
    const published=text(first('.pubdate-ip-text, .video-info-detail .pubdate'))||null;
    const date=published?.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    const record={schema_version:4,standard:{platform:'bilibili',note_id:identity.id,url:identity.url,title:title.slice(0,300),captured_at:new Date().toISOString(),published_at:date?date[1]:null,author_display:text(authorLink).slice(0,100)||null,...Object.fromEntries(Object.entries(observations).map(([k,v])=>[k,v.value]))},
      extra:{author,media_present:!!first('video,.bpx-player-container'),content_type:'video',field_observations:observations,published_label:published,author_opinion_quotes:[],comments:{items:[],captured_count:0,coverage:'visible_loaded_only',complete:false,truncated:false}},
      evidence:{text:original.slice(0,24000),original_length:original.length,truncated:original.length>24000,selector:body?'.video-description':null,parser_version:C.VERSION,source:'rendered_public_dom'}};
    // Legacy rendered comments only; closed shadow roots are explicitly unavailable.
    for(const node of document.querySelectorAll('.reply-list > .reply-item, .reply-list > .root-reply-container')){
      if(!visible(node))continue;const content=text(first('.reply-content, .root-reply .reply-content',node));if(!content)continue;
      const id=node.getAttribute('data-id')||node.getAttribute('data-rpid');
      record.extra.comments.items.push({key:'comment-'+(record.extra.comments.items.length+1),comment_id:/^\d{1,30}$/.test(id||'')?id:null,parent_key:null,is_reply:false,author_display:null,text:content.slice(0,2000),original_length:content.length,truncated:content.length>2000,like_count:null,published_label:null});
      if(record.extra.comments.items.length>=20)break;
    }
    record.extra.comments.captured_count=record.extra.comments.items.length;
    return {ready:true,record};
  }
  function probe(input){
    const blocked=gate();if(blocked)return {ready:false,gate:blocked};
    const xhsGate=root.CrowdPage?.probe('diagnostics')?.page?.gate;if(xhsGate)return {ready:false,gate:xhsGate};
    if(input?.action==='principal')return principal(input.platform);
    let identity;try{identity=K.targetURL(location.href);}catch(_){return {ready:false,reason:'page_mismatch'};}
    const task=input?.task;if(!task||identity.platform!==task.platform)return {ready:false,reason:'page_mismatch'};
    if(input.action==='listing_scroll'&&identity.kind==='creator'&&identity.id===task.target_id){window.scrollBy({top:Math.round(innerHeight*.7),behavior:'smooth'});return {ready:true};}
    if(input.action==='discover')return identity.kind==='creator'&&identity.id===task.target_id?discover(identity):{ready:false,reason:'page_mismatch'};
    if(input.action==='comments'&&identity.kind==='content'&&task.platform==='xiaohongshu'){
      if(task.include_replies)return root.CrowdPage?.probe('comments')||{ready:false};
      const panel=first('.comments-container, .comments-list, .comment-list');
      if(panel)panel.scrollIntoView({block:'start'});
      return {ready:true};
    }
    if(input.action!=='detail'||identity.kind!=='content')return {ready:false,reason:'page_mismatch'};
    const result=identity.platform==='xiaohongshu'?root.CrowdPage?.probe('note'):bilibili(identity);
    if(result?.ready){
      if(task.target_kind==='creator'&&!result.record.extra.author?.id)return {ready:false,reason:'author_unavailable'};
      result.record.extra.content_type ||= 'note';stripComments(result.record,task);
    }return result||{ready:false};
  }
  root.CrowdKOLPage={probe};
  if(typeof chrome!=='undefined'&&chrome.runtime?.onMessage)chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(sender.id!==chrome.runtime.id||message.type!=='crowd_kol_probe')return;
    try{reply(probe(message.input));}catch(_){reply({ready:false,reason:'content_unavailable'});}
  });
})(globalThis);
