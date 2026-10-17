'use strict';
// Sign a small, pinned release envelope. Private key is never put in the artifact.
const fs=require('fs'),crypto=require('crypto'),cp=require('child_process');
const [keyfile,zip,url,sequence,out]=process.argv.slice(2);
if(!out||!/^\d+$/.test(sequence))throw Error('Usage: publish.cjs KEY ZIP PINNED_URL SEQUENCE OUTPUT');
const data=fs.readFileSync(zip),release=cp.execFileSync('/usr/bin/unzip',['-p',zip,'release.json']);
const info=JSON.parse(release);if(info.protocol!=='crowd_v4'||!/^4\.\d+\.\d+$/.test(info.version))throw Error('invalid release');
const config=cp.execFileSync('/usr/bin/unzip',['-p',zip,'src/config.js']).toString();
const publicConfig=JSON.parse(config.replace(/^globalThis.CROWD_CONFIG = /,'').replace(/;\s*$/,''));
if(Object.keys(publicConfig).sort().join(',')!=='key,portal,url'||!/^sb_publishable_|^eyJ/.test(publicConfig.key))throw Error('only public configuration may be published');
if(publicConfig.key.startsWith('eyJ')&&JSON.parse(Buffer.from(publicConfig.key.split('.')[1],'base64url')).role!=='anon')throw Error('public key required');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const payload=Buffer.from(JSON.stringify({schema:1,protocol:'crowd_v4',sequence:Number(sequence),version:info.version,url,sha256:sha(data),release_sha256:sha(release),bytes:data.length}));
fs.writeFileSync(out,JSON.stringify({payload:payload.toString('base64'),signature:crypto.sign(null,payload,fs.readFileSync(keyfile)).toString('base64')})+'\n');
console.log(JSON.stringify({version:info.version,bytes:data.length,sha256:sha(data)}));
