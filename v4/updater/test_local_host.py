#!/usr/bin/env python3
"""Compile the separate keyless host in /tmp. Never install a host or launchd job."""
import argparse,hashlib,json,pathlib,shutil,struct,subprocess,tempfile,zipfile
ROOT=pathlib.Path(__file__).resolve().parent
parser=argparse.ArgumentParser();parser.add_argument('--source-v4',type=pathlib.Path,default=ROOT.parent);args=parser.parse_args()
work=pathlib.Path(tempfile.mkdtemp(prefix='crowd-local-host-test-')).resolve()
helper=work/'helper';helper.mkdir();directory=work/'原本机测试';directory.mkdir()
private=work/'fixture-private.pem';key=work/'ReleaseKey.swift'
subprocess.run(['node','-e',"const f=require('fs'),c=require('crypto'),k=c.generateKeyPairSync('ed25519');f.writeFileSync(process.argv[1],k.privateKey.export({type:'pkcs8',format:'pem'}));f.writeFileSync(process.argv[2],'let releasePublicKey = '+JSON.stringify(k.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64'))+'\\n');",str(private),str(key)],check=True)
profile=work/'LocalTestProfile.swift'
profile.write_text(''.join('let '+k+' = '+json.dumps(v,ensure_ascii=False)+'\n' for k,v in {'localTestExtensionID':'ipccepibnkcfpikgebdaanimocdappfk','localTestDirectory':str(directory),'localTestChannelURL':'https://raw.githubusercontent.com/huming0018-dot/crowd-pages/codex/v4.0.6-handoff/v4/releases/local-test-channel.json'}.items()))
binary=helper/'crowd-v4-updater'
subprocess.run(['swiftc','-O','-DTESTING','-DLOCAL_TEST','-module-cache-path','/private/tmp/crowd-swift-cache',str(ROOT/'main.swift'),str(key),str(profile),'-o',str(binary)],check=True)
source=work/'source';shutil.copytree(args.source_v4,source,ignore=shutil.ignore_patterns('dist','__pycache__'))
def build(ver):
    m=json.loads((source/'manifest.json').read_text());m.pop('key',None);m['version']=ver;(source/'manifest.json').write_text(json.dumps(m))
    import re
    p=source/'src/core.js';p.write_text(re.sub(r"VERSION = '4\.\d+\.\d+'",f"VERSION = '{ver}'",p.read_text()))
    package=work/(ver+'.zip');subprocess.run(['python3',str(source/'build.py'),'--local-test','--output',str(package)],check=True,capture_output=True);return package
old=build('4.2.13');new=build('4.2.14')
with zipfile.ZipFile(old) as z:z.extractall(directory)
channel=work/'channel.json';config={'directory':str(directory),'extension_id':'ipccepibnkcfpikgebdaanimocdappfk','test_channel':channel.as_uri()};(helper/'config.json').write_text(json.dumps(config))
def publish(package,sequence):subprocess.run(['node',str(ROOT/'publish.cjs'),str(private),str(package),package.as_uri(),str(sequence),str(channel)],check=True,capture_output=True)
def call(action,ver='4.2.13',origin='ipccepibnkcfpikgebdaanimocdappfk',**extra):
    msg=json.dumps({'action':action,'version':ver,**extra}).encode();r=subprocess.run([str(binary),'chrome-extension://'+origin+'/'],input=struct.pack('<I',len(msg))+msg,capture_output=True,check=True);return json.loads(r.stdout[4:])
publish(new,1)
assert call('status',origin='licijehcpohikchlnkbpjdjdfkcocndg')['error']=='invalid_origin'
r=call('start');assert r.get('error')=='invalid_request',r
assert call('apply')['status']=='pending_reload'
sha=hashlib.sha256((directory/'release.json').read_bytes()).hexdigest()
r=call('ack','4.2.14',release_sha256=sha);assert r['status']=='applied' and r['profile']=='local-test' and r['release_sha256']==sha,r
assert call('ack','4.2.14',release_sha256='0'*64)['error']=='handshake_mismatch'
assert call('ack','4.2.14',release_sha256=sha)['status']=='applied'
config['directory']=str(source);(helper/'config.json').write_text(json.dumps(config));assert call('status','4.2.14')['error']=='wrong_extension'
config['directory']=str(directory);(helper/'config.json').write_text(json.dumps(config))
shutil.rmtree(directory);directory.mkdir()
with zipfile.ZipFile(old) as z:z.extractall(directory)
(helper/'state.json').unlink()
envelope=json.loads(channel.read_text());envelope['signature']='AA==';channel.write_text(json.dumps(envelope));assert call('apply')['error']=='invalid_signature'
publish(new,2);original=new.read_bytes();new.write_bytes(original+b'tamper');assert call('apply')['error']=='hash_mismatch';new.write_bytes(original)
assert call('apply')['status']=='pending_reload'
assert (work/'.crowd-v4-local-test-backup').exists() and not (work/'.crowd-v4-backup').exists()
assert call('rollback','4.2.14')['status']=='rolled_back'
assert json.loads((directory/'manifest.json').read_text())['version']=='4.2.13'
assert call('apply')['error']=='replayed_release'
with zipfile.ZipFile(new) as z:files={n:z.read(n) for n in z.namelist()}
manifest=json.loads(files['manifest.json']);manifest['permissions'].append('tabs');files['manifest.json']=json.dumps(manifest).encode()
release=json.loads(files['release.json']);release['files']={n:hashlib.sha256(b).hexdigest() for n,b in files.items() if n!='release.json'};files['release.json']=json.dumps(release).encode()
changed=work/'permission.zip'
with zipfile.ZipFile(changed,'w',zipfile.ZIP_DEFLATED) as z:
    for n,b in files.items():
        item=zipfile.ZipInfo(n);item.create_system=3;item.external_attr=0o100644<<16;z.writestr(item,b)
publish(changed,3);assert call('apply')['error']=='permission_change'
print(json.dumps({'result':'PASS','fixture':str(work),'host_installed':False,'launchagent_installed':False,'real_collection':False,'checks':['keyless signed upgrade','exact origin and path','no start action','digest handshake','signature/hash rejection','separate backup','rollback/replay','permission rejection']},ensure_ascii=False))
