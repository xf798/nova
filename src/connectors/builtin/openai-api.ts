// ===== 通用 OpenAI-Compatible API 连接器 =====
//
// 对接任何 OpenAI 兼容 API（OpenAI、Claude via proxy、Ollama、DeepSeek 等）。
// 支持 SSE 流式输出 + function calling（tool_call）。

import type { Connector, ConnectorConfig, ConnectorCapabilities, SendOptions, SendResult, TokenUsage, ToolCallRequest, StreamMeta } from "../base";
import { TimelineBuilder } from "../timeline";

/** 流式累积的 tool_call 片段 */
interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;  // JSON string，流式拼接
}

export class OpenAIConnector implements Connector {
  readonly config: ConnectorConfig;
  readonly capabilities: ConnectorCapabilities = {
    nativeSession: false,
    needsHistory: true,
    supportsModelSwitch: true,
    needsMemorySupplement: false,
  };
  private abortController: AbortController | null = null;
  currentModel?: string;

  constructor(config: Partial<ConnectorConfig>) {
    this.config = {
      id: config.id || "openai-api",
      name: config.name || "OpenAI API",
      type: "api",
      icon: config.icon || "",
      description: config.description || "OpenAI-compatible API",
      enabled: config.enabled ?? true,
      apiEndpoint: config.apiEndpoint || "https://api.openai.com/v1",
      apiKey: config.apiKey || "",
      model: config.model || "gpt-4o",
      ...config,
    };
    this.currentModel = this.config.model;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.config.apiEndpoint || !this.config.apiKey) return false;
    try {
      const resp = await fetch(`${this.config.apiEndpoint}/models`, {
        headers: { "Authorization": `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async send(
    input: string,
    options: SendOptions,
    onChunk: (content: string) => void,
    onMeta?: (meta: import("../base").StreamMeta) => void,
  ): Promise<SendResult> {
    if (!this.config.apiEndpoint || !this.config.apiKey) {
      const err = "[错误] 未配置 API endpoint 或 key";
      onChunk(err);
      return { content: err };
    }

    this.abortController = new AbortController();

    const messages: { role: string; content?: string; tool_calls?: any[]; tool_call_id?: string }[] = [];

    // 注入历史上下文
    if (options.history) {
      for (const msg of options.history) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // 如果是 tool loop 二次调用，追加 assistant tool_calls + tool results
    if (options.toolMessages && options.toolMessages.length > 0) {
      // toolMessages 已包含完整的 assistant message（带 tool_calls）和 tool result messages
      // 由上层 sendMessage 构建好传入
      for (const tm of options.toolMessages) {
        messages.push(tm as any);
      }
    } else if (input) {
      // 首次调用，添加用户消息
      messages.push({ role: "user", content: input });
    }

    const model = this.currentModel || this.config.model || "gpt-4o";
    let accumulated = "";

    // 构建请求 body
    const body: Record<string, any> = { model, messages, stream: true };
    // stream_options 仅 OpenAI 官方 API 支持，智谱等第三方兼容 API 不支持
    // 智谱等 provider 在最后一个 chunk 中会自带 usage，无需 stream_options
    const endpoint = this.config.apiEndpoint || "";
    const isOfficialOpenAI = endpoint.includes("api.openai.com");
    if (isOfficialOpenAI) {
      body.stream_options = { include_usage: true };
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
    }

    console.log(`[OpenAI Connector] → 发送请求: endpoint=${this.config.apiEndpoint}, model=${model}, connectorId=${this.config.id}, connectorName=${this.config.name}, messages=${messages.length}条, hasTools=${!!(options.tools && options.tools.length)}`);

    try {
      const resp = await fetch(`${this.config.apiEndpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });

      console.log(`[OpenAI Connector] ← 响应状态: ${resp.status} ${resp.statusText}, endpoint=${this.config.apiEndpoint}`);

      if (!resp.ok) {
        const errText = await resp.text();
        const errMsg = `[API 错误 ${resp.status}] ${errText.slice(0, 200)}`;
        onChunk(errMsg);
        return { content: errMsg };
      }

      // SSE 流式解析
      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        onChunk("[错误] 无法获取响应流");
        return { content: "[错误] 无法获取响应流" };
      }

      let buffer = "";
      let usage: TokenUsage | undefined;
      let finishReason: string | null = null;
      let thoughtAccumulated = "";  // reasoning_content 思考过程累积

      // ─── 过程时间线 ───
      // 与 kiro-cli 共用 TimelineBuilder，保证两条路径语义一致。
      // OpenAI 兼容 API 的工具调用由上层 sendMessage 的 tool loop 驱动，
      // 不在此处产生 tool 事件。
      const tl = new TimelineBuilder();

      /** 统一产出 meta（思考全量 + timeline 快照） */
      const emitMeta = () => {
        if (!onMeta) return;
        const meta: StreamMeta = {};
        if (thoughtAccumulated) meta.thought = thoughtAccumulated;
        if (!tl.isEmpty) meta.timeline = tl.snapshot();
        onMeta(meta);
      };

      /** 组装最终 meta（无内容时返回 undefined，保持原有语义） */
      const buildFinalMeta = (): StreamMeta | undefined => {
        const meta: StreamMeta = {};
        if (thoughtAccumulated) meta.thought = thoughtAccumulated;
        if (!tl.isEmpty) meta.timeline = tl.snapshot();
        return Object.keys(meta).length > 0 ? meta : undefined;
      };

      // tool_calls 累积器
      const toolCallAccumulators: Map<number, ToolCallAccumulator> = new Map();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") break;

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;

            // 文本内容
            if (delta?.content) {
              accumulated += delta.content;
              tl.appendText(delta.content);
              onChunk(accumulated);
              emitMeta();
            }

            // reasoning_content（思考过程，如智谱 GLM thinking 模式、DeepSeek 等）
            if (delta?.reasoning_content) {
              thoughtAccumulated += delta.reasoning_content;
              tl.appendThought(delta.reasoning_content);
              emitMeta();
            }

            // tool_calls 流式解析
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallAccumulators.has(idx)) {
                  toolCallAccumulators.set(idx, {
                    id: tc.id || "",
                    name: tc.function?.name || "",
                    arguments: "",
                  });
                }
                const acc = toolCallAccumulators.get(idx)!;
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.arguments += tc.function.arguments;
              }
            }

            // finish_reason
            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            // usage（通常出现在最后一个 chunk）
            if (parsed.usage) {
              usage = {
                inputTokens: parsed.usage.prompt_tokens,
                outputTokens: parsed.usage.completion_tokens,
                totalTokens: parsed.usage.total_tokens,
              };
            }
          } catch {
            // 忽略解析失败的行
          }
        }
      }

      // 如果有 tool_calls 累积（finish_reason 可能是 "tool_calls" 或 "stop"，取决于 provider）
      if (toolCallAccumulators.size > 0 && (finishReason === "tool_calls" || finishReason === "stop")) {
        const toolCalls: ToolCallRequest[] = [];
        for (const [, acc] of toolCallAccumulators) {
          let args: any = {};
          try {
            args = acc.arguments ? JSON.parse(acc.arguments) : {};
          } catch {
            args = {};
          }
          toolCalls.push({
            id: acc.id,
            name: acc.name,
            arguments: args,
          });
        }

        console.log(`[OpenAI] ← tool_calls: ${toolCalls.map(t => t.name).join(", ")}`);
        tl.closeSegment();
        return { content: accumulated, toolCalls, usage, meta: buildFinalMeta() };
      }

      tl.closeSegment();
      return { content: accumulated, usage, meta: buildFinalMeta() };
    } catch (e: any) {
      if (e.name === "AbortError") {
        return { content: accumulated || "" };
      }
      const errMsg = `[请求失败] ${e.message}`;
      onChunk(errMsg);
      return { content: errMsg };
    } finally {
      this.abortController = null;
    }
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  setModel(modelId: string): void {
    this.currentModel = modelId;
  }

  async listModels(): Promise<{ models: { model_name: string; model_id: string; description: string; context_window_tokens: number; rate_multiplier: number; rate_unit: string }[]; defaultModel: string }> {
    if (!this.config.apiEndpoint || !this.config.apiKey) {
      return { models: [], defaultModel: this.config.model || "gpt-4o" };
    }
    try {
      const resp = await fetch(`${this.config.apiEndpoint}/models`, {
        headers: { "Authorization": `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return { models: [], defaultModel: this.config.model || "gpt-4o" };
      const data = await resp.json();
      const models = (data.data || []).map((m: any) => ({
        model_name: m.id,
        model_id: m.id,
        description: m.owned_by || "",
        context_window_tokens: 0,
        rate_multiplier: 0,
        rate_unit: "",
      }));
      return { models, defaultModel: this.config.model || "gpt-4o" };
    } catch {
      return { models: [], defaultModel: this.config.model || "gpt-4o" };
    }
  }
}
