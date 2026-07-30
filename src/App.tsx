import { useState, useEffect, useRef, createContext, useContext } from "react";
import { invoke } from "@tauri-apps/api/core";
import Sidebar from "./shell/Sidebar";
import MainContent from "./shell/MainContent";
import PreviewPanel from "./shell/PreviewPanel";
import { connectorRegistry, disposeAllConnectors } from "./connectors";
import type { Connector } from "./connectors";
import { setNotificationHandler } from "./plugins";
import { useSessionStore } from "./core/sessionStore";
import { useNovaTools } from "./hooks/useNovaTools";
import { useMcpBridge } from "./hooks/useMcpBridge";
import { useWecomBridge } from "./hooks/useWecomBridge";
import { useNovaInit } from "./hooks/useNovaInit";

// ─── 全局 Context（非 session 状态） ───

interface AppContextType {
  activeConnector: Connector;
  setActiveConnectorId: (id: string) => void;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  navigateTo: (page: string) => void;
  previewPanel: { type: 'image' | 'memories' | 'file' | 'distill'; data: any } | null;
  setPreviewPanel: (panel: { type: 'image' | 'memories' | 'file' | 'distill'; data: any } | null) => void;
  addAttachment?: (path: string) => void;
  hasFullDiskAccess: boolean;
  requestFullDiskAccess: () => void;
}
export const AppContext = createContext<AppContextType | null>(null);
export const useAppStore = () => useContext(AppContext)!;

// ─── App ───

