// ===== 记忆管理器 =====
//
// 三层记忆架构：
// Layer 1: 工作记忆 — 最近 N 条原始消息
// Layer 2: 会话摘要 — 被挤出窗口的消息压缩为摘要
// Layer 3: 长期记忆 — 跨会话知识（longterm.ts）

import type { HistoryMessage } from "../../connectors/base";
import type { Message } from "../types";

/** 记忆配置 */
export interface MemoryConfig {
  /** 工作记忆窗口大小（消息条数） */
  workingMemorySize: number;
  /** 单条消息最大字符数（超出截断） */
  maxMessageChars: number;
  /** 会话摘要最大字符数（单段） */
  maxSummaryChars: number;
  /** 是否启用自动摘要（需要模型调用） */
  autoSummarize: boolean;
  /** 摘要链最大段数（超出则合并最旧的两段） */
  maxSummarySegments: number;
  /** 是否启用自动记忆提取（side query 从对话中提取长期记忆） */
  autoExtractMemories: boolean;
  /** 每隔多少轮对话触发一次记忆提取（1 轮 = 1 次用户消息 + 1 次助手回复） */
  extractInterval: number;
}

const DEFAULT_CONFIG: MemoryConfig = {
  workingMemorySize: 16,
  maxMessageChars: 4000,
  maxSummaryChars: 800,
  autoSummarize: true,
  maxSummarySegments: 5,
  autoExtractMemories: true,
  extractInterval: 3,
};

/** 摘要链中的一个片段 */
export interface SummarySegment {
  /** 摘要文本 */
  summary: string;
  /** 覆盖的消息起始索引（dialog messages 中的位置，从 0 开始） */
  startIndex: number;
  /** 覆盖的消息结束索引（exclusive） */
  endIndex: number;
  /** 生成时间 ISO 字符串 */
  createdAt: string;
  /** 段号（从 1 开始递增） */
  segmentIndex: number;
}

/** 会话记忆状态 */
export interface SessionMemory {
  /** 旧的单一摘要（向后兼容，迁移后不再使用） */
  summary: string | null;
  /** 已被摘要覆盖的消息数 */
  summarizedCount: number;
  /** 摘要链（Layer 2 分段压缩，每段独立） */
  summaryChain?: SummarySegment[];
  /** 已提取长期记忆的对话轮数（用于增量提取，避免重复处理） */
  extractedTurns?: number;
  /** 已蒸馏的对话消息数（用于增量蒸馏，避免重复蒸馏旧消息） */
  distilledMsgCount?: number;
}

/**
 * MemoryManager — 为每次发送构建最优上下文
 * 
 * 使用方式：
 *   const context = memoryManager.buildContext(session.messages, sessionMemory);
 *   connector.send(input, { history: context });
 */
export class MemoryManager {
  private config: MemoryConfig;

