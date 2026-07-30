import { describe, it, expect, vi, beforeEach } from "vitest";

// sessionStorage 走 Tauri invoke，测试环境需打桩
const mockIndex = vi.fn();
const mockLoadMessages = vi.fn();
const mockMigrate = vi.fn();

vi.mock("./sessionStorage", () => ({
  sessionStorage: {
    migrate: () => mockMigrate(),
    loadIndex: () => mockIndex(),
    loadMessages: (id: string) => mockLoadMessages(id),
    saveToDisk: vi.fn().mockResolvedValue(undefined),
    updateMetaOnDisk: vi.fn().mockResolvedValue(undefined),
    deleteFromDisk: vi.fn().mockResolvedValue(undefined),
  },
}));

const { useSessionStore } = await import("./sessionStore");

const meta = (id: string, title = "会话") => ({
  id, title, connectorId: "kiro-cli", connectorSessionId: null,
  createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  mockMigrate.mockResolvedValue(undefined);
  useSessionStore.setState({ sessions: [], activeSessionId: null, loaded: false, pagination: {} });
});

describe("messagesLoaded — 区分「空会话」与「未加载」", () => {
  it("init 后：活跃会话已加载，其余未加载", async () => {
    mockIndex.mockResolvedValue([meta("s1"), meta("s2")]);
    mockLoadMessages.mockResolvedValue({
      messages: [{ id: "m1", role: "user", content: "hi", timestamp: "" }],
      total: 1,
    });

    await useSessionStore.getState().init();
    const { sessions, activeSessionId, loaded } = useSessionStore.getState();

    expect(loaded).toBe(true);
    const active = sessions.find(s => s.id === activeSessionId)!;
    expect(active.messagesLoaded).toBe(true);
    expect(active.messages.length).toBe(1);

    const other = sessions.find(s => s.id !== activeSessionId)!;
    expect(other.messagesLoaded).toBe(false);
    expect(other.messages.length).toBe(0);
  });

  it("新建会话直接视为已加载，不显示加载态", () => {
    useSessionStore.getState().createSession({
      id: "new1", title: "新对话", connectorId: "kiro-cli", connectorSessionId: null,
    });
    const s = useSessionStore.getState().sessions.find(x => x.id === "new1")!;
    expect(s.messagesLoaded).toBe(true);
  });

  it("switchSession 到未加载会话后标记为已加载", async () => {
    mockIndex.mockResolvedValue([meta("s1"), meta("s2")]);
    mockLoadMessages.mockResolvedValue({ messages: [], total: 0 });
    await useSessionStore.getState().init();

    mockLoadMessages.mockResolvedValue({
      messages: [{ id: "m1", role: "user", content: "旧消息", timestamp: "" }],
      total: 1,
    });
    await useSessionStore.getState().switchSession("s2");

    const s2 = useSessionStore.getState().sessions.find(s => s.id === "s2")!;
    expect(s2.messagesLoaded).toBe(true);
    expect(s2.messages.length).toBe(1);
  });

  it("已加载的会话再次切换不重复读盘", async () => {
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockResolvedValue({ messages: [], total: 0 });
    await useSessionStore.getState().init();

    const callsAfterInit = mockLoadMessages.mock.calls.length;
    await useSessionStore.getState().switchSession("s1");
    await useSessionStore.getState().switchSession("s1");

    // 真正空的会话也不该每次切换都重新读（旧实现按 messages.length 判断会重复读）
    expect(mockLoadMessages.mock.calls.length).toBe(callsAfterInit);
  });

  it("加载失败也要解除加载态，避免界面卡在 loading", async () => {
    mockIndex.mockResolvedValue([meta("s1"), meta("s2")]);
    mockLoadMessages.mockResolvedValue({ messages: [], total: 0 });
    await useSessionStore.getState().init();

    mockLoadMessages.mockRejectedValue(new Error("磁盘读取失败"));
    await useSessionStore.getState().switchSession("s2");

    const s2 = useSessionStore.getState().sessions.find(s => s.id === "s2")!;
    expect(s2.messagesLoaded).toBe(true);
  });

  it("init 预加载失败时活跃会话也标记为已加载", async () => {
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockRejectedValue(new Error("读取失败"));

    await useSessionStore.getState().init();
    const { sessions, activeSessionId, loaded } = useSessionStore.getState();

    expect(loaded).toBe(true);
    expect(sessions.find(s => s.id === activeSessionId)!.messagesLoaded).toBe(true);
  });

  it("无任何历史时 loaded 为 true 且无活跃会话", async () => {
    mockIndex.mockResolvedValue([]);
    await useSessionStore.getState().init();
    const { activeSessionId, loaded, sessions } = useSessionStore.getState();
    expect(loaded).toBe(true);
    expect(activeSessionId).toBeNull();
    expect(sessions.length).toBe(0);
  });
});

describe("modelId 从 index 与 session 文件恢复", () => {
  it("index 带 modelId 时直接恢复", async () => {
    mockIndex.mockResolvedValue([{ ...meta("s1"), modelId: "claude-opus-4.8" }]);
    mockLoadMessages.mockResolvedValue({ messages: [], total: 0 });
    await useSessionStore.getState().init();
    expect(useSessionStore.getState().sessions[0].modelId).toBe("claude-opus-4.8");
  });

  it("index 无 modelId 时用 session 文件兜底（兼容早期数据）", async () => {
    mockIndex.mockResolvedValue([meta("s1")]);
    mockLoadMessages.mockResolvedValue({ messages: [], total: 0, modelId: "gpt-5.6-sol" });
    await useSessionStore.getState().init();
    expect(useSessionStore.getState().sessions[0].modelId).toBe("gpt-5.6-sol");
  });
});
