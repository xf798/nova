# Nova Coding Agent 重构改造方案

> Nova 定位：**专注于代码开发的桌面 AI 工具**
> 交互形态：聊天框驱动，用户下指令 → AI 全自动执行 → 聊天框汇报结果
> 技术栈：Tauri（React + Rust），对接 OpenAI 兼容 API

---

## 一、目标

让 Nova 在 OpenAI 兼容 API（GPT-4o、DeepSeek、GLM 等）配置下，具备完整的代码开发能力：
- 读写文件、精准编辑代码
- 执行 shell 命令（编译、测试、git）
- 搜索代码库（grep、glob）
- 多轮自动执行 + 自我验证（改完跑 build/test，失败自动修）

**不依赖 kiro-cli，OpenAI connector 独立具备全部代码开发能力。**

---

## 二、架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        sendMessage() 对话循环                         │
│  用户输入 → 构建上下文 → connector.send() → [tool loop] → 最终回复    │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ tool_calls[]
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     ToolOrchestrator 编排层                           │
│                                                                     │
│  1. 查找 ToolDefinition                                              │
│  2. 安全检查（路径白名单、危险命令拦截）                                │
│  3. 执行 handler                                                     │
│  4. 结果截断 + 格式化                                                 │
│  5. [Future] pre/post hook                                          │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        ToolRegistry                                   │
│                                                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐              │
│  │ Coding   │ │ MCP/UI   │ │ Plugins  │ │ Future:  │              │
│  │ Tools    │ │ Tools    │ │ Tools    │ │ Agent    │              │
│  │ (6个)    │ │ (现有)   │ │ (现有)   │ │ /Skill   │              │
│  └────┬─────┘ └──────────┘ └──────────┘ └──────────┘              │
└───────┼─────────────────────────────────────────────────────────────┘
        │ Tauri invoke
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Rust 后端 (coding_tools.rs)                        │
│                                                                     │
│  tool_file_read │ tool_file_write │ tool_file_edit                   │
│  tool_bash      │ tool_glob       │ tool_grep                        │
│                                                                     │
│  安全层：路径验证 + 命令黑名单 + 超时控制                              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 三、Tool 通路与 MCP 兼容性

### 3.1 当前三条 Tool 通路

```
通路 1：OpenAI Connector（tool_call 模式）
  LLM → 返回 tool_calls → sendMessage tool loop → toolOrchestrator → toolRegistry.call()

通路 2：Kiro CLI Connector（MCP 模式）
  Kiro CLI ACP → 调 Nova MCP Server（HTTP axum）→ Tauri event →
  → 前端 toolRegistry.call() → invoke 回传 → Rust 返回 HTTP 响应

通路 3：旧的 inline fallback（过渡期）
  Kiro CLI 回复文本 → 正则匹配 [ACTION:...] → toolRegistry.call()
```

三条通路最终**都汇聚到 `toolRegistry.call()`**，coding tools 注册后自动可用。

### 3.2 Scope 机制（防止能力重复）

**问题**：kiro-cli 自身已有完整的文件读写/命令执行能力（ACP 内置 tool），如果 MCP Server 再暴露 Nova 的 coding tools 给它，会造成能力重复、模型混淆。

**方案**：给 ToolDefinition 增加 `scope` 字段：

```typescript
export interface ToolDefinition {
  // ...
  /**
   * Tool 可见范围：
   * - "all"   → 对所有通路可见（OpenAI tool_call + MCP Server 暴露给 kiro-cli）
   * - "local" → 仅 OpenAI connector 的 tool_call 可见，MCP tools/list 中不返回
   *
   * 默认 "all"（向后兼容现有 tools）
   */
  scope?: "all" | "local";
}
```

**过滤逻辑**：MCP Server 返回 tools 列表时加 scope 过滤：

```typescript
// MCP tools/list event handler
const mcpVisibleTools = toolRegistry.list().filter(t => t.scope !== "local");
```

**各类 Tool 的 scope 配置**：

| Tool 类别 | scope | 原因 |
|-----------|-------|------|
| MCP/UI tools（nav.goto, ui.screenshot 等） | `"all"` | kiro-cli 需要操控 Nova UI |
| 插件 tools | `"all"` | kiro-cli 可能需要调用 |
| **Coding tools（file_read, bash 等）** | **`"local"`** | kiro-cli 自己有，不需要重复 |
| system tools（tools.list, tools.doc） | `"all"` | 信息查询，通用 |
| chat tools（chat.send, chat.newSession） | `"all"` / `internal` | 按需 |

