const DRAFT_PREFIX = "nova-chat-draft:";
const NEW_CHAT_KEY = "__new__";

function draftKey(sessionId: string | null): string {
  return `${DRAFT_PREFIX}${sessionId ?? NEW_CHAT_KEY}`;
}

/** 持久化聊天草稿；null 始终表示尚未发送消息的 New Chat。 */
export const chatDrafts = {
  get(sessionId: string | null): string | undefined {
    try {
      return localStorage.getItem(draftKey(sessionId)) ?? undefined;
    } catch {
      return undefined;
    }
  },

  set(sessionId: string | null, value: string): void {
    try {
      if (value) {
        localStorage.setItem(draftKey(sessionId), value);
      } else {
        localStorage.removeItem(draftKey(sessionId));
      }
    } catch {
      // localStorage 不可用时静默降级。
    }
  },

  clear(sessionId: string | null): void {
    try {
      localStorage.removeItem(draftKey(sessionId));
    } catch {
      // localStorage 不可用时静默降级。
    }
  },

  /** 将旧版空 session 的草稿迁移到稳定的 New Chat 草稿槽。 */
  moveToNewChat(sessionId: string): void {
    try {
      const newChatKey = draftKey(null);
      const oldKey = draftKey(sessionId);
      const oldDraft = localStorage.getItem(oldKey);
      if (!localStorage.getItem(newChatKey) && oldDraft) {
        localStorage.setItem(newChatKey, oldDraft);
      }
      localStorage.removeItem(oldKey);
    } catch {
      // localStorage 不可用时静默降级。
    }
  },
};
