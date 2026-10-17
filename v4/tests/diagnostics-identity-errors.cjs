const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
async function reportSnapshot(profile,error,sourceRoot=path.resolve(__dirname,'../src')) {
 const source=fs.readFileSync(path.join(sourceRoot,profile),'utf8');
 const errors=source.match(/const diagnosticErrors = (\[[^\n]+\]);/);assert(errors);
 const start=source.indexOf('async function reportDiagnostics() {'),end=source.indexOf('async function setDiagnostics(',start);assert(start>=0&&end>start);
 const state={enabled:false,phase:'idle',last_error:error,outbox:[],rejected:[],next_at:0};const before=JSON.stringify(state),snapshots=[],writes=[];
 const c=vm.createContext({AbortController,setTimeout,clearTimeout,Date,Number,Math,Promise,
 diagnosticSettings:async()=>({id:'00000000-0000-4000-8000-000000000001',enabled:true,revision:1}),diagnosticKey:(_id,k)=>k,
 storage:{get:async()=>null,set:async(k,v)=>writes.push({k,v})},
 api:{rpc:async(name,p)=>{assert.equal(name,'diagnostics');assert.equal(p.p_action,'report');snapshots.push(JSON.parse(JSON.stringify(p.p_state)));return {saved_at:new Date().toISOString()};}},
 agent:{read:async()=>state},kol:{read:async()=>({...state,last_error:null})},workingTab:async()=>null,
 updater:{status:async()=>({state:'applied',enabled:true})},trace:{snapshot:async()=>[]},localTests:{status:async()=>({enabled:false})},CrowdCore:{VERSION:'4.2.73'},workTabs:{lastFailure:null}});
 let kol='';if(profile==='background.js'){const a=source.indexOf('function kolDiagnosticState('),b=source.indexOf('async function diagnosticSettings(',a);kol=source.slice(a,b);}
 await vm.runInContext(`let diagnosticReport=null; const diagnosticErrors=${errors[1]};\n${kol}\n${source.slice(start,end)}\nreportDiagnostics();`,c);
 assert.equal(snapshots.length,1);assert.equal(writes.length,1);assert.equal(writes[0].k,'status');assert.equal(writes[0].v.error,null);assert.equal(JSON.stringify(state),before);
 return snapshots[0];
}
async function main(){const root=process.argv[2]||path.resolve(__dirname,'../src');let cases=0;
 for(const profile of ['participant-background.js','background.js'])for(const error of ['identity_verification_required','platform_identity_changed','login_required','captcha','cancelled',null,'SYNTHETIC_PRIVATE_URL_TOKEN','toString',{},true]){
  const snapshot=await reportSnapshot(profile,error,root);assert.equal(snapshot.error,error&&typeof error==='string'&&['identity_verification_required','platform_identity_changed','login_required','captcha','cancelled'].includes(error)?error:error?'unexpected_error':null);
  assert(!JSON.stringify(snapshot).includes('SYNTHETIC_PRIVATE'));cases++;
 }
 for(const profile of ['participant-controller.js','controller.js']){const s=fs.readFileSync(path.join(root,profile),'utf8');for(const code of ['identity_verification_required','platform_identity_changed'])assert((s.includes(code+':')||s.includes('errors.'+code+'=')),'existing UI label remains');}
 console.log(JSON.stringify({pass:true,cases,actual_reporters:2,only_diagnostic_status_write:true,source_requests:0}));
}
module.exports={reportSnapshot};if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
