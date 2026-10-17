"""Rebuild a forward recovery candidate from one immutable reviewed release."""
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

BASELINE_SHA = 'a1838bf052fd569f3b04f2c9a09a59134fbefbc28779760d22e536d9e80d4f5a'
VERSION = '4.2.61'


def build_recovery(output, baseline, root):
    root = Path(root)
    baseline = Path(baseline)
    if hashlib.sha256(baseline.read_bytes()).hexdigest() != BASELINE_SHA:
        raise ValueError('Recovery requires the exact reviewed participant 58 ZIP')
    with zipfile.ZipFile(baseline) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Duplicate baseline entries')
        files = {name: archive.read(name) for name in names}
    old = json.loads(files.pop('release.json'))
    if old['version'] != '4.2.58' or old['protocol'] != 'crowd_v4':
        raise ValueError('Wrong recovery baseline')
    if set(files) != set(old['files']) or any(hashlib.sha256(data).hexdigest() != old['files'][name] for name, data in files.items()):
        raise ValueError('Baseline release file mismatch')
    manifest = json.loads(files['manifest.json'])
    shape = {key: value for key, value in manifest.items() if key not in ('version', 'background')}
    shape['content_scripts'] = shape['content_scripts'][:1]
    if shape != json.loads((root / 'updater/participant-manifest-shape.json').read_text()):
        raise ValueError('Baseline participant shape mismatch')
    core = files['src/core.js'].decode()
    if core.count("VERSION = '4.2.58'") != 1:
        raise ValueError('Recovery core anchor mismatch')
    files['src/core.js'] = core.replace("VERSION = '4.2.58'", "VERSION = '" + VERSION + "'").encode()
    old_worker = old['worker']
    worker = 'src/background_v' + VERSION.replace('.', '_') + '.js'
    files[worker] = files.pop(old_worker).decode().replace("version:'4.2.58'", "version:'" + VERSION + "'").encode()
    manifest['version'] = VERSION
    manifest['background'] = {'service_worker': worker}
    files['manifest.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    background = files['src/background.js'].decode()
    anchor = "'agent.js', 'pool.js'"
    if background.count(anchor) != 1:
        raise ValueError('Recovery import anchor mismatch')
    files['src/background.js'] = background.replace(anchor, "'agent.js', 'recovery-guard.js', 'pool.js'").encode()
    files['src/recovery-guard.js'] = (root / 'src/recovery-guard.js').read_bytes()
    html = files['src/controller.html'].decode()
    marker = '<body><main><h1>众包公开笔记采集</h1>'
    if html.count(marker) != 1:
        raise ValueError('Recovery notice anchor mismatch')
    notice = '<p role="status">恢复版 4.2.61：采用已验证的 4.2.58 采集行为，保留原账号、任务和待回传数据。60 的新增逐步骤云监控暂时停用，历史日志保留；原诊断、回执、评分及 OTA 继续可用。若 60 留有未确认的 SDK 或批回传操作，本版会暂停等待核对，不自动重发。</p>'
    files['src/controller.html'] = html.replace(marker, marker + '\n' + notice).encode()
    for name, data in files.items():
        if name.endswith('.js'):
            subprocess.run(['node', '--check'], input=data, check=True, capture_output=True)
    recovery_sources = ['build.py', 'recovery_build.py', 'src/recovery-guard.js', 'updater/participant-manifest-shape.json']
    changed = sorted(name for name, data in files.items() if hashlib.sha256(data).hexdigest() != old['files'].get(name))
    release = {'repository': old['repository'], 'source_directory': 'v4', 'version': VERSION, 'protocol': 'crowd_v4',
               'profile': 'participant_recovery', 'release_channel': 'participant_recovery_candidate', 'worker': worker,
               'source_files': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in recovery_sources},
               'baseline_source_files': old['source_files'],
               'recovery': {'baseline_version': '4.2.58', 'baseline_archive_sha256': BASELINE_SHA,
                            'purpose': 'forward recovery after acknowledged 60', 'unresolved_v60_operations': 'hold without storage mutation',
                            'node_monitoring': 'degraded; existing node storage untouched', 'changed_files': changed, 'removed_files': [old_worker]},
               'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    files['release.json'] = (json.dumps(release, sort_keys=True, indent=2) + '\n').encode()
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            item = zipfile.ZipInfo(name, (2026, 10, 14, 0, 0, 0))
            item.compress_type = zipfile.ZIP_DEFLATED
            item.external_attr = 0o100644 << 16
            archive.writestr(item, data)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.zip.sha256').write_text(digest + '  ' + output.name + '\n')
    return {'version': VERSION, 'profile': 'participant_recovery', 'bytes': output.stat().st_size, 'sha256': digest, 'worker': worker, 'baseline_sha256': BASELINE_SHA}
