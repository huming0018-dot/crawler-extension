#!/usr/bin/env python3
"""Compiled synthetic native framing/locking tests; no network, installed profile or SDK."""
import hashlib,json,os,pathlib,select,struct,subprocess,sys,tempfile,uuid
ROOT=pathlib.Path(__file__).resolve().parent
ORIGIN='chrome-extension://licijehcpohikchlnkbpjdjdfkcocndg/'
def frame(m):
 b=json.dumps(m).encode();return struct.pack('<I',len(b))+b
def get(p):
 assert select.select([p.stdout],[],[],8)[0], 'native response timeout'
 h=p.stdout.read(4);assert len(h)==4,h
 return json.loads(p.stdout.read(struct.unpack('<I',h)[0]))
with tempfile.TemporaryDirectory(prefix='pro-host-fixture-') as d:
 home=pathlib.Path(d);helper=home/'helper';helper.mkdir();directory=home/'extension';directory.mkdir()
 binary=helper/'host'
 subprocess.run(['swiftc','-DTESTING',os.environ.get('CROWD_TEST_HOST_SOURCE',str(ROOT/'main.swift')),str(ROOT/'ReleaseKey.swift'),'-o',str(binary)],check=True)
 manifest=json.loads((ROOT.parent/'manifest.json').read_text());(directory/'manifest.json').write_text(json.dumps(manifest))
 (helper/'config.json').write_text(json.dumps({'directory':str(directory),'extension_key':manifest['key']}))
 common={'schema':'crowd-participant-native-v1','id':str(uuid.uuid4()),'session':str(uuid.uuid4()),'epoch':10}
 hello={**common,'type':'pro_hello','version':1}
 p=subprocess.Popen([str(binary),ORIGIN],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE);p.stdin.write(frame(hello));p.stdin.flush();assert get(p)['state']=='not_ready';p.wait(5)
 child=helper/'fake.py';child.write_text('''import json,struct,sys,time
R=sys.stdin.buffer;W=sys.stdout.buffer
def send(m):
 b=json.dumps(m).encode();W.write(struct.pack('<I',len(b))+b);W.flush()
while True:
 h=R.read(4)
 if not h:break
 m=json.loads(R.read(struct.unpack('<I',h)[0]));t=m['type'];base={k:m[k] for k in ('schema','id','session','epoch')}
 if t=='rpc_result':state='complete';received=len(m['result'].get('body',''))
 elif t=='pro_stop':time.sleep(4);state='stopped';received=0
 else:state='ready';received=0
 send(dict(base,type='pro_state',run_id=None,state=state,phase='local_status',received=received,target=22,pending=0,error=None))
 if t=='pro_hello':send(dict(base,type='rpc_request',method='pro_status',params={}))
 if t=='pro_stop':break
''')
 config={'schema':'crowd-participant-pro-install-v1','python':sys.executable,'entry':str(child),'entry_sha256':hashlib.sha256(child.read_bytes()).hexdigest(),'root':str(home),'mc_root':str(home),'session_id':str(uuid.uuid4()),'max_api_requests':14,'purpose':'noncommercial_research'}
 cfg=helper/'pro-config.json';cfg.write_text(json.dumps(config));cfg.chmod(0o600)
 p=subprocess.Popen([str(binary),ORIGIN],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE);p.stdin.write(frame(hello));p.stdin.flush();assert get(p)['state']=='ready';assert get(p)['type']=='rpc_request'
 # Separate short OTA lock is obtainable; mutation still denied by persistent Pro lock.
 import fcntl
 with (helper/'update.lock').open('a') as f:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(f,fcntl.LOCK_UN)
 for action in ['apply','rollback']:
  q=subprocess.run([str(binary),ORIGIN],input=frame({'action':action,'version':manifest['version']}),capture_output=True,check=True)
  assert json.loads(q.stdout[4:])['error']=='busy'
 q=subprocess.run([str(binary),ORIGIN],input=frame({'action':'status','version':manifest['version']}),capture_output=True,check=True);assert json.loads(q.stdout[4:])['status']=='ready'
 # Native Pro permits >4096 bytes without widening old OTA.
 p.stdin.write(frame({**common,'type':'rpc_result','ok':True,'result':{'body':'a'*6000},'error':None}));p.stdin.flush();assert get(p)['received']==6000
 p.stdin.close();p.wait(10);assert json.loads((helper/'pro-state.json').read_text())['busy'] is False
 for bad in [struct.pack('<I',262145),struct.pack('<I',2)+b'\xff\xff',frame({'action':'status','version':manifest['version'],'padding':'x'*5000}),frame({**hello,'path':'/bin/sh'})]:
  q=subprocess.run([str(binary),ORIGIN],input=bad,capture_output=True,timeout=8);r=json.loads(q.stdout[4:]);assert r.get('status')=='error' or r.get('state')=='blocked';assert '/bin/sh' not in q.stdout.decode()
 # Config integrity fails closed and never executes a substituted entry.
 config['entry_sha256']='0'*64;cfg.write_text(json.dumps(config));cfg.chmod(0o600)
 q=subprocess.run([str(binary),ORIGIN],input=frame(hello),capture_output=True,timeout=8);assert json.loads(q.stdout[4:])['state']=='not_ready'
 print('PASS compiled Pro: missing deps, fixed config integrity, persistent frames, large RPC result, OTA lock isolation/busy, status compatibility, EOF stop, size/UTF8/extra-key rejection')

 # Clean transport close is not a new source outcome. No real SDK/Python needed.
 for boundary in ('terminal_eof','post_start_late_ready'):
  child.write_text("""import json,struct,sys
r=sys.stdin.buffer;w=sys.stdout.buffer
mode=MODE

def recv():
 h=r.read(4)
 return json.loads(r.read(struct.unpack('<I',h)[0])) if h else None

def send(m,state):
 base={k:m[k] for k in ('schema','session','epoch')}
 b=json.dumps(dict(base,id=m['id'],type='pro_state',run_id=None,state=state,phase='initial',received=None,target=None,pending=0,error=None)).encode()
 w.write(struct.pack('<I',len(b))+b);w.flush()
m=recv();send(m,'ready');m=recv()
if mode=='terminal_eof':send(m,'stopped')
else:send(m,'ready')
while True:
 m=recv()
 if m is None:break
 if mode=='terminal_eof':send(m,'stopped')
""".replace('MODE',repr(boundary)))
  config['entry_sha256']=hashlib.sha256(child.read_bytes()).hexdigest();cfg.write_text(json.dumps(config));cfg.chmod(0o600)
  # A new test connection begins without a prior unknown production run.
  (helper/'pro-state.json').write_text(json.dumps({'busy':False,'state':'stopped'}))
  p=subprocess.Popen([str(binary),ORIGIN],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  p.stdin.write(frame(hello));p.stdin.flush();assert get(p)['state']=='ready'
  command={**common,'id':str(uuid.uuid4())}
  if boundary=='terminal_eof':command.update(type='pro_stop',run_id=None)
  else:command.update(type='pro_start',subject=str(uuid.uuid4()),installation_id=str(uuid.uuid4()),task_id=29,intent=str(uuid.uuid4()))
  p.stdin.write(frame(command));p.stdin.flush();reply=get(p)
  assert reply['state']==('stopped' if boundary=='terminal_eof' else 'ready') and reply['pending']==0
  # Mirrors native Port disconnect: neither stdin nor response pipe remains open.
  p.stdout.close();p.stdin.close();p.wait(15)
  final=json.loads((helper/'pro-state.json').read_text());assert p.returncode==0
  assert final['busy'] is (boundary!='terminal_eof'),(boundary,final)
  assert final['state']==('stopped' if boundary=='terminal_eof' else 'unknown'),(boundary,final)
  print('PASS compiled boundary',boundary)
