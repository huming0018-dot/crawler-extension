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
  function unavailable(){
    const panel=[...document.querySelectorAll('.error-container, .error-panel, .note-error, .not-found, .error-text, .empty-content, [role="alert"]')].find(el=>visible(el)&&!el.closest('.comment-item, .reply-item, .comments-container, .reply-list'));
    const message=text(panel);if(!message||message.length>300)return null;
    if(/(?:作者|用户|该内容|此内容|该笔记|该视频).{0,4}(?:已删除|已被删除)|内容已被删除/.test(message))return 'source_deleted';
    if(/(?:作者设置为私密|私密作品|仅自己可见|无权访问此内容|内容仅作者可见)/.test(message))return 'source_private';
    if(/(?:笔记不存在|视频不存在|内容不存在|页面不存在|404(?:\s|$)|视频不见了)/.test(message))return 'source_not_found';
    return null;
  }
  function commentTypes(record,platform){
    const panel=first(platform==='xiaohongshu'?'.comments-container, .comments-list, .comment-list':'.reply-list');if(!panel||!record.extra.comments)return;
    const selector=platform==='xiaohongshu'?(panel.querySelector('.comment-item')?'.comment-item':'.comment-inner-container'):'.reply-item, .root-reply-container';
    const nodes=[...panel.querySelectorAll(selector)].filter(node=>visible(node)&&(platform==='xiaohongshu'||node.parentElement===panel)),keys=new Map(nodes.map((node,index)=>[node,'comment-'+(index+1)])),byKey=new Map((record.extra.comments.items||[]).map(item=>[item.key,item]));
    const enriched=[];
    for(const node of nodes){
      const own=selectors=>[...node.querySelectorAll(selectors)].find(el=>visible(el)&&el.closest(selector)===node);
      const body=own(platform==='xiaohongshu'?'.content .note-text, .content, .comment-content, .comment-text':'.reply-content, .root-reply .reply-content');
      const media_count=body?[...body.querySelectorAll('img')].filter(img=>visible(img)&&!img.closest('.emoji, .emoticon, .avatar')).length:0;
      const key=keys.get(node),ancestor=node.parentElement?.closest(selector),group=node.closest('.parent-comment'),parent=ancestor||(group&&group.querySelector(selector)!==node?group.querySelector(selector):null);let item=byKey.get(key);
      if(!item&&media_count){
        const raw=node.getAttribute('data-comment-id')||node.getAttribute('data-id')||node.getAttribute('data-rpid')||node.id||'',id=raw.replace(/^comment-/,'');
        item={key,comment_id:/^[a-zA-Z0-9_-]{1,80}$/.test(id)?id:null,parent_key:keys.get(parent)||null,is_reply:!!parent||node.matches('.comment-item-sub'),author_display:null,text:'',original_length:0,truncated:false,like_count:null,published_label:null};
      }
      if(!item)continue;
      if(parent&&keys.has(parent)&&enriched.some(p=>p.key===keys.get(parent)))item={...item,parent_key:keys.get(parent),is_reply:true};
      const image=item.original_length===0&&media_count>0,label=text(own('.show-more, .show-more-container, .more-replies, .reply-count'));
      const count=label.match(/(?:共|展开|查看)?\s*(\d+)\s*条?回复/);
      item={...item,content_type:image?'image':media_count?'mixed':'text',is_placeholder:image,media_count:Math.min(100,media_count),reported_reply_count:count?Number(count[1]):null};
      if(item.reported_reply_count>2147483647)item.reported_reply_count=null;
      enriched.push(item);if(enriched.length>=50)break;
    }
    record.extra.comments.items=enriched;record.extra.comments.captured_count=enriched.length;
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
    record.extra.comments={...comments,items:kept,captured_count:kept.length,...(Number.isInteger(comments.loaded_count)&&comments.loaded_count>=0?{omitted_count:Math.max(0,comments.loaded_count-kept.length)}:{}),complete:false,coverage:'visible_loaded_only',truncated:comments.truncated||kept.length<(comments.items||[]).length};
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
  function sessionHealth(platform){
    const host=location.hostname;
    if(!(platform==='xiaohongshu'?['www.xiaohongshu.com','m.xiaohongshu.com']:platform==='bilibili'?['www.bilibili.com','space.bilibili.com']:[]).includes(host))return {platform,status:'unknown'};
    const blocked=gate()||root.CrowdPage?.probe('diagnostics')?.page?.gate;
    if(blocked)return {platform,status:blocked==='login_required'?'logged_out':'challenge',reason:blocked};
    const own=principal(platform);
    const selectors=platform==='xiaohongshu'?'.side-bar .login-btn, .sidebar .login-btn, .channel-list .login-btn, nav button, [role="navigation"] button':'.bili-header .header-login-entry, .international-header .header-login-entry, .bili-header .header-avatar-wrap';
    const loggedOut=[...document.querySelectorAll(selectors)].some(el=>visible(el)&&/^(登录|立即登录|登录\/注册|登录注册|未登录)$/.test(text(el)));
    if(loggedOut&&own.ready)return {platform,status:'unknown'};
    if(loggedOut)return {platform,status:'logged_out',reason:'login_required'};
    return own.ready?{...own,status:'authenticated'}:{platform,status:'unknown'};
  }
  function pagination(kind){
    const scope=kind==='comments'?first('.comments-container, .comments-list, .comment-list, .reply-list, .reply-container'):first('.feeds-container, .note-list, .video-list, .space-content, #page-video');
    if(!scope)return {next:null,end_observed:false,kind:'scroll'};
    const rootNode=scope;
    const next=[...rootNode.querySelectorAll('.be-pager-next, .vui_pagenation--btn-side, .vui_pagination--btn-next, [aria-label="下一页"], [aria-label="Next page"]')].find(el=>visible(el)&&/下一页|下页|next/i.test(text(el)||el.getAttribute('aria-label')||''));
    const disabled=next&&(next.disabled||next.getAttribute('aria-disabled')==='true'||/disabled/.test(next.className));
    const end=[...rootNode.querySelectorAll('.end-container, .feeds-loading, .list-end, .reply-end, .no-more')].some(el=>visible(el)&&/没有更多|暂无更多|到底了|no more/i.test(text(el)));
    return {next:disabled?null:next,end_observed:!!disabled||end,kind:next?'next_button':'scroll'};
  }
  function advance(kind){
    const state=pagination(kind);if(state.end_observed)return {ready:true,end_observed:true};
    if(state.next){state.next.click();return {ready:true,method:'next_button'};}
    const panel=kind==='comments'?first('.comments-container, .comments-list, .comment-list, .reply-list, .reply-container'):first('.feeds-container, .note-list, .video-list');
    const box=panel&&panel.scrollHeight>panel.clientHeight&&/auto|scroll/.test(getComputedStyle(panel).overflowY)?panel:window;
    if(panel)panel.scrollIntoView({block:'end'});
    box.scrollBy({top:Math.round((box===window?innerHeight:box.clientHeight)*.8),behavior:'smooth'});return {ready:true,method:'scroll'};
  }
  function media(record,platform){
    const scope=first(platform==='xiaohongshu'?'.note-detail, .note-container, #noteContainer':'.video-container, .video-player, .bpx-player-container, .left-container')||null,refs=[];
    if(scope)for(const element of scope.querySelectorAll('img[src], video[src], video source[src], audio[src], audio source[src]')){
      if(element.closest('.comments-container, .comment-item, .reply-list, .author-wrapper, .up-info, .recommend-list'))continue;
      if(!visible(element)&&!visible(element.parentElement))continue;
      try{const u=new URL(element.currentSrc||element.src,location.href);
        if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!['xhscdn.com','xhsimg.com','hdslb.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))continue;
        const kind=element.tagName==='IMG'?'image':element.tagName==='AUDIO'||element.parentElement.tagName==='AUDIO'?'audio':'video';
        if(!refs.some(x=>x.url===u.href))refs.push({url:u.href,kind,source:'rendered_public_dom',status:'discovered_not_downloaded'});
      }catch(_){}if(refs.length>=20)break;
    }
    record.extra.media_refs=refs;record.extra.media_status=refs.length?'public_refs_available':'no_eligible_public_ref';
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
      if(links.length>=1500)break;
    }
    if(identity.platform==='bilibili'){
      const read=(selector)=>metric(text(first(selector)));
      profile={author_id:identity.id,url:identity.url,nickname:text(first('.nickname, #h-name, .upinfo-detail__name, [data-kol-name]')).slice(0,100)||null,public_handle:null,
        metrics:{followers:read('#n-fs, .fans-count, [data-kol-followers]'),notes:read('#n-video .n-num, .nav-tab--video .nav-tab__num, [data-kol-posts]'),likes_collected:{value:null,label:null,status:'not_visible'}},captured_at:new Date().toISOString(),source:'rendered_public_dom',parser_version:C.VERSION};
    }
    const page=pagination('listing');return {ready:true,creator_id:identity.id,links:links.slice(-120),profile,pagination:{kind:page.kind,end_observed:page.end_observed},coverage:'visible_loaded_only',complete:false};
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
    let commentIndex=0;for(const node of document.querySelectorAll('.reply-list > .reply-item, .reply-list > .root-reply-container')){
      if(!visible(node))continue;commentIndex++;const content=text(first('.reply-content, .root-reply .reply-content',node));if(!content)continue;
      const id=node.getAttribute('data-id')||node.getAttribute('data-rpid');
      record.extra.comments.items.push({key:'comment-'+commentIndex,comment_id:/^\d{1,30}$/.test(id||'')?id:null,parent_key:null,is_reply:false,author_display:null,text:content.slice(0,2000),original_length:content.length,truncated:content.length>2000,like_count:null,published_label:null});
      if(record.extra.comments.items.length>=20)break;
    }
    record.extra.comments.captured_count=record.extra.comments.items.length;
    return {ready:true,record};
  }
  function probe(input){
    if(input?.action==='session_health')return sessionHealth(input.platform);
    const blocked=gate();if(blocked)return {ready:false,gate:blocked};
    const xhsGate=root.CrowdPage?.probe('diagnostics')?.page?.gate;if(xhsGate)return {ready:false,gate:xhsGate};
    if(input?.action==='principal')return principal(input.platform);
    const missing=unavailable();if(missing)return {ready:false,unavailable:missing};
    let identity;try{identity=K.targetURL(location.href);}catch(_){return {ready:false,reason:'page_mismatch'};}
    const task=input?.task;if(!task||identity.platform!==task.platform)return {ready:false,reason:'page_mismatch'};
    if(input.action==='listing_scroll'&&identity.kind==='creator'&&identity.id===task.target_id)return advance('listing');
    if(input.action==='discover')return identity.kind==='creator'&&identity.id===task.target_id?discover(identity):{ready:false,reason:'page_mismatch'};
    if(input.action==='comments'&&identity.kind==='content'){
      if(task.platform==='xiaohongshu'&&task.include_replies)return root.CrowdPage?.probe('comments')||{ready:false};
      return advance('comments');
    }
    if(input.action!=='detail'||identity.kind!=='content')return {ready:false,reason:'page_mismatch'};
    const result=identity.platform==='xiaohongshu'?root.CrowdPage?.probe('note'):bilibili(identity);
    if(result?.ready){
      if(task.target_kind==='creator'&&!result.record.extra.author?.id)return {ready:false,reason:'author_unavailable'};
      result.record.extra.content_type ||= 'note';commentTypes(result.record,identity.platform);stripComments(result.record,task);media(result.record,identity.platform);
      const page=pagination('comments');result.pagination={kind:page.kind,end_observed:page.end_observed};
    }return result||{ready:false};
  }
  root.CrowdKOLPage={probe};
  if(typeof chrome!=='undefined'&&chrome.runtime?.onMessage)chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(sender.id!==chrome.runtime.id||message.type!=='crowd_kol_probe')return;
    try{reply(probe(message.input));}catch(_){reply({ready:false,reason:'content_unavailable'});}
  });
})(globalThis);
