import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../../App";
import { useSessionStore } from "../../core/sessionStore";
import { connectorInstances, connectorRegistry } from "../../connectors";
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
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  if (!activeConnector.capabilities.supportsModelSwitch) return null;

  const currentModel = sessionModelId || "auto";

  const handleOpen = async () => {
    if (isOpen) { setIsOpen(false); return; }
    setIsOpen(true);
    if (models.length === 0) {
      setLoading(true);
      try {
        const result = await activeConnector.listModels!();
        setModels(result.models);
      } catch {}
      setLoading(false);
    }
  };

  const handleSelect = (modelId: string) => {
    if (!activeSessionId) return;
    // 写入 session 持久化
    useSessionStore.getState().updateMeta(activeSessionId, { modelId });
    // 同时设置到当前 session 的 connector 实例（即时生效）
    const curSession = useSessionStore.getState().sessions.find(s => s.id === activeSessionId);
    const connId = curSession?.connectorId;
    const baseConn = connId ? connectorRegistry.get(connId) : null;
    const effectiveBase = (baseConn && baseConn.config.enabled) ? baseConn : activeConnector;
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