  constructor(config?: Partial<MemoryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 构建发送给模型的上下文
   *
   * Prompt Cache 优化：上下文分为 stable + variable 两层。
   * stable 层在前（几乎不变 → 高 cache 命中率），variable 层在后（每次可变 → cache miss 可接受）。
   *
   * 消息顺序：
   *   [stable system] → [variable system] → [session summary] → [working memory]
   *
   * @param messages 当前会话的所有消息
   * @param memory 会话记忆状态（摘要等）
   * @param stableSystemCtx 固定 system 上下文（always-active skills + user_preference 记忆）
   * @param variableSystemCtx 可变 system 上下文（query 相关回忆 + path-matched skills）
   * @returns 构建好的 HistoryMessage 数组
   */
  buildContext(
    messages: Message[],
    memory?: SessionMemory,
    stableSystemCtx?: string | null,
    variableSystemCtx?: string | null,
  ): HistoryMessage[] {
    const context: HistoryMessage[] = [];

    console.log(`[Memory] buildContext: messages=${messages.length}条, stableCtx=${stableSystemCtx?.length || 0}字符, variableCtx=${variableSystemCtx?.length || 0}字符`);
    console.log(`[Memory] buildContext 开始:`);
    console.log(`[Memory]   messages: ${messages.length} 条`);
    console.log(`[Memory]   memory.summaryChain: ${memory?.summaryChain?.length || 0} 段`);
    console.log(`[Memory]   memory.summarizedCount: ${memory?.summarizedCount || 0}`);
    console.log(`[Memory]   stableSystemCtx: ${stableSystemCtx?.length || 0} 字符`);
    console.log(`[Memory]   variableSystemCtx: ${variableSystemCtx?.length || 0} 字符`);

    // Stable 层：固定 system 上下文（高 cache 命中）
    if (stableSystemCtx) {
      context.push({ role: "system", content: stableSystemCtx });
    }

    // Variable 层：可变 system 上下文（每次可能不同）
    if (variableSystemCtx) {
      context.push({ role: "system", content: variableSystemCtx });
    }

    // Layer 2: 注入会话摘要
    // 优先使用 summaryChain（分段摘要），最近在前；回退到旧 summary（向后兼容）
    if (memory?.summaryChain && memory.summaryChain.length > 0) {
      const segments = [...memory.summaryChain].reverse(); // 最近在前
      const chainText = segments
        .map(seg => `[摘要 #${seg.segmentIndex}] ${seg.summary}`)
        .join("\n\n");
      context.push({
        role: "system",
        content: `[对话摘要]\n${chainText}`,
      });
      console.log(`[Memory]   注入摘要链: ${segments.length} 段, ${chainText.length} 字符`);
    } else if (memory?.summary) {
      context.push({
        role: "system",
        content: `[对话摘要] ${memory.summary}`,
      });
      console.log(`[Memory]   注入旧摘要: ${memory.summary.length} 字符`);
    }

    // Layer 1: 取最近 N 条消息作为工作记忆
    const relevantMessages = messages
      .filter(m => m.content !== "$$LOADING$$") // 排除加载占位
      .filter(m => m.role === "user" || m.role === "assistant"); // 只要对话消息

    const windowStart = Math.max(0, relevantMessages.length - this.config.workingMemorySize);
    const window = relevantMessages.slice(windowStart);

    for (const msg of window) {
      context.push({
        role: msg.role as "user" | "assistant",
        content: this.truncateContent(msg.content),
      });
    }

    console.log(`[Memory]   工作记忆窗口: ${window.length}/${relevantMessages.length} 条 (windowSize=${this.config.workingMemorySize})`);
    console.log(`[Memory]   最终 context: ${context.length} 条消息`);
    console.log(`[Memory] buildContext 结果: ${context.length}条 history (system=${context.filter(c => c.role === 'system').length}, user/assistant=${context.filter(c => c.role !== 'system').length})`);

    return context;
  }

  /**
   * 判断是否需要触发摘要压缩
   */
  shouldSummarize(messages: Message[], memory?: SessionMemory): boolean {
    if (!this.config.autoSummarize) return false;
    const dialogCount = messages.filter(m => m.role === "user" || m.role === "assistant").length;
    const summarized = memory?.summarizedCount || 0;
    // 当未被摘要覆盖的消息超过窗口大小的 1.5 倍时触发
    return (dialogCount - summarized) > this.config.workingMemorySize * 1.5;
  }

  /**
   * 获取需要被摘要的消息片段及其索引范围
   */
  getSummarizeRange(messages: Message[], memory?: SessionMemory): {
    messages: Message[];
    startIndex: number;
    endIndex: number;
  } {
    const dialogMessages = messages.filter(m => m.role === "user" || m.role === "assistant");
    const summarized = memory?.summarizedCount || 0;
    const windowStart = Math.max(0, dialogMessages.length - this.config.workingMemorySize);
    return {
      messages: dialogMessages.slice(summarized, windowStart),
      startIndex: summarized,
      endIndex: windowStart,
    };
  }

  /**
   * 获取需要被摘要的消息片段（向后兼容）
   */
  getMessagesToSummarize(messages: Message[], memory?: SessionMemory): Message[] {
    const dialogMessages = messages.filter(m => m.role === "user" || m.role === "assistant");
    const summarized = memory?.summarizedCount || 0;
    const windowStart = Math.max(0, dialogMessages.length - this.config.workingMemorySize);
    // 返回从上次摘要位置到窗口起始位置的消息
    return dialogMessages.slice(summarized, windowStart);
  }

  /**
   * 生成摘要 prompt（给模型用）
   * 每段独立压缩，不合并已有摘要——保留历史段不变
   */
  buildSummarizePrompt(messages: Message[]): string {
    const dialog = messages
      .map(m => `${m.role === "user" ? "用户" : "助手"}: ${this.truncateContent(m.content, 500)}`)
      .join("\n");

    return (
      "请将以下对话片段压缩为简洁的摘要（2-4句话），保留关键决策、结论和重要信息。\n" +
      "只总结这段对话的内容，不需要关联之前的对话历史。\n\n" +
      dialog +
      "\n\n请输出摘要："
    );
  }

  /**
   * 将新的摘要段追加到摘要链
   *
   * 每次压缩只处理被挤出窗口的那一段消息，生成独立的摘要段。
   * 更早的段保持不变（信息保留 + prompt cache 命中）。
   * 段数超过 maxSummarySegments 时，合并最旧的两段。
   *
   * @param summary 新段摘要文本
   * @param startIndex 消息起始索引
   * @param endIndex 消息结束索引（exclusive）
   * @param memory 当前记忆状态（可能为空）
   * @returns 更新后的 SessionMemory
   */
  appendSummarySegment(
    summary: string,
    startIndex: number,
    endIndex: number,
    memory?: SessionMemory
  ): SessionMemory {
    const existingChain = memory?.summaryChain || [];
    const nextSegmentIndex = existingChain.length > 0
      ? existingChain[existingChain.length - 1].segmentIndex + 1
      : 1;

    const newSegment: SummarySegment = {
      summary,
      startIndex,
      endIndex,
      createdAt: new Date().toISOString(),
      segmentIndex: nextSegmentIndex,
    };

    let chain = [...existingChain, newSegment];

    // 超过最大段数：合并最旧的两段
    while (chain.length > this.config.maxSummarySegments) {
      const [oldest, second, ...rest] = chain;
      const merged: SummarySegment = {
        summary: `${oldest.summary} ${second.summary}`,
        startIndex: oldest.startIndex,
        endIndex: second.endIndex,
        createdAt: second.createdAt,
        segmentIndex: oldest.segmentIndex,
      };
      chain = [merged, ...rest];
    }

    return {
      summary: memory?.summary ?? null, // 保留旧字段（向后兼容）
      summarizedCount: endIndex,
      summaryChain: chain,
    };
  }

  /** 截断过长内容 */
  private truncateContent(content: string, maxChars?: number): string {
    const limit = maxChars || this.config.maxMessageChars;
    if (content.length <= limit) return content;
    return content.slice(0, limit) + "...[截断]";
  }

  /** 更新配置 */
  updateConfig(config: Partial<MemoryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** 获取当前配置 */
  getConfig(): MemoryConfig {
    return { ...this.config };
  }
}

// 全局单例
export const memoryManager = new MemoryManager();
