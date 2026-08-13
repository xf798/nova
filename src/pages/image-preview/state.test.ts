import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_SCALE,
  MIN_IMAGE_SCALE,
  calculateFitScale,
  clampImageScale,
  formatImageScale,
  stepImageScale,
  zoomOffsetAroundPoint,
} from "./state";

describe("图片预览缩放状态", () => {
  it("适应窗口时保持宽高比且不放大小图", () => {
    expect(calculateFitScale(2000, 1000, 1000, 700, 50)).toBeCloseTo(0.45);
    expect(calculateFitScale(200, 100, 1000, 700, 50)).toBe(1);
  });

  it("极大图片仍可缩小到视口，缩放值受上下限保护", () => {
    expect(calculateFitScale(100000, 50000, 1000, 700, 50)).toBe(MIN_IMAGE_SCALE);
    expect(clampImageScale(99)).toBe(MAX_IMAGE_SCALE);
    expect(clampImageScale(0)).toBe(MIN_IMAGE_SCALE);
  });

  it("按固定倍率逐级缩放", () => {
    expect(stepImageScale(1, 1)).toBeCloseTo(1.2);
    expect(stepImageScale(1.2, -1)).toBeCloseTo(1);
  });

  it("围绕鼠标缩放时保持鼠标指向的图片位置不变", () => {
    const next = zoomOffsetAroundPoint({ x: 10, y: -20 }, { x: 110, y: 80 }, 1, 2);
    expect(next).toEqual({ x: -90, y: -120 });
  });

  it("格式化缩放百分比", () => {
    expect(formatImageScale(0.456)).toBe("46%");
  });
});
