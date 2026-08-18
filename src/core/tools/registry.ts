// ===== Nova Tool Registry =====
//
// 统一的 tool 注册中心。Nova 内置能力和插件都通过此机制暴露可调用的 tools。
// LLM 通过 function calling / tool_use 调用这些 tools。

import type { ToolContext, ToolDefinition, ToolScope } from "./types";

// ─── 类型定义 ───

/** OpenAI chat completions API tools 参数格式 */
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
}

export interface ToolMeta {
  name: string;
  description: string;
  params?: ToolParam[];
  returns?: string;
  pluginId: string;
  category?: string;
  internal?: boolean;
  /** Tool 可见范围，默认 "all" */
  scope?: ToolScope;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Tool 执行函数。
 *
 * 第二参数 ctx 携带会话级上下文（当前工作目录等）。声明为可选，
 * 不需要上下文的 handler 照旧只写 params 即可。
 */
export type ToolHandler = (params?: any, ctx?: ToolContext) => Promise<ToolResult>;

interface RegisteredTool {
  handler: ToolHandler;
  meta: ToolMeta;
  /** 增强定义（如有） */
  definition?: ToolDefinition;
}

// ─── Registry 实现 ───

class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  /**
   * 注册 tool
   * @param name 唯一标识
   * @param handler 执行函数
   * @param meta 元信息（ToolMeta 或 ToolDefinition，向后兼容）
   */
  register(name: string, handler: ToolHandler, meta: Omit<ToolMeta, "name"> | ToolDefinition): void {
    const toolMeta: ToolMeta = { ...meta, name } as ToolMeta;
    const definition = "inputSchema" in meta ? (meta as ToolDefinition) : undefined;
    this.tools.set(name, { handler, meta: toolMeta, definition });
  }

  /** 注销 tool */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /** 批量注销某插件的所有 tools */
  unregisterByPlugin(pluginId: string): void {
    for (const [name, reg] of this.tools) {
      if (reg.meta.pluginId === pluginId) {
        this.tools.delete(name);
      }
    }
  }

  /**
   * 调用 tool
   */
  async call(name: string, params?: any, ctx?: ToolContext): Promise<ToolResult> {
    const reg = this.tools.get(name);
    if (!reg) {
      return { ok: false, error: `Tool "${name}" not found` };
    }
    try {
      return await reg.handler(params, ctx);
    } catch (err: any) {
      return { ok: false, error: err.message || "Tool execution failed" };
    }
  }

  /** 列出所有已注册的 tools */
  list(): ToolMeta[] {
    return Array.from(this.tools.values()).map(r => r.meta);
  }

  /** 列出指定 scope 的 tools（用于 MCP 过滤） */
  listByScope(excludeScope?: ToolScope): ToolMeta[] {
    return this.list().filter(m => m.scope !== excludeScope);
  }

  /** 按分类列出 */
  listByCategory(category: string): ToolMeta[] {
    return this.list().filter(m => m.category === category);
  }

  /** 按插件列出 */
  listByPlugin(pluginId: string): ToolMeta[] {
    return this.list().filter(m => m.pluginId === pluginId);
  }

  /** 检查 tool 是否存在 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 获取 tool 元信息 */
  getMeta(name: string): ToolMeta | undefined {
    return this.tools.get(name)?.meta;
  }

  /** 获取增强定义（如有） */
  getDefinition(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  /**
   * 生成 LLM function-calling 格式的 tools 列表
   * 排除 internal tools 和 scope="local" 以外的过滤（MCP 用 listByScope）
   */
  generateToolsSchema(): { name: string; description: string; parameters: object }[] {
    return Array.from(this.tools.values())
      .filter(r => !r.meta.internal)
      .map(r => {
        // 优先使用 inputSchema（JSON Schema 格式）
        if (r.definition?.inputSchema) {
          return {
            name: r.meta.name,
            description: r.meta.description,
            parameters: r.definition.inputSchema,
          };
        }
        // Fallback: 从 params[] 构建
        return {
          name: r.meta.name,
          description: r.meta.description,
          parameters: {
            type: "object",
            properties: Object.fromEntries(
              (r.meta.params || []).map(p => [p.name, {
                type: p.type,
                description: p.description,
                ...(p.enum ? { enum: p.enum } : {}),
                ...(p.default !== undefined ? { default: p.default } : {}),
              }])
            ),
            required: (r.meta.params || []).filter(p => p.required).map(p => p.name),
          },
        };
      });
  }

  /**
   * 生成 OpenAI chat completions API 的 tools 参数格式
   */
  generateOpenAITools(): OpenAITool[] {
    return this.generateToolsSchema().map(t => ({
      type: "function" as const,
      function: t,
    }));
  }

  /**
   * 生成 LLM 可消费的 tool 文档（Markdown 格式）
   */
  generateToolDoc(): string {
    const metas = this.list();
    if (metas.length === 0) return "暂无可用的 tool。";

    const grouped = new Map<string, ToolMeta[]>();
    for (const m of metas) {
      const cat = m.category || "other";
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push(m);
    }

    let doc = "# Nova Tools\n\n以下是当前可调用的 tools。\n\n";
    for (const [cat, tools] of grouped) {
      doc += `## ${cat}\n\n`;
      for (const t of tools) {
        doc += `### \`${t.name}\`\n${t.description}\n`;
        if (t.params?.length) {
          doc += "| 参数 | 类型 | 必填 | 说明 |\n|------|------|------|------|\n";
          for (const p of t.params) {
            doc += `| ${p.name} | ${p.type} | ${p.required ? "✅" : "❌"} | ${p.description} |\n`;
          }
        }
        if (t.returns) doc += `\n返回: ${t.returns}\n`;
        doc += "\n";
      }
    }
    return doc;
  }
}

// 全局单例
export const toolRegistry = new ToolRegistry();
