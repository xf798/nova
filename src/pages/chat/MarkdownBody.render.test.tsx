import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";

// MarkdownBody 依赖的 Tauri API 在测试环境不可用
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: vi.fn(),
}));

const { default: MarkdownBody } = await import("./MarkdownBody");

const render = (md: string) => renderToString(React.createElement(MarkdownBody, null, md));

// 语法高亮按块启用（含代码围栏才跑 rehypeHighlight）。
// 这批用例守住「省了开销但没省掉功能」：代码块该有高亮、纯文本块内容不能坏。
describe("MarkdownBody — 按需语法高亮", () => {
  it("代码块带 hljs 类名（高亮生效）", () => {
    const html = render("```ts\nconst a: number = 1;\n```");
    expect(html).toContain("hljs");
  });

  it("无语言标注的代码块不加 hljs（rehype-highlight 默认需要语言标注，改动前后一致）", () => {
    const html = render("```\nplain code\n```");
    expect(html).not.toContain("hljs");
    expect(html).toContain("plain code");
  });

  it("纯文本块不含 hljs，但格式化正常", () => {
    const html = render("**粗体** 与 *斜体*");
    expect(html).not.toContain("hljs");
    expect(html).toContain("<strong>");
    expect(html).toContain("<em>");
  });

  it("行内代码不触发高亮，仍走 inline-code 样式", () => {
    const html = render("这里有 `foo()` 行内代码");
    expect(html).not.toContain("hljs");
    expect(html).toContain("inline-code");
  });

  it("混合内容：代码块高亮且前后文本完整", () => {
    const html = render("说明文字\n\n```js\nconst x = 1;\n```\n\n后续文字");
    expect(html).toContain("hljs");
    expect(html).toContain("说明文字");
    expect(html).toContain("后续文字");
  });

  it("列表中嵌套的代码围栏也能高亮（含围栏即启用）", () => {
    const html = render("- 步骤一\n\n  ```sh\n  npm run build\n  ```\n");
    expect(html).toContain("hljs");
  });

  it("表格不触发高亮，且走 components 里的自定义包裹", () => {
    const html = render("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).not.toContain("hljs");
    // components.table 把表格包在带边框的 div 里
    expect(html).toContain("<table");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("<th>a</th>");
  });

  it("空内容不报错", () => {
    expect(() => render("")).not.toThrow();
  });
});
