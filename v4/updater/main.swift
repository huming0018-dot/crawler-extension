import Foundation
import CryptoKit
import Darwin

// The host accepts fixed verbs only. Paths, keys and endpoints never come from a browser message.
let fm = FileManager.default
let extensionID = "licijehcpohikchlnkbpjdjdfkcocndg"
let hostName = "com.crowd.v4.updater"
let channelURL = "https://raw.githubusercontent.com/huming0018-dot/crowd-pages/codex/v4.0.6-handoff/v4/releases/channel.json"
let origin = "chrome-extension://\(extensionID)/"
struct Failure: Error { let code: String; init(_ code: String) { self.code = code } }
func require(_ value: Bool, _ code: String) throws { if !value { throw Failure(code) } }
func json(_ data: Data) throws -> [String: Any] { guard let v = try JSONSerialization.jsonObject(with:data) as? [String:Any] else { throw Failure("invalid_data") }; return v }
func read(_ url: URL) throws -> [String:Any] { try json(Data(contentsOf:url)) }
func write(_ value: [String:Any], _ url: URL) throws { try JSONSerialization.data(withJSONObject:value, options:[.sortedKeys]).write(to:url, options:.atomic); try fm.setAttributes([.posixPermissions:0o600], ofItemAtPath:url.path) }
func digest(_ data: Data) -> String { SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined() }
func version(_ text: String) throws -> [Int] { let a=text.split(separator:"."); try require(a.count==3 && a[0]=="4" && a.allSatisfy{!$0.isEmpty && $0.allSatisfy(\.isNumber)},"invalid_version"); let n=a.compactMap{Int($0)}; try require(n.count==3 && n.allSatisfy{$0<65536} && n.map(String.init).joined(separator:".")==text,"invalid_version"); return n }
func greater(_ a: String, _ b: String) throws -> Bool { try version(a).lexicographicallyPrecedes(version(b)) == false && a != b }
func run(_ executable: String, _ args: [String]) throws -> Data {
 let process=Process(), pipe=Pipe(); process.executableURL=URL(fileURLWithPath:executable); process.arguments=args; process.standardOutput=pipe; process.standardError=FileHandle.nullDevice
 try process.run(); let output=pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit(); try require(process.terminationStatus==0,"operation_failed"); return output
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
 try require(manifest["key"] as? String == c["extension_key"] as? String,"wrong_extension")
 return dir
}
func state() throws -> [String:Any] { fm.fileExists(atPath:stateURL.path) ? try read(stateURL) : [:] }
func paths(_ dir: URL) -> (URL, URL) { (dir.deletingLastPathComponent().appendingPathComponent(".crowd-v4-stage"),dir.deletingLastPathComponent().appendingPathComponent(".crowd-v4-backup")) }
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
 s["failed_sequence"]=s["pending_sequence"];s["pending"]=nil;s["pending_sequence"]=nil;s["pending_digest"]=nil;s["applied_at"]=nil;s["status"]="rolled_back"
 try write(s,stateURL);return true
}
func handle(_ message: [String:Any]) throws -> [String:Any] {
 try require(Set(message.keys).isSubset(of:["action","version","release_sha256"]),"invalid_request")
 let dir=try configuredDirectory(), (stage,backup)=paths(dir); var s=try state()
 let loaded=message["version"] as? String ?? ""; _=try version(loaded)
 let local=try read(dir.appendingPathComponent("manifest.json"))["version"] as? String ?? ""
 guard let action=message["action"] as? String else {throw Failure("invalid_request")}
 if action=="rollback" {try require(s["pending"] as? String == loaded,"no_pending_update");let restored=try rollback(dir,&s);return ["status":restored ? "rolled_back":"idle"]}
 if action=="ack" {
  if s["pending"] != nil && local != s["pending"] as? String {_=try rollback(dir,&s)}
  if let pending=s["pending"] as? String {
   try require(loaded==pending && local==pending && message["release_sha256"] as? String==s["pending_digest"] as? String,"handshake_mismatch")
   try require(digest(Data(contentsOf:dir.appendingPathComponent("release.json")))==s["pending_digest"] as? String,"handshake_mismatch")
   s["sequence"]=s["pending_sequence"];s["loaded_version"]=loaded;s["status"]="applied";s["pending"]=nil;s["pending_sequence"]=nil;s["pending_digest"]=nil;s["applied_at"]=nil
   try write(s,stateURL);if fm.fileExists(atPath:backup.path){try fm.removeItem(at:backup)}
  }
  return ["status":s["status"] as? String ?? "ready","version":local]
 }
 if action=="status" {return ["status":s["pending"] == nil ? (s["status"] as? String ?? "ready") : "pending_reload","version":local]}
 try require(action=="apply","invalid_request");try require(local==loaded,"version_mismatch")
 if s["pending"] != nil {return ["status":"pending_reload","version":local]}
 let temp=root.appendingPathComponent("download-"+UUID().uuidString);try fm.createDirectory(at:temp,withIntermediateDirectories:false);defer{try? fm.removeItem(at:temp)}
 var channel=channelURL
 #if TESTING
 channel=(try read(configURL))["test_channel"] as? String ?? channel
 #endif
 let envelopeURL=temp.appendingPathComponent("channel.json");try fetch(channel,envelopeURL,16384)
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
 let archive=temp.appendingPathComponent("extension.zip");try fetch(url,archive,2097152);let data=try Data(contentsOf:archive);try require(data.count==bytes && digest(data)==hash,"hash_mismatch")
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
 let rescue="try { importScripts('background.js'); } catch (_) { chrome.runtime.sendNativeMessage('com.crowd.v4.updater', {action:'rollback',version:'"+next+"'}).then(r=>{if(r.status==='rolled_back')chrome.runtime.reload();}).catch(()=>{}); }\n"
 try require(try String(contentsOf:stage.appendingPathComponent(worker),encoding:.utf8)==rescue,"invalid_package")
 var oldShape=oldManifest,newShape=newManifest
 for field in ["version","background"] {oldShape[field]=nil;newShape[field]=nil}
 try require(try JSONSerialization.data(withJSONObject:oldShape,options:[.sortedKeys])==JSONSerialization.data(withJSONObject:newShape,options:[.sortedKeys]),"permission_change")
 // New capabilities require a reviewed bootstrap, never silent permission expansion.
 for field in ["permissions","host_permissions","externally_connectable","content_scripts"] {
  let a=try JSONSerialization.data(withJSONObject:oldManifest[field] ?? [],options:[.sortedKeys,.fragmentsAllowed]);let b=try JSONSerialization.data(withJSONObject:newManifest[field] ?? [],options:[.sortedKeys,.fragmentsAllowed]);try require(a==b,"permission_change")
 }
 // Persist intent before swap. Recovery handles a process crash at each boundary.
 s["pending"]=next;s["pending_sequence"]=sequence;s["pending_digest"]=releaseHash;s["applied_at"]=Date().timeIntervalSince1970;s["status"]="applying";try write(s,stateURL)
 try fm.moveItem(at:stage,to:backup)
 try require(renameatx_np(AT_FDCWD,dir.path,AT_FDCWD,backup.path,UInt32(RENAME_SWAP))==0,"swap_failed")
 s["status"]="pending_reload";try write(s,stateURL)
 return ["status":"pending_reload","version":next]
}
func install(_ directory: String, _ browser: String) throws {
 try require(["Google Chrome","Microsoft Edge"].contains(browser),"unsupported_browser")
 let dir=URL(fileURLWithPath:directory).standardizedFileURL;try safePath(dir)
 let manifest=try read(dir.appendingPathComponent("manifest.json"));_=try version(manifest["version"] as? String ?? "")
 guard let encoded=manifest["key"] as? String,let key=Data(base64Encoded:encoded) else {throw Failure("wrong_extension")}
 let id=SHA256.hash(data:key).prefix(16).flatMap{[Int($0>>4),Int($0&15)]}.map{String(UnicodeScalar(97+$0)!)}.joined()
 try require(id==extensionID,"wrong_extension")
 let home=fm.homeDirectoryForCurrentUser, support=home.appendingPathComponent("Library/Application Support"), dest=support.appendingPathComponent("CrowdV4Updater")
 if fm.fileExists(atPath:dest.path){try safePath(dest);if fm.fileExists(atPath:dest.appendingPathComponent("config.json").path){try require(try read(dest.appendingPathComponent("config.json"))["directory"] as? String==dir.path,"different_installation")}}
 else {try fm.createDirectory(at:dest,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])}
 let binary=dest.appendingPathComponent("crowd-v4-updater")
 try Data(contentsOf:executable).write(to:binary,options:.atomic);try fm.setAttributes([.posixPermissions:0o700],ofItemAtPath:binary.path)
 try write(["directory":dir.path,"extension_key":encoded],dest.appendingPathComponent("config.json"))
 let browserSupport=support.appendingPathComponent(browser=="Google Chrome" ? "Google/Chrome":"Microsoft Edge"), hosts=browserSupport.appendingPathComponent("NativeMessagingHosts")
 if fm.fileExists(atPath:hosts.path){try safePath(hosts)}else{try fm.createDirectory(at:hosts,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])}
 try write(["name":hostName,"description":"Verified updates for the existing crowd v4 extension","path":binary.path,"type":"stdio","allowed_origins":[origin]],hosts.appendingPathComponent(hostName+".json"))
 let agents=home.appendingPathComponent("Library/LaunchAgents");try fm.createDirectory(at:agents,withIntermediateDirectories:true)
 let plist=agents.appendingPathComponent(hostName+".recovery.plist")
 let value:[String:Any]=["Label":hostName+".recovery","ProgramArguments":[binary.path,"--recover"],"StartInterval":300,"RunAtLoad":true]
 try PropertyListSerialization.data(fromPropertyList:value,format:.xml,options:0).write(to:plist,options:.atomic)
 _=try? run("/bin/launchctl",["bootout","gui/\(getuid())",plist.path])
 _=try run("/bin/launchctl",["bootstrap","gui/\(getuid())",plist.path])
 FileHandle.standardError.write(Data("更新助手已接通；只更新原 v4 插件，不关闭浏览器。\n".utf8))
}
func output(_ value: [String:Any]) {if let data=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]){var n=UInt32(data.count).littleEndian;FileHandle.standardOutput.write(Data(bytes:&n,count:4));FileHandle.standardOutput.write(data)}}
func exactRead(_ count: Int) throws -> Data {var data=Data();while data.count<count {let chunk=FileHandle.standardInput.readData(ofLength:count-data.count);if chunk.isEmpty {throw Failure("invalid_message")};data.append(chunk)};return data}
do {
 if CommandLine.arguments.count==4 && CommandLine.arguments[1]=="--install" {try install(CommandLine.arguments[2],CommandLine.arguments[3]);exit(0)}
 try require(CommandLine.arguments.count==2 && (CommandLine.arguments[1]==origin || CommandLine.arguments[1]=="--recover"),"invalid_origin")
 let fd=open(root.appendingPathComponent("update.lock").path,O_CREAT|O_RDWR|O_NOFOLLOW,0o600);try require(fd>=0,"lock_failed");defer{close(fd)};try require(flock(fd,LOCK_EX|LOCK_NB)==0,"busy")
 if CommandLine.arguments[1]=="--recover" {
  let dir=try configuredDirectory();var s=try state();if let at=s["applied_at"] as? Double,Date().timeIntervalSince1970-at>300 {_=try rollback(dir,&s)}
  else if s["pending"]==nil,let at=s["staging_at"] as? Double,Date().timeIntervalSince1970-at>300 {
   let(stage,_)=paths(dir);if fm.fileExists(atPath:stage.path){try safePath(stage);try fm.removeItem(at:stage)};s["staging_at"]=nil;try write(s,stateURL)
  }
 } else {
  let header=try exactRead(4);let n=header.withUnsafeBytes{$0.loadUnaligned(as:UInt32.self).littleEndian};try require(n>0 && n<=4096,"invalid_message")
  output(try handle(json(exactRead(Int(n)))))
 }
} catch let e as Failure {
 if CommandLine.arguments.dropFirst().first?.hasPrefix("--")==true {FileHandle.standardError.write(Data((e.code+"\n").utf8));exit(1)}
 output(["status":"error","error":e.code])
} catch {
 if CommandLine.arguments.dropFirst().first?.hasPrefix("--")==true {FileHandle.standardError.write(Data("operation_failed\n".utf8));exit(1)}
 output(["status":"error","error":"operation_failed"])
}