### 3.3 改动影响

| 组件 | 是否需改动 | 改动量 |
|------|-----------|--------|
| ToolRegistry | 极小 | `list()` 增加可选 scope 过滤 |
| MCP Server 前端 handler | 极小 | 返回列表时加 `.filter(t => t.scope !== "local")` |
| MCP Server Rust 侧 | 不需要 | 前端已过滤 |
| 现有 MCP tools | 不需要 | 默认 scope = "all" |
| OpenAI connector | 不需要 | `generateOpenAITools()` 返回所有非 internal 的 tools |
| kiro-cli connector | 不需要 | 通过 MCP 调用，过滤后看不到 coding tools |

---

## 四、分层设计原则（Tool 执行不经 MCP）

| 层 | 职责 | 不做什么 |
|---|---|---|
| **sendMessage** (对话循环) | tool loop 控制、system prompt 注入、轮次管理 | 不做 tool 执行细节 |
| **ToolOrchestrator** (编排) | 安全检查、结果截断、错误包装、future hook | 不做实际 IO |
| **ToolRegistry** (注册中心) | tool 注册/发现/schema 生成 | 不做编排逻辑 |
| **Coding Tool handlers** (前端) | 参数组装、调 Rust、格式化返回 | 不做安全判断 |
| **Rust coding_tools** (后端) | 实际文件 IO、命令执行、搜索 | 不做业务逻辑 |

---

## 五、Coding Tools 详细设计

### 4.1 六个核心 Tool

| Tool | 功能 | 参数 | 安全级别 |
|------|------|------|----------|
| `file_read` | 读取文件内容 | `path`, `offset?`, `limit?` | auto（只读） |
| `file_write` | 创建或完整覆盖文件 | `path`, `content` | notify（新建/覆盖） |
| `file_edit` | search-replace 精准编辑 | `path`, `old_str`, `new_str` | notify（修改） |
| `bash` | 执行 shell 命令 | `command`, `cwd?`, `timeout?` | 动态（普通 notify / 危险 deny） |
| `glob` | 文件名模式搜索 | `pattern`, `path?`, `limit?` | auto（只读） |
| `grep` | 文本内容搜索 | `pattern`, `path?`, `include?`, `limit?` | auto（只读） |

### 4.2 安全级别定义

```
auto   → 直接执行，不通知用户
notify → 执行，在聊天框显示执行了什么（tool_calls UI 已有）
deny   → 拒绝执行，返回错误信息给 AI（AI 会看到原因并调整）
```

**deny 触发条件**（Rust 侧强制）：
- 路径在 cwd 外且未被显式授权
- `rm -rf /`、`rm -rf ~`、`mkfs`、`dd if=` 等破坏性命令
- 尝试写入 `/System`、`/usr`、`/bin` 等系统目录

### 4.3 file_edit 的 search-replace 格式

参考 Aider 的研究结论：search-replace 比 unified diff 可靠。

```json
{
  "path": "/abs/path/to/file.ts",
  "old_str": "function hello() {\n  return 'world';\n}",
  "new_str": "function hello() {\n  return 'hello world';\n}"
}
```

规则：
- `old_str` 必须在文件中**唯一匹配**（否则返回错误 + 上下文提示）
- 不匹配时返回文件相关部分供 AI 修正
- 支持 `replace_all?: boolean` 选项（批量替换）

### 4.4 bash 的超时和输出控制

```rust
// Rust 侧
struct BashOutput {
    stdout: String,      // 截断到 max_chars
    stderr: String,      // 截断到 max_chars
    exit_code: i32,
    truncated: bool,     // 是否被截断
    duration_ms: u64,
}
```

- 默认超时：30 秒（参数可覆盖，最大 300 秒）
- 输出上限：stdout + stderr 各 50000 字符
- 超时后 SIGTERM → 等 3s → SIGKILL

---

## 六、ToolOrchestrator 设计

