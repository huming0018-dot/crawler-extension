#!/usr/bin/env python3
"""Build a universal native updater with a pinned public verification key."""
import argparse, base64, hashlib, json, pathlib, re, subprocess, tempfile
root=pathlib.Path(__file__).resolve().parent
p=argparse.ArgumentParser();p.add_argument('--output',type=pathlib.Path,required=True)
p.add_argument('--participant',action='store_true')
p.add_argument('--pro-participant-native-v2',action='store_true')
p.add_argument('--local-test-directory',type=pathlib.Path)
p.add_argument('--local-test-id')
p.add_argument('--local-test-public-key')
p.add_argument('--local-test-channel')
args=p.parse_args()
if args.pro_participant_native_v2 and not args.participant:p.error('Native-v2 requires --participant')
local=[args.local_test_directory,args.local_test_id,args.local_test_public_key,args.local_test_channel]
if args.participant and any(local):p.error('Participant profile cannot use local-test pins')
if any(local):
    if not all(local):p.error('All four local-test pins are required')
    if args.local_test_id!='ipccepibnkcfpikgebdaanimocdappfk':p.error('Unknown local test extension ID')
    if not args.local_test_directory.is_absolute() or args.local_test_directory.resolve()!=args.local_test_directory:p.error('Use the exact absolute installation path without symlinks')
    manifest=json.loads((args.local_test_directory/'manifest.json').read_text())
    if 'key' in manifest:p.error('Local test installation must remain keyless')
    try:valid=len(base64.b64decode(args.local_test_public_key,validate=True))==32
    except ValueError:valid=False
    if not valid:p.error('Use a 32-byte Ed25519 public key; never supply a private key')
    if not re.fullmatch(r'https://raw\.githubusercontent\.com/huming0018-dot/crowd-pages/[^?#]+/v4/releases/local-test-channel\.json',args.local_test_channel):p.error('Use the separate local-test HTTPS channel')
args.output.parent.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='crowd-host-build-') as d:
    sources=[str(root/'main.swift'),str(root/'ReleaseKey.swift')];flags=['-DPARTICIPANT'] if args.participant else []
    if args.pro_participant_native_v2:flags.append('-DPRO_PARTICIPANT_NATIVE_V2')
    if all(local):
        profile=pathlib.Path(d)/'LocalTestProfile.swift'
        values={'localTestExtensionID':args.local_test_id,'localTestDirectory':str(args.local_test_directory),'localTestChannelURL':args.local_test_channel,'releasePublicKey':args.local_test_public_key}
        profile.write_text(''.join('let '+k+' = '+json.dumps(v,ensure_ascii=False)+'\n' for k,v in values.items()))
        sources=[str(root/'main.swift'),str(profile)];flags=['-DLOCAL_TEST']
    if args.participant:
        pin=pathlib.Path(d)/'ParticipantManifest.swift'
        encoded=base64.b64encode((root/'participant-manifest-shape.json').read_bytes()).decode()
        pin.write_text('let participantManifestShapeBase64 = '+json.dumps(encoded)+'\n')
        sources.append(str(pin))
    bins=[]
    for arch in ('arm64','x86_64'):
        target=pathlib.Path(d)/arch
        subprocess.run(['swiftc','-O',*flags,'-target',arch+'-apple-macosx14.0','-module-cache-path',tempfile.gettempdir()+'/crowd-updater-module-cache',*sources,'-o',str(target)],check=True)
        bins.append(str(target))
    subprocess.run(['lipo','-create',*bins,'-output',str(args.output)],check=True)
    subprocess.run(['codesign','--force','--sign','-',str(args.output)],check=True,capture_output=True)
print(json.dumps({'bytes':args.output.stat().st_size,'sha256':hashlib.sha256(args.output.read_bytes()).hexdigest(),'architectures':['arm64','x86_64'],'minimum_macos':'14.0','signing':'ad-hoc; not notarized','profile':'local-test' if all(local) else 'pro-participant-native-v2' if args.pro_participant_native_v2 else 'participant' if args.participant else 'formal'}))
