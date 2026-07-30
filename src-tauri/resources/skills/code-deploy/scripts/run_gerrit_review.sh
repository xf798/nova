#!/usr/bin/env bash
# Gerrit Review 入口脚本（独立版本）
# 自动管理 venv，不依赖其他 skill
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

# venv 路径：存放在 skill 自身目录下
VENV_PATH="${VENV_PATH:-$SKILL_ROOT/.venv}"
PY="$VENV_PATH/bin/python3"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$VENV_PATH/playwright-browsers}"

# 确保 venv 存在
if [ ! -x "$PY" ]; then
  echo "初始化 Python venv..." >&2
  python3 -m venv "$VENV_PATH"
  "$VENV_PATH/bin/pip" -q install --upgrade pip
  "$VENV_PATH/bin/pip" -q install playwright
  "$VENV_PATH/bin/playwright" install chromium
  echo "✅ 环境初始化完成" >&2
fi

# 确保 playwright 已安装
"$PY" -c "from playwright.sync_api import sync_playwright" 2>/dev/null || {
  echo "安装 playwright..." >&2
  "$VENV_PATH/bin/pip" -q install playwright
  "$VENV_PATH/bin/playwright" install chromium
}

exec "$PY" "$SCRIPT_DIR/gerrit_review.py" "$@"
