#!/bin/bash
# 众包美食家 · Mac 一键安装（v4 零管理员版，2026-10-07）
#
# 不需要密码、不需要管理员。原理：
#   1) 下载插件包到 ~/crowd-ext；2) 装自更新器（自动升级）；3) 引导一次手动挂载（Chrome 154+ 已拒绝 --load-extension 命令行）
#   2) 装一个用户级自更新器（LaunchAgent，每 6 小时自动检查并应用新版本）
#   3) 启动 Chrome 并加载插件
# 以后升级全自动：自更新器下载新版 → 换上 → 重启 Chrome。
# 每一步自动上报遥测（crowd_install_report），出问题 PM 直接看到卡在哪。
EXT_ID="licijehcpohikchlnkbpjdjdfkcocndg"
EXT_DIR="$HOME/crowd-ext"
ZIP_URL="https://huming0018-dot.github.io/crowd-pages/crowd-extension-latest.zip"
ZIP_URL_BAK="https://bdwrhshgdeghgyzwpxnl.supabase.co/storage/v1/object/public/crowd/crowd-extension-v3.4.10.zip"
UPDATE_URL="https://huming0018-dot.github.io/crowd-pages/updates.xml"
API_KEY="sb_publishable_c93XenGzZsoa308e3bTg6A__lfaqQ-B"
RPC="https://bdwrhshgdeghgyzwpxnl.supabase.co/rest/v1/rpc/crowd_install_report"
RID="$(date +%s)-$(od -An -tx1 -N4 /dev/urandom 2>/dev/null | tr -d ' ' || echo R$RANDOM)"

report() {
  local msg
  msg=$(printf '%s' "$2" | tr '"\\' "'/" | head -c 380)
  curl -s --max-time 5 -X POST "$RPC" -H "apikey: $API_KEY" -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"p_run_id\":\"$RID\",\"p_step\":\"$1\",\"p_msg\":\"$msg\"}" >/dev/null 2>&1 || true
}

clear
echo "================================================"
echo "  众包美食家 · 一键安装（Mac · 免密码版）"
echo "  安装编号：$RID"
echo "================================================"
report start "v4 $(uname -m) macOS $(sw_vers -productVersion 2>/dev/null)"

step() { echo; echo "—— $1"; report "step" "$1"; }
fail() { echo; echo "❌ $1"; echo "👉 $2"; echo; report "FAIL" "$1"; exit 1; }

# ---------- 第 1 步：Chrome ----------
step "第 1 步：检查 Chrome"
[ -d "/Applications/Google Chrome.app" ] || fail "没检测到 Chrome" "先装 Chrome：https://www.google.cn/chrome/ ，装完重跑"
CHROME_VER=$("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version 2>/dev/null | grep -oE '[0-9]+' | head -1)
[ -n "$CHROME_VER" ] && [ "$CHROME_VER" -lt 96 ] && fail "Chrome 版本太老（$CHROME_VER）" "升级 Chrome 后重跑"
echo "✅ Chrome 已安装（版本 $CHROME_VER）"
report chrome_ok "chrome $CHROME_VER"

# ---------- 第 2 步：网络 ----------
step "第 2 步：检查网络"
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 12 "$UPDATE_URL" || echo 000)
[ "$CODE" = "200" ] || fail "连不上插件服务器（HTTP $CODE）" "检查网络/代理/VPN 后重跑"
echo "✅ 网络正常"
report net_ok "$CODE"

# ---------- 第 3 步：下载插件包 ----------
step "第 3 步：下载插件包"
rm -rf "$EXT_DIR" && mkdir -p "$EXT_DIR"
curl -sL --max-time 90 -o /tmp/crowd-ext.zip "$ZIP_URL" || curl -sL --max-time 90 -o /tmp/crowd-ext.zip "$ZIP_URL_BAK" \
  || fail "插件包下载失败" "检查网络后重跑"
[ -s /tmp/crowd-ext.zip ] || fail "插件包是空文件" "检查网络后重跑"
unzip -qo /tmp/crowd-ext.zip -d "$EXT_DIR" || fail "解压失败" "重跑本脚本"
[ -f "$EXT_DIR/manifest.json" ] || fail "解压内容不对" "重跑；不行就联系管理员"
VER=$(sed -n 's/.*"version": *"\([0-9.]*\)".*/\1/p' "$EXT_DIR/manifest.json" | head -1)
echo "✅ 插件包 v$VER 已就位"
report ext_ready "v$VER $EXT_DIR"

