// ===== 过程时间线构建器 =====
//
// 把流式到达的「正文 / 思考 / 工具」事件按真实顺序组织成一条时间线，
// 供 UI 还原 `文本 → 工具 → 文本 → 思考 → 工具` 的交错时序。
//
// 分段策略：连续同类内容合并进当前段，遇到不同类型的事件才封段。
// 这样一次回复只产生若干个段，而不是成百上千个碎片事件。
//
// 乱序容错：工具事件按 toolCallId 去重，同 id 重复到达时原地更新状态
// （ACP v2 引擎存在 tool_call_update 先于 tool_call 到达的情况）。

import type {
  TimelineEvent,
  TimelineTextEvent,
  TimelineThoughtEvent,
  TimelineToolEvent,
} from "./base";

/** 工具事件的输入形态（兼容连接器内部的工具状态结构） */
export interface ToolEventInput {
  toolCallId: string;
  title: string;
  /** 工具类别（read / edit / execute / search / other 等） */
  kind: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
}

export class TimelineBuilder {
  private events: TimelineEvent[] = [];
  /** 当前正在累积的文本段或思考段；工具事件不进入此状态 */
  private openSegment: TimelineTextEvent | TimelineThoughtEvent | null = null;
  /** 允许注入时钟，便于测试 */
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** 追加正文内容 */
  appendText(text: string): void {
    this.append("text", text);
  }

  /** 追加思考内容 */
  appendThought(text: string): void {
    this.append("thought", text);
  }

  private append(kind: "text" | "thought", text: string): void {
    if (!text) return;
    if (this.openSegment && this.openSegment.kind === kind) {
      this.openSegment.text += text;
      return;
    }
    this.closeSegment();
    const at = this.now();
    const seg: TimelineTextEvent | TimelineThoughtEvent =
      kind === "text"
        ? { kind: "text", text, at }
        : { kind: "thought", text, at };
    this.events.push(seg);
    this.openSegment = seg;
  }

  /**
   * 记录工具事件。同 toolCallId 已存在则原地更新，不重复插入。
   * 工具事件会打断当前累积的文本/思考段。
   */
  upsertTool(tc: ToolEventInput): void {
    const existing = this.events.find(
      (e): e is TimelineToolEvent => e.kind === "tool" && e.toolCallId === tc.toolCallId,
    );
    if (existing) {
      // 已是终结状态时不回退（防乱序把 completed 改回 in_progress）
      const isTerminal = existing.status === "completed" || existing.status === "failed";
      if (!isTerminal) existing.status = tc.status;
      if (tc.title && (!existing.title || existing.title === "thinking")) existing.title = tc.title;
      if (tc.kind && existing.toolKind === "other") existing.toolKind = tc.kind;
      if (tc.completedAt) existing.completedAt = tc.completedAt;
      return;
    }
    this.closeSegment();
    this.events.push({
      kind: "tool",
      toolCallId: tc.toolCallId,
      title: tc.title,
      toolKind: tc.kind,
      status: tc.status,
      at: tc.startedAt,
      completedAt: tc.completedAt,
    });
  }

  /** 封闭当前累积段（回复结束或中断时调用） */
  closeSegment(): void {
    if (this.openSegment && this.openSegment.kind === "thought") {
      this.openSegment.endedAt = this.now();
    }
    this.openSegment = null;
  }

  /** 事件数量 */
  get size(): number {
    return this.events.length;
  }

  /** 是否为空 */
  get isEmpty(): boolean {
    return this.events.length === 0;
  }

  /** 产出快照（浅拷贝每个事件，避免 UI 持有可变引用） */
  snapshot(): TimelineEvent[] {
    return this.events.map(e => ({ ...e }));
  }
}

/**
 * 从旧版 meta 字段拼出近似时间线，用于渲染历史消息。
 *
 * 旧数据只有 thought 全文、toolCalls 列表和 content 全文，
 * 没有文本位置信息，因此无法还原真实交错顺序。
 * 约定顺序为：思考 → 工具（按 startedAt 排序）→ 正文。
 *
 * 实测历史数据中 thought 与 toolCalls 从未共存，
 * 所以这个近似在绝大多数情况下与真实顺序一致。
 */
export function deriveLegacyTimeline(input: {
  content?: string;
  thought?: string;
  toolCalls?: ToolEventInput[];
}): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  if (input.thought) {
    events.push({ kind: "thought", text: input.thought, at: 0 });
  }

  const tools = [...(input.toolCalls || [])].sort(
    (a, b) => (a.startedAt || 0) - (b.startedAt || 0),
  );
  for (const tc of tools) {
    events.push({
      kind: "tool",
      toolCallId: tc.toolCallId,
      title: tc.title,
      toolKind: tc.kind,
      status: tc.status,
      at: tc.startedAt,
      completedAt: tc.completedAt,
    });
  }

  if (input.content) {
    events.push({ kind: "text", text: input.content, at: Number.MAX_SAFE_INTEGER });
  }

  return events;
}
