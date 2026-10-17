'use strict';
// Read both actual inputs; neither release numbers nor file times establish lineage.
// Parser is a developer dependency, never included in the participant extension.
const vm=require('node:vm'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const [zip,parser]=process.argv.slice(2);
if(!zip||!parser)throw Error('Usage: node tools/compare-kimi.cjs /path/to/candidate.zip /path/to/acorn');
const acorn=require(path.resolve(parser)),root=path.resolve(__dirname,'..');
const artifact=JSON.parse(execFileSync('python3',['-c',`import json,zipfile,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 print(json.dumps({n:z.read(n).decode('utf-8') for n in z.namelist() if n.endswith('.js') or n=='manifest.json'}))`,zip],{maxBuffer:8*1024*1024}));
const manifest=JSON.parse(artifact['manifest.json']),sourceManifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const clean=x=>JSON.stringify(x,(k,v)=>['start','end','raw'].includes(k)?undefined:v);
const parse=x=>acorn.parse(x,{ecmaVersion:'latest',sourceType:'script'});
const functions=ast=>new Map(ast.body.filter(n=>n.type==='FunctionDeclaration').map(n=>[n.id.name,clean(n)]));
const files=[];
for(const [name,code] of Object.entries(artifact)){
 if(!name.endsWith('.js'))continue;
 const local=name===manifest.background.service_worker?sourceManifest.background.service_worker:name;
 const file=path.resolve(root,local);
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file))throw Error('Unmatched artifact source: '+name);
 const source=fs.readFileSync(file,'utf8'),a=parse(source),b=parse(code),fa=functions(a),fb=functions(b);
 files.push({source:local,artifact:name,source_sha256:hash(source),artifact_sha256:hash(code),bytes_equal:source===code,ast_equal:clean(a)===clean(b),
 changed_top_level_functions:[...new Set([...fa.keys(),...fb.keys()])].filter(n=>fa.get(n)!==fb.get(n))});
}
async function collectProbe(code,search){
 const node=parse(code).body.find(n=>n.type==='FunctionDeclaration'&&n.id.name==='_collectOnceInner');
 const trace=[],state={proof_queue:[],participant_id:'fixture'},task={task_id:1,pack:['fixture'],kpi_min:5,known_note_ids:['known']};
 const safety={_get:async(k,f)=>state[k]??f,_set:async v=>Object.assign(state,v),
  isCircadianAllowed:async()=>({ok:true}),canStartSession:async()=>({ok:true}),queueWatermark:async()=>({full:false}),canSearch:async()=>({ok:true}),
  onRateLimited:async()=>trace.push('risk'),markSearch:async()=>trace.push('search_count'),markSessionAction:async()=>trace.push('session_count'),onSearchOutcome:async()=>({cooled:false,streak:1})};
 const context={safety,console:{warn(){},error(){}},self:{},CONFIG:{CONTENT_TIMEOUT_MS:15000,SYNC_VERSION:3},
  restoreSafetyEngine:async()=>{},fetchActiveTask:async()=>task,nextKwIndex:async()=>0,
  chrome:{runtime:{},tabs:{create:async()=>({id:1}),get:async()=>({status:'complete'}),remove:async()=>{},sendMessage:(id,msg,cb)=>cb(search)}},
  sleep:async()=>{},setTimeout:()=>1,clearTimeout:()=>{},reportRiskToServer:async()=>trace.push('report'),
  uploadProofs:async()=>{},uuidv4:()=> 'fixture-request',logError:async(_,err)=>{throw err;}};
 const result=await vm.runInNewContext('('+code.slice(node.start,node.end)+')',context,{timeout:1000})();
 return JSON.parse(JSON.stringify({result,trace,notes:state.proof_queue.flatMap(x=>x.items.map(i=>i.note_id))}));
}
(async()=>{
 const source=fs.readFileSync(path.join(root,sourceManifest.background.service_worker),'utf8'),pack=artifact[manifest.background.service_worker];
 const samples={normal:{ok:true,items:[{note_id:'known',title:'known'},{note_id:'new',title:'new note'}]},failed_risk:{ok:false,rateLimited:true,reason:'fixture'},successful_risk:{ok:true,rateLimited:true,items:[]}};
 const probes={};
 for(const [name,value] of Object.entries(samples))probes[name]={source:await collectProbe(source,value),artifact:await collectProbe(pack,value)};
 assert.deepEqual(probes.normal.source,probes.normal.artifact);assert.deepEqual(probes.normal.source.notes,['new']);
 assert.deepEqual(probes.failed_risk.source,probes.failed_risk.artifact);
 assert.deepEqual(probes.successful_risk.source.trace,['risk','report','search_count','session_count']);
 assert.deepEqual(probes.successful_risk.artifact.trace,['search_count','session_count','risk','report']);
 console.log(JSON.stringify({inputs:{source_manifest_label:sourceManifest.version,artifact_manifest_label:manifest.version,artifact_sha256:hash(fs.readFileSync(zip))},
 method:'Acorn AST without source positions, comments or literal raw spelling; limited isolated collection probes; labels do not rank versions',files,behavior_probes:probes},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
