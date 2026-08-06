// ===== 会话搜索 =====
//
// 搜的是磁盘上的 jsonl，而非浏览器原生 ⌘F —— 后者只能命中已渲染的 DOM，
// 而首屏只加载一页、切走还会裁剪内存，长会话里搜不到未加载的部分。

import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const { searchMessages, highlightParts } = await import("./sessionSearch");

describe("highlightParts — 片段切分", () => {
  it("命中处被单独切出", () => {
    const parts = highlightParts("这里有关键词在中间", "关键词");
    expect(parts.map(p => p.text)).toEqual(["这里有", "关键词", "在中间"]);
    expect(parts.map(p => p.matched)).toEqual([false, true, false]);
  });

  it("多处命中全部切出", () => {
    const parts = highlightParts("aXbXc", "X");
    expect(parts.filter(p => p.matched)).toHaveLength(2);
  });

  it("大小写不敏感匹配，但保留原文大小写", () => {
    const parts = highlightParts("用 RehypeHighlight 高亮", "rehypehighlight");
    const hit = parts.find(p => p.matched);
    expect(hit?.text).toBe("RehypeHighlight");
  });

  it("命中在开头", () => {
    const parts = highlightParts("关键词开头", "关键词");
    expect(parts[0]).toEqual({ text: "关键词", matched: true });
  });

  it("命中在结尾", () => {
    const parts = highlightParts("结尾是关键词", "关键词");
    expect(parts[parts.length - 1]).toEqual({ text: "关键词", matched: true });
  });

  it("整段就是命中", () => {
    expect(highlightParts("关键词", "关键词")).toEqual([{ text: "关键词", matched: true }]);
  });

  it("无命中时整段作为普通文本", () => {
    const parts = highlightParts("完全无关的内容", "关键词");
    expect(parts).toEqual([{ text: "完全无关的内容", matched: false }]);
  });

  it("空查询不切分", () => {
    expect(highlightParts("内容", "")).toEqual([{ text: "内容", matched: false }]);
    expect(highlightParts("内容", "   ")).toEqual([{ text: "内容", matched: false }]);
  });

  it("不产生空片段（否则渲染出多余节点）", () => {
    const parts = highlightParts("XX", "X");
    expect(parts.every(p => p.text.length > 0)).toBe(true);
    expect(parts).toHaveLength(2);
  });
});

describe("searchMessages — 调用契约", () => {
  it("空查询直接返回空，不打扰后端", async () => {
    invoke.mockClear();
    const r = await searchMessages("   ", "session", "s1");
    expect(r.results).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("限定本会话时传入 sessionId", async () => {
    invoke.mockClear();
    invoke.mockResolvedValue({ results: [], truncated: false });
    await searchMessages("关键词", "session", "s1");
    expect(invoke).toHaveBeenCalledWith("search_session_messages",
      expect.objectContaining({ sessionId: "s1" }));
  });

  it("全局搜索时 sessionId 传 null", async () => {
    invoke.mockClear();
    invoke.mockResolvedValue({ results: [], truncated: false });
    await searchMessages("关键词", "global", "s1");
    expect(invoke).toHaveBeenCalledWith("search_session_messages",
      expect.objectContaining({ sessionId: null }));
  });

  it("限定本会话却无会话（刚点新对话）→ 返回空且不请求", async () => {
    invoke.mockClear();
    const r = await searchMessages("关键词", "session", null);
    expect(r.results).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("后端报错时降级为空结果而非抛出", async () => {
    invoke.mockClear();
    invoke.mockRejectedValue(new Error("io error"));
    const r = await searchMessages("关键词", "global", null);
    expect(r).toEqual({ results: [], truncated: false });
  });

  it("透传后端返回的命中与截断标记", async () => {
    invoke.mockClear();
    invoke.mockResolvedValue({
      results: [{ sessionId: "s1", snippet: "片段", messageIndex: 3 }],
      truncated: true,
    });
    const r = await searchMessages("关键词", "global", null);
    expect(r.results).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });
});
