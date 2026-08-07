// ===== 工具轮次上限 =====
//
// 这段逻辑的价值全在「不误报也不漏报」：
// 漏报（撞上限却不提示）会留下一条无法解释的空消息；
// 误报（正常收尾也提示）会让每个长任务末尾都挂一句假警告。

import { describe, it, expect } from "vitest";
import { MAX_TOOL_LOOPS, isToolLoopCapped, toolLoopCapNotice } from "./toolLoopCap";

describe("isToolLoopCapped", () => {
  it("轮次用尽且仍要调工具 → 判为中断", () => {
    expect(isToolLoopCapped(MAX_TOOL_LOOPS, 1)).toBe(true);
    expect(isToolLoopCapped(MAX_TOOL_LOOPS, 8)).toBe(true);
  });

  it("轮次用尽但已给出最终答案 → 正常收尾，不提示", () => {
    expect(isToolLoopCapped(MAX_TOOL_LOOPS, 0)).toBe(false);
  });

  it("未到上限一律不提示，哪怕还有待执行工具（正常在跑）", () => {
    expect(isToolLoopCapped(0, 0)).toBe(false);
    expect(isToolLoopCapped(1, 3)).toBe(false);
    expect(isToolLoopCapped(MAX_TOOL_LOOPS - 1, 3)).toBe(false);
  });

  it("轮次超出上限也算中断（防御 off-by-one）", () => {
    expect(isToolLoopCapped(MAX_TOOL_LOOPS + 1, 2)).toBe(true);
  });
});

describe("toolLoopCapNotice", () => {
  it("带上上限轮次和已执行工具数，便于判断进展", () => {
    const out = toolLoopCapNotice(42);
    expect(out).toContain(String(MAX_TOOL_LOOPS));
    expect(out).toContain("42 个工具");
  });

  it("说明任务未完成", () => {
    expect(toolLoopCapNotice(7)).toContain("任务未做完");
  });

  it("给出可操作的下一步", () => {
    expect(toolLoopCapNotice(1)).toContain("继续");
  });
});
