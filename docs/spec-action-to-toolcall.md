# Nova Action → Tool Call 改造方案

## 背景

当前 Action 机制的问题：
1. AI 通过内联文本 `[ACTION:name {params}]` 调用 action，混在回复内容中
2. 前端正则匹配后执行，再从显示中 strip 掉 → 用户能看到闪烁
3. **最关键**：action 执行结果不回流给 LLM，AI 无法基于结果生成回复

## 目标

将 Action 改造为标准 **Tool Use（function calling）** 模式：
- AI 通过结构化的 `tool_call` 调用 action（不再嵌入文本中）
- Nova 拦截 tool_call → 执行 action → 拿到结果
- 将结果作为 `tool_result` 注入对话 → 二次请求 LLM → 生成包含结果的最终回复
- 用户看到的是完整的、自然语言的回答

## 架构对比

### Before（内联文本模式）

```
User → LLM → "[ACTION:autoprogram.getState {}] 让我查看..."
                    ↓
            前端正则匹配 → 执行 action → 结果丢弃
                    ↓
            strip 后展示 "让我查看..." ← 没有结果！
```

### After（Tool Call 模式）

```
User → LLM(tools=[...]) → tool_call: {name: "autoprogram.getState", args: {}}
                                ↓
                    Nova 拦截 → 执行 action → 拿到结果
                                ↓
        tool_result: {state: "running", stage: "ux", progress: 60%}
                                ↓
                    二次 LLM → "当前 AutoProgram 在 UX 阶段，进度 60%"
                                ↓
                          用户看到完整回答 ✓
```

## 影响范围

改造仅影响 **needsHistory 模式**的连接器（当前为 `OpenAIConnector`）。

对于 `KiroCliConnector`（ACP 协议），kiro-cli 自身已有 tool_call 机制（StreamMeta.toolCalls），
Nova 的 action 只需继续通过 system prompt 注入 + memorySupplement 告知 LLM。
但 kiro-cli 连接器可以在未来通过 ACP 扩展支持自定义 tools。

**本次改造核心聚焦**：OpenAI-compatible API 连接器 + sendMessage 层的 tool loop。

## 详细设计

### 1. Action → Tool Schema（已有，只需微调）

`actionRegistry.generateToolsSchema()` 已经能生成 OpenAI function calling 格式：

```typescript
// 当前已有，输出格式：
[{
  name: "autoprogram.getState",
  description: "获取流水线当前状态",
  parameters: { type: "object", properties: {}, required: [] }
}]
```

**改动**：包装为 OpenAI tools 格式（加 `type: "function"` 外壳）：

```typescript
// actionRegistry 新增方法
generateOpenAITools(): OpenAITool[] {
  return this.generateToolsSchema().map(t => ({
    type: "function" as const,
    function: t,
  }));
}
```

### 2. sendMessage 层新增 Tool Loop

在 `sendMessage.ts` 中，当连接器为 needsHistory 模式时，启用 tool loop：

```typescript
// 核心流程（伪代码）
async function sendMessage(params, onChunk, onMeta) {
  const tools = actionRegistry.generateOpenAITools();
  
  // 首次请求
  let result = await connector.send(input, { ...options, tools }, onChunk, onMeta);
  
  // Tool Loop：如果返回了 tool_calls，执行并回注
  while (result.toolCalls && result.toolCalls.length > 0) {
    const toolResults = [];
    for (const tc of result.toolCalls) {
      const actionResult = await actionRegistry.call(tc.name, tc.arguments);
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(actionResult),
      });
    }
    
    // 追加 tool_calls + tool_results 到 history，再次请求
    result = await connector.send("", { 
      ...options, 
      tools,
      toolMessages: toolResults,  // 新增字段
    }, onChunk, onMeta);
  }
  
  return result;
}
```

### 3. OpenAI Connector 支持 tools 参数

改造 `openai-api.ts`：

```typescript
interface SendOptions {
  // ... 已有字段
  /** Tool definitions（OpenAI function calling 格式） */
  tools?: OpenAITool[];
  /** Tool 执行结果（二次调用时传入） */
  toolMessages?: ToolMessage[];
}

// send() 中：
const body: any = { model, messages, stream: true };
if (options.tools?.length) {
  body.tools = options.tools;
}
```

