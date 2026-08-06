// ===== 会话内容搜索 =====
//
// 直接搜磁盘上的 jsonl，而不是浏览器原生 ⌘F。
// 原生查找只能命中已渲染的 DOM，而首屏只加载一页、切走还会裁剪内存，
// 165 条的会话里搜不到未加载的那 145 条。
//
// 实测：会话内 7-15ms；全局 130 个会话 32-82ms。

import { invoke } from "@tauri-apps/api/core";

/** 搜索范围 */
export type SearchScope = "session" | "global";

export interface SearchHit {
  sessionId: string;
  sessionTitle: string;
  /** 该消息在会话中的序号（0 基），供后续实现跳转用 */
  messageIndex: number;
  totalInSession: number;
  messageId: string | null;
  role: string | null;
  timestamp: string | null;
  /** 命中处前后的上下文片段，换行已压成空格 */
  snippet: string;
  /** 该条消息内的命中次数 */
  matchCount: number;
}

export interface SearchResult {
  results: SearchHit[];
  /** 命中过多被截断 */
  truncated: boolean;
}

const EMPTY: SearchResult = { results: [], truncated: false };

/**
 * 搜索会话内容。
 *
 * @param query 关键词（大小写不敏感）
 * @param scope session=仅当前会话，global=全部会话
 * @param sessionId scope 为 session 时必传
 */
export async function searchMessages(
  query: string,
  scope: SearchScope,
  sessionId: string | null,
): Promise<SearchResult> {
  if (!query.trim()) return EMPTY;
  // 限定当前会话却没有会话可搜（如刚点「新对话」）→ 直接返回空
  if (scope === "session" && !sessionId) return EMPTY;

  try {
    return await invoke<SearchResult>("search_session_messages", {
      query,
      sessionId: scope === "session" ? sessionId : null,
      limit: 200,
    });
  } catch (e) {
    console.warn("[Search] 搜索失败:", e);
    return EMPTY;
  }
}

/**
 * 把片段按命中位置切成片段数组，供 UI 高亮。
 *
 * 返回交替的「普通/命中」片段，命中项 matched 为 true。
 * 大小写不敏感匹配，但保留原文大小写。
 */
export function highlightParts(
  snippet: string,
  query: string,
): { text: string; matched: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text: snippet, matched: false }];

  const parts: { text: string; matched: boolean }[] = [];
  const lowerSnippet = snippet.toLowerCase();
  const lowerQuery = q.toLowerCase();
  let cursor = 0;

  while (cursor < snippet.length) {
    const hit = lowerSnippet.indexOf(lowerQuery, cursor);
    if (hit === -1) {
      parts.push({ text: snippet.slice(cursor), matched: false });
      break;
    }
    if (hit > cursor) {
      parts.push({ text: snippet.slice(cursor, hit), matched: false });
    }
    parts.push({ text: snippet.slice(hit, hit + q.length), matched: true });
    cursor = hit + q.length;
  }

  return parts.filter(p => p.text.length > 0);
}
