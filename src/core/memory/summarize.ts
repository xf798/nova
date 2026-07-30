// ===== 摘要服务（分段压缩） =====
//
// 每次压缩只处理被挤出工作记忆窗口的那一段消息，生成独立摘要段。
// 更早的摘要段保持不变——信息保留 + prompt cache 命中。
// 段数超过上限时，最旧的两段自动合并。

import type { Connector } from "../../connectors/base";
import type { Message } from "../types";
import type { SessionMemory } from "./index";
import { memoryManager } from "./index";

/**
 * 尝试对会话进行分段摘要压缩
 *
 * @param messages 当前会话所有消息
 * @param memory 当前记忆状态（含已有摘要链）
 * @param connector 用于调用模型的连接器
 * @returns 更新后的 SessionMemory，或 null（不需要摘要）
 */
export async function trySummarize(
  messages: Message[],
  memory: SessionMemory | undefined,
  connector: Connector
): Promise<SessionMemory | null> {
  console.log(`[Nova:Summarize] entry: messageCount=${messages.length}, summarizedCount=${memory?.summarizedCount ?? 0}`);
  console.log(`[Memory Summarize] 检查是否需要摘要压缩: shouldSummarize=${memoryManager.shouldSummarize(messages, memory)}`);

  if (!memoryManager.shouldSummarize(messages, memory)) {
    console.log(`[Nova:Summarize] skipped: summarization not needed`);
    return null;
  }

  const range = memoryManager.getSummarizeRange(messages, memory);
  if (range.messages.length === 0) return null;

  console.log(`[Nova:Summarize] start: startIndex=${range.startIndex}, endIndex=${range.endIndex}, messageCount=${range.messages.length}`);

  const prompt = memoryManager.buildSummarizePrompt(range.messages);

  try {
    let summary = "";
    const result = await connector.send(
      prompt,
      { /* 一次性请求，不传 sessionId */ },
      (chunk) => { summary = chunk; }
    );
    summary = result.content;

    // 清理可能的前缀
    summary = summary
      .replace(/^(摘要[：:]?\s*)/i, "")
      .trim();

    // 限制单段摘要长度
    const maxChars = memoryManager.getConfig().maxSummaryChars;
    if (summary.length > maxChars) {
      summary = summary.slice(0, maxChars) + "...";
    }

    console.log(`[Nova:Summarize] done: summaryLength=${summary.length}`);

    // 追加为新段，不修改已有段
    const updated = memoryManager.appendSummarySegment(
      summary,
      range.startIndex,
      range.endIndex,
      memory
    );

    console.log(`[Nova:Summarize] appended segment: totalSegments=${updated?.summaryChain?.length ?? 0}`);

    return updated;
  } catch (e) {
    console.error("[Summarize] failed:", e);
    return null;
  }
}
