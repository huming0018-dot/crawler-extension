"""Compile unchanged production diagnostic helpers; use only temporary data and local failures."""
import json,pathlib,subprocess,tempfile
root=pathlib.Path(__file__).resolve().parents[2]
source=(root/'v4/updater/main.swift').read_text()
prefix=source[:source.index('let executable=URL(')]
checks=r'''
func check(_ wanted: String, _ body: () throws -> Void) {
 do {try body();fatalError("expected failure "+wanted)} catch {precondition(safeErrorCode(error)==wanted,"wrong classification "+safeErrorCode(error))}
}
precondition(commandError("/usr/bin/curl",6,.exit)=="ota_network_dns")
precondition(commandError("/usr/bin/curl",28,.exit)=="ota_network_timeout")
precondition(commandError("/usr/bin/curl",60,.exit)=="ota_network_tls")
precondition(commandError("/usr/bin/curl",22,.exit)=="ota_network_http")
precondition(commandError("/usr/bin/curl",23,.exit)=="ota_io_failed")
precondition(commandError("/usr/bin/curl",99,.exit)=="ota_unknown_exit")
precondition(commandError("/usr/bin/curl",15,.uncaughtSignal)=="ota_process_terminated")
check("ota_network_connect") {_=try run("/usr/bin/curl",["--noproxy","*","--silent","--show-error","--connect-timeout","1","http://127.0.0.1:1/?token=PRIVATE_SECRET"])}
check("ota_io_missing") {_=try run("/nonexistent/PRIVATE_SECRET",[])}
let dir=URL(fileURLWithPath:CommandLine.arguments[1])
let invalid=dir.appendingPathComponent("private.zip");try Data("not a zip PRIVATE_SECRET".utf8).write(to:invalid)
check("ota_package_tool_failed") {_=try run("/usr/bin/unzip",["-Z","-1",invalid.path])}
check("ota_unknown_exit") {_=try run("/bin/sh",["-c","echo PRIVATE_SECRET >&2; exit 71"])}
check("ota_process_terminated") {_=try run("/bin/sh",["-c","kill -TERM $$"])}
check("ota_io_missing") {_=try Data(contentsOf:dir.appendingPathComponent("PRIVATE_SECRET_missing"))}
precondition(safeErrorCode(NSError(domain:NSCocoaErrorDomain,code:NSFileWriteOutOfSpaceError,userInfo:[NSLocalizedDescriptionKey:"PRIVATE_SECRET"]))=="ota_io_space")
precondition(safeErrorCode(NSError(domain:NSPOSIXErrorDomain,code:Int(EACCES),userInfo:[NSLocalizedDescriptionKey:"PRIVATE_SECRET"]))=="ota_io_permission")
precondition(safeErrorCode(NSError(domain:"unknown PRIVATE_SECRET",code:99,userInfo:[:]))=="operation_failed")
print("PASS native diagnostics: real curl connect, missing executable/file, corrupt zip, child exit/signal; fixed TLS/DNS/timeout/HTTP/IO mapping; unknown kept; no stderr/argv/error text exposed")
'''
with tempfile.TemporaryDirectory(prefix='crowd-safe-diagnostics-') as temp:
 d=pathlib.Path(temp);(d/'main.swift').write_text(prefix+checks)
 subprocess.run(['swiftc','-O','-module-cache-path','/private/tmp/crowd-updater-module-cache',str(d/'main.swift'),str(root/'v4/updater/ReleaseKey.swift'),'-o',str(d/'test')],check=True,capture_output=True)
 p=subprocess.run([str(d/'test'),str(d)],capture_output=True,text=True,check=True)
 assert 'PRIVATE_SECRET' not in p.stdout+p.stderr
 print(p.stdout.strip())
