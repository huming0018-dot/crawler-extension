#!/bin/bash
# publish.sh — 众包美食家一键发布（纯 bash，无需 python/agent）
#
# 做什么：
#   1. 从 manifest.json 读版本号
#   2. 校验 key.pem 与 manifest 内固定公钥一致（保证扩展 ID 稳定，自动升级链不断）
#   3. 打出 crowd-extension-v<ver>.zip（开发者模式备用）和 .crx（Chrome 自动升级主通道）
#      + crowd-extension-v<ver>-firefox.xpi（Firefox 通道，仅运行时文件，待 AMO 签名）
#   4. 生成 updates.xml（Chrome 更新清单）+ updates-firefox.json（Mozilla 更新清单，指向签名后 -signed 包）
#   5. 上传 bucket（PUT + x-upsert）：zip / crx / updates.xml / 三个引导页 / 两个安装器
#
# 用法：
#   ./publish.sh              # 打包 + 上传
#   ./publish.sh --no-upload  # 只打包，产物在 ./dist-release/
#
# 上传凭据（service_role，机密，绝不入库）：按以下顺序取
#   环境变量 CROWD_SERVICE_KEY > ../cloud/deploy.env 内 SERVICE_KEY 或 SUPABASE_SERVICE_ROLE_KEY
set -euo pipefail
cd "$(dirname "$0")"

EXT_ID="licijehcpohikchlnkbpjdjdfkcocndg"
# BUCKET：公网读取 URL（写进 updates.xml 给 Chrome 用）；UPLOAD：上传端点（无 public 前缀，否则被当成名为 public 的 bucket 报 NoSuchBucket）
BUCKET="https://bdwrhshgdeghgyzwpxnl.supabase.co/storage/v1/object/public/crowd"
UPLOAD="https://bdwrhshgdeghgyzwpxnl.supabase.co/storage/v1/object/crowd"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="dist-release"
NO_UPLOAD=0
[ "${1:-}" = "--no-upload" ] && NO_UPLOAD=1

VER=$(sed -n 's/.*"version": *"\([0-9.]*\)".*/\1/p' manifest.json | head -1)

# Chrome 打包用单形态 manifest（service_worker only）：manifest.json 里的双形态是给 Firefox 的，
# Chrome <121 不认 MV3 里的 background.scripts 键会拒装。打包时临时摘掉，打完恢复。
cp manifest.json "$OUT/manifest.with-scripts.bak"
python3 - "$OUT/manifest.with-scripts.bak" <<'PYEOF'
import json, sys
m = json.load(open(sys.argv[1]))
if isinstance(m.get("background"), dict) and "scripts" in m["background"]:
    del m["background"]["scripts"]
json.dump(m, open("manifest.json","w"), ensure_ascii=False, indent=2)
PYEOF
trap 'cp "$OUT/manifest.with-scripts.bak" manifest.json' EXIT
[ -n "$VER" ] || { echo "❌ 读不到 manifest 版本号"; exit 1; }
echo "== 发布众包美食家 v$VER（扩展 ID $EXT_ID）"

# ---- 1. 密钥：第一次发布生成；之后必须复用，丢了 = 扩展 ID 变 = 全员升级链断 ----
if [ ! -f key.pem ]; then
  echo "⚠️  key.pem 不存在，正在生成新密钥（仅应在首次发布发生；生成后请立即备份 key.pem！）"
  openssl genrsa -out key.pem 2048 2>/dev/null
  # Chrome 要求 PKCS#8 格式（BEGIN PRIVATE KEY），genrsa 默认产出 PKCS#1，需转换
  openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pem.tmp && mv key.pem.tmp key.pem
fi
grep -q "BEGIN PRIVATE KEY" key.pem || {
  openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pem.tmp && mv key.pem.tmp key.pem
}
openssl rsa -in key.pem -pubout -outform DER 2>/dev/null > "$OUT.tmp.der" || { echo "❌ key.pem 损坏"; exit 1; }
DERIVED_ID=$(shasum -a 256 "$OUT.tmp.der" | cut -c1-32 | tr '0-9a-f' 'a-p')
DERIVED_KEY=$(base64 -i "$OUT.tmp.der" | tr -d '\n')
rm -f "$OUT.tmp.der"
[ "$DERIVED_ID" = "$EXT_ID" ] || { echo "❌ key.pem 与固定扩展 ID 不符（$DERIVED_ID ≠ $EXT_ID），会断升级链，中止"; exit 1; }
grep -q "$DERIVED_KEY" manifest.json || { echo "❌ manifest.json 的 key 与 key.pem 不一致，中止"; exit 1; }
echo "== 密钥校验通过"

