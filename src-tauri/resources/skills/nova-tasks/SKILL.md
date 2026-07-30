---
name: nova-tasks
description: Nova 任务管理技能。当用户提到"创建任务"、"添加待办"、"记个待办"、"帮我记一下"、"任务列表"、"我的任务"、"看看待办"、"标记完成"、"完成任务"、"删除任务"、"更新任务"、"任务状态"、"TODO"、"to-do"、"task"、"截止日期"、"deadline"等需要对 Nova Tasks 进行增删改查操作的场景时触发。
---

# Nova Tasks 管理

通过直接读写 JSON 文件管理任务。Nova UI 通过文件监听自动同步展示。

## 数据文件

**路径**: `~/.nova/data/tasks.json`

**格式**: JSON 数组，每个元素为一个 Task 对象：

```json
[
  {
    "id": "task-1721555000000-a1b2",
    "title": "任务标题",
    "description": "任务描述（可选）",
    "status": "pending",
    "priority": "medium",
    "startDate": "2026-07-21",
    "dueDate": "2026-07-25",
    "createdAt": "2026-07-21T10:30:00.000Z",
    "updatedAt": "2026-07-21T10:30:00.000Z",
    "completedAt": null
  }
]
```

## 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | ✅ | 格式: `task-{timestamp}-{random4chars}` |
| title | string | ✅ | 任务标题 |
| description | string | ❌ | 任务描述 |
| status | string | ✅ | `pending` / `in_progress` / `completed` |
| priority | string | ✅ | `low` / `medium` / `high` |
| startDate | string | ✅ | 开始日期 YYYY-MM-DD，默认当天 |
| dueDate | string | ❌ | 截止日期 YYYY-MM-DD |
| createdAt | string | ✅ | ISO 时间戳 |
| updatedAt | string | ✅ | ISO 时间戳，每次修改更新 |
| completedAt | string | ❌ | 完成时间，status 变为 completed 时设置 |

## 操作方式

**所有操作通过 read/write tool 直接操作文件**：

### 查看任务
1. 使用 `read` tool 读取 `~/.nova/data/tasks.json`
2. 在回复中以合适格式展示给用户

### 创建任务
1. 读取现有文件内容
2. 构造新 Task 对象，`unshift` 到数组头部
3. 写回文件（保持 pretty print，2 空格缩进）

### 更新/删除任务
1. 读取文件
2. 找到对应 id 的任务，修改或删除
3. 更新 `updatedAt` 字段
4. 写回文件

## 行为规则

1. 用户要求查看任务时 → 读取文件，在对话中展示任务列表
2. 用户说"帮我记一下"、"TODO: xxx" 等格式时 → 直接创建任务写入文件
3. 创建任务时 `startDate` 默认当天；`dueDate` 用户没说则根据复杂度推断（简单 1-2 天，中等 3-5 天，复杂 1-2 周）
4. 文件不存在时创建新的空数组 `[]`
5. 最多保留 200 条任务，超出时移除最旧的
6. 写文件时使用 2 空格缩进的 JSON 格式

## ID 生成规则

```
task-{Date.now()}-{4位随机字母数字}
```

示例: `task-1721555000000-x7kp`
