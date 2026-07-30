// ===== 会话经验蒸馏 — 主流程 =====
//
// distillSessions(sessionIds) → DistillResult（不落盘，交审阅面板）
//
// 增量蒸馏：每个会话记 distilledMsgCount 水位线（存 SessionMemory），
// 每次只蒸馏水位线之后的新消息，蒸馏跑完推进水位线。避免重复蒸馏旧消息。
// force=true 时忽略水位线，全量重蒸。
//
// 跑在临时 connector 上（createTemporary("distill-bg")），静默失败。
// 长会话用 map-reduce：先分段摘要，再汇总蒸馏，避免爆上下文。

import type { Connector } from "../../connectors/base";
import type { Message } from "../types";
import type { SessionMemory } from "../memory";
import { useSessionStore } from "../sessionStore";
import { sessionStorage } from "../sessionStorage";
import { longTermMemory } from "../memory/longterm";
import { skillRegistry } from "../skills/skillRegistry";
import { ensureSkillsLoaded } from "../skills/skillLoader";
import { buildDistillPrompt, formatDialog, parseDistillResult } from "./prompt";
import { DEFAULT_DISTILL_CONFIG, emptyDistillResult } from "./types";
import type { DistillConfig, DistillResult } from "./types";
import { getDistillConfig } from "./config";

/** 单段字符上限：超过则触发 map-reduce 分段摘要 */
const MAX_DIALOG_CHARS = 12000;
/** 每段消息条数 */
const SEGMENT_SIZE = 12;

export interface DistillOptions {
  /** 覆盖配置 */
  config?: Partial<DistillConfig>;
  /** 进度回调 */
  onProgress?: (stage: string) => void;
  /** 忽略增量水位线，全量重蒸 */
  force?: boolean;
}

/** 会话消息 + 记忆状态 */
interface SessionData {
  id: string;
  dialogMessages: Message[];   // 仅 user/assistant
  memory?: SessionMemory;
}

/** 从 store 或磁盘取会话消息 + 记忆（非活跃会话可能未加载） */
async function getSessionData(sessionId: string): Promise<SessionData> {
  const sess = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
  if (sess && sess.messages.length > 0) {
    return {
      id: sessionId,
      dialogMessages: sess.messages.filter(
        (m) => m.content !== "$$LOADING$$" && (m.role === "user" || m.role === "assistant"),
      ),
      memory: sess.memory,
    };
  }
  try {
    const result = await sessionStorage.loadMessages(sessionId, 0, 500);
    return {
      id: sessionId,
      dialogMessages: (result.messages || []).filter(
        (m) => m.content !== "$$LOADING$$" && (m.role === "user" || m.role === "assistant"),
      ),
      memory: result.memory,
    };
  } catch {
    return { id: sessionId, dialogMessages: [], memory: undefined };
  }
}

/** 推进会话的蒸馏水位线到 count（写回 SessionMemory） */
function advanceWatermark(sessionId: string, count: number): void {
  const store = useSessionStore.getState();
  const sess = store.sessions.find((s) => s.id === sessionId);
  const existing = sess?.memory || { summary: null, summarizedCount: 0 };
  store.updateMemory(sessionId, { ...existing, distilledMsgCount: count });
}

/** map-reduce：把过长对话分段摘要后再拼接 */
async function reduceDialog(messages: Message[], connector: Connector): Promise<string> {
  const segments: Message[][] = [];
  for (let i = 0; i < messages.length; i += SEGMENT_SIZE) {
    segments.push(messages.slice(i, i + SEGMENT_SIZE));
  }

  const summaries: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segText = formatDialog(segments[i], 600);
    const prompt =
      "请将以下对话片段压缩为要点摘要（保留关键决策、方法、偏好、纠正），3-6 条：\n\n" +
      segText +
      "\n\n只输出要点：";
    try {
      const result = await connector.send(prompt, {}, () => {});
      summaries.push(`[片段 ${i + 1}]\n${result.content.trim()}`);
    } catch {
      summaries.push(`[片段 ${i + 1}]\n${segText.slice(0, 800)}`);
    }
  }
  return summaries.join("\n\n");
}

/**
 * 蒸馏一批会话（增量）
 *
 * @param sessionIds 会话 ID 列表
 * @param connector 用于侧查询的连接器
 * @param opts 选项（force 可全量重蒸）
 */
export async function distillSessions(
  sessionIds: string[],
  connector: Connector,
  opts?: DistillOptions,
): Promise<DistillResult> {
  const cfg: DistillConfig = { ...DEFAULT_DISTILL_CONFIG, ...(await getDistillConfig()), ...opts?.config };
  const progress = opts?.onProgress || (() => {});

  if (!cfg.enabled) {
    return { ...emptyDistillResult(sessionIds), skipped: "disabled" };
  }

  // 1. 收集各会话的「新消息」（水位线之后）
  progress("收集会话内容");
  const newMessages: Message[] = [];
  // 记录每个会话蒸馏后应推进到的水位线（= 当前对话消息总数）
  const pendingWatermarks: { id: string; count: number }[] = [];

  for (const id of sessionIds) {
    const data = await getSessionData(id);
    const total = data.dialogMessages.length;
    const watermark = opts?.force ? 0 : (data.memory?.distilledMsgCount || 0);
    // 水位线可能大于当前总数（异常），钳制
    const start = Math.min(Math.max(0, watermark), total);
    const slice = data.dialogMessages.slice(start);
    if (slice.length > 0) {
      newMessages.push(...slice);
    }
    pendingWatermarks.push({ id, count: total });
  }

  // 2. 新增内容不足 minTurns → 跳过（不推进水位线，等攒够再蒸）
  const newTurns = Math.floor(newMessages.length / 2);
  if (newMessages.length === 0) {
    return { ...emptyDistillResult(sessionIds), skipped: "no_new_content" };
  }
  if (newTurns < cfg.minTurns) {
    console.log(`[Distill] 新增轮数 ${newTurns} < minTurns ${cfg.minTurns}，跳过`);
    return { ...emptyDistillResult(sessionIds), skipped: "below_min_turns" };
  }

  // 3. 去重上下文
  const existingMemories = await longTermMemory.getAll();
  await ensureSkillsLoaded();
  const existingSkills = skillRegistry.getAll();

  // 4. 构建对话文本（长则 map-reduce）
  let dialog = formatDialog(newMessages, 1000);
  if (dialog.length > MAX_DIALOG_CHARS) {
    progress("会话较长，分段摘要中");
    dialog = await reduceDialog(newMessages, connector);
  }

  // 5. 蒸馏侧查询
  progress("蒸馏分析中");
  const prompt = buildDistillPrompt(dialog, existingMemories, existingSkills);
  let raw = "";
  try {
    const result = await connector.send(prompt, {}, () => {});
    raw = result.content;
  } catch (e: any) {
    console.warn("[Distill] 侧查询失败:", e?.message || e);
    // 失败不推进水位线，下次可重试
    return emptyDistillResult(sessionIds);
  }

  // 6. 解析
  progress("整理蒸馏结果");
  const parsed = parseDistillResult(raw, sessionIds);

  // 7. 推进水位线（蒸馏已发生，避免重复处理这批消息）
  for (const w of pendingWatermarks) {
    advanceWatermark(w.id, w.count);
  }

  console.log(
    `[Distill] 蒸馏完成: 新消息=${newMessages.length}, memories=${parsed.memories.length}, skills=${parsed.skills.length}, playbooks=${parsed.playbooks.length}`,
  );
  return parsed;
}
