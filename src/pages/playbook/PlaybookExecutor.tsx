// ===== Playbook 执行浮层 =====
//
// 居中弹窗+遮罩：
// 1. 参数表单（启动前填参数、选预设）
// 2. 步骤清单 + 每步状态/产出
// 3. 控制条：下一步 / 重试 / 跳过 / 中止

import { useState, useEffect, useCallback, useRef } from "react";
import {
  playbookRunner,
  type Playbook,
  type PlaybookRun,
  type PlaybookParam,
  type RunnerEvent,
} from "../../core/playbook";
import type { Connector } from "../../connectors/base";

interface PlaybookExecutorProps {
  playbook: Playbook;
  connector: Connector;
  onClose: () => void;
}

type Phase = "params" | "running";

export default function PlaybookExecutor({ playbook, connector, onClose }: PlaybookExecutorProps) {
  const [phase, setPhase] = useState<Phase>("params");
  const [params, setParams] = useState<Record<string, string>>(() => {
    // 初始化默认值
    const defaults: Record<string, string> = {};
    for (const p of playbook.params) {
      if (p.default) defaults[p.key] = p.default;
      else if (p.type === "boolean") defaults[p.key] = "false";
      else defaults[p.key] = "";
    }
    return defaults;
  });
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [run, setRun] = useState<PlaybookRun | null>(null);
  const [stepOutputs, setStepOutputs] = useState<Record<number, string>>({});
  const [confirmDialog, setConfirmDialog] = useState<{ stepIndex: number; title: string } | null>(null);
  const outputEndRef = useRef<HTMLDivElement>(null);

  // 监听 Runner 事件
  useEffect(() => {
    const unsubscribe = playbookRunner.subscribe((event: RunnerEvent) => {
      switch (event.type) {
        case "status_change":
          setRun({ ...event.run });
          break;
        case "step_output":
          setStepOutputs(prev => ({
            ...prev,
            [event.stepIndex]: (prev[event.stepIndex] || "") + event.chunk,
          }));
          break;
        case "step_complete":
          setRun(prev => prev ? { ...prev, stepResults: [...(playbookRunner.getActiveRun()?.stepResults || [])] } : prev);
          break;
        case "confirm_required":
          setConfirmDialog({ stepIndex: event.stepIndex, title: event.stepTitle });
          break;
        case "run_complete":
          setRun({ ...event.run });
          break;
      }
    });
    return unsubscribe;
  }, []);

  // 自动滚动到底部
  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [stepOutputs, run?.currentStepIndex]);

  // ─── 参数表单操作 ───

  const handlePresetChange = (presetName: string) => {
    setSelectedPreset(presetName);
    const preset = playbook.presets?.find(p => p.name === presetName);
    if (preset) {
      setParams(prev => ({ ...prev, ...preset.values }));
    }
  };

  const handleParamChange = (key: string, value: string) => {
    setParams(prev => ({ ...prev, [key]: value }));
  };

  const canStart = useCallback(() => {
    for (const p of playbook.params) {
      if (p.required && !params[p.key]) return false;
    }
    return true;
  }, [playbook.params, params]);

  // ─── 启动 ───

  const handleStart = async () => {
    try {
      const newRun = await playbookRunner.start(playbook.id, params, connector);
      setRun(newRun);
      setPhase("running");
    } catch (e: any) {
      window.dispatchEvent(new CustomEvent("nova-notify", {
        detail: { msg: `启动失败: ${e?.message || e}`, type: "error" },
      }));
    }
  };

  // ─── 控制操作 ───

  const handleNextStep = async () => {
    try {
      await playbookRunner.runNextStep();
    } catch (e: any) {
      console.error("[PlaybookExecutor] runNextStep error:", e);
    }
  };

  const handleConfirm = async () => {
    setConfirmDialog(null);
    try {
      await playbookRunner.confirmAndRun();
    } catch (e: any) {
      console.error("[PlaybookExecutor] confirmAndRun error:", e);
    }
  };

  const handleConfirmCancel = () => {
    setConfirmDialog(null);
    // 回到 paused 状态，用户可以选择跳过或中止
    // Runner 内部 status 已经是 confirming，这里手动 abort 或让用户点跳过
  };

  const handleRetry = async () => {
    try {
      await playbookRunner.retry();
    } catch (e: any) {
      console.error("[PlaybookExecutor] retry error:", e);
    }
  };

  const handleSkip = async () => {
    try {
      await playbookRunner.skip();
    } catch (e: any) {
      console.error("[PlaybookExecutor] skip error:", e);
    }
  };

  const handleAbort = async () => {
    try {
      await playbookRunner.abort();
    } catch (e: any) {
      console.error("[PlaybookExecutor] abort error:", e);
    }
  };

  // ─── 渲染 ───

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 backdrop-blur-sm p-6">
      <div className="relative w-full max-w-[640px] max-h-[80vh] flex flex-col rounded-2xl bg-app-bg border border-app-border shadow-2xl overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border">
          <div className="flex items-center gap-2">
            <span className="text-base">▶</span>
            <h2 className="text-sm font-semibold text-app-text">{playbook.displayName}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-app-text-muted hover:bg-app-hover transition-colors"
            title="关闭"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1L13 13M1 13L13 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-5">
          {phase === "params" ? (
            <ParamForm
              params={playbook.params}
              values={params}
              presets={playbook.presets}
              selectedPreset={selectedPreset}
              onPresetChange={handlePresetChange}
              onChange={handleParamChange}
            />
          ) : (
            <StepList
              steps={playbook.steps}
              run={run}
              stepOutputs={stepOutputs}
              outputEndRef={outputEndRef}
            />
          )}
        </div>

        {/* 底部控制条 */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-app-border">
          {phase === "params" ? (
            <>
              <p className="text-xs text-app-text-muted">
                {playbook.steps.length} 个步骤
                {playbook.params.length > 0 ? ` · ${playbook.params.length} 个参数` : ""}
              </p>
              <button
                onClick={handleStart}
                disabled={!canStart()}
                className="px-4 py-1.5 rounded-lg text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                开始执行
              </button>
            </>
          ) : (
            <RunControls
              run={run}
              onNext={handleNextStep}
              onRetry={handleRetry}
              onSkip={handleSkip}
              onAbort={handleAbort}
              onClose={onClose}
            />
          )}
        </div>
      </div>

      {/* Confirm 确认对话框 */}
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          onConfirm={handleConfirm}
          onCancel={handleConfirmCancel}
        />
      )}
    </div>
  );
}

