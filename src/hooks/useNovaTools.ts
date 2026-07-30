import { useEffect, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toolRegistry } from "../core/tools";
import { sendMessage } from "../core/sendMessage";
import { useSessionStore } from "../core/sessionStore";
import { connectorRegistry } from "../connectors";
import type { Connector } from "../connectors";

interface UseNovaToolsParams {
  activeConnectorRef: MutableRefObject<Connector>;
  setCurrentPage: (page: string) => void;
  setActiveConnectorId: (id: string) => void;
  setNotification: (n: { msg: string; type: string } | null) => void;
}

export function useNovaTools({
  activeConnectorRef,
  setCurrentPage,
  setActiveConnectorId,
  setNotification,
}: UseNovaToolsParams) {
  useEffect(() => {
    toolRegistry.register("nav.goto", async (params) => {
      const page = params?.page;
      if (!page) return { ok: false, error: "缺少 page 参数" };
      setCurrentPage(page);
      return { ok: true, data: { page } };
    }, { pluginId: "__nova__", description: "跳转到指定页面", category: "nav", params: [
      { name: "page", type: "string", description: "目标页面: chat/tasks/plugins/connectors/settings/pipeline", required: true, enum: ["chat", "tasks", "plugins", "connectors", "settings", "pipeline"] },
    ]});

    toolRegistry.register("chat.newSession", async () => {
      useSessionStore.getState().setActiveSessionId(null);
      setCurrentPage("chat");
      return { ok: true };
    }, { pluginId: "__nova__", description: "新建对话会话", category: "chat", internal: true });

    toolRegistry.register("connector.list", async () => {
      const configs = connectorRegistry.getConfigs().filter(c => !c.internal);
      return { ok: true, data: configs.map(c => ({ id: c.id, name: c.name, type: c.type, enabled: c.enabled })) };
    }, { pluginId: "__nova__", description: "列出所有已注册的连接器", category: "connector" });

    toolRegistry.register("connector.switch", async (params) => {
      const id = params?.id;
      if (!id) return { ok: false, error: "缺少 id 参数" };
      const conn = connectorRegistry.get(id);
      if (!conn) return { ok: false, error: `连接器 "${id}" 不存在` };
      setActiveConnectorId(id);
      return { ok: true, data: { id, name: conn.config.name } };
    }, { pluginId: "__nova__", description: "切换活跃的 AI 连接器", category: "connector", params: [
      { name: "id", type: "string", description: "连接器 ID", required: true },
    ]});

    toolRegistry.register("ui.notify", async (params) => {
      const msg = params?.message || params?.msg;
      if (!msg) return { ok: false, error: "缺少 message 参数" };
      setNotification({ msg, type: params?.type || "info" });
      setTimeout(() => setNotification(null), 3000);
      return { ok: true };
    }, { pluginId: "__nova__", description: "显示 toast 通知", category: "ui", params: [
      { name: "message", type: "string", description: "通知内容", required: true },
      { name: "type", type: "string", description: "类型", enum: ["info", "success", "error"] },
    ]});

    toolRegistry.register("ui.getState", async () => {
      const state = useSessionStore.getState();
      return { ok: true, data: {
        currentPage: "chat",
        activeConnectorId: activeConnectorRef.current?.config?.id,
        sessionCount: state.sessions.length,
        activeSessionId: state.activeSessionId,
      }};
    }, { pluginId: "__nova__", description: "获取 Nova 当前 UI 状态", category: "ui" });

    toolRegistry.register("ui.screenshot", async (params) => {
      try {
        const savePath = await invoke<string>("capture_screenshot", {
          path: params?.saveTo || null,
          scale: params?.scale ?? 1,
        });
        return { ok: true, data: { path: savePath } };
      } catch (err: any) {
        return { ok: false, error: `截图失败: ${err.message || err}` };
      }
    }, { pluginId: "__nova__", description: "截取 Nova 当前窗口界面保存为 PNG", category: "ui", params: [
      { name: "saveTo", type: "string", description: "保存路径（默认 ~/.nova/data/images/）" },
      { name: "scale", type: "number", description: "缩放比例（默认 1）" },
    ]});

    toolRegistry.register("tools.list", async () => {
      return { ok: true, data: toolRegistry.list() };
    }, { pluginId: "__nova__", description: "列出所有已注册的 tools", category: "system" });

    toolRegistry.register("tools.doc", async () => {
      return { ok: true, data: toolRegistry.generateToolDoc() };
    }, { pluginId: "__nova__", description: "生成所有 tools 的文档（供 LLM 参考）", category: "system" });

    toolRegistry.register("chat.send", async (params) => {
      const message = params?.message;
      if (!message) return { ok: false, error: "缺少 message 参数" };

      const connector = activeConnectorRef.current;
      if (!connector) return { ok: false, error: "没有可用的连接器" };

      const store = useSessionStore.getState();
      let sessionId = store.activeSessionId;
      const loadingId = `msg-${Date.now()}-loading`;
      const userMsgId = `msg-${Date.now()}-user`;

      if (!sessionId) {
        sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        useSessionStore.getState().createSession({
          id: sessionId,
          title: message.slice(0, 30),
          connectorId: connector.config.id,
          connectorSessionId: null,
        });
        useSessionStore.getState().setActiveSessionId(sessionId);
        useSessionStore.getState().updateMessages(sessionId, () => [
          { id: userMsgId, role: "user" as const, content: message, timestamp: new Date().toISOString() },
          { id: loadingId, role: "assistant" as const, content: "$$LOADING$$", timestamp: new Date().toISOString() },
        ]);
      } else {
        useSessionStore.getState().updateMessages(sessionId, (msgs) => [
          ...msgs,
          { id: userMsgId, role: "user" as const, content: message, timestamp: new Date().toISOString() },
          { id: loadingId, role: "assistant" as const, content: "$$LOADING$$", timestamp: new Date().toISOString() },
        ]);
      }

      setCurrentPage("chat");

      try {
        const curSession = useSessionStore.getState().sessions.find(s => s.id === sessionId);
        const result = await sendMessage(
          {
            input: message,
            connector,
            sessionId: curSession?.connectorSessionId || undefined,
            sessionMessages: curSession?.messages || [],
            sessionMemory: curSession?.memory,
            onSessionCreated: (newSessionId: string) => {
              useSessionStore.getState().updateMeta(sessionId!, { connectorSessionId: newSessionId });
            },
          },
          (chunk: string) => {
            useSessionStore.getState().updateMessages(sessionId!, (msgs) =>
              msgs.map(m => m.id === loadingId ? { ...m, content: chunk } : m)
            , false);
          }
        );

        useSessionStore.getState().updateMessages(sessionId!, (msgs) =>
          msgs.map(m => m.id === loadingId ? { ...m, content: result.content } : m)
        );

        return { ok: true, data: { sessionId, content: result.content } };
      } catch (err: any) {
        if (err.message?.includes("connector disposed")) {
          console.log('[chat.send] ⏭️ 忽略 disposed connector 错误');
          useSessionStore.getState().updateMessages(sessionId!, (msgs) => msgs.filter(m => m.id !== loadingId));
          return { ok: false, error: "connector disposed (ignored)" };
        }
        useSessionStore.getState().updateMessages(sessionId!, (msgs) =>
          msgs.map(m => m.id === loadingId ? { ...m, content: `❌ 发送失败: ${err.message}` } : m)
        );
        return { ok: false, error: err.message };
      }
    }, { pluginId: "__nova__", description: "向当前会话发送消息并获取 AI 回复", category: "chat", internal: true, params: [
      { name: "message", type: "string", description: "要发送的消息内容", required: true },
    ]});

    return () => {
      toolRegistry.unregisterByPlugin("__nova__");
    };
  }, []);
}
