/* Reuses the KOL rendered-navigation identity contract; no cookies/private state. */
(function(root){
 'use strict';
 if(!root.chrome?.runtime?.onMessage)return;
 const visible=el=>!!el&&(el.offsetWidth||el.offsetHeight||el.getClientRects().length)&&getComputedStyle(el).visibility!=='hidden';
 const text=el=>el?.innerText?.trim()||'';
 function observe(){
  if(!['www.xiaohongshu.com','m.xiaohongshu.com'].includes(location.hostname))return {platform:'xiaohongshu',status:'unknown'};
  const gate=root.CrowdPage?.probe('diagnostics')?.page?.gate;
  if(gate)return {platform:'xiaohongshu',status:gate==='login_required'?'logged_out':'challenge',reason:gate};
  const ids=new Set();
  for(const a of document.querySelectorAll('nav a[href], [role="navigation"] a[href], .side-bar a[href], .sidebar a[href], .channel-list a[href]')){
   if(!visible(a)||!/^(我|我的|我的主页|个人主页)$/.test(text(a)))continue;
   try{ids.add(root.CrowdCore.profileURL(a.href).id);}catch(_){}
  }
  const out=[...document.querySelectorAll('.side-bar .login-btn, .sidebar .login-btn, .channel-list .login-btn, nav button, [role="navigation"] button')].some(el=>visible(el)&&/^(登录|立即登录|登录\/注册|登录注册|未登录)$/.test(text(el)));
  if(ids.size>1||out&&ids.size)return {platform:'xiaohongshu',status:'unknown'};
  if(out)return {platform:'xiaohongshu',status:'logged_out',reason:'login_required'};
  return ids.size===1?{platform:'xiaohongshu',status:'authenticated',principal_id:[...ids][0],verification:'rendered_account_navigation'}:{platform:'xiaohongshu',status:'unknown'};
 }
 chrome.runtime.onMessage.addListener((message,sender,reply)=>{if(sender.id===chrome.runtime.id&&message.type==='crowd_session_probe')reply(observe());});
 let timer,last;
 function notify(){timer=null;const state=observe(),signature=JSON.stringify(state);if(signature===last||last===undefined&&state.status==='unknown')return;last=signature;chrome.runtime.sendMessage({type:'platform_session_changed'}).catch(()=>{});}
 const observer=new MutationObserver(()=>{if(!timer)timer=setTimeout(notify,1000);});
 if(document.documentElement)observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','href','style','hidden']});
 else document.addEventListener('DOMContentLoaded',()=>observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','href','style','hidden']}),{once:true});
 setTimeout(notify,1000);
})(globalThis);
