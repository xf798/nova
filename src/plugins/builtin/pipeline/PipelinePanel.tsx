// ===== Pipeline Panel — Linear/Vercel-inspired 精致 UI =====

import React, { useState, useEffect, useRef } from "react";
import { pipelineEngine } from "./engine";
import { tchubClient } from "./tchub-client";
import { useAppStore } from "../../../App";
import type { PipelineState, PipelineConfig, StageId, LogEntry, TCHubSyncStatus, PipelineRunRecord } from "./engine";
import type { WorkstreamInfo } from "./tchub-client";

// ─── Constants ───
const DEFAULT_CWD = "/Users/wangxf/workspace";
const STAGES: { id: StageId; label: string; short: string }[] = [
  { id: "pm", label: "PRD-IR 生成", short: "PRD-IR" },
  { id: "ux", label: "UX 设计", short: "UX" },
  { id: "dev", label: "代码生成", short: "Dev" },
];
const THINKING: Record<StageId, string[]> = {
  pm: ["分析需求文档...", "提取用户故事...", "生成结构化 IR..."],
  ux: ["解析交互规格...", "生成组件规格...", "适配设计 Token..."],
  dev: ["规划架构...", "生成组件代码...", "适配工程规范..."],
};

// ─── Utilities ───
function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
function elapsed(t?: string): number { return t ? Date.now() - new Date(t).getTime() : 0; }
function basename(p: string): string { return p.split("/").pop() || p; }

