---
name: nova-tasks
description: Nova 任务管理技能。当用户提到"创建任务"、"添加待办"、"记个待办"、"帮我记一下"、"任务列表"、"我的任务"、"看看待办"、"标记完成"、"完成任务"、"删除任务"、"更新任务"、"任务状态"、"TODO"、"to-do"、"task"、"截止日期"、"deadline"等需要对 Nova Tasks 进行增删改查操作的场景时触发。
---

# Nova Tasks 管理

通过结构化指令操作 Nova 客户端内置的任务系统。指令会被客户端自动解析和执行。

## 指令格式

在回复中嵌入以下格式的指令（可以混在正常回复文本中）：

### 创建任务

```
[TASK:CREATE title="任务标题" priority="medium" startDate="2026-07-17" dueDate="2026-07-20"]
```

- title: 必填，任务标题
- priority: 可选，low / medium / high，默认 medium
- description: 可选，任务描述
- startDate: 可选，开始日期 (YYYY-MM-DD)，默认当天
- dueDate: 可选，截止日期 (YYYY-MM-DD)。若用户未指定，根据任务复杂度自行推断合理的截止日期（简单任务 1-2 天，中等任务 3-5 天，复杂任务 1-2 周）

### 更新任务状态

```
[TASK:STATUS id="task-xxx" status="completed"]
```

- id: 必填，任务 ID
- status: pending / in_progress / completed

### 更新任务内容

```
[TASK:UPDATE id="task-xxx" title="新标题" priority="high" dueDate="2026-07-25"]
```

- id: 必填
- title / priority / description / startDate / dueDate: 要更新的字段

### 删除任务

```
[TASK:DELETE id="task-xxx"]
```

### 列出任务

```
[TASK:LIST filter="all"]
```

- filter: all / active / completed，默认 all

## 规则

1. 当用户明确要求创建、修改、删除、查看任务/待办时，使用上述指令
2. 指令可以出现在回复的任何位置，Nova 会自动提取执行
3. 一次回复中可以包含多条指令
4. 执行结果会自动展示给用户，你无需重复描述操作细节
5. 如果用户只是提到计划但没有明确要求记录，先询问是否需要创建任务
6. LIST 指令的结果会展示在 Tasks 面板，你在回复中简要说明即可
7. 创建任务时，startDate 默认当天；dueDate 如果用户没说，根据任务难度自行推断一个合理的截止日
