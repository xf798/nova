// ===== 向后兼容重导出 =====
// 真正的实现已移至 src/core/tools/ 目录。
// 此文件保留以兼容所有现有 import from "./tools" 或 "../core/tools" 的引用。

export {
  toolRegistry,
  toolOrchestrator,
  type OpenAITool,
  type ToolParam,
  type ToolMeta,
  type ToolResult,
  type ToolHandler,
  type ToolDefinition,
  type ToolContext,
  type ToolCategory,
  type ToolScope,
} from "./tools/index";
