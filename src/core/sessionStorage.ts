import { invoke } from "@tauri-apps/api/core";
import type { Message, ChatSession } from "./types";
import type { SessionMeta } from "./sessionStore";

const PAGE_SIZE = 50;

class SessionStorageManager {
  async migrate(): Promise<void> {
    await invoke("migrate_chat_history");
  }

  async loadIndex(): Promise<SessionMeta[]> {
    return invoke<SessionMeta[]>("get_sessions_index");
  }

  async loadMessages(
    sessionId: string,
    offset: number = 0,
    limit: number = PAGE_SIZE
  ): Promise<{ messages: Message[]; total: number; memory?: any; modelId?: string | null }> {
    return invoke("get_session_messages", { sessionId, offset, limit });
  }

  async saveToDisk(session: ChatSession): Promise<void> {
    await invoke("save_session", { sessionId: session.id, data: session });
  }

  /** 仅更新 meta 信息（不覆盖 messages）：读取磁盘 session → 合并 meta → 写回 */
  async updateMetaOnDisk(sessionId: string, meta: { title?: string; pinned?: boolean; connectorSessionId?: string | null; modelId?: string }): Promise<void> {
    await invoke("update_session_meta", { sessionId, meta });
  }

  async deleteFromDisk(sessionId: string): Promise<void> {
    await invoke("delete_session", { sessionId });
  }
}

export const sessionStorage = new SessionStorageManager();
