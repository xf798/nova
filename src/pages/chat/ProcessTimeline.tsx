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

import { useState, useEffect, useRef, memo } from "react";
import MarkdownBody from "./MarkdownBody";
import type { TimelineEvent, TimelineThoughtEvent, TimelineToolEvent } from "../../connectors";

/** 思考段结束后延迟收起的时长；留出余量避免「一闪而逝」 */
const COLLAPSE_DELAY_MS = 600;

/** 连续工具数达到此值才折叠成一组；低于此值直接平铺更易读 */
const TOOL_GROUP_THRESHOLD = 3;

/**
 * 单组展开时最多显示的工具行数。
 * 实测历史数据里出现过 220 个连续工具的组，全量展开会淹没会话，
 * 因此只展示最近的若干条并提示其余数量。
 */
const TOOL_GROUP_MAX_VISIBLE = 30;

/** 把毫秒格式化为人类可读耗时 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/**
 * 清理工具标题中的噪音前缀。
 *
 * 执行类工具的 title 形如：
 *   Running: export PATH="/opt/homebrew/bin:..."; cd /Users/x/proj; grep -n "foo"
 * 环境变量与 cd 前缀会把有效信息挤出可视区域，这里剥掉它们，
 * 只保留真正执行的命令。
 */
export function cleanToolTitle(title: string): string {
  const m = title.match(/^(Running:\s*)([\s\S]+)$/);
  if (!m) return title;

  const prefix = m[1];
  const segments = m[2].split(";");
  let i = 0;
  // 跳过开头的环境变量赋值与目录切换
  while (i < segments.length) {
    const seg = segments[i].trim();
    if (/^export\s+[A-Za-z_][A-Za-z0-9_]*=/.test(seg) || /^cd\s+\S/.test(seg) || seg === "") {
      i++;
      continue;
    }
    break;
  }
  // 全被剥掉说明这条命令本身就只是 env/cd，保留原样更诚实
  if (i >= segments.length) return title;

  return prefix + segments.slice(i).join(";").trim();
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

/**
 * 思考段：流式中展开显示全文，结束后收成一行摘要。
 *
 * 按值 memo，原因同 ToolRow：事件对象每次 emit 都会被重建。
 */
const ThoughtSegment = memo(function ThoughtSegment({ event, isActive }: { event: TimelineThoughtEvent; isActive: boolean }) {
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
        <div className="flex-shrink-0 flex items-center">
          {isActive ? <SpinnerIcon /> : <CheckIcon className="text-purple-500 dark:text-purple-400" />}
        </div>
        <span className={isActive ? "animate-pulse" : ""}>{summary}</span>
        <Chevron open={expanded} />
      </button>

      {expanded && (
        <div className="mt-1.5 ml-[22px] pl-3 border-l border-app-border text-[12px] leading-relaxed text-app-text-muted whitespace-pre-wrap">
          {event.text}
        </div>
      )}
    </div>
  );
}, (prev, next) =>
  prev.isActive === next.isActive &&
  prev.event.text === next.event.text &&
  prev.event.at === next.event.at &&
  prev.event.endedAt === next.event.endedAt,
);

/**
 * 工具行：单行展示，带状态图标与耗时。
 *
 * 按值 memo：TimelineBuilder.snapshot() 每次 emit 都重建所有事件对象，
 * 引用必变，默认浅比较无法命中，只能比较真正影响渲染的字段。
 */
const ToolRow = memo(function ToolRow({ event, compact = false }: { event: TimelineToolEvent; compact?: boolean }) {
  const running = event.status === "in_progress" || event.status === "pending";
  const failed = event.status === "failed";
  const duration = event.completedAt && event.at ? event.completedAt - event.at : undefined;

  return (
    <div className={`${compact ? "" : "my-1"} flex items-center gap-2 text-[12px] text-app-text-muted ${running ? "animate-pulse" : ""}`}>
      <div className="flex-shrink-0 flex items-center">
        {running ? <SpinnerIcon /> : failed ? <CrossIcon /> : <CheckIcon className="text-green-600 dark:text-green-400" />}
      </div>
      <span className="truncate min-w-0">{cleanToolTitle(event.title)}</span>
      {duration !== undefined && !running && (
        <span className="shrink-0 text-app-text-muted opacity-60">{formatDuration(duration)}</span>
      )}
    </div>
  );
}, (prev, next) =>
  prev.compact === next.compact &&
  prev.event.toolCallId === next.event.toolCallId &&
  prev.event.title === next.event.title &&
  prev.event.status === next.event.status &&
  prev.event.at === next.event.at &&
  prev.event.completedAt === next.event.completedAt,
);

/**
 * 连续工具分组：一串没有被文本/思考打断的工具调用收成一个可折叠块。
 *
 * 长任务里连续十几次读文件/执行命令会把正文挤出屏幕，
 * 折叠后只占一行；进行中自动展开以便观察进度，结束后延迟收起。
 */
