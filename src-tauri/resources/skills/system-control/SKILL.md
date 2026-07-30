---
name: system-control
description: macOS 系统控制技能。当用户提到"锁屏"、"睡眠"、"休眠"、"关屏"、"音量"、"声音"、"调大"、"调小"、"静音"、"取消静音"、"亮度"、"调亮"、"调暗"、"勿扰"、"免打扰"、"打开应用"、"关闭应用"、"退出应用"、"WiFi"、"蓝牙"、"系统信息"、"电池"、"lock"、"sleep"、"volume"、"brightness"、"mute"、"DND"、"do not disturb"、"open app"、"quit app"时触发。
metadata:
  requires:
    bins: ["bash", "osascript"]
---

# macOS 系统控制

通过 bash 脚本调用 macOS 原生命令（osascript / pmset / networksetup 等）实现系统级操作控制。

## 工具路径

```
~/.nova/skills/system-control/scripts/sysctl.sh
```

## 使用方式

通过 bash 执行脚本，结果直接输出到会话。**所有系统控制操作必须通过执行该脚本完成**。

---

## 命令参考

### 电源控制

```bash
# 锁屏
bash ~/.nova/skills/system-control/scripts/sysctl.sh lock

# 系统睡眠
bash ~/.nova/skills/system-control/scripts/sysctl.sh sleep

# 仅关闭显示器
bash ~/.nova/skills/system-control/scripts/sysctl.sh screen-off
```

### 音量控制

```bash
# 获取当前音量（输出 0-100）
bash ~/.nova/skills/system-control/scripts/sysctl.sh volume get

# 设置音量（0-100）
bash ~/.nova/skills/system-control/scripts/sysctl.sh volume set 50

# 静音
bash ~/.nova/skills/system-control/scripts/sysctl.sh volume mute

# 取消静音
bash ~/.nova/skills/system-control/scripts/sysctl.sh volume unmute
```

### 亮度控制

```bash
# 获取当前亮度（输出 0-100）
bash ~/.nova/skills/system-control/scripts/sysctl.sh brightness get

# 设置亮度（0-100）
bash ~/.nova/skills/system-control/scripts/sysctl.sh brightness set 70
```

> 注意：亮度控制依赖 `brightness` CLI 工具，若未安装会提示 `brew install brightness`。

### 勿扰模式

```bash
# 开启勿扰
bash ~/.nova/skills/system-control/scripts/sysctl.sh dnd on

# 关闭勿扰
bash ~/.nova/skills/system-control/scripts/sysctl.sh dnd off
```

### 应用管理

```bash
# 打开应用
bash ~/.nova/skills/system-control/scripts/sysctl.sh app open "Safari"

# 退出应用
bash ~/.nova/skills/system-control/scripts/sysctl.sh app quit "Safari"

# 列出正在运行的应用
bash ~/.nova/skills/system-control/scripts/sysctl.sh app list
```

### WiFi 控制

```bash
# 查看 WiFi 状态
bash ~/.nova/skills/system-control/scripts/sysctl.sh wifi status

# 开启 WiFi
bash ~/.nova/skills/system-control/scripts/sysctl.sh wifi on

# 关闭 WiFi
bash ~/.nova/skills/system-control/scripts/sysctl.sh wifi off
```

### 蓝牙控制

```bash
# 查看蓝牙状态
bash ~/.nova/skills/system-control/scripts/sysctl.sh bluetooth status

# 开启蓝牙
bash ~/.nova/skills/system-control/scripts/sysctl.sh bluetooth on

# 关闭蓝牙
bash ~/.nova/skills/system-control/scripts/sysctl.sh bluetooth off
```

> 注意：蓝牙控制依赖 `blueutil` CLI 工具，若未安装会提示 `brew install blueutil`。

### 系统信息

```bash
# 获取系统概况（CPU、内存、磁盘、电池）
bash ~/.nova/skills/system-control/scripts/sysctl.sh info
```

---

## 行为规则

1. lock / sleep / screen-off → 直接执行，无需确认
2. volume / brightness → 直接执行，执行后报告当前值
3. dnd on/off → 直接执行
4. app open → 直接执行
5. app quit → **需要用户确认**后再执行（可能导致未保存工作丢失）
6. wifi off / bluetooth off → **需要用户确认**后再执行（可能断开当前连接）
7. 用户说"声音大一点"/"小一点" → 先 `volume get` 获取当前值，再 ±10 调整
8. 用户说"亮一点"/"暗一点" → 先 `brightness get` 获取当前值，再 ±10 调整
9. 不支持 shutdown / restart 等高危操作，若用户要求则明确拒绝并说明原因

---

## 依赖说明

| 工具 | 用途 | 安装方式 |
|------|------|----------|
| osascript | 音量、应用控制、勿扰 | macOS 内置 |
| pmset | 睡眠/关屏 | macOS 内置 |
| networksetup | WiFi 控制 | macOS 内置 |
| brightness | 屏幕亮度 | `brew install brightness` |
| blueutil | 蓝牙控制 | `brew install blueutil` |

脚本会在运行时检测可选依赖是否存在，缺失时给出安装提示而非报错。
