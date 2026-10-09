import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.CROWD_TEST_TOOLS+'/node_modules/playwright/index.mjs'));
const browser=await chromium.launch({executablePath:process.env.CROWD_CHROMIUM,headless:true});
const src=path.resolve('v4/src'),a='a'.repeat(24),creator='d'.repeat(24),bili='BV1xx411c7mD';
const sources={
 xhs:`<section class="note-container"><h1 id="detail-title">真实DOM测试标题</h1><div id="detail-desc">作者原文，不是搜索摘要。</div><div class="author-wrapper"><a href="https://www.xiaohongshu.com/user/profile/${creator}"><span class="username">作者</span></a></div><span class="date">2026-10-08</span><div class="comments-container"><div class="parent-comment"><div class="comment-item" data-comment-id="root-1"><div class="content">一级评论</div><div class="comment-item comment-item-sub" data-comment-id="reply-1"><div class="content">实际二级回复</div></div></div><button class="show-more" onclick="this.insertAdjacentHTML('beforebegin','<div class=&quot;comment-item comment-item-sub&quot; data-comment-id=&quot;reply-2&quot;><div class=&quot;content&quot;>展开后回复</div></div>');this.remove()">展开1条回复</button></div></div></section><div class="interact-container"><span class="like-wrapper"><span class="count">1.2万</span></span></div>`,
 bili:`<h1 class="video-title">B站公开视频</h1><div class="basic-desc-info">视频简介原文。</div><div class="up-info"><a href="https://space.bilibili.com/123">UP主</a></div><span class="view-text">1.2万</span><span class="video-like-info">123</span><span class="pubdate-ip-text">2026-10-08 12:00:00</span><div class="reply-list"><div class="reply-item" data-id="100"><div class="reply-content">可见评论</div></div></div>`
};
sources.xhsProfile=`<div class="user-info"><span class="user-name">作者</span><div class="user-interactions"><div>粉丝<span class="count">1.2万</span></div><div>笔记<span class="count">20</span></div></div></div><section class="note-item"><a href="https://www.xiaohongshu.com/explore/${a}?xsec_token=LOCAL_NAVIGATION_ONLY">公开内容</a></section>`;
sources.biliProfile=`<div class="upinfo"><span class="nickname">UP主</span><span id="n-fs">2.3万</span><span id="n-video"><span class="n-num">8</span></span></div><div class="bili-video-card"><a href="https://www.bilibili.com/video/${bili}">公开视频</a></div>`;
const result={scope:'Synthetic rendered DOM in actual Chromium; no real platform collection',records:[],profiles:[]};
try{
 const page=await browser.newPage();await page.route('**/*',route=>{const url=route.request().url(),key=url.includes('/user/profile/')?'xhsProfile':url.includes('space.bilibili')?'biliProfile':url.includes('xiaohongshu')?'xhs':'bili';return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:'<!doctype html><html><body>'+sources[key]+'</body></html>'});});
 for(const [platform,id,author,url] of [['xiaohongshu',a,creator,'https://www.xiaohongshu.com/explore/'+a],['bilibili',bili,'123','https://www.bilibili.com/video/'+bili]]){
  await page.goto(url);for(const file of ['core.js','kol.js',...(platform==='xiaohongshu'?['content.js']:[]),'kol-content.js'])await page.addScriptTag({path:path.join(src,file)});
  const task={platform,target_kind:'creator',target_id:author,comment_limit:0,include_replies:false};
  let data=await page.evaluate(task=>CrowdKOLPage.probe({action:'detail',task}),task);
  assert.equal((await page.evaluate(platform=>CrowdKOLPage.probe({action:'principal',platform}),platform)).ready,false,'article author is not current login identity');
  await page.evaluate(({platform,author})=>document.body.insertAdjacentHTML('afterbegin',platform==='xiaohongshu'?`<nav><a href="https://www.xiaohongshu.com/user/profile/${author}">我</a></nav>`:`<header class="bili-header"><a class="header-avatar-wrap" href="https://space.bilibili.com/${author}"><img alt="头像" style="width:24px;height:24px"></a></header>`),{platform,author});
  const principal=await page.evaluate(platform=>CrowdKOLPage.probe({action:'principal',platform}),platform);
  assert.equal(principal.ready,true);assert.equal(principal.principal_id,author);assert.equal(principal.verification,'rendered_account_navigation');
  assert.equal(data.ready,true);assert.equal(data.record.standard.note_id,id);assert.equal(data.record.extra.author.id,author);assert.equal(data.record.extra.comments,undefined,'default comments off');
  task.comment_limit=20;task.include_replies=true;
  if(platform==='xiaohongshu')await page.evaluate(task=>CrowdKOLPage.probe({action:'comments',task}),task);
  data=await page.evaluate(task=>CrowdKOLPage.probe({action:'detail',task}),task);
  assert.equal(data.record.extra.comments.complete,false);assert.ok(data.record.extra.comments.items.length>=1);
  assert.ok(data.record.extra.comments.items.every(item=>item.author_display===null));
  if(platform==='xiaohongshu'){
    assert.equal(data.record.extra.field_observations.like_count.status,'approximate');
    assert.ok(data.record.extra.comments.items.some(item=>item.parent_key&&item.text==='展开后回复'));
  }else assert.equal(data.record.extra.field_observations.view_count.status,'approximate');
  result.records.push({platform,record:data.record});
  await page.goto(platform==='xiaohongshu'?'https://www.xiaohongshu.com/user/profile/'+creator:'https://space.bilibili.com/123/video');
  for(const file of ['core.js','kol.js',...(platform==='xiaohongshu'?['content.js']:[]),'kol-content.js'])await page.addScriptTag({path:path.join(src,file)});
  const found=await page.evaluate(task=>CrowdKOLPage.probe({action:'discover',task}),task);
  assert.equal(found.ready,true);assert.equal(found.creator_id,author);assert.equal(found.links.length,1);assert.equal(found.profile.metrics.followers.status,'approximate');
  const {notes,...profile}=found.profile;result.profiles.push({platform,profile});
 }
 result.result='PASS';if(process.env.CROWD_KOL_RECORDS)fs.writeFileSync(process.env.CROWD_KOL_RECORDS,JSON.stringify(result,null,2));
 console.log('PASS KOL DOM: XHS/Bilibili identities, source body, approximate metrics, zero-comment mode, explicit XHS visible replies, anonymized comment authors');
}finally{await browser.close();}