function ToolGroup({ events, isActive }: { events: TimelineToolEvent[]; isActive: boolean }) {
  const [expanded, setExpanded] = useState(isActive);
  const userToggled = useRef(false);

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

  const failedCount = events.filter(e => e.status === "failed").length;
  const runningTool = events.find(e => e.status === "in_progress" || e.status === "pending");
  const totalMs = events.reduce((sum, e) => sum + (e.completedAt && e.at ? e.completedAt - e.at : 0), 0);

  return (
    <div className="my-2">
      <button
        onClick={() => { userToggled.current = true; setExpanded(!expanded); }}
        className="flex items-center gap-2 text-[12px] text-app-text-muted hover:text-app-text-secondary transition-colors max-w-full"
      >
        <div className="flex-shrink-0 flex items-center">
          {runningTool ? <SpinnerIcon /> : failedCount > 0 ? <CrossIcon /> : <CheckIcon className="text-green-600 dark:text-green-400" />}
        </div>
        <span className="shrink-0">
          {events.length} 个工具
          {failedCount > 0 && <span className="text-red-500">（{failedCount} 个失败）</span>}
        </span>
        {/* 折叠态下仍显示当前正在执行的工具，保持「跟随」的感知 */}
        {runningTool && !expanded && (
          <span className="truncate min-w-0 opacity-60">{cleanToolTitle(runningTool.title)}</span>
        )}
        {!runningTool && totalMs > 0 && (
          <span className="shrink-0 opacity-60">{formatDuration(totalMs)}</span>
        )}
        <Chevron open={expanded} />
      </button>

      {expanded && (
        <div className="mt-1 ml-[22px] pl-3 border-l border-app-border flex flex-col gap-0.5">
          {events.length > TOOL_GROUP_MAX_VISIBLE && (
            <p className="text-[11px] text-app-text-muted opacity-60 py-0.5">
              仅显示最近 {TOOL_GROUP_MAX_VISIBLE} 条，另有 {events.length - TOOL_GROUP_MAX_VISIBLE} 条已省略
            </p>
          )}
          {events.slice(-TOOL_GROUP_MAX_VISIBLE).map(e => (
            <ToolRow key={e.toolCallId} event={e} compact />
          ))}
        </div>
      )}
    </div>
  );
}

/** 渲染单元：文本/思考为单个事件，连续工具合并为一组 */
type RenderUnit =
  | { type: "single"; event: TimelineEvent; index: number }
  | { type: "toolGroup"; events: TimelineToolEvent[]; lastIndex: number };

/** 把事件序列切成渲染单元，连续的工具事件归为一组 */
export function groupTimeline(events: TimelineEvent[]): RenderUnit[] {
  const units: RenderUnit[] = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i];
    if (e.kind !== "tool") {
      units.push({ type: "single", event: e, index: i });
      i++;
      continue;
    }
    // 收集连续的工具事件
    const group: TimelineToolEvent[] = [];
    while (i < events.length && events[i].kind === "tool") {
      group.push(events[i] as TimelineToolEvent);
      i++;
    }
    units.push({ type: "toolGroup", events: group, lastIndex: i - 1 });
  }
  return units;
}

/**
 * 判断当前是否有「正在进行」的过程单元。
 *
 * 用于决定要不要在时间线末尾补等待指示：工具完成到下一段文本到达之间
 * 存在空隙，若此时没有任何转圈，界面看起来像卡住了。
 */
export function hasActiveWork(events: TimelineEvent[]): boolean {
  for (const e of events) {
    if (e.kind === "tool" && (e.status === "in_progress" || e.status === "pending")) return true;
  }
  // 最后一个事件是尚未封段的思考 → 思考进行中
  const last = events[events.length - 1];
  if (last && last.kind === "thought" && !last.endedAt) return true;
  return false;
}

/** 尾部等待指示：流式中但无进行中单元时显示，避免看起来卡住 */
function PendingRow() {
  return (
    <div className="my-1 flex items-center gap-2 text-[12px] text-app-text-muted">
      <div className="flex-shrink-0 flex items-center">
        <SpinnerIcon />
      </div>
      <span className="animate-pulse">Thinking</span>
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
  const lastIndex = events.length - 1;
  const units = groupTimeline(events);
  // 流式中若没有任何进行中的单元，说明处于事件间隙，补一个等待指示
  const showPending = isStreaming && !hasActiveWork(events);

  return (
    <>
      {units.map((unit, ui) => {
        if (unit.type === "toolGroup") {
          const { events: tools, lastIndex: groupLast } = unit;
          // 组内有工具在跑，或流式且该组是最后一个单元 → 视为进行中
          const hasRunning = tools.some(t => t.status === "in_progress" || t.status === "pending");
          const isActive = hasRunning || (isStreaming && groupLast === lastIndex);

          // 数量少时平铺更易读，不引入折叠层级
          if (tools.length < TOOL_GROUP_THRESHOLD) {
            return (
              <div key={`tg-${ui}`}>
                {tools.map(t => <ToolRow key={t.toolCallId} event={t} />)}
              </div>
            );
          }
          return <ToolGroup key={`tg-${ui}`} events={tools} isActive={isActive} />;
        }

        const { event, index } = unit;
        const key = `${event.kind}-${index}`;

        if (event.kind === "text") {
          // 空白片段不渲染，避免产生空段落间距
          const text = event.text.trimEnd();
          if (!text) return null;
          return <MarkdownBody key={key}>{text}</MarkdownBody>;
        }

        // 思考段的「进行中」判定：流式且是最后一个事件且尚未封段
        const active = isStreaming && index === lastIndex && !(event as TimelineThoughtEvent).endedAt;
        return <ThoughtSegment key={key} event={event as TimelineThoughtEvent} isActive={active} />;
      })}
      {showPending && <PendingRow />}
    </>
  );
}

export default ProcessTimeline;
