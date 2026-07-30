import { useState, memo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Message } from "../../core/types";
import type { TimelineEvent } from "../../connectors";
import { deriveLegacyTimeline } from "../../connectors/timeline";
import ProcessTimeline from "./ProcessTimeline";

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

  // 过程时间线：新消息由连接器产出；历史消息现场降级出近似时间线，
  // 使渲染只需一套代码（旧数据无文本位置信息，约定 思考 → 工具 → 正文）
  const timelineEvents: TimelineEvent[] = meta?.timeline && meta.timeline.length > 0
    ? meta.timeline
    : deriveLegacyTimeline({
        content: displayContent,
        thought: meta?.thought,
        toolCalls: (meta?.toolCalls as ToolCallInfo[] | undefined)?.map(tc => ({
          toolCallId: tc.toolCallId,
          title: tc.title,
          kind: tc.kind,
          status: tc.status as "pending" | "in_progress" | "completed" | "failed",
          startedAt: tc.startedAt,
          completedAt: tc.completedAt,
        })),
      });

  const [recallExpanded, setRecallExpanded] = useState(false);

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

        {/* 流式刚开始、还没有任何过程事件时的等待指示 */}
        {isStreaming && timelineEvents.length === 0 && (
          <div className="mb-2 flex items-center gap-2 text-[12px] text-app-text-muted">
            <div className="w-7 h-7 flex items-center justify-center flex-shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-gray-400" strokeWidth="2" strokeLinecap="round" style={{ animation: "spin 2.5s linear infinite" }}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            </div>
            <span className="animate-pulse">Thinking</span>
          </div>
        )}

        {/* 过程与正文按真实顺序内联渲染 */}
        <ProcessTimeline events={timelineEvents} isStreaming={isStreaming} />

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
