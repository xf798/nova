import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../../App";
import { useSessionStore } from "../../core/sessionStore";
import { connectorInstances, connectorRegistry } from "../../connectors";
import { pendingModel } from "../../core/pendingModel";
import type { ModelInfo } from "../../connectors";

function ModelSelector() {
  const { activeConnector } = useAppStore();
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const sessionModelId = useSessionStore(s => {
    const session = s.sessions.find(sess => sess.id === s.activeSessionId);
    return session?.modelId;
  });

  const [isOpen, setIsOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  /** 无会话时选的模型（会话创建后由 ensureSession 落地），仅用于按钮回显 */
  const [pendingSelection, setPendingSelection] = useState<string | undefined>(() => pendingModel.get());
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 会话建好后暂存值已被消费，回显交回 session
  useEffect(() => {
    if (activeSessionId) setPendingSelection(undefined);
  }, [activeSessionId]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // 解析真正的对话后端。
  //
  // 企微会话的 connectorId 是 wecom-bot，而它只是消息通道
  // （supportsModelSwitch: false），实际回答由 cli/api 连接器生成
  // —— useWecomBridge 里有「bot 类型不能作为后端，回落到 cli」的逻辑。
  // 若按 wecom-bot 的能力判断，企微会话就永远看不到模型切换入口。
  const backend = (() => {
    const session = useSessionStore.getState().sessions.find(s => s.id === activeSessionId);
    const own = session?.connectorId ? connectorRegistry.get(session.connectorId) : null;
    // 会话自己的连接器能作为后端就用它，否则回落到全局活跃连接器
    if (own && own.config.type !== "bot" && own.config.enabled) return own;
    if (activeConnector.config.type !== "bot") return activeConnector;
    return connectorRegistry.getByType("cli")[0] ?? activeConnector;
  })();

  if (!backend.capabilities.supportsModelSwitch) return null;

  // 无会话时用暂存值回显，避免选了却显示 Auto
  const currentModel = sessionModelId || pendingSelection || "auto";

  const handleOpen = async () => {
    if (isOpen) { setIsOpen(false); return; }
    setIsOpen(true);
    if (models.length === 0) {
      setLoading(true);
      try {
        // 用真实后端列模型：wecom-bot 没有 listModels
        const result = await backend.listModels!();
        setModels(result.models);
      } catch {}
      setLoading(false);
    }
  };

  const handleSelect = (modelId: string) => {
    // 无 activeSessionId 的情况是「点了新对话但还没发消息」——会话是懒创建的。
    // 先暂存，等 ensureSession 创建会话时作为初始 modelId 落地，
    // 否则选择被直接丢弃，表现为点了没反应。
    if (!activeSessionId) {
      pendingModel.set(modelId);
      setPendingSelection(modelId);
      setIsOpen(false);
      return;
    }
    // 写入 session 持久化
    useSessionStore.getState().updateMeta(activeSessionId, { modelId });
    // 同时设置到当前 session 的 connector 实例（即时生效）
    const curSession = useSessionStore.getState().sessions.find(s => s.id === activeSessionId);
    const connId = curSession?.connectorId;
    const baseConn = connId ? connectorRegistry.get(connId) : null;
    // bot 类型不能作为后端实例的宿主，与 useWecomBridge 的解析保持一致
    const effectiveBase =
      baseConn && baseConn.config.enabled && baseConn.config.type !== "bot" ? baseConn : backend;
    const sessionConn = connectorInstances.get(activeSessionId, effectiveBase.config.id);
    if (sessionConn?.setModel) {
      sessionConn.setModel(modelId);
    }
    setIsOpen(false);
  };

  const displayName = currentModel === "auto" ? "Auto" : currentModel;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={handleOpen}
        className="inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[11px] font-medium text-app-text-muted hover:text-app-text-secondary transition-colors"
        style={{ backgroundColor: "var(--app-surface-hover)" }}
      >
        <svg className="block shrink-0 relative top-px" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="6"/>
          <path d="M5.5 8.5L7 10l3.5-4"/>
        </svg>
        <span>{displayName}</span>
        <svg className="block shrink-0 relative top-px" width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 3l2 2 2-2"/>
        </svg>
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-2 w-72 max-h-80 overflow-y-auto rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.12)] z-50 p-1.5"
          style={{ backgroundColor: "var(--app-bg)" }}>
          {loading ? (
            <div className="px-4 py-3 text-[12px] text-app-text-muted text-center">加载中...</div>
          ) : (
            <div className="py-1">
              {models.map((model) => (
                <button
                  key={model.model_id}
                  onClick={() => handleSelect(model.model_id)}
                  className={`w-full text-left px-3 py-2 hover:bg-app-surface-hover rounded-lg transition-colors ${
                    currentModel === model.model_id ? "bg-app-surface-hover" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] text-app-text font-medium">{model.model_name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-app-text-muted">{model.rate_multiplier}x</span>
                      {currentModel === model.model_id && (
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" className="text-green-500" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 8.5L7 11.5l5-7"/>
                        </svg>
                      )}
                    </div>
                  </div>
                  <p className="text-[11px] text-app-text-muted mt-0.5 leading-tight">{model.description}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ModelSelector;
