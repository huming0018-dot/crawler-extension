'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('v4/src/content.js','utf8');
const helpers=source.slice(source.indexOf('  const commentPanel'),source.indexOf('  function note('));
const action=source.slice(source.indexOf("    if (action === 'comments')"),source.indexOf("    if (action === 'scroll')"));
let reported=39,empty=true;const marker={visible:true,innerText:'这是一片荒地，点击评论'};const body={};const calls=[];
const panel={visible:true,parentElement:body,scrollHeight:1500,clientHeight:500,scrollTop:0,
 querySelector:()=>null,querySelectorAll:selector=>selector.includes('.no-comments')&&empty?[marker]:[],
 getBoundingClientRect:()=>({top:0,bottom:500}),scrollIntoView:()=>calls.push({into:true}),
 scrollTo:opts=>{calls.push(opts);panel.scrollTop=Math.min(panel.scrollHeight-panel.clientHeight,Math.max(0,opts.top));},
 scrollBy:opts=>{calls.push(opts);if(opts.behavior!=='smooth')panel.scrollTop=Math.min(panel.scrollHeight-panel.clientHeight,panel.scrollTop+opts.top);}};
const scope={querySelectorAll:selector=>selector.includes('.comments-el')?[panel]:[]};
const context=vm.createContext({URL,workDocument:'synthetic-document',note:()=>({ready:true,record:{standard:{comment_count:reported},extra:{}}}),document:{body,scrollingElement:panel},window:{},innerHeight:500,visible:x=>!!x?.visible,text:x=>x?.innerText||'',noteScope:()=>scope,first:()=>null,getComputedStyle:()=>({overflowY:'auto'}),parseCount:()=>null,platform:{noteURL:()=>({id:'a'.repeat(24)})},location:{href:'https://www.xiaohongshu.com/explore/'+'a'.repeat(24)}});
vm.runInContext(fs.readFileSync('v4/src/core.js','utf8')+'\nconst C=CrowdCore;',context);
vm.runInContext(helpers+'\nglobalThis.read=(record)=>comments(record,true);\nglobalThis.act=(boundWork=false)=>{const action="comments";'+action+'};',context);
context.note=()=>({ready:true,record:{standard:{comment_count:reported},extra:{comments:context.read({})}}});
const found=context.read({standard:{},extra:{}});assert.equal(found.panel_found,true);assert.equal(found.progress.empty,true);assert.equal(found.items.length,0);
empty=false;panel.scrollBy({top:400,behavior:'smooth'});assert.equal(panel.scrollTop,0,'fixture models paused background animation');context.act();assert.equal(panel.scrollTop,1000);assert.equal(calls.at(-1).behavior,'instant');context.act();context.act();assert.equal(panel.scrollTop,1000);assert.equal(context.read({}).progress.at_end,true);
console.log('PASS actual comments-el/no-comments parser; background smooth no-progress model replaced by bounded instant scroll to actual bottom (synthetic DOM only)');
context.document.hidden=true;const beforeHidden=calls.length;const hiddenReply=context.act(true);assert.equal(hiddenReply.needs_visible_page,true);assert.equal(calls.length,beforeHidden);assert.equal(panel.scrollTop,1000);assert.equal(context.read({}).progress.page_visible,false);const beforeLegacy=calls.length;assert.equal(context.act().needs_visible_page,undefined);assert.equal(calls.length,beforeLegacy+1);panel.scrollTop=1000;context.document.hidden=false;
const callsBeforeBottom=calls.length;context.act();assert.equal(panel.scrollTop,900);assert.equal(calls.length,callsBeforeBottom+1);context.act();assert.equal(panel.scrollTop,1000);assert.equal(calls.length,callsBeforeBottom+2);console.log('PASS each separate comment action moves once: unfinished bottom backs up .2 viewport, next action advances .8');
const makeNode=(i,mediaOnly)=>{
 const node={visible:true,id:'comment-'+('a'+i),parentElement:{closest:()=>null},getAttribute:()=>null,matches:()=>false,closest:()=>null};
 const images=mediaOnly?Array.from({length:5},()=>({visible:true,src:'https://picasso-static.xiaohongshu.com/emoji/a.png',getAttribute:()=>null,closest:()=>node,matches:()=>true})):[];
 const content={visible:true,innerText:mediaOnly?'':'text '+i,closest:()=>node,querySelectorAll:()=>images};
 node.querySelectorAll=s=>s.startsWith('img.')?images:s.includes('.content')?[content]:[];
 return {node,images};
};
const entries=Array.from({length:13},(_,i)=>makeNode(i,i>=11));
panel.querySelector=s=>s==='.comment-item'?entries[0].node:null;
panel.querySelectorAll=s=>s==='.comment-item'?entries.map(e=>e.node):[];
let actual=context.read({});assert.equal(actual.items.length,13);assert.equal(actual.items.filter(x=>x.content_kind==='media_only').length,2);assert.equal(actual.items[11].text,'');assert.equal(actual.items[11].original_length,0);assert.equal(actual.items[11].media.length,5);assert.equal(actual.items[11].media[0].alt,null);assert.equal(actual.truncated,false);
reported=13;context.document.hidden=true;assert.equal(context.act(true).needs_visible_page,undefined,'complete known count does not request window');panel.scrollTop=1000;
entries[11].images[0].src='https://evil.example/image.png';actual=context.read({});assert.equal(actual.truncated,true);assert.equal(actual.items[11].media.length,4);assert.equal(context.act(true).needs_visible_page,true,'truncated image capture is not complete despite equal item count');context.document.hidden=false;
entries[11].images.push(...Array.from({length:30},()=>entries[11].images[1]));actual=context.read({});assert.equal(actual.truncated,true);assert.equal(actual.items[11].media.length,20);
console.log('PASS actual full parser keeps 11 text + 2 media-only roots with exact empty text/5 emoji URLs; invalid or >20 images make partial, not false complete');
