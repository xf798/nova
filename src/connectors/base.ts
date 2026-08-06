// ===== 连接器接口定义 =====

export type ConnectorType = "cli" | "api" | "bot";

/** IM 机器人平台类型 */
export type BotPlatform = "wecom" | "feishu" | "dingtalk";

export interface ConnectorConfig {
  id: string;
  name: string;
  type: ConnectorType;     // 连接器类型
  icon?: string;           // emoji 或 svg
  description?: string;
  enabled: boolean;
  internal?: boolean;      // 内部连接器（pipeline 等），不在 UI 中展示

  // CLI 类型配置
  command?: string;        // 可执行文件名/路径
  defaultArgs?: string[];  // 默认参数
  cwd?: string;            // 工作目录

  // API 类型配置
  apiEndpoint?: string;    // API base URL (e.g. https://api.openai.com/v1)
  apiKey?: string;         // API key
  model?: string;          // 默认模型 ID

  // Bot 类型配置
  botPlatform?: BotPlatform;  // 机器人平台
  botId?: string;             // 机器人 ID
  botSecret?: string;         // 机器人密钥
  botName?: string;           // 机器人显示名称
  autoConnect?: boolean;      // 启动时自动连接
  /** 企微访问策略：谁能用（访问范围）+ 能做什么（高危能力开关） */
  wecomPolicy?: import("../core/wecomPolicy").WecomPolicy;
}

/** 历史消息（用于上下文传递） */
export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SendOptions {
  sessionId?: string;      // 连接器内部 session (如 kiro --resume-id)
  attachments?: string[];
  /** 对话历史（工作记忆 + 摘要），由上层构建后传入 */
  history?: HistoryMessage[];
  /** 覆盖连接器默认工作目录 */
  cwd?: string;
  /** 跨会话记忆补充（长期记忆，给有 nativeSession 但无跨会话记忆的连接器用） */
  memorySupplement?: string;
  /** Tool 定义列表（OpenAI function calling 格式），由上层传入 */
  tools?: import("../core/tools").OpenAITool[];
  /** Tool 执行结果（tool loop 二次调用时传入） */
  toolMessages?: ToolMessage[];
  /** 内部标志：标记当前为自动重连重试，避免无限递归 */
  _isRetry?: boolean;
  /** 内部标志：prompt Internal error 自动重试计数 */
  _promptRetryCount?: number;
  /** session 创建或恢复后立即回调，用于上层持久化 connectorSessionId（不等 send() 返回） */
  onSessionCreated?: (sessionId: string) => void;
}

/** AI 请求调用的工具（function calling 返回） */
export interface ToolCallRequest {
  id: string;           // tool_call_id（由 LLM 生成）
  name: string;         // function name = action name
  arguments: any;       // parsed JSON arguments
}

/** Tool 执行结果消息（用于二次 LLM 调用） */
export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export interface SendResult {
  content: string;
  sessionId?: string;      // 新创建或复用的 session ID
  usage?: TokenUsage;      // 本次请求消耗的 token/资源点
  meta?: StreamMeta;       // 最终的 metadata（toolcall/thought）
  /** AI 返回的 tool_calls（需要上层执行后二次调用） */
  toolCalls?: ToolCallRequest[];
}

/** Token/资源点消耗信息 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** 资源点（如 Kiro resource points，1 resource point ≈ 若干 tokens） */
  resourcePoints?: number;
}

/** 流式 metadata（与 onChunk 文本流分离的结构化数据通道） */
export interface StreamMeta {
  /** 工具调用状态列表 */
  toolCalls?: StreamToolCall[];
  /** 当前正在执行的工具名称（空字符串表示无） */
  activeTool?: string;
  /** Agent 思考过程（全量累积，供降级渲染与下游消费） */
  thought?: string;
  /**
   * 按真实发生顺序排列的过程事件流。
   *
   * 正文文本、思考、工具调用三类事件交错记录，使 UI 能还原
   * 「文本 → 工具 → 文本 → 思考 → 工具」这样的真实时序，
   * 而不是把思考和工具全部堆到消息顶部。
   *
   * 历史消息没有该字段，渲染层会用 thought + toolCalls + content
   * 现场拼一个近似 timeline（旧数据无文本位置信息，只能近似）。
   */
  timeline?: TimelineEvent[];
}

