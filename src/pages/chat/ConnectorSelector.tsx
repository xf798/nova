import { useAppStore } from "../../App";
import { connectorRegistry } from "../../connectors";
import { useSessionStore } from "../../core/sessionStore";
import { pendingModel } from "../../core/pendingModel";

function ConnectorSelector() {
  const { activeConnector, setActiveConnectorId } = useAppStore();
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const connectors = connectorRegistry.getEnabled().filter(c => c.config.type !== "bot");

  const handleSwitch = (id: string) => {
    if (id === activeConnector.config.id) return;
    setActiveConnectorId(id);
    // 同步更新当前会话的 connectorId，并清掉已选模型。
    //
    // modelId 是上一个连接器的模型（如 kiro-cli 的 claude-sonnet-5），
    // 在新连接器里不存在。留着会有两个后果：模型选择器回显一个不属于
    // 当前连接器的名字，发送时还会把它 setModel 给新连接器。
    // 回落到 Auto 最可预期，让用户重新选。
    if (activeSessionId) {
      useSessionStore.getState().updateMeta(activeSessionId, { connectorId: id, modelId: undefined });
    }
    // 无会话时选择暂存在 pendingModel 里，同样属于旧连接器
    pendingModel.clear();
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
