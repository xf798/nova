import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatSession } from "../../core/types";
import {
  CHANNEL_BINDING_CHANGED_EVENT,
  channelBindings,
  type ChannelBinding,
} from "../../core/channelBindings";

export default function WecomSessionBinding({
  channelSessionId,
  sessions,
}: {
  channelSessionId: string;
  sessions: ChatSession[];
}) {
  const [binding, setBinding] = useState<ChannelBinding | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  const reload = () => {
    void channelBindings.get("wecom", channelSessionId).then(setBinding);
  };

  useEffect(() => {
    reload();
    const onChanged = () => reload();
    window.addEventListener(CHANNEL_BINDING_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CHANNEL_BINDING_CHANGED_EVENT, onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelSessionId]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  const target = binding
    ? sessions.find(session => session.id === binding.targetSessionId)
    : undefined;

  const candidates = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return sessions
      .filter(session => !session.id.startsWith("wecom-"))
      .filter(session => !normalized || session.title.toLowerCase().includes(normalized))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 80);
  }, [sessions, query]);

  const bind = async (targetSession: ChatSession) => {
    await channelBindings.bind("wecom", channelSessionId, targetSession.id);
    setOpen(false);
    setQuery("");
    window.dispatchEvent(new CustomEvent("nova-notify", {
      detail: { msg: `企微已关联「${targetSession.title}」`, type: "success" },
    }));
  };

  const unbind = async () => {
    await channelBindings.unbind("wecom", channelSessionId);
    setOpen(false);
    window.dispatchEvent(new CustomEvent("nova-notify", {
      detail: { msg: "企微会话已解绑", type: "success" },
    }));
  };

  return (
    <div className="relative px-4 pb-1">
      <div className="max-w-[760px] mx-auto flex items-center gap-2">
        <div ref={panelRef} className="relative">
          <button
            onClick={() => setOpen(value => !value)}
            className="inline-flex items-center h-7 gap-1.5 px-2.5 rounded-lg text-[11px] font-medium text-app-text-muted hover:text-app-text transition-colors"
            style={{ backgroundColor: "var(--app-surface-hover)" }}
            title="选择这个企微入口要续接的 Nova 会话"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
            </svg>
            <span className="max-w-[260px] truncate">
              {target ? `企微续接：${target.title}` : binding ? "企微续接：目标已失效" : "关联 Nova 会话"}
            </span>
          </button>

          {open && (
            <div className="absolute left-0 bottom-full mb-2 w-[360px] max-h-[360px] flex flex-col rounded-xl border border-app-border shadow-lg z-50 overflow-hidden bg-app-bg">
              <div className="p-2 border-b border-app-border">
                <div className="flex items-center justify-between px-1 pb-2">
                  <span className="text-[12px] font-medium text-app-text">企微续接会话</span>
                  {binding && (
                    <button onClick={unbind} className="text-[11px] text-red-500 hover:text-red-400">解绑</button>
                  )}
                </div>
                <input
                  autoFocus
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder="搜索 Nova 会话"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-app-border bg-app-surface text-[12px] text-app-text focus:outline-none focus:border-app-text-muted"
                />
              </div>
              <div className="overflow-y-auto p-1.5">
                {candidates.length === 0 ? (
                  <div className="px-3 py-5 text-center text-[12px] text-app-text-muted">没有可关联的 Nova 会话</div>
                ) : candidates.map(session => (
                  <button
                    key={session.id}
                    onClick={() => bind(session)}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left hover:bg-app-surface-hover transition-colors"
                  >
                    <span className="min-w-0 truncate text-[12px] text-app-text-secondary">{session.title}</span>
                    {binding?.targetSessionId === session.id && (
                      <span className="shrink-0 text-[10px] text-green-500">已关联</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <span className="text-[11px] text-app-text-muted">
          {target ? "新消息会写入并继续该会话" : "未关联时使用独立企微会话"}
        </span>
      </div>
    </div>
  );
}
