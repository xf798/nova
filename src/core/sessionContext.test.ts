import { describe, expect, it, vi } from "vitest";
import { resolveSessionContext } from "./sessionContext";
import type { ChatSession, Message } from "./types";

const message = (id: string): Message => ({
  id,
  role: id.startsWith("u") ? "user" : "assistant",
  content: id,
  timestamp: "2026-01-01T00:00:00Z",
});

const session: ChatSession = {
  id: "session-a",
  title: "A",
  connectorId: "kiro",
  connectorSessionId: "native-a",
  messages: [message("a2-live"), { ...message("loading"), content: "$$LOADING$$" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  modelId: "claude",
  workspace: "/workspace/a",
};

describe("resolveSessionContext", () => {
  it("先探测 total，再从磁盘读取完整历史并合并待落盘消息", async () => {
    const loadMessages = vi.fn()
      .mockResolvedValueOnce({ messages: [message("a2")], total: 3, memory: { summary: "概要" } })
      .mockResolvedValueOnce({ messages: [message("u1"), message("a1"), message("a2")], total: 3, memory: { summary: "概要" } });

    const result = await resolveSessionContext("session-a", {
      storage: { loadMessages },
      session,
    });

    expect(loadMessages).toHaveBeenNthCalledWith(1, "session-a", 0, 1);
    expect(loadMessages).toHaveBeenNthCalledWith(2, "session-a", 0, 3);
    expect(result.messages.map(m => m.id)).toEqual(["u1", "a1", "a2", "a2-live"]);
    expect(result.connectorSessionId).toBe("native-a");
    expect(result.modelId).toBe("claude");
    expect(result.workspace).toBe("/workspace/a");
  });
});