```typescript
// src/core/tools/orchestrator.ts

class ToolOrchestrator {
  /**
   * 执行 tool（当前直通实现，预留 hook 扩展点）
   */
  async execute(name: string, params: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
    const def = toolRegistry.getDefinition(name);
    if (!def) return { ok: false, error: `Tool "${name}" not found` };

    // [扩展点] Pre-hook（future）
    // const preResult = await this.runPreHooks(name, params, ctx);
    // if (preResult.blocked) return preResult.error;

    // 执行
    const result = await toolRegistry.call(name, params, ctx);

    // 结果截断
    if (result.ok && result.data) {
      const maxChars = def.maxResultChars ?? 50000;
      const serialized = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
      if (serialized.length > maxChars) {
        result.data = serialized.slice(0, maxChars) + `\n\n[... 输出已截断，共 ${serialized.length} 字符，显示前 ${maxChars} 字符]`;
      }
    }

    // [扩展点] Post-hook（future）
    // await this.runPostHooks(name, params, result, ctx);

    return result;
  }
}

export const toolOrchestrator = new ToolOrchestrator();
```

---

## 七、sendMessage 改造

### 7.1 Tool Loop 增强

```typescript
// 改动点：
const MAX_TOOL_LOOPS = 25;  // 从 5 提升到 25

// tool 执行改为经过 orchestrator
const result = await toolOrchestrator.execute(tc.name, tc.arguments, {
  cwd: cwd || await getDefaultCwd(),
  signal: abortController.signal,
});
```

### 7.2 Bug 修复：Tool Messages 累积

**现有 Bug**：多轮 tool loop 中，第 N 轮的 LLM 请求只携带第 N 轮的 `toolMessages`，看不到第 1~N-1 轮的 tool 交互历史。导致 LLM 可能重复调用已执行过的 tool。

**修复方案**：在 while 循环外维护累积数组：

```typescript
const accumulatedToolMessages: any[] = [];  // ← 放在 while 外面

while (result.toolCalls && result.toolCalls.length > 0 && toolLoopCount < MAX_TOOL_LOOPS) {
  toolLoopCount++;

  const toolMessages: any[] = [];
  // 构建本轮 assistant message + tool results...
  toolMessages.push({ role: "assistant", content: result.content || null, tool_calls: [...] });
  for (const tc of result.toolCalls) {
    // 执行 tool...
    toolMessages.push({ role: "tool", tool_call_id: tc.id, content: "..." });
  }

  // 累积所有轮次的 tool 交互
  accumulatedToolMessages.push(...toolMessages);

  // 二次调用时传累积的完整 tool 历史
  result = await connector.send("", {
    history: history || fallbackHistory,
    toolMessages: accumulatedToolMessages,  // ← 累积的，不是单轮的
    tools,
    cwd,
  }, onChunk, onMeta);
}
```

### 7.3 已知问题：弱模型误调 tool

**问题**：GLM 等能力较弱的模型会错误调用 Nova 暴露的 UI tools（如 `chat.newSession`、`chat.send`），导致自动开新会话、重复消息。

**方案**：
1. `chat.send` 和 `chat.newSession` 已标记 `internal: true`，不会出现在 `generateOpenAITools()` 中
2. 对于仍然误调的情况，在 orchestrator 层加兜底：如果 tool 不存在直接返回 `{ ok: false, error: "Tool not found" }` 给 AI，让它调整行为
3. [Future] 可按 connector/model 配置 tool 白名单（只暴露部分 tools 给特定连接器）

### 7.4 Coding System Prompt 自动注入

```typescript
// 条件：connector.capabilities.needsHistory === true 且有 coding tools 注册
function getCodingSystemPrompt(cwd: string): string {
  return `You are an AI coding assistant with direct access to the filesystem and shell.

Working directory: ${cwd}

Available coding tools:
- file_read: Read file contents (supports line ranges)
- file_write: Create new files or overwrite existing ones
- file_edit: Make targeted edits using exact string matching (search/replace)
- bash: Execute shell commands (build, test, git, etc.)
- glob: Find files by name pattern
- grep: Search file contents with regex

Guidelines:
- Always read a file before editing it (to get current content for search/replace)
- Use file_edit for targeted changes; use file_write only for new files or complete rewrites
- After making changes, run the relevant build/test command to verify
- If a test fails, read the error output and fix the issue
- Use glob/grep to discover relevant files before making changes
- Prefer small, focused edits over large rewrites`;
}
```

### 7.5 注入时机

在 `sendMessage()` 构建 history 的 stable context 部分：

```typescript
if (needsHistory && hasCodingTools()) {
  const codingPrompt = getCodingSystemPrompt(cwd || homedir());
  stableParts.push(codingPrompt);
}
```

---

## 八、会话绑定独立连接器

