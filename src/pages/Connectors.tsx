import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { connectorRegistry, persistApiConnectors } from "../connectors";
import { KiroCliConnector, OpenAIConnector, WeComBotConnector } from "../connectors";
import { loadPersistedApiConnectors } from "../connectors/api-storage";
import type { ConnectorConfig, ConnectorType } from "../connectors";
import { useSessionStore } from "../core/sessionStore";
import ConnectorCard from "./connectors/ConnectorCard";
import {
  ApiForm, CliForm, BotForm, ModeSelector,
  type ApiFormData, type CliFormData, type BotFormData,
} from "./connectors/ConnectorForm";

type AddMode = "api" | "cli" | "bot";

// ─── 默认表单值 ───

const defaultApiForm: ApiFormData = { id: "", name: "", endpoint: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o", description: "" };
const defaultCliForm: CliFormData = { id: "", name: "", command: "", args: "", cwd: "/Users/wangxf/workspace", description: "" };
const defaultBotForm: BotFormData = { name: "", platform: "wecom", botId: "", secret: "", autoConnect: true };

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
  const [editBotForm, setEditBotForm] = useState<BotFormData>({ name: "", platform: "wecom", botId: "", secret: "", autoConnect: true });

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
    const ok = await connector.healthCheck();
    setHealthStatus(prev => ({ ...prev, [id]: ok }));
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

  const handleAddCli = () => {
    if (!cliForm.id || !cliForm.name || !cliForm.command) return;
    const config: Partial<ConnectorConfig> = {
      id: cliForm.id, name: cliForm.name, type: "cli" as ConnectorType,
      command: cliForm.command, defaultArgs: cliForm.args.split(/\s+/).filter(Boolean),
      cwd: cliForm.cwd || undefined, description: cliForm.description || undefined, enabled: true,
    };
    connectorRegistry.register(new KiroCliConnector(config));
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
        botName: botForm.name, autoConnect: botForm.autoConnect,
      });
    } else {
      bot = new WeComBotConnector({
        botPlatform: botForm.platform, botId: botForm.botId, botSecret: botForm.secret,
        botName: botForm.name, autoConnect: botForm.autoConnect,
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
      setEditBotForm({ name: cfg.botName || "", platform: cfg.botPlatform || "wecom", botId: cfg.botId || "", secret: cfg.botSecret || "", autoConnect: cfg.autoConnect ?? true });
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
    if (!editCliForm.name || !editCliForm.command) return;
    const connector = connectorRegistry.get(editCliForm.id);
    if (connector) {
      const cfg = connector.config;
      const newArgs = editCliForm.args.split(/\s+/).filter(Boolean);
      const needReset = cfg.command !== editCliForm.command
        || cfg.cwd !== (editCliForm.cwd || undefined)
        || JSON.stringify(cfg.defaultArgs || []) !== JSON.stringify(newArgs);
      cfg.name = editCliForm.name;
      cfg.command = editCliForm.command;
      cfg.defaultArgs = newArgs;
      cfg.cwd = editCliForm.cwd || undefined;
      cfg.description = editCliForm.description || undefined;
      if (needReset && 'resetProcess' in connector) {
        try { await (connector as any).resetProcess(); } catch (e: any) { console.error("[CLI] 重置进程失败:", e); }
      }
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
        botName: editBotForm.name, autoConnect: editBotForm.autoConnect,
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
