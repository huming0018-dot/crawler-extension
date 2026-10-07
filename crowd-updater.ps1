# crowd-updater.ps1 — 众包美食家自更新器（Windows · 免管理员）
# 由任务计划每 6 小时与登录时触发：检查新版本 → 下载 → 原子替换 → 必要时重启 Chrome（复用 profile 内已注册的 dev 挂载，无需任何启动参数）。
# 上报遥测（crowd_install_report），PM 可见每台机器的更新动作。
$ErrorActionPreference = 'SilentlyContinue'
$ext      = if ($env:CROWD_EXT_DIR) { $env:CROWD_EXT_DIR } else { "$env:USERPROFILE\crowd-ext" }
$restart  = if ($env:CROWD_UPDATER_RESTART) { $env:CROWD_UPDATER_RESTART } else { "1" }
$updateUrl= "https://huming0018-dot.github.io/crowd-pages/updates.xml"
$zipUrl   = "https://huming0018-dot.github.io/crowd-pages/crowd-extension-latest.zip"
$logFile  = "$env:USERPROFILE\Library\Logs\crowd-updater.log"
$apiKey   = "sb_publishable_c93XenGzZsoa308e3bTg6A__lfaqQ-B"
$rpc      = "https://bdwrhshgdeghgyzwpxnl.supabase.co/rest/v1/rpc/crowd_install_report"

function Log($m) {
  $dir = Split-Path $logFile
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  Add-Content -Path $logFile -Value ("{0} {1}" -f (Get-Date -Format 'MM-dd HH:mm:ss'), $m)
}
function Report($step, $msg) {
  try {
    $body = @{ p_run_id = "upd-$env:COMPUTERNAME"; p_step = $step; p_msg = ($msg -replace '["\\]', "'").Substring(0, [Math]::Min(380, $msg.Length)) } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri $rpc -Method Post -TimeoutSec 5 -Headers @{ apikey = $apiKey; Authorization = "Bearer $apiKey" } -ContentType "application/json" -Body $body | Out-Null
  } catch {}
}

Log "== updater start (ext=$ext restart=$restart)"

try { $xml = (Invoke-WebRequest -Uri $updateUrl -TimeoutSec 20 -UseBasicParsing).Content }
catch { Log "fetch xml fail"; Report upd_fail "fetch xml"; exit 0 }
if ($xml -notmatch 'version="([0-9.]+)"') { Log "no version"; Report upd_fail "no version"; exit 0 }
$remote = $Matches[1]

$local = "0"
$mf = Join-Path $ext "manifest.json"
if (Test-Path $mf) {
  $m = [regex]::Match((Get-Content $mf -Raw), '"version":\s*"([0-9.]+)"')
  if ($m.Success) { $local = $m.Groups[1].Value }
}
if ($local -eq $remote) { Log "latest $local"; Report upd_latest $local; exit 0 }

Log "found $local -> $remote"; Report upd_found "$local->$remote"
$tmp = Join-Path $env:TEMP ("crowd-ext-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Invoke-WebRequest -Uri $zipUrl -OutFile "$tmp\ext.zip" -TimeoutSec 90 -UseBasicParsing
  if ((Get-Item "$tmp\ext.zip").Length -lt 1000) { throw "empty zip" }
  Expand-Archive -Force "$tmp\ext.zip" "$tmp\x"
  if (!(Test-Path "$tmp\x\manifest.json")) { throw "bad content" }
  if (!(Test-Path $ext)) { New-Item -ItemType Directory -Force -Path $ext | Out-Null }
  robocopy "$tmp\x" $ext /MIR | Out-Null
  $newVer = ([regex]::Match((Get-Content (Join-Path $ext "manifest.json") -Raw), '"version":\s*"([0-9.]+)"')).Groups[1].Value
  Log "applied $newVer"; Report upd_applied $newVer
  if ($restart -eq "1") {
    Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep 4
    Start-Process "chrome.exe"
    Log "chrome restarted"; Report upd_chrome_restarted $newVer
  }
} catch {
  Log "apply fail: $_"; Report upd_fail "apply $_"
}
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Log "== updater end"
