// ===== 增量落盘 =====
//
// 本次改造把「全量覆盖」换成「append + partial」，风险点在增量边界的判定。
// 这批用例守住四条不变量：
//   1. 内存只有分页数据时，落盘不会波及磁盘上的历史
//   2. 最后一条走 partial，不进 jsonl（流式期间可反复重写）
//   3. 已 append 过的消息不会重复 append
//   4. 锚点失效时宁可不写消息，也不能覆盖数据

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message } from "./types";

const mockIndex = vi.fn();
const mockLoadMessages = vi.fn();
const mockMigrate = vi.fn();
const appendMessages = vi.fn();
const writePartial = vi.fn();
const saveMeta = vi.fn();
const dropTrailing = vi.fn();
const deleteMessage = vi.fn();

vi.mock("./sessionStorage", () => ({
  sessionStorage: {
    migrate: () => mockMigrate(),
    loadIndex: () => mockIndex(),
    loadMessages: (id: string) => mockLoadMessages(id),
    appendMessages: (...a: unknown[]) => appendMessages(...a),
    writePartial: (...a: unknown[]) => writePartial(...a),
    saveMeta: (...a: unknown[]) => saveMeta(...a),
    dropTrailing: (...a: unknown[]) => dropTrailing(...a),
    deleteMessage: (...a: unknown[]) => deleteMessage(...a),
    rewriteMessages: vi.fn().mockResolvedValue(undefined),
    clearPartial: vi.fn().mockResolvedValue(undefined),
    deleteFromDisk: vi.fn().mockResolvedValue(undefined),
    pageSizes: vi.fn().mockResolvedValue({ firstPage: 10, loadMore: 30 }),
  },
}));

vi.mock("./chatDrafts", () => ({ chatDrafts: { clear: vi.fn() } }));
vi.mock("./chatAttachments", () => ({ chatAttachments: { clear: vi.fn() } }));

// sessionStore 的防抖用 window.setTimeout；测试环境是 node，补最小桩
vi.stubGlobal("window", {
  setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
});

const { useSessionStore } = await import("./sessionStore");

const msg = (id: string, role: "user" | "assistant" = "user"): Message => ({
  id, role, content: `内容-${id}`, timestamp: "2026-08-01T00:00:00Z",
});

const meta = (id: string) => ({
  id, title: "会话", connectorId: "kiro-cli", connectorSessionId: null,
  createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
});

/** 推进防抖计时器并等待其中的 await 落地 */
async function flushSave() {
  vi.advanceTimersByTime(1100);
  // debouncedSave 内部有多个 await，需让微任务队列跑完
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockMigrate.mockResolvedValue(undefined);
  appendMessages.mockResolvedValue(undefined);
  writePartial.mockResolvedValue(undefined);
  saveMeta.mockResolvedValue(undefined);
  dropTrailing.mockResolvedValue(undefined);
  deleteMessage.mockResolvedValue({ deleted: true, lastPersistedId: "a", total: 2 });
  useSessionStore.setState({ sessions: [], activeSessionId: null, loaded: false, pagination: {} });
});

describe("增量落盘 — 分页会话不丢历史", () => {
  it("只加载最近一页后追加新消息，只 append 新增的那些", async () => {
    // 磁盘 140 条，内存只有最后 50 条
    const loaded = Array.from({ length: 50 }, (_, i) => msg(`old-${90 + i}`));
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockResolvedValue({
      messages: loaded, total: 140, partialIncluded: false,
    });
    await useSessionStore.getState().init();
    await useSessionStore.getState().switchSession("s1");

    // 发两条新消息
    useSessionStore.getState().updateMessages("s1", m => [...m, msg("new-1"), msg("new-2", "assistant")]);
    await flushSave();

    expect(appendMessages).toHaveBeenCalledTimes(1);
    const appended = appendMessages.mock.calls[0][1] as Message[];
    // 只 append 到倒数第二条：最后一条留给 partial
    expect(appended.map(m => m.id)).toEqual(["new-1"]);
    // 已在磁盘的 50 条不应重复写
    expect(appended.some(m => m.id.startsWith("old-"))).toBe(false);
  });

  it("最后一条写 partial 而非 jsonl（流式期间可反复重写）", async () => {
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockResolvedValue({ messages: [msg("a")], total: 1, partialIncluded: false });
    await useSessionStore.getState().init();
    await useSessionStore.getState().switchSession("s1");

    useSessionStore.getState().updateMessages("s1", m => [...m, msg("b", "assistant")]);
    await flushSave();

    expect(writePartial).toHaveBeenCalled();
    const lastPartial = writePartial.mock.calls[writePartial.mock.calls.length - 1][1] as Message;
    expect(lastPartial.id).toBe("b");
  });

  it("同一条消息不会被 append 两次", async () => {
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockResolvedValue({ messages: [msg("a")], total: 1, partialIncluded: false });
    await useSessionStore.getState().init();
    await useSessionStore.getState().switchSession("s1");

    useSessionStore.getState().updateMessages("s1", m => [...m, msg("b"), msg("c")]);
    await flushSave();
    const firstBatch = (appendMessages.mock.calls[0][1] as Message[]).map(m => m.id);
    expect(firstBatch).toEqual(["b"]);

    // 再来一条，b 不该重复出现
    useSessionStore.getState().updateMessages("s1", m => [...m, msg("d")]);
    await flushSave();
    const secondBatch = (appendMessages.mock.calls[1][1] as Message[]).map(m => m.id);
    expect(secondBatch).toEqual(["c"]);
    expect(secondBatch).not.toContain("b");
  });
});

