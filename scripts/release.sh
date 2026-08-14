#!/usr/bin/env bash
# ===== Nova 发布脚本 =====
#
# 流程：校验 → 构建（含 updater 产物）→ 生成 latest.json → 上传到 nova-releases 的 Release
#
# 用法:
#   scripts/release.sh              # 用 tauri.conf.json 里的当前版本发布
#   scripts/release.sh 0.1.1        # 先把版本号改成 0.1.1 再发布
#   scripts/release.sh --dry-run    # 只构建和生成 latest.json，不上传
#
# 前置条件:
#   - ~/.tauri/nova.key 存在（updater 签名私钥）
#   - gh CLI 已安装并登录（用于创建 Release 和上传资产）
#   - 公开仓库 xf798/nova-releases 已创建

set -euo pipefail

RELEASE_REPO="xf798/nova-releases"
SIGNING_KEY="$HOME/.tauri/nova.key"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CONF="$ROOT/src-tauri/tauri.conf.json"
BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle"

DRY_RUN=0
NEW_VERSION=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) echo "未知参数: $arg" >&2; exit 1 ;;
    *) NEW_VERSION="$arg" ;;
  esac
done

die() { echo "❌ $*" >&2; exit 1; }
info() { echo "▶ $*"; }

# ── 1. 前置校验 ──
info "校验前置条件"
[ -f "$SIGNING_KEY" ] || die "签名私钥不存在: $SIGNING_KEY（跑 tauri signer generate 生成）"
command -v node >/dev/null || die "未找到 node"

if [ "$DRY_RUN" -eq 0 ]; then
  command -v gh >/dev/null || die "未找到 gh CLI（brew install gh && gh auth login），或用 --dry-run 跳过上传"
  gh auth status >/dev/null 2>&1 || die "gh 未登录（gh auth login）"
fi

# 工作区必须干净，避免发布出未提交的代码
if [ -n "$(git status --porcelain)" ]; then
  die "工作区有未提交改动，请先提交或暂存"
fi

# 四处版本号必须一致。
#
# release.sh 只改 tauri.conf.json，其余三处靠手工同步，实际漏过：
# 0.1.5 和 0.1.6 两次发版 Cargo.toml 都停在 0.1.4，直到 0.1.7 才发现。
# tauri.conf.json 是 updater 的比较依据，不一致会让版本判断与实际不符。
check_versions() {
  local conf pkg cargo lock
  conf="$(node -e "console.log(require('$CONF').version)")"
  pkg="$(node -e "console.log(require('$ROOT/package.json').version)")"
  cargo="$(grep -m1 '^version' "$ROOT/src-tauri/Cargo.toml" | sed 's/.*"\(.*\)".*/\1/')"
  lock="$(node -e "
    const s=require('fs').readFileSync('$ROOT/src-tauri/Cargo.lock','utf8');
    const m=s.match(/name = \"nova\"\nversion = \"([^\"]+)\"/);
    console.log(m ? m[1] : 'NOT_FOUND');
  ")"
  if [ "$conf" != "$pkg" ] || [ "$conf" != "$cargo" ] || [ "$conf" != "$lock" ]; then
    die "版本号不一致：tauri.conf=$conf package.json=$pkg Cargo.toml=$cargo Cargo.lock=$lock"
  fi
  info "版本号四处一致: $conf"
}

# ── 2. 版本号 ──
if [ -n "$NEW_VERSION" ]; then
  echo "$NEW_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || die "版本号必须是 semver（如 0.1.1），收到: $NEW_VERSION"
  info "写入版本号 $NEW_VERSION"
  node -e "
    const fs=require('fs'),p='$CONF';
    const j=JSON.parse(fs.readFileSync(p,'utf8'));
    j.version='$NEW_VERSION';
    fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
  "
fi

VERSION="$(node -e "console.log(require('$CONF').version)")"
[ -n "$VERSION" ] || die "无法从 tauri.conf.json 读取版本号"
TAG="v$VERSION"
info "发布版本: $VERSION (tag=$TAG)"

# 版本号写定后校验四处一致（NEW_VERSION 只改了 tauri.conf.json）
check_versions

if [ "$DRY_RUN" -eq 0 ] && gh release view "$TAG" --repo "$RELEASE_REPO" >/dev/null 2>&1; then
  die "Release $TAG 已存在于 $RELEASE_REPO，请换版本号"
fi

# ── 3. 构建 ──
info "构建（bundles=app,dmg，含 updater 产物）"
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$SIGNING_KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# 注意：targets 必须显式指定，配成 "all" 时 tauri CLI 会跳过打包
#
# CI=true 让 tauri 给 bundle_dmg.sh 传 --skip-jenkins，跳过用 Finder
# 美化 DMG 窗口的那段 AppleScript。那一步依赖「发送 Apple 事件给 Finder」
# 的自动化授权，而每次终端宿主程序更新（如 kiro-cli 自更新）授权就会失效，
# 报 -1743 让整个打包失败。窗口摆放是纯观感，不值得为它卡住发版。
CI=true node ./node_modules/.bin/tauri build --bundles app,dmg

# ── 4. 定位产物 ──
APP_TARGZ="$BUNDLE_DIR/macos/Nova.app.tar.gz"
APP_SIG="$BUNDLE_DIR/macos/Nova.app.tar.gz.sig"
DMG="$(ls "$BUNDLE_DIR"/dmg/*.dmg 2>/dev/null | head -1 || true)"

[ -f "$APP_TARGZ" ] || die "缺少 updater 产物: $APP_TARGZ（确认 tauri.conf.json 里 createUpdaterArtifacts=true）"
[ -f "$APP_SIG" ]   || die "缺少签名文件: $APP_SIG"
[ -n "$DMG" ]       || die "缺少 dmg 产物"

# Nova 没有 Apple Developer ID 签名与公证，下载后双击会被 Gatekeeper 判为
# 「已损坏」。往 DMG 里放一个安装脚本，用户右键打开即可完成安装与解除隔离。
info "向 DMG 注入安装脚本"
"$ROOT/scripts/inject-dmg-installer.sh" "$DMG"

info "产物:"
echo "    $(basename "$APP_TARGZ")  $(du -h "$APP_TARGZ" | cut -f1)"
echo "    $(basename "$APP_SIG")"
echo "    $(basename "$DMG")  $(du -h "$DMG" | cut -f1)"

# ── 5. 生成 latest.json ──
# platform key 规则: {darwin|windows|linux}-{x86_64|aarch64}
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) PLATFORM="darwin-aarch64" ;;
  x86_64)        PLATFORM="darwin-x86_64" ;;
  *) die "未知架构: $ARCH" ;;
