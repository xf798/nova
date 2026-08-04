// ===== 会话持久化 =====
//
// 存储布局（Rust 侧详见 lib.rs「会话存储布局」）：
//   {id}.meta.json        元信息，不含消息
//   {id}.messages.jsonl   每行一条已完成的消息，只追加
//   {id}.partial.json     正在流式生成的最后一条，可反复重写
//
// 写入分三条路径，对应三种语义：
//   append    新消息落地，不读不重写 → 内存只有分页数据也不会冲掉磁盘历史
//   partial   流式期间的最后一条，单条 KB 级，可高频写
//   rewrite   编辑/删除历史消息，唯一会减少条数的路径，带截断守卫

import { invoke } from "@tauri-apps/api/core";
import type { Message } from "./types";
import type { SessionMemory } from "./memory";
import type { SessionMeta } from "./sessionStore";

/** 会话元信息（写盘用）；messages 不在其中 */
export interface SessionMetaPayload {
  id?: string;
  title?: string;
  connectorId?: string;
  connectorSessionId?: string | null;
  modelId?: string;
  pinned?: boolean;
  createdAt?: string;
  updatedAt?: string;
  memory?: SessionMemory;
}

/** 分页配置，取自 Rust 侧常量 */
export interface PageSizes {
  /** 首屏条数：追求尽快出现 */
  firstPage: number;
  /** 往上翻历史时每次条数：比首屏大，少翻几次 */
  loadMore: number;
}

class SessionStorageManager {
  /** 分页大小取自 Rust 侧常量，避免前后端各写一份而漂移 */
  private pageSizesPromise: Promise<PageSizes> | null = null;

  async pageSizes(): Promise<PageSizes> {
    if (!this.pageSizesPromise) {
      this.pageSizesPromise = invoke<PageSizes>("get_session_page_size").catch(e => {
        console.warn("[SessionStorage] 读取分页配置失败，回落默认值:", e);
        return { firstPage: 10, loadMore: 30 };
      });
    }
    return this.pageSizesPromise;
  }

  async migrate(): Promise<void> {
    await invoke("migrate_chat_history");
  }

  async loadIndex(): Promise<SessionMeta[]> {
    return invoke<SessionMeta[]>("get_sessions_index");
  }

  /**
   * 读取消息（offset 从尾部计算，0 表示最新一页）
   *
   * 未传 limit 时按 offset 判断用哪个页大小：offset=0 是首屏（小、快），
   * 其余是往上翻历史（大、少翻几次）。
   * partialIncluded 表示末条来自 partial 文件（尚未写入 jsonl），
   * 调用方据此确定「已追加」锚点。
   */
  async loadMessages(
    sessionId: string,
    offset: number = 0,
    limit?: number
  ): Promise<{
    messages: Message[];
    total: number;
    partialIncluded: boolean;
    memory?: SessionMemory;
    modelId?: string | null;
  }> {
    let size = limit;
    if (size === undefined) {
      const sizes = await this.pageSizes();
      size = offset === 0 ? sizes.firstPage : sizes.loadMore;
    }
    return invoke("get_session_messages", { sessionId, offset, limit: size });
  }

  /** 追加已完成的消息；meta 一并写入可省一次 IPC */
  async appendMessages(
    sessionId: string,
    messages: Message[],
    meta?: SessionMetaPayload
  ): Promise<void> {
    await invoke("append_session_messages", { sessionId, messages, meta });
  }

  /**
   * 全量重写消息（编辑/删除时用）
   *
   * allowShrink 必须在真实删除场景显式传 true，否则 Rust 侧会拒绝
   * 条数变少的写入——那是已复现的数据丢失路径（内存只有 50 条时覆盖磁盘 140 条）。
   */
  async rewriteMessages(
    sessionId: string,
    messages: Message[],
    opts?: { allowShrink?: boolean; meta?: SessionMetaPayload }
  ): Promise<void> {
    await invoke("rewrite_session_messages", {
      sessionId,
      messages,
      allowShrink: opts?.allowShrink ?? false,
      meta: opts?.meta,
    });
  }

  /**
   * 丢弃末尾若干条消息（重试时移除上一轮问答）
   *
   * 不走 rewriteMessages 是因为后者需要前端持有完整消息，
   * 而内存只有最近一页。这里由 Rust 按「partial + jsonl 尾行」精确截断。
   */
  async dropTrailing(sessionId: string, count: number): Promise<void> {
    await invoke("drop_trailing_session_messages", { sessionId, count });
  }

  /** 写入正在流式生成的最后一条消息 */
  async writePartial(sessionId: string, message: Message): Promise<void> {
    await invoke("write_partial_message", { sessionId, message });
  }

  /** 清除 partial（已追加进 jsonl 或被丢弃） */
  async clearPartial(sessionId: string): Promise<void> {
    await invoke("clear_partial_message", { sessionId });
  }

  /** 保存元信息；与磁盘已有 meta 做字段级合并 */
  async saveMeta(sessionId: string, meta: SessionMetaPayload): Promise<void> {
    await invoke("save_session_meta", { sessionId, meta });
  }

  async deleteFromDisk(sessionId: string): Promise<void> {
    await invoke("delete_session", { sessionId });
  }
}

export const sessionStorage = new SessionStorageManager();
