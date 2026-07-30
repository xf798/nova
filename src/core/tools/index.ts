// ===== Nova Tools — 向后兼容导出 =====
//
// 此文件保持原 src/core/tools.ts 的导出接口不变，
// 所有现有 import { toolRegistry } from "./tools" 或 "../core/tools" 继续有效。

export {
  toolRegistry,
  type OpenAITool,
  type ToolParam,
  type ToolMeta,
  type ToolResult,
  type ToolHandler,
} from "./registry";

export { toolOrchestrator } from "./orchestrator";
export type { ToolDefinition, ToolContext, ToolCategory, ToolScope } from "./types";
