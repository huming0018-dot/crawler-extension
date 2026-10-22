'use strict';
const assert=require('node:assert/strict'),cp=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const publisher=path.resolve(process.argv[2]||path.join(__dirname,'publish.cjs'));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crowd-publisher-url-'));
const prefix='https://raw.githubusercontent.com/huming0018-dot/crowd-pages/';
const valid=prefix+'a'.repeat(40)+'/v4/releases/crowd-v4.2.79-mac.zip';
const bad=[valid.replace('a'.repeat(40),'a'.repeat(7)),valid.replace('a'.repeat(40),'a'.repeat(39)),valid.replace('a'.repeat(40),'a'.repeat(41)),valid+'?download=1',valid+'#x',valid.replace('/crowd-pages/','/wrong-repo/'),valid.replace('/v4/releases/','/v4/releases/participants/'),valid.replace('https:','http:'),valid.replace('a'.repeat(40),'A'.repeat(40)),valid.replace('raw.githubusercontent.com','raw.githubusercontent.com.evil.invalid'),valid.replace('.zip','.exe'),valid+'\n','file:///tmp/package.zip'];
try{
 for(const url of bad){
  const output=path.join(dir,'channel.json');
  const r=cp.spawnSync(process.execPath,[publisher,path.join(dir,'missing-key'),path.join(dir,'missing.zip'),url,'79',output],{encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/Error: invalid_url/);assert.doesNotMatch(r.stderr,/ENOENT/);assert.equal(fs.existsSync(output),false);
 }
 // Valid URL passes only the new guard, then fails before ZIP/key access succeeds.
 const r=cp.spawnSync(process.execPath,[publisher,path.join(dir,'missing-key'),path.join(dir,'missing.zip'),valid,'79',path.join(dir,'channel.json')],{encoding:'utf8'});
 assert.notEqual(r.status,0);assert.match(r.stderr,/ENOENT/);assert.doesNotMatch(r.stderr,/Error: invalid_url/);
 console.log(JSON.stringify({invalid_urls_rejected_before_file_io:bad.length,valid_full_sha_passes_guard:true,no_signing:true}));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