# ---- 2. 打包（先复制到暂存目录：Chrome 拒绝打包内含 key.pem 的目录，也避免把产物打进包里）----
STAGE=$(mktemp -d /tmp/crowd-pack-XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT"
ZIP_NAME="crowd-extension-v$VER.zip"
CRX_NAME="crowd-extension-v$VER.crx"
ZIP="$OUT/$ZIP_NAME"
CRX="$OUT/$CRX_NAME"
rm -f "$ZIP" "$CRX"
rsync -a --exclude "key.pem" --exclude "dist-release" --exclude ".DS_Store" --exclude "*.zip" --exclude "*.crx" ./ "$STAGE/"
(cd "$STAGE" && zip -qr "$OLDPWD/$ZIP" .)
echo "== zip 完成：$ZIP（$(du -h "$ZIP" | cut -f1)）"

# ---- 3. crx（Chrome 打包，自动升级主通道）----
if [ -x "$CHROME" ]; then
  "$CHROME" --pack-extension="$STAGE" --pack-extension-key="$(pwd)/key.pem" --no-message-box 2>/dev/null || true
  [ -f "/tmp/crowd_pack.crx" ] && rm -f /tmp/crowd_pack.crx
  STAGE_CRX="$(dirname "$STAGE")/$(basename "$STAGE").crx"
  [ -f "$STAGE_CRX" ] && mv "$STAGE_CRX" "$CRX"
fi
if [ -f "$CRX" ]; then
  echo "== crx 完成：$CRX（$(du -h "$CRX" | cut -f1)）"
else
  echo "⚠️  未能生成 crx（需要本机装 Chrome）。zip 不受影响，但自动升级通道缺 crx。"
fi

# ---- 4. updates.xml ----
cat > "$OUT/updates.xml" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="$EXT_ID">
    <updatecheck codebase="$BUCKET/crowd-extension-v$VER.crx" version="$VER" />
  </app>
</gupdate>
XML
echo "== updates.xml 完成"

# 恢复双形态 manifest（Firefox 打包需要 scripts 数组；Chrome 包已在前面用单形态打完）
cp "$OUT/manifest.with-scripts.bak" manifest.json

# ---- 4.5 Firefox xpi（v3.4.8 起纳入流程；此前 Firefox 包是手工一次性产物，版本停在 v3.4.1）----
# 只含扩展运行时文件：manifest.json + src/ + icons/icon128.png
# 剔除 publish.sh / 安装器 / 引导 html / 文档 / key.pem（AMO lint 会 flag，且暴露内部流程）
GECKO_ID=$(sed -n 's/^ *"id": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
[ -n "$GECKO_ID" ] || GECKO_ID=$(node -e "console.log(require('./manifest.json').browser_specific_settings.gecko.id)" 2>/dev/null || true)
[ -n "$GECKO_ID" ] || { echo "❌ 读不到 gecko id"; exit 1; }
FF_STAGE=$(mktemp -d /tmp/crowd-ff-pack-XXXXXX)
cp manifest.json "$FF_STAGE/"
cp -R src "$FF_STAGE/src"
mkdir -p "$FF_STAGE/icons" && cp icons/icon128.png "$FF_STAGE/icons/"
find "$FF_STAGE" -name ".DS_Store" -delete
XPI_NAME="crowd-extension-v$VER-firefox.xpi"
XPI="$OUT/$XPI_NAME"
rm -f "$XPI"
(cd "$FF_STAGE" && zip -qr "$OLDPWD/$XPI" .)
rm -rf "$FF_STAGE"
echo "== Firefox xpi 完成：$XPI（$(du -h "$XPI" | cut -f1)）"

# ---- 4.6 updates-firefox.json（Mozilla 格式更新清单，gecko.update_url 指向它）----
# 注意：update_link 指向 AMO 签名后的 -firefox-signed.xpi（未签名包在正式版 Firefox 装不上）。
# 不放 update_hash：AMO 签名会改变文件内容使哈希失效，签名本身就是完整性校验。
# 发布顺序：先上传本 json 无碍（客户端拿到 400 只是不更新），但放量前必须上传 signed xpi。
cat > "$OUT/updates-firefox.json" <<JSON
{
  "addons": {
    "$GECKO_ID": {
      "updates": [
        {
          "version": "$VER",
          "update_link": "$BUCKET/crowd-extension-v$VER-firefox-signed.xpi",
          "applications": { "gecko": { "strict_min_version": "126.0" } }
        }
      ]
    }
  }
}
JSON
echo "== updates-firefox.json 完成（gecko id $GECKO_ID）"

# ---- 5. 上传 ----
if [ "$NO_UPLOAD" = "1" ]; then
  echo "== --no-upload：跳过上传。产物在 $OUT/"
  exit 0
fi
SVC="${CROWD_SERVICE_KEY:-}"
if [ -z "$SVC" ] && [ -f ../cloud/deploy.env ]; then
  SVC=$(grep -E "^(SERVICE_KEY|SUPABASE_SERVICE_ROLE_KEY)=" ../cloud/deploy.env | head -1 | cut -d= -f2-)
fi
[ -n "$SVC" ] || { echo "❌ 缺 service_role 凭据：export CROWD_SERVICE_KEY=... 或在 ../cloud/deploy.env 配置"; exit 1; }

upload() { # $1=本地文件 $2=bucket 路径 $3=content-type
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
    -H "Authorization: Bearer $SVC" -H "apikey: $SVC" -H "x-upsert: true" \
    -H "Content-Type: $3" --data-binary "@$1" "$UPLOAD/$2")
  [ "$code" = "200" ] && echo "   ✅ $2" || { echo "   ❌ $2 -> HTTP $code"; FAIL=1; }
}
FAIL=0
upload "$ZIP" "crowd-extension-v$VER.zip" "application/zip"
[ -f "$CRX" ] && upload "$CRX" "crowd-extension-v$VER.crx" "application/octet-stream"
upload "$OUT/updates.xml" "updates.xml" "text/xml"
# Firefox 通道：未签名 xpi（供 web-ext sign 取回签名）+ Mozilla 更新清单。
# ⚠️ 放量前提：AMO 签名后的 crowd-extension-v$VER-firefox-signed.xpi 需人工上传到同名路径，
#    否则 updates-firefox.json 里的 update_link 是 400，存量 Firefox 用户不会升级。
upload "$XPI" "$XPI_NAME" "application/x-xpinstall"
upload "$OUT/updates-firefox.json" "updates-firefox.json" "application/json"
upload apply.html apply.html "text/html"
upload install.html install.html "text/html"
upload install-mobile.html install-mobile.html "text/html"
upload submit.html submit.html "text/html"
upload sw.js sw.js "text/javascript"
upload app-manifest.json app-manifest.json "application/json"
upload icons/icon192.png icon192.png "image/png"
upload icons/icon512.png icon512.png "image/png"
upload crowd-install-mac.command crowd-install-mac.command "application/octet-stream"
upload crowd-install-win.bat crowd-install-win.bat "application/octet-stream"
[ "$FAIL" = "0" ] && # 6. Chrome 更新通道同步到 GitHub Pages（bucket 对 .xml 强制 text/plain，Chrome 更新客户端拒收——
#    updates.xml 和 crx 必须在 Pages 上才是有效的安装/升级链路）
if command -v gh >/dev/null 2>&1 && gh auth token >/dev/null 2>&1; then
  echo "== 同步 Chrome 更新通道到 Pages =="
  TMP_GH=$(mktemp -d)
  cp "$OUT/updates.xml" "$TMP_GH/updates.xml"
  cp "$CRX" "$TMP_GH/crowd-extension-v$VER.crx"
  # codebase 指向 Pages 上的 crx
  sed -i '' "s|https://bdwrhshgdeghgyzwpxnl.supabase.co/storage/v1/object/public/crowd/crowd-extension-v$VER.crx|https://huming0018-dot.github.io/crowd-pages/crowd-extension-v$VER.crx|g" "$TMP_GH/updates.xml"
  GHT=$(gh auth token)
  for F in updates.xml "crowd-extension-v$VER.crx"; do
    SHA=$(curl -s -H "Authorization: token $GHT" "https://api.github.com/repos/huming0018-dot/crowd-pages/contents/$F" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sha',''))" 2>/dev/null)
    python3 - "$GHT" "$TMP_GH/$F" "$F" "$SHA" <<'PYEOF'
import json, sys, base64, urllib.request
token, fp, name, sha = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
content = base64.b64encode(open(fp,'rb').read()).decode()
body = {"message": "publish.sh 同步 v"+content[:0]+"更新通道", "content": content}
if sha: body["sha"] = sha
req = urllib.request.Request("https://api.github.com/repos/huming0018-dot/crowd-pages/contents/"+name,
    data=json.dumps(body).encode(), method="PUT",
    headers={"Authorization":"token "+token,"Content-Type":"application/json","Accept":"application/vnd.github+json"})
print("Pages 同步:", name, json.loads(urllib.request.urlopen(req).read())["commit"]["sha"][:8])
PYEOF
  done
  rm -rf "$TMP_GH"
else
  echo "⚠️ 未检测到 gh 登录：updates.xml/crx 未同步到 Pages（Chrome 安装通道不会更新）"
fi

echo "== 发布完成：v$VER 已上线，已装插件的参与者将在 Chrome 下次检查更新时自动升级" || { echo "❌ 部分上传失败"; exit 1; }
