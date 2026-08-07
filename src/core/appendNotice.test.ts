// ===== 异常提示的可见性 =====
//
// 真实事故：连接器在生成中断时会拼一句「⚠️ 生成中断，以上为部分内容」，
// 但只拼进了 content。而 MessageItem 在 meta.timeline 存在时只渲染 timeline，
// content 不单独渲染 —— 于是这句提示是隐形的，用户看到的是
// 「一句开场白 + 几个工具 + 没有下文」，完全看不出是报错断掉的。
//
// 同一个坑吞掉了三处提示（生成中断、工具轮次上限、Agent 侧中断），
// 所以这里把「提示必须同时出现在两处」固定成契约。

import { describe, it, expect } from "vitest";
import { appendNotice } from "./appendNotice";
import type { TimelineEvent } from "../connectors/base";

const NOTICE = "⚠️ 任务未完成";
const at = () => 1000;

function timelineWithText(text: string): TimelineEvent[] {
  return [{ kind: "text", text, at: 1 }];
}

describe("appendNotice", () => {
  it("同时写进正文与时间线", () => {
    const tl = timelineWithText("我先核对一下。");
    const out = appendNotice("我先核对一下。", tl, NOTICE, at);
    expect(out).toContain(NOTICE);
    const tlText = tl.filter(e => e.kind === "text").map(e => (e as any).text).join("");
    expect(tlText).toContain(NOTICE);
  });

  it("提示落在时间线末尾（在所有工具事件之后）", () => {
    const tl: TimelineEvent[] = [
      { kind: "text", text: "开场白", at: 1 },
      { kind: "tool", toolCallId: "t1", title: "Reading a.ts", toolKind: "read", status: "completed", at: 2 },
    ];
    appendNotice("开场白", tl, NOTICE, at);
    expect(tl).toHaveLength(3);
    expect(tl[2].kind).toBe("text");
    expect((tl[2] as any).text).toContain(NOTICE);
  });

  it("正文非空时用空行分隔，不粘在原文后面", () => {
    const tl = timelineWithText("原文");
    const out = appendNotice("原文", tl, NOTICE, at);
    expect(out).toBe(`原文\n\n${NOTICE}`);
    expect((tl[1] as any).text.startsWith("\n\n")).toBe(true);
  });

  it("正文为空时提示单独成文，不以空白开头", () => {
    const tl = timelineWithText("");
    const out = appendNotice("", tl, NOTICE, at);
    expect(out).toBe(NOTICE);
    expect((tl[1] as any).text).toBe(NOTICE);
  });

  it("没有时间线的消息只改正文（渲染层此时走 content）", () => {
    const tl: TimelineEvent[] = [];
    const out = appendNotice("原文", tl, NOTICE, at);
    expect(out).toContain(NOTICE);
    expect(tl).toHaveLength(0);
  });

  it("多次追加互不覆盖，两处都能累积", () => {
    const tl = timelineWithText("原文");
    let c = appendNotice("原文", tl, "提示一", at);
    c = appendNotice(c, tl, "提示二", at);
    expect(c).toContain("提示一");
    expect(c).toContain("提示二");
    const tlText = tl.filter(e => e.kind === "text").map(e => (e as any).text).join("");
    expect(tlText).toContain("提示一");
    expect(tlText).toContain("提示二");
  });
});