# ---------- 第 4 步：装自更新器（LaunchAgent，用户级免管理员）----------
step "第 4 步：安装自更新器（以后自动升级）"
# 4.1 更新器脚本本体
cat > "$EXT_DIR/crowd-updater.sh" <<'UPDATER_EOF'
#!/bin/bash
# crowd-updater.sh — 众包美食家自更新器（免管理员）
# 由 LaunchAgent 每 6 小时和登录时触发：检查新版本 → 下载 → 原子替换 → 必要时重启 Chrome。
# 上报到遥测（crowd_install_report），PM 可见每台机器的更新动作。
EXT_ID="licijehcpohikchlnkbpjdjdfkcocndg"
UPDATE_URL="https://huming0018-dot.github.io/crowd-pages/updates.xml"
ZIP_URL="https://huming0018-dot.github.io/crowd-pages/crowd-extension-latest.zip"
EXT_DIR="${CROWD_EXT_DIR:-$HOME/crowd-ext}"
RESTART_CHROME="${CROWD_UPDATER_RESTART:-1}"   # 0=只换文件不重启 Chrome（日常主力机用）
API_KEY="sb_publishable_c93XenGzZsoa308e3bTg6A__lfaqQ-B"
RPC="https://bdwrhshgdeghgyzwpxnl.supabase.co/rest/v1/rpc/crowd_install_report"
LOG="$HOME/Library/Logs/crowd-updater.log"

log() { echo "$(date '+%m-%d %H:%M:%S') $*" >> "$LOG"; }
report() {
  local msg
  msg=$(printf '%s' "$2" | tr '"\\' "'/" | head -c 380)
  curl -s --max-time 5 -X POST "$RPC" -H "apikey: $API_KEY" -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"p_run_id\":\"upd-$(hostname -s)\",\"p_step\":\"$1\",\"p_msg\":\"$msg\"}" >/dev/null 2>&1 || true
}

mkdir -p "$(dirname "$LOG")"
log "== updater 启动（ext_dir=$EXT_DIR restart=$RESTART_CHROME）"

# 读远端版本（updates.xml 的 version 字段是单一事实源）
XML=$(curl -sL --max-time 20 "$UPDATE_URL") || { log "拉取更新清单失败"; report upd_fail "fetch xml"; exit 0; }
REMOTE_VER=$(printf '%s' "$XML" | sed -n 's/.*updatecheck[^>]*version="\([0-9.]*\)".*/\1/p' | head -1)
[ -n "$REMOTE_VER" ] || { log "清单里读不到版本号"; report upd_fail "no version"; exit 0; }

# 读本地版本
LOCAL_VER="0"
[ -f "$EXT_DIR/manifest.json" ] && LOCAL_VER=$(sed -n 's/.*"version": *"\([0-9.]*\)".*/\1/p' "$EXT_DIR/manifest.json" | head -1)

if [ "$LOCAL_VER" = "$REMOTE_VER" ]; then
  log "已是最新 $LOCAL_VER"
  report upd_latest "$LOCAL_VER"
  exit 0
fi

log "发现新版本：本地 $LOCAL_VER → 远端 $REMOTE_VER"
report upd_found "$LOCAL_VER->$REMOTE_VER"

# 下载并原子替换
TMP=$(mktemp -d)
if ! curl -sL --max-time 90 -o "$TMP/ext.zip" "$ZIP_URL"; then
  log "下载失败"; report upd_fail "download"; rm -rf "$TMP"; exit 0
fi
[ -s "$TMP/ext.zip" ] || { log "下载为空"; report upd_fail "empty zip"; rm -rf "$TMP"; exit 0; }
unzip -qo "$TMP/ext.zip" -d "$TMP/x" || { log "解压失败"; report upd_fail "unzip"; rm -rf "$TMP"; exit 0; }
[ -f "$TMP/x/manifest.json" ] || { log "包内容不对"; report upd_fail "bad content"; rm -rf "$TMP"; exit 0; }

mkdir -p "$EXT_DIR"
rsync -a --delete "$TMP/x/" "$EXT_DIR/"
rm -rf "$TMP"
NEW_VER=$(sed -n 's/.*"version": *"\([0-9.]*\)".*/\1/p' "$EXT_DIR/manifest.json" | head -1)
log "已更新到 $NEW_VER"
report upd_applied "$NEW_VER"

