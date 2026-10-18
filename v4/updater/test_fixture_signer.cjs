'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
const helper=path.resolve(process.argv[2]||path.join(__dirname,'candidate/v4/updater/test_publish_fixture.cjs'));
const work=fs.mkdtempSync(path.join(os.tmpdir(),'crowd-fixture-sign-')),zip=path.join(work,'fixture.zip'),key=path.join(work,'fixture-private.pem'),out=path.join(work,'channel.json');
try{
 const pair=crypto.generateKeyPairSync('ed25519');fs.writeFileSync(key,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
 cp.execFileSync('python3',['-c',"import zipfile,json,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('release.json',json.dumps({'protocol':'crowd_v4','version':'4.2.79'}))\n z.writestr('src/config.js','globalThis.CROWD_CONFIG = '+json.dumps({'url':'https://fixture.invalid','key':'sb_publishable_fixture','portal':'https://fixture.invalid'})+';')",zip]);
 cp.execFileSync(process.execPath,[helper,key,zip,pathToFileURL(zip).href,'79',out],{stdio:'pipe'});
 const envelope=JSON.parse(fs.readFileSync(out)),payload=Buffer.from(envelope.payload,'base64'),release=JSON.parse(payload);
 assert.equal(crypto.verify(null,payload,pair.publicKey,Buffer.from(envelope.signature,'base64')),true);assert.equal(release.url,pathToFileURL(zip).href);assert.equal(release.sequence,79);assert.equal(release.bytes,fs.statSync(zip).size);assert.equal(release.sha256,crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex'));
 const raw=cp.execFileSync('/usr/bin/unzip',['-p',zip,'release.json']);assert.equal(release.release_sha256,crypto.createHash('sha256').update(raw).digest('hex'));
 fs.unlinkSync(out);
 for(const url of [pathToFileURL(zip).href+'?x',pathToFileURL(path.join(work,'other.zip')).href,'https://example.invalid/fixture.zip']){
  const r=cp.spawnSync(process.execPath,[helper,key,zip,url,'79',out],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/fixture_url_mismatch/);assert.equal(fs.existsSync(out),false);
 }
 console.log(JSON.stringify({ephemeral_fixture_signature_verified:true,payload_hashes_exact:true,wrong_fixture_urls_rejected:3,no_real_key:true}));
}finally{fs.rmSync(work,{recursive:true,force:true});}
