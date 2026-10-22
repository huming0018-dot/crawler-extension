(function(root){
'use strict';
// Fixed cached public comment client; source commands remain backend-admitted and document-bound.
function createSitePager({window,document,enabled=false,binding,current,graph,admit,responseReady,now=Date.now}){
 let revoked=false,busy=false,sdk=null,captured=false,context=null;const used=new Set();
 const same=()=>{const c=current();if(!c||['owner','note','document','nonce','generation','test','lease'].some(k=>c[k]!==binding[k])||c.stopped||c.risk)revoked=true;return !revoked;};
 const frontier=(kind,root)=>{const g=kind==='main'?graph.main:graph.roots.get(root);return !g||g.ended?null:g.cursor;};
 const capture=()=>{
  if(captured)return sdk;captured=true;
  const base='https://fe-static.xhscdn.com/formula-static/xhs-pc-web/public/resource/js/';
  const required=['vendor-dynamic.8866efa7.js','index.6613bd4c.js','bundler-runtime.1200f52d.js'];
  if(!required.every(name=>Array.from(document?.scripts||[]).some(s=>s.src===base+name)))return null;
  const chunks=Object.getOwnPropertyDescriptor(window,'webpackChunkxhs_pc_web')?.value;
  if(!Array.isArray(chunks)||typeof chunks.push!=='function')return null;
  // One fixed cache lookup. Never require/initialize a module, enumerate it, or inject source factories.
  chunks.push([['crowd_public_comment_sdk_capture_v1'],{},require=>{
   const entry=Object.getOwnPropertyDescriptor(require.c||{},'25717')?.value;
   if(entry?.loaded!==true||!entry.exports)return;
   const main=entry.exports.S9,reply=entry.exports.z1;
   if(typeof main==='function'&&typeof reply==='function')sdk={main,reply};
  }]);return sdk;
 };
 return {
  available(){return enabled&&same()&&!!context&&now()>=context.at&&now()-context.at<=30000&&!!capture();},
  acceptedResponse(){if(context&&same())context.at=now();},
  observe(url,method='GET'){
   if(!enabled||!same()||method!=='GET')return false;
   try{const u=new URL(url);if(u.origin!=='https://edith.xiaohongshu.com'||u.pathname!=='/api/sns/web/v2/comment/page'||u.hash||u.username||u.password||u.searchParams.get('note_id')!==binding.note)return false;
    const allowed=['note_id','cursor','top_comment_id','image_formats','xsec_token'];if([...u.searchParams.keys()].some(k=>!allowed.includes(k))||allowed.some(k=>u.searchParams.getAll(k).length>1))return false;
    const image=u.searchParams.get('image_formats')||'',top=u.searchParams.get('top_comment_id')||'',token=u.searchParams.get('xsec_token')||'';
    if(image.length>100||top.length>100||token.length>2048)return false;
    context={image,top,token,at:now()};return true;
   }catch(_){return false;}
  },
  async next({kind,root=null,cursor}){
   if(!enabled||busy||!same())throw Error('disabled_or_busy');
   if(!['main','reply'].includes(kind)||frontier(kind,root)===null||frontier(kind,root)!==cursor||!context||now()-context.at>30000||now()<context.at){const e=Error('scope_or_context');e.notSent=true;throw e;}
   if(kind==='reply'&&!/^[a-f0-9]{24}$/.test(root||''))throw Error('root');busy=true;let sent=false;
   try{
    const grant=await admit({kind,root,cursor});if(!same()||grant?.allowed!==true||typeof grant.id!=='string'||used.has(grant.id)||!Number.isFinite(grant.expires)||grant.expires>now()+10000||['owner','note','document','nonce','generation','test','lease'].some(k=>grant[k]!==binding[k])||grant.kind!==kind||grant.root!==root||grant.cursor!==cursor)throw Error('grant');
    used.add(grant.id);if(grant.expires<=now()){const e=Error('expired_before_send');e.notSent=true;throw e;}if(frontier(kind,root)!==cursor)throw Error('cursor_changed');
    const transport=capture();if(!transport)throw Error('loaded_sdk_missing');
    if(!same()||grant.expires<=now()||frontier(kind,root)!==cursor||now()-context.at>30000)throw Error('revoked_or_expired');
    const params={noteId:binding.note,cursor,topCommentId:context.top,imageFormats:context.image,xsecToken:context.token};if(kind==='reply'){params.rootCommentId=root;params.num=10;}
    // The site's existing configured client owns serialization, signing, SSK, Mns, Sc-T and credentials.
    sent=true;await transport[kind]({params});
    if(!same())throw Error('revoked');
    // Do not treat the transformed SDK return as DOM/API evidence. The existing observer must accept its raw response.
    await responseReady({kind,root,cursor});
    if(!same()||frontier(kind,root)===cursor)throw Error('observer_response_missing');return {accepted:true};
   }catch(e){e.notSent=!sent&&['expired_before_send','cursor_changed','revoked_or_expired'].includes(e.message);if(!e.notSent)revoked=true;throw e;}finally{busy=false;}
  }
 };
}
root.CrowdSiteSDK={createSitePager};
})(globalThis);
