#!/usr/bin/env python3
"""Build only the canonical v4 extension. No publish, enrollment or private files."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.parse
import zipfile

ROOT = Path(__file__).resolve().parent
COMMON = ('core.js','identity.js','api.js','agent.js','pool.js','work-tabs.js','content.js','config.js','join.js',
    'controller.css','native-runtime.js','updater.js','trace.js','structured.js','site-sdk.js',
    'passive.js','hybrid.js','main-observer.js')
PROFILES = {
    'participant': ('participant-background.js','participant-controller.html','participant-controller.js','participant-policy.js','node-monitor.js','session-health.js','participant-session.js','session-content.js'),
    'kol': ('background.js','controller.html','controller.js','local-test.js','kol.js','kol-content.js','kol-ui.js','kol-controller.js','session-health.js'),
    'experiment': ('experiment-background.js','experiment-controller.html','experiment-controller.js','local-test.js','recovery.js','risk.js'),
}



def build(output,local_test=False,profile='participant'):
    if local_test:
        if profile not in ('participant','experiment'):raise ValueError('Cannot change KOL package identity')
        profile='experiment'
    if profile not in PROFILES:raise ValueError('Unknown profile')
    fileset=['manifest.json','icons/icon128.png']+['src/'+name for name in COMMON+PROFILES[profile]]
    manifest=json.loads((ROOT/'manifest.json').read_text())
    if profile=='experiment':manifest.pop('key',None)
    version=manifest['version']
    if not re.fullmatch(r'4\.\d+\.\d+',version): raise ValueError('v4 version required')
    core=(ROOT/'src/core.js').read_text()
    if f"VERSION = '{version}'" not in core: raise ValueError('Core/manifest version mismatch')
    conf=json.loads((ROOT/'public-config.json').read_text())
    conf['portal']='https://app-lyart-eta-22.vercel.app'
    u=urllib.parse.urlsplit(conf['url'])
    if u.scheme!='https' or not (u.hostname or '').endswith('.supabase.co') or u.username or u.port or u.path or u.query or u.fragment:
        raise ValueError('Expected bare HTTPS Supabase origin')
    key=conf['key']
    if key.startswith('eyJ'):
        payload=key.split('.')[1]
        if json.loads(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4))).get('role')!='anon':raise ValueError('Public key only')
    elif not key.startswith('sb_publishable_'):raise ValueError('Public key only')
    if set(conf)!={'url','key','portal'}:raise ValueError('Unexpected public configuration')
    files={name:(ROOT/name).read_bytes() for name in fileset}
    for name in files:
        if name.endswith('.js'):subprocess.run(['node','--check',str(ROOT/name)],check=True,capture_output=True)
    background,controller,_=PROFILES[profile][:3]
    files['src/background.js']=files['src/'+background]
    files['src/controller.html']=files['src/'+controller]
    entry='src/background_v'+version.replace('.','_')+'.js'
    # A syntax/import failure can request a rollback without loading broken business code.
    host='com.crowd.v4.local_test_updater' if profile=='experiment' else 'com.crowd.v4.updater'
    files[entry]=("try { importScripts('background.js'); } catch (_) { chrome.runtime.sendNativeMessage('"+host+"', {action:'rollback',version:'"+version+"'}).then(r=>{if(r.status==='rolled_back')chrome.runtime.reload();}).catch(()=>{}); }\n").encode()
    manifest['background']={'service_worker':entry}
    manifest.pop('browser_specific_settings',None)
    hosts=['https://www.xiaohongshu.com/*','https://m.xiaohongshu.com/*']
    if profile=='kol':hosts+=['https://space.bilibili.com/*','https://www.bilibili.com/*']
    manifest['host_permissions']=hosts+[conf['url']+'/*',conf['portal']+'/*']
    manifest['content_scripts']=[{'matches':hosts[:2], 'js':['src/core.js','src/content.js']+
        (['src/kol.js','src/kol-content.js'] if profile=='kol' else []), 'run_at':'document_start'},
        {'matches':['https://www.xiaohongshu.com/explore/*','https://www.xiaohongshu.com/discovery/item/*','https://www.xiaohongshu.com/search_result/*'],
        'js':['src/main-observer.js'],'run_at':'document_start','world':'MAIN','all_frames':False}]
    if profile=='kol':manifest['content_scripts'].append({'matches':hosts[2:],'js':['src/core.js','src/kol.js','src/kol-content.js'],'run_at':'document_start'})
    files['src/main-observer.js']=b'\n'.join(files['src/'+name] for name in ['structured.js','site-sdk.js','passive.js','main-observer.js'])
    files['src/content.js']=b'\n'.join(files['src/'+name] for name in ['structured.js','site-sdk.js','passive.js','hybrid.js','content.js']+(['session-content.js'] if profile=='participant' else []))
    if profile=='kol':manifest['content_scripts']=json.loads((ROOT/'manifest.json').read_text())['content_scripts']
    manifest['externally_connectable']={'matches':[conf['portal']+'/*']}
    files['manifest.json']=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()
    files['src/config.js']=('globalThis.CROWD_CONFIG = '+json.dumps(conf)+';\n').encode()
    files['src/controller.html']=files['src/controller.html'].decode().replace('connect-src https://*.supabase.co;', 'connect-src '+conf['url']+' '+conf['portal']+';').encode()
    source_files={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in fileset+['build.py','public-config.json']}
    provenance={'repository':'huming0018-dot/crawler-extension','source_directory':'v4','version':version,
                'protocol':'crowd_v4','profile':profile,'release_channel':profile+'_candidate','worker':entry,'source_files':source_files,
                'files':{name:hashlib.sha256(data).hexdigest() for name,data in files.items()}}
    files['release.json']=(json.dumps(provenance,sort_keys=True,indent=2)+'\n').encode()
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,data in sorted(files.items()):
            item=zipfile.ZipInfo(name,(2026,10,14,0,0,0));item.compress_type=zipfile.ZIP_DEFLATED;item.external_attr=0o100644<<16
            archive.writestr(item,data)
    digest=hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.zip.sha256').write_text(digest+'  '+output.name+'\n')
    return {'version':version,'profile':profile,'bytes':output.stat().st_size,'sha256':digest,'worker':entry}

if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--output',type=Path,required=True)
    ap.add_argument('--local-test',action='store_true',help='Keyless package and separate local-test rollback host')
    ap.add_argument('--profile',choices=PROFILES,default='participant')
    ap.add_argument('--recovery-from',type=Path,help='Exact frozen participant 58 ZIP; builds an unpublished forward recovery 61 candidate')
    args=ap.parse_args()
    if args.recovery_from:
        if args.local_test or args.profile!='participant':ap.error('Recovery is only for the standard participant identity')
        from recovery_build import build_recovery
        result=build_recovery(args.output,args.recovery_from,ROOT)
    else:result=build(args.output,args.local_test,args.profile)
    print(json.dumps(result))
