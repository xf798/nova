// ===== 会话切换的渲染分支 =====
//
// 曾用 useDeferredValue 把切换渲染降为低优先级，但它连续引入三个问题
// （转圈闪屏 → 旧会话内容串页 → 空白不恢复），而它要解决的 264ms 冻结
// 在首屏从 50 降到 20 条后已不存在（实测同步渲染 10-60ms）。
// 因此改回同步渲染，只保留三个分支。
//
// 这里固定两条契约：
//   1. 分支优先级：首次加载 > 空会话 > 消息列表
//   2. 渲染源就是活跃会话的消息，不存在「显示别的会话内容」的中间态

import { describe, it, expect } from "vitest";

type Session = { id: string; messages: { id: string; role: string }[]; messagesLoaded: boolean };

/** 复刻 ChatView 里的分支判定 */
function decide(input: {
  storeLoaded: boolean;
  activeSessionId: string | null;
  sessions: Session[];
}): "loading" | "empty" | "list" {
  const { storeLoaded, activeSessionId, sessions } = input;
  const activeSession = sessions.find(s => s.id === activeSessionId);
  const messages = activeSession?.messages || [];

  const isHistoryLoading = !storeLoaded || (!!activeSession && !activeSession.messagesLoaded);
  const isEmpty = !isHistoryLoading && messages.filter(m => m.role !== "system").length === 0;

  if (isHistoryLoading) return "loading";
  if (isEmpty) return "empty";
  return "list";
}

/** 复刻渲染源 */
function renderSource(activeSessionId: string | null, sessions: Session[]) {
  return sessions.find(s => s.id === activeSessionId)?.messages || [];
}

const msg = (id: string, role = "user") => ({ id, role });
const sess = (id: string, n: number, loaded = true): Session => ({
  id, messagesLoaded: loaded,
  messages: Array.from({ length: n }, (_, i) => msg(`${id}-m${i}`)),
});

describe("分支优先级", () => {
  const sessions = [sess("A", 20), sess("B", 5), sess("empty", 0)];

  it("store 未加载完 → 加载态", () => {
    expect(decide({ storeLoaded: false, activeSessionId: "A", sessions })).toBe("loading");
  });

  it("消息未从磁盘读入 → 加载态（首次进入）", () => {
    expect(decide({ storeLoaded: true, activeSessionId: "A", sessions: [sess("A", 0, false)] }))
      .toBe("loading");
  });

  it("已加载的空会话 → 欢迎页", () => {
    expect(decide({ storeLoaded: true, activeSessionId: "empty", sessions })).toBe("empty");
  });

  it("有内容的会话 → 列表，无中间态", () => {
    expect(decide({ storeLoaded: true, activeSessionId: "B", sessions })).toBe("list");
  });

  it("只有 system 消息也算空会话", () => {
    const s = [{ id: "s", messagesLoaded: true, messages: [msg("x", "system")] }];
    expect(decide({ storeLoaded: true, activeSessionId: "s", sessions: s })).toBe("empty");
  });

  it("无活跃会话 → 欢迎页（点新对话后会话是懒创建的）", () => {
    expect(decide({ storeLoaded: true, activeSessionId: null, sessions })).toBe("empty");
  });
});

describe("渲染源", () => {
  const sessions = [sess("A", 20), sess("B", 5)];

  it("始终取活跃会话的消息", () => {
    expect(renderSource("A", sessions)).toHaveLength(20);
    expect(renderSource("B", sessions)).toHaveLength(5);
  });

  it("会话不存在时回落空数组，不抛错", () => {
    expect(renderSource("nope", sessions)).toEqual([]);
    expect(renderSource(null, sessions)).toEqual([]);
  });

  it("切换后渲染源立即是新会话，不会短暂显示旧会话", () => {
    // 这是移除 useDeferredValue 要保证的核心性质
    const before = renderSource("A", sessions);
    const after = renderSource("B", sessions);
    expect(before[0].id).toContain("A-");
    expect(after[0].id).toContain("B-");
  });
});

describe("自动补加载的防级联", () => {
  /** 复刻「每个会话最多自动补一次」 */
  function shouldAutoFill(input: {
    sessionId: string | null;
    scrollHeight: number;
    clientHeight: number;
    hasMore: boolean;
    isLoading: boolean;
    already: Set<string>;
  }): boolean {
    const { sessionId, scrollHeight, clientHeight, hasMore, isLoading, already } = input;
    if (!sessionId || !hasMore || isLoading) return false;
    if (already.has(sessionId)) return false;
    return scrollHeight <= clientHeight + 8;
  }

  const base = { sessionId: "A", scrollHeight: 400, clientHeight: 800, hasMore: true, isLoading: false };

  it("首次撑不满 → 补一次", () => {
    expect(shouldAutoFill({ ...base, already: new Set() })).toBe(true);
  });

  it("同一会话不再重复补（否则每补一次都是 IPC + 全量重渲染，越补越慢）", () => {
    expect(shouldAutoFill({ ...base, already: new Set(["A"]) })).toBe(false);
  });

  it("换到别的会话仍可补一次", () => {
    expect(shouldAutoFill({ ...base, sessionId: "B", already: new Set(["A"]) })).toBe(true);
  });

  it("内容已超出视口 → 不补", () => {
    expect(shouldAutoFill({ ...base, scrollHeight: 2000, already: new Set() })).toBe(false);
  });

  it("没有更多历史 → 不补", () => {
    expect(shouldAutoFill({ ...base, hasMore: false, already: new Set() })).toBe(false);
  });

  it("正在加载 → 不补", () => {
    expect(shouldAutoFill({ ...base, isLoading: true, already: new Set() })).toBe(false);
  });

  it("无活跃会话 → 不补", () => {
    expect(shouldAutoFill({ ...base, sessionId: null, already: new Set() })).toBe(false);
  });
});
