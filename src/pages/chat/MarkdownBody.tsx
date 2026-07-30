// ===== Markdown 正文渲染 =====
//
// 从 MessageItem 抽出，供「消息正文」与「timeline 中的正文片段」共用，
// 避免两处各写一套 ReactMarkdown 配置。

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

function MarkdownBody({ children }: { children: string }) {
  return (
    <div className="markdown-body text-[14px] leading-relaxed text-app-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
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
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownBody;
