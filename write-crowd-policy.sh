#!/bin/bash
# write-crowd-policy.sh — 以管理员身份写入 Chrome 插件强制安装策略（由 osascript 提权调用）
set -e
EXT_ID="licijehcpohikchlnkbpjdjdfkcocndg"
UPDATE_URL="https://bdwrhshgdeghgyzwpxnl.supabase.co/storage/v1/object/public/crowd/updates.xml"
ENTRY="$EXT_ID;$UPDATE_URL"
PLIST="/Library/Managed Preferences/com.google.Chrome"

if /usr/libexec/PlistBuddy -c "Print :ExtensionInstallForcelist" "$PLIST.plist" >/dev/null 2>&1; then
  if /usr/libexec/PlistBuddy -c "Print :ExtensionInstallForcelist" "$PLIST.plist" | grep -q "$EXT_ID"; then
    echo "策略已存在"
  else
    IDX=$(/usr/libexec/PlistBuddy -c "Print :ExtensionInstallForcelist" "$PLIST.plist" | grep -cE "^    " || true)
    /usr/libexec/PlistBuddy -c "Add :ExtensionInstallForcelist:$IDX string $ENTRY" "$PLIST.plist"
    echo "已追加"
  fi
else
  /usr/bin/defaults write "$PLIST" ExtensionInstallForcelist -array "$ENTRY"
  echo "已新建"
fi
/usr/libexec/PlistBuddy -c "Print :ExtensionInstallForcelist" "$PLIST.plist"
