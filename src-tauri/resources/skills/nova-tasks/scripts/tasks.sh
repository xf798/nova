#!/usr/bin/env bash
# Nova Tasks CLI - 本地任务管理工具
# 数据存储: ~/.nova/app-storage.json (与 Nova 客户端共享)
#
# app-storage.json 结构:
# {
#   "task": {
#     "tasks": [ ... ]
#   },
#   ...其他命名空间
# }

set -euo pipefail

STORAGE_FILE="$HOME/.nova/app-storage.json"

# 确保数据文件存在
init_storage() {
  if [ ! -f "$STORAGE_FILE" ]; then
    echo '{"task":{"tasks":[]}}' > "$STORAGE_FILE"
  fi
}

# 列出任务
cmd_list() {
  local filter="${1:-all}"
  init_storage

  python3 << PYTHON
import json, sys

with open('$STORAGE_FILE', 'r') as f:
    data = json.load(f)

tasks = data.get('task', {}).get('tasks', [])
filter_type = '$filter'

if filter_type == 'active':
    tasks = [t for t in tasks if t.get('status') != 'completed']
elif filter_type == 'completed':
    tasks = [t for t in tasks if t.get('status') == 'completed']

if not tasks:
    print('当前没有任务。')
    sys.exit(0)

# 按优先级排序: high > medium > low
priority_order = {'high': 0, 'medium': 1, 'low': 2}
tasks.sort(key=lambda t: priority_order.get(t.get('priority', 'medium'), 1))

print(f'共 {len(tasks)} 条任务：')
print()
for t in tasks:
    status_icon = {'pending': '⏳', 'in_progress': '🔄', 'completed': '✅'}.get(t.get('status', 'pending'), '⏳')
    priority_icon = {'high': '🔴', 'medium': '🟡', 'low': '🟢'}.get(t.get('priority', 'medium'), '🟡')
    due = f" | 截止: {t['dueDate']}" if t.get('dueDate') else ''
    desc = f"\n     描述: {t['description']}" if t.get('description') else ''
    print(f"{status_icon} {priority_icon} [{t['id']}] {t['title']}{due}{desc}")
    print()
PYTHON
}

# 创建任务
cmd_create() {
  init_storage
  local title="" priority="medium" description="" start_date="" due_date=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title) title="$2"; shift 2 ;;
      --priority) priority="$2"; shift 2 ;;
      --description) description="$2"; shift 2 ;;
      --start-date) start_date="$2"; shift 2 ;;
      --due-date) due_date="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [ -z "$title" ]; then
    echo "错误: 必须提供 --title 参数"
    exit 1
  fi

  [ -z "$start_date" ] && start_date=$(date +%Y-%m-%d)

  python3 << PYTHON
import json, time, random, string
from datetime import datetime, timezone

with open('$STORAGE_FILE', 'r') as f:
    data = json.load(f)

if 'task' not in data:
    data['task'] = {}
if 'tasks' not in data['task']:
    data['task']['tasks'] = []

# 生成与 Nova 客户端一致的 ID 格式: task-{timestamp}-{random4}
ts = int(time.time() * 1000)
rand = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
task_id = f"task-{ts}-{rand}"

now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f"{ts % 1000:03d}Z"

task = {
    'id': task_id,
    'title': """$title""",
    'status': 'pending',
    'priority': '$priority',
    'startDate': '$start_date',
    'createdAt': now,
    'updatedAt': now,
}

due_date = '$due_date'
if due_date:
    task['dueDate'] = due_date

description = """$description"""
if description:
    task['description'] = description

# 插入到列表头部（与 Nova 客户端 unshift 行为一致）
data['task']['tasks'].insert(0, task)

with open('$STORAGE_FILE', 'w') as f:
    json.dump(data, f, ensure_ascii=False)

print(f"✅ 任务已创建: [{task_id}] $title")
PYTHON
}

# 更新任务内容
cmd_update() {
  init_storage
  local task_id="" title="" priority="" description="" start_date="" due_date=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) task_id="$2"; shift 2 ;;
      --title) title="$2"; shift 2 ;;
      --priority) priority="$2"; shift 2 ;;
      --description) description="$2"; shift 2 ;;
      --start-date) start_date="$2"; shift 2 ;;
      --due-date) due_date="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [ -z "$task_id" ]; then
    echo "错误: 必须提供 --id 参数"
    exit 1
  fi

  python3 << PYTHON
import json, sys
from datetime import datetime, timezone

