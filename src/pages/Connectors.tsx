import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { connectorRegistry, persistApiConnectors, connectorInstances } from "../connectors";
import { persistCliConnectorConfigs } from "../connectors/cli-storage";
import type { KiroCliCommandResolution } from "../connectors/kiro-cli-command";
import { KiroCliConnector, OpenAIConnector, WeComBotConnector } from "../connectors";
import { loadPersistedApiConnectors } from "../connectors/api-storage";
import type { ConnectorConfig, ConnectorType } from "../connectors";
import { useSessionStore } from "../core/sessionStore";
import { DEFAULT_WECOM_POLICY, parseWecomPolicy } from "../core/wecomPolicy";
import ConnectorCard from "./connectors/ConnectorCard";
import {
  ApiForm, CliForm, BotForm, ModeSelector,
  type ApiFormData, type CliFormData, type BotFormData,
} from "./connectors/ConnectorForm";

type AddMode = "api" | "cli" | "bot";

// ─── 默认表单值 ───

const defaultApiForm: ApiFormData = { id: "", name: "", endpoint: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o", description: "" };
const defaultCliForm: CliFormData = {
  id: "",
  name: "",
  command: "",
  args: "acp --agent-engine v2 --trust-all-tools",
  cwd: "",
  description: "",
};
const defaultBotForm: BotFormData = { name: "", platform: "wecom", botId: "", secret: "", autoConnect: true, policy: { ...DEFAULT_WECOM_POLICY } };

type CliCommandResolver = {
  resolveCommand(force?: boolean): Promise<KiroCliCommandResolution>;
  resetProcess?(): Promise<void>;
};

/**
 * 按能力判断而非 instanceof。
 *
 * Vite HMR 重载 kiro-cli 模块后类标识会变，instanceof 失配会静默跳过
 * 强制重解析，让改错的命令仍复用旧解析结果显示「检测通过」。
 */
function asCommandResolver(connector: unknown): CliCommandResolver | null {
  const candidate = connector as CliCommandResolver | null;
  return candidate && typeof candidate.resolveCommand === "function" ? candidate : null;
}

function ConnectorsPage() {
  const [, setTick] = useState(0);
  const connectors = connectorRegistry.getAll().filter(c => !c.config.internal);
  const [defaultConnectorId, setDefaultConnectorId] = useState<string>("kiro-cli");

  // 加载默认连接器配置
  useEffect(() => {
    invoke<any>("get_config").then(config => {
      if (config?.defaultConnectorId) {
        setDefaultConnectorId(config.defaultConnectorId);
      }
    }).catch(() => {});
  }, []);

  const handleSetDefault = async (id: string) => {
    setDefaultConnectorId(id);
    try {
      await invoke("save_config", { config: { defaultConnectorId: id } });
    } catch (e) {
      console.warn("[Connectors] 保存默认连接器失败:", e);
    }
  };

  // 页面挂载时同步文件中的 API 连接器
  useEffect(() => {
    loadPersistedApiConnectors().then(() => setTick(t => t + 1));
  }, []);

  const [healthStatus, setHealthStatus] = useState<Record<string, boolean | null>>({});
  const [cliCommandStatus, setCliCommandStatus] = useState<Record<string, { resolution?: KiroCliCommandResolution; error?: string }>>({});
  const cliConfigSignature = connectors
    .filter(connector => connector.config.type === "cli")
    .map(connector => `${connector.config.id}:${connector.config.command || ""}`)
    .join("|");

  useEffect(() => {
    for (const connector of connectors) {
      const resolver = asCommandResolver(connector);
      if (!resolver || connector.config.type !== "cli") continue;
      resolver.resolveCommand().then(resolution => {
        setCliCommandStatus(previous => ({ ...previous, [connector.config.id]: { resolution } }));
      }).catch(error => {
        setCliCommandStatus(previous => ({
          ...previous,
          [connector.config.id]: { error: error?.message || String(error) },
        }));
      });
    }
    // connectors 来自 registry，签名用于在新增或修改命令后重新探测。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cliConfigSignature]);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>("api");

  // 新增表单
  const [apiForm, setApiForm] = useState<ApiFormData>(defaultApiForm);
  const [cliForm, setCliForm] = useState<CliFormData>(defaultCliForm);
  const [botForm, setBotForm] = useState<BotFormData>(defaultBotForm);

  // 编辑态
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editApiForm, setEditApiForm] = useState<ApiFormData>({ id: "", name: "", endpoint: "", apiKey: "", model: "", description: "" });
  const [editCliForm, setEditCliForm] = useState<CliFormData>({ id: "", name: "", command: "", args: "", cwd: "", description: "" });
  const [editBotForm, setEditBotForm] = useState<BotFormData>({ ...defaultBotForm });

  // Bot 连接状态
  useEffect(() => {
    const bots = connectorRegistry.getBotConnectors();
    if (bots.length > 0) {
      const bot = bots[0];
      bot.onStatusChange(() => setTick(t => t + 1));
    }
  }, []);

  // ─── 操作 ───

  const checkHealth = async (id: string) => {
    const connector = connectorRegistry.get(id);
    if (!connector) return;
    setHealthStatus(prev => ({ ...prev, [id]: null }));

    // 检测必须验证用户眼前填的值。
    //
    // 命令输入框在展开的编辑区，而「检测」在卡片头部：只读已保存配置时，
    // 用户改了地址还没保存就点检测，验证的是旧配置，错误地址也会显示通过。
    const resolver = asCommandResolver(connector);
    const editing = resolver && editingId === id && editCliForm.id === id;
    const savedCommand = connector.config.command || "";
    const pendingCommand = editing ? editCliForm.command.trim() : savedCommand;
    const usePending = pendingCommand !== savedCommand;
    if (usePending) connector.config.command = pendingCommand;

    try {
      if (resolver) {
        try {
          const resolution = await resolver.resolveCommand(true);
          setCliCommandStatus(previous => ({ ...previous, [id]: { resolution } }));
        } catch (error: any) {
          setCliCommandStatus(previous => ({ ...previous, [id]: { error: error?.message || String(error) } }));
          setHealthStatus(prev => ({ ...prev, [id]: false }));
          return;
        }
      }
      const ok = await connector.healthCheck();
      setHealthStatus(prev => ({ ...prev, [id]: ok }));
    } finally {
      // 检测不代表保存：验证完还原配置，并清掉按待验证命令建立的解析缓存
      if (usePending) {
        connector.config.command = savedCommand;
        await resolver?.resetProcess?.().catch(() => {});
      }
    }
  };

  const handleAddApi = () => {
    if (!apiForm.id || !apiForm.name || !apiForm.endpoint || !apiForm.apiKey) return;
    connectorRegistry.register(new OpenAIConnector({
      id: apiForm.id, name: apiForm.name, apiEndpoint: apiForm.endpoint,
      apiKey: apiForm.apiKey, model: apiForm.model, description: apiForm.description || undefined, enabled: true,
    }));
    persistApiConnectors();
    setShowAddForm(false);
    setApiForm(defaultApiForm);
    setTick(t => t + 1);
  };

  const handleAddCli = async () => {
    if (!cliForm.id || !cliForm.name) return;
    const config: Partial<ConnectorConfig> = {
      id: cliForm.id,
      name: cliForm.name,
      type: "cli" as ConnectorType,
      command: cliForm.command.trim(),
      defaultArgs: cliForm.args.split(/\s+/).filter(Boolean),
      cwd: cliForm.cwd.trim() || undefined,
      description: cliForm.description || undefined,
      enabled: true,
    };
    connectorRegistry.register(new KiroCliConnector(config));
    await persistCliConnectorConfigs(connectorRegistry.getConfigs());
    setShowAddForm(false);
    setCliForm(defaultCliForm);
    setTick(t => t + 1);
  };

  const handleAddBot = async () => {
    if (!botForm.botId || !botForm.secret) return;
    const bots = connectorRegistry.getBotConnectors();
    let bot: WeComBotConnector;
    if (bots.length > 0) {
      bot = bots[0];
      await bot.updateConfig({
        botPlatform: botForm.platform, botId: botForm.botId, botSecret: botForm.secret,
        botName: botForm.name, autoConnect: botForm.autoConnect, wecomPolicy: botForm.policy,
      });
    } else {
      bot = new WeComBotConnector({
        botPlatform: botForm.platform, botId: botForm.botId, botSecret: botForm.secret,
        botName: botForm.name, autoConnect: botForm.autoConnect, wecomPolicy: botForm.policy,
      });
      connectorRegistry.register(bot);
      await bot.persistConfig();
    }
    syncWecomSessionTitles(botForm.name);
    setTick(t => t + 1);
    if (bot.config.botId && bot.config.botSecret && bot.status !== "connected" && bot.status !== "connecting") {
      try { await bot.connect(); } catch (e: any) { console.error("[Bot] 自动连接失败:", e); }
    }
  };

  // ─── 编辑操作 ───

  const startEdit = (id: string) => {
    const connector = connectorRegistry.get(id);
    if (!connector) return;
    const cfg = connector.config;
    if (cfg.type === "api") {
      setEditApiForm({ id: cfg.id, name: cfg.name, endpoint: cfg.apiEndpoint || "", apiKey: cfg.apiKey || "", model: cfg.model || "", description: cfg.description || "" });
    } else if (cfg.type === "cli") {
      setEditCliForm({ id: cfg.id, name: cfg.name, command: cfg.command || "", args: (cfg.defaultArgs || []).join(" "), cwd: cfg.cwd || "", description: cfg.description || "" });
    } else if (cfg.type === "bot") {
      setEditBotForm({ name: cfg.botName || "", platform: cfg.botPlatform || "wecom", botId: cfg.botId || "", secret: cfg.botSecret || "", autoConnect: cfg.autoConnect ?? true, policy: parseWecomPolicy(cfg.wecomPolicy) });
    }
    setEditingId(id);
  };

  const cancelEdit = () => setEditingId(null);

  const handleSaveEditApi = () => {
    if (!editApiForm.name || !editApiForm.endpoint || !editApiForm.apiKey) return;
    const connector = connectorRegistry.get(editApiForm.id);
    if (connector) {
      connector.config.name = editApiForm.name;
      connector.config.apiEndpoint = editApiForm.endpoint;
      connector.config.apiKey = editApiForm.apiKey;
      connector.config.model = editApiForm.model;
      connector.config.description = editApiForm.description || undefined;
    }
    persistApiConnectors();
    setEditingId(null);
    setTick(t => t + 1);
  };

  const handleSaveEditCli = async () => {
    if (!editCliForm.name) return;
    const connector = connectorRegistry.get(editCliForm.id);
    if (connector) {
      const cfg = connector.config;
      const newCommand = editCliForm.command.trim();
      const newCwd = editCliForm.cwd.trim() || undefined;
      const newArgs = editCliForm.args.split(/\s+/).filter(Boolean);
      const needReset = (cfg.command || "") !== newCommand
        || cfg.cwd !== newCwd
        || JSON.stringify(cfg.defaultArgs || []) !== JSON.stringify(newArgs);
      cfg.name = editCliForm.name;
      cfg.command = newCommand;
      cfg.defaultArgs = newArgs;
      cfg.cwd = newCwd;
      cfg.description = editCliForm.description || undefined;
      const resolver = asCommandResolver(connector);
      if (needReset && resolver) {
        try {
          await resolver.resetProcess?.();
          await connectorInstances.disposeByConnectorId(cfg.id);
          const resolution = await resolver.resolveCommand(true);
          setCliCommandStatus(previous => ({ ...previous, [cfg.id]: { resolution } }));
        } catch (error: any) {
          setCliCommandStatus(previous => ({
            ...previous,
            [cfg.id]: { error: error?.message || String(error) },
          }));
        }
      }
      await persistCliConnectorConfigs(connectorRegistry.getConfigs());
    }
    setEditingId(null);
    setTick(t => t + 1);
  };

  const handleSaveEditBot = async () => {
    if (!editBotForm.botId || !editBotForm.secret) return;
    const bots = connectorRegistry.getBotConnectors();
    if (bots.length > 0) {
      const bot = bots[0];
      const needReconnect = bot.config.botId !== editBotForm.botId || bot.config.botSecret !== editBotForm.secret;
      await bot.updateConfig({
        botPlatform: editBotForm.platform, botId: editBotForm.botId, botSecret: editBotForm.secret,
        botName: editBotForm.name, autoConnect: editBotForm.autoConnect, wecomPolicy: editBotForm.policy,
      });
      syncWecomSessionTitles(editBotForm.name);
      if (needReconnect && (bot.status === "connected" || bot.status === "connecting")) {
        try { await bot.disconnect(); await bot.connect(); } catch (e: any) { console.error("[Bot] 重连失败:", e); }
      }
    }
    setEditingId(null);
    setTick(t => t + 1);
  };

  // ─── 渲染 ───

  return (
    <div className="max-w-3xl mx-auto w-full">
      <div className="flex items-center justify-between mb-8">
        <h2 className="text-xl font-semibold">Connectors</h2>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="px-3.5 py-2 rounded-full text-[13px] font-medium border border-app-border text-app-text-secondary hover:border-app-text-muted hover:text-app-text transition-colors"
        >
          {showAddForm ? "取消" : "+ 添加连接器"}
        </button>
      </div>

      <p className="text-[13px] text-app-text-muted mb-6">
        连接器是 Nova 与外部系统交互的桥梁。支持 AI 模型（API / CLI）和 IM 机器人（企微 / 飞书 / 钉钉）。
      </p>

      {/* 添加表单 */}
      {showAddForm && (
        <div className="mb-6 px-4 py-4 rounded-xl border border-app-border space-y-4">
          <ModeSelector mode={addMode} onModeChange={setAddMode} />
          {addMode === "api" && <ApiForm data={apiForm} onChange={setApiForm} onSubmit={handleAddApi} />}
          {addMode === "cli" && <CliForm data={cliForm} onChange={setCliForm} onSubmit={handleAddCli} />}
          {addMode === "bot" && <BotForm data={botForm} onChange={setBotForm} onSubmit={handleAddBot} />}
        </div>
      )}

      {/* 连接器列表 */}
      <div className="space-y-3">
        {connectors.map(c => (
          <ConnectorCard
            key={c.config.id}
            config={c.config}
            status={healthStatus[c.config.id]}
            cliCommandStatus={c.config.type === "cli" ? cliCommandStatus[c.config.id] : undefined}
            onCheck={() => checkHealth(c.config.id)}
            onEdit={() => editingId === c.config.id ? cancelEdit() : startEdit(c.config.id)}
            isEditing={editingId === c.config.id}
            isDefault={c.config.id === defaultConnectorId}
            onSetDefault={() => handleSetDefault(c.config.id)}
          >
            {c.config.type === "api" && (
              <ApiForm data={editApiForm} onChange={setEditApiForm} onSubmit={handleSaveEditApi} onCancel={cancelEdit} isEdit />
            )}
            {c.config.type === "cli" && (
              <CliForm data={editCliForm} onChange={setEditCliForm} onSubmit={handleSaveEditCli} onCancel={cancelEdit} isEdit />
            )}
            {c.config.type === "bot" && (
              <BotForm data={editBotForm} onChange={setEditBotForm} onSubmit={handleSaveEditBot} onCancel={cancelEdit} isEdit submitLabel="保存" />
            )}
          </ConnectorCard>
        ))}
      </div>

      {connectors.length === 0 && (
        <div className="text-center py-20 text-app-text-muted">
          <p className="text-base mb-2">暂无连接器</p>
          <p className="text-sm">点击「添加连接器」开始配置</p>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ───

function syncWecomSessionTitles(botName: string) {
  const newBotLabel = botName ? `企微-${botName}` : "企微";
  const { sessions } = useSessionStore.getState();
  sessions.forEach(s => {
    if (!s.id.startsWith("wecom-")) return;
    const chatLabel = s.title.replace(/^\[[^\]]*\]\s*/, "");
    const newTitle = `[${newBotLabel}] ${chatLabel}`;
    if (s.title !== newTitle) {
      useSessionStore.getState().updateMeta(s.id, { title: newTitle });
    }
  });
}

export default ConnectorsPage;
