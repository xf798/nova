import { create } from "zustand";
import type { Message, ChatSession } from "./types";
import { sessionStorage } from "./sessionStorage";
import { chatDrafts } from "./chatDrafts";
import { chatAttachments } from "./chatAttachments";


export interface SessionMeta {
  id: string;
  title: string;
  connectorId: string;
  connectorSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  /** Per-session 模型选择 */
  modelId?: string;
}

interface PaginationInfo {
  loadedOffset: number;
  total: number;
}

interface SessionState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  loaded: boolean;
  pagination: Record<string, PaginationInfo>;

  init: (transform?: (sessions: ChatSession[]) => ChatSession[]) => Promise<void>;
  createSession: (meta: Omit<SessionMeta, "createdAt" | "updatedAt">) => string;
  updateMessages: (sessionId: string, updater: (msgs: Message[]) => Message[], touchTimestamp?: boolean) => void;
  /**
   * 丢弃末尾若干条消息并同步落盘（重试时移除上一轮问答）。
   *
   * 必须走这个入口而非 updateMessages：后者只做增量追加，
   * 减少消息会让持久化锚点失效，磁盘上的那几条不会被删掉。
   */
  dropTrailingMessages: (sessionId: string, count: number) => Promise<void>;
  updateMeta: (sessionId: string, metaUpdate: Partial<Pick<SessionMeta, "title" | "connectorId" | "connectorSessionId" | "pinned">> & { modelId?: string }) => void;
  updateMemory: (sessionId: string, memory: any) => void;
  switchSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  loadMore: (sessionId: string) => Promise<{ messages: Message[]; hasMore: boolean } | null>;
  setActiveSessionId: (id: string | null) => void;
  hasMoreMessages: (sessionId: string) => boolean;
}

const saveTimers: Map<string, number> = new Map();

/**
 * 记录每个会话已追加进 jsonl 的最后一条消息 id。
 *
 * 用它判断增量边界：内存里从这条之后的消息才是待落盘的。
 * 不用条数判断——内存只持有最近一页，条数与磁盘对不上。
 * null 表示尚未追加过任何消息。
 */
const persistedLastId: Map<string, string | null> = new Map();

/**
 * 会话加载后登记「已追加进 jsonl」的锚点。
 *
 * 若末条来自 partial（还没落进 jsonl），必须排除它——否则会被当成已持久化，
 * 等它不再是最后一条时也不会被追加，那条消息就永久丢了。
 */
function markPersisted(sessionId: string, messages: Message[], partialIncluded: boolean): void {
  const inJsonl = partialIncluded ? messages.slice(0, -1) : messages;
  const done = inJsonl.filter(m => m.content !== LOADING_PLACEHOLDER);
  persistedLastId.set(sessionId, done.length > 0 ? done[done.length - 1].id : null);
}

const LOADING_PLACEHOLDER = "$$LOADING$$";

/** 抽出写盘用的 meta（不含 messages） */
function metaOf(session: ChatSession) {
  return {
    id: session.id,
    title: session.title,
    connectorId: session.connectorId,
    connectorSessionId: session.connectorSessionId,
    modelId: session.modelId,
    pinned: session.pinned,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    memory: session.memory,
  };
}

/**
 * 增量落盘。
 *
 * 策略：**除最后一条外的消息 append 一次即不再重写；最后一条始终写 partial。**
 *
 * 这样不需要知道「是否正在流式」——正在生成的回复必然是最后一条，
 * 而它一旦不再是最后一条（有更新的消息进来）就说明已定稿，此时才 append。
 * 好处：
 *   - 流式期间只重写单条 partial（KB 级），不碰 jsonl（MB 级）
 *   - 崩溃时 partial 还在，未完成的回复不会凭空消失
 *   - append 不读旧内容，内存只有分页数据也不会冲掉磁盘历史
 *
 * $$LOADING$$ 占位消息不落盘。
 */
