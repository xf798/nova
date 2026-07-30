// ===== Nova Tool 框架类型定义 =====

/** Tool 类别 */
export type ToolCategory =
  | "coding"
  | "ui"
  | "system"
  | "connector"
  | "chat"
  | "skill"
  | "agent"
  | string;

/** Tool 可见范围 */
export type ToolScope =
  | "all"    // 对所有通路可见（OpenAI tool_call + MCP Server）
  | "local"; // 仅 OpenAI connector 的 tool_call 可见，MCP 不暴露

/** Tool 定义（增强版，向后兼容 ToolMeta） */
export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  pluginId: string;

  // 参数 schema（两种格式，inputSchema 优先）
  params?: import("./registry").ToolParam[];
  /** 标准 JSON Schema，优先于 params 用于 OpenAI function calling */
  inputSchema?: {
    type: "object";
    properties?: Record<string, any>;
    required?: string[];
  };

  // 行为标记
  /** 是否只读（不修改文件系统/系统状态） */
  isReadOnly?: boolean;
  /** 是否可并行执行 */
  isConcurrencySafe?: boolean;
  /** 最大结果字符数（超过截断，默认 50000） */
  maxResultChars?: number;

  // 可见性
  /** 不暴露给 LLM function calling（仅 MCP 通道可用） */
  internal?: boolean;
  /** 可见范围，默认 "all" */
  scope?: ToolScope;
  /** 是否启用 */
  enabled?: boolean;

  // 返回值说明（可选）
  returns?: string;
}

/** Tool 执行上下文 */
export interface ToolContext {
  /** 当前工作目录 */
  cwd: string;
  /** 调用来源标识 */
  callerId?: string;
  /** 取消信号 */
  signal?: AbortSignal;
}
