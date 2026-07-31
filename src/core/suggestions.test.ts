import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatSession } from "./types";

const mockGetAllTasks = vi.fn();
const mockGetAllMemories = vi.fn();

vi.mock("./task", () => ({ taskManager: { getAll: () => mockGetAllTasks() } }));
vi.mock("./memory/longterm", () => ({ longTermMemory: { getAll: () => mockGetAllMemories() } }));

const { buildSuggestions, extractWorkflowName } = await import("./suggestions");

const session = (id: string, title: string, updatedAt: string): ChatSession => ({
  id, title, connectorId: "kiro-cli", connectorSessionId: null,
  messages: [], createdAt: updatedAt, updatedAt,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllTasks.mockResolvedValue([]);
  mockGetAllMemories.mockResolvedValue([]);
});

describe("extractWorkflowName", () => {
  it("取中文冒号前的流程名", () => {
    expect(extractWorkflowName("Nova 本地构建发布流程（模式A）：本机 tauri build")).toBe("Nova 本地构建发布流程（模式A）");
  });

  it("取半角冒号前的流程名", () => {
    expect(extractWorkflowName("gh auth login 流程: 选 GitHub.com")).toBe("gh auth login 流程");
  });

  it("无冒号时截取开头", () => {
    expect(extractWorkflowName("一个没有冒号的流程说明")).toBe("一个没有冒号的流程说明");
  });

  it("过长时截断并加省略号", () => {
    const r = extractWorkflowName("A".repeat(50));
    expect(r.length).toBeLessThanOrEqual(25);
    expect(r.endsWith("…")).toBe(true);
  });

  it("空内容返回空串", () => {
    expect(extractWorkflowName("")).toBe("");
    expect(extractWorkflowName("   ")).toBe("");
  });

  it("冒号在开头时不返回空（回落到截取）", () => {
    expect(extractWorkflowName("：只有细节")).toBe("：只有细节");
  });
});

describe("buildSuggestions — 优先级与宁缺勿滥", () => {
  it("无任何素材时返回空数组，不用泛用语凑满", async () => {
    const r = await buildSuggestions([], null);
    expect(r).toEqual([]);
  });

  it("未完成任务按截止日期升序", async () => {
    mockGetAllTasks.mockResolvedValue([
      { id: "b", title: "晚的任务", status: "pending", dueDate: "2026-08-13" },
      { id: "a", title: "早的任务", status: "pending", dueDate: "2026-08-06" },
    ]);
    const r = await buildSuggestions([], null);
    expect(r.map(x => x.label)).toEqual(["继续：早的任务", "继续：晚的任务"]);
  });

  it("已完成任务不参与", async () => {
    mockGetAllTasks.mockResolvedValue([
      { id: "a", title: "做完了", status: "completed", dueDate: "2026-08-01" },
      { id: "b", title: "在做", status: "in_progress", dueDate: "2026-08-02" },
    ]);
    const r = await buildSuggestions([], null);
    expect(r.length).toBe(1);
    expect(r[0].label).toBe("继续：在做");
  });

  it("无截止日期的任务排在有截止日期之后", async () => {
    mockGetAllTasks.mockResolvedValue([
      { id: "a", title: "无期限", status: "pending" },
      { id: "b", title: "有期限", status: "pending", dueDate: "2026-08-06" },
    ]);
    const r = await buildSuggestions([], null);
    expect(r[0].label).toBe("继续：有期限");
  });

  it("任务建议带上描述作为 prompt", async () => {
    mockGetAllTasks.mockResolvedValue([
      { id: "a", title: "标题", description: "细节说明", status: "pending" },
    ]);
    const r = await buildSuggestions([], null);
    expect((r[0] as any).prompt).toContain("细节说明");
  });

  it("最近会话产出跳转型建议，且排除当前会话", async () => {
    const sessions = [
      session("s1", "旧的", "2026-07-01T00:00:00Z"),
      session("s2", "新的", "2026-07-31T00:00:00Z"),
      session("cur", "当前空会话", "2026-07-31T01:00:00Z"),
    ];
    const r = await buildSuggestions(sessions, "cur");
    expect(r.length).toBe(1);
    expect(r[0].kind).toBe("session");
    expect(r[0].label).toBe("回到：新的");
    expect((r[0] as any).sessionId).toBe("s2");
  });

  it("标题为「新对话」的会话不作为建议", async () => {
    const r = await buildSuggestions([session("s1", "新对话", "2026-07-31T00:00:00Z")], null);
    expect(r).toEqual([]);
  });

  it("workflow 记忆产出「走一遍」建议", async () => {
    mockGetAllMemories.mockResolvedValue([
      { content: "Nova 发布流程：跑 release.sh", category: "workflow", updatedAt: "2026-07-30T00:00:00Z" },
    ]);
    const r = await buildSuggestions([], null);
    expect(r.length).toBe(1);
    expect(r[0].label).toBe("走一遍：Nova 发布流程");
  });

  it("非 workflow 分类的记忆不参与", async () => {
    mockGetAllMemories.mockResolvedValue([
      { content: "某个事实：细节", category: "project_context", updatedAt: "2026-07-30T00:00:00Z" },
      { content: "某个偏好：细节", category: "user_preference", updatedAt: "2026-07-30T00:00:00Z" },
    ]);
    expect(await buildSuggestions([], null)).toEqual([]);
  });

  it("优先级为 任务 → 会话 → workflow", async () => {
    mockGetAllTasks.mockResolvedValue([{ id: "a", title: "任务甲", status: "pending", dueDate: "2026-08-01" }]);
    mockGetAllMemories.mockResolvedValue([
      { content: "流程甲：细节", category: "workflow", updatedAt: "2026-07-30T00:00:00Z" },
    ]);
    const r = await buildSuggestions([session("s1", "会话甲", "2026-07-31T00:00:00Z")], null);
    expect(r.map(x => x.kind)).toEqual(["task", "session", "workflow"]);
  });

  it("总数不超过 4 条", async () => {
    mockGetAllTasks.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, title: `任务${i}`, status: "pending", dueDate: `2026-08-0${i + 1}` })),
    );
    mockGetAllMemories.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ content: `流程${i}：细节`, category: "workflow", updatedAt: "2026-07-30T00:00:00Z" })),
    );
    const r = await buildSuggestions([session("s1", "会话", "2026-07-31T00:00:00Z")], null);
    expect(r.length).toBe(4);
  });

  it("某一数据源报错不影响其他来源", async () => {
    mockGetAllTasks.mockRejectedValue(new Error("任务读取失败"));
    mockGetAllMemories.mockResolvedValue([
      { content: "流程甲：细节", category: "workflow", updatedAt: "2026-07-30T00:00:00Z" },
    ]);
    const r = await buildSuggestions([], null);
    expect(r.map(x => x.kind)).toEqual(["workflow"]);
  });
});
