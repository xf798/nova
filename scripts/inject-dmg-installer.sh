#!/usr/bin/env bash
# ===== 把「安装 Nova.command」注入已构建的 DMG =====
#
# tauri 产出的 DMG 只有 Nova.app 和 Applications 快捷方式。用户从网络下载后
# 双击 Nova.app 会被 Gatekeeper 以「已损坏」拒绝（缺 Developer ID 签名与公证）。
# 这里把安装脚本一并放进 DMG：用户右键打开脚本即可完成安装与解除隔离，
# 不必自己敲 xattr。
#
# 用法: scripts/inject-dmg-installer.sh <path-to.dmg>

set -euo pipefail

DMG="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALLER_SRC="$SCRIPT_DIR/dmg-install.command"
INSTALLER_NAME="安装 Nova.command"

die() { echo "❌ $*" >&2; exit 1; }
info() { echo "▶ $*"; }

[ -n "$DMG" ] || die "用法: $0 <path-to.dmg>"
[ -f "$DMG" ] || die "DMG 不存在: $DMG"
[ -f "$INSTALLER_SRC" ] || die "缺少安装脚本: $INSTALLER_SRC"

WORK="$(mktemp -d)"
MOUNT="$WORK/mnt"
RW_DMG="$WORK/rw.dmg"
mkdir -p "$MOUNT"

cleanup() {
  hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# 只读 DMG 不能写入，先转成可读写格式
info "转换为可写镜像"
hdiutil convert "$DMG" -format UDRW -o "$RW_DMG" -quiet

info "挂载"
hdiutil attach "$RW_DMG" -nobrowse -mountpoint "$MOUNT" -quiet

[ -d "$MOUNT/Nova.app" ] || die "DMG 内未找到 Nova.app"

info "写入 $INSTALLER_NAME"
cp "$INSTALLER_SRC" "$MOUNT/$INSTALLER_NAME"
# 必须可执行，否则双击不会被 Terminal 运行
chmod +x "$MOUNT/$INSTALLER_NAME"

info "卸载"
hdiutil detach "$MOUNT" -quiet
trap - EXIT

# 压缩回只读 DMG，覆盖原文件
info "压缩回只读镜像"
FINAL="$WORK/final.dmg"
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$FINAL" -quiet
mv "$FINAL" "$DMG"
rm -rf "$WORK"

echo "✅ 已注入安装脚本: $DMG"
