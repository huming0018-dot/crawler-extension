import Foundation
import CryptoKit
import Darwin
import CoreFoundation

// The host accepts fixed verbs only. Paths, keys and endpoints never come from a browser message.
let fm = FileManager.default
#if LOCAL_TEST
let extensionID = localTestExtensionID
let hostName = "com.crowd.v4.local_test_updater"
let channelURL = localTestChannelURL
#else
let extensionID = "licijehcpohikchlnkbpjdjdfkcocndg"
let hostName = "com.crowd.v4.updater"
#if PARTICIPANT
let channelURL = "https://raw.githubusercontent.com/huming0018-dot/crowd-pages/codex/v4.0.6-handoff/v4/releases/channel-participants-pro.json"
#else
let channelURL = "https://raw.githubusercontent.com/huming0018-dot/crowd-pages/codex/v4.0.6-handoff/v4/releases/channel-kol.json"
#endif
#endif
let origin = "chrome-extension://\(extensionID)/"
struct Failure: Error { let code: String; init(_ code: String) { self.code = code } }
func require(_ value: Bool, _ code: String) throws { if !value { throw Failure(code) } }
func json(_ data: Data) throws -> [String: Any] { guard let v = try JSONSerialization.jsonObject(with:data) as? [String:Any] else { throw Failure("invalid_data") }; return v }
func read(_ url: URL) throws -> [String:Any] { try json(Data(contentsOf:url)) }
func write(_ value: [String:Any], _ url: URL) throws { try JSONSerialization.data(withJSONObject:value, options:[.sortedKeys]).write(to:url, options:.atomic); try fm.setAttributes([.posixPermissions:0o600], ofItemAtPath:url.path) }
func digest(_ data: Data) -> String { SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined() }
// Normalize only the reviewed optional local-test MAIN registration. Every other
// field remains subject to the original complete manifest and capability checks.
func manifestCapabilityShape(_ manifest: [String:Any]) throws -> [String:Any] {
 var shape=manifest
 for field in ["version","background"] {shape[field]=nil}
 #if LOCAL_TEST || PARTICIPANT
 let isolated:[String:Any]=["matches":["https://www.xiaohongshu.com/*","https://m.xiaohongshu.com/*"],"js":["src/core.js","src/content.js"],"run_at":"document_start"]
 let main:[String:Any]=["matches":["https://www.xiaohongshu.com/explore/*","https://www.xiaohongshu.com/discovery/item/*","https://www.xiaohongshu.com/search_result/*"],"js":["src/main-observer.js"],"run_at":"document_start","world":"MAIN","all_frames":false]
 guard let scripts=manifest["content_scripts"] as? [[String:Any]],scripts.count==1 || scripts.count==2 else {throw Failure("permission_change")}
 let expected=scripts.count==1 ? [isolated] : [isolated,main]
 let actualBytes=try JSONSerialization.data(withJSONObject:scripts,options:[.sortedKeys])
 let expectedBytes=try JSONSerialization.data(withJSONObject:expected,options:[.sortedKeys])
 try require(actualBytes==expectedBytes,"permission_change")
 shape["content_scripts"]=[isolated]
 #endif
 return shape
}
func version(_ text: String) throws -> [Int] { let a=text.split(separator:"."); try require(a.count==3 && a[0]=="4" && a.allSatisfy{!$0.isEmpty && $0.allSatisfy(\.isNumber)},"invalid_version"); let n=a.compactMap{Int($0)}; try require(n.count==3 && n.allSatisfy{$0<65536} && n.map(String.init).joined(separator:".")==text,"invalid_version"); return n }
func greater(_ a: String, _ b: String) throws -> Bool { try version(a).lexicographicallyPrecedes(version(b)) == false && a != b }
// Only fixed codes cross the native boundary. Never serialize NSError userInfo,
// subprocess stderr, argv or paths: those can contain credentials and user data.
func safeErrorCode(_ error: Error) -> String {
 if let failure=error as? Failure {return failure.code}
 let e=error as NSError
 if e.domain==NSCocoaErrorDomain {
  if [NSFileReadNoPermissionError,NSFileWriteNoPermissionError].contains(e.code){return "ota_io_permission"}
  if [NSFileNoSuchFileError,NSFileReadNoSuchFileError].contains(e.code){return "ota_io_missing"}
  if e.code==NSFileWriteOutOfSpaceError{return "ota_io_space"}
  if e.code>=0 && e.code<=1023{return "ota_io_failed"}
 }
 if e.domain==NSPOSIXErrorDomain {
  if [Int(EACCES),Int(EPERM)].contains(e.code){return "ota_io_permission"}
  if e.code==Int(ENOENT){return "ota_io_missing"}
  if e.code==Int(ENOSPC){return "ota_io_space"}
  if [Int(EIO),Int(EROFS),Int(EMFILE),Int(ENFILE)].contains(e.code){return "ota_io_failed"}
 }
 return "operation_failed"
}
func commandError(_ executable: String, _ status: Int32, _ reason: Process.TerminationReason) -> String {
 if reason != .exit{return "ota_process_terminated"}
 if executable=="/usr/bin/curl" {
  switch status {
  case 5,6:return "ota_network_dns"
  case 7:return "ota_network_connect"
  case 28:return "ota_network_timeout"
  case 35,51,58,59,60,77,80,82,83,90,91:return "ota_network_tls"
  case 22:return "ota_network_http"
  case 18,52,55,56,92,95,96:return "ota_network_transfer"
  case 23,26:return "ota_io_failed"
  case 63:return "too_large"
  default:return "ota_unknown_exit"
  }
 }
 if executable=="/usr/bin/unzip" || executable=="/usr/bin/ditto" {return "ota_package_tool_failed"}
 if executable=="/bin/launchctl" {return "ota_service_failed"}
 return "ota_unknown_exit"
}
func run(_ executable: String, _ args: [String]) throws -> Data {
 #if TESTING
 if executable=="/bin/launchctl" && ProcessInfo.processInfo.environment["CROWD_TEST_INSTALL_HOME"] != nil {return Data()}
 #endif
 let process=Process(), pipe=Pipe(); process.executableURL=URL(fileURLWithPath:executable); process.arguments=args; process.standardOutput=pipe; process.standardError=FileHandle.nullDevice
 do {try process.run()} catch {let code=safeErrorCode(error);throw Failure(code=="operation_failed" ? "ota_process_launch_failed":code)}; let output=pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit(); try require(process.terminationStatus==0,commandError(executable,process.terminationStatus,process.terminationReason)); return output
}
func safePath(_ url: URL) throws {
 try require(url.path==url.resolvingSymlinksInPath().path,"unsafe_path")
 let a=try fm.attributesOfItem(atPath:url.path); try require(a[.ownerAccountID] as? UInt32 == getuid(),"wrong_owner")
}
func fetch(_ text: String, _ output: URL, _ max: Int) throws {
 #if TESTING
 if text.hasPrefix("file://") { let data=try Data(contentsOf:URL(string:text)!); try require(data.count<=max,"too_large"); try data.write(to:output); return }
 #endif
 guard let u=URL(string:text) else {throw Failure("invalid_url")}
 try require(u.scheme=="https" && u.host=="raw.githubusercontent.com" && u.user==nil && u.password==nil && u.port==nil && u.query==nil && u.fragment==nil,"invalid_url")
 _=try run("/usr/bin/curl",["--fail","--silent","--show-error","--proto","=https","--connect-timeout","10","--max-time","45","--max-filesize",String(max),text,"--output",output.path])
 try require((try Data(contentsOf:output)).count<=max,"too_large")
}
let executable=URL(fileURLWithPath:CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath()
let root=executable.deletingLastPathComponent()
let configURL=root.appendingPathComponent("config.json"), stateURL=root.appendingPathComponent("state.json")
func configuredDirectory() throws -> URL {
 try safePath(root); try safePath(configURL)
 let c=try read(configURL); guard let p=c["directory"] as? String else {throw Failure("not_configured")}
 let dir=URL(fileURLWithPath:p).standardizedFileURL; try require(p.hasPrefix("/") && dir.path != root.path && !root.path.hasPrefix(dir.path+"/"),"unsafe_path"); try safePath(dir)
 let manifest=try read(dir.appendingPathComponent("manifest.json")); let v=manifest["version"] as? String ?? ""; _=try version(v)
 #if LOCAL_TEST
 try require(dir.path==URL(fileURLWithPath:localTestDirectory).standardizedFileURL.path && c["extension_id"] as? String==extensionID && manifest["key"]==nil,"wrong_extension")
 #else
 guard let encoded=manifest["key"] as? String,let key=Data(base64Encoded:encoded),let configuredKey=c["extension_key"] as? String else {throw Failure("wrong_extension")}
 let id=SHA256.hash(data:key).prefix(16).flatMap{[Int($0>>4),Int($0&15)]}.map{String(UnicodeScalar(97+$0)!)}.joined()
 try require(encoded==configuredKey && id==extensionID,"wrong_extension")
 #endif
 return dir
}
func state() throws -> [String:Any] { fm.fileExists(atPath:stateURL.path) ? try read(stateURL) : [:] }
func paths(_ dir: URL) -> (URL, URL) {
 #if LOCAL_TEST
 let prefix=".crowd-v4-local-test"
 #else
 let prefix=".crowd-v4"
 #endif
 return (dir.deletingLastPathComponent().appendingPathComponent(prefix+"-stage"),dir.deletingLastPathComponent().appendingPathComponent(prefix+"-backup"))
}
func rollback(_ dir: URL, _ s: inout [String:Any]) throws -> Bool {
 guard s["pending"] as? String != nil else {return false}
 let (stage, backup)=paths(dir)
 if fm.fileExists(atPath:backup.path) {
  try safePath(backup)
  // Before swap backup is the new tree; after swap it is the old tree.
  let currentVersion=try read(dir.appendingPathComponent("manifest.json"))["version"] as? String
  if currentVersion==s["pending"] as? String {
   try require(renameatx_np(AT_FDCWD,dir.path,AT_FDCWD,backup.path,UInt32(RENAME_SWAP))==0,"swap_failed")
  }
  try fm.removeItem(at:backup)
 }
 if fm.fileExists(atPath:stage.path){try safePath(stage);try fm.removeItem(at:stage)}
 s["failed_sequence"]=s["pending_sequence"];s["pending"]=nil;s["pending_sequence"]=nil;s["pending_digest"]=nil;s["applied_at"]=nil;s["awaiting_launch"]=nil;s["status"]="rolled_back"
 try write(s,stateURL);return true
}
func handle(_ message: [String:Any], prepareOnly: Bool = false, unattended: Bool = false) throws -> [String:Any] {
 try require(Set(message.keys).isSubset(of:["action","version","release_sha256","enabled"]),"invalid_request")
 let dir=try configuredDirectory(), (stage,backup)=paths(dir); var s=try state()
 let loaded=message["version"] as? String ?? ""; _=try version(loaded)
 let local=try read(dir.appendingPathComponent("manifest.json"))["version"] as? String ?? ""
 guard let action=message["action"] as? String else {throw Failure("invalid_request")}
 if action=="settings" {
  try require(Set(message.keys)==Set(["action","version","enabled"]) && message["enabled"] is Bool,"invalid_request")
  var config=try read(configURL);config["scheduled_enabled"]=message["enabled"];try write(config,configURL)
  return ["status":"configured","protocol":2]
 }
 if action=="rollback" {try proBusy();try require(s["pending"] as? String == loaded,"no_pending_update");let restored=try rollback(dir,&s);return ["status":restored ? "rolled_back":"idle"]}
 if action=="ack" {
  if s["pending"] != nil && local != s["pending"] as? String {_=try rollback(dir,&s)}
  if let pending=s["pending"] as? String {
   if s["awaiting_launch"] as? Bool == true {
    s["awaiting_launch"]=nil;s["applied_at"]=Date().timeIntervalSince1970;try write(s,stateURL)
    if loaded != pending {return ["status":"pending_reload","version":pending,"protocol":2]}
   }
   try require(loaded==pending && local==pending && message["release_sha256"] as? String==s["pending_digest"] as? String,"handshake_mismatch")
   try require(digest(Data(contentsOf:dir.appendingPathComponent("release.json")))==s["pending_digest"] as? String,"handshake_mismatch")
   #if LOCAL_TEST
   s["loaded_digest"]=s["pending_digest"]
   #endif
   s["sequence"]=s["pending_sequence"];s["loaded_version"]=loaded;s["status"]="applied";s["pending"]=nil;s["pending_sequence"]=nil;s["pending_digest"]=nil;s["applied_at"]=nil;s["awaiting_launch"]=nil
   try write(s,stateURL);if fm.fileExists(atPath:backup.path){try fm.removeItem(at:backup)}
   let cache=root.appendingPathComponent("cache");if fm.fileExists(atPath:cache.path){try safePath(cache);try fm.removeItem(at:cache)}
  }
  #if LOCAL_TEST
  let loadedDigest=digest(try Data(contentsOf:dir.appendingPathComponent("release.json")))
  try require(loaded==local && message["release_sha256"] as? String==loadedDigest,"handshake_mismatch")
  if s["status"] as? String=="applied" {
   try require(loaded==local && message["release_sha256"] as? String==s["loaded_digest"] as? String && digest(Data(contentsOf:dir.appendingPathComponent("release.json")))==s["loaded_digest"] as? String,"handshake_mismatch")
  }
  return ["status":s["status"] as? String ?? "ready","version":local,"protocol":2,"profile":"local-test","release_sha256":loadedDigest]
  #else
  return ["status":s["status"] as? String ?? "ready","version":local,"protocol":2]
  #endif
 }
 if action=="status" {
  var result:[String:Any] = ["status":s["pending"] == nil ? (s["status"] as? String ?? "ready") : "pending_reload","version":local,"protocol":2,"diagnostics_schema":1]
  if let at=s["last_poll_at"] as? Double,at.isFinite,at>0 {result["last_poll_at"]=at}
  if let value=s["poll_status"] as? String,["current","downloaded","pending_reload","error"].contains(value){result["poll_status"]=value}
  if let value=s["poll_error"] as? String {result["poll_error"]=["invalid_signature","hash_mismatch","permission_change","replayed_release","recovery_required","busy","operation_failed","invalid_manifest","invalid_url","wrong_extension","ota_network_dns","ota_network_connect","ota_network_timeout","ota_network_tls","ota_network_http","ota_network_transfer","ota_io_permission","ota_io_missing","ota_io_space","ota_io_failed","ota_package_tool_failed","ota_service_failed","ota_process_terminated","ota_process_launch_failed","ota_unknown_exit","too_large","unsafe_archive","invalid_package","lock_failed","swap_failed","process_check_failed"].contains(value) ? value : "operation_failed"}
  return result
 }
 try require(action=="apply","invalid_request");try proBusy();try require(local==loaded,"version_mismatch")
 if s["pending"] != nil {return ["status":"pending_reload","version":local]}
 let temp=root.appendingPathComponent("download-"+UUID().uuidString);try fm.createDirectory(at:temp,withIntermediateDirectories:false);defer{try? fm.removeItem(at:temp)}
 var channel=channelURL
 #if TESTING
 channel=(try read(configURL))["test_channel"] as? String ?? channel
 #endif
 let cache=root.appendingPathComponent("cache"), cachedEnvelope=root.appendingPathComponent("cache/channel.json"), cachedArchive=root.appendingPathComponent("cache/extension.zip")
 let useCache = !unattended && fm.fileExists(atPath:cachedEnvelope.path) && fm.fileExists(atPath:cachedArchive.path)
 let envelopeURL=temp.appendingPathComponent("channel.json")
 if useCache {try safePath(cachedEnvelope);try fm.copyItem(at:cachedEnvelope,to:envelopeURL)} else {try fetch(channel,envelopeURL,16384)}
 let envelope=try read(envelopeURL)
 guard let encoded=envelope["payload"] as? String,let payload=Data(base64Encoded:encoded),let sigText=envelope["signature"] as? String,let signature=Data(base64Encoded:sigText),let keyData=Data(base64Encoded:releasePublicKey) else {throw Failure("invalid_signature")}
 let key=try Curve25519.Signing.PublicKey(rawRepresentation:keyData);try require(key.isValidSignature(signature,for:payload),"invalid_signature")
 let release=try json(payload)
 try require(Set(release.keys)==Set(["schema","protocol","sequence","version","url","sha256","release_sha256","bytes"]),"invalid_manifest")
 guard release["schema"] as? Int==1,release["protocol"] as? String=="crowd_v4",let next=release["version"] as? String,let sequence=release["sequence"] as? Int,let url=release["url"] as? String,let hash=release["sha256"] as? String,let releaseHash=release["release_sha256"] as? String,let bytes=release["bytes"] as? Int else {throw Failure("invalid_manifest")}
 try require(hash.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil && releaseHash.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil && bytes>0 && bytes<=2097152,"invalid_manifest")
 guard try greater(next,local) else {return ["status":"current","version":local]}
 try require(sequence > max(s["sequence"] as? Int ?? 0,s["failed_sequence"] as? Int ?? 0),"replayed_release")
 #if !TESTING
 try require(url.range(of:"^https://raw\\.githubusercontent\\.com/huming0018-dot/crowd-pages/[a-f0-9]{40}/v4/releases/[a-z0-9.-]+\\.zip$",options:.regularExpression) != nil,"invalid_url")
 #endif
 let archive=temp.appendingPathComponent("extension.zip");if useCache {try safePath(cachedArchive);try fm.copyItem(at:cachedArchive,to:archive)} else {try fetch(url,archive,2097152)};let data=try Data(contentsOf:archive);try require(data.count==bytes && digest(data)==hash,"hash_mismatch")
 let listing=try run("/usr/bin/unzip",["-Z","-1",archive.path]);guard let namesText=String(data:listing,encoding:.utf8) else {throw Failure("unsafe_archive")}
 let names=namesText.split(separator:"\n").map(String.init)
 try require(names.count<100 && Set(names).count==names.count && names.allSatisfy{!$0.isEmpty && !$0.hasPrefix("/") && !$0.contains("\\") && !$0.split(separator:"/",omittingEmptySubsequences:false).contains(where:{$0==".." || $0=="." || $0.isEmpty}) && $0.unicodeScalars.allSatisfy{$0.value>=32 && $0.value<127}},"unsafe_archive")
 let detail=String(data:try run("/usr/bin/unzip",["-Z","-l",archive.path]),encoding:.utf8) ?? ""
 try require(!detail.split(separator:"\n").contains(where:{$0.hasPrefix("l")}),"unsafe_archive")
 // Signed packages are small; validate expansion sizes before extraction.
 let fileRows=detail.split(separator:"\n").filter{$0.hasPrefix("-")}; var expanded=0
 for row in fileRows {let fields=row.split(whereSeparator:\.isWhitespace);try require(fields.count>=9,"unsafe_archive");guard let size=Int(fields[3]),size>=0 else {throw Failure("unsafe_archive")};expanded+=size}
 try require(fileRows.count==names.count && expanded<=2097152,"unsafe_archive")
 try require(!fm.fileExists(atPath:stage.path) && !fm.fileExists(atPath:backup.path),"recovery_required")
 s["staging_at"]=Date().timeIntervalSince1970;try write(s,stateURL)
 try fm.createDirectory(at:stage,withIntermediateDirectories:false);defer{try? fm.removeItem(at:stage);if var latest=try? state(){latest["staging_at"]=nil;try? write(latest,stateURL)}}
 _=try run("/usr/bin/ditto",["-x","-k",archive.path,stage.path])
 let provenanceData=try Data(contentsOf:stage.appendingPathComponent("release.json"));try require(digest(provenanceData)==releaseHash,"hash_mismatch")
 let provenance=try json(provenanceData);guard let files=provenance["files"] as? [String:String] else {throw Failure("invalid_package")}
 try require(Set(names)==Set(files.keys).union(["release.json"]) && provenance["protocol"] as? String=="crowd_v4" && provenance["repository"] as? String=="huming0018-dot/crawler-extension" && provenance["version"] as? String==next,"invalid_package")
 for (name,hash) in files {let file=stage.appendingPathComponent(name);try safePath(file);try require(digest(Data(contentsOf:file))==hash,"hash_mismatch")}
 let oldManifest=try read(dir.appendingPathComponent("manifest.json")),newManifest=try read(stage.appendingPathComponent("manifest.json"))
 try require(newManifest["version"] as? String==next && newManifest["key"] as? String==oldManifest["key"] as? String,"wrong_extension")
 let worker="src/background_v"+next.replacingOccurrences(of:".",with:"_")+".js"
 try require((newManifest["background"] as? [String:String])==["service_worker":worker],"invalid_package")
 let rescue="try { importScripts('background.js'); } catch (_) { chrome.runtime.sendNativeMessage('"+hostName+"', {action:'rollback',version:'"+next+"'}).then(r=>{if(r.status==='rolled_back')chrome.runtime.reload();}).catch(()=>{}); }\n"
 try require(try String(contentsOf:stage.appendingPathComponent(worker),encoding:.utf8)==rescue,"invalid_package")
 let oldShape=try manifestCapabilityShape(oldManifest),newShape=try manifestCapabilityShape(newManifest)
 try require(try JSONSerialization.data(withJSONObject:oldShape,options:[.sortedKeys])==JSONSerialization.data(withJSONObject:newShape,options:[.sortedKeys]),"permission_change")
 // New capabilities require a reviewed bootstrap, never silent permission expansion.
 for field in ["permissions","host_permissions","externally_connectable","content_scripts"] {
  let a=try JSONSerialization.data(withJSONObject:oldShape[field] ?? [],options:[.sortedKeys,.fragmentsAllowed]);let b=try JSONSerialization.data(withJSONObject:newShape[field] ?? [],options:[.sortedKeys,.fragmentsAllowed]);try require(a==b,"permission_change")
 }
 // Keep a verified package while a browser owns the live directory. The
 // browser revalidates this signed cache before applying it, including offline.
 if unattended {
  if fm.fileExists(atPath:cache.path){try safePath(cache)}else{try fm.createDirectory(at:cache,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])}
  try data.write(to:cachedArchive,options:.atomic);try Data(contentsOf:envelopeURL).write(to:cachedEnvelope,options:.atomic)
 }
 if try prepareOnly || (unattended && browserRunning()) {return ["status":"downloaded","version":next]}
 // Persist intent before swap. Recovery handles a process crash at each boundary.
 s["pending"]=next;s["pending_sequence"]=sequence;s["pending_digest"]=releaseHash;s["applied_at"]=Date().timeIntervalSince1970;s["status"]="applying";s["awaiting_launch"]=unattended;try write(s,stateURL)
 try fm.moveItem(at:stage,to:backup)
 try require(renameatx_np(AT_FDCWD,dir.path,AT_FDCWD,backup.path,UInt32(RENAME_SWAP))==0,"swap_failed")
 s["status"]="pending_reload";try write(s,stateURL)
 return ["status":"pending_reload","version":next]
}
func browserRunning() throws -> Bool {
 #if TESTING
 if let value=(try read(configURL))["test_browser_running"] as? Bool {return value}
 #endif
 let process=Process();process.executableURL=URL(fileURLWithPath:"/usr/bin/pgrep")
 process.arguments=["-u",String(getuid()),"-f","Google Chrome|Microsoft Edge"]
 process.standardOutput=FileHandle.nullDevice;process.standardError=FileHandle.nullDevice
 try process.run();process.waitUntilExit();try require([0,1].contains(process.terminationStatus),"process_check_failed")
 return process.terminationStatus==0
}
func scheduledPoll() throws {
 let dir=try configuredDirectory();guard (try read(configURL))["scheduled_enabled"] as? Bool == true else {return}
 let local=try read(dir.appendingPathComponent("manifest.json"))["version"] as? String ?? ""
 let supportsOffline = !(try greater("4.2.3",local))
 let result=try handle(["action":"apply","version":local],prepareOnly: try !supportsOffline || browserRunning(),unattended:true)
 var current=try state();current["last_poll_at"]=Date().timeIntervalSince1970;current["poll_status"]=result["status"];current["poll_error"]=nil;try write(current,stateURL)
}
func checkParticipantInstallation(_ directory: String) throws {
 #if PARTICIPANT
 let dir=URL(fileURLWithPath:directory).standardizedFileURL;try safePath(dir)
 let manifest=try read(dir.appendingPathComponent("manifest.json"))
 let installedVersion=manifest["version"] as? String ?? "";_=try version(installedVersion)
 let expectedWorker="src/background_v"+installedVersion.replacingOccurrences(of:".",with:"_")+".js"
 try require((manifest["background"] as? [String:String])==["service_worker":expectedWorker],"permission_change")
 guard let expectedData=Data(base64Encoded:participantManifestShapeBase64) else {throw Failure("invalid_package")}
 let expected=try json(expectedData),actual=try manifestCapabilityShape(manifest)
 try require(try JSONSerialization.data(withJSONObject:actual,options:[.sortedKeys])==JSONSerialization.data(withJSONObject:expected,options:[.sortedKeys]),"permission_change")
 #else
 throw Failure("unsupported_profile")
 #endif
}
func installationHome() -> URL {
 #if TESTING
 if let value=ProcessInfo.processInfo.environment["CROWD_TEST_INSTALL_HOME"] {return URL(fileURLWithPath:value)}
 #endif
 return fm.homeDirectoryForCurrentUser
}
func reconnect(_ browser: String) throws {
 #if PARTICIPANT
 let support=installationHome().appendingPathComponent("Library/Application Support/CrowdV4Updater")
 let configuration=support.appendingPathComponent("config.json");try safePath(support);try safePath(configuration)
 guard let directory=try read(configuration)["directory"] as? String else {throw Failure("not_configured")}
 try install(directory,browser)
 #else
 throw Failure("unsupported_profile")
 #endif
}
func install(_ directory: String, _ browser: String) throws {
 #if PARTICIPANT
 try checkParticipantInstallation(directory)
 #endif
 try require(["Google Chrome","Microsoft Edge"].contains(browser),"unsupported_browser")
 let dir=URL(fileURLWithPath:directory).standardizedFileURL;try safePath(dir)
 let manifest=try read(dir.appendingPathComponent("manifest.json"));_=try version(manifest["version"] as? String ?? "")
 #if LOCAL_TEST
 try require(dir.path==URL(fileURLWithPath:localTestDirectory).standardizedFileURL.path && manifest["key"]==nil,"wrong_extension")
 let supportName="CrowdV4LocalTestUpdater"
 #else
 guard let encoded=manifest["key"] as? String,let key=Data(base64Encoded:encoded) else {throw Failure("wrong_extension")}
 let id=SHA256.hash(data:key).prefix(16).flatMap{[Int($0>>4),Int($0&15)]}.map{String(UnicodeScalar(97+$0)!)}.joined()
 try require(id==extensionID,"wrong_extension")
 let supportName="CrowdV4Updater"
 #endif
 let home=installationHome(), support=home.appendingPathComponent("Library/Application Support"), dest=support.appendingPathComponent(supportName)
 if fm.fileExists(atPath:dest.path){try safePath(dest);if fm.fileExists(atPath:dest.appendingPathComponent("config.json").path){try require(try read(dest.appendingPathComponent("config.json"))["directory"] as? String==dir.path,"different_installation")}}
 else {try fm.createDirectory(at:dest,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])}
 let installLock=open(dest.appendingPathComponent("update.lock").path,O_CREAT|O_RDWR|O_NOFOLLOW,0o600)
 try require(installLock>=0,"lock_failed");defer{close(installLock)}
 try require(flock(installLock,LOCK_EX|LOCK_NB)==0,"busy");try proBusy(dest)
 let binary=dest.appendingPathComponent("crowd-v4-updater")
 #if PARTICIPANT
 let oldStateURL=dest.appendingPathComponent("state.json")
 if fm.fileExists(atPath:oldStateURL.path){try safePath(oldStateURL);let oldState=try read(oldStateURL);try require(oldState["pending"]==nil && oldState["staging_at"]==nil,"recovery_required")}
 let browserRoot=support.appendingPathComponent(browser=="Google Chrome" ? "Google/Chrome":"Microsoft Edge")
 let rollbackURLs=[binary,dest.appendingPathComponent("config.json"),browserRoot.appendingPathComponent("NativeMessagingHosts/"+hostName+".json"),home.appendingPathComponent("Library/LaunchAgents/"+hostName+".recovery.plist"),home.appendingPathComponent("Library/LaunchAgents/"+hostName+".ota.plist")]
 var originals:[(URL,Data?,Any?)]=[]
 let migrationBackup=dest.appendingPathComponent("migration-backup-"+UUID().uuidString)
 try fm.createDirectory(at:migrationBackup,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
 for (index,file) in rollbackURLs.enumerated(){
  let data:Data?
  if fm.fileExists(atPath:file.path){try safePath(file);data=try Data(contentsOf:file);try data!.write(to:migrationBackup.appendingPathComponent(String(index)),options:.atomic)}else{data=nil}
  let mode=fm.fileExists(atPath:file.path) ? (try fm.attributesOfItem(atPath:file.path))[.posixPermissions] : nil
  originals.append((file,data,mode))
 }
 if fm.fileExists(atPath:oldStateURL.path){try Data(contentsOf:oldStateURL).write(to:migrationBackup.appendingPathComponent("state.json"),options:.atomic)}
 try write(["schema":1,"created_at":Date().timeIntervalSince1970,"files":rollbackURLs.enumerated().map{["slot":String($0.offset),"path":$0.element.path]}],migrationBackup.appendingPathComponent("backup.json"))
 var installationComplete=false
 defer {
  if !installationComplete {
   for (file,data,mode) in originals {if let data=data{try? data.write(to:file,options:.atomic);if let mode=mode{try? fm.setAttributes([.posixPermissions:mode],ofItemAtPath:file.path)}}else if fm.fileExists(atPath:file.path){try? fm.removeItem(at:file)}}
  }
 }
 #endif
 try Data(contentsOf:executable).write(to:binary,options:.atomic);try fm.setAttributes([.posixPermissions:0o700],ofItemAtPath:binary.path)
 let prior=(try? read(dest.appendingPathComponent("config.json"))) ?? [:]
 var config=prior;config["directory"]=dir.path;config["scheduled_enabled"]=prior["scheduled_enabled"] as? Bool ?? false
 #if LOCAL_TEST
 config["extension_id"]=extensionID
 #else
 config["extension_key"]=encoded
 #endif
 try write(config,dest.appendingPathComponent("config.json"))
 #if TESTING
 if ProcessInfo.processInfo.environment["CROWD_TEST_INSTALL_HOME"] != nil && ProcessInfo.processInfo.environment["CROWD_TEST_INSTALL_FAILURE"]=="after_config" {throw Failure("injected_install_failure")}
 #endif
 let browserSupport=support.appendingPathComponent(browser=="Google Chrome" ? "Google/Chrome":"Microsoft Edge"), hosts=browserSupport.appendingPathComponent("NativeMessagingHosts")
 if fm.fileExists(atPath:hosts.path){try safePath(hosts)}else{try fm.createDirectory(at:hosts,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])}
 try write(["name":hostName,"description":"Verified updates for the existing crowd v4 extension","path":binary.path,"type":"stdio","allowed_origins":[origin]],hosts.appendingPathComponent(hostName+".json"))
 let agents=home.appendingPathComponent("Library/LaunchAgents");try fm.createDirectory(at:agents,withIntermediateDirectories:true)
 let plist=agents.appendingPathComponent(hostName+".recovery.plist")
 let value:[String:Any]=["Label":hostName+".recovery","ProgramArguments":[binary.path,"--recover"],"StartInterval":300,"RunAtLoad":true]
 try PropertyListSerialization.data(fromPropertyList:value,format:.xml,options:0).write(to:plist,options:.atomic)
 _=try? run("/bin/launchctl",["bootout","gui/\(getuid())",plist.path])
 _=try run("/bin/launchctl",["bootstrap","gui/\(getuid())",plist.path])
 let otaPlist=agents.appendingPathComponent(hostName+".ota.plist")
 let ota:[String:Any]=["Label":hostName+".ota","ProgramArguments":[binary.path,"--poll"],"StartInterval":3600,"RunAtLoad":true]
 try PropertyListSerialization.data(fromPropertyList:ota,format:.xml,options:0).write(to:otaPlist,options:.atomic)
 _=try? run("/bin/launchctl",["bootout","gui/\(getuid())",otaPlist.path])
 _=try run("/bin/launchctl",["bootstrap","gui/\(getuid())",otaPlist.path])
 #if PARTICIPANT
 installationComplete=true
 #endif
 FileHandle.standardError.write(Data("更新助手已接通；只更新原 v4 插件，不关闭浏览器。\n".utf8))
}

