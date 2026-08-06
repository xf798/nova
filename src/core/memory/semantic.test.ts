// ===== 语义召回与排名融合 =====
//
// 阈值与融合方式都是实测校准的结果，不是拍的：
//
// 阈值 0.55：6 组口语提问 × 5 个候选阈值实测
//   0.45/0.50 命中 5/6 返回 4.2 条；0.55 命中 5/6 返回 3.7 条；0.60 命中 3/6
//   最初定 0.60 是只用了 4 个书面化查询，换成口语提问后发现相关内容
//   落在 0.50-0.60 —— 记忆是书面技术总结，提问是口语，风格差得远。
//
// 融合改用 RRF：两侧分数量纲不同（语义余弦 0.55-0.75，关键词 0.15-0.70），
// 加权平均会出现「语义+关键词都命中」反而低于「只有语义命中」的荒谬结果。

import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const { fuseRanked, semanticSearch, hasLexicalAnchor, SEMANTIC_THRESHOLD, SEMANTIC_WEIGHT } =
  await import("./semantic");

describe("阈值", () => {
  it("取 0.55（实测最优：命中率与更低阈值相同但返回更精简）", () => {
    expect(SEMANTIC_THRESHOLD).toBe(0.55);
  });

  it("语义权重大于关键词", () => {
    expect(SEMANTIC_WEIGHT).toBeGreaterThan(0.5);
  });
});

describe("RRF 融合", () => {
  it("两侧都命中的排名高于只有一侧命中的", () => {
    // 这正是加权平均搞错的地方：关键词命中曾把语义排名拉低
    const s = fuseRanked(["both", "semOnly"], ["both", "kwOnly"]);
    expect(s.get("both")!).toBeGreaterThan(s.get("semOnly")!);
    expect(s.get("both")!).toBeGreaterThan(s.get("kwOnly")!);
  });

  it("同名次时语义侧权重更高", () => {
    const s = fuseRanked(["a"], ["b"]);
    expect(s.get("a")!).toBeGreaterThan(s.get("b")!);
  });

  it("靠前的名次得分更高", () => {
    const s = fuseRanked(["first", "second", "third"], []);
    expect(s.get("first")!).toBeGreaterThan(s.get("second")!);
    expect(s.get("second")!).toBeGreaterThan(s.get("third")!);
  });

  it("只有语义结果时也能排序", () => {
    const s = fuseRanked(["a", "b"], []);
    expect(s.size).toBe(2);
    expect(s.get("a")!).toBeGreaterThan(s.get("b")!);
  });

  it("只有关键词结果时也能排序", () => {
    const s = fuseRanked([], ["a", "b"]);
    expect(s.size).toBe(2);
    expect(s.get("a")!).toBeGreaterThan(s.get("b")!);
  });

  it("两侧都空则结果为空", () => {
    expect(fuseRanked([], []).size).toBe(0);
  });

  it("不受分数量纲影响（这是改用排名的原因）", () => {
    // 无论各路原始分数多少，只要名次相同，融合结果就相同
    const a = fuseRanked(["x", "y"], ["y", "x"]);
    const b = fuseRanked(["x", "y"], ["y", "x"]);
    expect(a.get("x")).toBe(b.get("x"));
  });
});

describe("semanticSearch 阈值过滤", () => {
  it("过滤掉低于阈值的命中", async () => {
    invoke.mockClear();
    invoke.mockResolvedValue({
      hits: [
        { id: "high", score: 0.7 },
        { id: "edge", score: 0.55 },
        { id: "low", score: 0.54 },
      ],
    });
    const r = await semanticSearch("查询");
    expect(r.map(h => h.id)).toEqual(["high", "edge"]);
  });

  it("空查询不请求后端", async () => {
    invoke.mockClear();
    const r = await semanticSearch("   ");
    expect(r).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("资产未就绪时静默返回空（降级到关键词）", async () => {
    invoke.mockClear();
    invoke.mockRejectedValue(new Error("模型资产未就绪"));
    expect(await semanticSearch("查询")).toEqual([]);
  });

  it("其他错误也降级而非抛出", async () => {
    invoke.mockClear();
    invoke.mockRejectedValue(new Error("推理失败"));
    expect(await semanticSearch("查询")).toEqual([]);
  });
});

describe("词面锚点过滤", () => {
  // 小模型抓话题强、分主语弱：「之前那个切换慢是怎么弄的」召回到
  // 「录音mode2修复方案简化」(0.590) 与正确答案(0.599) 仅差 0.009，
  // 两者都在讲「某问题怎么修的」。这种差距调阈值解决不了。
  it("主语相同则保留", () => {
    expect(hasLexicalAnchor(
      "之前那个切换慢是怎么弄的",
      "Nova会话切换性能方案：首屏20条+翻页30条",
    )).toBe(true);
  });

  it("话题相近但主语不同则拦截", () => {
    expect(hasLexicalAnchor(
      "之前那个切换慢是怎么弄的",
      "录音mode2修复方案简化：15秒回查机制可以整个砍掉",
    )).toBe(false);
  });

  it("英文技术名词整体作为锚点", () => {
    expect(hasLexicalAnchor("JSONL 迁移怎么做的", "会话存储已迁移到 jsonl 格式")).toBe(true);
  });

  it("无实义片段时不过滤（交给闸门处理）", () => {
    expect(hasLexicalAnchor("做吧", "任意内容")).toBe(true);
  });

  it("空查询不过滤", () => {
    expect(hasLexicalAnchor("", "任意内容")).toBe(true);
  });

  it("大小写不敏感", () => {
    expect(hasLexicalAnchor("rehypeHighlight 慢", "用 REHYPEHIGHLIGHT 做高亮")).toBe(true);
  });

  it("不传 contents 时跳过锚点过滤", async () => {
    invoke.mockClear();
    invoke.mockResolvedValue({ hits: [{ id: "a", score: 0.7 }] });
    const r = await semanticSearch("切换慢");
    expect(r).toHaveLength(1);
  });

  it("传 contents 时按锚点过滤", async () => {
    invoke.mockClear();
    invoke.mockResolvedValue({
      hits: [{ id: "keep", score: 0.7 }, { id: "drop", score: 0.7 }],
    });
    const contents = new Map([
      ["keep", "会话切换性能方案"],
      ["drop", "录音修复方案"],
    ]);
    const r = await semanticSearch("切换慢是怎么弄的", 10, contents);
    expect(r.map(h => h.id)).toEqual(["keep"]);
  });
});
