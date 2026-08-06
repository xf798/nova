import { useState, useRef, useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useAppStore } from "../App";
import { connectorInstances, connectorRegistry } from "../connectors";
import { buildSuggestions } from "../core/suggestions";
import { chatAttachments } from "../core/chatAttachments";
import { pendingModel } from "../core/pendingModel";
import type { Suggestion } from "../core/suggestions";
import type { QuotedMessage } from "../core/types";
import { memoryManager } from "../core/memory";
import { trySummarize } from "../core/memory/summarize";
import { tryExtractMemories } from "../core/memory/extractor";

import { sendMessage } from "../core/sendMessage";
import { getActiveSkillList } from "../core/skills";
import { useSessionStore } from "../core/sessionStore";
import { scheduler } from "../core/scheduler";
import ChatInput from "./chat/ChatInput";
import MessageItem from "./chat/MessageItem";

// 队列项：AI 输出中排队待发的指令
interface QueuedItem {
  id: string;
  text: string;
  attachments: string[];
  quote: QuotedMessage | null;
}

/** 输入队列单会话最大排队数 */
const MAX_QUEUE_SIZE = 20;

// 出队/队列触发发送时携带的上下文
interface QueuedSend {
  targetSessionId: string;
  attachments: string[];
  quote: QuotedMessage | null;
}

