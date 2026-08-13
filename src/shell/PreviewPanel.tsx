import { useState, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAppStore } from "../App";
import { CATEGORY_LABELS } from "../core/memory/longterm";
import type { LongTermMemory, MemoryCategory } from "../core/memory/longterm";
import { applyDistillResult } from "../core/distill";
import { removeReviewItem } from "../core/distill";
import type { DistillResult, MemoryCandidate, SkillCandidate, PlaybookCandidate, ArtifactConfidence } from "../core/distill";
import ImageViewer from "../pages/image-preview/ImageViewer";
import { openImagePreviewWindow } from "../pages/image-preview/openWindow";

function PreviewPanel() {
  const { previewPanel, setPreviewPanel } = useAppStore();
  const [memoryFilter, setMemoryFilter] = useState<MemoryCategory | "all">("all");
  const [fullscreen, setFullscreen] = useState(false);

  if (!previewPanel) return null;

  const openInWindow = (path: string) => {
    void openImagePreviewWindow(path).catch(error => {
      window.dispatchEvent(new CustomEvent("nova-notify", {
        detail: { msg: `打开图片窗口失败：${error?.message || error}`, type: "error" },
      }));
    });
  };

  // 图片全屏 overlay
  if (previewPanel.type === "image" && fullscreen) {
    return (
      <div className="fixed inset-0 z-[9999] bg-black/90">
        <ImageViewer
          path={previewPanel.data}
          onClose={() => setFullscreen(false)}
          onOpenWindow={() => openInWindow(previewPanel.data)}
        />
      </div>
    );
  }

  // 图片侧边栏预览
  if (previewPanel.type === "image") {
    return (
      <div className="w-[400px] h-full border-l border-app-border flex flex-col bg-app-bg">
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border shrink-0">
          <h3 className="text-[14px] font-medium text-app-text">图片预览</h3>
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                window.dispatchEvent(new CustomEvent("nova-add-attachment", { detail: previewPanel.data }));
              }}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
              title="添加到输入框"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14"/>
              </svg>
            </button>
            <button
              onClick={() => setFullscreen(true)}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
              title="全屏查看"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
            <button
              onClick={() => openInWindow(previewPanel.data)}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
              title="在独立窗口打开"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 3h7v7M21 3l-9 9" />
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
              </svg>
            </button>
            <button
              onClick={() => { setPreviewPanel(null); setFullscreen(false); }}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
              title="关闭"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        {/* 图片内容 */}
        <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4">
          <img
            src={convertFileSrc(previewPanel.data)}
            alt="预览"
            className="max-w-full max-h-full object-contain rounded-lg cursor-pointer"
            onClick={() => setFullscreen(true)}
            draggable="true"
            onDragStart={(e) => {
              e.dataTransfer.setData("text/nova-image-path", previewPanel.data);
              e.dataTransfer.effectAllowed = "copy";
            }}
          />
        </div>
        {/* 底部信息 */}
        <div className="px-4 py-2 border-t border-app-border shrink-0">
          <p className="text-[11px] text-app-text-muted truncate">
            {previewPanel.data.split("/").pop()}
          </p>
        </div>
      </div>
    );
  }

  // 文件内容预览
  if (previewPanel.type === "file") {
    return <FilePreview path={previewPanel.data} onClose={() => setPreviewPanel(null)} />;
  }

  // 蒸馏审阅面板
  if (previewPanel.type === "distill") {
    return <DistillReview result={previewPanel.data} onClose={() => setPreviewPanel(null)} />;
  }

  // 记忆列表侧边栏
  return (
    <div className="w-[400px] h-full border-l border-app-border flex flex-col bg-app-bg">
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border shrink-0">
        <h3 className="text-[14px] font-medium text-app-text">记忆列表</h3>
        <button
          onClick={() => setPreviewPanel(null)}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
          title="关闭"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <MemoriesPreview
          memories={previewPanel.data}
          filter={memoryFilter}
          setFilter={setMemoryFilter}
        />
      </div>
    </div>
  );
}

