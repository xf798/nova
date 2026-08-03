import { useState, useRef, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAppStore } from "../../App";
import { chatDrafts } from "../../core/chatDrafts";
import { getWorkspaceDirs } from "../../plugins/builtin/workspace";
import { bootstrapCommands, dispatchCommand, resolveCommand, runDistill } from "../../core/commands";
import ConnectorSelector from "./ConnectorSelector";
import ModelSelector from "./ModelSelector";

/** 弹 toast（复用 App 的 nova-notify 监听） */
function toast(msg: string, type: "info" | "success" | "error" = "info") {
  window.dispatchEvent(new CustomEvent("nova-notify", { detail: { msg, type } }));
}

function ChatInput({
  isProcessing,
  isDragging,
  attachments,
  setAttachments,
  selectedWorkspace,
  setSelectedWorkspace,
  showWorkspacePicker,
  setShowWorkspacePicker,
  onSend,
  onAbort,
  sessionId,
  totalUsage,
}: {
  isProcessing: boolean;
  isDragging: boolean;
  attachments: string[];
  setAttachments: React.Dispatch<React.SetStateAction<string[]>>;
  selectedWorkspace: string | null;
  setSelectedWorkspace: React.Dispatch<React.SetStateAction<string | null>>;
  showWorkspacePicker: boolean;
  setShowWorkspacePicker: React.Dispatch<React.SetStateAction<boolean>>;
  onSend: (text: string) => void;
  onAbort: () => void;
  sessionId: string | null;
  totalUsage?: { inputTokens: number; outputTokens: number; totalTokens: number; resourcePoints: number };
}) {
  const { activeConnector, hasFullDiskAccess, requestFullDiskAccess } = useAppStore();
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [input, setInput] = useState(() => chatDrafts.get(sessionId) ?? "");
  const prevSessionRef = useRef<string | null>(sessionId);

  const inputRef = useRef(input);
  inputRef.current = input;
  useEffect(() => {
    return () => {
      chatDrafts.set(prevSessionRef.current, inputRef.current);
    };
  }, []);

  useEffect(() => {
    const prevId = prevSessionRef.current;
    if (prevId !== sessionId) {
      chatDrafts.set(prevId, input);
      setInput(chatDrafts.get(sessionId) ?? "");
      prevSessionRef.current = sessionId;
    }
  }, [sessionId]);

  const isImage = (path: string) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path);
  const fileName = (path: string) => path.split("/").pop() || path;

  // 注册内置 slash 命令（幂等）
  useEffect(() => { bootstrapCommands(); }, []);
  const [distilling, setDistilling] = useState(false);

  const workspacePickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showWorkspacePicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (workspacePickerRef.current && !workspacePickerRef.current.contains(e.target as Node)) {
        setShowWorkspacePicker(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showWorkspacePicker]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !isComposing && e.keyCode !== 229) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    // slash 命令拦截：只有确实命中已注册命令才走命令分支。
    // 先前按「以 / 开头」判定，会把 /Users/… 这类路径当命令，
    // 清空输入框后既不发消息也没命令可执行，输入就丢了。
    if (text && resolveCommand(text)) {
      setInput("");
      chatDrafts.clear(sessionId);
      dispatchCommand(text, { sessionId, notify: toast });
      return;
    }

    setInput("");
    chatDrafts.clear(sessionId);
    onSend(text);
  };

  const handleDistill = async () => {
    if (distilling) return;
    setDistilling(true);
    try {
      await runDistill({ sessionId, notify: toast }, "");
    } finally {
      setDistilling(false);
    }
  };

  return (
    <div className="shrink-0 px-4 pb-4 pt-2">
      <div className="max-w-[760px] mx-auto">

        <div className={`relative rounded-3xl border transition-all ${
          isDragging ? "border-[#10a37f] shadow-[0_0_0_2px_rgba(16,163,127,0.2)]" : "border-app-border focus-within:border-app-text-muted"
        }`} style={{ backgroundColor: "var(--app-input-bg)" }}
          onDragOver={(e) => {
            e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
          }}>
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              {attachments.map((path, i) => (
                <div key={i} className="relative group">
                  {isImage(path) ? (
                    <img src={convertFileSrc(path)} alt={fileName(path)} className="w-14 h-14 object-cover rounded-xl border border-app-border" />
                  ) : (
                    <div className="h-14 flex items-center gap-2 px-3 bg-app-surface-hover rounded-xl border border-app-border">
                      <span className="text-base">📄</span>
                      <span className="text-[11px] text-app-text-secondary max-w-[80px] truncate">{fileName(path)}</span>
                    </div>
                  )}
                  <button onClick={() => setAttachments(prev => prev.filter((_, idx) => idx !== i))}
                    className="absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center bg-app-surface-hover border border-app-border hover:bg-red-500 hover:border-red-500 hover:text-white rounded-full text-[10px] text-app-text-muted opacity-0 group-hover:opacity-100 transition-all">×</button>
                </div>
              ))}
            </div>
          )}


          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); chatDrafts.set(sessionId, e.target.value); }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            placeholder={`给 ${activeConnector.config.name} 发送消息`}
            rows={1}
            className="w-full px-5 py-4 bg-transparent text-[15px] text-app-text resize-none focus:outline-none leading-normal placeholder:text-app-text-muted"
            style={{ minHeight: "52px", maxHeight: "200px" }}
            onInput={(e) => {
              const el = e.target as HTMLTextAreaElement;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 200) + "px";
            }}
          />


          <div className="flex items-center justify-between px-3 pb-2.5">
            <div className="flex items-center gap-1.5">
              <ConnectorSelector />
              <ModelSelector />
              <div className="relative">
              <button
                onClick={() => setShowWorkspacePicker(!showWorkspacePicker)}
        className="inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[11px] font-medium text-app-text-muted hover:text-app-text transition-colors"
        style={{ backgroundColor: "var(--app-surface-hover)" }}
                title="选择工程"
              >
                <svg className="block shrink-0 relative top-px" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                </svg>
                <span>{selectedWorkspace ? selectedWorkspace.split("/").pop() : "workspace"}</span>
                {selectedWorkspace && (
                  <span
                    onClick={(e) => { e.stopPropagation(); setSelectedWorkspace(null); }}
                    className="hover:text-red-400 cursor-pointer"
                  >×</span>
                )}
              </button>
              {showWorkspacePicker && (
                <div ref={workspacePickerRef} className="absolute left-0 bottom-full mb-2 p-1.5 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.12)] bg-app-bg min-w-[220px] z-50">
                  {getWorkspaceDirs().length === 0 ? (
                    <div className="px-3 py-2 text-[12px] text-app-text-muted">
                      暂无工作目录，请在 Workspace 中添加
                    </div>
                  ) : (
                    getWorkspaceDirs().map(d => (
                      <button
                        key={d.path}
                        onClick={() => {
                          setSelectedWorkspace(d.path);
                          setShowWorkspacePicker(false);
                        }}
                        className="w-full text-left px-3 py-2 text-[12px] hover:bg-app-surface-hover rounded-lg transition-colors text-app-text-secondary"
                        title={d.path}
                      >
                        📂 {d.name} <span className="text-app-text-muted ml-1">{d.path}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
              </div>
              <button
                onClick={handleDistill}
                disabled={distilling || !sessionId}
                className="inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[11px] font-medium text-app-text-muted hover:text-app-text disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                style={{ backgroundColor: "var(--app-surface-hover)" }}
                title="蒸馏本会话经验为 记忆/技能/工作流（等同 /distill）"
              >
                {distilling ? (
                  <svg className="animate-spin block shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                ) : (
                  <svg className="block shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 2v6.5L4.5 18a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 8.5V2"/><path d="M8 2h8"/><path d="M7 15h10"/>
                  </svg>
                )}
                <span>{distilling ? "蒸馏中" : "蒸馏"}</span>
              </button>
              {totalUsage && (totalUsage.resourcePoints > 0 || totalUsage.totalTokens > 0) && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-[2px] rounded-full text-[10px] font-medium text-app-text-muted"
                  style={{ backgroundColor: "var(--app-surface-hover)" }}
                  title={totalUsage.resourcePoints > 0
                    ? `本会话共消耗 ${totalUsage.resourcePoints} resource points`
                    : `本会话共消耗 ${totalUsage.totalTokens.toLocaleString()} tokens (↑${totalUsage.inputTokens.toLocaleString()} ↓${totalUsage.outputTokens.toLocaleString()})`}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                  </svg>
                  {totalUsage.resourcePoints > 0
                    ? `${totalUsage.resourcePoints} pts`
                    : `${totalUsage.totalTokens.toLocaleString()} tok`}
                </span>
              )}
              {!hasFullDiskAccess && (
                <button
                  onClick={requestFullDiskAccess}
                  className="inline-flex items-center gap-1 px-2.5 py-[3px] rounded-full text-[11px] font-medium text-yellow-600 hover:text-yellow-700 transition-colors"
                  style={{ backgroundColor: "rgba(234,179,8,0.1)" }}
                  title="授予完全磁盘访问权限，避免反复弹出权限确认"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
                  </svg>
                  <span>授权磁盘访问</span>
                </button>
              )}
            </div>
            {isProcessing && !input.trim() && attachments.length === 0 ? (
              <button onClick={onAbort}
                className="w-9 h-9 flex items-center justify-center rounded-full bg-app-text hover:opacity-80 transition-colors" title="停止">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-app-bg">
                  <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button onClick={handleSend} disabled={!input.trim() && attachments.length === 0}
                className="w-9 h-9 flex items-center justify-center bg-app-text disabled:bg-app-border disabled:cursor-not-allowed rounded-full transition-colors"
                title={isProcessing ? "加入队列（回答结束后自动发送）" : "发送"}>
                {isProcessing ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-app-bg">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/>
                    <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M8 12L8 4M8 4L4 8M8 4L12 8" stroke="currentColor" className="text-app-bg" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
            )}
          </div>
        </div>
        <p className="text-[11px] text-app-text-muted text-center mt-2">Nova 可能会犯错。请核查重要信息。</p>
      </div>
    </div>
  );
}

export default ChatInput;
