// ===== 分页与自动补加载 =====
//
// 首屏从 50 条降到 10 条（实测 50 条要渲染 574 个块元素、157ms，
// 而一屏只看得到 15-25 个块）。降低首屏带来一个连带风险：
// 内容可能撑不满视口，而「加载更多」原本只由向上滚动触发，
// 没有滚动条就永远触发不了，历史再也看不到。
//
// 这批用例固定三条契约：
//   1. 首屏用小页、翻页用大页
//   2. 内容不足一屏且还有更多 → 需要自动补加载
//   3. 加载更多后按高度增量补偿滚动位置，视线不被推走

import { describe, it, expect } from "vitest";

const SIZES = { firstPage: 20, loadMore: 30 };

/** 复刻 sessionStorage.loadMessages 的页大小选择 */
function pickLimit(offset: number, limit: number | undefined, sizes = SIZES): number {
  if (limit !== undefined) return limit;
  return offset === 0 ? sizes.firstPage : sizes.loadMore;
}

/** 复刻自动补加载的判定 */
function shouldAutoFill(input: {
  scrollHeight: number;
  clientHeight: number;
  hasMore: boolean;
  isLoading: boolean;
}): boolean {
  const { scrollHeight, clientHeight, hasMore, isLoading } = input;
  if (!hasMore || isLoading) return false;
  return scrollHeight <= clientHeight + 8;
}

/** 复刻滚动位置补偿 */
function restoredScrollTop(prevTop: number, prevHeight: number, newHeight: number): number {
  const delta = newHeight - prevHeight;
  return delta > 0 ? prevTop + delta : prevTop;
}

describe("页大小选择", () => {
  it("首屏用小页（offset=0）", () => {
    expect(pickLimit(0, undefined)).toBe(20);
  });

  it("往上翻历史用大页", () => {
    expect(pickLimit(20, undefined)).toBe(30);
    expect(pickLimit(40, undefined)).toBe(30);
  });

  it("显式传 limit 时优先", () => {
    expect(pickLimit(0, 5)).toBe(5);
    expect(pickLimit(99, 1)).toBe(1);
  });

  it("翻页页大于首屏页（翻历史时少翻几次）", () => {
    expect(SIZES.loadMore).toBeGreaterThan(SIZES.firstPage);
  });
});

describe("自动补加载", () => {
  it("内容撑不满视口且有更多 → 补加载", () => {
    expect(shouldAutoFill({
      scrollHeight: 400, clientHeight: 800,
      hasMore: true, isLoading: false,
    })).toBe(true);
  });

  it("内容刚好等于视口高度也补（否则没有可滚动空间）", () => {
    expect(shouldAutoFill({
      scrollHeight: 800, clientHeight: 800,
      hasMore: true, isLoading: false,
    })).toBe(true);
  });

  it("内容已超出视口 → 不补，交给滚动触发", () => {
    expect(shouldAutoFill({
      scrollHeight: 2000, clientHeight: 800,
      hasMore: true, isLoading: false,
    })).toBe(false);
  });

  it("8px 容差内不反复触发（边框/圆整误差）", () => {
    expect(shouldAutoFill({
      scrollHeight: 806, clientHeight: 800,
      hasMore: true, isLoading: false,
    })).toBe(true);
    expect(shouldAutoFill({
      scrollHeight: 809, clientHeight: 800,
      hasMore: true, isLoading: false,
    })).toBe(false);
  });

  it("没有更多历史时不补", () => {
    expect(shouldAutoFill({
      scrollHeight: 100, clientHeight: 800,
      hasMore: false, isLoading: false,
    })).toBe(false);
  });

  it("正在加载时不重复触发", () => {
    expect(shouldAutoFill({
      scrollHeight: 100, clientHeight: 800,
      hasMore: true, isLoading: true,
    })).toBe(false);
  });

});

describe("滚动位置补偿", () => {
  it("按高度增量补偿，视线停在原处", () => {
    // 加载前：内容高 1000，停在 200；新内容插到顶部后高 1600
    expect(restoredScrollTop(200, 1000, 1600)).toBe(800);
  });

  it("在顶部加载后不回到 0（否则又会触发一次加载）", () => {
    expect(restoredScrollTop(0, 1000, 1600)).toBe(600);
  });

  it("高度没变化时保持原位", () => {
    expect(restoredScrollTop(200, 1000, 1000)).toBe(200);
  });

  it("高度异常缩小时不做负向补偿", () => {
    expect(restoredScrollTop(200, 1000, 800)).toBe(200);
  });
});
