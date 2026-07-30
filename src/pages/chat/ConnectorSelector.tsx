import { useAppStore } from "../../App";
import { connectorRegistry } from "../../connectors";
import { useSessionStore } from "../../core/sessionStore";

function ConnectorSelector() {
  const { activeConnector, setActiveConnectorId } = useAppStore();
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const connectors = connectorRegistry.getEnabled().filter(c => c.config.type !== "bot");

  const handleSwitch = (id: string) => {
    setActiveConnectorId(id);
    // 同步更新当前会话的 connectorId
    if (activeSessionId) {
      useSessionStore.getState().updateMeta(activeSessionId, { connectorId: id });
    }
  };

  if (connectors.length <= 1) {
    return (
      <div className="inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[11px] font-medium text-app-text-muted" style={{ backgroundColor: "var(--app-surface-hover)" }}>
        {activeConnector.config.icon && <span>{activeConnector.config.icon}</span>}
        <span>{activeConnector.config.name}</span>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-0.5 rounded-full py-[3px] px-[3px]" style={{ backgroundColor: "var(--app-surface-hover)" }}>
      {connectors.map(c => (
        <button key={c.config.id} onClick={() => handleSwitch(c.config.id)}
          className={`px-2.5 py-[3px] rounded-full text-[11px] font-medium transition-all ${
            activeConnector.config.id === c.config.id ? "bg-app-bg text-app-text shadow-sm" : "text-app-text-muted hover:text-app-text-secondary"
          }`}>
          {c.config.icon ? `${c.config.icon} ` : ""}{c.config.name}
        </button>
      ))}
    </div>
  );
}

export default ConnectorSelector;