describe("增量落盘 — partial 恢复", () => {
  it("末条来自 partial 时不算已持久化，之后会被 append", async () => {
    // 上次退出时 assistant 消息还在 partial 里
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockResolvedValue({
      messages: [msg("u1"), msg("a1", "assistant")],
      total: 2,
      partialIncluded: true,
    });
    await useSessionStore.getState().init();
    await useSessionStore.getState().switchSession("s1");

    // 新一轮消息进来，a1 已不是最后一条 → 应被 append
    useSessionStore.getState().updateMessages("s1", m => [...m, msg("u2"), msg("a2", "assistant")]);
    await flushSave();

    const appended = (appendMessages.mock.calls[0][1] as Message[]).map(m => m.id);
    expect(appended).toContain("a1");
    expect(appended).toEqual(["a1", "u2"]);
  });
});

describe("增量落盘 — 占位消息", () => {
  it("$$LOADING$$ 不写盘", async () => {
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockResolvedValue({ messages: [msg("a")], total: 1, partialIncluded: false });
    await useSessionStore.getState().init();
    await useSessionStore.getState().switchSession("s1");

    useSessionStore.getState().updateMessages("s1", m => [
      ...m,
      msg("b"),
      { id: "loading", role: "assistant", content: "$$LOADING$$", timestamp: "x" },
    ]);
    await flushSave();

    const allWritten = [
      ...appendMessages.mock.calls.flatMap(c => c[1] as Message[]),
      ...writePartial.mock.calls.map(c => c[1] as Message),
    ];
    expect(allWritten.some(m => m.content === "$$LOADING$$")).toBe(false);
  });
});

describe("dropTrailingMessages — 重试时同步删除磁盘内容", () => {
  it("按数量截断并同步内存", async () => {
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockResolvedValue({
      messages: [msg("a"), msg("b"), msg("c", "assistant")],
      total: 3,
      partialIncluded: false,
    });
    await useSessionStore.getState().init();
    await useSessionStore.getState().switchSession("s1");

    await useSessionStore.getState().dropTrailingMessages("s1", 2);

    expect(dropTrailing).toHaveBeenCalledWith("s1", 2);
    const after = useSessionStore.getState().sessions.find(s => s.id === "s1")!;
    expect(after.messages.map(m => m.id)).toEqual(["a"]);
  });

  it("count 为 0 时不做任何事", async () => {
    await useSessionStore.getState().dropTrailingMessages("s1", 0);
    expect(dropTrailing).not.toHaveBeenCalled();
  });

  it("落盘失败时内存不变，避免与磁盘不一致", async () => {
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockResolvedValue({
      messages: [msg("a"), msg("b")], total: 2, partialIncluded: false,
    });
    await useSessionStore.getState().init();
    await useSessionStore.getState().switchSession("s1");

    dropTrailing.mockRejectedValueOnce(new Error("io error"));
    await useSessionStore.getState().dropTrailingMessages("s1", 1);

    const after = useSessionStore.getState().sessions.find(s => s.id === "s1")!;
    expect(after.messages.map(m => m.id)).toEqual(["a", "b"]);
  });

  it("截断后新消息从正确位置继续 append（锚点已重置）", async () => {
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockResolvedValue({
      messages: [msg("a"), msg("b"), msg("c", "assistant")],
      total: 3,
      partialIncluded: false,
    });
    await useSessionStore.getState().init();
    await useSessionStore.getState().switchSession("s1");

    await useSessionStore.getState().dropTrailingMessages("s1", 2);
    // 重发：a 之后接两条新的
    useSessionStore.getState().updateMessages("s1", m => [...m, msg("b2"), msg("c2", "assistant")]);
    await flushSave();

    const appended = (appendMessages.mock.calls[0][1] as Message[]).map(m => m.id);
    expect(appended).toEqual(["b2"]);
    // 被截断的旧消息不该复活
    expect(appended).not.toContain("b");
    expect(appended).not.toContain("c");
  });
});

