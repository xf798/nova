import { describe, it, expect } from "vitest";
import { formatDuration } from "./ProcessTimeline";

describe("formatDuration", () => {
  it("毫秒级用 ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(36)).toBe("36ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("秒级保留一位小数", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(12_340)).toBe("12.3s");
    expect(formatDuration(59_999)).toBe("60.0s");
  });

  it("分钟级用 XmYs", () => {
    expect(formatDuration(60_000)).toBe("1m0s");
    expect(formatDuration(90_000)).toBe("1m30s");
    expect(formatDuration(605_000)).toBe("10m5s");
  });

  it("真实历史数据的工具耗时（36ms）能正确显示", () => {
    // 取自 ~/.nova/data/sessions 中的实际样本
    const startedAt = 1784608156313;
    const completedAt = 1784608156349;
    expect(formatDuration(completedAt - startedAt)).toBe("36ms");
  });
});
