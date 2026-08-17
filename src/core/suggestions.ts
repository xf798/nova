// ===== 新会话建议 =====
//
// 新会话首页原先是四条固定泛用语（「帮我分析一下这个问题」之类），
// 没有上下文、基本不会被点。现在从本地已有的结构化数据派生出具体建议。
//
// 全部为确定性拼装，不调模型：素材本身已是结构化的（任务有标题、
// workflow 记忆有流程名），模板拼接即可得到具体文案。
// 好处是零延迟、零成本、措辞稳定；代价是措辞不如模型润色自然。
//
// 宁缺勿滥：素材不足时就少给几条，不用泛用语凑满——凑数反而降低可信度。

import { taskManager, buildTaskPrompt } from "./task";
import { longTermMemory } from "./memory/longterm";
import type { ChatSession } from "./types";

/** 建议项：点击后或发消息，或跳转到已有会话 */
export type Suggestion =
  | { kind: "task"; label: string; prompt: string }
  | { kind: "workflow"; label: string; prompt: string }
  | { kind: "session"; label: string; sessionId: string };

/** 建议总数上限 */
const MAX_SUGGESTIONS = 4;
/** 未完成任务最多取几条 */
const MAX_TASKS = 2;
/** workflow 记忆最多取几条 */
const MAX_WORKFLOWS = 2;

/**
 * 从 workflow 记忆内容中抽取流程名。
 *
 * workflow 记忆的写法通常是「<流程名>：<步骤细节>」或「<流程名>:<细节>」，
 * 取分隔符前那段作为流程名；没有分隔符则截取前若干字。
 */
export function extractWorkflowName(content: string): string {
  const cut = content.search(/[：:]/);
  const head = cut > 0 ? content.slice(0, cut) : content;
  const trimmed = head.trim();
  if (!trimmed) return "";
  return trimmed.length > 24 ? trimmed.slice(0, 24) + "…" : trimmed;
}

/**
 * 标题兜底截断。
 *
 * 实际省略由 CSS truncate 按像素宽度处理（比按字符数更准），
 * 这里只防止异常长的标题进入 DOM。
 */
function clip(s: string, n = 60): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/**
 * 派生新会话建议。
 *
 * 优先级：未完成任务 → 最近会话 → workflow 记忆。
 * 纯本地读取，无网络与模型调用。
 *
 * @param sessions 会话列表（用于「继续上次」）
 * @param currentSessionId 当前会话，需排除自身
 */
export async function buildSuggestions(
  sessions: ChatSession[],
  currentSessionId?: string | null,
): Promise<Suggestion[]> {
  const out: Suggestion[] = [];

  // 1. 未完成任务：按截止日期升序，无截止的排后面
  try {
    const tasks = await taskManager.getAll();
    const pending = tasks
      .filter(t => t.status === "pending" || t.status === "in_progress")
      .sort((a, b) => {
        if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return 0;
      })
      .slice(0, MAX_TASKS);

    for (const t of pending) {
      out.push({
        kind: "task",
        label: clip(t.title),
        // 与 Tasks 页「发送到新会话」共用拼装，措辞保持一致
        prompt: buildTaskPrompt(t),
      });
    }
  } catch (e) {
    console.warn("[Suggestions] 读取任务失败:", e);
  }

  // 2. 最近一个有内容的会话（排除当前空会话）
  try {
    const recent = sessions
      .filter(s => s.id !== currentSessionId && s.title && s.title !== "新对话")
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
    if (recent) {
      out.push({
        kind: "session",
        label: clip(recent.title),
        sessionId: recent.id,
      });
    }
  } catch (e) {
    console.warn("[Suggestions] 读取会话失败:", e);
  }

  // 3. workflow 记忆：可复现的流程
  try {
    const mems = await longTermMemory.getAll();
    const workflows = mems
      .filter(m => m.category === "workflow")
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
      .slice(0, MAX_WORKFLOWS * 2); // 多取一些，抽名失败时有余量

    let added = 0;
    for (const m of workflows) {
      if (added >= MAX_WORKFLOWS) break;
      const name = extractWorkflowName(m.content);
      if (!name) continue;
      out.push({
        kind: "workflow",
        label: clip(name),
        prompt: `按记录的流程执行：${name}`,
      });
      added++;
    }
  } catch (e) {
    console.warn("[Suggestions] 读取记忆失败:", e);
  }

  return sortForDisplay(out.slice(0, MAX_SUGGESTIONS));
}

/**
 * 展示顺序：文案由长到短向下排列。
 *
 * 胶囊宽度随文字走，随机长短会让右边缘参差不齐；长的在上、短的在下形成单调收窄的
 * 阶梯，右边缘有了方向感，扫读时视线也自然从上往下收。
 *
 * 只影响呈现，不动 buildSuggestions 的取材优先级（任务 → 会话 → 流程）：
 * 优先级决定「谁入选」，长度决定「怎么摆」。等长时保持原有相对顺序（sort 稳定）。
 */
export function sortForDisplay(suggestions: Suggestion[]): Suggestion[] {
  return [...suggestions].sort((a, b) => b.label.length - a.label.length);
}