/** 过程事件：正文片段 */
export interface TimelineTextEvent {
  kind: "text";
  /** 该片段的正文内容（已做流式 markdown 稳定化） */
  text: string;
  /** 片段开始时间 */
  at: number;
}

/** 过程事件：思考片段 */
export interface TimelineThoughtEvent {
  kind: "thought";
  text: string;
  at: number;
  /** 该段思考结束时间（被工具调用或正文打断时封段） */
  endedAt?: number;
}

/** 过程事件：工具调用 */
export interface TimelineToolEvent {
  kind: "tool";
  toolCallId: string;
  title: string;
  /** 工具类别（read / edit / execute / search / other 等） */
  toolKind: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  at: number;
  completedAt?: number;
}

export type TimelineEvent = TimelineTextEvent | TimelineThoughtEvent | TimelineToolEvent;

/** 流式工具调用信息（供 UI 展示） */
export interface StreamToolCall {
  toolCallId: string;
  title: string;
  kind: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
}

/** 模型信息 */
export interface ModelInfo {
  model_name: string;
  model_id: string;
  description: string;
  context_window_tokens: number;
  rate_multiplier: number;
  rate_unit: string;
}

/** 连接器能力声明 */
export interface ConnectorCapabilities {
  /** 是否支持原生 session 恢复（如 kiro --resume-id） */
  nativeSession: boolean;
  /** 是否需要上层传入 history 来维持上下文 */
  needsHistory: boolean;
  /** 是否支持模型切换 */
  supportsModelSwitch: boolean;
  /**
   * 是否需要跨会话记忆补充。
   * 适用于有 nativeSession 但无跨会话记忆的连接器（如 kiro-cli）。
   * 为 true 时，上层会通过 SendOptions.memorySupplement 传入长期记忆，
   * connector 负责注入到请求中（如拼到 input 前面）。
   */
  needsMemorySupplement: boolean;
}

/**
 * 连接器 — 与外部 CLI/API 交互的标准适配器
 * 
 * 每个连接器封装了一种 CLI 工具的交互逻辑：
 * - kiro-cli: AI 模型对话
 * - cursor-cli: Cursor 编辑器
 * - wecom-cli: 企业微信
 * - 未来更多...
 */
export interface Connector {
  readonly config: ConnectorConfig;
  readonly capabilities: ConnectorCapabilities;

  /** 检查 CLI 是否可用 */
  healthCheck(): Promise<boolean>;

  /** 
   * 发送消息，流式回调输出
   * @param input 用户输入
   * @param options 选项（session 复用、历史上下文等）
   * @param onChunk 流式文本回调（每次有新内容时调用，传入当前累积的完整文本）
   * @param onMeta 流式 metadata 回调（toolcall/thought 等结构化数据，独立于文本流）
   * @returns 最终结果
   */
  send(
    input: string,
    options: SendOptions,
    onChunk: (content: string) => void,
    onMeta?: (meta: StreamMeta) => void,
  ): Promise<SendResult>;

  /** 中止当前请求 */
  abort(): void;

  /** 
   * 释放连接器持有的资源（子进程、连接等）。
   * HMR 热更新和应用退出时调用，防止僵尸进程泄漏。
   */
  dispose?(): Promise<void>;

  /** 获取历史 session 列表（可选） */
  listSessions?(): Promise<{ id: string; label: string }[]>;

  /** 获取可用模型列表（可选） */
  listModels?(): Promise<{ models: ModelInfo[]; defaultModel: string }>;

  /** 获取/设置当前模型 */
  currentModel?: string;
  setModel?(modelId: string): void;
}
