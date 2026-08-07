// ===== Agent 侧中断识别 =====
//
// 用例里的字符串全部取自真实会话数据（~/.nova/data/sessions 里 5 次出现）。
// 关键是这类中断的 stopReason 仍为 end_turn，Nova 看不出异常，
// 所以只能靠正文里的这句固定句式识别。

import { describe, it, expect } from "vitest";
import { isTurnInterrupted, withTurnInterruptNotice } from "./turnInterrupt";

// 真实样本（截断）
const REAL = {
  onlyMarker: "Response was interrupted by the user",
  withPeriod: "Response was interrupted by the user.",
  afterQuota: "You have 6387 weighted tokens leftResponse was interrupted by the user.",
  afterText: "查三处 —— 执行引擎实际支持的、SKILL.md 声明的、前端能插入的:Response was interrupted by the user",
  normal: "改完了，跑过 437 个测试，tsc 干净。",
  quotaOnly: "You have 1793 weighted tokens left收尾处理中：正在把信号删除操作移到信号详情页。",
};

describe("isTurnInterrupted", () => {
  it("识别单独成句的中断标记", () => {
    expect(isTurnInterrupted(REAL.onlyMarker)).toBe(true);
  });

  it("句尾带句号也能识别", () => {
    expect(isTurnInterrupted(REAL.withPeriod)).toBe(true);
  });

  it("紧跟额度提示的样本能识别（真实出现过的形态）", () => {
    expect(isTurnInterrupted(REAL.afterQuota)).toBe(true);
  });

  it("拼在正文末尾（无换行分隔）也能识别", () => {
    expect(isTurnInterrupted(REAL.afterText)).toBe(true);
  });

  it("正常回答不误判", () => {
    expect(isTurnInterrupted(REAL.normal)).toBe(false);
  });

  it("只有额度提示、没有中断标记时不误判（额度低≠已中断）", () => {
    expect(isTurnInterrupted(REAL.quotaOnly)).toBe(false);
  });

  it("空正文不误判", () => {
    expect(isTurnInterrupted("")).toBe(false);
  });
});

describe("withTurnInterruptNotice", () => {
  it("保留 Agent 原句，只在后面补说明", () => {
    const out = withTurnInterruptNotice(REAL.afterText);
    expect(out.startsWith(REAL.afterText)).toBe(true);
    expect(out).toContain("任务可能未完成");
  });

  it("说明里指出不是用户点的停止，避免误导", () => {
    expect(withTurnInterruptNotice("x")).toContain("并非你点了停止");
  });

  it("给出可操作的下一步", () => {
    expect(withTurnInterruptNotice("x")).toContain("继续");
  });
});
