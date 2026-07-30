// ===== 长期记忆提取器（Side Query） =====
//
// 对标 Claude Code 的 Auto Memory 机制：
// 不是用独立管道扫描对话，而是在对话过程中用 side query 让模型
// 自主判断"什么值得记住"，然后结构化写入 LongTermMemoryStore。
//
// 触发策略（简化版 Claude Code）：
// - 每 N 轮对话（1 轮 = 1 次用户消息 + 1 次助手回复）触发一次
// - 只处理自上次提取以来的新消息（增量提取）
// - 去重：与已有记忆做内容相似度检查
//
// 使用方式：
//   import { tryExtractMemories } from "./extractor";
//   const saved = await tryExtractMemories(messages, memory, connector);
//   // saved = 新写入的记忆条数

import type { Connector } from "../../connectors/base";
import type { Message } from "../types";
import type { SessionMemory, MemoryConfig } from "./index";
import { memoryManager } from "./index";
import { longTermMemory } from "./longterm";
import type { LongTermMemory, MemoryCategory } from "./longterm";

/** 提取出的单条记忆（模型输出） */
interface ExtractedMemory {
  category: MemoryCategory;
  content: string;
  tags: string[];
}

/** 单次提取上限，避免模型一次输出过多 */
const MAX_EXTRACT_PER_RUN = 5;

/** 提取结果 */
export interface ExtractionResult {
  /** 是否真正执行了提取（达到触发阈值） */
  triggered: boolean;
  /** 新写入的记忆条数 */
  saved: number;
  /** 本次提取处理到的轮数（调用方据此更新 extractedTurns） */
  processedTurns: number;
}

/**
 * 尝试从对话中提取长期记忆
 *
 * @param messages 当前会话所有消息
 * @param memory 当前会话记忆状态
 * @param connector 用于 side query 的连接器
 * @param config 记忆配置
 * @returns 提取结果
 */
