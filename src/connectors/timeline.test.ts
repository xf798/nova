import { describe, it, expect } from "vitest";
import { TimelineBuilder, deriveLegacyTimeline } from "./timeline";
import type { TimelineEvent, TimelineToolEvent } from "./base";

/** 递增时钟，让每个事件有可预测且不同的时间戳 */
function fakeClock(start = 1000, step = 10) {
  let t = start;
  return () => (t += step);
}

/** 提取事件类型序列，便于断言顺序 */
const kinds = (events: TimelineEvent[]) => events.map(e => e.kind);

/** 提取文本/思考段的内容 */
const texts = (events: TimelineEvent[]) =>
  events.filter(e => e.kind !== "tool").map(e => (e as { text: string }).text);

describe("TimelineBuilder — 分段", () => {
  it("连续同类内容合并进一段，不产生碎片", () => {
    const tl = new TimelineBuilder(fakeClock());
    tl.appendText("现状");
    tl.appendText("梳理");
    tl.appendText("完了");

    expect(tl.size).toBe(1);
    expect(texts(tl.snapshot())).toEqual(["现状梳理完了"]);
  });

  it("文本与思考交替时各自封段", () => {
    const tl = new TimelineBuilder(fakeClock());
    tl.appendThought("先看看数据");
    tl.appendText("数据链路是这样的");
    tl.appendThought("还要确认历史消息");

    expect(kinds(tl.snapshot())).toEqual(["thought", "text", "thought"]);
    expect(texts(tl.snapshot())).toEqual([
      "先看看数据",
      "数据链路是这样的",
      "还要确认历史消息",
    ]);
  });

  it("空字符串不产生段", () => {
    const tl = new TimelineBuilder(fakeClock());
    tl.appendText("");
    tl.appendThought("");
    expect(tl.isEmpty).toBe(true);
  });

  it("思考段被打断时记录 endedAt", () => {
    const tl = new TimelineBuilder(fakeClock());
    tl.appendThought("思考中");
    tl.appendText("正文");

    const first = tl.snapshot()[0] as { endedAt?: number };
    expect(first.endedAt).toBeGreaterThan(0);
  });
});

describe("TimelineBuilder — 工具事件与交错", () => {
  it("工具调用打断文本段，形成真实交错顺序", () => {
    const tl = new TimelineBuilder(fakeClock());
    tl.appendText("先读文件");
    tl.upsertTool({
      toolCallId: "t1", title: "Read lib.rs", kind: "read",
      status: "in_progress", startedAt: 1,
    });
    tl.appendText("读到了同步逻辑");
    tl.upsertTool({
      toolCallId: "t2", title: "Grep timeline", kind: "search",
      status: "in_progress", startedAt: 2,
    });

    expect(kinds(tl.snapshot())).toEqual(["text", "tool", "text", "tool"]);
  });

  it("同一工具重复到达时原地更新，不重复插入", () => {
    const tl = new TimelineBuilder(fakeClock());
    tl.upsertTool({
      toolCallId: "t1", title: "Read", kind: "read",
      status: "in_progress", startedAt: 1,
    });
    tl.upsertTool({
      toolCallId: "t1", title: "Read", kind: "read",
      status: "completed", startedAt: 1, completedAt: 5,
    });

    const snap = tl.snapshot();
    expect(snap.length).toBe(1);
    const tool = snap[0] as TimelineToolEvent;
    expect(tool.status).toBe("completed");
    expect(tool.completedAt).toBe(5);
  });

  it("乱序容错：终结状态不被回退成进行中", () => {
    const tl = new TimelineBuilder(fakeClock());
    // tool_call_update(completed) 先到
    tl.upsertTool({
      toolCallId: "t1", title: "Read", kind: "read",
      status: "completed", startedAt: 1, completedAt: 5,
    });
    // tool_call(in_progress) 后到
    tl.upsertTool({
      toolCallId: "t1", title: "Read", kind: "read",
      status: "in_progress", startedAt: 1,
    });

    const tool = tl.snapshot()[0] as TimelineToolEvent;
    expect(tool.status).toBe("completed");
  });

  it("乱序容错：占位 title/kind 会被真实值补齐", () => {
    const tl = new TimelineBuilder(fakeClock());
    tl.upsertTool({
      toolCallId: "t1", title: "thinking", kind: "other",
      status: "in_progress", startedAt: 1,
    });
    tl.upsertTool({
      toolCallId: "t1", title: "Reading lib.rs", kind: "read",
      status: "completed", startedAt: 1, completedAt: 5,
    });

    const tool = tl.snapshot()[0] as TimelineToolEvent;
    expect(tool.title).toBe("Reading lib.rs");
    expect(tool.toolKind).toBe("read");
  });

  it("失败状态被保留", () => {
    const tl = new TimelineBuilder(fakeClock());
    tl.upsertTool({
      toolCallId: "t1", title: "Bash", kind: "execute",
      status: "failed", startedAt: 1, completedAt: 5,
    });
    expect((tl.snapshot()[0] as TimelineToolEvent).status).toBe("failed");
  });
});

