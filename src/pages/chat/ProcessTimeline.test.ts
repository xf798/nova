import { describe, it, expect } from "vitest";
import { formatDuration, cleanToolTitle, groupTimeline } from "./ProcessTimeline";
import type { TimelineEvent, TimelineToolEvent } from "../../connectors";

const tool = (id: string, title = "Read", status: TimelineToolEvent["status"] = "completed"): TimelineToolEvent => ({
  kind: "tool", toolCallId: id, title, toolKind: "read", status, at: 100, completedAt: 200,
});
const text = (t: string): TimelineEvent => ({ kind: "text", text: t, at: 1 });
const thought = (t: string): TimelineEvent => ({ kind: "thought", text: t, at: 1 });

describe("formatDuration", () => {
  it("毫秒级用 ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(36)).toBe("36ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("秒级保留一位小数", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(3900)).toBe("3.9s");
    expect(formatDuration(12_340)).toBe("12.3s");
  });

  it("分钟级用 XmYs", () => {
    expect(formatDuration(60_000)).toBe("1m0s");
    expect(formatDuration(90_000)).toBe("1m30s");
  });

  it("真实历史数据的工具耗时（36ms）能正确显示", () => {
    expect(formatDuration(1784608156349 - 1784608156313)).toBe("36ms");
  });
});

describe("cleanToolTitle — 剥离命令噪音前缀", () => {
  it("剥掉 export PATH 与 cd，只留真实命令", () => {
    // 取自实际截图中的标题
    const raw = 'Running: export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; cd /Users/wangxf/workspace/nova; grep -n "ProcessTimeline"';
    expect(cleanToolTitle(raw)).toBe('Running: grep -n "ProcessTimeline"');
  });

  it("剥掉多个连续的 export", () => {
    const raw = "Running: export A=1; export B=2; cd /tmp; ls -la";
    expect(cleanToolTitle(raw)).toBe("Running: ls -la");
  });

  it("只有 cd 前缀也能剥", () => {
    expect(cleanToolTitle("Running: cd /Users/x/proj; npm test")).toBe("Running: npm test");
  });

  it("保留命令中后续的分号结构", () => {
    const raw = "Running: cd /tmp; echo a; echo b";
    expect(cleanToolTitle(raw)).toBe("Running: echo a; echo b");
  });

  it("无噪音前缀时原样返回", () => {
    expect(cleanToolTitle("Running: ls -la")).toBe("Running: ls -la");
  });

  it("非执行类标题不受影响", () => {
    expect(cleanToolTitle("Reading MessageItem.tsx:139-158")).toBe("Reading MessageItem.tsx:139-158");
    expect(cleanToolTitle("Editing ChatView.tsx")).toBe("Editing ChatView.tsx");
    expect(cleanToolTitle("Creating RecallBlock.tsx")).toBe("Creating RecallBlock.tsx");
  });

  it("命令本身只有 env/cd 时保留原样，不返回空", () => {
    const raw = "Running: export PATH=/x; cd /tmp";
    expect(cleanToolTitle(raw)).toBe(raw);
  });
});

describe("groupTimeline — 连续工具归组", () => {
  it("连续工具合并为一组", () => {
    const units = groupTimeline([tool("a"), tool("b"), tool("c")]);
    expect(units.length).toBe(1);
    expect(units[0].type).toBe("toolGroup");
    expect((units[0] as any).events.length).toBe(3);
  });

  it("被文本打断则分成两组，保持真实交错", () => {
    const units = groupTimeline([
      tool("a"), tool("b"),
      text("中间的正文"),
      tool("c"),
    ]);
    expect(units.map(u => u.type)).toEqual(["toolGroup", "single", "toolGroup"]);
    expect((units[0] as any).events.length).toBe(2);
    expect((units[2] as any).events.length).toBe(1);
  });

  it("被思考打断同样分组", () => {
    const units = groupTimeline([tool("a"), thought("想一下"), tool("b")]);
    expect(units.map(u => u.type)).toEqual(["toolGroup", "single", "toolGroup"]);
  });

  it("纯文本不产生工具组", () => {
    const units = groupTimeline([text("只有正文")]);
    expect(units.map(u => u.type)).toEqual(["single"]);
  });

  it("空输入产出空数组", () => {
    expect(groupTimeline([])).toEqual([]);
  });

  it("保留原始顺序与索引", () => {
    const units = groupTimeline([text("一"), tool("a"), text("二")]);
    expect((units[0] as any).index).toBe(0);
    expect((units[1] as any).lastIndex).toBe(1);
    expect((units[2] as any).index).toBe(2);
  });

  it("截图场景：14 个连续工具归为单组", () => {
    const many = Array.from({ length: 14 }, (_, i) => tool(`t${i}`));
    const units = groupTimeline(many);
    expect(units.length).toBe(1);
    expect((units[0] as any).events.length).toBe(14);
  });
});
