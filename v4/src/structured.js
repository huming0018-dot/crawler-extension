/* Whitelisted public page observations, never credentials or executable page data. */
(function(root){
'use strict';

// Parse data literals, never evaluate a webpage's executable JavaScript.
function structuredBody(script,noteId) {
 const prefix='window.__INITIAL_STATE__=';
 if(typeof script!=='string'||script.length>2000000||!script.startsWith(prefix)||! /^[a-f0-9]{24}$/.test(noteId))throw Error('invalid_hydration');
 const input=script.slice(prefix.length).replace(/;\s*$/,''), boundary=c=>!c||!/[A-Za-z0-9_$]/.test(c);
 let out='',quoted=false,escaped=false;
 for(let i=0;i<input.length;i++){
  const c=input[i];
  if(quoted){out+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
  else if(c==='"'){quoted=true;out+=c;}
  else if(input.slice(i,i+9)==='undefined'&&boundary(input[i-1])&&boundary(input[i+9])){out+='null';i+=8;}
  else if(input.slice(i,i+11)==='new Map([])'&&boundary(input[i-1])&&boundary(input[i+11])){out+='{}';i+=10;}
  else out+=c;
 }
 const note=JSON.parse(out).note?.noteDetailMap?.[noteId]?.note;
 if(!note||note.noteId!==noteId||typeof note.title!=='string'||typeof note.desc!=='string'||note.title.length>300||note.desc.length>24000)throw Error('missing_or_wrong_note');
 return {source:'page_hydration',note_id:noteId,title:note.title,text:note.desc,original_length:note.desc.length,truncated:false};
}


// Independent implementation: normal-page response observations, never DOM evidence.
// No request signing, credentials, network calls, or silent retry in this module.
class StructuredPages {
 constructor(note) {this.note=note;this.items=new Map();this.roots=new Map();this.pages=new Map();this.main={cursor:'',ended:false};this.failures=[];this.bytes=0;}
 accept(kind,inputCursor,data,root=null) {
  if(!['main','reply'].includes(kind)||typeof inputCursor!=='string'||!data||typeof data.cursor!=='string'||typeof data.has_more!=='boolean'||!Array.isArray(data.comments))throw Error('invalid_page');
  if(kind==='reply'&&!this.roots.has(root))throw Error('unknown_parent');
  const state=kind==='main'?this.main:this.roots.get(root),key=kind+':'+(root||'')+':'+inputCursor;
  if(inputCursor.length>100 || data.cursor.length>100 || data.comments.length>50)throw Error('page_budget');
  const payload=JSON.stringify(data);if(payload.length>1000000)throw Error('page_budget');
  if(this.pages.has(key)){if(this.pages.get(key)!==payload)throw Error('page_conflict');return;}
  if(this.pages.size>=250||this.bytes+new TextEncoder().encode(payload).length>1500000)throw Error('page_budget');
  if(state.ended||state.cursor!==inputCursor)throw Error('cursor_out_of_order');
  if(data.has_more&&(!data.cursor||data.cursor===inputCursor))throw Error('cursor_stalled');
  const next=[],pendingRoots=new Map();
  const add=(item,parent)=>{
   if(!item||typeof item.id!=='string'||! /^[a-f0-9]{24}$/.test(item.id)||item.note_id!==this.note||typeof item.content!=='string'||item.content.length>24000)throw Error('wrong_note_or_item');
   const pictures=item.pictures===undefined?[]:item.pictures;
   if(!Array.isArray(pictures)||pictures.some(p=>{try{const u=new URL(p.url_default);return !['http:','https:'].includes(u.protocol)||u.hostname!=='sns-webpic-qc.xhscdn.com'||u.port||u.username||u.password||u.search||u.hash||!/\/comment(?:_uhdr)?\//.test(u.pathname)||!Number.isInteger(p.width)||!Number.isInteger(p.height)||p.width<=0||p.height<=0||p.width>100000||p.height>100000;}catch(_){return true;}}))throw Error('invalid_pictures');
   const authorId=item.author_id??null,targetId=item.target_comment_id??null,author=item.author_display??null;
   if([authorId,targetId].some(id=>id!==null&&(typeof id!=='string'||!/^[a-f0-9]{24}$/.test(id))) || author!==null&&(typeof author!=='string'||author.length>100))throw Error('invalid_comment_metadata');
   const likes=item.like_count??null,time=item.create_time??null;
   if(likes!==null&&(!/^[0-9]+$/.test(String(likes))||!Number.isSafeInteger(Number(likes))||Number(likes)<0) || time!==null&&(!Number.isSafeInteger(time)||time<0))throw Error('invalid_comment_metadata');
   const record={id:item.id,parent,text:item.content,pictures,author_id:authorId,author_display:author,like_count:likes===null?null:Number(likes),create_time:time,reply_target_id:targetId,source:'page_response'};
   const existing=this.items.get(item.id)||next.find(v=>v.id===item.id);
   if(existing&&(existing.parent!==parent||existing.text!==record.text||existing.author_id!==record.author_id||existing.reply_target_id!==record.reply_target_id))throw Error('item_conflict');
   next.push(record);
  };
  for(const item of data.comments){
   add(item,root);
   if(kind==='main'){
    const count=Number(item.sub_comment_count);
    if(!Number.isSafeInteger(count)||count<0||count>10000||typeof item.sub_comment_has_more!=='boolean'||typeof item.sub_comment_cursor!=='string'||!Array.isArray(item.sub_comments))throw Error('invalid_reply_state');
    const snapshot=JSON.stringify([count,item.sub_comment_has_more,item.sub_comment_cursor]);
    if((this.roots.has(item.id)&&this.roots.get(item.id).snapshot!==snapshot)||(pendingRoots.has(item.id)&&pendingRoots.get(item.id)!==snapshot))throw Error('root_metadata_conflict');
    pendingRoots.set(item.id,snapshot);
    for(const reply of item.sub_comments)add(reply,item.id);
   }
  }
  if(new Set([...this.items.keys(),...next.map(v=>v.id)]).size>2000)throw Error('page_budget');
  // Commit a whole validated page; malformed rows cannot advance a cursor.
  for(const record of next)this.items.set(record.id,record);
  if(kind==='main')for(const item of data.comments){
   const previous=this.roots.get(item.id);
   if(!previous)this.roots.set(item.id,{cursor:item.sub_comment_cursor,ended:!item.sub_comment_has_more,declared:Number(item.sub_comment_count),snapshot:JSON.stringify([Number(item.sub_comment_count),item.sub_comment_has_more,item.sub_comment_cursor])});
  }
  state.cursor=data.cursor;state.ended=!data.has_more;this.pages.set(key,payload);this.bytes+=new TextEncoder().encode(payload).length;
 }
 summary(){
  const counts=new Map();let replies=0,images=0;
  for(const item of this.items.values()){
   if(item.parent!==null){replies++;counts.set(item.parent,(counts.get(item.parent)||0)+1);}
   images+=item.pictures.length;
  }
  const groups=[...this.roots].map(([id,s])=>({id,declared:s.declared,captured:counts.get(id)||0,ended:s.ended}));
  return {source:'page_response',roots:this.roots.size,replies,images,main_ended:this.main.ended,groups,complete:this.main.ended&&groups.every(g=>g.ended&&g.captured===g.declared)&&!this.failures.length};
 }
}


root.CrowdStructured={structuredBody,StructuredPages};
})(globalThis);
