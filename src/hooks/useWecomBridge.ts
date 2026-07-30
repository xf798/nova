import { useEffect, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { connectorRegistry, connectorInstances } from "../connectors";
import type { Connector } from "../connectors";
import { useSessionStore } from "../core/sessionStore";
import { sendMessage } from "../core/sendMessage";
import { applyWecomInterceptors } from "../core/wecomInterceptor";

interface UseWecomBridgeParams {
  activeConnectorRef: MutableRefObject<Connector>;
}

export function useWecomBridge({ activeConnectorRef }: UseWecomBridgeParams) {
  useEffect(() => {
    let disposed = false;

    if (!(window as any).__wecom_processed_ids) {
      (window as any).__wecom_processed_ids = new Set<string>();
    }
    const processedIds: Set<string> = (window as any).__wecom_processed_ids;

    const messageQueue: Array<() => Promise<void>> = [];
    let processing = false;

    const processQueue = async () => {
      if (processing) return;
      processing = true;
      while (messageQueue.length > 0) {
        if (disposed) {
          console.log('[WeCom] ⏭️ listener 已 disposed，丢弃队列中剩余任务');
          messageQueue.length = 0;
          break;
        }
        const task = messageQueue.shift()!;
        try {
          await task();
        } catch (e) {
          console.error("[WeCom] 队列任务异常:", e);
        }
      }
      processing = false;
    };

    const unlisten = listen<{
      request_id: string;
      sender_id: string;
      sender_name: string;
      chat_id: string;
      chat_type: string;
      msg_type: string;
      text: string;
      mentioned: boolean;
      response_url: string;
    }>("wecom-message", async (event) => {
      const msg = event.payload;
      if (!msg.text) return;
      const dbg = (m: string) => invoke("debug_log", { msg: m }).catch(() => {});
      dbg(`[WeCom] 收到消息: text=${msg.text.slice(0, 50)} | request_id=${msg.request_id} | sender=${msg.sender_name}`);

      if (processedIds.has(msg.request_id)) {
        console.log(`[WeCom] ⏭️ 重复消息，跳过: request_id=${msg.request_id}`);
        return;
      }
      processedIds.add(msg.request_id);
      if (processedIds.size > 100) {
        const first = processedIds.values().next().value;
        if (first) processedIds.delete(first);
      }

      if (disposed) {
        console.log(`[WeCom] ⏭️ listener 已 disposed，忽略消息: ${msg.text.slice(0, 30)}`);
        return;
      }

      console.log(`[WeCom] 收到消息: ${msg.sender_name}: ${msg.text.slice(0, 50)} (队列长度: ${messageQueue.length})`);

      messageQueue.push(async () => {

      const wecomSessionId = `wecom-${msg.chat_id}`;
      const userMsgId = `msg-${Date.now()}-wecom-user`;
      const assistantMsgId = `msg-${Date.now()}-wecom-assistant`;

      // 读取机器人名称
      let botName = "企微";
      const botConnectors = connectorRegistry.getBotConnectors();
      if (botConnectors.length > 0) {
        const botCfg = botConnectors[0].config;
        if (botCfg.botName) {
          botName = `企微-${botCfg.botName}`;
        } else if (botCfg.botId) {
          botName = `企微-${botCfg.botId.slice(0, 8)}`;
        }
      }

      // 查找或创建企微会话，然后统一通过 updateMessages 添加消息
      const store = useSessionStore.getState();
      const existing = store.sessions.find(s => s.id === wecomSessionId);
      if (!existing) {
        const chatLabel = msg.text.slice(0, 20) || "新会话";
        store.createSession({
          id: wecomSessionId,
          title: `[${botName}] ${chatLabel}`,
          connectorId: activeConnectorRef.current?.config?.id || "wecom-bot",
          connectorSessionId: null,
        });
      }
      useSessionStore.getState().updateMessages(wecomSessionId, (msgs) => [
        ...msgs,
        { id: userMsgId, role: "user" as const, content: msg.text, timestamp: new Date().toISOString() },
        { id: assistantMsgId, role: "assistant" as const, content: "$$LOADING$$", timestamp: new Date().toISOString() },
      ]);

      // 通过统一发送层处理
      try {
        // 解析对话后端：优先当前活跃连接器（cli/api），bot 类型不能作为后端，回落到 cli
        const activeConn = activeConnectorRef.current;
        const baseConnector =
          activeConn && (activeConn.config.type === "cli" || activeConn.config.type === "api")
            ? activeConn
            : connectorRegistry.getByType("cli")[0];
        if (!baseConnector) throw new Error("没有可用的对话连接器");

        const connector = connectorInstances.getOrCreate(wecomSessionId, baseConnector);
        connectorInstances.markBusy(wecomSessionId, baseConnector.config.id);

        const curSession = useSessionStore.getState().sessions.find(s => s.id === wecomSessionId);
        const connectorSessionId = curSession?.connectorSessionId || undefined;
        const sessionMessages = (curSession?.messages || []).filter(m => m.content !== "$$LOADING$$");

        console.log(`[WeCom] 会话上下文: wecomSessionId=${wecomSessionId}, connectorSessionId=${connectorSessionId || "(新会话)"}, historyMsgCount=${sessionMessages.length}`);

        const result = await sendMessage(
          {
            input: msg.text,
            connector,
            sessionId: connectorSessionId,
            sessionMessages,
            sessionMemory: curSession?.memory,
            cwd: "/Users/wangxf/workspace",
            onSessionCreated: (newSessionId: string) => {
              useSessionStore.getState().updateMeta(wecomSessionId, { connectorSessionId: newSessionId });
            },
          },
          (chunk: string) => {
            useSessionStore.getState().updateMessages(wecomSessionId, (msgs) =>
              msgs.map(m => m.id === assistantMsgId ? { ...m, content: chunk } : m)
            , false);
          }
        );

        dbg(`[WeCom] sendMessage返回 | content长度=${result.content?.length || 0}`);

        const replyContent = result.content || "（无输出）";
        useSessionStore.getState().updateMessages(wecomSessionId, (msgs) =>
          msgs.map(m => m.id === assistantMsgId ? { ...m, content: replyContent } : m)
        );

        // 回复到企微
        const wecomReply = applyWecomInterceptors(result.content || "", { msg, result });
        dbg(`[WeCom] 准备回复 | 原始长度=${result.content?.length || 0} | 拦截后长度=${wecomReply.length}`);
        if (wecomReply.trim()) {
          const botConn = connectorRegistry.getBotConnectors()[0];
          if (botConn) {
            try {
              await botConn.replyMessage(msg.request_id, wecomReply, msg.response_url);
              dbg(`[WeCom] replyMessage成功 | request_id=${msg.request_id}`);
            } catch (replyErr: any) {
              dbg(`[WeCom] ❌ replyMessage失败 | error=${replyErr?.message || replyErr}`);
              console.error("[WeCom] replyMessage error:", replyErr);
            }
          }
        }
        connectorInstances.markIdle(wecomSessionId);

      } catch (e: any) {
        connectorInstances.markIdle(wecomSessionId);
        if (e.message?.includes("connector disposed")) {
          console.log('[WeCom] ⏭️ 忽略 disposed connector 错误');
          useSessionStore.getState().updateMessages(wecomSessionId, (msgs) => msgs.filter(m => m.id !== assistantMsgId));
          return;
        }

        const errMsg = `😵 处理失败: ${e.message || e}`;
        console.error("[WeCom] 处理消息失败:", e);

        useSessionStore.getState().updateMessages(wecomSessionId, (msgs) =>
          msgs.map(m => m.id === assistantMsgId ? { ...m, content: errMsg } : m)
        );

        const botConn2 = connectorRegistry.getBotConnectors()[0];
        if (botConn2) {
          await botConn2.replyMessage(msg.request_id, errMsg, msg.response_url).catch(() => {});
        }
      }
      }); // end messageQueue.push

      processQueue();
    });

    // 通知 Rust 端前端已就绪
    invoke("wecom_frontend_ready").catch(() => {});

    return () => {
      disposed = true;
      messageQueue.length = 0;
      unlisten.then(fn => fn());
    };
  }, []);
}
