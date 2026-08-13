import { describe, expect, it } from "vitest";
import { ChannelBindingStore, resolveBindingTarget, type ChannelBinding } from "./channelBindings";

class MemoryStorage {
  data: Record<string, Record<string, unknown>> = {};
  async get<T>(namespace: string, key: string, defaultValue?: T): Promise<T | undefined> {
    return (this.data[namespace]?.[key] as T | undefined) ?? defaultValue;
  }
  async set(namespace: string, key: string, value: unknown): Promise<void> {
    this.data[namespace] ||= {};
    this.data[namespace][key] = value;
  }
}

describe("ChannelBindingStore", () => {
  it("持久化绑定并支持解绑", async () => {
    const storage = new MemoryStorage();
    const first = new ChannelBindingStore(storage);
    await first.bind("wecom", "wecom-chat-1", "session-a");

    const second = new ChannelBindingStore(storage);
    expect((await second.get("wecom", "wecom-chat-1"))?.targetSessionId).toBe("session-a");

    await second.unbind("wecom", "wecom-chat-1");
    expect(await first.get("wecom", "wecom-chat-1")).toBeNull();
  });

  it("删除目标会话时清理所有指向它的绑定", async () => {
    const store = new ChannelBindingStore(new MemoryStorage());
    await store.bind("wecom", "wecom-chat-1", "session-a");
    await store.bind("wecom", "wecom-chat-2", "session-a");
    await store.bind("wecom", "wecom-chat-3", "session-b");

    await store.removeByTargetSession("session-a");

    expect(await store.get("wecom", "wecom-chat-1")).toBeNull();
    expect(await store.get("wecom", "wecom-chat-2")).toBeNull();
    expect((await store.get("wecom", "wecom-chat-3"))?.targetSessionId).toBe("session-b");
  });
});


describe("resolveBindingTarget", () => {
  const binding: ChannelBinding = {
    channel: "wecom",
    channelSessionId: "wecom-chat-1",
    targetSessionId: "session-a",
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("有效绑定命中目标；无绑定回落入口会话", () => {
    expect(resolveBindingTarget("wecom-chat-1", binding, ["session-a"]))
      .toEqual({ targetSessionId: "session-a", invalidBinding: false });
    expect(resolveBindingTarget("wecom-chat-1", null, []))
      .toEqual({ targetSessionId: "wecom-chat-1", invalidBinding: false });
  });

  it("目标会话删除后标记失效并回落入口会话", () => {
    expect(resolveBindingTarget("wecom-chat-1", binding, ["session-b"]))
      .toEqual({ targetSessionId: "wecom-chat-1", invalidBinding: true });
  });
});