function debouncedSave(sessionId: string, delay: number = 1000): void {
  const existing = saveTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = window.setTimeout(async () => {
    saveTimers.delete(sessionId);
    const session = useSessionStore.getState().sessions.find(s => s.id === sessionId);
    if (!session) return;

    const msgs = session.messages.filter(m => m.content !== LOADING_PLACEHOLDER);
    if (msgs.length === 0) {
      // 会话可能只有占位消息；meta 仍需落盘（新建会话的标题等）
      await sessionStorage.saveMeta(sessionId, metaOf(session)).catch(e =>
        console.warn("[SessionStore] saveMeta 失败:", e));
      return;
    }

    const lastId = persistedLastId.get(sessionId) ?? null;
    // 找到已持久化位置：其后到倒数第二条是本次要 append 的
    const idx = lastId === null ? -1 : msgs.findIndex(m => m.id === lastId);

    if (lastId !== null && idx === -1) {
      // 已持久化的那条在内存里找不到 —— 说明历史被编辑/删除过。
      // 此时不能 append（会重复），只能重写；而内存未必持有全量，
      // 交给显式的 rewriteMessages 路径处理，这里只更新 meta 以免误伤数据。
      console.warn(
        `[SessionStore] 会话 ${sessionId} 的持久化锚点丢失，跳过消息落盘（请走 rewriteMessages）`
      );
      await sessionStorage.saveMeta(sessionId, metaOf(session)).catch(e =>
        console.warn("[SessionStore] saveMeta 失败:", e));
      return;
    }

    const last = msgs[msgs.length - 1];
    const toAppend = msgs.slice(idx + 1, msgs.length - 1);

    try {
      if (toAppend.length > 0) {
        await sessionStorage.appendMessages(sessionId, toAppend, metaOf(session));
        persistedLastId.set(sessionId, toAppend[toAppend.length - 1].id);
      } else {
        await sessionStorage.saveMeta(sessionId, metaOf(session));
      }
      // 最后一条可能还在生成，写 partial 而非 jsonl
      await sessionStorage.writePartial(sessionId, last);
    } catch (e) {
      console.warn("[SessionStore] 增量落盘失败:", e);
    }
  }, delay);
  saveTimers.set(sessionId, timer);
}

/** 只更新 meta（标题/置顶等），不动消息 */
function debouncedSaveMeta(sessionId: string): void {
  const key = `meta-${sessionId}`;
  const existing = saveTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = window.setTimeout(async () => {
    saveTimers.delete(key);
    const session = useSessionStore.getState().sessions.find(s => s.id === sessionId);
    if (!session) return;
    await sessionStorage.saveMeta(sessionId, metaOf(session)).catch(e =>
      console.warn("[SessionStore] saveMeta 失败:", e));
  }, 300);
  saveTimers.set(key, timer);
}

/**
 * 裁剪已离开会话的内存消息，只保留最近一页。
 *
 * 往上翻历史会把消息不断累积到内存里，而切回来时这些消息要全部重新挂载。
 * 实测某个 165 条的会话：内存 20 条渲染 61ms，50 条 135ms，110 条 333ms，
 * 165 条 457ms —— 翻过历史之后每次切回都付全额，且随翻页次数无上限增长。
 *
 * 裁掉后切回成本恒定在首屏那一页。代价是要重新点「加载更早的消息」，
 * 但那是显式操作，比每次切换都变慢好。只动内存，磁盘上的 jsonl 不受影响。
 */
