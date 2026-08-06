// ===== 会话搜索面板 =====
//
// ⌘F 打开，默认搜当前会话，可切到全部会话。
// 简化版：只展示命中片段供查阅，不做跳转定位。

import { useState, useEffect, useRef } from "react";
import { searchMessages, highlightParts } from "../../core/sessionSearch";
import type { SearchScope, SearchHit } from "../../core/sessionSearch";

/** 输入防抖：避免每敲一个字都扫一遍磁盘 */
const DEBOUNCE_MS = 180;

const ROLE_LABELS: Record<string, string> = {
  user: "我",
  assistant: "回复",
  system: "系统",
};

function formatTime(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return sameYear ? `${mm}/${dd} ${hh}:${mi}` : `${d.getFullYear()}/${mm}/${dd}`;
}

function SearchPanel({
  open,
  onClose,
  sessionId,
  initialScope = "session",
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string | null;
  initialScope?: SearchScope;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>(initialScope);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时聚焦并采用调用方指定的范围
  useEffect(() => {
    if (!open) return;
    setScope(initialScope);
    // 等面板挂载后再聚焦
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open, initialScope]);

  // 关闭时清空，避免下次打开闪出上次的结果
  useEffect(() => {
    if (open) return;
    setQuery("");
    setHits([]);
    setTruncated(false);
  }, [open]);

  // 防抖搜索；cancelled 标记避免慢请求覆盖新结果
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      setTruncated(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const r = await searchMessages(q, scope, sessionId);
      if (cancelled) return;
      setHits(r.results);
      setTruncated(r.truncated);
      setSearching(false);
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, scope, sessionId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const scopeButton = (value: SearchScope, label: string) => (
    <button
      onClick={() => setScope(value)}
      className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
        scope === value
          ? "bg-app-surface-hover text-app-text"
          : "text-app-text-muted hover:text-app-text-secondary"
      }`}
    >
      {label}
    </button>
  );

  return (
    <>
      {/* 遮罩：点击关闭 */}
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div
        className="fixed left-1/2 -translate-x-1/2 top-[12vh] z-50 w-[min(680px,90vw)] rounded-2xl shadow-[0_16px_48px_rgba(0,0,0,0.18)] overflow-hidden"
        style={{ backgroundColor: "var(--app-bg)" }}
      >
        {/* 输入行 */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-app-border">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="shrink-0 text-app-text-muted" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={scope === "session" ? "在本会话中搜索…" : "在全部会话中搜索…"}
            className="flex-1 bg-transparent text-[14px] text-app-text placeholder:text-app-text-muted focus:outline-none"
          />
          <div className="flex items-center gap-0.5 shrink-0">
            {scopeButton("session", "本会话")}
            {scopeButton("global", "全部会话")}
          </div>
        </div>

        {/* 结果 */}
        <div className="max-h-[52vh] overflow-y-auto">
          {!query.trim() ? (
            <p className="px-4 py-6 text-[12px] text-app-text-muted text-center">
              搜索会话正文。与浏览器查找不同，这里会搜完整历史，不只是当前屏幕上的内容。
            </p>
          ) : searching && hits.length === 0 ? (
            <p className="px-4 py-6 text-[12px] text-app-text-muted text-center">搜索中…</p>
          ) : hits.length === 0 ? (
            <p className="px-4 py-6 text-[12px] text-app-text-muted text-center">
              没有匹配的内容
              {scope === "session" && (
                <>
                  {"　"}
                  <button onClick={() => setScope("global")} className="underline hover:text-app-text">
                    搜全部会话
                  </button>
                </>
              )}
            </p>
          ) : (
            <>
              <div className="px-4 pt-2.5 pb-1 flex items-center justify-between">
                <span className="text-[11px] text-app-text-muted">
                  {hits.length} 条命中
                  {scope === "global" && ` · ${new Set(hits.map(h => h.sessionId)).size} 个会话`}
                </span>
                {truncated && <span className="text-[11px] text-app-text-muted">结果过多，已截断</span>}
              </div>
              <div className="pb-2">
                {hits.map((h, i) => (
                  <div
                    key={`${h.sessionId}-${h.messageIndex}-${i}`}
                    className="px-4 py-2 hover:bg-app-surface transition-colors"
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-app-surface-hover text-app-text-muted shrink-0">
                        {ROLE_LABELS[h.role || ""] || h.role}
                      </span>
                      {scope === "global" && (
                        <span className="text-[11px] text-app-text-secondary min-w-0 truncate">
                          {h.sessionTitle}
                        </span>
                      )}
                      <span className="text-[10px] text-app-text-muted shrink-0 ml-auto">
                        {formatTime(h.timestamp)}
                      </span>
                    </div>
                    <p className="text-[12px] leading-relaxed text-app-text-secondary break-words">
                      {highlightParts(h.snippet, query).map((p, j) =>
                        p.matched ? (
                          <mark key={j} className="bg-yellow-300/40 text-app-text rounded px-0.5">
                            {p.text}
                          </mark>
                        ) : (
                          <span key={j}>{p.text}</span>
                        )
                      )}
                    </p>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export default SearchPanel;