解析 SSE 时新增 tool_calls 解析：

```typescript
// 解析 delta.tool_calls
if (delta.tool_calls) {
  // 累积 tool_call 信息
  for (const tc of delta.tool_calls) {
    // 合并 streaming 的 function name 和 arguments
  }
}

// finish_reason === "tool_calls" 时返回
if (finishReason === "tool_calls") {
  return { content: accumulated, toolCalls: collectedToolCalls };
}
```

### 4. SendResult 扩展

```typescript
export interface SendResult {
  content: string;
  sessionId?: string;
  usage?: TokenUsage;
  meta?: StreamMeta;
  /** AI 请求调用 tools（需要上层处理后二次调用） */
  toolCalls?: ToolCallRequest[];
}

export interface ToolCallRequest {
  id: string;           // tool_call_id
  name: string;         // function name = action name
  arguments: any;       // parsed JSON arguments
}
```

### 5. UI 展示 Tool Call 状态

tool loop 执行时，通过 `onMeta` 回调通知 UI：

```typescript
onMeta?.({
  toolCalls: [{
    toolCallId: tc.id,
    title: `执行 ${tc.name}`,
    kind: "execute",
    status: "in_progress",
    startedAt: Date.now(),
  }],
  activeTool: tc.name,
});
```

这与现有 ChatView 中展示 kiro-cli tool calls 的逻辑复用。

### 6. KiroCliConnector 的处理

KiroCliConnector 通过 ACP 与 kiro-cli 通信。kiro-cli 本身不支持自定义 tools 注入。
方案：继续通过 `memorySupplement` 注入 Nova actions 描述（和现在一样），
但在 ACP 层面，如果 kiro 回复包含 `[ACTION:...]`，sendMessage 层仍执行并二次注入。

**这意味着 kiro-cli 模式下保持旧逻辑作为兼容**，优先改造 OpenAI API 模式。

### 7. 清理旧逻辑

改造完成后：
- `generateNovaIdentityPrompt()` 中关于 `[ACTION:...]` 格式的说明可删除（OpenAI 模式）
- `executeNovaActions(content)` 正则解析逻辑降级为 fallback（仅 kiro-cli 连接器）
- `stripNovaActions()` 同上
- `formatActionResult()` 整个删除（结果由 LLM 自己总结）

## 分阶段实施

### Phase 1: OpenAI Connector 支持 tool_call（最小可用）
1. `SendOptions` / `SendResult` 加 tools/toolCalls 字段
2. `openai-api.ts` 发请求时带 tools，解析 tool_calls 返回
3. `sendMessage.ts` 实现 tool loop（执行 action + 二次调用）
4. 移除 OpenAI 模式下的 `[ACTION:...]` prompt 注入

### Phase 2: UI 联动
5. tool loop 中通过 onMeta 通知 UI 展示执行状态
6. ChatView 复用现有 toolcall 卡片展示

### Phase 3: KiroCliConnector 渐进升级
7. 如果 kiro-cli 未来支持 MCP tool 注入，可将 Nova actions 作为 MCP tools 注册
8. 否则保持 memorySupplement + fallback 正则模式

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `src/connectors/base.ts` | SendOptions 加 tools/toolMessages；SendResult 加 toolCalls |
| `src/connectors/builtin/openai-api.ts` | send() 发送 tools、解析 tool_calls 响应 |
| `src/core/actions.ts` | 新增 generateOpenAITools() |
| `src/core/sendMessage.ts` | 实现 tool loop；根据 connector 类型选择 tool 模式或旧模式 |
| `src/core/actionExecutor.ts` | 旧逻辑降级为 fallback；删除 identity prompt 中的 action 格式说明 |

## 风险与回退

- **回退方案**：改造以 connector 类型区分，kiro-cli 仍走旧路径，不影响主力使用场景
- **并发安全**：tool loop 是同步顺序执行（一次请求中最多一轮 tool_calls），无并发问题
- **Token 消耗**：tool loop 会增加一次 LLM 调用，但只有当 AI 需要调用 action 时才触发
- **超时**：tool loop 最多循环 5 次（防止 LLM 无限调用 tool 的边界情况）