// The persistent Pro port is separate from OTA's short-lived update lock.
let proSchema="crowd-participant-native-v1"
let proLimit=262144
let proMethods:Set<String>=["scope","verify_platform_principal","pro_claim","pro_guard","pro_submit","pro_status","pro_receipt","pro_finish","pro_comment_submit","pro_comment_commit","pro_comment_receipt"]
let proStates:Set<String>=["ready","not_ready","running","complete","partial","finish_unknown","source_failed","source_unknown","delivery_unknown","source_launch_unknown","stopped","blocked","unknown","native_ready","launching"]
func proInteger(_ value:Any?) -> Int? {guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite,n.doubleValue>=0,n.doubleValue<=9007199254740991,n.doubleValue.rounded()==n.doubleValue else{return nil};return n.intValue}
func proUUID(_ value:Any?) -> Bool {guard let s=value as? String else{return false};return UUID(uuidString:s)?.uuidString.lowercased()==s}
func proCapability(_ raw:Any?) throws {
 guard let v=raw as? [String:Any] else{throw Failure("pro_invalid_message")}
 let feature=v["comment_options_v1"] as? NSNumber
 try require(Set(v.keys)==Set(["schema","runtime_sha256","entry_sha256","worker_sha256","upstream_commit","comment_options_v1","max_api_requests"]) && v["schema"] as? String=="crowd-participant-pro-capability-v1" && feature != nil && CFGetTypeID(feature!)==CFBooleanGetTypeID() && feature?.boolValue==true,"pro_invalid_message")
 for key in ["runtime_sha256","entry_sha256","worker_sha256"] {try require((v[key] as? String)?.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil,"pro_invalid_message")}
 try require((v["upstream_commit"] as? String)?.range(of:"^[a-f0-9]{40}$",options:.regularExpression) != nil && (proInteger(v["max_api_requests"]) ?? 0)>=1 && (proInteger(v["max_api_requests"]) ?? 101)<=100,"pro_invalid_message")
}
func proMessage(_ m:[String:Any],child:Bool=false) throws {
 let base:Set<String>=["schema","type","id","session","epoch"]
 try require(m["schema"] as? String==proSchema && proUUID(m["id"]) && proUUID(m["session"]) && proInteger(m["epoch"]) != nil,"pro_invalid_message")
 guard let type=m["type"] as? String else{throw Failure("pro_invalid_message")}
 var extra:[String]
 let rpcErrors:Set<String>=["participant_scope_changed","participant_writer_busy","participant_stopped","participant_rpc_outcome_unknown","participant_protocol_invalid"]
 let stateErrors=rpcErrors.union(["participant_contract_refused","participant_installation_invalid","participant_existing_run","participant_capability_required","pro_not_ready","login_required"])
 let phases:Set<String>=["initial","local_status","scope","delivery","import","stage","finish","source","stopping"]
 switch type {
 case "pro_hello":try require(!child && proInteger(m["version"])==1,"pro_invalid_message");extra=["version"];if m.keys.contains("capability_request"){try require(m["capability_request"] as? String=="pro_comment_options_v1","pro_invalid_message");extra=extra+["capability_request"]}
 case "pro_start":try require(!child && proUUID(m["subject"]) && proUUID(m["installation_id"]) && proUUID(m["intent"]) && (proInteger(m["task_id"]) ?? 0)>0,"pro_invalid_message");extra=["subject","installation_id","task_id","intent"]
 case "pro_stop","pro_status":try require(!child && (m["run_id"] is NSNull || proUUID(m["run_id"])),"pro_invalid_message");extra=["run_id"]
 case "rpc_result":try require(!child && m["ok"] is Bool && (m["error"] is NSNull || rpcErrors.contains(m["error"] as? String ?? "")),"pro_invalid_message");let ok=m["ok"] as? Bool==true;try require(ok ? (m["result"] is [String:Any] && m["error"] is NSNull):(m["result"] is NSNull && m["error"] is String),"pro_invalid_message");extra=["ok","result","error"]
 case "rpc_request":try require(child && proMethods.contains(m["method"] as? String ?? "") && m["params"] is [String:Any],"pro_invalid_message");extra=["method","params"]
 case "pro_state":try require(child && proStates.contains(m["state"] as? String ?? "") && phases.contains(m["phase"] as? String ?? "") && (m["error"] is NSNull || stateErrors.contains(m["error"] as? String ?? "")) && (m["run_id"] is NSNull || proUUID(m["run_id"])) && proInteger(m["pending"]) != nil && (m["received"] is NSNull || proInteger(m["received"]) != nil) && (m["target"] is NSNull || proInteger(m["target"]) != nil),"pro_invalid_message");extra=["run_id","state","phase","received","target","pending","error"];if m.keys.contains("capabilities"){try proCapability(m["capabilities"]);extra=extra+["capabilities"]}
 default:throw Failure("pro_invalid_message")
 }
 try require(Set(m.keys)==base.union(extra),"pro_invalid_message")
}
func framedRead(_ input:FileHandle) throws -> [String:Any]? {
 func readN(_ n:Int,initial:Bool=false) throws -> Data? {var b=Data();while b.count<n {let c=input.readData(ofLength:n-b.count);if c.isEmpty{if initial && b.isEmpty{return nil};throw Failure("pro_invalid_message")};b.append(c)};return b}
 guard let h=try readN(4,initial:true) else{return nil}
 let n=h.withUnsafeBytes{$0.loadUnaligned(as:UInt32.self).littleEndian}
 try require(n>0 && n<=proLimit,"pro_invalid_message")
 let b=try readN(Int(n))!;try require(String(data:b,encoding:.utf8) != nil,"pro_invalid_message");return try json(b)
}
let frameOutputLock=NSLock()
func framedWrite(_ m:[String:Any],_ out:FileHandle) throws {let b=try JSONSerialization.data(withJSONObject:m,options:[.sortedKeys]);try require(b.count<=proLimit,"pro_invalid_message");var n=UInt32(b.count).littleEndian;frameOutputLock.lock();defer{frameOutputLock.unlock()};try out.write(contentsOf:Data(bytes:&n,count:4));try out.write(contentsOf:b)}
func proBusy(_ directory:URL=root) throws {
 let fd=open(directory.appendingPathComponent("pro.lock").path,O_CREAT|O_RDWR|O_NOFOLLOW,0o600);try require(fd>=0,"lock_failed");defer{close(fd)}
 try require(flock(fd,LOCK_EX|LOCK_NB)==0,"busy")
 let file=directory.appendingPathComponent("pro-state.json")
 if fm.fileExists(atPath:file.path){try safePath(file);try require((try read(file))["busy"] as? Bool==false,"busy")}
}
func proConfiguration() throws -> [String:Any] {
 let path=root.appendingPathComponent("pro-config.json");try safePath(path)
 let a=try fm.attributesOfItem(atPath:path.path)
 try require(a[.type] as? FileAttributeType == .typeRegular && (a[.posixPermissions] as? Int ?? 0)==0o600 && (a[.size] as? Int ?? 999999)<=16384,"pro_not_ready")
 let c=try read(path)
 try require(Set(c.keys)==Set(["schema","python","entry","entry_sha256","root","mc_root","session_id","max_api_requests","purpose"]) && c["schema"] as? String=="crowd-participant-pro-install-v1" && proUUID(c["session_id"]) && (proInteger(c["max_api_requests"]) ?? 0)>0 && (proInteger(c["max_api_requests"]) ?? 999)<=100 && ["noncommercial_research"].contains(c["purpose"] as? String ?? ""),"pro_not_ready")
 for key in ["python","entry","root","mc_root"] {guard let p=c[key] as? String else{throw Failure("pro_not_ready")};try require(p.hasPrefix("/") && !p.contains("\n") && fm.fileExists(atPath:p),"pro_not_ready")}
 guard let entry=c["entry"] as? String,let hash=c["entry_sha256"] as? String,let python=c["python"] as? String else{throw Failure("pro_not_ready")}
 try safePath(URL(fileURLWithPath:entry));let data=try Data(contentsOf:URL(fileURLWithPath:entry));try require(data.count<=1048576 && digest(data)==hash && fm.isExecutableFile(atPath:python),"pro_not_ready")
 return c
}
func proResponse(_ first:[String:Any],_ state:String,_ error:String?) -> [String:Any] {return ["schema":proSchema,"type":"pro_state","id":first["id"]!,"session":first["session"]!,"epoch":first["epoch"]!,"run_id":NSNull(),"state":state,"phase":"initial","received":NSNull(),"target":NSNull(),"pending":0,"error":error as Any? ?? NSNull()]}
func proSession(_ first:[String:Any]) throws {
 try proMessage(first);try require(["pro_hello","pro_start"].contains(first["type"] as? String ?? ""),"pro_invalid_message");_=try configuredDirectory()
 let c:[String:Any]
 do {c=try proConfiguration()} catch {try framedWrite(proResponse(first,"not_ready","pro_not_ready"),.standardOutput);return}
 // Serialize starting a port against OTA before releasing its short lock.
 let update=open(root.appendingPathComponent("update.lock").path,O_CREAT|O_RDWR|O_NOFOLLOW,0o600);try require(update>=0,"lock_failed");defer{close(update)};try require(flock(update,LOCK_EX|LOCK_NB)==0,"busy")
 let lock=open(root.appendingPathComponent("pro.lock").path,O_CREAT|O_RDWR|O_NOFOLLOW,0o600);try require(lock>=0,"lock_failed");defer{close(lock)};try require(flock(lock,LOCK_EX|LOCK_NB)==0,"busy")
 let busyURL=root.appendingPathComponent("pro-state.json")
 // A reconnect can inspect durable state; it cannot silently clear an unknown run.
 let previousBusy=(try? read(busyURL))?["busy"] as? Bool ?? false
 try write(["busy":true,"state":"connected"],busyURL);flock(update,LOCK_UN)
 let process=Process(),input=Pipe(),output=Pipe();process.executableURL=URL(fileURLWithPath:c["python"] as! String);process.arguments=["-u",c["entry"] as! String,"--config",root.appendingPathComponent("pro-config.json").path];process.standardInput=input;process.standardOutput=output;process.standardError=FileHandle.nullDevice
 process.environment=["PATH":"/usr/bin:/bin:/usr/sbin:/sbin","HOME":fm.homeDirectoryForCurrentUser.path,"PYTHONDONTWRITEBYTECODE":"1","PYTHONUNBUFFERED":"1"]
 do {try process.run()} catch {try write(["busy":previousBusy,"state":"not_ready"],busyURL);try framedWrite(proResponse(first,"not_ready","pro_not_ready"),.standardOutput);return}
 let stateLock=NSLock();var clean=false;var run:Any=NSNull();var readerFailed=false;var pendingRPC=Set<String>();var recovering=previousBusy;var commandIssued=first["type"] as? String == "pro_start"
 let done=DispatchGroup();done.enter()
 DispatchQueue.global().async {
  defer{done.leave()}
  do {while let m=try framedRead(output.fileHandleForReading) {try proMessage(m,child:true);try require(m["session"] as? String==first["session"] as? String && proInteger(m["epoch"])==proInteger(first["epoch"]),"pro_invalid_message")
    stateLock.lock();defer{stateLock.unlock()}
    if m["type"] as? String=="rpc_request" {try require(!pendingRPC.contains(m["id"] as! String),"pro_invalid_message");pendingRPC.insert(m["id"] as! String);clean=false}
    if m["type"] as? String=="pro_state" {run=m["run_id"]!;let state=m["state"] as! String;if ["stopped","complete","partial","source_failed"].contains(state){recovering=false};clean = !recovering && pendingRPC.isEmpty && (["stopped","complete","partial","source_failed"].contains(state) || (!commandIssued && ["ready","not_ready"].contains(state))) && proInteger(m["pending"])==0;try write(["busy":!clean,"state":state],busyURL)}
    try framedWrite(m,.standardOutput)
  }} catch {stateLock.lock();readerFailed=true;clean=false;stateLock.unlock();try? write(["busy":true,"state":"unknown"],busyURL);try? input.fileHandleForWriting.close()}
 }
 defer {
  // EOF cancels the owned worker via its reader. Never signal Chrome or a foreign process group.
  stateLock.lock();let lastRun=run;let alreadyClean=clean && !readerFailed && pendingRPC.isEmpty;stateLock.unlock()
  var stop=first;stop["type"]="pro_stop";stop["id"]=UUID().uuidString.lowercased();stop=stop.filter{["schema","type","id","session","epoch"].contains($0.key)};stop["run_id"]=lastRun
  if !alreadyClean {try? framedWrite(stop,input.fileHandleForWriting)};try? input.fileHandleForWriting.close()
  let until=Date().addingTimeInterval(12);while process.isRunning && Date()<until {Thread.sleep(forTimeInterval:0.02)}
  if process.isRunning {process.terminate()}
  _=done.wait(timeout:.now()+1)
  stateLock.lock();let safe=clean && !readerFailed && pendingRPC.isEmpty && !process.isRunning && process.terminationStatus==0;stateLock.unlock()
  try? write(["busy":!safe,"state":safe ? "stopped":"unknown"],busyURL)
 }
 try framedWrite(first,input.fileHandleForWriting)
 while let m=try framedRead(.standardInput) {try proMessage(m);try require(m["session"] as? String==first["session"] as? String && proInteger(m["epoch"])==proInteger(first["epoch"]),"pro_invalid_message");if ["pro_start","pro_status","pro_stop"].contains(m["type"] as? String ?? "") {stateLock.lock();commandIssued=true;clean=false;stateLock.unlock()};if m["type"] as? String=="rpc_result" {stateLock.lock();let known=pendingRPC.remove(m["id"] as! String) != nil;stateLock.unlock();try require(known,"pro_invalid_message")};try framedWrite(m,input.fileHandleForWriting)}
}
func output(_ value: [String:Any]) {if let data=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]){var n=UInt32(data.count).littleEndian;FileHandle.standardOutput.write(Data(bytes:&n,count:4));FileHandle.standardOutput.write(data)}}
func exactRead(_ count: Int) throws -> Data {var data=Data();while data.count<count {let chunk=FileHandle.standardInput.readData(ofLength:count-data.count);if chunk.isEmpty {throw Failure("invalid_message")};data.append(chunk)};return data}
signal(SIGPIPE,SIG_IGN)
do {
 if CommandLine.arguments.count==3 && CommandLine.arguments[1]=="--reconnect" {try reconnect(CommandLine.arguments[2]);exit(0)}
 if CommandLine.arguments.count==3 && CommandLine.arguments[1]=="--check-install" {try checkParticipantInstallation(CommandLine.arguments[2]);exit(0)}
 if CommandLine.arguments.count==4 && CommandLine.arguments[1]=="--install" {try install(CommandLine.arguments[2],CommandLine.arguments[3]);exit(0)}
 try require(CommandLine.arguments.count==2 && (CommandLine.arguments[1]==origin || CommandLine.arguments[1]=="--recover" || CommandLine.arguments[1]=="--poll"),"invalid_origin")
 var first:[String:Any]?=nil
 if CommandLine.arguments[1]==origin {
  let header=try exactRead(4);let n=header.withUnsafeBytes{$0.loadUnaligned(as:UInt32.self).littleEndian};try require(n>0 && n<=proLimit,"invalid_message")
  let data=try exactRead(Int(n));try require(String(data:data,encoding:.utf8) != nil,"invalid_message");let message=try json(data)
  if message["schema"] as? String==proSchema {
   do {try proSession(message)} catch {if proUUID(message["id"]) && proUUID(message["session"]) && proInteger(message["epoch"]) != nil {try? framedWrite(proResponse(message,"blocked",safeErrorCode(error)=="busy" ? "participant_writer_busy":"participant_protocol_invalid"),.standardOutput)} else {throw error}};exit(0)
  }
  try require(n<=4096,"invalid_message");first=message
 }
 let fd=open(root.appendingPathComponent("update.lock").path,O_CREAT|O_RDWR|O_NOFOLLOW,0o600);try require(fd>=0,"lock_failed");defer{close(fd)};try require(flock(fd,LOCK_EX|LOCK_NB)==0,"busy")
 if CommandLine.arguments[1]=="--poll" {
  do {try scheduledPoll()} catch {var current=(try? state()) ?? [:];current["last_poll_at"]=Date().timeIntervalSince1970;current["poll_status"]="error";current["poll_error"]=safeErrorCode(error);try? write(current,stateURL);throw error}
 } else if CommandLine.arguments[1]=="--recover" {
  try proBusy();let dir=try configuredDirectory();var s=try state()
  if let pending=s["pending"] as? String,try read(dir.appendingPathComponent("manifest.json"))["version"] as? String != pending {_=try rollback(dir,&s)}
  else if s["awaiting_launch"] as? Bool != true,let at=s["applied_at"] as? Double,Date().timeIntervalSince1970-at>300 {_=try rollback(dir,&s)}
  else if s["pending"]==nil,let at=s["staging_at"] as? Double,Date().timeIntervalSince1970-at>300 {
   let(stage,_)=paths(dir);if fm.fileExists(atPath:stage.path){try safePath(stage);try fm.removeItem(at:stage)};s["staging_at"]=nil;try write(s,stateURL)
  }
 } else {
  output(try handle(first!))
 }
} catch let e as Failure {
 if CommandLine.arguments.dropFirst().first?.hasPrefix("--")==true {FileHandle.standardError.write(Data((e.code+"\n").utf8));exit(1)}
 output(["status":"error","error":e.code])
} catch {
 if CommandLine.arguments.dropFirst().first?.hasPrefix("--")==true {FileHandle.standardError.write(Data((safeErrorCode(error)+"\n").utf8));exit(1)}
 output(["status":"error","error":safeErrorCode(error)])
}