// ─── Icons (SVG line-style, 14×14 default) ───
const I = { w: 14, h: 14, vb: "0 0 24 24", f: "none", s: "currentColor", sw: "1.5", lc: "round", lj: "round" };
function Icon({ d, size = 14, cls = "" }: { d: string; size?: number; cls?: string }) {
  return <svg width={size} height={size} viewBox={I.vb} fill={I.f} stroke={I.s} strokeWidth={I.sw} strokeLinecap={I.lc as any} strokeLinejoin={I.lj as any} className={cls}><path d={d} /></svg>;
}
const icons = {
  play: "M5 3l14 9-14 9V3z",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  stop: "M4 4h16v16H4z",
  skip: "M5 4l10 8-10 8V4zM19 5v14",
  retry: "M23 4v6h-6M20.49 15a9 9 0 1 1-2.12-9.36L23 10",
  reset: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  cloud: "M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z",
  alert: "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01",
  check: "M9 12l2 2 4-4",
  x: "M18 6L6 18M6 6l12 12",
  chevDown: "M6 9l6 6 6-6",
  chevUp: "M18 15l-6-6-6 6",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06c.5.5 1.2.7 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.84 1 1.51 1.08H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
};
function Spinner({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>;
}


// ─── Main Component ───
export default function PipelinePanel() {
  const [state, setState] = useState<PipelineState>(pipelineEngine.getState());
  const [configOpen, setConfigOpen] = useState(false);

  useEffect(() => pipelineEngine.subscribe((s) => setState({ ...s })), []);

  const { status } = state;
  const isIdle = status === "idle";
  const isActive = status === "running" || status === "paused" || status === "completed" || status === "failed";

  return (
    <div className="max-w-2xl mx-auto w-full py-4 px-1">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-semibold text-app-text">AutoProgram</span>
          <StatusPill status={status} />
        </div>
        <div className="flex items-center gap-2">
          {state.config.workstreamId && <SyncBadge status={state.tchubSync} lastSync={state.tchubLastSync} />}
          {isIdle && (
            <button onClick={() => setConfigOpen(!configOpen)} className="px-3 py-1 text-[12px] rounded-full border border-app-border text-app-text-muted hover:text-app-text hover:border-app-text-muted transition-colors flex items-center gap-1">
              <Icon d={icons.settings} size={12} />
              配置
            </button>
          )}
        </div>
      </div>

      {/* Idle: workstream list or config */}
      {isIdle && configOpen && <ConfigPanel state={state} onClose={() => setConfigOpen(false)} />}
      {isIdle && !configOpen && <IdlePanel onOpenConfig={() => setConfigOpen(true)} />}

      {/* Active: running dashboard */}
      {isActive && <ActiveView state={state} />}
    </div>
  );
}

// ─── Status Pill ───
function StatusPill({ status }: { status: string }) {
  const m: Record<string, [string, string]> = {
    idle: ["bg-neutral-500/10 text-app-text-muted", "待启动"],
    running: ["bg-blue-500/10 text-blue-500", "运行中"],
    paused: ["bg-yellow-500/10 text-yellow-600", "已暂停"],
    completed: ["bg-green-500/10 text-green-600", "已完成"],
    failed: ["bg-red-500/10 text-red-500", "失败"],
  };
  const [cls, label] = m[status] || m.idle;
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${cls}`}>{label}</span>;
}

// ─── TCHub Sync Badge ───
function SyncBadge({ status, lastSync }: { status: TCHubSyncStatus; lastSync?: string }) {
  const m: Record<TCHubSyncStatus, [string, string]> = {
    idle: ["text-app-text-muted", "TCHub"],
    syncing: ["text-blue-400 animate-pulse", "同步中"],
    synced: ["text-green-500", "已同步"],
    error: ["text-red-400", "同步失败"],
  };
  const [cls, label] = m[status] || m.idle;
  return (
    <span className={`flex items-center gap-1 text-[11px] ${cls}`} title={lastSync ? `上次: ${new Date(lastSync).toLocaleTimeString("zh-CN")}` : ""}>
      <Icon d={icons.cloud} size={12} />
      {label}
    </span>
  );
}


// ─── Active View (Running/Paused/Completed/Failed) ───
function ActiveView({ state }: { state: PipelineState }) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const isRunning = state.status === "running";

  useEffect(() => {
    if (!state.startedAt) return;
    const tick = () => setElapsedMs(elapsed(state.startedAt));
    tick();
    if (isRunning) { const id = setInterval(tick, 1000); return () => clearInterval(id); }
  }, [state.startedAt, isRunning]);

  const total = state.completedAt && state.startedAt
    ? new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime()
    : elapsedMs;

  return (
    <div className="space-y-4">
      {/* Top bar: elapsed + status */}
      <div className="flex items-center justify-between text-[12px] text-app-text-muted">
        <span className="flex items-center gap-1.5 tabular-nums">
          <Icon d={icons.clock} size={12} />
          {fmt(total)}
        </span>
        {state.status === "completed" && <span className="text-green-600 font-medium flex items-center gap-1"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>全部完成</span>}
        {state.status === "failed" && <span className="text-red-500 font-medium flex items-center gap-1"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>执行失败</span>}
      </div>

      {/* Horizontal stepper */}
      <Stepper stages={state.stages} currentStage={state.currentStage} />

      {/* Current stage detail */}
      {state.currentStage && (state.status === "running" || state.status === "paused") && (
        <StageDetail stageId={state.currentStage} stageState={state.stages[state.currentStage]} paused={state.status === "paused"} />
      )}

      {/* Decision panel */}
      {state.pendingDecision && <DecisionCard decision={state.pendingDecision} />}

      {/* Completed: artifacts */}
      {state.status === "completed" && <ArtifactsSummary stages={state.stages} />}

      {/* Failed: error */}
      {state.status === "failed" && <FailedDetail stages={state.stages} />}

      {/* Blockers */}
      <Blockers stages={state.stages} />

      {/* Logs */}
      <LogPanel logs={state.logs} />

      {/* Actions */}
      <Actions status={state.status} hasPending={!!state.pendingDecision} />
    </div>
  );
}

// ─── Horizontal Stepper ───
function Stepper({ stages, currentStage }: { stages: PipelineState["stages"]; currentStage: StageId | null }) {
  const [expandedStage, setExpandedStage] = useState<StageId | null>(null);

  return (
    <div>
      <div className="flex items-center justify-between px-2">
        {STAGES.map((s, i) => {
          const st = stages[s.id].status;
          const isActive = s.id === currentStage && (st === "running");
          const done = st === "success";
          const failed = st === "failed";
          const skipped = st === "skipped";
          const clickable = done || failed || skipped;

          // dot style
          let dotCls = "w-3 h-3 rounded-full border-2 transition-all ";
          if (done) dotCls += "bg-green-500 border-green-500";
          else if (failed) dotCls += "bg-red-500 border-red-500";
          else if (skipped) dotCls += "bg-neutral-400 border-neutral-400";
          else if (isActive) dotCls += "bg-blue-500 border-blue-500 animate-pulse";
          else dotCls += "bg-transparent border-app-border";

          return (
            <React.Fragment key={s.id}>
              <div
                className={`flex flex-col items-center gap-1.5 ${clickable ? "cursor-pointer group/stage" : ""}`}
                onClick={() => clickable && setExpandedStage(expandedStage === s.id ? null : s.id)}
              >
                <div className={`${dotCls} ${clickable ? "group-hover/stage:ring-2 group-hover/stage:ring-blue-500/20" : ""}`} />
                <span className={`text-[11px] ${done ? "text-green-600" : failed ? "text-red-500" : skipped ? "text-neutral-400" : isActive ? "text-blue-500 font-medium" : "text-app-text-muted"} ${clickable ? "group-hover/stage:underline" : ""}`}>
                  {s.short}
                </span>
                {stages[s.id].duration > 0 && <span className="text-[10px] text-app-text-muted tabular-nums">{fmt(stages[s.id].duration)}</span>}
              </div>
              {i < STAGES.length - 1 && (
                <div className={`flex-1 h-[2px] mx-2 rounded-full transition-colors ${
                  stages[STAGES[i + 1].id].status !== "pending" || done ? "bg-green-500/40" : "bg-app-border"
                }`} />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* Expanded stage detail */}
      {expandedStage && (stages[expandedStage].status === "success" || stages[expandedStage].status === "failed" || stages[expandedStage].status === "skipped") && (
        <StageExpandedDetail
          stageId={expandedStage}
          stageState={stages[expandedStage]}
          onClose={() => setExpandedStage(null)}
        />
      )}
    </div>
  );
}

// ─── Stage Expanded Detail (for completed/failed stages) ───
function StageExpandedDetail({ stageId, stageState, onClose }: { stageId: StageId; stageState: PipelineState["stages"][StageId]; onClose: () => void }) {
  const label = STAGES.find(s => s.id === stageId)?.label || "";
  const statusLabel = stageState.status === "success" ? "✅ 成功" : stageState.status === "failed" ? "❌ 失败" : "⏭ 已跳过";
  const borderColor = stageState.status === "success" ? "border-l-green-500" : stageState.status === "failed" ? "border-l-red-500" : "border-l-neutral-400";
  const { setPreviewPanel } = useAppStore();

  return (
    <div className={`mt-3 rounded-lg border border-app-border bg-app-bg p-3 border-l-2 ${borderColor} animate-fade-in`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-app-text">{label}</span>
          <span className="text-[10px] text-app-text-muted">{statusLabel}</span>
        </div>
        <button onClick={onClose} className="text-app-text-muted hover:text-app-text transition-colors">
          <Icon d={icons.x} size={12} />
        </button>
      </div>

      <div className="space-y-2 text-[11px]">
        {/* Duration */}
        {stageState.duration > 0 && (
          <div className="flex items-center gap-2 text-app-text-muted">
            <Icon d={icons.clock} size={11} />
            <span>耗时: {fmt(stageState.duration)}</span>
          </div>
        )}

        {/* Error */}
        {stageState.error && (
          <div className="px-2 py-1.5 rounded bg-red-500/5 border border-red-500/20 text-red-400 font-mono text-[10px]">
            {stageState.error}
          </div>
        )}

        {/* Output summary */}
        {stageState.output && stageState.status === "success" && (
          <div className="px-2 py-1.5 rounded bg-app-surface-hover text-app-text-muted font-mono text-[10px] max-h-[80px] overflow-y-auto leading-relaxed">
            {stageState.output.slice(0, 300)}{stageState.output.length > 300 ? "..." : ""}
          </div>
        )}

        {/* Artifacts */}
        {stageState.artifacts.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1 text-app-text-muted">
              <Icon d={icons.file} size={11} />
              <span>产出文件 ({stageState.artifacts.length})</span>
            </div>
            <div className="space-y-0.5 pl-4">
              {stageState.artifacts.map((f, i) => (
                <div
                  key={i}
                  className="text-[10px] font-mono text-app-text-muted truncate cursor-pointer hover:text-blue-500 transition-colors"
                  onClick={() => setPreviewPanel({ type: "file", data: f })}
                >
                  {basename(f)}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Files copied to next stage */}
        {stageState.filesCopied && stageState.filesCopied.length > 0 && (
          <div className="flex items-center gap-1.5 text-app-text-muted">
            <span>→ 已传递 {stageState.filesCopied.length} 个文件到下游</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Current Stage Detail ───
function StageDetail({ stageId, stageState, paused }: { stageId: StageId; stageState: PipelineState["stages"][StageId]; paused: boolean }) {
  const [ti, setTi] = useState(0);
  const texts = THINKING[stageId];
  useEffect(() => { const id = setInterval(() => setTi(p => (p + 1) % texts.length), 2500); return () => clearInterval(id); }, [texts.length]);

  const label = STAGES.find(s => s.id === stageId)?.label || "";

  return (
    <div className="rounded-lg border border-app-border bg-app-bg p-4 border-l-2 border-l-blue-500">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[13px] font-medium text-app-text">{label}</span>
        <span className="text-[11px] font-mono text-blue-500">{stageState.progress}%</span>
      </div>
      {/* Progress bar */}
      <div className="w-full h-1.5 bg-app-border rounded-full overflow-hidden mb-2">
        <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${stageState.progress}%` }} />
      </div>
      {/* Thinking text */}
      {!paused && (
        <div className="flex items-center gap-2 text-[11px] text-app-text-muted">
          <span className="flex gap-0.5">
            <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: "300ms" }} />
          </span>
          <span className="italic">{texts[ti]}</span>
        </div>
      )}
      {paused && <span className="text-[11px] text-yellow-600 italic">已暂停</span>}
    </div>
  );
}

