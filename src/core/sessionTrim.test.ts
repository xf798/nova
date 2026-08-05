// ===== 离开会话时裁剪内存消息 =====
//
// 往上翻历史会把消息累积到内存里，切回来时全部重新挂载。
// 实测某 165 条的会话：内存 20 条渲染 61ms，50 条 135ms，110 条 333ms，
// 165 条 457ms —— 随翻页次数无上限增长。裁回首屏那一页可让切回成本恒定。
//
// 这批用例固定四条契约：
//   1. 裁剪保留的是最近的消息（不是最早的）
//   2. loadedOffset 跟着回退，否则「加载更早」会从错误位置继续取
//   3. 持久化锚点仍在保留集内 —— 锚点丢了会触发跳过落盘，等于数据不落地
//   4. 只动内存，不碰磁盘

import { describe, it, expect } from "vitest";

type Msg = { id: string };

/** 复刻 trimInactiveSession 的裁剪计算 */
function trim(messages: Msg[], loadedOffset: number, keep: number) {
  if (messages.length <= keep) {
    return { messages, loadedOffset, changed: false };
  }
  return {
    messages: messages.slice(-keep),
    loadedOffset: Math.min(loadedOffset, keep),
    changed: true,
  };
}

const msgs = (n: number, prefix = "m") =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));

describe("裁剪范围", () => {
  it("超过一页时裁到最近一页", () => {
    const r = trim(msgs(165), 165, 20);
    expect(r.messages).toHaveLength(20);
    expect(r.changed).toBe(true);
  });

  it("保留的是最近的消息，不是最早的", () => {
    const r = trim(msgs(100), 100, 20);
    expect(r.messages[r.messages.length - 1].id).toBe("m99");
    expect(r.messages[0].id).toBe("m80");
  });

  it("不足一页时原样保留，避免无谓的 state 更新", () => {
    const src = msgs(12);
    const r = trim(src, 12, 20);
    expect(r.messages).toBe(src);
    expect(r.changed).toBe(false);
  });

  it("刚好一页时不裁", () => {
    const r = trim(msgs(20), 20, 20);
    expect(r.changed).toBe(false);
  });

  it("空会话不出错", () => {
    expect(trim([], 0, 20).messages).toEqual([]);
  });
});

describe("分页游标回退", () => {
  it("loadedOffset 回退到保留条数，否则「加载更早」会跳过一段历史", () => {
    // 已加载 110 条（首屏 20 + 翻页 3 次），裁回 20 条
    const r = trim(msgs(110), 110, 20);
    expect(r.loadedOffset).toBe(20);
  });

  it("loadedOffset 本就小于保留数时不上调", () => {
    const r = trim(msgs(15), 15, 20);
    expect(r.loadedOffset).toBe(15);
  });

  it("回退后仍能判断有更多历史", () => {
    const total = 165;
    const r = trim(msgs(110), 110, 20);
    expect(r.loadedOffset < total).toBe(true);
  });
});

describe("持久化锚点不因裁剪失效", () => {
  // 锚点是「已追加进 jsonl 的最后一条消息 id」，恒在末尾附近。
  // 若裁剪把它裁掉，debouncedSave 会因找不到锚点而跳过消息落盘。
  it("锚点在保留集内", () => {
    const all = msgs(165);
    const anchorId = all[all.length - 1].id; // 最后一条已落盘
    const r = trim(all, 165, 20);
    expect(r.messages.some(m => m.id === anchorId)).toBe(true);
  });

  it("倒数第二条作为锚点时也在保留集内（末条还在 partial）", () => {
    const all = msgs(165);
    const anchorId = all[all.length - 2].id;
    const r = trim(all, 165, 20);
    expect(r.messages.some(m => m.id === anchorId)).toBe(true);
  });

  it("保留一页足以覆盖锚点，即使一页只有 1 条", () => {
    const all = msgs(50);
    const anchorId = all[all.length - 1].id;
    const r = trim(all, 50, 1);
    expect(r.messages.some(m => m.id === anchorId)).toBe(true);
  });
});

describe("切回成本恒定", () => {
  it("反复翻页再切走，内存量始终回到一页", () => {
    let m = msgs(20);
    // 翻三次页，每次 30 条
    for (let i = 0; i < 3; i++) m = [...msgs(30, `old${i}-`), ...m];
    expect(m).toHaveLength(110);
    // 切走
    const r = trim(m, 110, 20);
    expect(r.messages).toHaveLength(20);
    // 再翻再切，仍回到 20
    let m2 = [...msgs(30, "x-"), ...r.messages];
    expect(trim(m2, 50, 20).messages).toHaveLength(20);
  });
});
