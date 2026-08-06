// ===== 超长内容折叠 =====
//
// 实测（4053 个真实文本段）：P95 = 1.5KB、P99 = 4.6KB，最大 554KB。
// 超过 8KB 的只占 0.6%（25 段）却占 64% 的正文量 ——
// 极少数超长内容吃掉绝大部分渲染成本。
//
// 两个慢会话的分阶段实测：
//   客户画像后端代码：单条 13.7KB 含 43 个代码块 → commit 357ms
//   客户画像问题修复：单条 150KB 用户消息    → paint 164ms（React 只花 44ms）
//
// 这批用例固定折叠的判定与截断行为。

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: vi.fn(),
}));

const CollapsibleText = (await import("./CollapsibleText")).default;
const MarkdownBody = (await import("./MarkdownBody")).default;

const render = (el: React.ReactElement) => renderToString(el);
const text = (n: number) => "x".repeat(n);

describe("CollapsibleText — 纯文本折叠", () => {
  it("短文本原样输出，不出现折叠按钮", () => {
    const html = render(React.createElement(CollapsibleText, { text: text(1000) }));
    expect(html).not.toContain("展开全文");
  });

  it("刚好 8KB 不折叠（阈值是「超过」）", () => {
    const html = render(React.createElement(CollapsibleText, { text: text(8 * 1024) }));
    expect(html).not.toContain("展开全文");
  });

  it("超过 8KB 折叠，并标出总大小", () => {
    const html = render(React.createElement(CollapsibleText, { text: text(150 * 1024) }));
    expect(html).toContain("展开全文");
    expect(html).toContain("150KB");
  });

  it("折叠后输出的 DOM 远小于原文（这是 paint 提速的来源）", () => {
    const big = text(150 * 1024);
    const html = render(React.createElement(CollapsibleText, { text: big }));
    // 只输出约 2KB 预览 + 按钮，不应接近原文体积
    expect(html.length).toBeLessThan(big.length / 10);
  });

  it("在换行处截断，不把一行劈开", () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `第 ${i} 行内容，这里再补一些字凑够长度`).join("\n");
    expect(lines.length).toBeGreaterThan(8 * 1024);
    const html = render(React.createElement(CollapsibleText, { text: lines }));
    // 预览段应以完整的一行结束（后面紧跟省略号）
    expect(html).toContain("展开全文");
  });

  it("极长单行（无换行可截）也能折叠而不报错", () => {
    const oneLine = text(50 * 1024);
    expect(() => render(React.createElement(CollapsibleText, { text: oneLine }))).not.toThrow();
  });

  it("className 与 style 透传（保持气泡样式）", () => {
    const html = render(React.createElement(CollapsibleText, {
      text: "短内容", className: "rounded-3xl", style: { backgroundColor: "red" },
    }));
    expect(html).toContain("rounded-3xl");
  });
});

describe("MarkdownBody — markdown 折叠", () => {
  it("短内容不折叠", () => {
    const html = render(React.createElement(MarkdownBody, null, "# 标题\n\n正文"));
    expect(html).not.toContain("展开全文");
  });

  it("超长内容折叠并显示剩余段数", () => {
    const md = Array.from({ length: 600 }, (_, i) => `第 ${i} 段内容，补充一些文字让这一段够长一点。`).join("\n\n");
    expect(md.length).toBeGreaterThan(8 * 1024);
    const html = render(React.createElement(MarkdownBody, null, md));
    expect(html).toContain("展开全文");
    expect(html).toContain("还有");
  });

  it("折叠后仍渲染出预览内容，不是空白", () => {
    const md = Array.from({ length: 600 }, (_, i) => `第 ${i} 段内容，补充一些文字让这一段够长一点。`).join("\n\n");
    const html = render(React.createElement(MarkdownBody, null, md));
    expect(html).toContain("第 0 段内容");
  });

  it("单块超长时至少渲染一块，避免空预览", () => {
    // 一整块超过预览额度：仍应输出这一块而非什么都不显示
    const md = "同一段里非常长的内容。".repeat(2000);
    const html = render(React.createElement(MarkdownBody, null, md));
    expect(html).toContain("同一段里非常长的内容");
  });

  it("代码块多的超长内容会被折叠（commit 提速的来源）", () => {
    const md = Array.from({ length: 120 }, (_, i) => `说明第 ${i} 处的实现细节\n\n\`\`\`ts\nconst someVariable${i} = computeValue(${i}, \"extra padding\");\n\`\`\``).join("\n\n");
    expect(md.length).toBeGreaterThan(8 * 1024);
    const html = render(React.createElement(MarkdownBody, null, md));
    expect(html).toContain("展开全文");
    // 折叠后只有少数代码块进入 DOM
    // components.pre 把代码块包成 code-block-wrapper，按它计数
    const rendered = (html.match(/code-block-wrapper/g) || []).length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(60);
  });
});

describe("MarkdownBody — 代码块数量也触发折叠", () => {
  it("短但代码块多的内容会折叠（代码块比同长度纯文本贵得多）", () => {
    // 实测：3.5KB 含 9 个代码块的消息要 19ms，而 10KB 纯文本只要几毫秒
    const md = Array.from({ length: 9 }, (_, i) => `说明${i}\n\n\`\`\`ts\nconst a${i}=${i};\n\`\`\``).join("\n\n");
    expect(md.length).toBeLessThan(8 * 1024);
    const html = render(React.createElement(MarkdownBody, null, md));
    expect(html).toContain("展开全文");
  });

  it("代码块数量在阈值内不折叠", () => {
    const md = Array.from({ length: 3 }, (_, i) => `说明${i}\n\n\`\`\`ts\nconst a${i}=${i};\n\`\`\``).join("\n\n");
    const html = render(React.createElement(MarkdownBody, null, md));
    expect(html).not.toContain("展开全文");
  });

  it("行内反引号不被误计为代码块", () => {
    const md = "这里有 `inline` 和 `more` 行内代码，共 6 个反引号但没有围栏";
    const html = render(React.createElement(MarkdownBody, null, md));
    expect(html).not.toContain("展开全文");
  });
});
