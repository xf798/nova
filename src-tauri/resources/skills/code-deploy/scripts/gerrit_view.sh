#!/bin/bash
# gerrit_view.sh - 通过 Gerrit REST API 查看 CR 变更详情和代码 diff
# 用法:
#   bash gerrit_view.sh --info <change_number>        # 查看 CR 基本信息
#   bash gerrit_view.sh --files <change_number>       # 列出变更文件
#   bash gerrit_view.sh --diff <change_number> <file> # 查看指定文件 diff
#   bash gerrit_view.sh --content <change_number> <file> # 查看文件完整内容

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/../config/gerrit_config.json"

# --- 读取配置 ---
if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: 配置文件不存在: $CONFIG_FILE"
  echo "请复制 gerrit_config.example.json 并填入 Gerrit HTTP Password"
  exit 1
fi

GERRIT_URL=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['gerrit_url'])")
USERNAME=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['username'])")
HTTP_PASSWORD=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['http_password'])")

AUTH="${USERNAME}:${HTTP_PASSWORD}"

# --- 辅助函数 ---
gerrit_api() {
  local endpoint="$1"
  local response
  response=$(curl -s -u "$AUTH" "${GERRIT_URL}/a${endpoint}")
  # Gerrit REST API 返回以 )]}' 开头，需要去掉
  echo "$response" | tail -n +2
}

usage() {
  echo "用法:"
  echo "  bash $0 --info <change_number>          查看 CR 基本信息"
  echo "  bash $0 --files <change_number>         列出变更文件清单"
  echo "  bash $0 --diff <change_number> <file>   查看指定文件的 diff"
  echo "  bash $0 --content <change_number> <file> 查看文件完整内容（新版本）"
  echo ""
  echo "示例:"
  echo "  bash $0 --info 637735"
  echo "  bash $0 --files 637735"
  echo "  bash $0 --diff 637735 src/index.tsx"
  exit 1
}

# --- 命令：查看 CR 信息 ---
cmd_info() {
  local change_number="$1"
  local result
  result=$(gerrit_api "/changes/${change_number}/detail")
  
  if echo "$result" | grep -q "Not found"; then
    echo "ERROR: CR ${change_number} 不存在或无权限访问"
    exit 1
  fi
  
  echo "$result" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(json.dumps({
    'number': data.get('_number'),
    'project': data.get('project'),
    'branch': data.get('branch'),
    'subject': data.get('subject'),
    'status': data.get('status'),
    'owner': data.get('owner', {}).get('name'),
    'created': data.get('created'),
    'updated': data.get('updated'),
    'insertions': data.get('insertions'),
    'deletions': data.get('deletions'),
    'url': '${GERRIT_URL}/c/' + data.get('project','') + '/+/' + str(data.get('_number',''))
}, ensure_ascii=False, indent=2))
"
}

# --- 命令：列出变更文件 ---
cmd_files() {
  local change_number="$1"
  local result
  result=$(gerrit_api "/changes/${change_number}/revisions/current/files")
  
  if echo "$result" | grep -q "Not found"; then
    echo "ERROR: CR ${change_number} 不存在或无权限访问"
    exit 1
  fi
  
  echo "$result" | python3 -c "
import sys, json
data = json.load(sys.stdin)
files = []
for f, info in sorted(data.items()):
    if f == '/COMMIT_MSG':
        continue
    files.append({
        'file': f,
        'status': info.get('status', 'M'),
        'lines_inserted': info.get('lines_inserted', 0),
        'lines_deleted': info.get('lines_deleted', 0),
        'size': info.get('size', 0)
    })
print(json.dumps(files, ensure_ascii=False, indent=2))
"
}

# --- 命令：查看文件 diff ---
cmd_diff() {
  local change_number="$1"
  local file_path="$2"
  # URL encode the file path
  local encoded_path
  encoded_path=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$file_path', safe=''))")
  
  local result
  result=$(curl -s -u "$AUTH" "${GERRIT_URL}/a/changes/${change_number}/revisions/current/files/${encoded_path}/diff")
  
  # 去掉 Gerrit 的 )]}' 前缀
  result=$(echo "$result" | tail -n +2)
  
  if echo "$result" | grep -q "Not found"; then
    echo "ERROR: 文件 ${file_path} 不存在于 CR ${change_number}"
    exit 1
  fi
  
  echo "$result" | python3 -c "
import sys, json

data = json.load(sys.stdin)
meta_a = data.get('meta_a', {})
meta_b = data.get('meta_b', {})

change_type = data.get('change_type', 'MODIFIED')
print(f'--- Change Type: {change_type}')
if meta_a:
    print(f'--- a/ {meta_a.get(\"name\",\"\")} ({meta_a.get(\"lines\",0)} lines)')
if meta_b:
    print(f'+++ b/ {meta_b.get(\"name\",\"\")} ({meta_b.get(\"lines\",0)} lines)')
print()

for chunk in data.get('content', []):
    # ab = context lines (unchanged)
    if 'ab' in chunk:
        for line in chunk['ab']:
            print(f' {line}')
    # a = removed lines
    if 'a' in chunk:
        for line in chunk['a']:
            print(f'-{line}')
    # b = added lines
    if 'b' in chunk:
        for line in chunk['b']:
            print(f'+{line}')
    # skip marker
    if 'skip' in chunk:
        print(f'... ({chunk[\"skip\"]} lines skipped) ...')
"
}

# --- 命令：查看文件完整内容 ---
cmd_content() {
  local change_number="$1"
  local file_path="$2"
  local encoded_path
  encoded_path=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$file_path', safe=''))")
  
  local result
  result=$(curl -s -u "$AUTH" "${GERRIT_URL}/a/changes/${change_number}/revisions/current/files/${encoded_path}/content")
  
  if echo "$result" | grep -q "Not found"; then
    echo "ERROR: 文件 ${file_path} 不存在于 CR ${change_number}"
    exit 1
  fi
  
  # Gerrit 返回 base64 编码的内容
  echo "$result" | base64 -d
}

# --- 主逻辑 ---
if [ $# -lt 2 ]; then
  usage
fi

COMMAND="$1"
CHANGE_NUMBER="$2"

case "$COMMAND" in
  --info)
    cmd_info "$CHANGE_NUMBER"
    ;;
  --files)
    cmd_files "$CHANGE_NUMBER"
    ;;
  --diff)
    if [ $# -lt 3 ]; then
      echo "ERROR: --diff 需要指定文件路径"
      usage
    fi
    cmd_diff "$CHANGE_NUMBER" "$3"
    ;;
  --content)
    if [ $# -lt 3 ]; then
      echo "ERROR: --content 需要指定文件路径"
      usage
    fi
    cmd_content "$CHANGE_NUMBER" "$3"
    ;;
  *)
    echo "ERROR: 未知命令 $COMMAND"
    usage
    ;;
esac
