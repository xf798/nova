import type { ConnectorConfig } from "../../connectors";

function ConnectorCard({ config, status, cliCommandStatus, onCheck, onEdit, isEditing, isDefault, onSetDefault, children }: {
  config: ConnectorConfig;
  status: boolean | null | undefined;
  cliCommandStatus?: { resolution?: { command: string; source: string }; error?: string };
  onCheck: () => void;
  onEdit: () => void;
  isEditing?: boolean;
  isDefault?: boolean;
  onSetDefault?: () => void;
  children?: React.ReactNode;
}) {
  const typeLabel = config.type === "api" ? "API" : config.type === "bot" ? "BOT" : "CLI";
  const typeColor = config.type === "api" ? "bg-blue-500/10 text-blue-400" : config.type === "bot" ? "bg-purple-500/10 text-purple-400" : "bg-amber-500/10 text-amber-400";

  const platformLabel = config.botPlatform === "wecom" ? "企微" : config.botPlatform === "feishu" ? "飞书" : config.botPlatform === "dingtalk" ? "钉钉" : "";

  return (
    <div className="px-4 py-4 rounded-xl border border-app-border hover:border-app-text-muted transition-colors">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-app-surface-hover flex items-center justify-center">
            {config.type === "bot" ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-app-text-muted" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="10" rx="2"/>
                <circle cx="12" cy="5" r="2"/>
                <path d="M12 7v4"/>
                <circle cx="8" cy="16" r="1.5" fill="currentColor" stroke="none"/>
                <circle cx="16" cy="16" r="1.5" fill="currentColor" stroke="none"/>
              </svg>
            ) : config.type === "cli" ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-app-text-muted" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5"/>
                <line x1="12" y1="19" x2="20" y2="19"/>
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-app-text-muted" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a5 5 0 015 5v3H7V7a5 5 0 015-5z"/>
                <rect x="3" y="10" width="18" height="12" rx="2"/>
                <circle cx="12" cy="16" r="2"/>
              </svg>
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-app-text">{config.type === "bot" && config.botName ? config.botName : config.name}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${typeColor}`}>{typeLabel}</span>
              {config.type === "bot" && platformLabel && (
                <span className="text-[10px] px-1.5 py-0.5 bg-purple-500/5 text-purple-300 rounded-full font-medium">{platformLabel}</span>
              )}
              {config.enabled && (
                <span className="text-[10px] px-1.5 py-0.5 bg-[#10a37f]/10 text-[#10a37f] rounded-full font-medium">启用</span>
              )}
            </div>
            <p className="text-[12px] text-app-text-muted mt-0.5">
              {config.description || (config.type === "api" ? config.apiEndpoint : config.type === "bot" ? `${platformLabel}机器人` : "Kiro CLI 本地连接器")}
            </p>
            <p className="text-[11px] text-app-text-muted mt-0.5 font-mono">
              {config.type === "api"
                ? `${config.apiEndpoint} · ${config.model || "default"}`
                : config.type === "bot"
                ? `${config.botId ? config.botId.slice(0, 12) + "..." : "未配置"}`
                : `${config.command || "自动探测 kiro-cli"} ${(config.defaultArgs || []).slice(0, 3).join(" ")}${(config.defaultArgs || []).length > 3 ? "..." : ""}`
              }
            </p>
            {config.type === "cli" && cliCommandStatus?.resolution && (
              <p className="text-[10px] text-[#10a37f] mt-0.5 font-mono break-all">
                {cliCommandStatus.resolution.source === "configured" ? "指定" : "已自动检测"}: {cliCommandStatus.resolution.command}
              </p>
            )}
            {config.type === "cli" && cliCommandStatus?.error && (
              <p className="text-[10px] text-red-500 mt-1 break-all whitespace-pre-line leading-relaxed">{cliCommandStatus.error}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isDefault && <span className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-blue-500/10 text-blue-500">默认</span>}
          {!isDefault && onSetDefault && config.type !== "bot" && (
            <button onClick={onSetDefault}
              className="px-2 py-1 text-[11px] rounded-lg text-app-text-muted hover:text-blue-500 hover:bg-blue-500/10 transition-colors">
              设为默认
            </button>
          )}
          {status === true && <span className="w-2 h-2 bg-green-500 rounded-full"></span>}
          {status === false && <span className="w-2 h-2 bg-red-500 rounded-full"></span>}
          {status === null && <span className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse"></span>}
          <button onClick={onEdit}
            className="px-3 py-1.5 text-[12px] rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors">
            {isEditing ? "收起" : "编辑"}
          </button>
          <button onClick={onCheck}
            className="px-3 py-1.5 text-[12px] rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors">
            检测
          </button>
        </div>
      </div>
      {/* 卡片内展开区域 */}
      {isEditing && children && (
        <div className="mt-3 border-t border-app-border pt-3 space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}

export default ConnectorCard;
