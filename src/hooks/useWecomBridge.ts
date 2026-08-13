import { useEffect, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { connectorRegistry, connectorInstances } from "../connectors";
import type { Connector } from "../connectors";
import { useSessionStore } from "../core/sessionStore";
import { sendMessage } from "../core/sendMessage";
import { applyWecomInterceptors } from "../core/wecomInterceptor";
import { checkWecomGuard } from "../core/wecomGuard";
import { checkWecomAccess, parseWecomPolicy, rememberSender } from "../core/wecomPolicy";
import { channelBindings, resolveBindingTarget } from "../core/channelBindings";
import { resolveSessionContext } from "../core/sessionContext";
import { sessionTurnQueue } from "../core/sessionTurnQueue";

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

      // 访问控制：先判断「谁能用」，再判断「能做什么」。
      //
      // 策略从机器人连接器配置实时读取，改完设置立即生效，无需重连。
      const botConn0 = connectorRegistry.getBotConnectors()[0];
      const policy = parseWecomPolicy(botConn0?.config?.wecomPolicy);
      const reject = async (content: string) => {
        if (botConn0) {
          await botConn0.replyMessage(msg.request_id, content, msg.response_url).catch(() => {});
        }
      };

      const access = checkWecomAccess(
        { senderId: msg.sender_id, senderName: msg.sender_name, chatId: msg.chat_id },
        policy,
      );
      // 记录发言人供「白名单一键添加」使用，被拒的也记（否则无从得知谁在敲门）
      rememberSender({
        senderId: msg.sender_id,
        senderName: msg.sender_name,
        chatId: msg.chat_id,
        blocked: !access.allowed,
      });

      if (!access.allowed) {
        console.log(`[WeCom] 🚫 访问拒绝 [${access.reason}]: ${msg.sender_name}(${msg.sender_id})`);
        dbg(`[WeCom] 🚫 访问拒绝 reason=${access.reason} | sender=${msg.sender_name} | id=${msg.sender_id}`);
        await reject(access.rejectMessage || "⛔ 未授权");
        return;
      }

      // 高危操作守卫：按策略里开启的类别拦截
      const guardResult = checkWecomGuard(msg.text, policy);
      if (guardResult.blocked) {
        console.log(`[WeCom] 🛡️ 守卫拦截 [${guardResult.ruleName}]: ${msg.text.slice(0, 50)}`);
        dbg(`[WeCom] 🛡️ 守卫拦截 rule=${guardResult.ruleName} | text=${msg.text.slice(0, 80)}`);
        await reject(guardResult.rejectMessage || "⛔ 该操作被拦截");
        return;
      }

      console.log(`[WeCom] 收到消息: ${msg.sender_name}: ${msg.text.slice(0, 50)} (队列长度: ${messageQueue.length})`);

      messageQueue.push(async () => {

      const channelSessionId = `wecom-${msg.chat_id}`;
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

      // 企微入口会话始终保留，供桌面端管理绑定；消息按绑定路由到目标 Nova 会话。
      const store = useSessionStore.getState();
      const activeConn = activeConnectorRef.current;
      const fallbackConnector =
        activeConn && (activeConn.config.type === "cli" || activeConn.config.type === "api")
          ? activeConn
          : connectorRegistry.getByType("cli")[0];
      const existing = store.sessions.find(s => s.id === channelSessionId);
      if (!existing) {
        const chatLabel = msg.text.slice(0, 20) || "新会话";
        store.createSession({
          id: channelSessionId,
          title: `[${botName}] ${chatLabel}`,
          connectorId: fallbackConnector?.config.id || "wecom-bot",
          connectorSessionId: null,
        });
      }

      const binding = await channelBindings.get("wecom", channelSessionId);
      const route = resolveBindingTarget(
        channelSessionId,
        binding,
        useSessionStore.getState().sessions.map(session => session.id),
      );
      if (route.invalidBinding && binding) {
        console.warn(`[WeCom] 绑定目标已不存在，自动解绑: ${binding.targetSessionId}`);
        await channelBindings.unbind("wecom", channelSessionId);
      }
      const targetSessionId = route.targetSessionId;

      await sessionTurnQueue.enqueue(targetSessionId, async () => {
      const targetSession = useSessionStore.getState().sessions.find(session => session.id === targetSessionId)!;
      const context = await resolveSessionContext(targetSessionId).catch(error => {
        console.warn(`[WeCom] 读取完整会话上下文失败，回退内存上下文: ${targetSessionId}`, error);
        return {
          messages: targetSession.messages.filter(message => message.content !== "$$LOADING$$"),
          memory: targetSession.memory,
          modelId: targetSession.modelId,
          connectorId: targetSession.connectorId,
          connectorSessionId: targetSession.connectorSessionId || undefined,
          workspace: targetSession.workspace,
        };
      });
      const userOrigin = {
        channel: "wecom" as const,
        senderId: msg.sender_id,
        senderName: msg.sender_name,
        requestId: msg.request_id,
      };
      const assistantOrigin = { channel: "wecom" as const, requestId: msg.request_id };
      useSessionStore.getState().updateMessages(targetSessionId, (msgs) => [
        ...msgs,
        { id: userMsgId, role: "user" as const, content: msg.text, timestamp: new Date().toISOString(), origin: userOrigin },
        { id: assistantMsgId, role: "assistant" as const, content: "$$LOADING$$", timestamp: new Date().toISOString(), origin: assistantOrigin },
      ]);

      // 通过统一发送层处理
      try {
        // 绑定后优先使用目标会话自己的连接器；不可用时才回落当前桌面连接器。
        const configuredConnector = context.connectorId ? connectorRegistry.get(context.connectorId) : null;
        const baseConnector = configuredConnector?.config.enabled
          && (configuredConnector.config.type === "cli" || configuredConnector.config.type === "api")
          ? configuredConnector
          : fallbackConnector;
        if (!baseConnector) throw new Error("没有可用的对话连接器");

        const connector = connectorInstances.getOrCreate(
          targetSessionId,
          baseConnector,
          baseConnector.config.type === "cli"
            ? { cwd: context.workspace || baseConnector.config.cwd }
            : undefined,
        );
        connectorInstances.markBusy(targetSessionId, baseConnector.config.id);

        const sessionModelId = context.modelId;
        if (sessionModelId && sessionModelId !== "auto" && connector.setModel) {
          connector.setModel(sessionModelId);
          console.log(`[WeCom] 🎯 Per-session 模型: "${sessionModelId}"`);
        }

        console.log(`[WeCom] 会话上下文: channelSessionId=${channelSessionId}, targetSessionId=${targetSessionId}, connectorSessionId=${context.connectorSessionId || "(新会话)"}, historyMsgCount=${context.messages.length}, workspace=${context.workspace || "(默认)"}`);

        const result = await sendMessage(
          {
            input: msg.text,
            connector,
            sessionId: context.connectorSessionId,
            sessionMessages: context.messages,
            sessionMemory: context.memory,
            cwd: context.workspace || baseConnector.config.cwd,
            workspace: context.workspace,
            onSessionCreated: (newSessionId: string) => {
              useSessionStore.getState().updateMeta(targetSessionId, { connectorSessionId: newSessionId });
            },
          },
          (chunk: string) => {
            useSessionStore.getState().updateMessages(targetSessionId, (msgs) =>
              msgs.map(m => m.id === assistantMsgId ? { ...m, content: chunk } : m)
            , false);
          },
          // 过程流：思考与工具调用走 onMeta，与正文是两条独立通道。
          // 原先只传了 onChunk，企微会话因此只有文本、看不到思考和工具调用。
          (meta) => {
            useSessionStore.getState().updateMessages(targetSessionId, (msgs) =>
              msgs.map(m => m.id === assistantMsgId ? { ...m, meta } : m)
            , false);
          },
          // 召回明细走第五个参数，在请求发出前就已确定
          (recall) => {
            useSessionStore.getState().updateMessages(targetSessionId, (msgs) =>
              msgs.map(m => m.id === assistantMsgId ? { ...m, recall } : m)
            , false);
          }
        );

        dbg(`[WeCom] sendMessage返回 | content长度=${result.content?.length || 0}`);

        const replyContent = result.content || "（无输出）";
        useSessionStore.getState().updateMessages(targetSessionId, (msgs) =>
          msgs.map(m => m.id === assistantMsgId ? {
            ...m,
            content: replyContent,
            // 合并而非覆盖：流式期间写入的 thought/timeline 比 result.meta 更完整，
            // 直接覆盖会只剩 toolCalls，思考过程凭空消失
            meta: {
              ...(m.meta || {}),
              ...(result.meta || {}),
              timeline: (result.meta?.timeline && result.meta.timeline.length > 0)
                ? result.meta.timeline
                : (m.meta as any)?.timeline,
            },
            // 召回已由 onRecall 提前写入，这里不要覆盖成 undefined
            recall: result.recall && (result.recall.memories.length > 0 || result.recall.skills.length > 0)
              ? result.recall
              : m.recall,
          } : m)
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
        connectorInstances.markIdle(targetSessionId);

      } catch (e: any) {
        connectorInstances.markIdle(targetSessionId);
        if (e.message?.includes("connector disposed")) {
          console.log('[WeCom] ⏭️ 忽略 disposed connector 错误');
          useSessionStore.getState().updateMessages(targetSessionId, (msgs) => msgs.filter(m => m.id !== assistantMsgId));
          return;
        }

        const errMsg = `😵 处理失败: ${e.message || e}`;
        console.error("[WeCom] 处理消息失败:", e);

        useSessionStore.getState().updateMessages(targetSessionId, (msgs) =>
          msgs.map(m => m.id === assistantMsgId ? { ...m, content: errMsg } : m)
        );

        const botConn2 = connectorRegistry.getBotConnectors()[0];
        if (botConn2) {
          await botConn2.replyMessage(msg.request_id, errMsg, msg.response_url).catch(() => {});
        }
      }
      }); // end sessionTurnQueue.enqueue
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
