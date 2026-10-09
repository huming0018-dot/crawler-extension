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
FILES = ['manifest.json', 'icons/icon128.png'] + ['src/'+name for name in (
    'core.js','api.js','agent.js','background.js','content.js','config.js','join.js',
    'controller.js','controller.html','controller.css','native-runtime.js','updater.js','trace.js','kol.js','kol-content.js','kol-ui.js','kol-controller.js')]


def build(output):
    manifest=json.loads((ROOT/'manifest.json').read_text())
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
    files={name:(ROOT/name).read_bytes() for name in FILES}
    for name in files:
        if name.endswith('.js'):subprocess.run(['node','--check',str(ROOT/name)],check=True,capture_output=True)
    entry='src/background_v'+version.replace('.','_')+'.js'
    # A syntax/import failure can request a rollback without loading broken business code.
    files[entry]=("try { importScripts('background.js'); } catch (_) { chrome.runtime.sendNativeMessage('com.crowd.v4.updater', {action:'rollback',version:'"+version+"'}).then(r=>{if(r.status==='rolled_back')chrome.runtime.reload();}).catch(()=>{}); }\n").encode()
    manifest['background']={'service_worker':entry}
    manifest.pop('browser_specific_settings',None)
    manifest['host_permissions']=['https://www.xiaohongshu.com/*','https://m.xiaohongshu.com/*','https://space.bilibili.com/*','https://www.bilibili.com/*',conf['url']+'/*',conf['portal']+'/*']
    manifest['externally_connectable']={'matches':[conf['portal']+'/*']}
    files['manifest.json']=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()
    files['src/config.js']=('globalThis.CROWD_CONFIG = '+json.dumps(conf)+';\n').encode()
    files['src/controller.html']=files['src/controller.html'].decode().replace('connect-src https://*.supabase.co;', 'connect-src '+conf['url']+' '+conf['portal']+';').encode()
    source_files={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in FILES+['build.py','public-config.json']}
    provenance={'repository':'huming0018-dot/crawler-extension','source_directory':'v4','version':version,
                'protocol':'crowd_v4','release_channel':'private_candidate','worker':entry,'source_files':source_files,
                'files':{name:hashlib.sha256(data).hexdigest() for name,data in files.items()}}
    files['release.json']=(json.dumps(provenance,sort_keys=True,indent=2)+'\n').encode()
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,data in sorted(files.items()):
            item=zipfile.ZipInfo(name,(2026,10,8,0,0,0));item.compress_type=zipfile.ZIP_DEFLATED;item.external_attr=0o100644<<16
            archive.writestr(item,data)
    digest=hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.zip.sha256').write_text(digest+'  '+output.name+'\n')
    return {'version':version,'bytes':output.stat().st_size,'sha256':digest,'worker':entry}

if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--output',type=Path,required=True)
    print(json.dumps(build(ap.parse_args().output)))
