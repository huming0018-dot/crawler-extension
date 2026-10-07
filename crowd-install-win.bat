@echo off
rem 众包美食家 · Windows 一键安装（v5 免管理员版，2026-10-07）
rem
rem 不需要管理员权限。原理：
rem   1) 下载插件包到 %USERPROFILE%\crowd-ext
rem   2) 装自更新器（任务计划，每 6 小时自动检查新版本，免管理员）
rem   3) 预置开发者模式 + 打开扩展页，引导一次手动挂载
rem 以后升级全自动。Chrome 企业策略通道在非企业 Windows 同样被 Chrome 拦截（与 Mac 同理），
rem 所以走"手动挂载 + 自更新"路线——这是现行唯一稳定通道。
chcp 65001 >nul
setlocal EnableDelayedExpansion
set "EXT_DIR=%USERPROFILE%\crowd-ext"
set "ZIP_URL=https://huming0018-dot.github.io/crowd-pages/crowd-extension-latest.zip"
set "UPDATE_URL=https://huming0018-dot.github.io/crowd-pages/updates.xml"
set "CHROME1=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "CHROME2=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
set "CHROME3=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

echo ==============================================
echo   众包美食家 · 一键安装（Windows · 免密码版）
echo ==============================================
echo.

echo —— 第 1 步：检查 Chrome
set "CHROME="
if exist "%CHROME1%" set "CHROME=%CHROME1%"
if exist "%CHROME2%" set "CHROME=%CHROME2%"
if exist "%CHROME3%" set "CHROME=%CHROME3%"
if not defined CHROME (
  echo [X] 没检测到 Chrome，请先安装 Chrome 浏览器后再运行本脚本
  echo     https://www.google.cn/chrome/
  pause
  exit /b 1
)
echo [OK] Chrome 已安装

echo.
echo —— 第 2 步：检查网络
curl -s -o nul -w "%%{http_code}" --max-time 12 "%UPDATE_URL%" > "%TEMP%\crowd_net.txt" 2>nul
set /p NETCODE=<"%TEMP%\crowd_net.txt"
if not "%NETCODE%"=="200" (
  echo [X] 连不上插件更新服务器（HTTP %NETCODE%），检查网络/代理后重跑
  pause
  exit /b 1
)
echo [OK] 更新通道正常

echo.
echo —— 第 3 步：下载插件包
if exist "%EXT_DIR%" rmdir /s /q "%EXT_DIR%"
mkdir "%EXT_DIR%" 2>nul
curl -sL --max-time 90 -o "%TEMP%\crowd-ext.zip" "%ZIP_URL%"
if not exist "%TEMP%\crowd-ext.zip" (
  echo [X] 插件包下载失败，检查网络后重跑
  pause
  exit /b 1
)
where tar >nul 2>nul
if %errorlevel%==0 (
  tar -xf "%TEMP%\crowd-ext.zip" -C "%EXT_DIR%" >nul 2>&1
) else (
  powershell -NoProfile -Command "Expand-Archive -Force '%TEMP%\crowd-ext.zip' '%EXT_DIR%'" >nul 2>&1
)
if not exist "%EXT_DIR%\manifest.json" (
  echo [X] 插件包解压失败，重跑本脚本
  pause
  exit /b 1
)
for /f "tokens=2 delims=:," %%a in ('findstr /c:"\"version\"" "%EXT_DIR%\manifest.json"') do set "EXT_VER=%%a"
set "EXT_VER=%EXT_VER:"=%"
set "EXT_VER=%EXT_VER: =%"
echo [OK] 插件包 v%EXT_VER% 已就位

echo.
echo —— 第 4 步：安装自更新器（以后自动升级）
schtasks /create /tn "众包美食家-自更新" /tr "powershell -NoProfile -ExecutionPolicy Bypass -File \"%EXT_DIR%\crowd-updater.ps1\"" /sc hourly /mo 6 /f >nul 2>&1
if %errorlevel%==0 (
  echo [OK] 自更新器已安装（每 6 小时自动检查新版本）
) else (
  echo [!] 自更新器注册失败（插件本体已装好，只是以后升级要重跑本脚本）
)

echo.
echo —— 第 5 步：预置开发者模式并打开挂载页
taskkill /f /im chrome.exe >nul 2>&1
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "$p = \"$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Preferences\"; if (Test-Path $p) { $d = Get-Content $p -Raw | ConvertFrom-Json; if (-not $d.extensions) { $d | Add-Member -MemberType NoteProperty -Name extensions -Value ([pscustomobject]@{}) -Force }; if (-not $d.extensions.ui) { $d.extensions | Add-Member -MemberType NoteProperty -Name ui -Value ([pscustomobject]@{}) -Force }; $d.extensions.ui | Add-Member -MemberType NoteProperty -Name developer_mode -Value $true -Force; $d | ConvertTo-Json -Depth 32 -Compress | Set-Content $p -Encoding UTF8 }" >nul 2>&1
if defined CHROME (start "" "%CHROME%" "chrome://extensions/") else (start "" "chrome://extensions/")

echo.
echo ==============================================
echo   还剩最后 4 下（只此一次）：
echo   在刚打开的 chrome://extensions 页面里——
echo   1. 右上角确认「开发者模式」已开（我已帮你预置）
echo   2. 点左上角「加载已解压的扩展程序」
echo   3. 地址栏粘贴：%EXT_DIR%
echo   4. 回车 → 点「选择文件夹」
echo.
echo   「众包美食家」出现后，协议页自动打开：
echo   点【我要加入】领编号 → 点【同意并开始使用】，完成！
echo   之后采集和升级全部自动，不用再碰。
echo ==============================================
pause
