import { describe, it, expect } from "vitest";
import { buildTaskPrompt } from "./taskManager";

describe("buildTaskPrompt", () => {
  it("有描述时标题与描述用空行分隔", () => {
    expect(buildTaskPrompt({ title: "修复登录", description: "点两次会重复提交" }))
      .toBe("继续这个任务：修复登录\n\n点两次会重复提交");
  });

  it("无描述时只带标题", () => {
    expect(buildTaskPrompt({ title: "修复登录" }))
      .toBe("继续这个任务：修复登录");
  });

  it("描述为空字符串等同于无描述", () => {
    expect(buildTaskPrompt({ title: "A", description: "" }))
      .toBe("继续这个任务：A");
  });

  it("描述只有空白时不produce尾部空行", () => {
    expect(buildTaskPrompt({ title: "A", description: "   \n  " }))
      .toBe("继续这个任务：A");
  });

  it("描述首尾空白被裁掉", () => {
    expect(buildTaskPrompt({ title: "A", description: "  正文  " }))
      .toBe("继续这个任务：A\n\n正文");
  });

  it("保留描述内部的换行", () => {
    expect(buildTaskPrompt({ title: "A", description: "第一行\n第二行" }))
      .toBe("继续这个任务：A\n\n第一行\n第二行");
  });
});
