#!/bin/bash
# Nova System Control Script for macOS
# Usage: bash sysctl.sh <command> [subcommand] [args...]

set +e

COMMAND="${1:-help}"
SUBCMD="${2:-}"
ARG="${3:-}"

# --- Helper Functions ---

check_dep() {
  local cmd="$1"
  local install_hint="$2"
  if ! command -v "$cmd" &>/dev/null; then
    echo "❌ 依赖缺失: $cmd"
    echo "   安装方式: $install_hint"
    exit 1
  fi
}

# 检测 System Events 辅助功能权限，权限不足时给出明确提示
check_accessibility() {
  local test_result
  test_result=$(osascript -e 'tell application "System Events" to return name of first process whose frontmost is true' 2>&1)
  if echo "$test_result" | grep -q "未获得授权\|Not authorized\|-1743"; then
    echo "⚠️  需要辅助功能权限（Accessibility）"
    echo ""
    echo "   请前往: 系统设置 → 隐私与安全性 → 辅助功能"
    echo "   将当前终端应用或 Nova.app 添加并开启权限"
    echo ""
    echo "   快捷打开设置面板:"
    echo "   open \"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility\""
    return 1
  fi
  return 0
}

get_wifi_device() {
  networksetup -listallhardwareports | awk '/Wi-Fi/{getline; print $2}'
}

# --- Commands ---

cmd_lock() {
  # 优先使用 CGSession（不需要辅助功能权限）
  if command -v "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession" &>/dev/null; then
    "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession" -suspend
  else
    # Fallback: 关闭显示器触发锁屏
    pmset displaysleepnow
  fi
  echo "✅ 已锁屏"
}

cmd_sleep() {
  pmset sleepnow
  echo "✅ 系统进入睡眠"
}

cmd_screen_off() {
  pmset displaysleepnow
  echo "✅ 显示器已关闭"
}

cmd_volume() {
  case "$SUBCMD" in
    get)
      vol=$(osascript -e 'output volume of (get volume settings)')
      muted=$(osascript -e 'output muted of (get volume settings)')
      echo "🔊 当前音量: ${vol}%"
      if [ "$muted" = "true" ]; then
        echo "🔇 状态: 已静音"
      fi
      ;;
    set)
      if [ -z "$ARG" ] || [ "$ARG" -lt 0 ] 2>/dev/null || [ "$ARG" -gt 100 ] 2>/dev/null; then
        echo "❌ 请提供 0-100 的音量值"
        exit 1
      fi
      osascript -e "set volume output volume $ARG"
      echo "✅ 音量已设置为 ${ARG}%"
      ;;
    mute)
      osascript -e 'set volume output muted true'
      echo "✅ 已静音"
      ;;
    unmute)
      osascript -e 'set volume output muted false'
      echo "✅ 已取消静音"
      ;;
    *)
      echo "用法: sysctl.sh volume [get|set <0-100>|mute|unmute]"
      exit 1
      ;;
  esac
}

cmd_brightness() {
  case "$SUBCMD" in
    get)
      check_dep "brightness" "brew install brightness"
      val=$(brightness -l 2>/dev/null | grep -o 'brightness [0-9.]*' | head -1 | awk '{printf "%.0f", $2 * 100}')
      echo "🔆 当前亮度: ${val}%"
      ;;
    set)
      check_dep "brightness" "brew install brightness"
      if [ -z "$ARG" ] || [ "$ARG" -lt 0 ] 2>/dev/null || [ "$ARG" -gt 100 ] 2>/dev/null; then
        echo "❌ 请提供 0-100 的亮度值"
        exit 1
      fi
      # Convert 0-100 to 0.0-1.0
      float_val=$(echo "scale=2; $ARG / 100" | bc)
      brightness "$float_val"
      echo "✅ 亮度已设置为 ${ARG}%"
      ;;
    *)
      echo "用法: sysctl.sh brightness [get|set <0-100>]"
      exit 1
      ;;
  esac
}

