// ===== 会话切换的渲染分支 =====
//
// 切到已加载的长会话时用 useDeferredValue 把重渲染降为低优先级，
// 期间显示加载态而不是冻住界面。这里固化三条契约：
//   1. 分支优先级：首次加载 > 空会话 > 切换中 > 消息列表
//   2. 只在「切换会话」时降级，同一会话内的内容更新（流式）不受影响
//   3. 渲染用的消息数组必须来自延迟后的会话，否则下标与内容错位

import { describe, it, expect } from "vitest";

type Session = { id: string; messages: { id: string; role: string }[]; messagesLoaded: boolean };

/** 复刻 ChatView 里的分支判定 */
function decide(input: {
  storeLoaded: boolean;
  activeSessionId: string | null;
  deferredSessionId: string | null;
  sessions: Session[];
  /** 切换已超过延迟阈值（150ms）仍未渲染完 */
  showSwitchSpinner?: boolean;
}): "loading" | "empty" | "switching" | "list" {
  const { storeLoaded, activeSessionId, sessions } = input;
  const activeSession = sessions.find(s => s.id === activeSessionId);
  const messages = activeSession?.messages || [];

  const isHistoryLoading = !storeLoaded || (!!activeSession && !activeSession.messagesLoaded);
  const isEmpty = !isHistoryLoading && messages.filter(m => m.role !== "system").length === 0;

  if (isHistoryLoading) return "loading";
  if (isEmpty) return "empty";
  // 转圈只在超过延迟阈值后出现；此前沿用上一个会话的内容过渡
  if (input.showSwitchSpinner) return "switching";
  return "list";
}

/** 复刻延迟转圈的状态机 */
function spinnerAfter(isSwitching: boolean, elapsedMs: number, delayMs = 150): boolean {
  return isSwitching && elapsedMs >= delayMs;
}

/** 复刻渲染用的消息来源 */
function renderSource(deferredSessionId: string | null, sessions: Session[]) {
  return sessions.find(s => s.id === deferredSessionId)?.messages || [];
}

const msg = (id: string, role = "user") => ({ id, role });
const sess = (id: string, n: number, loaded = true): Session => ({
  id, messagesLoaded: loaded,
  messages: Array.from({ length: n }, (_, i) => msg(`${id}-m${i}`)),
});

describe("分支优先级", () => {
  const sessions = [sess("A", 50), sess("B", 30), sess("empty", 0)];

  it("store 未加载完 → 加载态", () => {
    expect(decide({ storeLoaded: false, activeSessionId: "A", deferredSessionId: "A", sessions }))
      .toBe("loading");
  });

  it("会话消息未从磁盘读入 → 加载态（首次进入）", () => {
    const s = [sess("A", 0, false)];
    expect(decide({ storeLoaded: true, activeSessionId: "A", deferredSessionId: "A", sessions: s }))
      .toBe("loading");
  });

  it("已加载的空会话 → 欢迎页，不显示加载态", () => {
    expect(decide({ storeLoaded: true, activeSessionId: "empty", deferredSessionId: "empty", sessions }))
      .toBe("empty");
  });

  it("切到空会话时也直接出欢迎页，不闪加载态", () => {
    // 点「新对话」的场景：deferred 还指向旧会话，但目标是空的
    expect(decide({ storeLoaded: true, activeSessionId: "empty", deferredSessionId: "A", sessions }))
      .toBe("empty");
  });

  it("切到有内容的会话且渲染够快 → 直接是列表，不闪转圈", () => {
    // 消息一直缓存在内存里，切换只是重渲染；17-33ms 就完成的话
    // 弹转圈会被误认为在重新加载
    expect(decide({
      storeLoaded: true, activeSessionId: "B", deferredSessionId: "A", sessions,
      showSwitchSpinner: false,
    })).toBe("list");
  });

  it("切换超过阈值仍未渲染完 → 才显示转圈", () => {
    expect(decide({
      storeLoaded: true, activeSessionId: "B", deferredSessionId: "A", sessions,
      showSwitchSpinner: true,
    })).toBe("switching");
  });

  it("切换完成 → 渲染列表", () => {
    expect(decide({ storeLoaded: true, activeSessionId: "B", deferredSessionId: "B", sessions }))
      .toBe("list");
  });

  it("稳定状态下始终是列表，不会误判为切换中", () => {
    expect(decide({ storeLoaded: true, activeSessionId: "A", deferredSessionId: "A", sessions }))
      .toBe("list");
  });
});

describe("延迟转圈的时序", () => {
  it("阈值内不显示（快速切换感觉是瞬间的）", () => {
    expect(spinnerAfter(true, 0)).toBe(false);
    expect(spinnerAfter(true, 33)).toBe(false);
    expect(spinnerAfter(true, 149)).toBe(false);
  });

  it("达到阈值才显示", () => {
    expect(spinnerAfter(true, 150)).toBe(true);
    expect(spinnerAfter(true, 400)).toBe(true);
  });

  it("没在切换时永不显示", () => {
    expect(spinnerAfter(false, 999)).toBe(false);
  });
});

describe("只对会话切换降级，不影响流式输出", () => {
  it("同一会话内消息增长不触发切换态", () => {
    // 流式期间 messages 数组引用不断变化，但 sessionId 不变
    let sessions = [sess("A", 10)];
    expect(decide({ storeLoaded: true, activeSessionId: "A", deferredSessionId: "A", sessions }))
      .toBe("list");

    sessions = [{ ...sessions[0], messages: [...sessions[0].messages, msg("A-new")] }];
    expect(decide({ storeLoaded: true, activeSessionId: "A", deferredSessionId: "A", sessions }))
      .toBe("list");
  });

  it("流式期间渲染源始终是最新消息（无延迟）", () => {
    const grown = [{ ...sess("A", 10), messages: [...sess("A", 10).messages, msg("A-new")] }];
    // deferredSessionId 与 activeSessionId 相同 → 取到的就是最新数组
    expect(renderSource("A", grown).map(m => m.id)).toContain("A-new");
    expect(renderSource("A", grown)).toHaveLength(11);
  });
});

describe("渲染源与下标一致性", () => {
  const sessions = [sess("A", 50), sess("B", 3)];

  it("切换中渲染源仍是旧会话（此时界面显示加载态，不会真的渲染）", () => {
    expect(renderSource("A", sessions)).toHaveLength(50);
  });

  it("切换完成后渲染源是新会话", () => {
    expect(renderSource("B", sessions)).toHaveLength(3);
  });

  it("渲染源缺失时回落空数组，不抛错", () => {
    expect(renderSource("nonexistent", sessions)).toEqual([]);
    expect(renderSource(null, sessions)).toEqual([]);
  });

  it("最后一条判定必须基于渲染源长度，而非活跃会话长度", () => {
    // 活跃会话 A 有 50 条，渲染源 B 只有 3 条；
    // 若用 A 的长度判断 isLastMessage，B 的最后一条就不会被标记
    const rendered = renderSource("B", sessions);
    const lastIdx = rendered.length - 1;
    expect(lastIdx).toBe(2);
    expect(lastIdx).not.toBe(sessions[0].messages.length - 1);
  });
});