export async function tryExtractMemories(
  messages: Message[],
  memory: SessionMemory | undefined,
  connector: Connector,
  config?: MemoryConfig,
): Promise<ExtractionResult> {
  const cfg = config || memoryManager.getConfig();
  const NOT_TRIGGERED: ExtractionResult = { triggered: false, saved: 0, processedTurns: 0 };
  if (!cfg.autoExtractMemories) return NOT_TRIGGERED;

  // 计算未提取的对话轮数
  const dialogMessages = messages.filter(
    m => m.role === "user" || m.role === "assistant",
  );
  const totalTurns = Math.floor(dialogMessages.length / 2);
  const extractedTurns = memory?.extractedTurns || 0;
  const unextractedTurns = totalTurns - extractedTurns;

  console.log(`[Nova:MemExtract] entry: totalMessages=${messages.length}, extractedTurns=${extractedTurns}, unextractedTurns=${unextractedTurns}`);
  console.log(`[Memory Extractor] 检查是否需要提取记忆: totalTurns=${totalTurns}, extractedTurns=${extractedTurns}, unextracted=${unextractedTurns}, interval=${cfg.extractInterval}`);

  // 未达到触发间隔
  if (unextractedTurns < cfg.extractInterval) {
    console.log(`[Nova:MemExtract] NOT_TRIGGERED: unextractedTurns(${unextractedTurns}) < extractInterval(${cfg.extractInterval})`);
    return NOT_TRIGGERED;
  }

  // 取未提取的消息片段
  const startIdx = extractedTurns * 2; // 每轮 2 条消息
  const newMessages = dialogMessages.slice(startIdx);

  if (newMessages.length < 2) return NOT_TRIGGERED; // 至少要有一轮完整对话

  console.log(`[Nova:MemExtract] start extraction: messageRange=[${startIdx}, ${startIdx + newMessages.length - 1}], count=${newMessages.length}`);

  // 获取已有记忆用于去重
  const existing = await longTermMemory.getAll();

  console.log(`[Memory Extractor] ⏳ 触发记忆提取 | 新消息: ${newMessages.length}条 | 已有记忆: ${existing.length}条`);

  // 构建 prompt
  const prompt = buildExtractionPrompt(newMessages, existing);

  try {
    // side query：不传 sessionId，一次性请求
    let raw = "";
    const result = await connector.send(
      prompt,
      {},
      (chunk) => { raw = chunk; },
    );
    raw = result.content;

    // 解析 JSON
    const extracted = parseExtractionResult(raw);
    console.log(`[Nova:MemExtract] side query done: extractedMemories=${extracted.length}`);
    if (extracted.length === 0) {
      return { triggered: true, saved: 0, processedTurns: totalTurns };
    }

    // 去重 + 写入
    let saved = 0;
    for (const mem of extracted.slice(0, MAX_EXTRACT_PER_RUN)) {
      if (!isDuplicate(mem, existing)) {
        await longTermMemory.save(mem.category, mem.content, mem.tags);
        existing.push({
          id: `temp-${saved}`,
          category: mem.category,
          content: mem.content,
          tags: mem.tags,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        saved++;
      }
    }

    console.log(`[Nova:MemExtract] after dedup: savedMemories=${saved}`);
    console.log(`[Memory Extractor] ✅ 提取完成: saved=${saved}条新记忆`);
    return { triggered: true, saved, processedTurns: totalTurns };
  } catch (e) {
    console.error("[MemoryExtractor] failed:", e);
    return { triggered: true, saved: 0, processedTurns: totalTurns };
  }
}

/**
 * 构建记忆提取 prompt
 *
 * 遵循 Claude Code 的原则：
 * - 明确什么该存、什么不该存
 * - 要求结构化 JSON 输出
 * - 给出已有记忆避免重复
 */
function buildExtractionPrompt(messages: Message[], existing: LongTermMemory[]): string {
  // 对话文本（截断单条消息避免过长）
  const dialog = messages
    .map(m => `${m.role === "user" ? "用户" : "助手"}: ${m.content.slice(0, 800)}`)
    .join("\n");

  // 已有记忆摘要（让模型知道已有什么，避免重复提取）
  const existingSummary = existing.length > 0
    ? existing.slice(0, 20).map((m, i) => `${i + 1}. [${m.category}] ${m.content.slice(0, 100)}`).join("\n")
    : "（暂无）";

  return [
    "你是一个记忆提取器。请分析以下对话，提取值得长期记住的信息。",
    "",
    "只提取以下类型的信息：",
    '- user_preference: 用户偏好、习惯、技术栈选择（如"喜欢用表格展示"、"用 React + Tauri"）',
    '- feedback: 用户对助手的纠正或确认（如"不要用 var"、"对，就这样"）',
    "- project_context: 无法从代码推导的项目信息（截止日期、决策动机、负责人）",
    "- workflow: 常用的工作流程或命令顺序",
    "",
    "不要提取以下信息：",
    "- 代码片段、代码模式（可从代码本身看到）",
    "- 临时调试信息、一次性问题",
    "- 可以从 git 历史或项目文件推导的信息",
    "",
    "已有记忆（避免重复）：",
    existingSummary,
    "",
    "对话内容：",
    dialog,
    "",
    "请以 JSON 数组格式输出，每条记忆包含 category、content、tags 字段。",
    'category 只能是: user_preference, feedback, project_context, workflow',
    "tags 是字符串数组，用于辅助检索。",
    "如果没有值得记住的信息，返回空数组 []。",
    "只输出 JSON，不要其他文字。",
    "",
    "输出格式示例：",
    '[{"category":"user_preference","content":"用户偏好表格形式展示状态","tags":["ui","format"]}]',
    "",
    "请输出 JSON：",
  ].join("\n");
}

/**
 * 从模型响应中解析 JSON 记忆数组
 *
 * 模型可能输出：
 * - 干净 JSON: [{"category":"...","content":"...","tags":["..."]}]
 * - Markdown 包裹: ```json\n[...]\n```
 * - 带前缀文字: "以下是提取的记忆:\n[...]"
 * - 空结果: [] 或 "没有值得记住的信息"
 */
function parseExtractionResult(raw: string): ExtractedMemory[] {
  const trimmed = raw.trim();

  // 尝试直接解析
  let jsonStr = trimmed;

  // 提取 ```json ... ``` 中的内容
  const mdMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (mdMatch) {
    jsonStr = mdMatch[1].trim();
  } else {
    // 尝试找到第一个 [ 和最后一个 ]
    const firstBracket = trimmed.indexOf("[");
    const lastBracket = trimmed.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      jsonStr = trimmed.slice(firstBracket, lastBracket + 1);
    }
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    const valid: ExtractedMemory[] = [];
    const validCategories: Set<string> = new Set([
      "user_preference", "feedback", "project_context", "workflow",
    ]);

    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const category = item.category;
      const content = String(item.content || "").trim();
      if (!content || !validCategories.has(category)) continue;
      valid.push({
        category: category as MemoryCategory,
        content,
        tags: Array.isArray(item.tags)
          ? item.tags.map((t: unknown) => String(t)).filter(Boolean)
          : [],
      });
    }

    return valid;
  } catch {
    // JSON 解析失败，静默跳过
    return [];
  }
}

/**
 * 去重检查：新记忆是否与已有记忆重复
 *
 * 策略：
 * 1. 完全匹配（忽略大小写和首尾空格）
 * 2. 包含关系（新记忆是已有记忆的子串，或反之）
 * 3. 高重叠率（分词后交集占比 > 60%）
 */
function isDuplicate(newMem: ExtractedMemory, existing: LongTermMemory[]): boolean {
  const newContent = newMem.content.toLowerCase().trim();

  for (const mem of existing) {
    const existContent = mem.content.toLowerCase().trim();

    // 1. 完全匹配
    if (newContent === existContent) return true;

    // 2. 包含关系（短的是长的子串）
    if (newContent.length > 10 && existContent.length > 10) {
      if (newContent.includes(existContent) || existContent.includes(newContent)) {
        return true;
      }
    }

    // 3. 高重叠率（简单分词交集）
    if (newContent.length > 15) {
      const newTokens = new Set(newContent.split(/[\s,，。.、；;:：!！?？]+/).filter(t => t.length >= 2));
      const existTokens = new Set(existContent.split(/[\s,，。.、；;:：!！?？]+/).filter(t => t.length >= 2));
      if (newTokens.size > 0 && existTokens.size > 0) {
        let overlap = 0;
        for (const t of newTokens) {
          if (existTokens.has(t)) overlap++;
        }
        const overlapRatio = overlap / Math.min(newTokens.size, existTokens.size);
        if (overlapRatio > 0.6) return true;
      }
    }
  }

  return false;
}
