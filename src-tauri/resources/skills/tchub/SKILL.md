---
name: tchub
description: TCHub 文档与工作流管理技能。通过 TCHub REST API 查询项目/Feature/Workstream 信息，上传和获取文档，管理工作流状态和成员，记录笔记和记忆。当用户需要"上传文档"、"查看文档"、"同步PRD"、"更新工作流状态"、"查看workstream"、"查询项目文档"、"添加成员"、"记录决策"时触发。
---

# TCHub 文档与工作流管理

通过 TCHub REST API（MCP 服务）管理项目文档、工作流状态、笔记和记忆。

## 连接配置

TCHub MCP 服务地址和认证信息：

```json
{
  "url": "https://tchub.ingageapp.com/mcp",
  "headers": {
    "Authorization": "Bearer <token>"
  }
}
```

Token 从环境变量 `TCH_API_TOKEN` 获取，格式为 `tch_` 前缀。

---

## 工具列表

### 项目与 Feature 管理

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `list_projects` | 列出所有项目 | 无 |
| `list_features` | 列出项目下的 Feature | `projectId` |
| `create_project` | 创建项目 | `name` |
| `create_feature` | 创建 Feature | `projectId`, `name` |

### Workstream 管理

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `list_workstreams` | 列出 workstream | `featureId` 或 `mine=true` |
| `list_workstreams_for_feature` | 列出某 Feature 下所有 workstream | `featureId` |
| `create_workstream` | 创建 workstream | `featureId`, `name`, `ownerRole` |
| `update_workstream_status` | 更新状态 | `workstreamId`, `status`, `currentStage` |
| `update_workstream_member` | 管理成员 | `workstreamId`, `action`, `userId`, `userName`, `role` |
| `get_workstream_context` | 获取完整上下文 | `workstreamId`, `compact`(可选) |

### 文档管理

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `search_documents` | 搜索文档 | `query`, `featureId`(可选) |
| `get_document` | 获取单个文档内容 | `documentId` |
| `get_feature_context` | 获取 Feature 下完整文档列表 | `featureId` |
| `get_upload_command` | 生成文档上传 curl 命令 | `workstreamId`, `filePath`, `title`, `docType`, `currentStage` |
| `upload_document_version` | 上传文档新版本 | `documentId`, `filePath`, `uploadNote` |

### 笔记与记忆

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `list_context_notes` | 列出笔记 | `workstreamId`, `noteType`, `limit` |
| `search_context_notes` | 搜索笔记 | `query`, `workstreamId`, `noteType`, `limit` |
| `remember_context` | 创建笔记 | `workstreamId`, `title`, `contentText`, `noteType`, `tags` |
| `write_handoff` | 写入交接笔记 | `workstreamId`, 内容 |
| `list_memories` | 列出长期记忆 | 过滤条件 |
| `search_memories` | 搜索记忆 | `query` |
| `create_memory` | 创建记忆 | `title`, `content`, `scopeType`, `scopeId` |
| `update_memory_lifecycle` | 更新记忆状态 | `memoryId`, `status` |
| `promote_memory` | 提升记忆重要性 | `memoryId` |

---

## Workstream 状态流转

| 用户意图 | status | currentStage |
|:---|:---|:---|
| 产品文档已确认/PRD确认 | `product_complete` | `product` |
| 进入设计阶段 | `design_active` | `design` |
| 设计完成 | `design_complete` | `design` |
| 进入开发 | `implementation_active` | `implementation` |
| 进入测试 | `qa_active` | `qa` |
| 测试完成 | `qa_complete` | `qa` |
| 全部完成 | `completed` | `done` |

---

## 成员角色映射

| 用户说法 | role |
|:---|:---|
| 研发负责人/开发/dev | `dev` |
| 产品/PM | `product` |
| 测试/QA | `qa` |

成员操作 action: `add` / `remove` / `update`

`userId` 约定：使用成员姓名拼音（如"王晓峰" → `wangxiaofeng`）。

---

## 文档上传规范

### docType 映射

| 文档类型 | docType | currentStage |
|:---|:---|:---|
| 需求澄清 | `prd` | `product` |
| PRD | `prd` | `product` |
| 方案设计/技术方案 | `prd` | `design` |
| 技术PRD | `prd` | `product` |
| 交互设计 | `ux_spec` | `design` |
| 技术基准 | `tech_baseline` | `design` |

### 上传方式

使用 `get_upload_command` 生成 curl 命令，然后通过 bash 执行：

```bash
# 1. 通过 MCP 调用 get_upload_command 获取 curl 命令模板
# 2. 添加认证 header 执行
curl -X POST "https://tchub.ingageapp.com/api/documents/upload" \
  -H "Authorization: Bearer <token>" \
  -F "file=@/path/to/file.md" \
  -F "projectName=<项目名>" \
  -F "featureName=<Feature名>" \
  -F "workstream_id=<workstream_id>" \
  -F "title=<文档标题>" \
  -F "doc_type=<doc_type>" \
  -F "author_name=<作者>" \
  -F "created_role=product" \
  -F "current_stage=<stage>"
```

Token 来源：环境变量 `TCH_API_TOKEN`。

### 已有文档更新

使用 `upload_document_version`：
- `documentId` = 已有文档的 ID
- `filePath` = 本地文件路径  
- `uploadNote` = 版本说明

---

## 典型工作流

### 工作流 1：上传文档到 Workstream

**用户意图**: "上传 PRD 到 XXX 工作流"

**步骤:**
1. **定位 Workstream**: 调用 `list_workstreams` 按名称匹配，获取 workstream ID
2. **检查已有文档**: 调用 `get_feature_context(featureId=...)` 查看是否已有同名文档
3. **确定操作**:
   - 无同名文档 → 新建上传（`get_upload_command` + bash 执行 curl）
   - 有同名文档 → 上传新版本（`upload_document_version`）
4. **汇报结果**: 告知文档 ID 和上传状态

### 工作流 2：查看 Workstream 文档

**用户意图**: "查看 XXX 的文档"

**步骤:**
1. **定位 Workstream**: 匹配名称获取 ID
2. **获取文档列表**: `get_feature_context(featureId=...)` 或 `search_documents(query=...)`
3. **获取文档内容**: `get_document(documentId=...)`
4. **展示内容**: 向用户展示文档摘要或完整内容

### 工作流 3：更新 Workstream 状态

**用户意图**: "PRD 确认了" / "进入开发"

**步骤:**
1. **定位 Workstream**: 根据上下文确定目标
2. **更新状态**: `update_workstream_status(workstreamId=..., status=..., currentStage=...)`
3. **汇报结果**

### 工作流 4：管理 Workstream 成员

**用户意图**: "把张三加为研发负责人"

**步骤:**
1. **定位 Workstream**
2. **确定用户信息**: userId（拼音）、userName（中文名）、role
3. **执行操作**: `update_workstream_member(workstreamId=..., action="add", userId=..., userName=..., role=...)`
4. **汇报结果**

---

## 注意事项

- **workstreamId 必传**: 上传文档、记录笔记时必须携带 workstreamId
- **渐进式加载**: 优先使用轻量工具（search_context_notes），避免一次性拉取全量上下文
- **Token 安全**: 不要在输出中暴露完整 token
- **文档上传限制**: 使用 `get_upload_command` + curl 方式，不使用 `upload_document_from_path`
- **上传前先查重**: 通过 `get_feature_context` 检查是否已有同名文档，避免重复创建
