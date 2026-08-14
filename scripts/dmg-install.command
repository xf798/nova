#!/bin/bash
# ===== Nova 安装脚本（放在 DMG 内，供用户双击运行）=====
#
# 为什么需要它：Nova 没有 Apple Developer ID 签名和公证，从网络下载的应用
# 会被打上 com.apple.quarantine，Gatekeeper 随即以「已损坏」为由拒绝启动。
# 实际文件没有问题，只是缺少可信签名。这个脚本把安装和解除隔离一并做掉，
# 用户不需要自己敲 xattr 命令。
#
# 脚本自身也带 quarantine，首次需要「右键 → 打开」才能运行。

set -u

APP_NAME="Nova.app"
TARGET_DIR="/Applications"
TARGET="$TARGET_DIR/$APP_NAME"
# 脚本与 Nova.app 同在 DMG 根目录
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SRC_DIR/$APP_NAME"

echo "=============================="
echo "  Nova 安装程序"
echo "=============================="
echo

fail() {
  echo
  echo "❌ $*"
  echo
  echo "按回车键关闭窗口"
  read -r _ || true
  exit 1
}

[ -d "$SRC" ] || fail "未在 $SRC_DIR 找到 $APP_NAME，请确认已挂载 Nova 的 DMG 并从其中运行本脚本。"

# 正在运行的旧实例会占用文件，先退出
if pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
  echo "▶ 检测到 Nova 正在运行，先退出旧版本"
  osascript -e 'quit app "Nova"' >/dev/null 2>&1 || true
  sleep 2
  pkill -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1 || true
  sleep 1
fi

if [ -d "$TARGET" ]; then
  echo "▶ 移除已安装的旧版本"
  rm -rf "$TARGET" || fail "无法删除 $TARGET，请手动将其移到废纸篓后重试。"
fi

echo "▶ 安装到 $TARGET_DIR"
# 用 ditto 而不是 cp：它会完整保留 bundle 结构、符号链接和扩展属性
ditto "$SRC" "$TARGET" || fail "拷贝失败。若提示权限不足，请确认对 $TARGET_DIR 有写入权限。"

echo "▶ 解除下载隔离标记"
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

# 校验隔离标记确实已清除，避免「装完仍提示已损坏」
if xattr -pr com.apple.quarantine "$TARGET" >/dev/null 2>&1; then
  echo "  ⚠ 隔离标记未完全清除，尝试再执行一次"
  xattr -cr "$TARGET" 2>/dev/null || true
fi

# 重建 ad-hoc 签名。
#
# Tauri 产出的 app 由链接器 ad-hoc 签名，签名声明包含资源但 _CodeSignature
# 并不完整，拷贝到 /Applications 后 codesign 校验失败，内核的 AppleSystemPolicy
# 会直接拒绝启动（日志: ASP: Security policy would not allow process）。
# 表现和「已损坏」是同一类问题，只清 quarantine 不够，必须重新签一次。
echo "▶ 修复应用签名"
codesign --force --deep --sign - "$TARGET" >/dev/null 2>&1 \
  || echo "  ⚠ 重签名失败，若启动被拒请安装 Xcode Command Line Tools 后重试"

if ! codesign --verify --deep "$TARGET" >/dev/null 2>&1; then
  echo "  ⚠ 签名校验仍未通过，应用可能无法启动"
fi

echo "▶ 启动 Nova"
open "$TARGET" 2>/dev/null || true
sleep 4

if pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
  echo
  echo "✅ 安装完成，Nova 已启动。"
  echo "   以后直接从「应用程序」或启动台打开即可，无需再运行本脚本。"
else
  # macOS 15 起，未经 Apple 公证的应用即使清除了隔离标记，首次通过双击启动
  # 仍会被 Gatekeeper 拦下，必须由用户在系统设置里显式放行一次。
  # 这一步只能在图形界面完成，脚本无法代替。
  echo
  echo "⚠️  应用已安装，但系统拦下了首次启动。请放行一次（只需做一次）："
  echo
  echo "   1. 打开「系统设置」→「隐私与安全性」"
  echo "   2. 向下滚动，找到关于 Nova 被阻止的提示"
  echo "   3. 点击「仍要打开」，并在弹窗中再次确认"
  echo
  echo "   正在为你打开该设置页面…"
  open "x-apple.systempreferences:com.apple.preference.security?Privacy" 2>/dev/null || true
  echo
  echo "   放行后，从「应用程序」双击 Nova 即可正常使用。"
fi
echo
echo "按回车键关闭窗口"
read -r _ || true
