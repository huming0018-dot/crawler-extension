#!/usr/bin/env python3
"""Build a universal native updater with a pinned public verification key."""
import argparse, hashlib, json, pathlib, subprocess, tempfile
root=pathlib.Path(__file__).resolve().parent
p=argparse.ArgumentParser();p.add_argument('--output',type=pathlib.Path,required=True);args=p.parse_args()
args.output.parent.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='crowd-host-build-') as d:
    bins=[]
    for arch in ('arm64','x86_64'):
        target=pathlib.Path(d)/arch
        subprocess.run(['swiftc','-O','-target',arch+'-apple-macosx14.0','-module-cache-path',tempfile.gettempdir()+'/crowd-updater-module-cache',str(root/'main.swift'),str(root/'ReleaseKey.swift'),'-o',str(target)],check=True)
        bins.append(str(target))
    subprocess.run(['lipo','-create',*bins,'-output',str(args.output)],check=True)
    subprocess.run(['codesign','--force','--sign','-',str(args.output)],check=True,capture_output=True)
print(json.dumps({'bytes':args.output.stat().st_size,'sha256':hashlib.sha256(args.output.read_bytes()).hexdigest(),'architectures':['arm64','x86_64'],'minimum_macos':'14.0','signing':'ad-hoc; not notarized'}))
