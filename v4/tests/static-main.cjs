const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const source=path.join(__dirname,'../src'),read=n=>fs.readFileSync(path.join(source,n+'.js'),'utf8');
const note='a'.repeat(24),comment='b'.repeat(24),nonce='11111111-1111-4111-8111-111111111111',checks=[];
const row={id:comment,note_id:note,content:'root',sub_comment_count:0,sub_comment_has_more:false,sub_comment_cursor:'',sub_comments:[]};
function setup(marked=true,dropAck=0){
 const listeners=[],events=[],location={href:'https://www.xiaohongshu.com/explore/'+note+(marked?'?crowd_capture='+nonce:''),pathname:'/explore/'+note,origin:'https://www.xiaohongshu.com'};
 let calls=0;const w={addEventListener:(kind,fn)=>{if(kind==='message')listeners.push(fn);},setTimeout,
  postMessage(data){events.push(data);if(data.installed&&dropAck-->0)return;setImmediate(()=>listeners.forEach(fn=>fn({data,source:w,origin:location.origin})));},
  fetch:async()=>{calls++;return {status:200,headers:{get:()=>null},clone:()=>({text:async()=>JSON.stringify({success:true,data:{cursor:'',has_more:false,comments:[row]}})})};}};w.top=w;
 const main=vm.createContext({URL,TextEncoder,WeakMap,window:w,location}),isolated=vm.createContext({URL,TextEncoder,window:w,location,document:{scripts:[]}});
 for(const n of ['structured','site-sdk','passive'])vm.runInContext(read(n),main);for(const n of ['structured','hybrid'])vm.runInContext(read(n),isolated);
 return {w,location,events,calls:()=>calls,start:()=>main.CrowdPassive.pageObserver(),hybrid:()=>isolated.CrowdHybrid.createHybrid({window:w,document:{scripts:[]},location}),original:w.fetch};
}
const tick=()=>new Promise(r=>setImmediate(r));const dom={standard:{comment_count:1},evidence:{text:''},extra:{comments:{items:[{comment_id:comment}]}}};
(async()=>{
 let t=setup(false);t.start();assert.equal(t.w.fetch,t.original);assert.equal(t.calls(),0);checks.push('No marker installs no hook or request');
 t=setup();t.start();await t.w.fetch('https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id='+note);await tick();assert.equal(t.events.filter(e=>e.page).length,0);const h=t.hybrid();h.bind(nonce);await tick();await tick();assert.equal(h.snapshot(note,dom,'doc').complete,true);assert.equal(t.calls(),1);checks.push('MAIN first buffers early sanitized page until READY without extra request');
 t=setup();const h2=t.hybrid();h2.bind(nonce);t.start();await tick();await t.w.fetch('https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id='+note);await tick();await tick();assert.equal(h2.snapshot(note,dom,'doc').complete,true);checks.push('ISOLATED first handshake installs observer');
 t=setup(true,1);t.start();const h3=t.hybrid();h3.bind(nonce);await new Promise(r=>setTimeout(r,350));assert.equal(h3.snapshot(note,dom,'doc').observer_status,'installed');assert.equal(t.calls(),0);checks.push('Lost first installation ACK recovered by bounded READY retry');
 t=setup();t.start();t.w.postMessage({type:'crowd_public_ready_v1',nonce:'bad',note_id:note});await tick();await t.w.fetch('https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id='+note);await tick();assert.equal(t.events.filter(e=>e.page||e.installed).length,0);checks.push('Wrong nonce never activates response bridge');
 t=setup();t.start();const h4=t.hybrid();h4.bind(nonce);await tick();await t.w.fetch('https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id='+'c'.repeat(24));await tick();await tick();assert.equal(h4.snapshot(note,dom,'doc').items.length,0);assert.equal(t.calls(),1);checks.push('Wrong note never enters graph');
 t=setup();t.start();const h5=t.hybrid();h5.bind(nonce);await tick();t.location.href=t.location.href.replace(nonce,'22222222-2222-4222-8222-222222222222');await t.w.fetch('https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id='+note);await tick();await tick();assert.equal(h5.snapshot(note,dom,'doc'),null);t.location.href=t.location.href.replace('22222222-2222-4222-8222-222222222222',nonce);assert.equal(h5.snapshot(note,dom,'doc'),null);checks.push('Changed owned marker permanently stops emission and snapshot');
 assert.ok(!read('hybrid').includes('createElement'));assert.ok(!read('hybrid').includes('pageObserver.toString'));checks.push('ISOLATED no longer creates dynamic script sink');
 console.log(JSON.stringify({checks}));
})().catch(e=>{console.error(e);process.exitCode=1;});
