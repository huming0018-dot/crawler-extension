#!/usr/bin/env python3
"""Compile actual configuration prefix in all three profiles; no host IPC/network."""
import pathlib,subprocess,tempfile,json,sys
source=pathlib.Path(sys.argv[1]);old='https://raw.githubusercontent.com/huming0018-dot/crowd-pages/codex/v4.0.6-handoff/v4/releases/channel-participants-pro.json';new=old.replace('channel-participants-pro.json','channel-participants-pro-native-v2.json')
text=source.read_text();prefix=text[:text.index('let origin =')]
with tempfile.TemporaryDirectory(prefix='native-channel-contract-')as d:
 p=pathlib.Path(d);s=p/'main.swift'
 s.write_text('#if LOCAL_TEST\nlet localTestExtensionID="ipccepibnkcfpikgebdaanimocdappfk"\nlet localTestChannelURL="https://example.invalid/local"\n#endif\n'+prefix+'\nprint(channelURL)\nprint(extensionID)\nprint(hostName)\n')
 for label,flags,expected in [('native-v2',['-DPARTICIPANT','-DPRO_PARTICIPANT_NATIVE_V2'],new),('participant',['-DPARTICIPANT'],old),('formal',[],old.replace('channel-participants-pro.json','channel-kol.json')),('local',['-DLOCAL_TEST','-DPRO_PARTICIPANT_NATIVE_V2'],'https://example.invalid/local')]:
  binary=p/label;subprocess.run(['swiftc',*flags,str(s),'-o',str(binary)],check=True);lines=subprocess.check_output([str(binary)],text=True).splitlines();assert lines[0]==expected,(label,lines[0],expected)
  if label!='local':assert lines[1:]==['licijehcpohikchlnkbpjdjdfkcocndg','com.crowd.v4.updater']
  print('PASS',label,flush=True)
print('PASS four compiled channel profiles; original extension/host identity exact')