### 8.1 现状

- session 创建时已记录 `connectorId`（sessionStore 中的字段）
- 但发送消息时统一使用全局 `activeConnector`，忽略 session 自身的绑定
- 切换连接器 = 全局切换，影响所有会话

### 8.2 目标行为

**核心原则：不存在"全局连接器"概念，每个会话记住自己的连接器。**

- **新会话**：绑定创建时 UI 上选中的连接器 ID
- **发送消息**：永远看 `session.connectorId`，不看全局状态
- **切换连接器（UI 操作）**：更新当前活跃会话的 `connectorId`
- **打开旧会话**：继续用该会话自己记录的连接器
- **connectorId 对应的连接器被删除/禁用** → 提示用户重新选择

### 8.3 改动点

**1. ChatView.tsx 的 handleSend — 获取连接器逻辑**：

```typescript
// 改为：永远从 session 获取
const sessionConnector = getConnectorForSession(curSession, sessionId);
```

**2. 新增 helper**：

```typescript
function getConnectorForSession(
  session: ChatSession | undefined,
  sessionId: string,
): Connector | null {
  const connectorId = session?.connectorId;
  if (!connectorId) return null;  // 异常：session 没绑连接器

  const connector = connectorRegistry.get(connectorId);
  if (!connector || !connector.config.enabled) return null;  // 连接器被删/禁用

  // CLI 类型需要独立实例（每个 session 一个进程）
  if (connector.config.type === "cli") {
    return connectorInstances.getOrCreate(sessionId, {
      cwd: session?.cwd || homedir(),
    });
  }
  return connector;
}
```

**3. 切换连接器的 UI 操作**：

```typescript
// ConnectorSelector 切换时：更新当前会话的 connectorId
function handleConnectorSwitch(newConnectorId: string) {
  if (activeSessionId) {
    updateMeta(activeSessionId, { connectorId: newConnectorId });
  }
}
```

**4. 新会话创建时**（已有，无需改）：

```typescript
// ensureSession() 中已经做了：
connectorId: currentSelectedConnectorId  // UI 上当前选中的
```

### 8.4 不涉及的

- 不需要改 sessionStore 结构（`connectorId` 字段已有）
- 不需要改 sendMessage.ts（它接收 connector 参数，不关心来源）
- 不需要改 connector 实现
- 不需要维护全局 activeConnector 状态（可逐步移除）

---

## 九、OpenAI Connector 适配

当前已基本满足，需微调：

| 改动 | 说明 |
|------|------|
| inputSchema 支持 | `generateOpenAITools()` 优先使用 `ToolDefinition.inputSchema`（JSON Schema）|
| result 格式 | 确保 tool result content 始终为 string |
| parallel_tool_calls | GPT-4o 可能一次返回多个 tool_calls，当前逐个执行即可（已支持） |
| finish_reason 兼容 | 有些模型返回 `"stop"` 有些返回 `"tool_calls"`，两种都要处理 |

---

## 十、Rust 后端实现要点

### 10.1 模块结构

```rust
// src-tauri/src/coding_tools.rs

use std::process::Command;
use std::time::Duration;
use tokio::time::timeout;

#[tauri::command]
pub async fn tool_file_read(path: String, offset: Option<usize>, limit: Option<usize>) -> Result<String, String> {
    // 1. 路径安全检查（resolve symlink，检查是否在允许范围内）
    // 2. 读取文件
    // 3. 按 offset/limit 截取行
    // 4. 返回内容
}

#[tauri::command]
pub async fn tool_file_write(path: String, content: String) -> Result<String, String> {
    // 1. 路径安全检查
    // 2. 自动创建父目录
    // 3. 写入文件
    // 4. 返回确认信息（文件大小、行数）
}

#[tauri::command]
pub async fn tool_file_edit(path: String, old_str: String, new_str: String, replace_all: Option<bool>) -> Result<String, String> {
    // 1. 路径安全检查
    // 2. 读取文件
    // 3. 查找 old_str（必须唯一匹配，否则返回错误+上下文）
    // 4. 替换
    // 5. 写回
    // 6. 返回变更摘要
}

#[tauri::command]
pub async fn tool_bash(command: String, cwd: Option<String>, timeout_ms: Option<u64>) -> Result<BashOutput, String> {
    // 1. 命令安全检查（黑名单）
    // 2. spawn sh -c "command"
    // 3. 超时控制
    // 4. 输出截断
    // 5. 返回 stdout + stderr + exit_code
}

#[tauri::command]
pub async fn tool_glob(pattern: String, path: Option<String>, limit: Option<usize>) -> Result<Vec<String>, String> {
    // 1. walkdir + globset 匹配
    // 2. 排除 .git, node_modules, target 等
    // 3. 限制返回数量（默认 200）
}

#[tauri::command]
pub async fn tool_grep(pattern: String, path: Option<String>, include: Option<String>, limit: Option<usize>) -> Result<String, String> {
    // 1. 递归搜索
    // 2. 正则匹配
    // 3. 返回 "文件:行号:内容" 格式
    // 4. 限制匹配数量（默认 100）
}
```

