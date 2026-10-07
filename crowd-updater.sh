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
  # 不带参数重启：扩展已在 profile 里注册（dev 挂载），Chrome 每次启动自动重读 unpacked 目录；
  # --load-extension 在 Chrome 154+ 已被官方拒绝（extension_service.cc:423），带了也被忽略
  open -a "Google Chrome"
  report upd_chrome_restarted "$NEW_VER"
fi
log "== updater 结束"