cmd_dnd() {
  if ! check_accessibility; then
    exit 1
  fi
  case "$SUBCMD" in
    on)
      # macOS Monterey+ uses Focus system
      defaults write com.apple.controlcenter "NSStatusItem Visible FocusModes" -bool true
      osascript -e '
        tell application "System Events"
          tell process "ControlCenter"
            -- Open Control Center
            click menu bar item "Control Center" of menu bar 1
            delay 0.5
            -- Click Focus/DND
            try
              click button "Focus" of group 1 of window "Control Center"
            on error
              click button "专注模式" of group 1 of window "Control Center"
            end try
            delay 0.3
            -- Click Do Not Disturb
            try
              click checkbox "Do Not Disturb" of scroll area 1 of window "Control Center"
            on error
              click checkbox "勿扰模式" of scroll area 1 of window "Control Center"
            end try
            delay 0.2
            -- Close Control Center
            key code 53
          end tell
        end tell
      ' 2>/dev/null
      echo "✅ 勿扰模式已开启"
      ;;
    off)
      osascript -e '
        tell application "System Events"
          tell process "ControlCenter"
            click menu bar item "Control Center" of menu bar 1
            delay 0.5
            try
              click button "Focus" of group 1 of window "Control Center"
            on error
              click button "专注模式" of group 1 of window "Control Center"
            end try
            delay 0.3
            try
              click checkbox "Do Not Disturb" of scroll area 1 of window "Control Center"
            on error
              click checkbox "勿扰模式" of scroll area 1 of window "Control Center"
            end try
            delay 0.2
            key code 53
          end tell
        end tell
      ' 2>/dev/null
      echo "✅ 勿扰模式已关闭"
      ;;
    *)
      echo "用法: sysctl.sh dnd [on|off]"
      exit 1
      ;;
  esac
}

cmd_app() {
  case "$SUBCMD" in
    open)
      if [ -z "$ARG" ]; then
        echo "❌ 请指定应用名称"
        exit 1
      fi
      open -a "$ARG" 2>/dev/null
      if [ $? -eq 0 ]; then
        echo "✅ 已打开 $ARG"
      else
        echo "❌ 无法打开 $ARG，请检查应用名称"
        exit 1
      fi
      ;;
    quit)
      if [ -z "$ARG" ]; then
        echo "❌ 请指定应用名称"
        exit 1
      fi
      # osascript quit 不需要 System Events 权限，直接 tell app to quit
      local quit_result
      quit_result=$(osascript -e "tell application \"$ARG\" to quit" 2>&1)
      if echo "$quit_result" | grep -q "未获得授权\|Not authorized\|-1743"; then
        # Fallback: 使用 pkill
        pkill -x "$ARG" 2>/dev/null && echo "✅ 已退出 $ARG (通过 pkill)" || echo "❌ 无法退出 $ARG"
      else
        echo "✅ 已退出 $ARG"
      fi
      ;;
    list)
      echo "📋 正在运行的应用:"
      local app_list
      app_list=$(osascript -e '
        tell application "System Events"
          set appList to name of every process whose background only is false
        end tell
        set output to ""
        repeat with appName in appList
          set output to output & "  • " & appName & linefeed
        end repeat
        return output
      ' 2>&1)
      if echo "$app_list" | grep -q "未获得授权\|Not authorized\|-1743"; then
        # Fallback: 从进程列表中提取 .app 应用
        LANG=en_US.UTF-8 ps aux | grep -oE '/Applications/[^/]+\.app' | sort -u | while read -r line; do
          app=$(basename "$line" .app)
          [ -n "$app" ] && echo "  • $app"
        done
      elif [ -n "$app_list" ]; then
        echo "$app_list"
      else
        LANG=en_US.UTF-8 ps aux | grep -oE '/Applications/[^/]+\.app' | sort -u | while read -r line; do
          app=$(basename "$line" .app)
          [ -n "$app" ] && echo "  • $app"
        done
      fi
      ;;
    *)
      echo "用法: sysctl.sh app [open|quit|list] [app_name]"
      exit 1
      ;;
  esac
}

cmd_wifi() {
  local device
  device=$(get_wifi_device)
  if [ -z "$device" ]; then
    echo "❌ 未找到 Wi-Fi 设备"
    exit 1
  fi

  case "$SUBCMD" in
    status)
      local power
      power=$(networksetup -getairportpower "$device" | awk '{print $NF}')
      if [ "$power" = "On" ]; then
        local network
        network=$(networksetup -getairportnetwork "$device" 2>/dev/null | sed 's/Current Wi-Fi Network: //')
        echo "📶 WiFi: 已开启"
        if echo "$network" | grep -q "not associated"; then
          echo "   当前网络: 未连接"
        else
          echo "   当前网络: $network"
        fi
      else
        echo "📶 WiFi: 已关闭"
      fi
      ;;
    on)
      networksetup -setairportpower "$device" on
      echo "✅ WiFi 已开启"
      ;;
    off)
      networksetup -setairportpower "$device" off
      echo "✅ WiFi 已关闭"
      ;;
    *)
      echo "用法: sysctl.sh wifi [status|on|off]"
      exit 1
      ;;
  esac
}

