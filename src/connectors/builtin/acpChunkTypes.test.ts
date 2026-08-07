// ===== ACP 事件名 =====
//
// 事件名写错不会报错，只会静默丢内容。思考内容就是这么丢掉的：
// 代码匹配 thought_message_chunk（从文档猜的），而 kiro-cli 实际发的是
// agent_thought_chunk —— acp-session.log 里 146389 条 agent_thought_chunk，
// 落进 timeline 的 thought 事件 0 个，整段推理在界面上完全看不到。
//
// 这批用例固定「日志中实际观测到的事件名」，改名或手误会被立刻打断。

import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-shell", () => ({
  Command: { create: () => ({ execute: async () => ({}) }) },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { isTextChunk, isThoughtChunk, isHighFrequencyChunk } from "./kiro-cli";
import { TimelineBuilder } from "../timeline";

// acp-session.log 中实际出现过的 sessionUpdate 名字及出现次数
const OBSERVED = {
  agent_thought_chunk: 146389,
  tool_call_update: 23889,
  tool_call: 14052,
  agent_message_chunk: 332,
};

describe("事件名识别", () => {
  it("识别实际观测到的思考事件名", () => {
    expect(isThoughtChunk("agent_thought_chunk")).toBe(true);
  });

  it("识别实际观测到的正文事件名", () => {
    expect(isTextChunk("agent_message_chunk")).toBe(true);
  });

  it("思考与正文互不混淆", () => {
    expect(isTextChunk("agent_thought_chunk")).toBe(false);
    expect(isThoughtChunk("agent_message_chunk")).toBe(false);
  });

  it("兼容 PascalCase 写法（不同引擎版本混用过）", () => {
    expect(isThoughtChunk("AgentThoughtChunk")).toBe(true);
    expect(isTextChunk("AgentMessageChunk")).toBe(true);
  });

  it("工具事件不被当成 chunk，否则会被排除出日志", () => {
    for (const t of ["tool_call", "tool_call_update", "turn_end"]) {
      expect(isHighFrequencyChunk(t), t).toBe(false);
    }
  });

  it("两类高频 chunk 都不写文件日志（每行要 spawn 一个 sh）", () => {
    expect(isHighFrequencyChunk("agent_message_chunk")).toBe(true);
    expect(isHighFrequencyChunk("agent_thought_chunk")).toBe(true);
  });

  it("日志里观测到的四个名字都能被正确归类", () => {
    const classify = (t: string) =>
      isThoughtChunk(t) ? "thought" : isTextChunk(t) ? "text" : "other";
    expect(Object.keys(OBSERVED).map(classify)).toEqual(["thought", "other", "other", "text"]);
  });
});

describe("思考内容进入过程流", () => {
  it("逐 token 的思考合并成一段，不是十万个事件", () => {
    const tl = new TimelineBuilder(() => 1000);
    for (const t of ["我", "先", "看", "一", "下"]) tl.appendThought(t);
    const events = tl.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("thought");
    expect((events[0] as any).text).toBe("我先看一下");
  });

  it("工具调用会打断思考段，形成「思考→工具→思考」的真实顺序", () => {
    const tl = new TimelineBuilder(() => 1000);
    tl.appendThought("先读文件");
    tl.upsertTool({ toolCallId: "t1", title: "Reading a.ts", kind: "read", status: "completed", startedAt: 1000 });
    tl.appendThought("再改一处");
    expect(tl.snapshot().map(e => e.kind)).toEqual(["thought", "tool", "thought"]);
  });

  it("思考段被打断时会封口，供 UI 判断是否仍在进行", () => {
    const tl = new TimelineBuilder(() => 1000);
    tl.appendThought("想一下");
    tl.upsertTool({ toolCallId: "t1", title: "x", kind: "read", status: "completed", startedAt: 1000 });
    expect((tl.snapshot()[0] as any).endedAt).toBe(1000);
  });
});
