import { describe, it, expect } from "vitest";
import { parseMarkdownIntoBlocks } from "./MarkdownBody";

describe("parseMarkdownIntoBlocks", () => {
  it("空输入返回空数组", () => {
    expect(parseMarkdownIntoBlocks("")).toEqual([]);
  });

  it("拼回原文（块级 raw 必须无损，否则内容会丢字）", () => {
    const md = "# 标题\n\n段落一。\n\n- a\n- b\n\n```ts\nconst x=1;\n```\n\n段落二。";
    expect(parseMarkdownIntoBlocks(md).join("")).toBe(md);
  });

  it("多个段落切成多块", () => {
    const blocks = parseMarkdownIntoBlocks("第一段。\n\n第二段。\n\n第三段。");
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });

  it("代码围栏作为单块，不被拆散", () => {
    const md = "说明\n\n```ts\nline1\n\nline2\n```\n";
    const blocks = parseMarkdownIntoBlocks(md);
    const fence = blocks.find(b => b.includes("```"));
    expect(fence).toBeDefined();
    // 围栏内的空行不应导致拆块
    expect(fence!).toContain("line1");
    expect(fence!).toContain("line2");
  });

  it("列表作为单块，不被逐项拆散", () => {
    const blocks = parseMarkdownIntoBlocks("- 一\n- 二\n- 三\n");
    const list = blocks.filter(b => b.includes("- "));
    expect(list.length).toBe(1);
    expect(list[0]).toContain("一");
    expect(list[0]).toContain("三");
  });

  it("表格作为单块", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n";
    const blocks = parseMarkdownIntoBlocks(md);
    const table = blocks.filter(b => b.includes("|"));
    expect(table.length).toBe(1);
  });

  it("未闭合的代码围栏不抛错（流式中间态）", () => {
    expect(() => parseMarkdownIntoBlocks("说明\n\n```ts\nconst a = 1;")).not.toThrow();
  });

  it("流式增长：已完成的块保持稳定，只有末块变化", () => {
    const a = parseMarkdownIntoBlocks("第一段。\n\n第二段。\n\n正在写");
    const b = parseMarkdownIntoBlocks("第一段。\n\n第二段。\n\n正在写更多内容");
    // 前缀块逐一相同 —— 这是块级 memo 能命中的前提
    expect(b.slice(0, a.length - 1)).toEqual(a.slice(0, a.length - 1));
    expect(b[b.length - 1]).not.toBe(a[a.length - 1]);
  });

  it("不产生空块（空块会渲染出多余间距）", () => {
    const blocks = parseMarkdownIntoBlocks("段落。\n\n\n\n另一段。\n\n\n");
    expect(blocks.every(b => b.length > 0)).toBe(true);
  });
});
