// ===== 过程时间线渲染 =====
//
// 按 timeline 的真实顺序内联渲染「正文 / 思考 / 工具」三类事件，
// 使 `文本 → 工具 → 文本 → 思考 → 工具` 的时序在界面上如实呈现，
// 而不是把思考和工具全部堆到消息顶部。
//
// 折叠策略：
// - 思考段流式中展开；该段结束后延迟 COLLAPSE_DELAY_MS 收起
// - 用户手动点过之后不再自动收起（尊重显式操作）
// - 工具行本身只有一行，不折叠

import { useState, useEffect, useRef } from "react";
import MarkdownBody from "./MarkdownBody";
import type { TimelineEvent, TimelineThoughtEvent, TimelineToolEvent } from "../../connectors";

/** 思考段结束后延迟收起的时长；留出余量避免「一闪而逝」 */
const COLLAPSE_DELAY_MS = 600;

/** 把毫秒格式化为人类可读耗时 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

const SpinnerIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-gray-400" strokeWidth="2" strokeLinecap="round" style={{ animation: "spin 2.5s linear infinite" }}>
    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
  </svg>
);

const CheckIcon = ({ className }: { className?: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className={className} strokeWidth="2.5" strokeLinecap="round">
    <path d="M20 6L9 17l-5-5"/>
  </svg>
);

const CrossIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-red-500" strokeWidth="2.5" strokeLinecap="round">
    <path d="M18 6L6 18M6 6l12 12"/>
  </svg>
);

const Chevron = ({ open }: { open: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} strokeWidth="2" strokeLinecap="round">
    <path d="M6 9l6 6 6-6"/>
  </svg>
);

/** 思考段：流式中展开显示全文，结束后收成一行摘要 */
function ThoughtSegment({ event, isActive }: { event: TimelineThoughtEvent; isActive: boolean }) {
  const [expanded, setExpanded] = useState(isActive);
  const userToggled = useRef(false);

  // 该段结束后自动收起（用户手动操作过则不干预）
  useEffect(() => {
    if (isActive) {
      if (!userToggled.current) setExpanded(true);
      return;
    }
    if (userToggled.current) return;
    const timer = setTimeout(() => {
      if (!userToggled.current) setExpanded(false);
    }, COLLAPSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isActive]);

  // 有起止时间才显示秒数；历史消息无时间戳（at=0）时只显示「已思考」
  const duration = event.endedAt && event.at ? event.endedAt - event.at : undefined;
  const summary = isActive
    ? "思考中…"
    : duration
      ? `思考了 ${formatDuration(duration)}`
      : "已思考";

  return (
    <div className="my-2">
      <button
        onClick={() => { userToggled.current = true; setExpanded(!expanded); }}
        className="flex items-center gap-2 text-[12px] text-app-text-muted hover:text-app-text-secondary transition-colors"
      >
        <div className="w-7 h-7 flex items-center justify-center flex-shrink-0">
          {isActive ? <SpinnerIcon /> : <CheckIcon className="text-purple-500 dark:text-purple-400" />}
        </div>
        <span className={isActive ? "animate-pulse" : ""}>{summary}</span>
        <Chevron open={expanded} />
      </button>

      {expanded && (
        <div className="mt-1.5 ml-7 pl-3 border-l border-app-border text-[12px] leading-relaxed text-app-text-muted whitespace-pre-wrap">
          {event.text}
        </div>
      )}
    </div>
  );
}

/** 工具行：单行展示，带状态图标与耗时 */
function ToolRow({ event }: { event: TimelineToolEvent }) {
  const running = event.status === "in_progress" || event.status === "pending";
  const failed = event.status === "failed";
  const duration = event.completedAt && event.at ? event.completedAt - event.at : undefined;

  return (
    <div className={`my-1 flex items-center gap-2 text-[12px] text-app-text-muted ${running ? "animate-pulse" : ""}`}>
      <div className="w-7 h-7 flex items-center justify-center flex-shrink-0">
        {running ? <SpinnerIcon /> : failed ? <CrossIcon /> : <CheckIcon className="text-green-600 dark:text-green-400" />}
      </div>
      <span className="truncate min-w-0">{event.title}</span>
      {duration !== undefined && !running && (
        <span className="shrink-0 text-app-text-muted opacity-60">{formatDuration(duration)}</span>
      )}
    </div>
  );
}

function ProcessTimeline({
  events,
  isStreaming,
}: {
  events: TimelineEvent[];
  isStreaming: boolean;
}) {
  // 流式中最后一个事件视为「进行中」，用于驱动思考段展开与转圈
  const lastIndex = events.length - 1;

  return (
    <>
      {events.map((event, i) => {
        const isLast = i === lastIndex;
        const key = event.kind === "tool" ? `tool-${event.toolCallId}` : `${event.kind}-${i}`;

        if (event.kind === "text") {
          // 空白片段不渲染，避免产生空段落间距
          const text = event.text.trimEnd();
          if (!text) return null;
          return <MarkdownBody key={key}>{text}</MarkdownBody>;
        }

        if (event.kind === "thought") {
          // 思考段的「进行中」判定：流式且是最后一个事件且尚未封段
          const active = isStreaming && isLast && !event.endedAt;
          return <ThoughtSegment key={key} event={event} isActive={active} />;
        }

        return <ToolRow key={key} event={event} />;
      })}
    </>
  );
}

export default ProcessTimeline;