### 10.2 安全层

```rust
// src-tauri/src/coding_tools.rs

/// 危险命令黑名单
const DANGEROUS_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf ~",
    "rm -rf $HOME",
    "mkfs",
    "dd if=",
    "> /dev/sda",
    "chmod -R 777 /",
    ":(){ :|:& };:",  // fork bomb
];

/// 系统保护路径
const PROTECTED_PATHS: &[&str] = &[
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/private",
];

fn validate_path(path: &str, cwd: &str) -> Result<PathBuf, String> {
    let resolved = fs::canonicalize(path).map_err(|e| format!("路径无效: {e}"))?;
    
    for protected in PROTECTED_PATHS {
        if resolved.starts_with(protected) {
            return Err(format!("拒绝访问系统保护路径: {}", resolved.display()));
        }
    }
    
    Ok(resolved)
}

fn validate_command(command: &str) -> Result<(), String> {
    let lower = command.to_lowercase();
    for pattern in DANGEROUS_PATTERNS {
        if lower.contains(pattern) {
            return Err(format!("拒绝执行危险命令: 包含 '{pattern}'"));
        }
    }
    Ok(())
}
```

---

## 十一、前端 Tool 注册

### 9.1 目录结构

```
src/core/tools/
├── types.ts              ← ToolDefinition, ToolContext 类型定义
├── registry.ts           ← ToolRegistry（从现有 tools.ts 提取，增强）
├── orchestrator.ts       ← ToolOrchestrator
├── index.ts              ← 向后兼容导出（toolRegistry, actionRegistry 等别名）
└── coding/
    ├── index.ts          ← registerCodingTools() 入口
    ├── fileRead.ts
    ├── fileWrite.ts
    ├── fileEdit.ts
    ├── bash.ts
    ├── glob.ts
    └── grep.ts
```

### 9.2 注册示例

```typescript
// src/core/tools/coding/fileRead.ts
import { invoke } from "@tauri-apps/api/core";
import { toolRegistry } from "../registry";
import type { ToolDefinition } from "../types";

export const fileReadDef: ToolDefinition = {
  name: "file_read",
  description: "Read the contents of a file. Returns file text with line numbers. Supports reading specific line ranges with offset and limit.",
  category: "coding",
  pluginId: "__nova_coding__",
  scope: "local",           // 仅 OpenAI connector 可见，不暴露给 MCP/kiro-cli
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 100000,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file to read" },
      offset: { type: "number", description: "Start line (0-indexed, optional)" },
      limit: { type: "number", description: "Maximum number of lines to read (optional)" },
    },
    required: ["path"],
  },
};

export function registerFileRead() {
  toolRegistry.register("file_read", async (params) => {
    const { path, offset, limit } = params;
    try {
      const content = await invoke<string>("tool_file_read", { path, offset, limit });
      return { ok: true, data: content };
    } catch (err: any) {
      return { ok: false, error: err.toString() };
    }
  }, fileReadDef);
}
```

### 9.3 统一注册入口

```typescript
// src/core/tools/coding/index.ts
import { registerFileRead } from "./fileRead";
import { registerFileWrite } from "./fileWrite";
import { registerFileEdit } from "./fileEdit";
import { registerBash } from "./bash";
import { registerGlob } from "./glob";
import { registerGrep } from "./grep";

export function registerCodingTools() {
  registerFileRead();
  registerFileWrite();
  registerFileEdit();
  registerBash();
  registerGlob();
  registerGrep();
  console.log("[Nova] ✅ Coding tools registered (6)");
}
```

### 9.4 在应用启动时注册

