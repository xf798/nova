// ===== 侧边栏组件 =====

import { useMemo, useState, useRef, useEffect } from "react";
import { pluginRegistry } from "../plugins";
import type { ChatSession } from "../core/types";
import { MessageSquare, CheckSquare, Blocks, Plug, MoreVertical, Settings, MoreHorizontal, Pencil, Trash2, Pin, PinOff } from "lucide-react";

/** 侧边栏最多展示的导航项数（含预制的 4 个） */
const MAX_VISIBLE_ITEMS = 6;

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  order: number;
  onClick: () => void;
}

interface SidebarProps {
  currentPage: string;
  setCurrentPage: (page: string) => void;
  activeSessionId: string | null;
  sessions: ChatSession[];
  onNewChat: () => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onPinSession?: (id: string, pinned: boolean) => void;
  onRenameSession?: (id: string, newTitle: string) => void;
  onCollapse?: () => void;
}

export default function Sidebar({
  currentPage,
  setCurrentPage,
  activeSessionId,
  sessions,
  onNewChat,
  onSwitchSession,
  onDeleteSession,
  onPinSession,
  onRenameSession,
  onCollapse,
}: SidebarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭"更多"菜单
  useEffect(() => {
    if (!moreOpen) return;
    function handleClick(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [moreOpen]);

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return;
    function handleClick(e: MouseEvent) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [contextMenu]);

  // 构建导航项列表
  const { visibleItems, overflowItems } = useMemo(() => {
    // 1. 预制的 4 个选项（始终显示在外层，优先展示）
    const presetItems: NavItem[] = [
      { id: "__new_chat", label: "New Chat", icon: <MessageSquare size={16} />, order: 0, onClick: onNewChat },
      { id: "tasks", label: "Tasks", icon: <CheckSquare size={16} />, order: 1, onClick: () => setCurrentPage("tasks") },
      { id: "plugins", label: "Plugins", icon: <Blocks size={16} />, order: 2, onClick: () => setCurrentPage("plugins") },
      { id: "connectors", label: "Connectors", icon: <Plug size={16} />, order: 3, onClick: () => setCurrentPage("connectors") },
    ];

    // 2. 插件注册的侧边栏项（排除 memory）
    const pluginItems = pluginRegistry
      .getSidebarItems()
      .filter(item => item.id !== "memory")
      .map((item, index) => ({
        id: item.id,
        label: item.label,
        icon: item.icon,
        order: item.order ?? (100 + index), // 没有 order 的按添加顺序排在后面
        onClick: () => setCurrentPage(item.id),
      }));

    // 3. 其余选项按 order 排序
    const sortedPluginItems = [...pluginItems].sort((a, b) => a.order - b.order);

    // 4. 合并：预制选项 + 排序后的插件选项
    const allItems = [...presetItems, ...sortedPluginItems];

    // 5. 拆分：前 MAX_VISIBLE_ITEMS 个显示，其余放入"更多"
    const visible = allItems.slice(0, MAX_VISIBLE_ITEMS);
    const overflow = allItems.slice(MAX_VISIBLE_ITEMS);

    return { visibleItems: visible, overflowItems: overflow };
  }, [onNewChat, setCurrentPage]);

  const sortedSessions = useMemo(() => {
    return [...sessions]
      .sort((a, b) => {
        // 企微对话永远最优先
        const aIsWecom = a.id.startsWith("wecom-");
        const bIsWecom = b.id.startsWith("wecom-");
        if (aIsWecom && !bIsWecom) return -1;
        if (!aIsWecom && bIsWecom) return 1;
        // 其次手动置顶
        const aIsPinned = a.pinned || false;
        const bIsPinned = b.pinned || false;
        if (aIsPinned && !bIsPinned) return -1;
        if (!aIsPinned && bIsPinned) return 1;
        // 同类按创建时间排序，时间相同时用 id 稳定排序
        const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
  }, [sessions]);

  /** 判断某个导航项是否处于激活态 */
  function isActive(item: NavItem): boolean {
    if (item.id === "__new_chat") {
      return currentPage === "chat" && !sortedSessions.some(s => s.id === activeSessionId);
    }
    return currentPage === item.id;
  }

  return (
    <nav className="w-[260px] bg-app-surface flex flex-col h-full">
      {/* 顶部：拖拽区域 + 折叠按钮（与 macOS 窗口控制按钮垂直居中） */}
      <div className="h-14 shrink-0 relative" data-tauri-drag-region>
        {onCollapse && (
          <button
            onClick={onCollapse}
            className="absolute right-2 top-[3px] w-7 h-7 flex items-center justify-center rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
            title="折叠侧边栏"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>
            </svg>
          </button>
        )}
      </div>

      {/* 核心导航 */}
      <div className="px-2 space-y-0.5">
        {visibleItems.map(item => (
          <SidebarBtn
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={isActive(item)}
            onClick={item.onClick}
          />
        ))}

        {/* "更多"折叠菜单 */}
        {overflowItems.length > 0 && (
          <div className="relative" ref={moreRef}>
            <SidebarBtn
              icon={<MoreVertical size={16} />}
              label="更多"
              active={overflowItems.some(item => isActive(item))}
              onClick={() => setMoreOpen(prev => !prev)}
            />
            {moreOpen && (
              <div className="mt-1 mx-1 rounded-lg bg-app-surface-hover border border-app-border overflow-hidden shadow-lg animate-in fade-in slide-in-from-top-1 duration-150">
                <div className="py-1 space-y-0.5 px-1">
                  {overflowItems.map(item => (
                    <SidebarBtn
                      key={item.id}
                      icon={item.icon}
                      label={item.label}
                      active={isActive(item)}
                      onClick={() => {
                        item.onClick();
                        setMoreOpen(false);
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 历史会话 */}
      <div className="flex-1 min-h-0 overflow-y-auto mt-5 px-2">
        <div className="text-[11px] font-medium text-app-text-muted px-2 mb-2 uppercase tracking-wider">
          对话记录 ({sortedSessions.length})
        </div>
        {sortedSessions.length === 0 ? (
          <div className="text-xs text-app-text-muted px-2 py-4">暂无历史对话</div>
        ) : (
          <div className="space-y-0.5">
            {sortedSessions.map(s => {
              const isWecom = s.id.startsWith("wecom-");
              const isPinned = s.pinned || isWecom;
              const isDropdownOpen = contextMenu?.sessionId === s.id;

              return (
              <div key={s.id} className="relative group">
                {renamingId === s.id ? (
                  <div className="px-2.5 py-1.5">
                    <input
                      autoFocus
                      className="w-full px-2 py-1 rounded-md border border-app-border bg-app-bg text-[13px] text-app-text focus:outline-none focus:border-app-text-muted"
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") {
                          if (renameValue.trim() && onRenameSession) onRenameSession(s.id, renameValue.trim());
                          setRenamingId(null);
                        } else if (e.key === "Escape") {
                          setRenamingId(null);
                        }
                      }}
                      onBlur={() => {
                        if (renameValue.trim() && onRenameSession) onRenameSession(s.id, renameValue.trim());
                        setRenamingId(null);
                      }}
                    />
                  </div>
                ) : (
                <>
                <button
                  onClick={() => onSwitchSession(s.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg text-[13px] transition-colors flex items-center gap-2 pr-16 ${
                    s.id === activeSessionId && currentPage === "chat"
                      ? "bg-app-surface-hover text-app-text"
                      : "text-app-text-secondary hover:bg-app-surface-hover hover:text-app-text"
                  }`}
                  title={s.title}
                >
                  <span className="w-4 h-4 flex items-center justify-center shrink-0">
                    {isPinned ? (
                      <Pin size={14} className="text-app-text-secondary" style={{ transform: "rotate(45deg)" }} />
                    ) : (
                      <MessageSquare size={14} className="opacity-60" />
                    )}
                  </span>
                  <span className="truncate flex-1">{s.title}</span>
                </button>
                {/* Hover 操作区：置顶 + 更多（ChatGPT 风格） */}
                <div className={`absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 ${isDropdownOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"} transition-opacity`}>
                  {/* 置顶按钮（企微不可取消） */}
                  {!isWecom && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onPinSession?.(s.id, !isPinned); }}
                      className={`w-6 h-6 flex items-center justify-center rounded-md hover:text-app-text transition-colors ${isPinned ? "text-app-text-muted" : "text-app-text-secondary"}`}
                      title={isPinned ? "取消置顶" : "置顶"}
                      style={isPinned ? undefined : { transform: "rotate(45deg)" }}
                    >
                      {isPinned ? <PinOff size={16} /> : <Pin size={16} />}
                    </button>
                  )}
                  {/* 更多按钮（横向三点） */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isDropdownOpen) {
                        setContextMenu(null);
                      } else {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setContextMenu({ x: rect.right - 140, y: rect.bottom + 4, sessionId: s.id });
                      }
                    }}
                    className={`w-6 h-6 flex items-center justify-center rounded-md text-app-text-muted hover:text-app-text transition-colors ${isDropdownOpen ? "text-app-text" : ""}`}
                    title="更多"
                  >
                    <MoreHorizontal size={16} />
                  </button>
                </div>
                </>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 底部：Settings */}
      <div className="px-2 pb-3">
        <SidebarBtn icon={<Settings size={16} />} label="Settings" active={currentPage === "settings"} onClick={() => setCurrentPage("settings")} />
      </div>

      {/* 更多下拉菜单（ChatGPT 风格） */}
      {contextMenu && (() => {
        const s = sessions.find(sess => sess.id === contextMenu.sessionId);
        if (!s) return null;
        return (
          <div
            ref={contextMenuRef}
            className="fixed z-50 min-w-[160px] p-1.5 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.12)] bg-app-bg"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            {/* 重命名 */}
            <button
              className="w-full text-left px-3 py-2 text-[14px] text-app-text hover:bg-app-surface-hover rounded-lg transition-colors flex items-center gap-3"
              onClick={() => {
                setRenameValue(s.title);
                setRenamingId(s.id);
                setContextMenu(null);
              }}
            >
              <Pencil size={16} />
              Rename
            </button>
            {/* 删除 */}
            <button
              className="w-full text-left px-3 py-2 text-[14px] text-red-600 hover:bg-app-surface-hover rounded-lg transition-colors flex items-center gap-3"
              onClick={() => {
                onDeleteSession(s.id);
                setContextMenu(null);
              }}
            >
              <Trash2 size={16} />
              Delete
            </button>
          </div>
        );
      })()}
    </nav>
  );
}

function SidebarBtn({ icon, label, active, onClick }: {
  icon: React.ReactNode; label: string; active?: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] w-full text-left transition-colors ${
        active
          ? "bg-app-surface-hover text-app-text"
          : "text-app-text-secondary hover:bg-app-surface-hover hover:text-app-text"
      }`}
    >
      <span className="w-4 h-4 flex items-center justify-center shrink-0">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// ===== SVG 线条风格图标 =====

// Icons now provided by lucide-react
