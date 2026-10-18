"""Original compiled host regressions plus a negotiated optional-capability child. Temp only."""
from pathlib import Path
import hashlib,json,os,subprocess,tempfile
UP=Path(__file__).resolve().parent;C=UP/'main.swift'
original=(UP/'test_pro_host.py').read_text();source=original.replace('ROOT=pathlib.Path(__file__).resolve().parent','ROOT=pathlib.Path('+repr(str(UP))+')')
cap={'schema':'crowd-participant-pro-capability-v1','runtime_sha256':'a'*64,'entry_sha256':'b'*64,'worker_sha256':'c'*64,'upstream_commit':'d'*40,'comment_options_v1':True,'max_api_requests':14}
for mode in ['optional']:
 code=source
 if mode=='optional':
  code=code.replace("'type':'pro_hello','version':1}","'type':'pro_hello','version':1,'capability_request':'pro_comment_options_v1'}")
  assert code.count("received=received,target=22,pending=0,error=None))")==1
  code=code.replace('received=received,target=22,pending=0,error=None))','received=received,target=22,pending=0,error=None,capabilities='+repr(cap)+'))')
  needle="assert get(p)['state']=='ready';assert get(p)['type']=='rpc_request'";assert needle in code
  code=code.replace(needle,"reply=get(p);assert reply['state']=='ready';assert reply['capabilities']=="+repr(cap)+";assert get(p)['type']=='rpc_request'")
 with tempfile.TemporaryDirectory(prefix='g07-compiled-host-')as t:
  test=Path(t)/'test.py';test.write_text(code);r=subprocess.run(['python3','-B',str(test)],env={**os.environ,'CROWD_TEST_HOST_SOURCE':str(C)},capture_output=True,text=True,timeout=90)
  assert r.returncode==0,r.stdout+r.stderr
print(json.dumps({'status':'PASS','compiled_modes':['negotiated_optional_existing_original_assertions'],'source_sha256':hashlib.sha256(C.read_bytes()).hexdigest(),'original_test_sha256':hashlib.sha256((UP/'test_pro_host.py').read_bytes()).hexdigest(),'actual_sdk_or_profile':False}))