// ─── Decision Card ───
function DecisionCard({ decision }: { decision: NonNullable<PipelineState["pendingDecision"]> }) {
  return (
    <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 border-l-2 border-l-yellow-500">
      <div className="flex items-start gap-2 mb-3">
        <Icon d={icons.alert} size={14} cls="text-yellow-500 shrink-0 mt-0.5" />
        <div>
          <div className="text-[13px] font-medium text-app-text">需要决断</div>
          <div className="text-[12px] text-app-text-muted mt-1">{decision.message}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 ml-5">
        {decision.options.map((opt) => (
          <button key={opt.action} onClick={() => pipelineEngine.resolveDecision(opt.action)} className="px-3 py-1 text-[12px] rounded-full border border-app-border bg-app-bg text-app-text hover:border-blue-500 hover:text-blue-500 transition-colors">
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}


// ─── Completed: Stats Card ───
function ArtifactsSummary({ stages }: { stages: PipelineState["stages"] }) {
  const allFiles = Object.values(stages).flatMap(s => s.artifacts);
  const totalDuration = Object.values(stages).reduce((sum, s) => sum + s.duration, 0);
  const stagesCompleted = Object.values(stages).filter(s => s.status === "success").length;
  const stagesSkipped = Object.values(stages).filter(s => s.status === "skipped").length;
  const { setPreviewPanel } = useAppStore();

  return (
    <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-4 space-y-3">
      {/* Summary row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="text-center">
          <div className="text-[18px] font-semibold text-app-text tabular-nums">{stagesCompleted}<span className="text-[11px] text-app-text-muted">/{STAGES.length}</span></div>
          <div className="text-[10px] text-app-text-muted">阶段完成{stagesSkipped > 0 ? ` (${stagesSkipped}跳过)` : ""}</div>
        </div>
        <div className="text-center">
          <div className="text-[18px] font-semibold text-app-text tabular-nums">{allFiles.length}</div>
          <div className="text-[10px] text-app-text-muted">产出文件</div>
        </div>
        <div className="text-center">
          <div className="text-[18px] font-semibold text-app-text tabular-nums">{fmt(totalDuration)}</div>
          <div className="text-[10px] text-app-text-muted">总耗时</div>
        </div>
      </div>

      {/* Per-stage duration bar */}
      {totalDuration > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-app-text-muted mb-1">各阶段耗时</div>
          {STAGES.map(s => {
            const st = stages[s.id];
            if (st.duration === 0 && st.status !== "success") return null;
            const pct = totalDuration > 0 ? (st.duration / totalDuration) * 100 : 0;
            const color = st.status === "success" ? "bg-green-500" : st.status === "skipped" ? "bg-neutral-400" : "bg-red-500";
            return (
              <div key={s.id} className="flex items-center gap-2">
                <span className="text-[10px] text-app-text-muted w-10 shrink-0">{s.short}</span>
                <div className="flex-1 h-1.5 bg-app-border rounded-full overflow-hidden">
                  <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${Math.max(pct, 2)}%` }} />
                </div>
                <span className="text-[10px] text-app-text-muted tabular-nums w-10 text-right">{fmt(st.duration)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* File list */}
      {allFiles.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <Icon d={icons.file} size={11} />
            <span className="text-[10px] text-app-text-muted">产出文件</span>
          </div>
          <div className="space-y-0.5 max-h-[120px] overflow-y-auto">
            {allFiles.map((f, i) => (
              <div
                key={i}
                className="text-[10px] font-mono text-app-text-muted flex items-center gap-1.5 py-0.5 cursor-pointer hover:text-blue-500 transition-colors"
                onClick={() => setPreviewPanel({ type: "file", data: f })}
              >
                <Icon d={icons.file} size={9} />
                <span className="truncate">{basename(f)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Failed: Error Detail ───
function FailedDetail({ stages }: { stages: PipelineState["stages"] }) {
  const failed = (Object.entries(stages) as [StageId, PipelineState["stages"][StageId]][]).find(([, s]) => s.status === "failed");
  if (!failed) return null;
  const [id, st] = failed;
  const label = STAGES.find(s => s.id === id)?.label || id;
  return (
    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 border-l-2 border-l-red-500">
      <div className="text-[12px] font-medium text-red-500 mb-1">阶段失败: {label}</div>
      {st.error && <div className="text-[11px] text-red-400 font-mono leading-relaxed">{st.error}</div>}
    </div>
  );
}

// ─── Blockers ───
function Blockers({ stages }: { stages: PipelineState["stages"] }) {
  const all: { stage: StageId; msg: string }[] = [];
  for (const [id, st] of Object.entries(stages) as [StageId, PipelineState["stages"][StageId]][]) {
    for (const b of st.blockers) all.push({ stage: id, msg: b });
  }
  if (all.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {all.map((b, i) => (
        <div key={i} className="flex items-start gap-2 px-3 py-2 rounded-lg bg-yellow-500/5 border border-yellow-500/20 text-[11px]">
          <Icon d={icons.alert} size={12} cls="text-yellow-500 shrink-0 mt-0.5" />
          <span className="text-app-text-muted">[{b.stage}] {b.msg}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Log Panel (collapsed by default, with filters) ───
function LogPanel({ logs }: { logs: LogEntry[] }) {
  const [open, setOpen] = useState(false);
  const [stageFilter, setStageFilter] = useState<StageId | "system" | "all">("all");
  const [levelFilter, setLevelFilter] = useState<LogEntry["level"] | "all">("all");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs.length, open]);

  if (logs.length === 0) return null;

  const filtered = logs.filter(log => {
    if (stageFilter !== "all" && log.stage !== stageFilter) return false;
    if (levelFilter !== "all" && log.level !== levelFilter) return false;
    return true;
  });

  const display = open ? filtered.slice(-80) : filtered.slice(-3);
  const lvlCls: Record<string, string> = { info: "text-blue-400", warn: "text-yellow-500", error: "text-red-500", success: "text-green-500" };
  const stageCls: Record<string, string> = { pm: "text-blue-400", ux: "text-purple-400", dev: "text-amber-500", system: "text-app-text-muted" };

  const filterBtnCls = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-[9px] transition-colors ${active ? "bg-blue-500/20 text-blue-500" : "text-app-text-muted hover:text-app-text"}`;

  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-[11px] text-app-text-muted hover:text-app-text transition-colors mb-1.5">
        <Icon d={open ? icons.chevUp : icons.chevDown} size={12} />
        日志 ({logs.length}{filtered.length !== logs.length ? ` / 显示 ${filtered.length}` : ""})
      </button>

      {/* Filters (only when expanded) */}
      {open && (
        <div className="flex items-center gap-3 mb-1.5 flex-wrap">
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-app-text-muted">阶段:</span>
            {(["all", "pm", "ux", "dev", "system"] as const).map(s => (
              <button key={s} onClick={() => setStageFilter(s)} className={filterBtnCls(stageFilter === s)}>
                {s === "all" ? "全部" : s}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-app-text-muted">级别:</span>
            {(["all", "info", "warn", "error", "success"] as const).map(l => (
              <button key={l} onClick={() => setLevelFilter(l)} className={filterBtnCls(levelFilter === l)}>
                {l === "all" ? "全部" : l}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={`rounded-lg border border-app-border bg-app-bg p-2 font-mono text-[10px] leading-relaxed overflow-y-auto transition-all ${open ? "max-h-[300px]" : "max-h-[72px]"}`}>
        {display.length === 0 && (
          <div className="text-app-text-muted text-center py-2">无匹配日志</div>
        )}
        {display.map((log, i) => (
          <div key={i} className="flex items-baseline gap-2 py-0.5">
            <span className="text-app-text-muted tabular-nums shrink-0">{new Date(log.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span className={`shrink-0 ${stageCls[log.stage] || ""}`}>{log.stage}</span>
            <span className={`${lvlCls[log.level] || "text-app-text"}`}>{log.message}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}


// ─── Action Buttons ───
function Actions({ status, hasPending }: { status: string; hasPending: boolean }) {
  const btn = (onClick: () => void, icon: string, label: string, variant: "default" | "primary" | "danger" = "default") => {
    const cls = variant === "primary" ? "bg-blue-500 text-white hover:bg-blue-600"
      : variant === "danger" ? "text-red-400 border-red-500/20 hover:bg-red-500/10"
      : "text-app-text-muted hover:text-app-text hover:bg-app-surface-hover";
    return (
      <button onClick={onClick} className={`px-3 py-1 text-[12px] rounded-full border border-app-border transition-colors flex items-center gap-1 ${cls}`}>
        <Icon d={icon} size={12} />
        {label}
      </button>
    );
  };

  return (
    <div className="flex items-center gap-2 pt-3 border-t border-app-border">
      {status === "running" && (
        <>
          {btn(() => pipelineEngine.pause(), icons.pause, "暂停")}
          {btn(() => pipelineEngine.stop(), icons.stop, "停止", "danger")}
          {btn(() => pipelineEngine.skip(), icons.skip, "跳过")}
        </>
      )}
      {status === "paused" && (
        <>
          {btn(() => pipelineEngine.resume(), icons.play, "继续", "primary")}
          {btn(() => pipelineEngine.stop(), icons.stop, "停止", "danger")}
        </>
      )}
      {status === "failed" && !hasPending && (
        <>
          {btn(() => pipelineEngine.retry(), icons.retry, "重试", "primary")}
          {btn(() => pipelineEngine.skip(), icons.skip, "跳过")}
          {btn(() => pipelineEngine.reset(), icons.reset, "重置", "danger")}
        </>
      )}
      {status === "completed" && btn(() => pipelineEngine.reset(), icons.reset, "重置")}
    </div>
  );
}

// ─── Idle Panel: Workstream List ───
function IdlePanel({ onOpenConfig }: { onOpenConfig: () => void }) {
  const [ws, setWs] = useState<WorkstreamInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [startingId, setStartingId] = useState<string | null>(null);
  const [runHistory, setRunHistory] = useState<PipelineRunRecord[]>([]);

  useEffect(() => { load(); loadHistory(); }, []);

  const load = async () => {
    setLoading(true); setError("");
    const res = await tchubClient.listAutoProgramWorkstreams();
    if (res.ok) setWs(res.data || []);
    else setError(res.error || "加载失败");
    setLoading(false);
  };

  const loadHistory = async () => {
    const history = await pipelineEngine.getRunHistory();
    setRunHistory(history.slice(0, 5));
  };

  const start = (w: WorkstreamInfo) => {
    setStartingId(w.id);
    pipelineEngine.start({
      prdPath: "",
      specName: w.slug || w.name.replace(/\s+/g, "-").toLowerCase(),
      targetDir: "src/pages/demo/",
      pmCwd: `${DEFAULT_CWD}/ai-pm-team`,
      uxCwd: `${DEFAULT_CWD}/ai-ux-team`,
      devCwd: `${DEFAULT_CWD}/ai-develop-team`,
      workstreamId: w.id,
      syncToTchub: true,
    });
  };

  return (
    <div>
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-[12px] text-app-text-muted flex items-center gap-1.5">
          <Icon d={icons.cloud} size={12} />
          Workstreams
          {!loading && <span className="text-[10px]">({ws.length})</span>}
        </span>
        <button onClick={load} className="p-1 rounded text-app-text-muted hover:text-app-text transition-colors" title="刷新">
          <Icon d={icons.retry} size={12} />
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="py-8 flex items-center justify-center gap-2 text-[12px] text-app-text-muted border border-dashed border-app-border rounded-lg">
          <Spinner size={14} />
          加载中...
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="px-3 py-2 rounded-lg border border-red-500/20 bg-red-500/5 text-[11px] text-red-400 flex items-center gap-2">
          <Icon d={icons.alert} size={12} cls="text-red-400" />
          {error}
          <button onClick={load} className="ml-auto underline text-[10px]">重试</button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && ws.length === 0 && (
        <div className="py-8 text-center border border-dashed border-app-border rounded-lg">
          <div className="text-[12px] text-app-text-muted mb-1">暂无可用 Workstream</div>
          <div className="text-[11px] text-app-text-muted">在 TCHub 创建 auto_program workstream 后将显示在此</div>
        </div>
      )}

      {/* List */}
      {!loading && !error && ws.length > 0 && (
        <div className="space-y-2">
          {ws.map((w) => (
            <div key={w.id} className="group px-3 py-2.5 rounded-lg border border-app-border bg-app-bg hover:border-app-text-muted/30 transition-colors">
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium text-app-text truncate">{w.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-app-surface-hover text-app-text-muted border border-app-border">{w.current_stage}</span>
                  </div>
                  <div className="text-[10px] text-app-text-muted mt-0.5 truncate">{w.project_name} / {w.feature_name}</div>
                </div>
                <button
                  onClick={() => start(w)}
                  disabled={startingId === w.id}
                  className="shrink-0 px-3 py-1 text-[11px] rounded-full bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 transition-all opacity-0 group-hover:opacity-100 flex items-center gap-1"
                >
                  {startingId === w.id ? <Spinner size={10} /> : <Icon d={icons.play} size={10} />}
                  启动
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Recent Runs History */}
      {runHistory.length > 0 && (
        <div className="mt-4 pt-3 border-t border-app-border">
          <div className="flex items-center gap-1.5 mb-2">
            <Icon d={icons.clock} size={12} />
            <span className="text-[11px] text-app-text-muted">最近运行</span>
          </div>
          <div className="space-y-1.5">
            {runHistory.map((run) => (
              <div key={run.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-app-border bg-app-bg">
                <div className="flex items-center gap-2 min-w-0">
                  <RunStatusDot status={run.status} />
                  <span className="text-[11px] text-app-text truncate">{run.config.specName || run.id}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[10px] text-app-text-muted tabular-nums">{fmt(run.totalDuration)}</span>
                  <span className="text-[10px] text-app-text-muted tabular-nums">{formatRelative(run.completedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Manual config fallback */}
      <button onClick={onOpenConfig} className="mt-3 text-[11px] text-app-text-muted hover:text-app-text transition-colors flex items-center gap-1">
        <Icon d={icons.settings} size={11} />
        手动配置启动...
      </button>
    </div>
  );
}

// ─── Run Status Dot ───
function RunStatusDot({ status }: { status: string }) {
  const cls = status === "completed" ? "bg-green-500" : status === "failed" ? "bg-red-500" : "bg-yellow-500";
  return <div className={`w-2 h-2 rounded-full shrink-0 ${cls}`} />;
}

// ─── Relative Time Format ───
function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

// ─── Config Panel (collapsible, not modal) ───
function ConfigPanel({ state, onClose }: { state: PipelineState; onClose: () => void }) {
  const [cfg, setCfg] = useState<PipelineConfig>({
    prdPath: state.config.prdPath || "",
    specName: state.config.specName || "",
    targetDir: state.config.targetDir || "src/pages/demo/",
    pmCwd: state.config.pmCwd || `${DEFAULT_CWD}/ai-pm-team`,
    uxCwd: state.config.uxCwd || `${DEFAULT_CWD}/ai-ux-team`,
    devCwd: state.config.devCwd || `${DEFAULT_CWD}/ai-develop-team`,
    syncToTchub: state.config.syncToTchub !== false,
    skipStages: state.config.skipStages || [],
  });
  const [advOpen, setAdvOpen] = useState(false);
  const up = (k: keyof PipelineConfig, v: any) => setCfg(p => ({ ...p, [k]: v }));
  const inputCls = "w-full px-2.5 py-1.5 rounded-lg border border-app-border bg-app-bg text-[12px] text-app-text focus:outline-none focus:border-blue-500/50 transition-colors";

  const toggleStage = (stageId: StageId) => {
    const current = cfg.skipStages || [];
    if (current.includes(stageId)) {
      up("skipStages", current.filter((s: StageId) => s !== stageId));
    } else {
      up("skipStages", [...current, stageId]);
    }
  };

  return (
    <div className="mb-4 p-4 rounded-lg border border-app-border bg-app-bg space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-app-text">手动配置</span>
        <button onClick={onClose} className="text-app-text-muted hover:text-app-text transition-colors">
          <Icon d={icons.x} size={14} />
        </button>
      </div>

      <div>
        <label className="text-[11px] text-app-text-muted mb-1 block">PRD 路径（可选）</label>
        <input value={cfg.prdPath} onChange={e => up("prdPath", e.target.value)} placeholder="留空则从 TCHub 拉取" className={inputCls} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] text-app-text-muted mb-1 block">Spec Name</label>
          <input value={cfg.specName} onChange={e => up("specName", e.target.value)} placeholder="可选" className={inputCls} />
        </div>
        <div>
          <label className="text-[11px] text-app-text-muted mb-1 block">输出目录</label>
          <input value={cfg.targetDir} onChange={e => up("targetDir", e.target.value)} className={inputCls} />
        </div>
      </div>

      {/* Advanced: CWD paths */}
      <button onClick={() => setAdvOpen(!advOpen)} className="text-[11px] text-app-text-muted hover:text-app-text flex items-center gap-1 transition-colors">
        <Icon d={advOpen ? icons.chevUp : icons.chevDown} size={11} />
        高级选项
      </button>
      {advOpen && (
        <div className="space-y-2 pl-2 border-l-2 border-app-border">
          <div>
            <label className="text-[10px] text-app-text-muted mb-0.5 block">PM CWD</label>
            <input value={cfg.pmCwd} onChange={e => up("pmCwd", e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="text-[10px] text-app-text-muted mb-0.5 block">UX CWD</label>
            <input value={cfg.uxCwd} onChange={e => up("uxCwd", e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="text-[10px] text-app-text-muted mb-0.5 block">Dev CWD</label>
            <input value={cfg.devCwd} onChange={e => up("devCwd", e.target.value)} className={inputCls} />
          </div>
        </div>
      )}

      {/* Stage skip toggles */}
      <div>
        <label className="text-[11px] text-app-text-muted mb-1.5 block">阶段开关</label>
        <div className="flex items-center gap-3">
          {STAGES.map(s => {
            const skipped = (cfg.skipStages || []).includes(s.id);
            // pm 阶段不允许跳过（是入口）
            const canSkip = s.id !== "pm";
            return (
              <button
                key={s.id}
                onClick={() => canSkip && toggleStage(s.id)}
                disabled={!canSkip}
                className={`px-2.5 py-1 text-[11px] rounded-full border transition-colors flex items-center gap-1 ${
                  skipped
                    ? "border-neutral-400/30 text-neutral-400 line-through"
                    : "border-app-border text-app-text hover:border-blue-500"
                } ${!canSkip ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
              >
                {skipped ? <Icon d={icons.x} size={10} /> : <Icon d={icons.check} size={10} />}
                {s.short}
              </button>
            );
          })}
        </div>
        <div className="text-[9px] text-app-text-muted mt-1">点击可跳过对应阶段（PRD-IR 为必选）</div>
      </div>

      <div className="flex justify-end pt-1">
        <button
          onClick={() => { pipelineEngine.start(cfg); onClose(); }}
          disabled={state.status === "running"}
          className="px-3 py-1 text-[12px] rounded-full bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 transition-colors flex items-center gap-1"
        >
          <Icon d={icons.play} size={12} />
          启动
        </button>
      </div>
    </div>
  );
}
