// ===== Nova Tool Orchestrator =====
//
// Tool 编排层。sendMessage 的 tool loop 通过此层执行 tool，
// 而非直接调 toolRegistry.call()。
//
// 当前为直通实现，预留 pre/post hook 扩展点。

import { toolRegistry, type ToolResult } from "./registry";
import type { ToolContext } from "./types";

/**
 * Tool 编排器 — 安全检查 + 结果截断 + 扩展点
 */
class ToolOrchestrator {
  /**
   * 执行 tool（经过完整生命周期）
   */
  async execute(
    name: string,
    params: Record<string, any>,
    ctx?: ToolContext,
  ): Promise<ToolResult> {
    const def = toolRegistry.getDefinition(name);

    // tool 不存在：返回友好错误给 AI
    if (!def && !toolRegistry.has(name)) {
      return { ok: false, error: `Tool "${name}" not found. Available tools: ${toolRegistry.list().filter(t => !t.internal).map(t => t.name).join(", ")}` };
    }

    // [扩展点] Pre-hook（future）
    // const blocked = await this.runPreHooks(name, params, ctx);
    // if (blocked) return blocked;

    // 执行
    const result = await toolRegistry.call(name, params, ctx);

    // 结果截断
    if (result.ok && result.data != null) {
      const maxChars = def?.maxResultChars ?? 50000;
      const serialized = typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data);

      if (serialized.length > maxChars) {
        result.data = serialized.slice(0, maxChars) +
          `\n\n[... 输出已截断，共 ${serialized.length} 字符，显示前 ${maxChars} 字符]`;
      }
    }

    // [扩展点] Post-hook（future）
    // await this.runPostHooks(name, params, result, ctx);

    return result;
  }
}

/** 全局单例 */
export const toolOrchestrator = new ToolOrchestrator();