with open('$STORAGE_FILE', 'r') as f:
    data = json.load(f)

task_id = '$task_id'
found = False
for task in data.get('task', {}).get('tasks', []):
    if task['id'] == task_id:
        found = True
        title = """$title"""
        priority = '$priority'
        description = """$description"""
        start_date = '$start_date'
        due_date = '$due_date'

        if title: task['title'] = title
        if priority: task['priority'] = priority
        if description: task['description'] = description
        if start_date: task['startDate'] = start_date
        if due_date: task['dueDate'] = due_date
        task['updatedAt'] = datetime.now(timezone.utc).isoformat()
        break

if not found:
    print(f'错误: 找不到任务 {task_id}')
    sys.exit(1)

with open('$STORAGE_FILE', 'w') as f:
    json.dump(data, f, ensure_ascii=False)

print(f"✅ 任务已更新: [{task_id}] {task['title']}")
PYTHON
}

# 更新任务状态
cmd_status() {
  init_storage
  local task_id="" status=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) task_id="$2"; shift 2 ;;
      --status) status="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [ -z "$task_id" ] || [ -z "$status" ]; then
    echo "错误: 必须提供 --id 和 --status 参数"
    exit 1
  fi

  python3 << PYTHON
import json, sys
from datetime import datetime, timezone

with open('$STORAGE_FILE', 'r') as f:
    data = json.load(f)

task_id = '$task_id'
status = '$status'
valid_statuses = ['pending', 'in_progress', 'completed']

if status not in valid_statuses:
    print(f'错误: 无效状态 "{status}"，有效值: {", ".join(valid_statuses)}')
    sys.exit(1)

found = False
for task in data.get('task', {}).get('tasks', []):
    if task['id'] == task_id:
        found = True
        task['status'] = status
        task['updatedAt'] = datetime.now(timezone.utc).isoformat()
        if status == 'completed':
            task['completedAt'] = datetime.now(timezone.utc).isoformat()
        else:
            task.pop('completedAt', None)
        break

if not found:
    print(f'错误: 找不到任务 {task_id}')
    sys.exit(1)

with open('$STORAGE_FILE', 'w') as f:
    json.dump(data, f, ensure_ascii=False)

status_label = {'pending': '待处理', 'in_progress': '进行中', 'completed': '已完成'}[status]
print(f"✅ 任务状态已更新: [{task_id}] {task['title']} → {status_label}")
PYTHON
}

# 删除任务
cmd_delete() {
  init_storage
  local task_id="" title=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id) task_id="$2"; shift 2 ;;
      --title) title="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [ -z "$task_id" ] && [ -z "$title" ]; then
    echo "错误: 必须提供 --id 或 --title 参数"
    exit 1
  fi

  python3 << PYTHON
import json, sys

with open('$STORAGE_FILE', 'r') as f:
    data = json.load(f)

task_id = '$task_id'
title_search = """$title"""

tasks = data.get('task', {}).get('tasks', [])
found = None
remaining = []

for task in tasks:
    matched = False
    if task_id and task['id'] == task_id:
        matched = True
    elif title_search and title_search.lower() in task.get('title', '').lower():
        matched = True

    if matched and found is None:
        found = task
    else:
        remaining.append(task)

if not found:
    print('错误: 找不到匹配的任务')
    sys.exit(1)

data['task']['tasks'] = remaining

with open('$STORAGE_FILE', 'w') as f:
    json.dump(data, f, ensure_ascii=False)

print(f"✅ 任务已删除: [{found['id']}] {found['title']}")
PYTHON
}

# 主入口
case "${1:-help}" in
  list) shift; cmd_list "$@" ;;
  create) shift; cmd_create "$@" ;;
  update) shift; cmd_update "$@" ;;
  status) shift; cmd_status "$@" ;;
  delete) shift; cmd_delete "$@" ;;
  help|*)
    echo "Nova Tasks CLI"
    echo ""
    echo "用法: tasks.sh <command> [options]"
    echo ""
    echo "命令:"
    echo "  list [all|active|completed]   列出任务"
    echo "  create --title <t> [--priority high|medium|low] [--description <d>] [--due-date <YYYY-MM-DD>]"
    echo "  update --id <id> [--title <t>] [--priority <p>] [--description <d>] [--due-date <d>]"
    echo "  status --id <id> --status <pending|in_progress|completed>"
    echo "  delete --id <id> | --title <keyword>"
    echo ""
    echo "数据文件: $STORAGE_FILE (与 Nova 客户端共享)"
    ;;
esac
