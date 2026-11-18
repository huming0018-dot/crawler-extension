'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {extractNoteCards}=require('../core/xhs_note_cards.cjs');
function card({href=null,title=null,linkText=null,author=null}={}) {
 return {querySelector(selector) {
  if(selector.startsWith('a[href'))return href?{href,textContent:linkText}:null;
  if(selector==='.title')return title==null?null:{textContent:title};
  return author==null?null:{textContent:author};
 }};
}
function documentFor(cards){return {querySelectorAll(selector){assert.equal(selector,'section.note-item, div.note-item');return cards;}};}
test('two cards preserve their own title/link/author without cross-card fallback',()=>{
 const out=extractNoteCards(documentFor([card({href:'https://www.xiaohongshu.com/explore/A1?x=1',title:'  Alpha  ',author:'Alice'}),card({href:'https://www.xiaohongshu.com/discovery/item/B2',title:'Beta'})]));
 assert.equal(out.length,2);assert.equal(out[0].note_id,'A1');assert.equal(out[1].note_id,'B2');assert.equal(out[0].title,'Alpha');assert.equal(out[1].title,'Beta');assert.equal(out[1].author,'');assert.equal(out[1].excerpt,null);
 assert.equal(out[0].note_url,'https://www.xiaohongshu.com/explore/A1?xsec_source=pc_crowd');
});
test('empty cards skipped, no cards yields empty output',()=>{assert.deepEqual(extractNoteCards(documentFor([card()])),[]);assert.deepEqual(extractNoteCards(documentFor([])),[])});
test('missing link keeps explicit missing id and own title',()=>{const [r]=extractNoteCards(documentFor([card({title:'Own'})]));assert.equal(r.note_id,null);assert.equal(r.note_id_missing,true);assert.equal(r.note_url,null);assert.equal(r.title,'Own')});
test('title falls back only to same-card anchor text',()=>{const [r]=extractNoteCards(documentFor([card({href:'https://www.xiaohongshu.com/explore/N1',linkText:'Own link'})]));assert.equal(r.title,'Own link')});
test('historical author timestamp cleanup is retained, not promised semantically correct',()=>{const [r]=extractNoteCards(documentFor([card({title:'Own',author:'Alice 2026-11-18'})]));assert.equal(r.author,'Alice')});
test('malformed note path retains missing-id flag',()=>{const [r]=extractNoteCards(documentFor([card({href:'https://www.xiaohongshu.com/explore/',title:'Own'})]));assert.equal(r.note_id,null);assert.equal(r.note_id_missing,true)});
test('scope limitation: caller DOM is trusted, hostname is not authenticated',()=>{const [r]=extractNoteCards(documentFor([card({href:'https://untrusted.invalid/explore/N1',title:'Own'})]));assert.equal(r.note_id,'N1');assert(r.note_url.startsWith('https://untrusted.invalid/'))});
