import { useState, useEffect, memo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Message } from "../../core/types";

// ─── Tool Call Types ───
interface ToolCallInfo {
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  startedAt: number;
  completedAt?: number;
}

const MessageItem = memo(function MessageItem({ message, onImageClick, onAddAttachment, isSessionProcessing = false, isLastMessage = false, onCopy, onRetry, onQuote }: {
  message: Message;
  onImageClick: (path: string) => void;
  onAddAttachment?: (path: string) => void;
  isSessionProcessing?: boolean;
  isLastMessage?: boolean;
  onCopy?: () => void;
  onRetry?: () => void;
  onQuote?: () => void;
}) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isLoading = message.content === "$$LOADING$$";

  const isStreaming = isSessionProcessing && isLastMessage && message.id.includes("loading") && !isLoading;

  const displayContent = (message.content || "").trimEnd();
  const meta = message.meta;
  const toolCalls: ToolCallInfo[] = (meta?.toolCalls as ToolCallInfo[]) || [];

  const sortedToolCalls = [...toolCalls].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const now = Date.now();
  const MIN_DISPLAY_MS = 1000;
  const activeToolCalls = sortedToolCalls.filter(tc =>
    tc.status === "in_progress" || tc.status === "pending" ||
    ((tc.status === "completed" || tc.status === "failed") && tc.completedAt && (now - tc.completedAt) < MIN_DISPLAY_MS)
  );
  const completedToolCalls = sortedToolCalls.filter(tc =>
    (tc.status === "completed" || tc.status === "failed") &&
    (!tc.completedAt || (now - tc.completedAt) >= MIN_DISPLAY_MS)
  );
  const [toolListExpanded, setToolListExpanded] = useState(false);
  const [thoughtExpanded, setThoughtExpanded] = useState(false);
  const [recallExpanded, setRecallExpanded] = useState(false);

  const [, forceRender] = useState(0);
  useEffect(() => {
    const recentlyCompleted = sortedToolCalls.filter(tc =>
      (tc.status === "completed" || tc.status === "failed") && tc.completedAt && (Date.now() - tc.completedAt) < MIN_DISPLAY_MS
    );
    if (recentlyCompleted.length > 0) {
      const timer = setTimeout(() => forceRender(n => n + 1), MIN_DISPLAY_MS);
      return () => clearTimeout(timer);
    }
  }, [sortedToolCalls]);

  if (isLoading) {
    return (
      <div className="py-2">
        <div className="w-8 h-8 flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-gray-400" strokeWidth="2" strokeLinecap="round" style={{ animation: "spin 2.5s linear infinite" }}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
        </div>
      </div>
    );
  }

  if (isSystem) {
    return (
      <div className="px-3 py-2 rounded-lg text-[12px] text-app-text-muted border border-app-border bg-app-surface whitespace-pre-wrap">
        {message.content}
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="flex items-start justify-end group">
        <div className="max-w-[85%]">
          {message.quotedMessage && (
            <div className="flex justify-end mb-1">
              <div className="px-3 py-1.5 rounded-2xl text-[12px] text-app-text-muted border border-app-border max-w-full truncate"
                style={{ backgroundColor: "var(--app-surface-hover)" }}>
                <span className="opacity-60">{message.quotedMessage.role === "user" ? "我" : "AI"}:</span>{" "}
                {message.quotedMessage.content.slice(0, 80)}{message.quotedMessage.content.length > 80 ? "…" : ""}
              </div>
            </div>
          )}
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2 justify-end">
              {message.attachments.map((path, i) => (
                isImgPath(path) ? (
                  <div key={i} className="relative group/img">
                    <img src={convertFileSrc(path)} alt="" className="max-w-[180px] max-h-[180px] rounded-2xl object-cover cursor-pointer"
                      onClick={() => onImageClick(path)} />
                    {onAddAttachment && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onAddAttachment(path); }}
                        className="absolute bottom-2 right-2 w-7 h-7 flex items-center justify-center rounded-lg bg-black/50 hover:bg-black/70 text-white opacity-0 group-hover/img:opacity-100 transition-opacity"
                        title="添加到输入框"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 5v14M5 12h14"/>
                        </svg>
                      </button>
                    )}
                  </div>
                ) : (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-app-border bg-app-surface">
                    <span>📄</span><span className="text-[12px] text-app-text-secondary">{path.split("/").pop()}</span>
                  </div>
                )
              ))}
            </div>
          )}
          {message.content && (
            <div className="px-4 py-2.5 rounded-3xl text-[14px] leading-relaxed whitespace-pre-wrap break-words"
              style={{ backgroundColor: "var(--app-msg-user-bg)" }}>
              {message.content}
            </div>
          )}
          {onQuote && message.content && (
            <div className="mt-1 flex items-center gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={onQuote}
                className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-app-surface-hover transition-colors"
                title="引用"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-app-text-muted" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 17 4 12 9 7"/>
                  <path d="M20 18v-2a4 4 0 00-4-4H4"/>
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start group">
      <div className="flex-1 min-w-0">

        {isStreaming && activeToolCalls.length === 0 && (
          <div className="mb-2">
            <div className="flex items-start gap-2 text-[12px] text-app-text-muted">
              <div className="w-7 h-7 flex items-center justify-center flex-shrink-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-gray-400" strokeWidth="2" strokeLinecap="round" style={{ animation: "spin 2.5s linear infinite" }}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
              </div>
              {meta?.thought ? (
                <div className="flex-1 min-w-0 whitespace-pre-wrap leading-relaxed max-h-[300px] overflow-y-auto pt-1" style={{ opacity: 0.7 }}>
                  {meta.thought}
                </div>
              ) : (
                <span className="pt-1 animate-pulse">Thinking</span>
              )}
            </div>
          </div>
        )}

        {activeToolCalls.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            {activeToolCalls.map((tc) => (
              <div key={tc.toolCallId} className="flex items-center gap-2 text-[12px] text-app-text-muted animate-pulse">
                <div className="w-7 h-7 flex items-center justify-center flex-shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-gray-400" strokeWidth="2" strokeLinecap="round" style={{ animation: "spin 2.5s linear infinite" }}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                </div>
                <span className="truncate">{tc.title}</span>
              </div>
            ))}
          </div>
        )}

        {!isStreaming && meta?.thought && (
          <div className="mb-2">
            <button
              onClick={() => setThoughtExpanded(!thoughtExpanded)}
              className="flex items-center gap-2 text-[12px] text-app-text-muted hover:text-app-text-secondary transition-colors"
            >
              <div className="w-7 h-7 flex items-center justify-center flex-shrink-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-purple-500 dark:text-purple-400" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
              </div>
              <span>已思考</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" className={`transition-transform duration-200 ${thoughtExpanded ? "rotate-180" : ""}`} strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6"/></svg>
            </button>

            {thoughtExpanded && (
              <div className="mt-1.5 ml-7 text-[12px] leading-relaxed text-app-text-muted whitespace-pre-wrap max-h-[400px] overflow-y-auto">
                {meta.thought}
              </div>
            )}
          </div>
        )}

        {completedToolCalls.length > 0 && (
          <div className="mb-2">
            <button
              onClick={() => setToolListExpanded(!toolListExpanded)}
              className="flex items-center gap-2 text-[12px] text-app-text-muted hover:text-app-text-secondary transition-colors"
            >
              <div className="w-7 h-7 flex items-center justify-center flex-shrink-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-green-600 dark:text-green-400" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
              </div>
              <span>{completedToolCalls.length} 个工具已调用</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" className={`transition-transform duration-200 ${toolListExpanded ? "rotate-180" : ""}`} strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6"/></svg>
            </button>

            {toolListExpanded && (
              <div className="mt-1.5 ml-7 flex flex-col gap-0.5">
                {completedToolCalls.map((tc) => (
                  <div key={tc.toolCallId} className="flex items-center gap-1.5 text-[11px] text-app-text-muted py-0.5">
                    {tc.status === "completed" ? (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-green-600 dark:text-green-400 flex-shrink-0" strokeWidth="2" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
                    ) : (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-red-500 flex-shrink-0" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    )}
                    <span className="truncate">{tc.title}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 召回明细（可观测）：本次注入的记忆/技能 */}
        {message.recall && (message.recall.memories.length > 0 || message.recall.skills.length > 0) && (
          <div className="mb-2">
            <button
              onClick={() => setRecallExpanded(!recallExpanded)}
              className="flex items-center gap-2 text-[12px] text-app-text-muted hover:text-app-text-secondary transition-colors"
            >
              <div className="w-7 h-7 flex items-center justify-center flex-shrink-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-blue-500 dark:text-blue-400" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.5.4.8 1 .9 1.6M12 2a7 7 0 0 1 4 12.7c-.5.4-.8 1-.9 1.6"/></svg>
              </div>
              <span>
                召回 {message.recall.memories.length > 0 && `${message.recall.memories.length} 记忆`}
                {message.recall.memories.length > 0 && message.recall.skills.length > 0 && " · "}
                {message.recall.skills.length > 0 && `${message.recall.skills.length} 技能`}
                {message.recall.estimated && " · 预计"}
              </span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" className={`transition-transform duration-200 ${recallExpanded ? "rotate-180" : ""}`} strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6"/></svg>
            </button>

            {recallExpanded && (
              <div className="mt-1.5 ml-7 flex flex-col gap-2 max-w-[680px]">
                {message.recall.skills.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-medium text-app-text-muted uppercase tracking-wide">技能</span>
                    {message.recall.skills.map((s) => (
                      <div key={s.name} className="flex items-start gap-1.5 text-[11px]">
                        <span className={`shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium ${
                          s.source === "query" ? "bg-blue-500/15 text-blue-500" : s.source === "path" ? "bg-purple-500/15 text-purple-500" : "bg-app-surface-hover text-app-text-muted"
                        }`}>
                          {s.source === "query" ? "场景召回" : s.source === "path" ? "路径" : "常驻"}
                        </span>
                        <span className="text-app-text-secondary min-w-0">
                          {s.displayName}
                          {s.distilled && <span className="ml-1 text-[9px] text-green-500">✦蒸馏</span>}
                          {typeof s.score === "number" && <span className="ml-1 text-app-text-muted">{s.score.toFixed(2)}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {message.recall.memories.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-medium text-app-text-muted uppercase tracking-wide">记忆</span>
                    {message.recall.memories.map((m, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-[11px]">
                        <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-app-surface-hover text-app-text-muted">{m.category}</span>
                        <span className="text-app-text-secondary min-w-0 leading-relaxed">
                          {m.content.length > 120 ? m.content.slice(0, 120) + "…" : m.content}
                          {m.distilled && <span className="ml-1 text-[9px] text-green-500">✦蒸馏</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {message.recall.estimated && (
                  <p className="text-[9px] text-app-text-muted">※ 当前连接器由其自身加载技能，此处为 Nova 按同一算法的预计召回，可能与实际注入不完全一致。</p>
                )}
              </div>
            )}
          </div>
        )}

        {displayContent && (
          <div className="markdown-body text-[14px] leading-relaxed text-app-text">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
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
              {displayContent}
            </ReactMarkdown>
          </div>
        )}

        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.attachments.map((path, i) => (
              isImgPath(path) ? (
                <div key={i} className="relative group/img rounded-xl overflow-hidden border border-app-border bg-app-surface">
                  <img
                    src={convertFileSrc(path)}
                    alt="截图"
                    className="max-w-[320px] max-h-[240px] object-contain cursor-pointer"
                    onClick={() => onImageClick(path)}
                  />
                  {onAddAttachment && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onAddAttachment(path); }}
                      className="absolute bottom-2 right-2 w-7 h-7 flex items-center justify-center rounded-lg bg-black/50 hover:bg-black/70 text-white opacity-0 group-hover/img:opacity-100 transition-opacity"
                      title="添加到输入框"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 5v14M5 12h14"/>
                      </svg>
                    </button>
                  )}
                </div>
              ) : (
                <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-app-border bg-app-surface">
                  <span>📄</span><span className="text-[12px] text-app-text-secondary">{path.split("/").pop()}</span>
                </div>
              )
            ))}
          </div>
        )}

        {!isStreaming && displayContent && (
          <div className="mt-1.5 flex items-center gap-2 text-[10px] text-app-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
            {onCopy && (
              <button
                onClick={() => {
                  onCopy();
                  const btn = document.activeElement as HTMLButtonElement;
                  const originalTitle = btn?.title;
                  if (btn) { btn.title = "已复制"; setTimeout(() => { btn.title = originalTitle; }, 1500); }
                }}
                className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-app-surface-hover transition-colors"
                title="复制"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                </svg>
              </button>
            )}
            {onRetry && (
              <button
                onClick={onRetry}
                className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-app-surface-hover transition-colors"
                title="重试"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1 4 1 10 7 10"/>
                  <path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
                </svg>
              </button>
            )}
            {onQuote && (
              <button
                onClick={onQuote}
                className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-app-surface-hover transition-colors"
                title="引用"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 17 4 12 9 7"/>
                  <path d="M20 18v-2a4 4 0 00-4-4H4"/>
                </svg>
              </button>
            )}
            <span className="opacity-60">{formatMsgTime(message.timestamp)}</span>
          </div>
        )}

      </div>
    </div>
  );
});

/** 格式化消息时间为 MM/DD HH:mm */
export function formatMsgTime(timestamp: string): string {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${min}`;
}

export function isImgPath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path);
}

export default MessageItem;