# 重启 Chrome 让新版生效（挂载参数带上，保证 unpack 形态一直加载）
if [ "$RESTART_CHROME" = "1" ] && pgrep -x "Google Chrome" >/dev/null 2>&1; then
  log "重启 Chrome 应用新版本"
  osascript -e 'tell application "Google Chrome" to quit' 2>/dev/null || true
  sleep 4
  pkill -x "Google Chrome" 2>/dev/null; sleep 2
  open -a "Google Chrome" --args --load-extension="$EXT_DIR"
  report upd_chrome_restarted "$NEW_VER"
fi
log "== updater 结束"
UPDATER_EOF
chmod +x "$EXT_DIR/crowd-updater.sh"
# 4.2 LaunchAgent plist（模板变量替换）
LA_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LA_DIR"
PLIST_OUT="$LA_DIR/com.crowd.meishijia.updater.plist"
RESTART_FLAG="${CROWD_UPDATER_RESTART:-1}"
cat > "$PLIST_OUT" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.crowd.meishijia.updater</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$EXT_DIR/crowd-updater.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>21600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/crowd-updater-launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/crowd-updater-launchd.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CROWD_UPDATER_RESTART</key>
    <string>$RESTART_FLAG</string>
  </dict>
</dict>
</plist>
PLIST_EOF
# 4.3 注册（先卸旧的可能存在的，再装新的；gui 域不需要 root）
launchctl bootout "gui/$(id -u)/com.crowd.meishijia.updater" 2>/dev/null || true
if launchctl bootstrap "gui/$(id -u)" "$PLIST_OUT" 2>/dev/null; then
  echo "✅ 自更新器已安装（每 6 小时自动检查新版本）"
  report updater_ok "restart=$RESTART_FLAG"
else
  # 老系统回退 load 方式
  launchctl load "$PLIST_OUT" 2>/dev/null \
    && { echo "✅ 自更新器已安装（legacy 注册）"; report updater_ok "legacy"; } \
    || { echo "⚠️  自更新器注册失败（插件本体已装好，只是以后升级要重跑本脚本）"; report updater_fail ""; }
fi

# ---------- 第 5 步：预置开发者模式 + 引导手动挂载 ----------
# Chrome 154+ 拒绝 --load-extension 命令行（官方日志："not allowed in Google Chrome"），
# 且 Chrome 对 Secure Preferences 有 MAC 完整性校验，无法脚本注入注册——
# 唯一活路：chrome://extensions 手动「加载未打包的扩展程序」。本步把准备工作全做完，
# 用户只需点 4 下。
step "第 5 步：预置开发者模式并打开挂载页"
osascript -e 'tell application "Google Chrome" to quit' 2>/dev/null || true
sleep 3
pkill -x "Google Chrome" 2>/dev/null; sleep 2
# 预置开发者模式（普通 Preferences 无 MAC 校验，可脚本写入；必须 Chrome 关闭时改）
PREFS="$HOME/Library/Application Support/Google/Chrome/Default/Preferences"
if [ -f "$PREFS" ]; then
  python3 - "$PREFS" <<'PYEOF'
import json, sys
p = sys.argv[1]
try:
    d = json.load(open(p))
except Exception:
    d = {}
d.setdefault("extensions", {}).setdefault("ui", {})["developer_mode"] = True
json.dump(d, open(p, "w"))
PYEOF
  report devmode_preset ""
else
  echo "（Chrome 还没跑过，开发者模式需手动打开一次）"
fi
open -a "Google Chrome" "chrome://extensions/"
report extpage_opened ""

echo
echo "================================================"
echo "  ✅ 还剩最后 4 下（只此一次）："
echo "  在刚打开的 chrome://extensions 页面里——"
echo "  1. 右上角确认「开发者模式」已开（我已帮你预置）"
echo "  2. 点左上角「加载未打包的扩展程序」"
echo "  3. 文件框里按 Cmd+Shift+G，粘贴：$EXT_DIR"
echo "  4. 回车 → 点「选择」"
echo
echo "  「众包美食家」出现后，协议页自动打开："
echo "  点【我要加入】领编号 → 点【同意并开始使用】，完成！"
echo "  之后采集和升级全部自动，不用再碰。"
echo "================================================"
report install_done "v$VER manual-load"
