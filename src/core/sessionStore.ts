import { create } from "zustand";
import type { Message, ChatSession } from "./types";
import { sessionStorage } from "./sessionStorage";

const PAGE_SIZE = 50;

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
  updateMeta: (sessionId: string, metaUpdate: Partial<Pick<SessionMeta, "title" | "connectorId" | "connectorSessionId" | "pinned">> & { modelId?: string }) => void;
  updateMemory: (sessionId: string, memory: any) => void;
  switchSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  loadMore: (sessionId: string) => Promise<{ messages: Message[]; hasMore: boolean } | null>;
  setActiveSessionId: (id: string | null) => void;
  hasMoreMessages: (sessionId: string) => boolean;
}

const saveTimers: Map<string, number> = new Map();

function debouncedSave(sessionId: string, delay: number = 1000): void {
  const existing = saveTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = window.setTimeout(async () => {
    saveTimers.delete(sessionId);
    const state = useSessionStore.getState();
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return;
    const cleanMessages = session.messages.filter(m => m.content !== "$$LOADING$$");
    if (cleanMessages.length === 0 && session.messages.length === 0) return;
    await sessionStorage.saveToDisk({ ...session, messages: cleanMessages });
  }, delay);
  saveTimers.set(sessionId, timer);
}

/** 仅更新 index 中的 meta 信息（title/pinned），不覆盖 session 文件中的 messages */
function debouncedSaveMeta(sessionId: string): void {
  const key = `meta-${sessionId}`;
  const existing = saveTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = window.setTimeout(async () => {
    saveTimers.delete(key);
    const state = useSessionStore.getState();
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return;

    // 如果 messages 已加载（非空），走完整保存
    if (session.messages.length > 0) {
      const cleanMessages = session.messages.filter(m => m.content !== "$$LOADING$$");
      await sessionStorage.saveToDisk({ ...session, messages: cleanMessages });
    } else {
      // messages 未加载，只更新 index（读取磁盘上的完整 session，合并 meta 后写回）
      await sessionStorage.updateMetaOnDisk(sessionId, {
        title: session.title,
        pinned: session.pinned,
        connectorSessionId: session.connectorSessionId,
        modelId: session.modelId,
      });
    }
  }, 300);
  saveTimers.set(key, timer);
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
    }));

    if (transform) sessions = transform(sessions);

    const activeSessionId = sessions.length > 0 ? sessions[0].id : null;

    if (activeSessionId) {
      try {
        const result = await sessionStorage.loadMessages(activeSessionId);
        const idx = sessions.findIndex(s => s.id === activeSessionId);
        if (idx >= 0) {
          sessions[idx] = {
            ...sessions[idx],
            messages: result.messages,
            memory: result.memory,
            // index 里没有时用 session 文件中的值兜底（兼容早期数据）
            modelId: sessions[idx].modelId ?? (result.modelId || undefined),
          };
        }
        set(state => ({
          pagination: { ...state.pagination, [activeSessionId]: { loadedOffset: result.messages.length, total: result.total } },
        }));
      } catch (e) {
        console.warn("[SessionStore] preload active session failed:", e);
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
    };
    set(state => ({ sessions: [session, ...state.sessions] }));
    sessionStorage.saveToDisk(session).catch(e => console.warn("[SessionStore] createSession persist failed:", e));
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
    set({ activeSessionId: sessionId });

    const session = get().sessions.find(s => s.id === sessionId);
    if (session && session.messages.length === 0) {
      try {
        const result = await sessionStorage.loadMessages(sessionId);
        set(state => ({
          sessions: state.sessions.map(s =>
            s.id === sessionId
              ? {
                  ...s,
                  messages: result.messages,
                  memory: result.memory,
                  // index 里没有时用 session 文件中的值兜底（兼容早期数据）
                  modelId: s.modelId ?? (result.modelId || undefined),
                }
              : s
          ),
          pagination: { ...state.pagination, [sessionId]: { loadedOffset: result.messages.length, total: result.total } },
        }));
      } catch (e) {
        console.warn("[SessionStore] load session messages failed:", e);
      }
    }
  },

  deleteSession: async (sessionId) => {
    await sessionStorage.deleteFromDisk(sessionId);
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

    const result = await sessionStorage.loadMessages(sessionId, pag.loadedOffset, PAGE_SIZE);

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

  setActiveSessionId: (id) => set({ activeSessionId: id }),

  hasMoreMessages: (sessionId) => {
    const pag = get().pagination[sessionId];
    if (!pag) return false;
    return pag.loadedOffset < pag.total;
  },
}));
