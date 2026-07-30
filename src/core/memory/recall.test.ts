import { describe, it, expect } from "vitest";
import { scoreMemory, recallMemories, tokenize } from "./recall";
import type { LongTermMemory } from "./longterm";

const now = new Date().toISOString();

function mem(partial: Partial<LongTermMemory> & { content: string }): LongTermMemory {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    content: partial.content,
    category: partial.category ?? "feedback",
    tags: partial.tags ?? [],
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    ...partial,
  } as LongTermMemory;
}

describe("scoreMemory — 相关性作为闸门", () => {
  it("零关键词零标签匹配时得 0 分，不靠时效/分类拿保底分", () => {
    // 回归用例：早期加法公式下，7 天内的 feedback 记忆保底
    // recency*0.10 + cat*0.10 = 0.17 > 阈值 0.15，导致任何查询都能通过
    const m = mem({ content: "用户要求先出设计方案供 review", category: "feedback", updatedAt: now });
    expect(scoreMemory(m, tokenize("hi"))).toBe(0);
  });

  it("最新的 user_preference 同样不能靠分类拿保底分", () => {
    const m = mem({ content: "完全无关的内容", category: "user_preference", updatedAt: now });
    expect(scoreMemory(m, tokenize("xyzzy"))).toBe(0);
  });

  it("有关键词匹配才得分", () => {
    const m = mem({ content: "skill 同步采用 manifest 方案" });
    expect(scoreMemory(m, tokenize("manifest"))).toBeGreaterThan(0);
  });

  it("标签匹配也能得分", () => {
    const m = mem({ content: "无关正文", tags: ["updater"] });
    expect(scoreMemory(m, tokenize("updater"))).toBeGreaterThan(0);
  });

  it("得分不超过相关性上限（加成为乘性，不会把无关项抬进结果）", () => {
    const fresh = mem({ content: "manifest 方案", category: "user_preference", updatedAt: now });
    const stale = mem({ content: "manifest 方案", category: "workflow", updatedAt: "2020-01-01T00:00:00Z" });
    const a = scoreMemory(fresh, tokenize("manifest"));
    const b = scoreMemory(stale, tokenize("manifest"));
    expect(a).toBeLessThanOrEqual(1);
    expect(b).toBeLessThanOrEqual(1);
    // 相关性相同时，新的、高权重分类的排前面
    expect(a).toBeGreaterThan(b);
  });

  it("时效与分类只在相关项之间拉开差距", () => {
    const relevant = mem({ content: "关于 updater 的说明", updatedAt: now });
    const irrelevant = mem({ content: "毫无关系", category: "user_preference", updatedAt: now });
    expect(scoreMemory(relevant, tokenize("updater"))).toBeGreaterThan(
      scoreMemory(irrelevant, tokenize("updater")),
    );
  });

  it("空查询仍走时效+分类（用于无查询场景）", () => {
    const m = mem({ content: "任意内容", category: "user_preference", updatedAt: now });
    expect(scoreMemory(m, [])).toBeGreaterThan(0);
  });
});

describe("recallMemories — 结果集", () => {
  const pool = [
    mem({ content: "skill 同步采用 manifest 方案" }),
    mem({ content: "updater 的下载状态放在模块级 store" }),
    mem({ content: "完全无关的内容甲", category: "feedback", updatedAt: now }),
    mem({ content: "完全无关的内容乙", category: "user_preference", updatedAt: now }),
    mem({ content: "完全无关的内容丙", category: "project_context", updatedAt: now }),
    mem({ content: "完全无关的内容丁", category: "workflow", updatedAt: now }),
  ];

  it("无关查询返回空，不再退化成「最近 N 条」", () => {
    expect(recallMemories("zzzz", pool)).toEqual([]);
  });

  it("只返回真正相关的条目", () => {
    const r = recallMemories("manifest", pool);
    expect(r.length).toBe(1);
    expect(r[0].memory.content).toContain("manifest");
  });

  it("结果按分数降序", () => {
    const r = recallMemories("store updater", pool);
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score);
    }
  });

  it("空池返回空", () => {
    expect(recallMemories("任意", [])).toEqual([]);
  });
});
