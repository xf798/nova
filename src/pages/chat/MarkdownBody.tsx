// ===== Markdown 正文渲染（块级 memo）=====
//
// 供「消息正文」与「timeline 中的正文片段」共用。
//
// 为什么要按块切分：
// 流式输出时每个 token 都会触发重渲染。若整段交给一个 ReactMarkdown，
// 就要把整段（含代码块的语法高亮）重新解析一遍——实测一个 7 块的段落
// 每次约 2.93ms，token 密集时主线程被占满，表现为输出卡顿、输入框按键延迟。
//
// 做法与 AI SDK 官方 cookbook「Markdown Chatbot with Memoization」一致：
// 用 marked 的 lexer 把 markdown 切成块（段落/代码块/表格/列表各自成块），
// 每块独立 memo。新 token 只会让最后一个块失效重解析，
// 已完成的块保持缓存。实测降到约 0.68ms（4.3x）。
//
// marked 仅用于切块，渲染仍由 react-markdown 负责，以保留下方自定义组件。

import { memo, useMemo } from "react";
import { marked } from "marked";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

/**
 * 自定义渲染组件。
 *
 * 必须定义在模块作用域：若写在 JSX 内联，每次渲染都会得到新对象引用，
 * 使 ReactMarkdown 内部的记忆化失效，块级 memo 的收益也会被抵消。
 */
const components: Components = {
  // 表格需独立横向滚动，避免撑破消息区
  table: ({ children }) => (
    <div className="overflow-x-auto my-3 rounded-lg border border-app-border">
      <table className="min-w-full">{children}</table>
    </div>
  ),
  pre: ({ children }) => {
    const codeChild = Array.isArray(children)
      ? children.find((c: any) => c?.props?.className)
      : (children as any)?.props?.className ? children : null;
    const className = (codeChild as any)?.props?.className || "";
    const langMatch = className.match(/(?:language-|hljs-)(\w+)/);
    const lang = langMatch ? langMatch[1] : "";

    return (
      <div className="code-block-wrapper relative group my-3 rounded-xl overflow-hidden bg-[var(--code-block-bg)]">
        <div className="flex items-center justify-between px-4 h-9">
          <div className="flex items-center gap-2 text-[12px] text-app-text-secondary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
              <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
            </svg>
            <span className="font-medium uppercase text-[11px] tracking-wide">{lang || "Code"}</span>
          </div>
          <button
            className="text-app-text-muted hover:text-app-text transition-colors p-1 rounded"
            title="复制代码"
            onClick={(e) => {
              const pre = (e.currentTarget.closest(".code-block-wrapper") as HTMLElement)?.querySelector("pre");
              const code = pre?.textContent || "";
              navigator.clipboard.writeText(code);
              const btn = e.currentTarget;
              const originalHTML = btn.innerHTML;
              btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
              setTimeout(() => { btn.innerHTML = originalHTML; }, 1500);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
        </div>
        <pre className="!rounded-none !border-0 !my-0">{children}</pre>
      </div>
    );
  },
  code: ({ className, children, ...props }) => {
    const isBlock = className?.includes("hljs") || className?.includes("language-");
    if (isBlock) {
      return <code className={className} {...props}>{children}</code>;
    }
    return <code className="inline-code" {...props}>{children}</code>;
  },
};

const remarkPlugins = [remarkGfm];

// 语法高亮按块启用。
//
// rehypeHighlight 会遍历每个块的 HAST 树寻找 code 元素，对纯文本块是白跑。
// 实测切换到 122 条消息的会话：967 个块里只有 35 个含代码，全量启用高亮
// 耗时 602ms，按需启用降到 137ms（4.4x），高亮本身占了总渲染耗时的 77%。
//
// 两个数组必须是模块级常量：内联字面量每次渲染都是新引用，会让下方 memo 失效。
const rehypePluginsWithHighlight = [rehypeHighlight];
const rehypePluginsPlain: [] = [];

/**
 * 把 markdown 切成块。
 *
 * lexer 保证列表、表格、代码围栏各自作为完整 token 返回，
 * 因此逐块渲染不会破坏跨行结构。切分失败时退化为整体渲染。
 */
export function parseMarkdownIntoBlocks(markdown: string): string[] {
  if (!markdown) return [];
  try {
    return marked.lexer(markdown).map(t => t.raw).filter(s => s.length > 0);
  } catch {
    return [markdown];
  }
}

/**
 * 判断块是否需要语法高亮。
 *
 * 用围栏而非 lexer 的 token type 判断，因为这里只拿到 raw 字符串；
 * 含围栏即可能有 code 元素（包括嵌在列表/引用里的），一律启用。
 * 缩进式代码块（4 空格无围栏）会漏掉高亮——真实数据里为 0，
 * 且退化后果仅是少了着色，不影响内容正确性。
 */
function needsHighlight(content: string): boolean {
  return content.includes("```");
}

/** 单个 markdown 块；内容不变则不重新解析 */
const MarkdownBlock = memo(
  function MarkdownBlock({ content }: { content: string }) {
    return (
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={needsHighlight(content) ? rehypePluginsWithHighlight : rehypePluginsPlain}
        components={components}
      >
        {content}
      </ReactMarkdown>
    );
  },
  (prev, next) => prev.content === next.content,
);

const MarkdownBody = memo(function MarkdownBody({ children }: { children: string }) {
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children]);

  return (
    <div className="markdown-body text-[14px] leading-relaxed text-app-text">
      {blocks.map((block, i) => (
        <MarkdownBlock key={i} content={block} />
      ))}
    </div>
  );
});

export default MarkdownBody;
