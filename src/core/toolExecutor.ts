// ===== Nova Tool Executor =====
//
// 从 AI 回复中解析 [ACTION:name {params}] 指令并执行（legacy fallback）。
// 新的 tool_call 模式下不再需要文本解析，此模块仅供 kiro-cli 连接器兼容使用。

import { toolRegistry } from "./tools";
import type { ToolResult } from "./tools";

export interface ToolExecResult {
  tool: string;
  result: ToolResult;
}

/**
 * 解析 AI 回复中的 tool 调用指令并执行（legacy fallback）
 *
 * 支持格式：[ACTION:name {params}]
 * 注意：仅在非 tool_call 模式（kiro-cli）下使用
 */
export async function executeInlineToolCalls(content: string): Promise<ToolExecResult[]> {
  const results: ToolExecResult[] = [];
  const pattern = /\[ACTION:([a-zA-Z][a-zA-Z0-9_.]*)\s*(\{[^}]*\})?\s*\]/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const toolName = match[1];
    const paramsStr = match[2];

    let params: any = undefined;
    if (paramsStr) {
      try {
        params = JSON.parse(paramsStr);
      } catch {
        results.push({
          tool: toolName,
          result: { ok: false, error: `参数解析失败: ${paramsStr}` },
        });
        continue;
      }
    }

    const result = await toolRegistry.call(toolName, params);
    results.push({ tool: toolName, result });
  }

  return results;
}

/**
 * 从内容中移除已执行的 tool 指令（清理显示）
 */
export function stripInlineToolCalls(content: string): string {
  return content.replace(/\[ACTION:[a-zA-Z][a-zA-Z0-9_.]*\s*(?:\{[^}]*\})?\s*\]\n?/g, "").trim();
}

/**
 * 生成 Nova 身份声明（告诉 LLM 它运行在 Nova 桌面应用中）
 */
export function generateNovaIdentityPrompt(): string {
  return `<nova_runtime>
你当前运行在 Nova 桌面应用中（Tauri + React）。Nova 是一个 AI Native 工作台，你不仅是聊天助手，还可以通过 tool 调用来操控 Nova 的 UI 和功能。
Nova 的能力已通过 MCP Server 注册为你可调用的 tools（如 autoprogram.getState、ui.screenshot 等），需要时直接使用 tool_call 调用即可。
</nova_runtime>`;
}
