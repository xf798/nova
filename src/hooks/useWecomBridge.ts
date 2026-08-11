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

        // Per-session 模型选择。
        //
        // 正常发送路径（ChatView）会在发送前 setModel(session.modelId)，
        // 企微这条路原先漏了，导致在企微会话里切了模型也不生效。
        const sessionModelId = curSession?.modelId;
        if (sessionModelId && sessionModelId !== "auto" && connector.setModel) {
          connector.setModel(sessionModelId);
          console.log(`[WeCom] 🎯 Per-session 模型: "${sessionModelId}"`);
        }

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
          },
          // 过程流：思考与工具调用走 onMeta，与正文是两条独立通道。
          // 原先只传了 onChunk，企微会话因此只有文本、看不到思考和工具调用。
          (meta) => {
            useSessionStore.getState().updateMessages(wecomSessionId, (msgs) =>
              msgs.map(m => m.id === assistantMsgId ? { ...m, meta } : m)
            , false);
          }
        );

        dbg(`[WeCom] sendMessage返回 | content长度=${result.content?.length || 0}`);

        const replyContent = result.content || "（无输出）";
        useSessionStore.getState().updateMessages(wecomSessionId, (msgs) =>
          msgs.map(m => m.id === assistantMsgId ? { ...m, content: replyContent, meta: result.meta } : m)
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
