/* This adapter observes a marked, owned note only. It never initiates a platform request. */
(function(root){
 'use strict';
 function createHybrid({window,document,location,bodyReader=root.CrowdStructured.structuredBody}) {
  const note=location.pathname.match(/^\/(?:explore|discovery\/item|search_result)\/([a-f0-9]{24})\/?$/i)?.[1]?.toLowerCase(),nonce=new URL(location.href).searchParams.get('crowd_capture');
  if(!note||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(nonce||''))return null;
  const graph=new root.CrowdStructured.StructuredPages(note),pending=[],errors=[];
  let revoked=false;
  const current=()=>{
   const url=new URL(location.href),noteNow=location.pathname.match(/^\/(?:explore|discovery\/item|search_result)\/([a-f0-9]{24})\/?$/i)?.[1]?.toLowerCase(),markerNow=url.searchParams.get('crowd_capture');
   if(noteNow!==note || markerNow!==null&&markerNow!==nonce)revoked=true;
   return !revoked;
  };
  // Same-document SPA cleanup may remove the marker; another owner/note revokes permanently.
  if(window.history)for(const key of ['pushState','replaceState']){const original=window.history[key];if(typeof original==='function')window.history[key]=function(...args){const result=original.apply(this,args);current();return result;};}
  window.addEventListener('popstate',current);
  let workDocument=null;
  let bound=false,installed=false,attempted=0,body=null,gate=null;
  const countKeys=['fetch_calls','xhr_calls','matched_requests','responses','parse_failures','wrong_note','invalid_picture','invalid_page','page_budget','response_failed'],hookKeys=['fetch_hook_current','xhr_hook_current'];
  let observerDiagnostics=null;const sdkWaiters=new Map();
  const fault=reason=>{if(!errors.includes(reason))errors.push(reason);};
  const consume=page=>{try{graph.accept(page.kind,page.input_cursor,page.data,page.root_id);}catch(e){fault(['unknown_parent','cursor_out_of_order','cursor_stalled','page_conflict','root_metadata_conflict','item_conflict','page_budget'].includes(e.message)?e.message:'invalid_page');}};
  window.addEventListener('message',event=>{
   const m=event.data;
   if(!current()||event.source!==window||event.origin!==location.origin||m?.type!=='crowd_public_response_v1'||m.nonce!==nonce||m.note_id!==note)return;
   try{if(JSON.stringify(m).length>1100000){fault('page_budget');return;}}catch(_){fault('invalid_page');return;}
   if(m.revoked===true){revoked=true;bound=false;return;}
   if(m.diagnostics){
    const d=m.diagnostics;
    if(typeof d!=='object'||Array.isArray(d)||Object.keys(d).length!==countKeys.length+hookKeys.length||countKeys.some(k=>!Number.isInteger(d[k])||d[k]<0||d[k]>10000)||hookKeys.some(k=>typeof d[k]!=='boolean')){fault('invalid_page');return;}
    observerDiagnostics=Object.fromEntries([...countKeys,...hookKeys].map(k=>[k,d[k]]));
   }
   if(m.sdk_result){const q=sdkWaiters.get(m.sdk_result.id);if(q){sdkWaiters.delete(m.sdk_result.id);q(m.sdk_result.status);}return;}
   if(m.installed===true){installed=true;return;}
   if(['captcha','rate_limit'].includes(m.gate)){gate=m.gate;return;}
   if(m.error){fault(['response_failed','invalid_page','page_budget'].includes(m.error)?m.error:'invalid_page');return;}
   if(!m.page)return;
   if(bound)consume(m.page);else if(pending.length<4)pending.push(m.page);else fault('late_binding');
  });
  const install=()=>{
   if(!current()||installed||attempted>=4)return;
   attempted++;
   window.postMessage({type:'crowd_public_ready_v1',nonce,note_id:note},location.origin);
   if(!installed&&attempted<4)window.setTimeout(install,250);
  };
  // The fixed MAIN file owns installation. READY can be repeated without network traffic.
  install();
  return {
   sdkGate(){return gate;},
   sdkPlan(){
    if(!current()||!bound||!installed||gate||errors.length||workDocument===null)return null;
    for(const [id,g] of graph.roots)if(!g.ended)return {kind:'reply',root:id,cursor:g.cursor};
    return graph.main.ended?null:{kind:'main',root:null,cursor:graph.main.cursor};
   },
   sdkCommand(command){
    if(!current()||!bound||!installed||gate||errors.length||command.binding?.document!==workDocument||command.binding?.nonce!==nonce||command.binding?.note!==note)return Promise.resolve('unavailable');
    return new Promise(resolve=>{const timer=window.setTimeout(()=>{sdkWaiters.delete(command.id);resolve('unknown');},10000);sdkWaiters.set(command.id,status=>{clearTimeout(timer);resolve(status);});window.postMessage({type:'crowd_public_ready_v1',nonce,note_id:note,sdk:command},location.origin);});
   },
   bind(token,documentId){if(workDocument===null&&documentId!==undefined)workDocument=documentId;else if(documentId!==undefined&&workDocument!==documentId)revoked=true;if(token!==nonce)revoked=true;bound=current()&&token===nonce;if(bound)for(const page of pending.splice(0))consume(page);return bound;},
   snapshot(noteId,dom,documentId){
    if(workDocument===null)workDocument=documentId;else if(workDocument!==documentId)revoked=true;
    if(!current()||!bound||noteId!==note)return null;
    if(installed)window.postMessage({type:'crowd_public_ready_v1',nonce,note_id:note},location.origin);
    if(!body){const script=[...(document.scripts||[])].find(s=>!s.src&&s.textContent?.startsWith('window.__INITIAL_STATE__='));if(script)try{body=bodyReader(script.textContent,note);}catch(_){fault('body_unavailable');}}
    const summary=graph.summary(),items=[...graph.items.values()],domIds=[...new Set((dom?.extra?.comments?.items||[]).map(i=>i.comment_id).filter(Boolean))];
    const witness=domIds.length>0&&domIds.every(id=>graph.items.has(id));
    return {version:1,note_id:note,document:documentId,source:'page_response',mode:installed?'passive_hybrid':'dom_fallback',observer_status:installed?'installed':attempted?'csp_or_not_installed':'waiting',
     gate,body,items,groups:summary.groups,main_ended:summary.main_ended,pages:[...graph.pages.keys()],
     observer_diagnostics:observerDiagnostics?{...observerDiagnostics,marker_retained:new URL(location.href).searchParams.get('crowd_capture')===nonce}:null,
     complete:summary.complete&&installed&&witness&&errors.length===0,errors:errors.slice(0,12),
     dom_witness:{note_id:note,comment_ids:domIds,matched:witness,reported_count:dom?.standard?.comment_count??null},
     body_dom_match:!!body&&body.text.replace(/\[[^\]\r\n]{1,40}R\]/g,'').replace(/\[话题\]#/g,'').trim()===dom?.evidence?.text};
   }
  };
 }
 root.CrowdHybrid={createHybrid};
})(globalThis);