```typescript
// src/hooks/useNovaInit.ts 中追加
import { registerCodingTools } from "../core/tools/coding";

// 在 load() 函数中，initBuiltinConnectors() 之后：
registerCodingTools();
```

---

## 十二、实施步骤

### Step 1：基础框架（半天）
- [ ] 新建 `src/core/tools/types.ts`（ToolDefinition, ToolContext，含 scope 字段）
- [ ] 将现有 `tools.ts` 拆为 `registry.ts` + 兼容层 `index.ts`
- [ ] `registry.ts` 中 `list()` 增加 scope 过滤支持
- [ ] 新建 `orchestrator.ts`（初版直通实现）
- [ ] MCP event handler 中加 `.filter(t => t.scope !== "local")`
- [ ] 确保现有 MCP tools、插件 tools 零影响通过

### Step 2：Rust 后端（1天）
- [ ] 新建 `src-tauri/src/coding_tools.rs`
- [ ] 实现 6 个 `#[tauri::command]` 函数
- [ ] 实现安全校验层（路径验证 + 命令黑名单）
- [ ] 在 `lib.rs` 注册 commands
- [ ] 编译验证

### Step 3：前端 Tool 注册（半天）
- [ ] 新建 `src/core/tools/coding/` 目录及 6 个 tool 文件
- [ ] 实现 `registerCodingTools()`
- [ ] 在 `useNovaInit.ts` 中调用注册
- [ ] 验证 `toolRegistry.generateOpenAITools()` 输出正确 schema

### Step 4：sendMessage 改造（半天）
- [ ] `MAX_TOOL_LOOPS` → 25
- [ ] 修复 tool messages 累积 bug（accumulatedToolMessages）
- [ ] tool loop 中 `toolRegistry.call()` → `toolOrchestrator.execute()`
- [ ] 新增 `getCodingSystemPrompt(cwd)` 并在 needsHistory 模式下注入
- [ ] orchestrator 层兜底：tool not found 返回友好错误（防弱模型误调）
- [ ] 测试完整 tool loop 流程（含多轮累积验证）

### Step 5：联调验证（半天）
- [ ] 用 OpenAI connector + GPT-4o 测试："帮我创建一个 hello world 的 Node.js 项目"
- [ ] 验证多轮 tool loop（读文件 → 改文件 → 跑命令 → 修错误）
- [ ] 验证 tool messages 累积正确（第 3 轮能看到第 1、2 轮结果）
- [ ] 验证安全拦截（尝试 rm -rf /）
- [ ] 验证现有 MCP tools 不受影响
- [ ] 验证 GLM 等弱模型误调 tool 时不崩溃（返回错误信息）

### Step 6：会话绑定独立连接器（15分钟）
- [ ] ChatView handleSend 中新增 `getConnectorForSession()` helper
- [ ] 根据 session.connectorId 查找对应连接器，fallback 到 activeConnector
- [ ] 验证：切换全局连接器后，旧会话继续用原连接器

---

## 十三、兼容性保证

| 现有功能 | 影响 | 原因 |
|----------|------|------|
| MCP tools（nav.goto, ui.screenshot 等） | ✅ 无影响 | register() API 不变，scope 默认 "all" |
| MCP Server → kiro-cli 通路 | ✅ 无影响 | coding tools scope="local" 不暴露给 MCP |
| 插件 tools | ✅ 无影响 | 同上 |
| kiro-cli connector | ✅ 无影响 | 它不走 tool loop，MCP 也不会看到 coding tools |
| 企微 bot | ✅ 无影响 | 它不走 tool loop |
| 现有 OpenAI connector | ✅ 增强 | 新增 coding tools + tool loop 加强 |
| MCP Server（Rust axum） | ✅ 无影响 | 独立模块，不改动 |
| 旧的 [ACTION:...] inline fallback | ✅ 无影响 | coding tools 不走这条路 |

---

## 十四、后续演进路线

| 阶段 | 内容 | 时间 |
|------|------|------|
| **V1（本次）** | 6 coding tools + orchestrator + tool loop 增强 | 3天 |
| **V2** | Build/Plan 双模式（system prompt 切换 tool 白名单） | 后续 |
| **V3** | Post-hook（编辑后自动 lint/format） | 后续 |
| **V4** | 多模型路由（简单任务用 mini，复杂用 4o） | 后续 |
| **V5** | SubAgent（fork 独立对话上下文执行子任务） | 后续 |
| **V6** | Skill → Recipe（多步执行流程定义） | 后续 |