async function trimInactiveSession(sessionId: string): Promise<void> {
  const keep = await sessionStorage.pageSizes()
    .then(s => s.firstPage)
    .catch(() => 20);
  const state = useSessionStore.getState();
  const target = state.sessions.find(s => s.id === sessionId);
  if (!target || target.messages.length <= keep) return;

  useSessionStore.setState(s => ({
    sessions: s.sessions.map(x =>
      x.id === sessionId ? { ...x, messages: x.messages.slice(-keep) } : x
    ),
    // loadedOffset 必须跟着回退，否则「加载更早」会从错误的位置继续取
    pagination: s.pagination[sessionId]
      ? {
          ...s.pagination,
          [sessionId]: {
            ...s.pagination[sessionId],
            loadedOffset: Math.min(s.pagination[sessionId].loadedOffset, keep),
          },
        }
      : s.pagination,
  }));
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  loaded: false,
  pagination: {},

  init: async (transform) => {
    await sessionStorage.migrate();
    const index = await sessionStorage.loadIndex();
    index.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    let sessions: ChatSession[] = index.map(meta => ({
      id: meta.id,
      title: meta.title,
      connectorId: meta.connectorId,
      connectorSessionId: meta.connectorSessionId,
      messages: [],
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      pinned: meta.pinned || false,
      modelId: meta.modelId || undefined,
      // 索引里没有消息，需按需从磁盘加载
      messagesLoaded: false,
    }));

    if (transform) sessions = transform(sessions);

    const activeSessionId = sessions.length > 0 ? sessions[0].id : null;

    if (activeSessionId) {
      try {
        const result = await sessionStorage.loadMessages(activeSessionId);
        // 登记已持久化锚点。漏了这步，首次保存会把刚读出来的整页
        // 重新 append 一遍，磁盘上出现重复消息。
        markPersisted(activeSessionId, result.messages, result.partialIncluded);
        const idx = sessions.findIndex(s => s.id === activeSessionId);
        if (idx >= 0) {
          sessions[idx] = {
            ...sessions[idx],
            messages: result.messages,
            memory: result.memory,
            // index 里没有时用 session 文件中的值兜底（兼容早期数据）
            modelId: sessions[idx].modelId ?? (result.modelId || undefined),
            messagesLoaded: true,
          };
        }
        set(state => ({
          pagination: { ...state.pagination, [activeSessionId]: { loadedOffset: result.messages.length, total: result.total } },
        }));
      } catch (e) {
        console.warn("[SessionStore] preload active session failed:", e);
        // 失败也标记为已加载，否则界面会一直停在 loading
        const idx = sessions.findIndex(s => s.id === activeSessionId);
        if (idx >= 0) sessions[idx] = { ...sessions[idx], messagesLoaded: true };
      }
    }

    set({ sessions, activeSessionId, loaded: true });
  },

  createSession: (meta) => {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: meta.id,
      title: meta.title,
      connectorId: meta.connectorId,
      connectorSessionId: meta.connectorSessionId,
      messages: [],
      createdAt: now,
      updatedAt: now,
      // 新建会话无历史可加载，直接视为已加载，避免显示加载态
      messagesLoaded: true,
    };
    set(state => ({ sessions: [session, ...state.sessions] }));
    // 新建会话只有 meta 可写；消息由后续 debouncedSave 增量追加
    persistedLastId.set(session.id, null);
    sessionStorage.saveMeta(session.id, metaOf(session)).catch(e =>
      console.warn("[SessionStore] createSession persist failed:", e));
    return session.id;
  },

  updateMessages: (sessionId, updater, touchTimestamp = true) => {
    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId
          ? { ...s, messages: updater(s.messages), ...(touchTimestamp ? { updatedAt: new Date().toISOString() } : {}) }
          : s
      ),
    }));
    debouncedSave(sessionId);
  },

  dropTrailingMessages: async (sessionId, count) => {
    if (count <= 0) return;
    // 先落盘再改内存：写失败时内存与磁盘仍一致，用户可重试
    try {
      await sessionStorage.dropTrailing(sessionId, count);
    } catch (e) {
      console.warn("[SessionStore] dropTrailing 失败:", e);
      return;
    }
    // 待落盘的定时器已无意义，取消掉免得把刚删的又写回去
    const pending = saveTimers.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      saveTimers.delete(sessionId);
    }
    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId ? { ...s, messages: s.messages.slice(0, -count) } : s
      ),
    }));
    // 截断后内存里的末条必定已在 jsonl 中（partial 只存最末一条，已被删）
    const after = get().sessions.find(s => s.id === sessionId);
    if (after) markPersisted(sessionId, after.messages, false);
  },

  updateMeta: (sessionId, metaUpdate) => {
    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId ? { ...s, ...metaUpdate } : s
      ),
    }));
    debouncedSaveMeta(sessionId);
  },

  updateMemory: (sessionId, memory) => {
    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId ? { ...s, memory } : s
      ),
    }));
    debouncedSave(sessionId);
  },

  switchSession: async (sessionId) => {
    const prevId = get().activeSessionId;
    set({ activeSessionId: sessionId });
    // 先切再裁：裁剪只影响已经不显示的会话，不该拖慢切换本身
    if (prevId && prevId !== sessionId) void trimInactiveSession(prevId);

    const session = get().sessions.find(s => s.id === sessionId);
    // 用 messagesLoaded 判断而非 messages.length：
    // 后者会让真正空的会话每次切换都重复读盘
    if (session && !session.messagesLoaded) {
      try {
        const result = await sessionStorage.loadMessages(sessionId);
        // 登记已持久化位置：磁盘上最后一条就是锚点，
        // 后续 debouncedSave 只追加它之后的消息
        markPersisted(sessionId, result.messages, result.partialIncluded);
        set(state => ({
          sessions: state.sessions.map(s =>
            s.id === sessionId
              ? {
                  ...s,
                  messages: result.messages,
                  memory: result.memory,
                  // index 里没有时用 session 文件中的值兜底（兼容早期数据）
                  modelId: s.modelId ?? (result.modelId || undefined),
                  messagesLoaded: true,
                }
              : s
          ),
          pagination: { ...state.pagination, [sessionId]: { loadedOffset: result.messages.length, total: result.total } },
        }));
      } catch (e) {
        console.warn("[SessionStore] load session messages failed:", e);
        // 加载失败也要解除加载态，否则界面会一直停在 loading
        set(state => ({
          sessions: state.sessions.map(s =>
            s.id === sessionId ? { ...s, messagesLoaded: true } : s
          ),
        }));
      }
    }
  },

  deleteSession: async (sessionId) => {
    await sessionStorage.deleteFromDisk(sessionId);
    // 连同未发出的草稿与附件一起清理，否则会话没了记录还留在 localStorage
    chatDrafts.clear(sessionId);
    chatAttachments.clear(sessionId);
    persistedLastId.delete(sessionId);
    set(state => {
      const sessions = state.sessions.filter(s => s.id !== sessionId);
      const activeSessionId = state.activeSessionId === sessionId
        ? (sessions.length > 0 ? sessions[0].id : null)
        : state.activeSessionId;
      const newPagination = { ...state.pagination };
      delete newPagination[sessionId];
      return { sessions, activeSessionId, pagination: newPagination };
    });
  },

  loadMore: async (sessionId) => {
    const pag = get().pagination[sessionId];
    if (!pag || pag.loadedOffset >= pag.total) return null;

    // 不传 limit，由 sessionStorage 取 Rust 侧的分页大小（单一来源）
    const result = await sessionStorage.loadMessages(sessionId, pag.loadedOffset);

    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === sessionId
          ? { ...s, messages: [...result.messages, ...s.messages] }
          : s
      ),
      pagination: { ...state.pagination, [sessionId]: { loadedOffset: pag.loadedOffset + result.messages.length, total: result.total } },
    }));

    const newPag = get().pagination[sessionId];
    return {
      messages: get().sessions.find(s => s.id === sessionId)?.messages || [],
      hasMore: newPag ? newPag.loadedOffset < newPag.total : false,
    };
  },

  setActiveSessionId: (id) => {
    const prevId = get().activeSessionId;
    set({ activeSessionId: id });
    // 点「新对话」走的是这条路（不经过 switchSession），同样要裁剪离开的会话，
    // 否则切回去时仍要重新挂载它累积的全部消息
    if (prevId && prevId !== id) void trimInactiveSession(prevId);
  },

  hasMoreMessages: (sessionId) => {
    const pag = get().pagination[sessionId];
    if (!pag) return false;
    return pag.loadedOffset < pag.total;
  },
}));