cmd_bluetooth() {
  case "$SUBCMD" in
    status)
      check_dep "blueutil" "brew install blueutil"
      local power
      power=$(blueutil -p)
      if [ "$power" = "1" ]; then
        echo "🔵 蓝牙: 已开启"
        echo "   已连接设备:"
        blueutil --connected --format json 2>/dev/null | python3 -c "
import sys, json
try:
    devices = json.load(sys.stdin)
    for d in devices:
        print(f\"  • {d.get('name', '未知设备')} ({d.get('address', '')})\")
    if not devices:
        print('  （无已连接设备）')
except:
    print('  （无法获取设备列表）')
" 2>/dev/null || echo "  （无法获取设备列表）"
      else
        echo "🔵 蓝牙: 已关闭"
      fi
      ;;
    on)
      check_dep "blueutil" "brew install blueutil"
      blueutil -p 1
      echo "✅ 蓝牙已开启"
      ;;
    off)
      check_dep "blueutil" "brew install blueutil"
      blueutil -p 0
      echo "✅ 蓝牙已关闭"
      ;;
    *)
      echo "用法: sysctl.sh bluetooth [status|on|off]"
      exit 1
      ;;
  esac
}

cmd_info() {
  echo "📊 系统信息"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # macOS version
  echo ""
  echo "🖥  系统: $(sw_vers -productName) $(sw_vers -productVersion) ($(uname -m))"

  # CPU
  echo ""
  echo "⚙️  CPU: $(sysctl -n machdep.cpu.brand_string)"
  local cpu_usage
  cpu_usage=$(ps -A -o %cpu | awk '{s+=$1} END {printf "%.1f", s}')
  echo "   使用率: ${cpu_usage}%"

  # Memory
  echo ""
  local mem_total
  mem_total=$(sysctl -n hw.memsize | awk '{printf "%.1f", $1/1073741824}')
  local mem_used
  mem_used=$(memory_pressure 2>/dev/null | grep "System-wide memory free percentage" | awk '{printf "%.1f", 100-$NF}' 2>/dev/null || echo "N/A")
  echo "🧠 内存: ${mem_total} GB 总计, 已用 ${mem_used}%"

  # Disk
  echo ""
  local disk_info
  disk_info=$(df -H / | tail -1 | awk '{print "总计 "$2", 已用 "$3" ("$5")"}')
  echo "💾 磁盘: $disk_info"

  # Battery
  echo ""
  local battery
  battery=$(pmset -g batt 2>/dev/null | grep -o '[0-9]*%' | head -1)
  local charging
  charging=$(pmset -g batt 2>/dev/null | grep -o "'.*'" | head -1)
  if [ -n "$battery" ]; then
    local power_source
    power_source=$(pmset -g batt | head -1 | grep -o "'.*'" | tr -d "'")
    echo "🔋 电池: ${battery} (${power_source:-未知})"
  else
    echo "🔋 电池: 未检测到电池（台式机）"
  fi

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

cmd_help() {
  echo "Nova System Control (macOS)"
  echo ""
  echo "用法: sysctl.sh <command> [subcommand] [args]"
  echo ""
  echo "命令:"
  echo "  lock              锁屏"
  echo "  sleep             系统睡眠"
  echo "  screen-off        关闭显示器"
  echo "  volume            音量控制 [get|set|mute|unmute]"
  echo "  brightness        亮度控制 [get|set]"
  echo "  dnd               勿扰模式 [on|off]"
  echo "  app               应用管理 [open|quit|list]"
  echo "  wifi              WiFi 控制 [status|on|off]"
  echo "  bluetooth         蓝牙控制 [status|on|off]"
  echo "  info              系统信息概览"
  echo "  help              显示帮助"
}

# --- Main Router ---

case "$COMMAND" in
  lock)       cmd_lock ;;
  sleep)      cmd_sleep ;;
  screen-off) cmd_screen_off ;;
  volume)     cmd_volume ;;
  brightness) cmd_brightness ;;
  dnd)        cmd_dnd ;;
  app)        cmd_app ;;
  wifi)       cmd_wifi ;;
  bluetooth)  cmd_bluetooth ;;
  info)       cmd_info ;;
  help|--help|-h) cmd_help ;;
  *)
    echo "❌ 未知命令: $COMMAND"
    echo ""
    cmd_help
    exit 1
    ;;
esac
