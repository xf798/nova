// ===== 底部跟随 =====
//
// 两个真实 bug 的回归保护：
//   1. 切到某些会话后停在半路、底部一片空白 —— 平滑动画盖掉了直接定位
//   2. 用户往上翻历史时被新消息拽回底部
//
// 另固定「不再依赖 content-visibility 的估算高度」这个前提：
// 估值两个方向都会错（实测末 20 条真实 1888px vs 估算 4800px），
// 而切换定位用的就是 scrollHeight，估错就滚错。

import { describe, it, expect } from "vitest";
import { NEAR_BOTTOM_PX, isNearBottom, shouldSmoothFollow } from "./scrollFollow";

describe("isNearBottom", () => {
  it("正好在底部算贴底", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
  });

  it("阈值内算贴底", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 580, clientHeight: 400 })).toBe(true);
  });

  it("刚好达到阈值不算（严格小于）", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 600 - NEAR_BOTTOM_PX, clientHeight: 400 })).toBe(false);
  });

  it("往上翻历史时不算贴底", () => {
    expect(isNearBottom({ scrollHeight: 5000, scrollTop: 100, clientHeight: 400 })).toBe(false);
  });

  it("内容不足一屏时算贴底（没有可滚区间）", () => {
    expect(isNearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 400 })).toBe(true);
  });
});

describe("shouldSmoothFollow", () => {
  it("会话切换那一次提交不发平滑滚动，让位给直接定位", () => {
    expect(shouldSmoothFollow({ justSwitched: true, isNearBottom: true, messageCount: 20 })).toBe(false);
  });

  it("同会话内新消息且贴底 → 跟随", () => {
    expect(shouldSmoothFollow({ justSwitched: false, isNearBottom: true, messageCount: 20 })).toBe(true);
  });

  it("用户在翻历史 → 不跟随，不打断阅读", () => {
    expect(shouldSmoothFollow({ justSwitched: false, isNearBottom: false, messageCount: 20 })).toBe(false);
  });

  it("空会话不滚动", () => {
    expect(shouldSmoothFollow({ justSwitched: false, isNearBottom: true, messageCount: 0 })).toBe(false);
  });
});
