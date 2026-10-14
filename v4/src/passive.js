/* Fixed packaged MAIN observer; no dynamic scripts, extra requests or CSP changes. */
(function(root){
 'use strict';
 function pageObserver() {
  'use strict';
  const marker=new URL(location.href).searchParams.get('crowd_capture'),id=location.pathname.match(/^\/(?:explore|discovery\/item|search_result)\/([a-f0-9]{24})\/?$/i)?.[1]?.toLowerCase();
  if(window.top!==window || !id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(marker||''))return;
  const sdkGraph=new root.CrowdStructured.StructuredPages(id);let sdkBinding=null,sdkPager=null,sdkContextURL=null,sdkGrant=null,sdkOperation=null,pendingReads=0;
  let bridgeReady=false,pendingBytes=0,overflow=false,pendingGate=null;
  const pending=[];
  const counts={fetch_calls:0,xhr_calls:0,matched_requests:0,responses:0,parse_failures:0,wrong_note:0,invalid_picture:0,invalid_page:0,page_budget:0,response_failed:0};
  let fetchHook=null,xhrOpenHook=null,xhrSendHook=null;
  const count=key=>{counts[key]=Math.min(10000,counts[key]+1);};
  const diagnostics=()=>({...counts,fetch_hook_current:fetchHook!==null&&window.fetch===fetchHook,xhr_hook_current:xhrOpenHook!==null&&typeof XMLHttpRequest==='function'&&!!XMLHttpRequest.prototype&&XMLHttpRequest.prototype.open===xhrOpenHook&&XMLHttpRequest.prototype.send===xhrSendHook});
  let revoked=false;
  const current=()=>{
   const url=new URL(location.href),noteNow=location.pathname.match(/^\/(?:explore|discovery\/item|search_result)\/([a-f0-9]{24})\/?$/i)?.[1]?.toLowerCase(),markerNow=url.searchParams.get('crowd_capture');
   if(!revoked&&(noteNow!==id || markerNow!==null&&markerNow!==marker)){revoked=true;window.postMessage({type:'crowd_public_response_v1',nonce:marker,note_id:id,revoked:true},location.origin);}
   return !revoked;
  };
  // Same-document SPA cleanup may remove the marker; another owner/note revokes permanently.
  if(window.history)for(const key of ['pushState','replaceState']){const original=window.history[key];if(typeof original==='function')window.history[key]=function(...args){const result=original.apply(this,args);current();return result;};}
  window.addEventListener('popstate',current);
  const sdkCurrent=()=>sdkBinding&&current()?{...sdkBinding,stopped:false,risk:pendingGate}:null;
  const send=data=>{if(current())window.postMessage({type:'crowd_public_response_v1',nonce:marker,note_id:id,...data},location.origin);};
  const emit=data=>{
   if(!current())return;if(data.gate)pendingGate=data.gate;
   if(bridgeReady){send(data);return;}
   if(data.gate){pendingGate=data.gate;return;}
   const bytes=JSON.stringify(data).length;
   if(pending.length<4&&pendingBytes+bytes<=1000000){pending.push(data);pendingBytes+=bytes;}else overflow=true;
  };
  window.addEventListener('message',event=>{
   const m=event.data;
   if(event.source!==window||event.origin!==location.origin||m?.type!=='crowd_public_ready_v1'||m.nonce!==marker||m.note_id!==id||!current())return;
   bridgeReady=true;send({installed:true,diagnostics:diagnostics()});
   if(m.sdk && root.CrowdSiteSDK){
    const q=m.sdk,b=q.binding;
    if(!b||b.note!==id||b.nonce!==marker||!b.document||!b.owner||!b.test||!/^[a-f0-9]{64}$/.test(b.lease||'')||!Number.isInteger(b.generation))return;
    if(sdkBinding&&['owner','note','document','nonce','generation','test','lease'].some(k=>sdkBinding[k]!==b[k])){revoked=true;return;}
    if(!sdkBinding){sdkBinding={...b};sdkPager=root.CrowdSiteSDK.createSitePager({window,document,enabled:true,binding:sdkBinding,current:sdkCurrent,graph:sdkGraph,
     admit:async()=>sdkGrant,responseReady:async()=>{for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,50));if(sdkGraph.pages.has(sdkOperation.kind+':'+(sdkOperation.root||'')+':'+sdkOperation.cursor))return;}throw Error('observer_response_missing');}});if(sdkContextURL)sdkPager.observe(sdkContextURL);}
    if(q.type==='plan'&&(pendingReads>0||sdkContextURL&&!sdkGraph.pages.size)){send({sdk_result:{id:q.id,status:'wait'}});return;}
    if(q.type==='plan'){send({sdk_result:{id:q.id,status:sdkPager.available()?'available':'unavailable'}});return;}
    if(q.type==='action'){
     if(pendingReads>0){send({sdk_result:{id:q.id,status:'not_sent'}});return;}
     sdkGrant=q.grant;sdkOperation=q.operation;
     sdkPager.next(q.operation).then(()=>send({sdk_result:{id:q.id,status:'accepted'}})).catch(error=>send({sdk_result:{id:q.id,status:error.notSent?'not_sent':'unknown'}}));return;
    }
   }
   if(pendingGate)send({gate:pendingGate});
   for(const value of pending.splice(0))send(value);
   pendingBytes=0;if(overflow){send({error:'page_budget'});overflow=false;}
  });
  const descriptor=(value,method)=>{
   try{
    const u=new URL(value,location.href);if(method!=='GET'||u.protocol!=='https:'||u.hostname!=='edith.xiaohongshu.com'||u.username||u.password||u.port||u.searchParams.get('note_id')!==id)return null;
    const kind=u.pathname==='/api/sns/web/v2/comment/page'?'main':u.pathname==='/api/sns/web/v2/comment/sub/page'?'reply':null;
    if(!kind)return null;const cursor=u.searchParams.get('cursor')||'',parent=kind==='reply'?u.searchParams.get('root_comment_id'):null;
    if(cursor.length>100 || kind==='reply'&&!/^[a-f0-9]{24}$/.test(parent||''))return null;
    return {kind,input_cursor:cursor,root_id:parent};
   }catch(_){return null;}
  };
  const item=(c,withReplies=false)=>{
   if(!c||c.note_id!==id||typeof c.content!=='string')throw Error('wrong_note');
   const v={id:c.id,note_id:c.note_id,content:c.content,author_id:c.user_info?.user_id||null,author_display:c.user_info?.nickname||null,
    like_count:c.like_count??null,create_time:c.create_time??null,target_comment_id:c.target_comment?.id||null,
    pictures:(c.pictures||[]).map(p=>{const u=new URL(p.url_default);if(!['http:','https:'].includes(u.protocol)||u.hostname!=='sns-webpic-qc.xhscdn.com'||u.username||u.password||u.port||u.search||u.hash||!/^\/[^\s?#]+\/comment(?:_uhdr)?\/[a-zA-Z0-9_-]+![a-zA-Z0-9_-]+$/.test(u.pathname))throw Error('invalid_picture');return {url_default:p.url_default,width:p.width,height:p.height};})};
   if(withReplies)Object.assign(v,{sub_comment_count:c.sub_comment_count,sub_comment_has_more:c.sub_comment_has_more,sub_comment_cursor:c.sub_comment_cursor,sub_comments:(c.sub_comments||[]).map(r=>item(r))});
   return v;
  };
  const deliver=(meta,value,status)=>{
   if(!meta)return;
   if(status===403||status===429 || ['300011','300012','300013'].includes(String(value?.code))){emit({gate:'rate_limit'});return;}
   if(status===461||status===471){emit({gate:'captcha'});return;}
   if(status!==200||value?.success!==true){count('response_failed');send({diagnostics:diagnostics()});emit({error:'response_failed'});return;}
   try{
    const d=value.data;if(!d||!Array.isArray(d.comments)||d.comments.length>50||typeof d.cursor!=='string'||typeof d.has_more!=='boolean')throw Error('invalid_page');
    const page={cursor:d.cursor,has_more:d.has_more,comments:d.comments.map(c=>item(c,meta.kind==='main'))};
    if(JSON.stringify(page).length>1000000)throw Error('page_budget');
    sdkGraph.accept(meta.kind,meta.input_cursor,page,meta.root_id);sdkPager?.acceptedResponse();emit({page:{...meta,data:page}});
   }catch(error){count(['wrong_note','invalid_picture','page_budget'].includes(error.message)?error.message:'invalid_page');emit({error:'invalid_page'});}
   send({diagnostics:diagnostics()});
  };
  const originalFetch=window.fetch;
  if(typeof originalFetch==='function')window.fetch=function(...args){
   count('fetch_calls');
   // Read only the public URL/method; never request headers/body/cookies.
   const meta=current()?descriptor(typeof args[0]==='string'?args[0]:args[0]?.url,String(args[1]?.method||args[0]?.method||'GET').toUpperCase()):null;
   if(meta){count('matched_requests');pendingReads++;if(meta.kind==='main'){sdkContextURL=typeof args[0]==='string'?args[0]:args[0]?.url;sdkPager?.observe(sdkContextURL);}}
   const result=originalFetch.apply(this,args);
   if(meta)result.then(response=>{count('responses');const size=Number(response.headers.get('content-length')||0);if(size>1000000){count('page_budget');pendingReads=Math.max(0,pendingReads-1);send({diagnostics:diagnostics()});emit({error:'page_budget'});return;}
    response.clone().text().then(text=>{pendingReads=Math.max(0,pendingReads-1);if(text.length>1000000){count('page_budget');send({diagnostics:diagnostics()});emit({error:'page_budget'});return;}try{deliver(meta,JSON.parse(text),response.status);}catch(_){count('parse_failures');send({diagnostics:diagnostics()});emit({error:'response_failed'});}}).catch(()=>{pendingReads=Math.max(0,pendingReads-1);count('parse_failures');send({diagnostics:diagnostics()});emit({error:'response_failed'});});
   }).catch(()=>{pendingReads=Math.max(0,pendingReads-1);emit({error:'response_failed'});});
   return result;
  };
  if(typeof originalFetch==='function')fetchHook=window.fetch;
  if(typeof XMLHttpRequest==='function'){
   const savedOpen=XMLHttpRequest.prototype.open,savedSend=XMLHttpRequest.prototype.send,metadata=new WeakMap();
   XMLHttpRequest.prototype.open=function(method,url,...rest){count('xhr_calls');const meta=current()?descriptor(url,String(method).toUpperCase()):null;if(meta){count('matched_requests');if(meta.kind==='main'){sdkContextURL=new URL(url,location.href).href;sdkPager?.observe(sdkContextURL);}}metadata.set(this,meta);return savedOpen.call(this,method,url,...rest);};
   XMLHttpRequest.prototype.send=function(...args){const meta=metadata.get(this);
    if(meta){pendingReads++;let settled=false;const settle=()=>{if(!settled){settled=true;pendingReads=Math.max(0,pendingReads-1);}};for(const event of ['error','abort','timeout'])this.addEventListener(event,()=>{settle();emit({error:'response_failed'});},{once:true});this.addEventListener('load',()=>{settle();count('responses');try{const value=this.responseType==='json'?this.response:JSON.parse(this.responseText);if(JSON.stringify(value).length<=1000000)deliver(meta,value,this.status);else {count('page_budget');send({diagnostics:diagnostics()});emit({error:'page_budget'});}}catch(_){count('parse_failures');send({diagnostics:diagnostics()});emit({error:'response_failed'});}}, {once:true});}
    return savedSend.apply(this,args);
   };
   xhrOpenHook=XMLHttpRequest.prototype.open;xhrSendHook=XMLHttpRequest.prototype.send;
  }
  // ISOLATED requests the installation ACK after registering its receiver.
 }
 root.CrowdPassive={pageObserver};
})(globalThis);