function MemoriesPreview({
  memories,
  filter,
  setFilter,
}: {
  memories: LongTermMemory[];
  filter: MemoryCategory | "all";
  setFilter: (f: MemoryCategory | "all") => void;
}) {
  return (
    <div className="space-y-3">
      {/* 分类筛选 */}
      <div className="flex gap-1.5 flex-wrap">
        <button
          onClick={() => setFilter("all")}
          className={`px-2 py-1 rounded-full text-[10px] font-medium transition-colors ${
            filter === "all" ? "bg-app-surface-hover text-app-text" : "text-app-text-muted hover:text-app-text-secondary"
          }`}
        >
          全部 ({memories.length})
        </button>
        {(Object.keys(CATEGORY_LABELS) as MemoryCategory[]).map(cat => {
          const count = memories.filter(m => m.category === cat).length;
          if (count === 0) return null;
          return (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={`px-2 py-1 rounded-full text-[10px] font-medium transition-colors ${
                filter === cat ? "bg-app-surface-hover text-app-text" : "text-app-text-muted hover:text-app-text-secondary"
              }`}
            >
              {CATEGORY_LABELS[cat]} ({count})
            </button>
          );
        })}
      </div>

      {/* 记忆列表 */}
      <div className="space-y-1.5">
        {memories.length === 0 ? (
          <p className="text-[11px] text-app-text-muted py-4 text-center">暂无记忆</p>
        ) : (
          memories
            .filter(m => filter === "all" || m.category === filter)
            .map(mem => (
              <div key={mem.id} className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-app-bg border border-app-border">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-app-surface-hover text-app-text-muted font-medium">
                      {CATEGORY_LABELS[mem.category]}
                    </span>
                    {mem.tags.length > 0 && (
                      <span className="text-[9px] text-app-text-muted">
                        {mem.tags.slice(0, 3).join(" · ")}
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-app-text leading-relaxed">{mem.content}</p>
                  <span className="text-[9px] text-app-text-muted">
                    {new Date(mem.createdAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              </div>
            ))
        )}
      </div>
    </div>
  );
}

export default PreviewPanel;
function FilePreview({ path, onClose }: { path: string; onClose: () => void }) {
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const filename = path.split("/").pop() || path;
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        // tool_file_read returns content with line numbers like "  1| ...", strip them
        const raw = await invoke<string>("tool_file_read", { path, offset: null, limit: null });
        // Remove line number prefix (e.g. "  1| ")
        const text = raw.replace(/^\s*\d+\| /gm, "");
        setContent(text);
      } catch (e: any) {
        setError(e.message || e || "读取文件失败");
      }
      setLoading(false);
    })();
  }, [path]);

  return (
    <div className="w-[450px] h-full border-l border-app-border flex flex-col bg-app-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6" />
          </svg>
          <span className="text-[13px] font-medium text-app-text truncate">{filename}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-app-surface-hover text-app-text-muted">{ext}</span>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
          title="关闭"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {loading && (
          <div className="flex items-center justify-center py-8 text-[12px] text-app-text-muted">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="animate-spin mr-2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
            加载中...
          </div>
        )}
        {error && (
          <div className="px-3 py-2 rounded-lg border border-red-500/20 bg-red-500/5 text-[11px] text-red-400">
            {error}
          </div>
        )}
        {!loading && !error && (
          <pre className="text-[11px] font-mono text-app-text leading-relaxed whitespace-pre-wrap break-words">
            {content}
          </pre>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-app-border shrink-0">
        <p className="text-[10px] text-app-text-muted truncate">{path}</p>
      </div>
    </div>
  );
}


// ─── 蒸馏审阅面板 ───

const CONFIDENCE_STYLE: Record<ArtifactConfidence, { label: string; cls: string }> = {
  high: { label: "高", cls: "bg-green-500/15 text-green-500" },
  medium: { label: "中", cls: "bg-yellow-500/15 text-yellow-600" },
  low: { label: "低", cls: "bg-app-surface-hover text-app-text-muted" },
};

function ConfidenceBadge({ c }: { c: ArtifactConfidence }) {
  const s = CONFIDENCE_STYLE[c] || CONFIDENCE_STYLE.medium;
  return <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${s.cls}`}>置信 {s.label}</span>;
}

function DistillReview({ result, onClose }: { result: DistillResult; onClose: () => void }) {
  // 默认勾选 high 置信度
  const initSel = (arr: { confidence: ArtifactConfidence }[]) =>
    new Set(arr.map((_, i) => i).filter(i => arr[i].confidence === "high"));

  const [memSel, setMemSel] = useState<Set<number>>(() => initSel(result.memories));
  const [skillSel, setSkillSel] = useState<Set<number>>(() => initSel(result.skills));
  const [pbSel, setPbSel] = useState<Set<number>>(() => initSel(result.playbooks));
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState(false);
  const [wide, setWide] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // 可编辑本地副本（小偏差就地修改后应用，不必丢弃）
  const [mems, setMems] = useState<MemoryCandidate[]>(() => result.memories.map(m => ({ ...m, tags: [...m.tags] })));
  const [skills, setSkills] = useState<SkillCandidate[]>(() => result.skills.map(s => ({ ...s, keywords: [...s.keywords], tags: [...s.tags] })));
  const [pbs, setPbs] = useState<PlaybookCandidate[]>(() => result.playbooks.map(p => ({ ...p, keywords: [...p.keywords], steps: p.steps.map(st => ({ ...st })) })));
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const toggleEdit = (key: string) => {
    setEditing(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const updateMem = (i: number, patch: Partial<MemoryCandidate>) => setMems(a => a.map((m, idx) => idx === i ? { ...m, ...patch } : m));
  const updateSkill = (i: number, patch: Partial<SkillCandidate>) => setSkills(a => a.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  const updatePb = (i: number, patch: Partial<PlaybookCandidate>) => setPbs(a => a.map((p, idx) => idx === i ? { ...p, ...patch } : p));
  const updatePbStep = (i: number, si: number, patch: Partial<{ title: string; detail: string }>) =>
    setPbs(a => a.map((p, idx) => idx === i ? { ...p, steps: p.steps.map((st, sj) => sj === si ? { ...st, ...patch } : st) } : p));
  const splitTags = (v: string) => v.split(/[,，]/).map(t => t.trim()).filter(Boolean);

  const queueId: string | undefined = (result as any).__queueId;

  const clearFromQueue = async () => {
    if (queueId) {
      await removeReviewItem(queueId);
      window.dispatchEvent(new CustomEvent("nova-distill-queue-changed"));
    }
  };

  const handleIgnore = async () => {
    await clearFromQueue();
    onClose();
  };

  const toggle = (set: Set<number>, setter: (s: Set<number>) => void, i: number) => {
    const next = new Set(set);
    if (next.has(i)) next.delete(i); else next.add(i);
    setter(next);
  };

  const selectedCount = memSel.size + skillSel.size + pbSel.size;

  const handleApply = async () => {
    if (applying || selectedCount === 0) return;
    setApplying(true);
    try {
      const selected = {
        memories: mems.filter((_, i) => memSel.has(i)),
        skills: skills.filter((_, i) => skillSel.has(i)),
        playbooks: pbs.filter((_, i) => pbSel.has(i)),
      };
      const stats = await applyDistillResult(selected);
      await clearFromQueue();
      window.dispatchEvent(new CustomEvent("nova-notify", {
        detail: { msg: `已沉淀：${stats.memoriesSaved} 记忆 / ${stats.skillsSaved} 技能 / ${stats.playbooksSaved} 工作流`, type: "success" },
      }));
      setDone(true);
      setTimeout(onClose, 800);
    } catch (e: any) {
      window.dispatchEvent(new CustomEvent("nova-notify", { detail: { msg: `沉淀失败：${e?.message || e}`, type: "error" } }));
    } finally {
      setApplying(false);
    }
  };

  const panelBody = (
    <>
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border shrink-0">
        <h3 className="text-[14px] font-medium text-app-text">蒸馏审阅</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setWide(w => !w)}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
            title={wide ? "收起面板" : "展开面板"}
          >
            {wide ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 3 3 3 3 9"/><polyline points="15 21 21 21 21 15"/><line x1="3" y1="3" x2="10" y2="10"/><line x1="21" y1="21" x2="14" y2="14"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            )}
          </button>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
            title="关闭"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </div>

      {/* 内容 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {result.summary && (
          <p className="text-[13px] text-app-text-secondary leading-relaxed">{result.summary}</p>
        )}

        {mems.length + skills.length + pbs.length === 0 && (
          <p className="text-[13px] text-app-text-muted py-6 text-center">没有蒸馏出可沉淀的内容</p>
        )}

        {/* 记忆 */}
        {mems.length > 0 && (
          <Section title={`记忆 (${mems.length})`}>
            {mems.map((m, i) => {
              const ed = editing.has(`m${i}`);
              return (
                <CandidateRow key={i} checked={memSel.has(i)} onToggle={() => toggle(memSel, setMemSel, i)} confidence={m.confidence} editing={ed} onEdit={() => toggleEdit(`m${i}`)}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-app-surface-hover text-app-text-muted font-medium">{CATEGORY_LABELS[m.category]}</span>
                    {m.isUpdate && <span className="text-[10px] text-app-text-muted">更新已有</span>}
                  </div>
                  {ed ? (
                    <div onClick={(e) => e.stopPropagation()} className="space-y-1.5">
                      <textarea value={m.content} onChange={(e) => updateMem(i, { content: e.target.value })}
                        className="w-full min-h-[90px] px-2 py-1.5 rounded-md border border-app-border bg-app-bg text-[13px] text-app-text leading-relaxed resize-y focus:outline-none focus:border-app-text-muted" />
                      <input value={m.tags.join(", ")} onChange={(e) => updateMem(i, { tags: splitTags(e.target.value) })} placeholder="标签，逗号分隔"
                        className="w-full px-2 py-1 rounded-md border border-app-border bg-app-bg text-[11px] text-app-text-secondary focus:outline-none" />
                    </div>
                  ) : (
                    <>
                      <p className="text-[13px] text-app-text leading-relaxed">{m.content}</p>
                      {m.tags.length > 0 && <span className="text-[10px] text-app-text-muted">{m.tags.slice(0, 4).join(" · ")}</span>}
                    </>
                  )}
                </CandidateRow>
              );
            })}
          </Section>
        )}

        {/* 技能 */}
        {skills.length > 0 && (
          <Section title={`技能 (${skills.length})`}>
            {skills.map((s, i) => {
              const ed = editing.has(`s${i}`);
              return (
                <CandidateRow key={i} checked={skillSel.has(i)} onToggle={() => toggle(skillSel, setSkillSel, i)} confidence={s.confidence} editing={ed} onEdit={() => toggleEdit(`s${i}`)}>
                  {ed ? (
                    <div onClick={(e) => e.stopPropagation()} className="space-y-1.5">
                      <input value={s.displayName} onChange={(e) => updateSkill(i, { displayName: e.target.value })} placeholder="名称"
                        className="w-full px-2 py-1 rounded-md border border-app-border bg-app-bg text-[13px] font-medium text-app-text focus:outline-none focus:border-app-text-muted" />
                      <input value={s.description} onChange={(e) => updateSkill(i, { description: e.target.value })} placeholder="适用场景描述"
                        className="w-full px-2 py-1 rounded-md border border-app-border bg-app-bg text-[12px] text-app-text-secondary focus:outline-none" />
                      <input value={s.keywords.join(", ")} onChange={(e) => updateSkill(i, { keywords: splitTags(e.target.value) })} placeholder="召回关键词，逗号分隔"
                        className="w-full px-2 py-1 rounded-md border border-app-border bg-app-bg text-[11px] text-app-text-muted focus:outline-none" />
                      <textarea value={s.body} onChange={(e) => updateSkill(i, { body: e.target.value })} placeholder="SKILL.md 正文"
                        className="w-full min-h-[240px] px-2 py-1.5 rounded-md border border-app-border bg-app-bg text-[12px] font-mono text-app-text leading-relaxed resize-y focus:outline-none focus:border-app-text-muted" />
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[13px] font-medium text-app-text">{s.displayName}</span>
                        {s.isUpdate && <span className="text-[10px] text-app-text-muted">更新已有</span>}
                      </div>
                      <p className="text-[12px] text-app-text-secondary leading-relaxed">{s.description}</p>
                      {s.keywords.length > 0 && <span className="text-[10px] text-app-text-muted">关键词：{s.keywords.slice(0, 5).join(" · ")}</span>}
                      <div>
                        <button onClick={(e) => { e.stopPropagation(); toggleExpand(`s${i}`); }} className="mt-1 text-[11px] text-app-text-muted hover:text-app-text transition-colors">
                          {expanded.has(`s${i}`) ? "▾ 收起正文" : "▸ 查看正文"}
                        </button>
                        {expanded.has(`s${i}`) && (
                          <pre className="mt-1 px-2 py-1.5 rounded-md bg-app-surface-hover text-[12px] font-mono text-app-text leading-relaxed whitespace-pre-wrap break-words max-h-[280px] overflow-y-auto">{s.body || "（无正文）"}</pre>
                        )}
                      </div>
                    </>
                  )}
                </CandidateRow>
              );
            })}
          </Section>
        )}

        {/* 工作流 */}
        {pbs.length > 0 && (
          <Section title={`工作流 (${pbs.length})`}>
            {pbs.map((p, i) => {
              const ed = editing.has(`p${i}`);
              return (
                <CandidateRow key={i} checked={pbSel.has(i)} onToggle={() => toggle(pbSel, setPbSel, i)} confidence={p.confidence} editing={ed} onEdit={() => toggleEdit(`p${i}`)}>
                  {ed ? (
                    <div onClick={(e) => e.stopPropagation()} className="space-y-1.5">
                      <input value={p.displayName} onChange={(e) => updatePb(i, { displayName: e.target.value })} placeholder="名称"
                        className="w-full px-2 py-1 rounded-md border border-app-border bg-app-bg text-[13px] font-medium text-app-text focus:outline-none focus:border-app-text-muted" />
                      <input value={p.description} onChange={(e) => updatePb(i, { description: e.target.value })} placeholder="描述"
                        className="w-full px-2 py-1 rounded-md border border-app-border bg-app-bg text-[12px] text-app-text-secondary focus:outline-none" />
                      <div className="space-y-1.5">
                        {p.steps.map((st, si) => (
                          <div key={si} className="flex gap-1.5 items-start">
                            <span className="text-[11px] text-app-text-muted mt-1.5 shrink-0">{si + 1}.</span>
                            <div className="flex-1 space-y-1">
                              <input value={st.title} onChange={(e) => updatePbStep(i, si, { title: e.target.value })} placeholder="步骤标题"
                                className="w-full px-2 py-1 rounded-md border border-app-border bg-app-bg text-[12px] text-app-text focus:outline-none" />
                              <input value={st.detail} onChange={(e) => updatePbStep(i, si, { detail: e.target.value })} placeholder="步骤细节"
                                className="w-full px-2 py-1 rounded-md border border-app-border bg-app-bg text-[11px] text-app-text-secondary focus:outline-none" />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-[13px] font-medium text-app-text mb-1">{p.displayName}</p>
                      <p className="text-[12px] text-app-text-secondary leading-relaxed">{p.description}</p>
                      <div>
                        <button onClick={(e) => { e.stopPropagation(); toggleExpand(`p${i}`); }} className="mt-1 text-[11px] text-app-text-muted hover:text-app-text transition-colors">
                          {expanded.has(`p${i}`) ? `▾ 收起步骤（${p.steps.length}）` : `▸ 查看步骤（${p.steps.length}）`}
                        </button>
                        {expanded.has(`p${i}`) && (
                          <ol className="mt-1 px-2 py-1.5 rounded-md bg-app-surface-hover space-y-1 list-decimal list-inside">
                            {p.steps.map((step, si) => (
                              <li key={si} className="text-[12px] text-app-text leading-relaxed">
                                <span className="font-medium">{step.title}</span>
                                {step.detail && <span className="text-app-text-secondary">：{step.detail}</span>}
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    </>
                  )}
                </CandidateRow>
              );
            })}
          </Section>
        )}
      </div>

      {/* 底部操作 */}
      <div className="px-4 py-3 border-t border-app-border shrink-0 flex items-center gap-2">
        <button
          onClick={handleIgnore}
          className="flex-1 px-3 py-2 rounded-lg text-[12px] text-app-text-muted hover:bg-app-surface-hover transition-colors"
        >
          全部忽略
        </button>
        <button
          onClick={handleApply}
          disabled={applying || done || selectedCount === 0}
          className="flex-1 px-3 py-2 rounded-lg text-[12px] font-medium bg-app-text text-app-bg disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-80 transition-opacity"
        >
          {done ? "已沉淀" : applying ? "沉淀中…" : `应用选中 (${selectedCount})`}
        </button>
      </div>
    </>
  );

  // 展开态：居中浮层弹窗（不挤压会话区）；收起态：右侧 400px 侧栏
  if (wide) {
    return (
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm p-6"
        onClick={(e) => { if (e.target === e.currentTarget) setWide(false); }}
      >
        <div className="w-[840px] max-w-[92vw] h-[85vh] rounded-2xl shadow-2xl border border-app-border bg-app-bg flex flex-col overflow-hidden">
          {panelBody}
        </div>
      </div>
    );
  }

  return (
    <div className="w-[400px] h-full border-l border-app-border flex flex-col bg-app-bg">
      {panelBody}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-[11px] font-medium text-app-text-muted uppercase tracking-wide">{title}</h4>
      {children}
    </div>
  );
}

function CandidateRow({
  checked,
  onToggle,
  confidence,
  children,
  onEdit,
  editing,
}: {
  checked: boolean;
  onToggle: () => void;
  confidence: ArtifactConfidence;
  children: React.ReactNode;
  onEdit?: () => void;
  editing?: boolean;
}) {
  return (
    <div
      onClick={editing ? undefined : onToggle}
      className={`px-2.5 py-2 rounded-lg border transition-colors ${
        editing
          ? "border-app-text/30 bg-app-surface-hover"
          : checked
          ? "border-app-text/30 bg-app-surface-hover cursor-pointer"
          : "border-app-border bg-app-bg hover:bg-app-surface-hover cursor-pointer"
      }`}
    >
      {/* meta 行：复选框（左） + 编辑 + 置信度（右）；内容在下方占满整宽 */}
      <div className="flex items-center gap-2 mb-1.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 accent-current"
        />
        <div className="flex-1" />
        {onEdit && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className={`text-[10px] transition-colors ${editing ? "text-[#10a37f]" : "text-app-text-muted hover:text-app-text"}`}
            title={editing ? "完成编辑" : "编辑"}
          >
            {editing ? "完成" : "编辑"}
          </button>
        )}
        <ConfidenceBadge c={confidence} />
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
