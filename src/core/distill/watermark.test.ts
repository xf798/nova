// ===== 蒸馏水位线 =====
//
// 真实故障：点蒸馏按钮一直提示「自上次蒸馏后无新内容」。
// 根因是拿内存里的部分视图（首屏 20 条）去和水位线比 —— 实测 22 个有水位线
// 的会话全部卡死，其中「客户画像问题修复」磁盘 227 条、水位线 76，
// 151 条新内容永远蒸不到。
//
// 这批用例固定两条性质：按全量切片正确、水位线只前进不后退。

import { describe, it, expect } from "vitest";
import { sliceNewMessages, nextWatermark } from "./watermark";

/** 造 n 条可辨识的消息 */
const msgs = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);

describe("sliceNewMessages", () => {
  it("从水位线之后切出新内容", () => {
    const r = sliceNewMessages(msgs(5), 3);
    expect(r.slice).toEqual(["m3", "m4"]);
    expect(r.start).toBe(3);
    expect(r.clamped).toBe(false);
  });

  it("水位线为 0 时切出全部（从未蒸过）", () => {
    expect(sliceNewMessages(msgs(3), 0).slice).toEqual(["m0", "m1", "m2"]);
  });

  it("水位线等于总数时无新内容（这才是真正的 no_new_content）", () => {
    const r = sliceNewMessages(msgs(5), 5);
    expect(r.slice).toEqual([]);
    expect(r.clamped).toBe(false);
  });

  it("force 忽略水位线，全量重蒸", () => {
    const r = sliceNewMessages(msgs(4), 4, true);
    expect(r.slice).toHaveLength(4);
    expect(r.start).toBe(0);
  });

  it("真实场景：磁盘 227 条、水位线 76 → 切出 151 条", () => {
    const r = sliceNewMessages(msgs(227), 76);
    expect(r.slice).toHaveLength(151);
  });

  it("水位线超过总数时标记 clamped，供上层记脏数据日志", () => {
    // 实测存在：客户画像-UI 水位线 87、磁盘 86
    const r = sliceNewMessages(msgs(86), 87);
    expect(r.clamped).toBe(true);
    expect(r.slice).toEqual([]);
    expect(r.start).toBe(86);
  });

  it("异常水位线（负数、NaN、小数）不越界", () => {
    expect(sliceNewMessages(msgs(3), -5).slice).toHaveLength(3);
    expect(sliceNewMessages(msgs(3), NaN).slice).toHaveLength(3);
    expect(sliceNewMessages(msgs(3), 1.7).start).toBe(1);
  });

  it("空会话不报错", () => {
    expect(sliceNewMessages([], 10).slice).toEqual([]);
  });
});

describe("nextWatermark", () => {
  it("正常推进", () => {
    expect(nextWatermark(20, 50)).toBe(50);
  });

  it("拒绝回退——这是重复蒸馏 230 条的来源", () => {
    expect(nextWatermark(250, 20)).toBe(250);
  });

  it("首次蒸馏（无既有水位线）", () => {
    expect(nextWatermark(undefined, 30)).toBe(30);
  });

  it("异常入参不产生负数或 NaN", () => {
    expect(nextWatermark(10, -1)).toBe(10);
    expect(nextWatermark(undefined, NaN)).toBe(0);
  });
});