describe("deleteMessage — 按 ID 删除单条消息", () => {
  it("先落盘再删除，并同步内存与分页总数", async () => {
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockResolvedValue({
      messages: [msg("a"), msg("b"), msg("c", "assistant")],
      total: 8,
      partialIncluded: false,
    });
    await useSessionStore.getState().init();

    deleteMessage.mockResolvedValueOnce({ deleted: true, lastPersistedId: "c", total: 7 });
    const ok = await useSessionStore.getState().deleteMessage("s1", "b");

    expect(ok).toBe(true);
    expect(deleteMessage).toHaveBeenCalledWith("s1", "b");
    // 纯历史删除没有待落盘内容，不应把已在 JSONL 的末条再复制到 partial。
    expect(writePartial).not.toHaveBeenCalled();
    const state = useSessionStore.getState();
    expect(state.sessions.find(s => s.id === "s1")!.messages.map(m => m.id)).toEqual(["a", "c"]);
    expect(state.pagination.s1).toEqual({ loadedOffset: 2, total: 7 });
  });

  it("存在防抖中的新增消息时先刷盘再删除", async () => {
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockResolvedValue({
      messages: [msg("a")], total: 1, partialIncluded: false,
    });
    await useSessionStore.getState().init();
    useSessionStore.getState().updateMessages("s1", m => [...m, msg("b"), msg("c", "assistant")]);

    deleteMessage.mockResolvedValueOnce({ deleted: true, lastPersistedId: "a", total: 2 });
    await useSessionStore.getState().deleteMessage("s1", "b");

    expect((appendMessages.mock.calls[0][1] as Message[]).map(m => m.id)).toEqual(["b"]);
    expect((writePartial.mock.calls[0][1] as Message).id).toBe("c");
    expect(deleteMessage).toHaveBeenCalledWith("s1", "b");
  });

  it("磁盘删除失败时不改内存", async () => {
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockResolvedValue({
      messages: [msg("a"), msg("b")], total: 2, partialIncluded: false,
    });
    await useSessionStore.getState().init();

    deleteMessage.mockRejectedValueOnce(new Error("io error"));
    const ok = await useSessionStore.getState().deleteMessage("s1", "b");

    expect(ok).toBe(false);
    expect(useSessionStore.getState().sessions.find(s => s.id === "s1")!.messages.map(m => m.id))
      .toEqual(["a", "b"]);
  });

  it("删除对话消息时清空可能包含该正文的会话摘要", async () => {
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockResolvedValue({
      messages: [msg("a"), msg("b", "assistant")], total: 2, partialIncluded: false,
      memory: {
        summary: "包含 b 的旧摘要",
        summarizedCount: 2,
        summaryChain: [{ summary: "旧摘要", startIndex: 0, endIndex: 2, createdAt: "x", segmentIndex: 1 }],
        distilledMsgCount: 2,
      },
    });
    await useSessionStore.getState().init();

    deleteMessage.mockResolvedValueOnce({ deleted: true, lastPersistedId: "a", total: 1 });
    await useSessionStore.getState().deleteMessage("s1", "b");

    const memory = useSessionStore.getState().sessions.find(s => s.id === "s1")!.memory!;
    expect(memory.summary).toBeNull();
    expect(memory.summarizedCount).toBe(0);
    expect(memory.summaryChain).toEqual([]);
    expect(memory.distilledMsgCount).toBe(2);
  });
});

describe("新建会话", () => {
  it("只写 meta，消息交给后续增量落盘", () => {
    useSessionStore.getState().createSession({
      id: "new-1", title: "新对话", connectorId: "kiro-cli", connectorSessionId: null,
    });
    expect(saveMeta).toHaveBeenCalledWith("new-1", expect.objectContaining({ id: "new-1" }));
    expect(appendMessages).not.toHaveBeenCalled();
  });
});