esac

# 更新说明。
#
# 原先取 git log -1，但最后一次提交必然是「版本升级到 x.y.z」，
# 0.1.9 就把这句话发成了更新弹窗的正文。改为跳过版本升级提交，
# 需要完整说明时用 NOTES 环境变量覆盖：
#   NOTES="$(cat notes.md)" scripts/release.sh
NOTES="${NOTES:-$(git log -20 --pretty=%s | grep -v -E '^chore: 版本升级' | head -1)}"
LATEST_JSON="$BUNDLE_DIR/latest.json"

info "生成 latest.json (platform=$PLATFORM)"
# 下载地址走加速代理。
#
# GitHub 直连实测只有 21KB/s（自己的仓库也一样，是整体带宽问题），
# 10MB 的更新包要下 8 分钟；经 gh-proxy 实测 4.6MB/s，几秒完成。
# 代理下载的文件 sha256 与官方完全一致，且 updater 本身会用 minisign
# 验签，代理只是传输通道，被篡改也过不了验签。
GH_URL="https://github.com/$RELEASE_REPO/releases/download/$TAG/$(basename "$APP_TARGZ")"
SIGNATURE="$(cat "$APP_SIG")" \
DL_URL="https://gh-proxy.com/$GH_URL" \
NOTES="$NOTES" \
node -e "
  const fs=require('fs');
  const out={
    version: '$VERSION',
    notes: process.env.NOTES || '',
    pub_date: new Date().toISOString(),
    platforms: {
      '$PLATFORM': {
        signature: process.env.SIGNATURE.trim(),
        url: process.env.DL_URL,
      },
    },
  };
  fs.writeFileSync('$LATEST_JSON', JSON.stringify(out,null,2)+'\n');
"

echo "--- latest.json ---"
cat "$LATEST_JSON"
echo "-------------------"

if [ "$DRY_RUN" -eq 1 ]; then
  info "--dry-run：跳过上传。产物在 $BUNDLE_DIR"
  exit 0
fi

# ── 6. 上传 ──
info "创建 Release $TAG 并上传资产到 $RELEASE_REPO"
gh release create "$TAG" \
  --repo "$RELEASE_REPO" \
  --title "Nova $TAG" \
  --notes "$NOTES" \
  "$APP_TARGZ" "$APP_SIG" "$DMG" "$LATEST_JSON"

info "✅ 发布完成"
echo "    Release : https://github.com/$RELEASE_REPO/releases/tag/$TAG"
echo "    更新源  : https://github.com/$RELEASE_REPO/releases/latest/download/latest.json"
echo

# 自动验证 latest 别名指向本次发布。
#
# 曾因为往 nova-releases 传了个非版本 release（models-v1）而抢占 latest 别名，
# 导致所有客户端更新检查 404。这里主动确认一次，避免同类问题静默发生。
# CDN 有缓存，给它一点时间。
info "验证更新源"
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 6
  GOT="$(curl -sL -m 20 "https://github.com/$RELEASE_REPO/releases/latest/download/latest.json" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).version)}catch(e){console.log('')}})" 2>/dev/null)"
  if [ "$GOT" = "$VERSION" ]; then
    info "更新源已指向 $VERSION"
    break
  fi
  [ "$i" -eq 10 ] && echo "  ⚠ 更新源仍未指向 $VERSION（当前: ${GOT:-无法读取}）。若仓库里有非版本 release，需把它标为 prerelease。"
done