describe("TimelineBuilder — 快照隔离", () => {
  it("快照是拷贝，修改快照不影响内部状态", () => {
    const tl = new TimelineBuilder(fakeClock());
    tl.appendText("原文");

    const snap = tl.snapshot();
    (snap[0] as { text: string }).text = "被篡改";

    expect(texts(tl.snapshot())).toEqual(["原文"]);
  });

  it("快照后继续追加，旧快照不受影响", () => {
    const tl = new TimelineBuilder(fakeClock());
    tl.appendText("第一段");
    const snap1 = tl.snapshot();

    tl.appendText("续写");
    expect(texts(snap1)).toEqual(["第一段"]);
    expect(texts(tl.snapshot())).toEqual(["第一段续写"]);
  });
});

describe("deriveLegacyTimeline — 历史消息降级", () => {
  it("纯工具的历史消息：工具按 startedAt 排序后置于正文前", () => {
    const events = deriveLegacyTimeline({
      content: "最终回复",
      toolCalls: [
        { toolCallId: "b", title: "Grep", kind: "search", status: "completed", startedAt: 200, completedAt: 210 },
        { toolCallId: "a", title: "Read", kind: "read", status: "completed", startedAt: 100, completedAt: 110 },
      ],
    });

    expect(kinds(events)).toEqual(["tool", "tool", "text"]);
    expect((events[0] as TimelineToolEvent).title).toBe("Read");
    expect((events[1] as TimelineToolEvent).title).toBe("Grep");
  });

  it("纯思考的历史消息：思考在正文前", () => {
    const events = deriveLegacyTimeline({
      content: "回复内容",
      thought: "我的思考",
    });
    expect(kinds(events)).toEqual(["thought", "text"]);
  });

  it("两者都有时顺序为 思考 → 工具 → 正文", () => {
    const events = deriveLegacyTimeline({
      content: "回复",
      thought: "思考",
      toolCalls: [
        { toolCallId: "a", title: "Read", kind: "read", status: "completed", startedAt: 100 },
      ],
    });
    expect(kinds(events)).toEqual(["thought", "tool", "text"]);
  });

  it("无 meta 的消息只产出正文段", () => {
    const events = deriveLegacyTimeline({ content: "只有正文" });
    expect(kinds(events)).toEqual(["text"]);
    expect(texts(events)).toEqual(["只有正文"]);
  });

  it("完全空输入产出空数组", () => {
    expect(deriveLegacyTimeline({})).toEqual([]);
  });

  it("保留工具耗时信息（旧数据有完整起止时间）", () => {
    const events = deriveLegacyTimeline({
      toolCalls: [
        { toolCallId: "a", title: "Read", kind: "read", status: "completed", startedAt: 1784608156313, completedAt: 1784608156349 },
      ],
    });
    const tool = events[0] as TimelineToolEvent;
    expect(tool.completedAt! - tool.at).toBe(36);
  });
});