// ─── 子组件 ───

function ParamForm({
  params, values, presets, selectedPreset,
  onPresetChange, onChange,
}: {
  params: PlaybookParam[];
  values: Record<string, string>;
  presets?: { name: string; values: Record<string, string> }[];
  selectedPreset: string;
  onPresetChange: (name: string) => void;
  onChange: (key: string, value: string) => void;
}) {
  if (params.length === 0) {
    return (
      <div className="text-center py-8 text-app-text-muted text-sm">
        此 Playbook 无需配置参数，直接点击「开始执行」即可。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 预设选择 */}
      {presets && presets.length > 0 && (
        <div>
          <label className="block text-xs font-medium text-app-text-muted mb-1.5">参数预设</label>
          <select
            value={selectedPreset}
            onChange={e => onPresetChange(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-app-border bg-app-bg text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-blue-500/50"
          >
            <option value="">自定义...</option>
            {presets.map(p => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* 参数表单 */}
      {params.map(param => (
        <div key={param.key}>
          <label className="block text-xs font-medium text-app-text-muted mb-1.5">
            {param.label}
            {param.required && <span className="text-red-400 ml-0.5">*</span>}
            {param.description && (
              <span className="ml-2 font-normal opacity-60">{param.description}</span>
            )}
          </label>
          {param.type === "enum" && param.options ? (
            <select
              value={values[param.key] || ""}
              onChange={e => onChange(param.key, e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-app-border bg-app-bg text-sm text-app-text focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            >
              <option value="">请选择...</option>
              {param.options.map(opt => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          ) : param.type === "boolean" ? (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={values[param.key] === "true"}
                onChange={e => onChange(param.key, e.target.checked ? "true" : "false")}
                className="rounded border-app-border"
              />
              <span className="text-sm text-app-text">{values[param.key] === "true" ? "是" : "否"}</span>
            </label>
          ) : (
            <input
              type="text"
              value={values[param.key] || ""}
              onChange={e => onChange(param.key, e.target.value)}
              placeholder={param.default || `输入${param.label}...`}
              className="w-full px-3 py-2 rounded-lg border border-app-border bg-app-bg text-sm text-app-text placeholder:text-app-text-muted/50 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            />
          )}
        </div>
      ))}
    </div>
  );
}

function StepList({
  steps, run, stepOutputs, outputEndRef,
}: {
  steps: { id: string; title: string; kind: string }[];
  run: PlaybookRun | null;
  stepOutputs: Record<number, string>;
  outputEndRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div className="space-y-2">
      {steps.map((step, idx) => {
        const result = run?.stepResults[idx];
        const isCurrent = run?.currentStepIndex === idx;
        const status = result?.status || (isCurrent ? (run?.status === "running" ? "running" : "pending") : "pending");

        return (
          <div
            key={step.id}
            className={`rounded-xl border p-3 transition-colors ${
              isCurrent
                ? "border-blue-500/50 bg-blue-500/5"
                : result?.status === "success"
                ? "border-green-500/30 bg-green-500/5"
                : result?.status === "failed"
                ? "border-red-500/30 bg-red-500/5"
                : result?.status === "skipped"
                ? "border-app-border/50 bg-app-hover/30"
                : "border-app-border/50"
            }`}
          >
            <div className="flex items-center gap-2">
              <StepStatusIcon status={status} />
              <span className={`text-sm font-medium ${
                result?.status === "skipped" ? "text-app-text-muted line-through" : "text-app-text"
              }`}>
                {idx + 1}. {step.title}
              </span>
              {step.kind === "confirm" && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-600">
                  需确认
                </span>
              )}
            </div>

            {/* 步骤输出 */}
            {(stepOutputs[idx] || result?.output) && (
              <div className="mt-2 pl-6">
                <pre className="text-xs text-app-text-muted whitespace-pre-wrap max-h-32 overflow-y-auto leading-relaxed">
                  {stepOutputs[idx] || result?.output}
                </pre>
              </div>
            )}

            {/* 错误信息 */}
            {result?.error && (
              <div className="mt-2 pl-6">
                <p className="text-xs text-red-400">{result.error}</p>
              </div>
            )}
          </div>
        );
      })}
      <div ref={outputEndRef} />
    </div>
  );
}

function StepStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "success":
      return <span className="w-4 h-4 flex items-center justify-center text-green-500 text-xs">✓</span>;
    case "failed":
      return <span className="w-4 h-4 flex items-center justify-center text-red-500 text-xs">✗</span>;
    case "skipped":
      return <span className="w-4 h-4 flex items-center justify-center text-app-text-muted text-xs">–</span>;
    case "running":
      return (
        <span className="w-4 h-4 flex items-center justify-center">
          <span className="w-2.5 h-2.5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
        </span>
      );
    default:
      return <span className="w-4 h-4 flex items-center justify-center text-app-text-muted/40 text-xs">○</span>;
  }
}

function RunControls({
  run, onNext, onRetry, onSkip, onAbort, onClose,
}: {
  run: PlaybookRun | null;
  onNext: () => void;
  onRetry: () => void;
  onSkip: () => void;
  onAbort: () => void;
  onClose: () => void;
}) {
  if (!run) return null;

  const isTerminal = run.status === "completed" || run.status === "aborted";

  if (isTerminal) {
    return (
      <>
        <p className="text-xs text-app-text-muted">
          {run.status === "completed" ? "✓ 全部完成" : "⊘ 已中止"}
        </p>
        <button
          onClick={onClose}
          className="px-4 py-1.5 rounded-lg text-sm font-medium bg-app-hover text-app-text hover:bg-app-hover/80 transition-colors"
        >
          关闭
        </button>
      </>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2">
        {run.status === "failed" && (
          <>
            <button
              onClick={onRetry}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 transition-colors"
            >
              重试
            </button>
            <button
              onClick={onSkip}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-app-hover text-app-text-muted hover:bg-app-hover/80 transition-colors"
            >
              跳过
            </button>
          </>
        )}
        <button
          onClick={onAbort}
          className="px-3 py-1.5 rounded-lg text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors"
        >
          中止
        </button>
      </div>

      {run.status === "paused" && (
        <button
          onClick={onNext}
          className="px-4 py-1.5 rounded-lg text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 transition-colors"
        >
          执行下一步 →
        </button>
      )}

      {run.status === "running" && (
        <span className="text-xs text-app-text-muted flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          执行中...
        </span>
      )}

      {run.status === "confirming" && (
        <span className="text-xs text-amber-500 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
          等待确认...
        </span>
      )}
    </>
  );
}

/** confirm 步骤的两步确认对话框（Tauri 不用 native confirm） */
function ConfirmDialog({
  title, onConfirm, onCancel,
}: {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [secondConfirm, setSecondConfirm] = useState(false);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
      <div className="w-full max-w-sm rounded-2xl bg-app-bg border border-app-border shadow-2xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-amber-500 text-lg">⚠</span>
          <h3 className="text-sm font-semibold text-app-text">危险步骤确认</h3>
        </div>
        <p className="text-sm text-app-text-muted mb-4">
          即将执行：<strong className="text-app-text">{title}</strong>
        </p>
        {!secondConfirm ? (
          <div className="flex justify-end gap-2">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 rounded-lg text-sm text-app-text-muted hover:bg-app-hover transition-colors"
            >
              取消
            </button>
            <button
              onClick={() => setSecondConfirm(true)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 transition-colors"
            >
              确认执行
            </button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 rounded-lg text-sm text-app-text-muted hover:bg-app-hover transition-colors"
            >
              取消
            </button>
            <button
              onClick={onConfirm}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition-colors"
            >
              再次确认 — 执行
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
