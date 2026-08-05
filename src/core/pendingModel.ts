// ===== New Chat 的待应用模型选择 =====
//
// 点「新对话」只是把 activeSessionId 置空，会话要等首次发消息才懒创建。
// 这段空窗里用户可能先选好模型，但那时还没有 session 可写，
// 选择会被直接丢弃（表现为「点了没反应」）。
//
// 这里暂存选择，会话创建时取出来作为它的初始 modelId。
// 与 chatDrafts 的 __new__ 槽位是同一个思路：New Chat 也需要能承载状态。

const KEY = "nova-pending-model";

export const pendingModel = {
  get(): string | undefined {
    try {
      return localStorage.getItem(KEY) ?? undefined;
    } catch {
      return undefined;
    }
  },

  set(modelId: string): void {
    try {
      localStorage.setItem(KEY, modelId);
    } catch {
      // localStorage 不可用时静默降级。
    }
  },

  /** 取出并清除（会话创建时消费一次） */
  take(): string | undefined {
    const v = this.get();
    this.clear();
    return v;
  },

  clear(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // localStorage 不可用时静默降级。
    }
  },
};
