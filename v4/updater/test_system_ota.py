"""Real compiled host + macOS launchd; isolated files, key and browser-state fixture."""
import json, os, pathlib, plistlib, runpy, shutil, struct, subprocess, time, uuid, zipfile, hashlib

base=runpy.run_path(str(pathlib.Path(__file__).with_name('test_host.py')))
work=base['work']; build=base['build']; key=base['keys']/'private.pem'
old=work/'ota-old.zip'; new=work/'ota-new.zip'; build('4.2.3',old);build('4.2.4',new)
def fixture(name,running=False):
    root=work/name;root.mkdir();helper=root/'helper';helper.mkdir();binary=helper/'crowd-v4-updater';shutil.copy2(base['binary'],binary)
    directory=root/'original';directory.mkdir()
    with zipfile.ZipFile(old) as z:z.extractall(directory)
    channel=root/'channel.json'
    subprocess.run(['node',str(base['ROOT']/'publish.cjs'),str(key),str(new),new.as_uri(),'10',str(channel)],check=True,capture_output=True)
    config=helper/'config.json';config.write_text(json.dumps({'directory':str(directory),'extension_key':json.loads((directory/'manifest.json').read_text())['key'],'test_channel':channel.as_uri(),'test_browser_running':running,'scheduled_enabled':False}))
    def call(action,version='4.2.3',**extra):
        msg=json.dumps(dict(action=action,version=version,**extra)).encode()
        p=subprocess.run([str(binary),'chrome-extension://licijehcpohikchlnkbpjdjdfkcocndg/'],input=struct.pack('<I',len(msg))+msg,capture_output=True,check=True)
        return json.loads(p.stdout[4:])
    return root,helper,binary,directory,channel,call

r,h,b,d,ch,call=fixture('closed')
subprocess.run([str(b),'--poll'],check=True)
assert not (h/'state.json').exists(),'system polling defaults off until preferences are synchronized'
assert call('settings',enabled=True)['status']=='configured'
label='com.crowd.ota-test.'+uuid.uuid4().hex;domain='gui/'+str(os.getuid())
plist=r/'test.plist';plist.write_bytes(plistlib.dumps({'Label':label,'ProgramArguments':[str(b),'--poll'],'RunAtLoad':True,'StartInterval':3600,'StandardErrorPath':str(r/'poll-error.log')}))
try:
    subprocess.run(['/bin/launchctl','bootstrap',domain,str(plist)],check=True,capture_output=True)
    until=time.time()+25
    while time.time()<until:
        state=json.loads((h/'state.json').read_text()) if (h/'state.json').exists() else {}
        if state.get('poll_status')=='pending_reload':break
        time.sleep(.2)
    assert state.get('poll_status')=='pending_reload',state
    assert json.loads((d/'manifest.json').read_text())['version']=='4.2.4'
    assert state['awaiting_launch'] is True
finally:
    subprocess.run(['/bin/launchctl','bootout',domain+'/'+label],capture_output=True)
state['applied_at']=time.time()-86400;(h/'state.json').write_text(json.dumps(state))
subprocess.run([str(b),'--recover'],check=True)
assert json.loads((d/'manifest.json').read_text())['version']=='4.2.4','closed browser must not trigger a false rollback'
assert call('ack',release_sha256='0'*64)['status']=='pending_reload','old loaded worker must reload the staged version'
assert call('ack','4.2.4',release_sha256=hashlib.sha256((d/'release.json').read_bytes()).hexdigest())['status']=='applied'
assert not (r/'.crowd-v4-backup').exists()

r,h,b,d,ch,call=fixture('running',True);call('settings',enabled=True)
subprocess.run([str(b),'--poll'],check=True)
assert json.loads((h/'state.json').read_text())['poll_status']=='downloaded'
assert json.loads((d/'manifest.json').read_text())['version']=='4.2.3','never replace a directory while the browser owns it'
assert not (r/'.crowd-v4-backup').exists()
ch.unlink() # Offline after the OS task: browser applies the verified cached package.
assert call('apply')['status']=='pending_reload'
assert call('ack','4.2.4',release_sha256=hashlib.sha256((d/'release.json').read_bytes()).hexdigest())['status']=='applied'
assert not (h/'cache').exists()
call('settings','4.2.4',enabled=False);subprocess.run([str(b),'--poll'],check=True) # no channel access while disabled

r,h,b,d,ch,call=fixture('tampered-cache',True);call('settings',enabled=True);subprocess.run([str(b),'--poll'],check=True)
with (h/'cache/extension.zip').open('ab') as f:f.write(b'tamper')
assert call('apply')['error']=='hash_mismatch'
assert json.loads((d/'manifest.json').read_text())['version']=='4.2.3'
print('PASS system OTA: real launchd dispatch, opt-out, verified download while running, offline cached apply, closed-browser install, deferred handshake, original worker reload, tampered cache rejection')
(work/'system-ota-result.json').write_text(json.dumps({'result':'PASS','scope':'real launchd and compiled native host; isolated files and explicit browser-state fixture'}))
