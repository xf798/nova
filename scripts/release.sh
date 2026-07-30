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

if [ "$DRY_RUN" -eq 0 ] && gh release view "$TAG" --repo "$RELEASE_REPO" >/dev/null 2>&1; then
  die "Release $TAG 已存在于 $RELEASE_REPO，请换版本号"
fi

# ── 3. 构建 ──
info "构建（bundles=app,dmg，含 updater 产物）"
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$SIGNING_KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# 注意：targets 必须显式指定，配成 "all" 时 tauri CLI 会跳过打包
node ./node_modules/.bin/tauri build --bundles app,dmg

# ── 4. 定位产物 ──
APP_TARGZ="$BUNDLE_DIR/macos/Nova.app.tar.gz"
APP_SIG="$BUNDLE_DIR/macos/Nova.app.tar.gz.sig"
DMG="$(ls "$BUNDLE_DIR"/dmg/*.dmg 2>/dev/null | head -1 || true)"

[ -f "$APP_TARGZ" ] || die "缺少 updater 产物: $APP_TARGZ（确认 tauri.conf.json 里 createUpdaterArtifacts=true）"
[ -f "$APP_SIG" ]   || die "缺少签名文件: $APP_SIG"
[ -n "$DMG" ]       || die "缺少 dmg 产物"

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

NOTES="$(git log -1 --pretty=%s)"
LATEST_JSON="$BUNDLE_DIR/latest.json"

info "生成 latest.json (platform=$PLATFORM)"
SIGNATURE="$(cat "$APP_SIG")" \
DL_URL="https://github.com/$RELEASE_REPO/releases/download/$TAG/$(basename "$APP_TARGZ")" \
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
echo "验证更新源可达（应返回 200 且是刚发布的版本）:"
echo "    curl -sL https://github.com/$RELEASE_REPO/releases/latest/download/latest.json | head -20"
