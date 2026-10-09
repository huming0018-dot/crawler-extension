#!/usr/bin/env python3
"""Real compiled host: signed upgrade, ack, tampering, rollback and replay rejection."""
import importlib.util,json,os,pathlib,shutil,struct,subprocess,tempfile,time,zipfile,hashlib
ROOT=pathlib.Path(__file__).resolve().parent
work=pathlib.Path(tempfile.mkdtemp(prefix='crowd-host-test-')).resolve()
print('Fixture:',work,flush=True)
keys=work/'keys';keys.mkdir()
subprocess.run(['node','-e',"const f=require('fs'),c=require('crypto'),k=c.generateKeyPairSync('ed25519');f.writeFileSync(process.argv[1],k.privateKey.export({type:'pkcs8',format:'pem'}));f.writeFileSync(process.argv[2],'let releasePublicKey = \\\"'+k.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64')+'\\\"\\n');",str(keys/'private.pem'),str(keys/'ReleaseKey.swift')],check=True)
# The fixture key is never the production publishing key.
helper=work/'helper';helper.mkdir();binary=helper/'crowd-v4-updater'
subprocess.run(['swiftc','-O','-DTESTING','-module-cache-path','/private/tmp/crowd-swift-cache',str(ROOT/'main.swift'),str(keys/'ReleaseKey.swift'),'-o',str(binary)],check=True)
source=work/'source';shutil.copytree(ROOT.parent,source,ignore=shutil.ignore_patterns('dist','__pycache__'))
def build(ver,out):
    m=json.loads((source/'manifest.json').read_text());m['version']=ver;(source/'manifest.json').write_text(json.dumps(m))
    p=source/'src/core.js';s=p.read_text();import re;p.write_text(re.sub(r"VERSION = '4\.\d+\.\d+'",f"VERSION = '{ver}'",s))
    subprocess.run(['python3',str(source/'build.py'),'--output',str(out)],check=True,capture_output=True)
old=work/'old.zip';new=work/'new.zip';build('4.2.0',old);build('4.2.1',new)
directory=work/'原插件';directory.mkdir()
with zipfile.ZipFile(old) as z:z.extractall(directory)
channel=work/'channel.json'
config={'directory':str(directory),'extension_key':json.loads((directory/'manifest.json').read_text())['key'],'test_channel':channel.as_uri()}
(helper/'config.json').write_text(json.dumps(config))
def publish(package,sequence=1):subprocess.run(['node',str(ROOT/'publish.cjs'),str(keys/'private.pem'),str(package),package.as_uri(),str(sequence),str(channel)],check=True,capture_output=True)
def call(action,version='4.2.0',**extra):
    msg=json.dumps(dict(action=action,version=version,**extra)).encode();p=subprocess.run([str(binary),'chrome-extension://licijehcpohikchlnkbpjdjdfkcocndg/'],input=struct.pack('<I',len(msg))+msg,capture_output=True,check=True)
    assert len(p.stdout)>=4,(p.stdout,p.stderr)
    result=json.loads(p.stdout[4:]);return result
publish(new)
assert call('status')['status']=='ready'
r=call('apply');assert r=={'status':'pending_reload','version':'4.2.1'},r
assert (work/'.crowd-v4-backup').exists()
assert call('ack','4.2.1',release_sha256='0'*64)['error']=='handshake_mismatch'
sha=hashlib.sha256((directory/'release.json').read_bytes()).hexdigest()
assert call('ack','4.2.1',release_sha256=sha)['status']=='applied'
assert not (work/'.crowd-v4-backup').exists()
assert call('apply','4.2.1')['status']=='current'
# Fresh old installation, invalid signature never changes original files.
shutil.rmtree(directory);directory.mkdir()
with zipfile.ZipFile(old) as z:z.extractall(directory)
(helper/'state.json').unlink();envelope=json.loads(channel.read_text());envelope['signature']='AA==';channel.write_text(json.dumps(envelope))
assert call('apply')['error']=='invalid_signature'
assert json.loads((directory/'manifest.json').read_text())['version']=='4.2.0'
publish(new,2);original=new.read_bytes();new.write_bytes(original+b'tamper');assert call('apply')['error']=='hash_mismatch';new.write_bytes(original)
assert call('apply')['status']=='pending_reload'
assert call('rollback','4.2.1')['status']=='rolled_back'
assert json.loads((directory/'manifest.json').read_text())['version']=='4.2.0'
assert call('apply')['error']=='replayed_release'
publish(new,3);assert call('apply')['status']=='pending_reload'
s=json.loads((helper/'state.json').read_text());s['applied_at']=time.time()-400;(helper/'state.json').write_text(json.dumps(s))
subprocess.run([str(binary),'--recover'],check=True,capture_output=True)
assert json.loads((directory/'manifest.json').read_text())['version']=='4.2.0'
# Validly signed permission changes and unsafe archive paths must still fail closed.
with zipfile.ZipFile(new) as z:package={n:z.read(n) for n in z.namelist()}
def repack(files,target):
    release=json.loads(files['release.json']);release['files']={n:hashlib.sha256(b).hexdigest() for n,b in files.items() if n!='release.json'};files={**files,'release.json':json.dumps(release).encode()}
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as z:
        for n,b in files.items():
            i=zipfile.ZipInfo(n);i.create_system=3;i.external_attr=0o100644<<16;i.compress_type=zipfile.ZIP_DEFLATED;z.writestr(i,b)
    return target
m=json.loads(package['manifest.json']);m['permissions'].append('tabs')
changed=repack({**package,'manifest.json':json.dumps(m).encode()},work/'permission.zip');publish(changed,4)
assert call('apply')['error']=='permission_change'
unsafe=repack({**package,'../escape':b'forbidden'},work/'unsafe.zip');publish(unsafe,4)
assert call('apply')['error']=='unsafe_archive';assert not (work/'escape').exists()
# Simulate a killed download/extraction before the atomic switch.
stage=work/'.crowd-v4-stage';stage.mkdir();(stage/'partial').write_text('partial')
s=json.loads((helper/'state.json').read_text());s['staging_at']=time.time()-400;(helper/'state.json').write_text(json.dumps(s))
subprocess.run([str(binary),'--recover'],check=True,capture_output=True);assert not stage.exists()
assert json.loads((directory/'manifest.json').read_text())['version']=='4.2.0'
# Keep this isolated fixture for the real browser test. No live participant data.
publish(new,4)
(work/'fixture.json').write_text(json.dumps({'helper':str(helper),'directory':str(directory),'old':str(old),'new':str(new),'channel':str(channel),'private_key':str(keys/'private.pem')}))
print('PASS compiled native host: signature, package hash, atomic replacement, handshake, backup cleanup, rollback, failed-release replay, timed recovery, permission expansion, archive traversal and interrupted staging',flush=True)
print('FIXTURE='+str(work),flush=True)