function ChatView() {
  const { activeConnector, setPreviewPanel } = useAppStore();
  const sessions = useSessionStore(s => s.sessions);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const storeLoaded = useSessionStore(s => s.loaded);
  const [processingSessions, setProcessingSessions] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  // 待发附件按会话隔离（同草稿）：ChatView 常驻挂载，切会话不重建组件，
  // 若用单个 state 会把附件带进新会话
  const [attachments, setAttachments] = useState<string[]>(() => chatAttachments.get(activeSessionId));
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [activeSkills, setActiveSkills] = useState<{ name: string; description: string; matched: boolean }[]>([]);
  const [showSkillPopover, setShowSkillPopover] = useState(false);
  const [_recalledCount, setRecalledCount] = useState(0);
  const [quotedMessage, setQuotedMessage] = useState<QuotedMessage | null>(null);
  /** 其他页面请求发送的内容，等会话就绪后由 effect 消费 */  const [pendingExternalSend, setPendingExternalSend] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // ── 输入框指令队列：AI 输出中发送的消息进入队列，回答结束后自动出队 ──
  const messageQueueRef = useRef<Record<string, QueuedItem[]>>({});
  const [, forceQueueRender] = useState(0);
  const bumpQueue = () => forceQueueRender(v => v + 1);
  // processingSessions 的 ref 镜像（供闭包内实时判断，避免 state 异步滞后）
  const processingRef = useRef<Set<string>>(new Set());

  const removeFromQueue = (sid: string, id: string) => {
    const q = messageQueueRef.current;
    q[sid] = (q[sid] || []).filter(i => i.id !== id);
    bumpQueue();
  };
  const isNearBottomRef = useRef(true);
  const sendTimeRef = useRef<number>(0);
  const MIN_LOADING_MS = 600;
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);

  const isProcessing = activeSessionId ? processingSessions.has(activeSessionId) : false;

  const dragListenerRef = useRef(false);
  useEffect(() => {
    if (dragListenerRef.current) return;
    dragListenerRef.current = true;
    let unlisten: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") setIsDragging(true);
      else if (event.payload.type === "drop") {
        setIsDragging(false);
        const paths = event.payload.paths || [];
        if (paths.length > 0) {
          setAttachments(prev => {
            const merged = [...prev];
            for (const p of paths) { if (!merged.includes(p)) merged.push(p); }
            return merged;
          });
        }
      } else setIsDragging(false);
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); dragListenerRef.current = false; };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent).detail;
      if (path && typeof path === "string") {
        setAttachments(prev => prev.includes(path) ? prev : [...prev, path]);
      }
    };
    window.addEventListener("nova-add-attachment", handler);
    return () => window.removeEventListener("nova-add-attachment", handler);
  }, []);

  // ===== 附件的会话隔离 =====
  //
  // 切换会话时把当前附件存回原会话，再载入目标会话的。
  // 用 ref 记录上一个 sessionId，与 ChatInput 处理草稿的方式一致。
  const prevAttachSessionRef = useRef<string | null>(activeSessionId);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  useEffect(() => {
    const prevId = prevAttachSessionRef.current;
    if (prevId === activeSessionId) return;
    chatAttachments.set(prevId, attachmentsRef.current);
    setAttachments(chatAttachments.get(activeSessionId));
    prevAttachSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  // 附件变化时落盘，保证重启后与草稿一起恢复。
  //
  // 依赖刻意只有 attachments，写入目标取 ref 而非 activeSessionId：
  // 切换会话的那一次渲染里 activeSessionId 已是新值但 attachments 仍是旧值，
  // 若依赖两者，会用旧附件覆盖目标会话刚恢复出来的记录。
  // 上面的切换 effect 先跑并已把 ref 指向新会话，此处写入即正确。
  useEffect(() => {
    chatAttachments.set(prevAttachSessionRef.current, attachments);
  }, [attachments]);

  // ===== 跨页「发送到新会话」=====
  //
  // Tasks 页等其他页面派发 nova-send-to-new-session 事件请求开一个新会话处理内容。
  // ChatView 始终挂载（MainContent 用 display:none 隐藏），所以监听器一直有效，
  // 不存在「派发时目标未挂载」的时序问题。
  //
  // 分两步：handler 只负责准备好会话并记下待发内容，实际发送交给下面的 effect。
  // 直接在 handler 里调 handleSend 会读到闭包中尚未更新的 activeSession，
  // 把消息发进旧会话。
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail;
      if (!text || typeof text !== "string") return;

      const store = useSessionStore.getState();
      const current = store.sessions.find(s => s.id === store.activeSessionId);
      // 当前已是空会话就直接复用，避免堆一串空的「新对话」
      const isEmpty = current && (current.messages?.length ?? 0) === 0;
      if (!isEmpty) {
        const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        store.createSession({
          id: sessionId,
          title: "新对话",
          connectorId: activeConnector.config.id,
          connectorSessionId: null,
          // 与 ensureSession 一致：落地「新对话」空窗期选好的模型
          modelId: pendingModel.take(),
        });
        store.setActiveSessionId(sessionId);
      }
      setPendingExternalSend(text);
    };
    window.addEventListener("nova-send-to-new-session", handler);
    return () => window.removeEventListener("nova-send-to-new-session", handler);
  }, [activeConnector.config.id]);

  // 消费待发内容。此时已完成一次渲染，activeSession 指向目标会话。
  // 刻意不把 handleSend 放进依赖：它每次渲染都重建，会导致重复发送。
  useEffect(() => {
    if (!pendingExternalSend) return;
    setPendingExternalSend(null);
    handleSend(pendingExternalSend);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingExternalSend]);

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const messages = activeSession?.messages || [];

  // 区分「有历史正在加载」与「真的是空会话」：
  // 两者 messages 都为空，若不区分会在加载历史时闪出欢迎页
  const isHistoryLoading = !storeLoaded || (!!activeSession && !activeSession.messagesLoaded);
  const isEmpty = !isHistoryLoading && messages.filter(m => m.role !== "system").length === 0;

  // 新会话建议：从本地任务/会话/workflow 记忆派生，仅在空会话时需要
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  useEffect(() => {
    if (!isEmpty) return;
    let cancelled = false;
    buildSuggestions(sessions, activeSessionId).then(s => {
      if (!cancelled) setSuggestions(s);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isEmpty, activeSessionId, sessions.length]);

  // 切换会话或消息加载完成时，强制滚到底部
  const prevSessionRef = useRef<string | null>(null);
  // 分页状态跟随真正的活跃会话（与渲染无关，用非延迟值）
  useEffect(() => {
    if (!activeSessionId) { setHasMoreMessages(false); return; }
    setHasMoreMessages(useSessionStore.getState().hasMoreMessages(activeSessionId));
  }, [activeSessionId]);

  // 切换会话或消息增长后回到底部。
  //
  // 容器带 key，切换时会重建，scrollTop 归零，因此必须在内容提交后重新定位。
  //
  // 刻意用 scrollTop 直接赋值而非 scrollIntoView：后者会让 WebView 在同一帧
  // 内既重建图层又滚动，实测出现过同一段内容在多个偏移上重复绘制的残留
  // （截图里同一条消息叠了三次）。直接设 scrollTop 的 DOM 改动更少。
  //
  // 另外已移除原先的 display:none + 读 offsetHeight 强制 reflow：
  // 它让元素脱离再回到渲染树，是干扰合成的可疑来源，而 key 已经保证了
  // DOM 不复用，这一步是多余的。
  useEffect(() => {
    if (prevSessionRef.current !== activeSessionId) {
      prevSessionRef.current = activeSessionId;
      isNearBottomRef.current = true;
    }

    if (isNearBottomRef.current && messages.length > 0) {
      requestAnimationFrame(() => {
        const el = scrollContainerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [activeSessionId, messages.length]);

  // 流式输出期间跟随到底部（平滑，不在会话切换的关键帧里）
  useEffect(() => {
    if (isNearBottomRef.current) {
      const el = scrollContainerRef.current;
      el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  useEffect(() => {
    const paths = [...attachments];
    if (selectedWorkspace) paths.push(selectedWorkspace);
    getActiveSkillList(paths).then(setActiveSkills).catch(() => setActiveSkills([]));
  }, [selectedWorkspace, attachments]);

  const ensureSession = (): string => {
    if (activeSession) return activeSession.id;
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    useSessionStore.getState().createSession({
      id: sessionId,
      title: "新对话",
      connectorId: activeConnector.config.id,
      connectorSessionId: null,
      // 点「新对话」后、发消息前选的模型：那时还没有 session 可写，
      // 暂存在 pendingModel 里，此刻作为初始值落地
      modelId: pendingModel.take(),
    });
    useSessionStore.getState().setActiveSessionId(sessionId);
    return sessionId;
  };

  const handleLoadMore = async () => {
    if (!activeSessionId || isLoadingMore) return;
    setIsLoadingMore(true);
    // 记录锚点：新消息插在顶部会把当前视图整体推下去。
    // 记下加载前的 scrollHeight 与 scrollTop，内容进来后按增量补偿，
    // 让用户视线停在原处而不是被弹走。
    const el = scrollContainerRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const result = await useSessionStore.getState().loadMore(activeSessionId);
      if (result) setHasMoreMessages(result.hasMore);
      if (el) {
        // 等这一批消息渲染完再补偿，否则量到的还是旧高度
        requestAnimationFrame(() => {
          const delta = el.scrollHeight - prevHeight;
          if (delta > 0) el.scrollTop = prevTop + delta;
        });
      }
    } catch (e) {
      console.warn("[LoadMore] 加载更多消息失败:", e);
    } finally {
      setIsLoadingMore(false);
    }
  };

  // 内容撑不满视口时自动补加载。
  //
  // 「加载更多」原本只由向上滚动（scrollTop < 100）触发，可是内容不足一屏时
  // 根本没有滚动条，永远触发不了 —— 历史就再也看不到了。
  //
  // 每个会话最多自动补一次：补一次后仍不满屏就交给顶部按钮。
  // 不设上限会级联——每补一次都是一次 IPC + 全量重渲染，
  // 「渲染 10 条 → 渲染 40 条 → 渲染 70 条」的总开销远超一次渲染到位，
  // 表现就是「消息多的会话反而变慢」。
  const autoFilledRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeSessionId || !hasMoreMessages || isLoadingMore) return;
    if (autoFilledRef.current.has(activeSessionId)) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    // 留 8px 容差，避免因边框/圆整误差反复触发
    if (el.scrollHeight <= el.clientHeight + 8) {
      autoFilledRef.current.add(activeSessionId);
      handleLoadMore();
    }
    // handleLoadMore 每次渲染都重建，放进依赖会导致重复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, messages.length, hasMoreMessages, isLoadingMore]);

  const handleSend = async (text?: string, queued?: QueuedSend) => {
    console.log('[ChatView] ─── handleSend 开始 ───');
    const userInput = (text ?? "").trim();
    const fromQueue = !!queued;

    // 入队：当前会话正在处理中，且非队列触发 → 消息进入队列，等回答结束自动发送
    if (!fromQueue && activeSessionId && processingRef.current.has(activeSessionId)) {
      if (!userInput && attachments.length === 0) return;
      const q = messageQueueRef.current;
      const curLen = q[activeSessionId]?.length || 0;
      if (curLen >= MAX_QUEUE_SIZE) {
        window.dispatchEvent(new CustomEvent("nova-notify", { detail: { msg: `排队已满（最多 ${MAX_QUEUE_SIZE} 条），请等当前回答结束`, type: "error" } }));
        return;
      }
      const item: QueuedItem = {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        text: userInput,
        attachments: [...attachments],
        quote: quotedMessage,
      };
      q[activeSessionId] = [...(q[activeSessionId] || []), item];
      setAttachments([]);
      setQuotedMessage(null);
      bumpQueue();
      console.log('[ChatView] 📥 消息已入队 | sessionId:', activeSessionId, '| 队列长度:', q[activeSessionId].length);
      return;
    }

    const srcAttachments = queued ? queued.attachments : attachments;
    const srcQuote = queued ? queued.quote : quotedMessage;
    if (!userInput && srcAttachments.length === 0) return;
    // 记录用户活跃，供调度引擎 idle 触发判断
    scheduler.markActivity();
    const attached = [...srcAttachments];
    if (!fromQueue) {
      setAttachments([]);
      // 显式清掉来源会话的记录，不依赖「两个 setState 被批处理」这一假设：
      // 若发送时顺带新建了会话（ensureSession），未批处理的情况下切换 effect
      // 会用尚未清空的附件写回原会话，让已发出的附件残留在 New Chat 槽里。
      // 此刻 prevAttachSessionRef 仍指向持有这批附件的会话。
      chatAttachments.clear(prevAttachSessionRef.current);
    }

    const persistedAttachments = await Promise.all(
      attached.map(async (p) => {
        if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p)) {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            return await invoke<string>("persist_image", { path: p });
          } catch { return p; }
        }
        return p;
      })
    );

    const currentQuote = srcQuote;
    if (!fromQueue) setQuotedMessage(null);

    const sessionId = queued ? queued.targetSessionId : ensureSession();
    setProcessingSessions(prev => new Set(prev).add(sessionId));
    processingRef.current = new Set(processingRef.current).add(sessionId);
    sendTimeRef.current = Date.now();

    const loadingId = `msg-${Date.now()}-loading`;
    const displayContent = userInput || (persistedAttachments.length > 0 ? `📎 ${persistedAttachments.length} 个附件` : "");
    const sendContent = currentQuote
      ? `[引用消息 - ${currentQuote.role === "user" ? "我" : "AI"}]:\n${currentQuote.content}\n\n${userInput}`
      : userInput;

    const store = useSessionStore.getState();
    // 发送消息后强制滚动到底部，确保用户能看到自己发的消息
    isNearBottomRef.current = true;
    store.updateMessages(sessionId, (msgs) => [
      ...msgs,
      { id: `msg-${Date.now()}-user`, role: "user", content: displayContent, timestamp: new Date().toISOString(), attachments: persistedAttachments, quotedMessage: currentQuote || undefined },
      { id: loadingId, role: "assistant", content: "$$LOADING$$", timestamp: new Date().toISOString() },
    ]);

    const newTitle = (userInput || "附件消息").slice(0, 30);
    const curTitleSession = useSessionStore.getState().sessions.find(s => s.id === sessionId);
    if (curTitleSession && curTitleSession.title === "新对话") {
      useSessionStore.getState().updateMeta(sessionId, { title: newTitle });
    }

    const curSession = useSessionStore.getState().sessions.find(s => s.id === sessionId);

    // 解析连接器：所有类型都走 per-session 实例，互不影响
    const connectorId = curSession?.connectorId;
    const boundConnector = connectorId ? connectorRegistry.get(connectorId) : null;
    const baseConnector = (boundConnector && boundConnector.config.enabled) ? boundConnector : activeConnector;
    console.log(`[ChatView] 🔌 连接器解析: session.connectorId="${connectorId}" | boundConnector=${boundConnector?.config.id || "null"} | baseConnector=${baseConnector.config.id} | registry已注册: [${connectorRegistry.getEnabled().map(c => c.config.id).join(", ")}]`);
    const sessionConnector = connectorInstances.getOrCreate(
      sessionId,
      baseConnector,
      baseConnector.config.type === "cli"
        ? { cwd: selectedWorkspace || baseConnector.config.cwd }
        : undefined,
    );

    // Per-session 模型选择：设置到独立的 session connector 实例
    const sessionModelId = curSession?.modelId;
    if (sessionModelId && sessionModelId !== "auto" && sessionConnector.setModel) {
      sessionConnector.setModel(sessionModelId);
      console.log(`[ChatView] 🎯 Per-session 模型: "${sessionModelId}"`);
    }

    // ─── 流式更新合并与节流 ───
    //
    // 连接器每收到一个 ACP chunk 会同时回调 onChunk（正文）与 onMeta（过程），
    // 若各自直接写 store，一个 token 就触发两轮全量重渲染。
    // 这里合并成一次写入并限制最小间隔，把渲染频率压到可控范围。
    // 丢弃中间帧无妨：sendMessage 返回后会用最终结果再写一次。
    const STREAM_FLUSH_MS = 50;
    let pendingContent: string | null = null;
    let pendingMeta: import("../connectors/base").StreamMeta | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushStream = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (pendingContent === null && pendingMeta === null) return;
      const content = pendingContent;
      const meta = pendingMeta;
      pendingContent = null;
      pendingMeta = null;
      useSessionStore.getState().updateMessages(sessionId, (msgs) =>
        msgs.map(m => {
          if (m.id !== loadingId) return m;
          const next = { ...m, role: "assistant" as const };
          if (content !== null) next.content = content;
          if (meta !== null) next.meta = meta;
          return next;
        })
      , false);
    };

    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => { flushTimer = null; flushStream(); }, STREAM_FLUSH_MS);
    };

    /** 出错时丢弃未落地的帧，避免定时器在之后写入过期内容 */
    const cancelFlush = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      pendingContent = null;
      pendingMeta = null;
    };

    try {

      let firstChunkReceived = false;
      let loadingReplacedResolve: (() => void) | null = null;
      const loadingReplacedPromise = new Promise<void>(r => { loadingReplacedResolve = r; });

      const minLoadingTimer = new Promise<void>(r => {
        const remaining = Math.max(0, MIN_LOADING_MS - (Date.now() - sendTimeRef.current));
        if (remaining === 0) r();
        else setTimeout(r, remaining);
      });

      console.log('[ChatView] 📤 准备发送 | sessionId:', curSession?.connectorSessionId || '(新会话)', '| connector:', sessionConnector.config.id);
      connectorInstances.markBusy(sessionId, baseConnector.config.id);
      const result = await sendMessage(
        {
          input: sendContent,
          connector: sessionConnector,
          sessionId: curSession?.connectorSessionId || undefined,
          attachments: persistedAttachments.length > 0 ? persistedAttachments : undefined,
          cwd: selectedWorkspace || undefined,
          sessionMessages: curSession?.messages || [],
          sessionMemory: curSession?.memory,
          workspace: selectedWorkspace || undefined,
          onSessionCreated: (newSessionId: string) => {
            useSessionStore.getState().updateMeta(sessionId, { connectorSessionId: newSessionId });
          },
        },
        (chunk: string) => {
          const displayChunk = chunk.replace(/\[ACTION:[a-zA-Z][a-zA-Z0-9_.]*\s*(?:\{[^}]*\})?\s*\]\n?/g, "").trim();
          pendingContent = displayChunk;
          if (!firstChunkReceived) {
            firstChunkReceived = true;
            // 首帧等最小 loading 时长后立即落地，不参与节流
            minLoadingTimer.then(() => {
              flushStream();
              loadingReplacedResolve?.();
            });
          } else {
            scheduleFlush();
          }
        },
        (meta) => {
          pendingMeta = meta;
          scheduleFlush();
        },
        // 召回在请求发出前就已确定，收到即写入，等待期间就能看到
        (recall) => {
          useSessionStore.getState().updateMessages(sessionId, (msgs) =>
            msgs.map(m => m.id === loadingId ? { ...m, recall } : m)
          , false);
        }
      );

      if (firstChunkReceived) {
        await loadingReplacedPromise;
      } else {
        await minLoadingTimer;
      }

      // 落地最后一帧，避免节流窗口内的更新丢失
      flushStream();

      useSessionStore.getState().updateMessages(sessionId, (msgs) =>
        msgs.map(m => m.id === loadingId ? {
          ...m,
          role: "assistant" as const,
          content: result.content,
          // 保留流式期间写入的 toolCalls，合并最终 meta（如 thought）
          meta: {
            ...(m.meta || {}),
            ...(result.meta || {}),
            // toolCalls 优先用已有的（流式期间完整记录），除非 result.meta 有更新
            toolCalls: (result.meta?.toolCalls && result.meta.toolCalls.length > 0)
              ? result.meta.toolCalls
              : (m.meta as any)?.toolCalls,
            // timeline 同理：连接器最终返回的更完整（已封段），否则沿用流式期间的
            timeline: (result.meta?.timeline && result.meta.timeline.length > 0)
              ? result.meta.timeline
              : (m.meta as any)?.timeline,
          },
          // 合并：保留 MCP tool 执行期间已附加的 attachments（如截图），再追加 sendMessage 返回的
          attachments: [...(m.attachments || []), ...(result.attachments || [])].length > 0
            ? [...(m.attachments || []), ...(result.attachments || [])]
            : undefined,
          // 召回明细（可观测）：本次注入的记忆/技能
          // 已由 onRecall 提前写入，这里不覆盖为 undefined
          recall: result.recall && (result.recall.memories.length > 0 || result.recall.skills.length > 0)
            ? result.recall
            : m.recall,
        } : m)
      );

      console.log('[ChatView] 📥 收到回复 | length:', result.content.length, '| sessionId:', result.sessionId, '| recalled:', result.recalledCount);
      connectorInstances.markIdle(sessionId, baseConnector.config.id);
      setRecalledCount(result.recalledCount);

      // ── AI 标题生成（首轮对话完成后） ──
      const titleSession = useSessionStore.getState().sessions.find(s => s.id === sessionId);
      const userMessages = titleSession?.messages.filter(m => m.role === "user" && m.content !== "$$LOADING$$") || [];
      const isFirstReply = userMessages.length === 1;
      const hasDefaultTitle = titleSession?.title === "新对话" || titleSession?.title === userMessages[0]?.content?.slice(0, 30);

      if (isFirstReply && hasDefaultTitle && result.content && result.content.length > 10) {
        (async () => {
          try {
            const titleConnector = connectorInstances.createTemporary("title-gen");
            const titlePrompt = `请为以下对话生成一个简短的标题（不超过20个字，不加引号，不加标点，直接输出标题文字）：\n\n用户：${userMessages[0].content.slice(0, 200)}\n助手：${result.content.slice(0, 300)}`;
            const titleResult = await titleConnector.send(
              titlePrompt,
              {},
              () => {}
            );
            const generatedTitle = titleResult.content
              .replace(/^["'"「『]|["'"」』]$/g, "")
              .replace(/[。.!！？?，,;；]$/g, "")
              .trim()
              .slice(0, 30);
            if (generatedTitle && generatedTitle.length >= 2) {
              useSessionStore.getState().updateMeta(sessionId, { title: generatedTitle });
              console.log('[ChatView] 🏷️ AI 标题生成:', generatedTitle);
            }
            titleConnector.dispose().catch(() => {});
          } catch (e: any) {
            console.warn('[ChatView] 🔇 标题生成失败（已静默）:', e?.message || e);
          }
        })();
      }

      const shouldSummarize = result.needsHistory && memoryManager.getConfig().autoSummarize;
      const shouldExtract = memoryManager.getConfig().autoExtractMemories;

      console.log('[ChatView] 📊 后处理检查 | shouldSummarize:', shouldSummarize, '| shouldExtract:', shouldExtract);
      if (shouldSummarize || shouldExtract) {
        (async () => {
          const bgConnector = connectorInstances.createTemporary("memory-bg");
          try {
          let currentMemory = useSessionStore.getState().sessions.find(s => s.id === sessionId)?.memory;

          if (shouldSummarize) {
            const sess = useSessionStore.getState().sessions.find(s => s.id === sessionId);
            if (sess) {
              const summarizeResult = await trySummarize(sess.messages, currentMemory, bgConnector);
              if (summarizeResult) {
                console.log('[ChatView] 📝 摘要压缩完成 | summarizedCount:', summarizeResult.summarizedCount);
                currentMemory = summarizeResult;
                useSessionStore.getState().updateMemory(sessionId, summarizeResult);
              }
            }
          }

          if (shouldExtract) {
            const sess = useSessionStore.getState().sessions.find(s => s.id === sessionId);
            if (sess) {
              const extractResult = await tryExtractMemories(sess.messages, currentMemory, bgConnector);
              if (extractResult.triggered) {
                console.log('[ChatView] 🧠 记忆提取完成 | saved:', extractResult.saved, '| processedTurns:', extractResult.processedTurns);
                const existingMemory = useSessionStore.getState().sessions.find(s => s.id === sessionId)?.memory;
                const updatedMemory = { ...(existingMemory || currentMemory || { summary: null, summarizedCount: 0 }), extractedTurns: extractResult.processedTurns };
                useSessionStore.getState().updateMemory(sessionId, updatedMemory);
                if (extractResult.saved > 0) {
                  console.log(`[MemoryExtractor] 提取了 ${extractResult.saved} 条长期记忆`);
                }
              }
            }
          }
          } catch (bgErr: any) {
            // 后台记忆任务失败只打日志，不向用户展示错误
            console.warn('[ChatView] 🔇 后台记忆任务失败（已静默）:', bgErr?.message || bgErr);
          } finally {
            bgConnector.dispose().catch(() => {});
          }
        })();
      }
    } catch (e: any) {
      cancelFlush();
      connectorInstances.markIdle(sessionId, baseConnector.config.id);
      if (e.message?.includes("connector disposed")) {
        console.log('[ChatView] ⏭️ 忽略 disposed connector 错误');
        useSessionStore.getState().updateMessages(sessionId, (msgs) => msgs.filter(m => m.id !== loadingId));
        return;
      }
      console.log('[ChatView] ❌ 发送失败:', e);
      useSessionStore.getState().updateMessages(sessionId, (msgs) =>
        msgs.map(m => m.id === loadingId ? { ...m, role: "system" as const, content: `❌ ${e.message || e}` } : m)
      );
    }
    setProcessingSessions(prev => { const next = new Set(prev); next.delete(sessionId); return next; });
    processingRef.current = new Set([...processingRef.current].filter(s => s !== sessionId));

    // 出队：处理完成后检查该会话队列，自动触发下一条
    flushQueue(sessionId);
  };

  const flushQueue = (sessionId: string) => {
    const q = messageQueueRef.current;
    const items = q[sessionId];
    if (!items || items.length === 0) return;
    const [next, ...rest] = items;
    q[sessionId] = rest;
    bumpQueue();
    console.log('[ChatView] 📤 出队执行 | sessionId:', sessionId, '| 剩余队列:', rest.length);
    // 延迟触发，确保 processing 状态已清理
    setTimeout(() => {
      handleSend(next.text, {
        targetSessionId: sessionId,
        attachments: next.attachments,
        quote: next.quote,
      });
    }, 50);
  };

  return (
    <div className="flex flex-col h-full bg-app-bg">
      {/* key 按会话变化：强制 React 销毁并重建整个滚动子树。
          WebView（WKWebView）在会话切换后有时不清除旧内容的绘制，表现为上一个
          会话的消息残留在画面上、新内容画在它下面（已复现两次）。
          仅靠 display:none 触发 reflow 不足以让合成层失效；换 key 拿到全新的
          DOM 与图层，是更彻底的做法。
          代价是不复用 DOM，但两个会话的消息 key 本就完全不同，原本也无从复用。 */}
      <div key={activeSessionId ?? "__new__"} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden" ref={scrollContainerRef} onScroll={() => {
        const el = scrollContainerRef.current;
        if (el) {
          isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
          if (el.scrollTop < 100 && hasMoreMessages && !isLoadingMore) {
            handleLoadMore();
          }
        }
      }}>
        {isHistoryLoading ? (
          <div className="h-full flex flex-col items-center justify-center gap-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-app-text-muted" strokeWidth="2" strokeLinecap="round" style={{ animation: "spin 2.5s linear infinite" }}>
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            </svg>
            <span className="text-[13px] text-app-text-muted">加载会话…</span>
          </div>
        ) : isEmpty ? (
          <div className="h-full flex flex-col items-center justify-center px-6">
            <h1 className="text-[28px] font-semibold mb-2 text-app-text">有什么我能帮你的吗？</h1>
            <p className="text-sm text-app-text-muted mb-8">{activeConnector.config.name}</p>
            {/* 建议来自本地任务/会话/workflow 记忆；宁缺勿滥，没素材就不显示 */}
            {/* 宽度与消息区/输入区一致（760px），避免缩在中间显得孤立；
                两列等宽，既不参差也不会因标题短而显得空旷 */}
            {suggestions.length > 0 && (
              <div className="w-full max-w-[760px] px-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      if (s.kind === "session") {
                        useSessionStore.getState().switchSession(s.sessionId);
                      } else {
                        handleSend(s.prompt);
                      }
                    }}
                    title={`${s.label}\n${s.kind === "task" ? "继续这个任务" : s.kind === "session" ? "回到该会话" : "按记录的流程执行"}`}
                    className="group/sg flex items-center gap-2.5 w-full px-3.5 py-2.5 rounded-xl bg-app-surface hover:bg-app-surface-hover transition-colors text-left"
                  >
                    <span className="shrink-0 flex items-center text-app-text-muted group-hover/sg:text-app-text-secondary transition-colors">
                      {s.kind === "task" ? (
                        // 任务：勾选框
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/>
                        </svg>
                      ) : s.kind === "session" ? (
                        // 会话：对话气泡
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                      ) : (
                        // 流程：有序步骤
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>
                        </svg>
                      )}
                    </span>
                    <span className="min-w-0 truncate text-[13px] text-app-text-secondary group-hover/sg:text-app-text transition-colors">
                      {s.label}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="max-w-[760px] mx-auto py-6 px-4 space-y-4">
            {/* 显式入口：滚动触发不直观（惯性滚动常越过阈值），给个按钮更可控 */}
            {isLoadingMore ? (
              <div className="flex justify-center py-2">
                <span className="text-[12px] text-app-text-muted">加载更多…</span>
              </div>
            ) : hasMoreMessages ? (
              <div className="flex justify-center py-2">
                <button
                  onClick={handleLoadMore}
                  className="px-3 py-1 rounded-full text-[12px] text-app-text-muted hover:text-app-text hover:bg-app-surface transition-colors"
                >
                  加载更早的消息
                </button>
              </div>
            ) : null}
            {messages.map((msg, idx) => (
              <MessageItem
                key={msg.id}
                message={msg}
                onImageClick={(path) => setPreviewPanel({ type: 'image', data: path })}
                onAddAttachment={(path) => setAttachments(prev => prev.includes(path) ? prev : [...prev, path])}
                isSessionProcessing={isProcessing}
                isLastMessage={idx === messages.length - 1}
                onCopy={() => {
                  if (msg.content && msg.content !== "$$LOADING$$") {
                    navigator.clipboard.writeText(msg.content);
                  }
                }}
                onRetry={async () => {
                  const sid = activeSessionId;
                  if (!sid) return;
                  const msgsUpToHere = messages.slice(0, idx);
                  const lastUserMsg = [...msgsUpToHere].reverse().find(m => m.role === "user");
                  if (!lastUserMsg) return;
                  // 重试只对最后一轮有意义：删掉末尾这一问一答再重发。
                  // 走 dropTrailingMessages 而非 updateMessages —— 后者只做增量追加，
                  // 减少消息不会同步到磁盘，重发后历史里会残留旧的那一轮。
                  const dropCount = messages.length - messages.indexOf(lastUserMsg);
                  await useSessionStore.getState().dropTrailingMessages(sid, dropCount);
                  handleSend(lastUserMsg.content);
                }}
                onQuote={() => {
                  if (msg.content && msg.content !== "$$LOADING$$") {
                    setQuotedMessage({ id: msg.id, role: msg.role, content: msg.content });
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* 上下文指示器：Skill + 引用消息 统一一行 */}
      {(activeSkills.length > 0 || quotedMessage) && (
        <div className="relative px-4 pb-1">
          {showSkillPopover && (
            <div className="fixed inset-0 z-40" onClick={() => setShowSkillPopover(false)} />
          )}
          <div className="max-w-[760px] mx-auto flex items-center gap-2">
            {activeSkills.length > 0 && (
              <button
                onClick={() => setShowSkillPopover(!showSkillPopover)}
                className="relative z-50 inline-flex items-center h-7 gap-1.5 px-2.5 rounded-lg text-[11px] font-medium text-app-text-muted hover:text-app-text transition-colors"
                style={{ backgroundColor: "var(--app-surface-hover)" }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>
                </svg>
                <span>{activeSkills.length} skills</span>
              </button>
            )}
            {quotedMessage && (
              <div className="inline-flex items-center h-7 gap-1.5 px-2.5 rounded-lg text-[11px] font-medium text-app-text-muted max-w-[60%]"
                style={{ backgroundColor: "var(--app-surface-hover)" }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <polyline points="9 14 4 9 9 4"/>
                  <path d="M20 20v-7a4 4 0 00-4-4H4"/>
                </svg>
                <span className="truncate min-w-0 text-app-text-secondary">
                  {quotedMessage.role === "user" ? "回复自己" : "回复 AI"}: {quotedMessage.content.slice(0, 50)}{quotedMessage.content.length > 50 ? "…" : ""}
                </span>
                <button
                  onClick={() => setQuotedMessage(null)}
                  className="shrink-0 w-4 h-4 flex items-center justify-center rounded hover:bg-app-surface transition-colors text-app-text-muted hover:text-app-text"
                  title="取消引用"
                >
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6L6 18M6 6l12 12"/>
                  </svg>
                </button>
              </div>
            )}
            {showSkillPopover && activeSkills.length > 0 && (
              <div className="absolute bottom-full left-4 mb-1 py-1.5 rounded-xl border border-app-border shadow-lg min-w-[240px] z-50"
                style={{ backgroundColor: "var(--app-surface)" }}>
                <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-app-text-muted font-medium">
                  Active Skills
                </div>
                {activeSkills.map((s, i) => (
                  <div key={i} className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: s.matched ? "#10a37f" : "var(--app-text-muted)" }} />
                      <span className="text-[12px] text-app-text font-medium truncate">{s.name}</span>
                      {s.matched && <span className="text-[10px] text-green-500 shrink-0">path</span>}
                    </div>
                    {s.description && (
                      <p className="text-[11px] text-app-text-muted ml-3.5 mt-0.5 leading-tight truncate">{s.description}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 指令队列展示：排队中的消息 */}
      {activeSessionId && (messageQueueRef.current[activeSessionId]?.length ?? 0) > 0 && (
        <div className="px-4 pb-1">
          <div className="max-w-[760px] mx-auto flex flex-wrap gap-1.5">
            {messageQueueRef.current[activeSessionId].map((item, idx) => (
              <div
                key={item.id}
                className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] text-app-text-muted max-w-[220px]"
                style={{ backgroundColor: "var(--app-surface-hover)" }}
                title={item.text || (item.attachments.length > 0 ? `${item.attachments.length} 个附件` : "")}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
                </svg>
                <span className="shrink-0">{idx + 1}</span>
                <span className="truncate min-w-0 text-app-text-secondary">
                  {item.text || (item.attachments.length > 0 ? `📎 ${item.attachments.length} 个附件` : "")}
                </span>
                <button
                  onClick={() => removeFromQueue(activeSessionId, item.id)}
                  className="shrink-0 w-4 h-4 flex items-center justify-center rounded hover:bg-app-surface transition-colors text-app-text-muted hover:text-app-text"
                  title="取消这条排队消息"
                >
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6L6 18M6 6l12 12"/>
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <ChatInput
        isProcessing={isProcessing}
        isDragging={isDragging}
        attachments={attachments}
        setAttachments={setAttachments}
        selectedWorkspace={selectedWorkspace}
        setSelectedWorkspace={setSelectedWorkspace}
        showWorkspacePicker={showWorkspacePicker}
        setShowWorkspacePicker={setShowWorkspacePicker}
        onSend={handleSend}
        onAbort={() => {
          const sid = activeSessionId;
          if (sid) {
            const inst = connectorInstances.get(sid);
            if (inst) inst.abort();
            else activeConnector.abort();
            setProcessingSessions(prev => { const next = new Set(prev); next.delete(sid); return next; });
            useSessionStore.getState().updateMessages(sid, msgs => {
              const lastMsg = msgs[msgs.length - 1];
              if (lastMsg && lastMsg.meta?.toolCalls) {
                const updatedToolCalls = (lastMsg.meta.toolCalls as any[]).map((tc: any) =>
                  (tc.status === "in_progress" || tc.status === "pending")
                    ? { ...tc, status: "failed", completedAt: Date.now() }
                    : tc
                );
                return [...msgs.slice(0, -1), { ...lastMsg, meta: { ...lastMsg.meta, toolCalls: updatedToolCalls } }];
              }
              return msgs;
            }, false);
          }
        }}
        sessionId={activeSessionId}
        totalUsage={(() => {
          const total = { inputTokens: 0, outputTokens: 0, totalTokens: 0, resourcePoints: 0 };
          let hasAny = false;
          for (const m of messages) {
            if (m.usage) {
              hasAny = true;
              if (m.usage.inputTokens) total.inputTokens += m.usage.inputTokens;
              if (m.usage.outputTokens) total.outputTokens += m.usage.outputTokens;
              if (m.usage.totalTokens) total.totalTokens += m.usage.totalTokens;
              if (m.usage.resourcePoints) total.resourcePoints += m.usage.resourcePoints;
            }
          }
          return hasAny ? total : undefined;
        })()}
      />
    </div>
  );
}


export default ChatView;
