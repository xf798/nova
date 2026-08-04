// ===== 按会话隔离的待发附件 =====
//
// 与 chatDrafts 对称：草稿文本和待发附件都属于「这个会话里还没发出去的输入」，
// 切换会话时应各自留在原会话，而不是跟着用户跑到新会话里去。
//
// 先前 attachments 是 ChatView 里的单个 useState，而 ChatView 常驻挂载
// （MainContent 用 display:none 隐藏），切会话不重建组件，附件就被带了过去。

const ATTACHMENT_PREFIX = "nova-chat-attachments:";
const NEW_CHAT_KEY = "__new__";

function key(sessionId: string | null): string {
  return `${ATTACHMENT_PREFIX}${sessionId ?? NEW_CHAT_KEY}`;
}

/**
 * 持久化每个会话的待发附件路径；null 表示尚未发送消息的 New Chat。
 *
 * 与草稿一样存 localStorage，跨重启保留——否则重启后草稿文本回来了、
 * 一起选的图片却没了，输入状态残缺。
 * 不校验路径是否仍存在：校验需要异步 Tauri 调用，且文件被删的情况
 * 在发送时本来就会报错，与当前行为一致。
 */
export const chatAttachments = {
  get(sessionId: string | null): string[] {
    try {
      const raw = localStorage.getItem(key(sessionId));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      // 容错：历史或损坏数据可能不是字符串数组
      return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
    } catch {
      return [];
    }
  },

  set(sessionId: string | null, paths: string[]): void {
    try {
      if (paths.length > 0) {
        localStorage.setItem(key(sessionId), JSON.stringify(paths));
      } else {
        localStorage.removeItem(key(sessionId));
      }
    } catch {
      // localStorage 不可用时静默降级。
    }
  },

  clear(sessionId: string | null): void {
    try {
      localStorage.removeItem(key(sessionId));
    } catch {
      // localStorage 不可用时静默降级。
    }
  },
};
