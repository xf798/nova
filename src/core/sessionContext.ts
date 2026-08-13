import type { Message, ChatSession } from "./types";
import type { SessionMemory } from "./memory";
import { sessionStorage } from "./sessionStorage";
import { useSessionStore } from "./sessionStore";

const LOADING_PLACEHOLDER = "$$LOADING$$";

export interface ResolvedSessionContext {
  messages: Message[];
  memory?: SessionMemory;
  modelId?: string;
  connectorId?: string;
  connectorSessionId?: string;
  workspace?: string;
}

interface MessagePage {
  messages: Message[];
  total: number;
  memory?: SessionMemory;
  modelId?: string | null;
}

interface ContextStorage {
  loadMessages(sessionId: string, offset?: number, limit?: number): Promise<MessagePage>;
}

/**
 * 从磁盘读取完整历史，而不是依赖 SessionStore 中仅保留的最近一页。
 * 同时合并尚在防抖落盘窗口中的内存消息，避免跨入口紧接着发送时丢失上一轮。
 */
export async function resolveSessionContext(
  sessionId: string,
  options: { storage?: ContextStorage; session?: ChatSession } = {},
): Promise<ResolvedSessionContext> {
  const storage = options.storage || sessionStorage;
  const session = options.session || useSessionStore.getState().sessions.find(s => s.id === sessionId);
  if (!session) throw new Error(`会话不存在: ${sessionId}`);

  const probe = await storage.loadMessages(sessionId, 0, 1);
  const page = probe.total > probe.messages.length
    ? await storage.loadMessages(sessionId, 0, probe.total)
    : probe;

  const messages = page.messages.filter(m => m.content !== LOADING_PLACEHOLDER);
  const ids = new Set(messages.map(m => m.id));
  for (const message of session.messages) {
    if (message.content !== LOADING_PLACEHOLDER && !ids.has(message.id)) {
      messages.push(message);
      ids.add(message.id);
    }
  }

  return {
    messages,
    memory: session.memory || page.memory,
    modelId: session.modelId || page.modelId || undefined,
    connectorId: session.connectorId,
    connectorSessionId: session.connectorSessionId || undefined,
    workspace: session.workspace,
  };
}