function App() {
  const [currentPage, setCurrentPage] = useState<string>("chat");
  const [activeConnectorId, setActiveConnectorId] = useState<string>("kiro-cli");
  const [theme, setThemeState] = useState<"dark" | "light">("light");
  const [hasFullDiskAccess, setHasFullDiskAccess] = useState(true);
  const [notification, setNotification] = useState<{ msg: string; type: string } | null>(null);
  const [previewPanel, setPreviewPanel] = useState<{ type: 'image' | 'memories' | 'file' | 'distill'; data: any } | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const deletedSessionIdsRef = useRef<Set<string>>(new Set());

  // zustand store — session 状态的单一真相源
  const sessions = useSessionStore(s => s.sessions);
  const activeSessionId = useSessionStore(s => s.activeSessionId);

  const activeConnector = connectorRegistry.get(activeConnectorId) || connectorRegistry.getEnabled()[0];

  const activeConnectorRef = useRef(activeConnector);
  activeConnectorRef.current = activeConnector;

  // 注册通知处理器
  useEffect(() => {
    setNotificationHandler((message, type) => {
      setNotification({ msg: message, type });
      setTimeout(() => setNotification(null), 3000);
    });
  }, []);

  // 注册 Nova 内置 actions
  useNovaTools({ activeConnectorRef, setCurrentPage, setActiveConnectorId, setNotification });

  // 监听外部插件的 PreviewPanel 打开事件
  useEffect(() => {
    const handler = (e: Event) => {
      const { type, data } = (e as CustomEvent).detail || {};
      if (type && data) setPreviewPanel({ type, data });
    };
    window.addEventListener("nova-open-preview", handler);
    return () => window.removeEventListener("nova-open-preview", handler);
  }, []);

  // 监听通用 toast 事件（供命令/蒸馏等使用）
  useEffect(() => {
    const handler = (e: Event) => {
      const { msg, type } = (e as CustomEvent).detail || {};
      if (!msg) return;
      setNotification({ msg, type: type || "info" });
      setTimeout(() => setNotification(null), 3000);
    };
    window.addEventListener("nova-notify", handler);
    return () => window.removeEventListener("nova-notify", handler);
  }, []);

  // MCP Server 桥接
  useMcpBridge();

  // 主题
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark", "light");
    root.classList.add(theme);
    localStorage.setItem("nova-theme", theme);
  }, [theme]);

  const setTheme = (t: "dark" | "light") => setThemeState(t);

  // 加载历史 + 插件 + 同步 skills + 自动连接企微
  useNovaInit({ activeConnectorId, setHasFullDiskAccess });

  // ─── 应用退出时清理子进程 ───
  useEffect(() => {
    const cleanup = () => {
      console.log(`[Nova:Cleanup] 🧹 清理连接器子进程...`);
      disposeAllConnectors();
    };
    window.addEventListener("beforeunload", cleanup);
    return () => {
      window.removeEventListener("beforeunload", cleanup);
      disposeAllConnectors();
    };
  }, []);

  // 切换会话时，同步该会话绑定的 connectorId 到全局 UI 显示
  useEffect(() => {
    if (!activeSessionId) return;
    const session = sessions.find(s => s.id === activeSessionId);
    if (session?.connectorId && session.connectorId !== activeConnectorId) {
      // 确认该连接器仍然存在且启用
      const conn = connectorRegistry.get(session.connectorId);
      if (conn && conn.config.enabled) {
        setActiveConnectorId(session.connectorId);
      }
    }
  }, [activeSessionId]);

  // 默认连接器：从 config 读取，fallback 到第一个非 bot 的启用连接器
  const [defaultConnectorId, setDefaultConnectorId] = useState<string>(
    connectorRegistry.getEnabled().filter(c => c.config.type !== "bot")[0]?.config.id || "kiro-cli"
  );

  useEffect(() => {
    invoke<any>("get_config").then(config => {
      if (config?.defaultConnectorId) {
        setDefaultConnectorId(config.defaultConnectorId);
      }
    }).catch(() => {});
  }, []);

  const handleNewChat = () => {
    useSessionStore.getState().setActiveSessionId(null);
    setActiveConnectorId(defaultConnectorId);
    setCurrentPage("chat");
  };

  const handleSwitchSession = (sessionId: string) => {
    useSessionStore.getState().switchSession(sessionId);
    setCurrentPage("chat");
  };

  const handleDeleteSession = (sessionId: string) => {
    deletedSessionIdsRef.current.add(sessionId);
    useSessionStore.getState().deleteSession(sessionId).catch(e => console.warn("[DeleteSession] 删除失败:", e));
  };

  // 企微机器人消息桥接
  useWecomBridge({ activeConnectorRef });

  if (!activeConnector) {
    return (
      <div className="flex h-screen items-center justify-center bg-app-bg text-app-text">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-app-border border-t-app-text rounded-full mx-auto mb-4" />
          <p className="text-sm text-app-text-muted">初始化中...</p>
        </div>
      </div>
    );
  }

  return (
    <AppContext.Provider value={{ activeConnector: activeConnector!, setActiveConnectorId, theme, setTheme, navigateTo: setCurrentPage, previewPanel, setPreviewPanel, addAttachment: (path: string) => { window.dispatchEvent(new CustomEvent("nova-add-attachment", { detail: path })); }, hasFullDiskAccess, requestFullDiskAccess: () => { invoke("open_full_disk_access_settings"); } }}>
      <div className="flex h-screen bg-app-bg text-app-text">
        {!sidebarCollapsed && (
        <Sidebar
          currentPage={currentPage}
          setCurrentPage={setCurrentPage}
          activeSessionId={activeSessionId}
          sessions={sessions}
          onNewChat={handleNewChat}
          onSwitchSession={handleSwitchSession}
          onDeleteSession={handleDeleteSession}
          onPinSession={(id, pinned) => {
            useSessionStore.getState().updateMeta(id, { pinned });
          }}
          onRenameSession={(id, newTitle) => {
            useSessionStore.getState().updateMeta(id, { title: newTitle });
          }}
          onCollapse={() => setSidebarCollapsed(true)}
        />
        )}
        <main className="flex-1 overflow-hidden relative">
          {sidebarCollapsed && (
            <button
              onClick={() => setSidebarCollapsed(false)}
              className="absolute top-[3px] left-[76px] z-10 w-7 h-7 flex items-center justify-center rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
              title="展开侧边栏"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>
              </svg>
            </button>
          )}
          <MainContent currentPage={currentPage} />
        </main>
        {previewPanel && <PreviewPanel />}
      </div>

      {/* Toast 通知 */}
      {notification && (
        <div className={`fixed top-4 right-4 px-4 py-2.5 rounded-xl text-sm shadow-lg z-50 animate-fade-in ${
          notification.type === "error" ? "bg-red-500 text-white" :
          notification.type === "success" ? "bg-green-600 text-white" :
          "bg-app-surface border border-app-border text-app-text"
        }`}>
          {notification.msg}
        </div>
      )}
    </AppContext.Provider>
  );
}

export default App;
